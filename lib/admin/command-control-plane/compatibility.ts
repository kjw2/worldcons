import { randomUUID } from "node:crypto";
import { adminCommandError } from "@/lib/admin/command-control-plane/errors";
import { adminCommandService } from "@/lib/admin/command-control-plane/service";
import type { AdminCommandResult, SubmittedAdminCommand } from "@/lib/admin/command-control-plane/types";
import { redactAdminAuditMetadata } from "@/lib/security/audit-redaction";
import { createHash } from "@/lib/utils/hash";
import { recordCompatibilityObservation } from "@/lib/admin/p5/observations";

export const ADMIN_QUEUE_V3_SHADOW_WRITE_FLAG = "ADMIN_QUEUE_V3_SHADOW_WRITE_ENABLED";

export interface AdminCompatibilityCommandInput {
  commandType: string;
  payloadRef?: Record<string, unknown>;
  request?: Request;
  requestedBy?: string;
  priority?: number;
}

export interface AdminCompatibilityCommandResult<T> {
  value: T;
  authority: "legacy";
  shadow: "disabled" | "skipped" | "written" | "failed";
  shadowResult?: AdminCommandResult<SubmittedAdminCommand>;
}

interface AdminCompatibilityCommandOptions<T> {
  isLegacySuccess: (value: T) => boolean;
  shadowEnabled?: boolean;
  submit?: typeof adminCommandService.submit;
}

export function adminQueueV3ShadowWriteEnabled(environment: Record<string, string | undefined> = process.env) {
  return environment[ADMIN_QUEUE_V3_SHADOW_WRITE_FLAG]?.trim().toLowerCase() === "true";
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => [key, stableJsonValue(entryValue)]),
  );
}

export function buildAdminCompatibilityCommandIdentity(input: AdminCompatibilityCommandInput) {
  const safePayload = redactAdminAuditMetadata(input.payloadRef);
  const requestKey = input.request?.headers.get("idempotency-key")?.trim();
  const invocationKey = requestKey && requestKey.length <= 200 ? requestKey : randomUUID();
  const payloadHash = createHash(JSON.stringify(stableJsonValue(safePayload)), 48);
  return {
    payloadRef: safePayload,
    idempotencyKey: `compat:${createHash(`${input.commandType}:${invocationKey}`, 64)}`,
    dedupeKey: `compat:${input.commandType}:${payloadHash}`.slice(0, 240),
  };
}

export async function executeAdminCompatibilityCommand<T>(
  input: AdminCompatibilityCommandInput,
  executeLegacy: () => Promise<T> | T,
  options: AdminCompatibilityCommandOptions<T>,
): Promise<AdminCompatibilityCommandResult<T>> {
  let value: T;
  try {
    value = await executeLegacy();
    recordCompatibilityObservation({ surface: "admin_command", domain: "queue", direction: "write", authority: "legacy", outcome: "succeeded" });
  } catch (error) {
    recordCompatibilityObservation({ surface: "admin_command", domain: "queue", direction: "write", authority: "legacy", outcome: "failed" });
    throw error;
  }
  const shadowEnabled = options.shadowEnabled ?? adminQueueV3ShadowWriteEnabled();
  if (!shadowEnabled) {
    recordCompatibilityObservation({ surface: "admin_command", domain: "queue", direction: "write", authority: "new", outcome: "disabled" });
    return { value, authority: "legacy", shadow: "disabled" };
  }

  let legacySucceeded = false;
  try {
    legacySucceeded = options.isLegacySuccess(value);
  } catch {
    console.warn("[admin command shadow]", {
      event: "admin_command_success_predicate_failed",
      commandType: input.commandType,
    });
  }
  if (!legacySucceeded) {
    recordCompatibilityObservation({ surface: "admin_command", domain: "queue", direction: "write", authority: "new", outcome: "skipped" });
    return { value, authority: "legacy", shadow: "skipped" };
  }

  const identity = buildAdminCompatibilityCommandIdentity(input);
  const submit = options.submit ?? adminCommandService.submit;
  let shadowResult: AdminCommandResult<SubmittedAdminCommand>;
  try {
    shadowResult = await submit({
      commandType: input.commandType,
      payloadRef: identity.payloadRef,
      idempotencyKey: identity.idempotencyKey,
      dedupeKey: identity.dedupeKey,
      requestedBy: input.requestedBy ?? "admin",
      priority: input.priority,
      shadowOnly: true,
    });
  } catch {
    shadowResult = { ok: false, error: adminCommandError("internal") };
  }

  if (!shadowResult.ok) {
    recordCompatibilityObservation({ surface: "admin_command", domain: "queue", direction: "write", authority: "new", outcome: "failed" });
    console.warn("[admin command shadow]", {
      event: "admin_command_shadow_failed",
      commandType: input.commandType,
      errorCode: shadowResult.error.code,
    });
  }
  if (shadowResult.ok) recordCompatibilityObservation({ surface: "admin_command", domain: "queue", direction: "write", authority: "new", outcome: "succeeded" });

  return {
    value,
    authority: "legacy",
    shadow: shadowResult.ok ? "written" : "failed",
    shadowResult,
  };
}
