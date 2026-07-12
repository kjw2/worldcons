import { redactAdminAuditMetadata, redactAdminAuditText } from "@/lib/security/audit-redaction";
import { adminCommandError } from "@/lib/admin/command-control-plane/errors";
import { postgresAdminCommandRepository } from "@/lib/admin/command-control-plane/repository";
import type {
  AbortAdminCommandRunInput,
  AdminCommandRepository,
  ClaimAdminCommandInput,
  FailAdminCommandAttemptInput,
  SubmitAdminCommandInput,
} from "@/lib/admin/command-control-plane/types";

const COMMAND_TYPE_PATTERN = /^[a-z][a-z0-9._-]{0,119}$/;

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value ?? fallback)));
}

function validText(value: string, max: number) {
  const text = value.trim();
  return text.length > 0 && text.length <= max && !/[\u0000-\u001f\u007f]/.test(text);
}

function validFencingToken(value: string) {
  return /^[1-9][0-9]{0,18}$/.test(value);
}

export function createAdminCommandService(repository: AdminCommandRepository = postgresAdminCommandRepository) {
  return {
    submit(input: SubmitAdminCommandInput) {
      if (
        !COMMAND_TYPE_PATTERN.test(input.commandType) ||
        !validText(input.idempotencyKey, 240) ||
        !validText(input.dedupeKey, 240)
      ) {
        return Promise.resolve({ ok: false as const, error: adminCommandError("invalid_input") });
      }
      const backoffBase = boundedInteger(input.retryBackoffBaseSeconds, 15, 1, 86400);
      return repository.submit({
        ...input,
        commandType: input.commandType.trim(),
        payloadRef: redactAdminAuditMetadata(input.payloadRef),
        requestedBy: input.requestedBy ? redactAdminAuditText(input.requestedBy, 160) : null,
        priority: boundedInteger(input.priority, 0, -1000, 1000),
        maxAttempts: boundedInteger(input.maxAttempts, 3, 1, 100),
        retryBackoffBaseSeconds: backoffBase,
        retryBackoffCapSeconds: boundedInteger(input.retryBackoffCapSeconds, 900, backoffBase, 604800),
      });
    },

    claim(input: ClaimAdminCommandInput) {
      if (!validText(input.workerId, 160) || input.commandTypes?.some((type) => !COMMAND_TYPE_PATTERN.test(type))) {
        return Promise.resolve({ ok: false as const, error: adminCommandError("invalid_input") });
      }
      return repository.claim({
        workerId: redactAdminAuditText(input.workerId, 160),
        commandTypes: input.commandTypes,
        leaseSeconds: boundedInteger(input.leaseSeconds, 60, 1, 86400),
      });
    },

    heartbeat(attemptId: string, fencingToken: string, leaseSeconds?: number) {
      if (!validText(attemptId, 120) || !validFencingToken(fencingToken)) {
        return Promise.resolve({ ok: false as const, error: adminCommandError("invalid_input") });
      }
      return repository.heartbeat(attemptId, fencingToken, boundedInteger(leaseSeconds, 60, 1, 86400));
    },

    complete(attemptId: string, fencingToken: string, resultSummary: Record<string, unknown> = {}) {
      if (!validText(attemptId, 120) || !validFencingToken(fencingToken)) {
        return Promise.resolve({ ok: false as const, error: adminCommandError("invalid_input") });
      }
      return repository.complete(attemptId, fencingToken, redactAdminAuditMetadata(resultSummary));
    },

    fail(input: FailAdminCommandAttemptInput) {
      if (
        !validText(input.attemptId, 120) ||
        !validFencingToken(input.fencingToken) ||
        !validText(input.errorCode, 160)
      ) {
        return Promise.resolve({ ok: false as const, error: adminCommandError("invalid_input") });
      }
      return repository.fail({
        ...input,
        errorCode: redactAdminAuditText(input.errorCode, 160),
        errorMessage: input.errorMessage ? redactAdminAuditText(input.errorMessage, 500) : null,
        resultSummary: redactAdminAuditMetadata(input.resultSummary),
      });
    },

    abort(input: AbortAdminCommandRunInput) {
      if (!validText(input.runId, 120) || !validText(input.requestedBy, 160)) {
        return Promise.resolve({ ok: false as const, error: adminCommandError("invalid_input") });
      }
      return repository.abort({
        ...input,
        requestedBy: redactAdminAuditText(input.requestedBy, 160),
        reason: input.reason ? redactAdminAuditText(input.reason, 500) : null,
      });
    },

    retry(runId: string, requestedBy: string, reason?: string | null) {
      if (!validText(runId, 120) || !validText(requestedBy, 160)) {
        return Promise.resolve({ ok: false as const, error: adminCommandError("invalid_input") });
      }
      return repository.retry(
        runId,
        redactAdminAuditText(requestedBy, 160),
        reason ? redactAdminAuditText(reason, 500) : null,
      );
    },
  };
}

export const adminCommandService = createAdminCommandService();
