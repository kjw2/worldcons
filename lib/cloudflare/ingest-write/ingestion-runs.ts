import type { D1RuntimeDatabase } from "@/lib/cloudflare/d1/runtime-binding";
import { m13ProfileValueForEnvVar } from "@/lib/cloudflare/m13/profile-override";

export const INGEST_RUN_WRITE_AUTHORITY_ENV = "WORLDCONS_INGEST_RUN_WRITE_AUTHORITY";
export const INGEST_RUN_CANARY_MARKER_ENV = "WORLDCONS_INGEST_RUN_CANARY_MARKER";
export const INGEST_RUN_BOUNDARY_PATH = "/v1/ingest/run";

export type IngestRunWriteAuthority = "supabase" | "d1-canary" | "d1";

export interface IngestRunWriteAuthorityConfig {
  authority: IngestRunWriteAuthority;
}

export interface IngestRunWriteAuthorityEnvironment {
  [key: string]: string | undefined;
}

export type IngestionRunMutation =
  | {
      action: "start";
      id: string;
      sourceKey: string;
      startedAt: string;
      canary: boolean;
    }
  | {
      action: "finish";
      id: string;
      status: string;
      finishedAt: string;
      discoveredCount: number;
      fetchedCount: number;
      summarizedCount: number;
      failedCount: number;
      errorMessage: string | null;
      metadata: Record<string, unknown>;
      canary: boolean;
    }
  | {
      action: "summary";
      id: string;
      summarizedCount: number;
      canary: boolean;
    }
  | {
      action: "recover-stale";
      sourceKey: string;
      cutoff: string;
      finishedAt: string;
      errorMessage: string;
      canary: boolean;
    };

export type IngestionRunMutationParseResult =
  | { ok: true; mutation: IngestionRunMutation }
  | { ok: false; error: string };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SOURCE_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,79}$/u;
const STATUS_PATTERN = /^[a-z][a-z0-9_-]{0,39}$/u;
const MAX_METADATA_BYTES = 131_072;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, maxLength: number) {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength ? value : null;
}

function timestamp(value: unknown) {
  const candidate = text(value, 64);
  return candidate && Number.isFinite(Date.parse(candidate)) ? candidate : null;
}

function count(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function metadata(value: unknown) {
  if (!isRecord(value)) return null;
  try {
    return JSON.stringify(value).length <= MAX_METADATA_BYTES ? value : null;
  } catch {
    return null;
  }
}

export function resolveIngestRunWriteAuthorityConfig(
  environment: IngestRunWriteAuthorityEnvironment = {},
): IngestRunWriteAuthorityConfig {
  if (m13ProfileValueForEnvVar(INGEST_RUN_WRITE_AUTHORITY_ENV, environment) === "d1") return { authority: "d1" };
  const raw = environment[INGEST_RUN_WRITE_AUTHORITY_ENV]?.trim().toLowerCase();
  if (raw === "d1-canary") return { authority: raw };
  return { authority: "d1" };
}

export function resolveIngestRunCanaryMarker(
  environment: IngestRunWriteAuthorityEnvironment = {},
) {
  const marker = environment[INGEST_RUN_CANARY_MARKER_ENV]?.trim();
  if (!marker) return false;
  if (marker === "1" || marker.toLowerCase() === "true") return true;
  const runId = environment.GITHUB_RUN_ID?.trim();
  return Boolean(runId && marker === runId);
}

export function shouldWriteIngestionRunToD1(
  mutation: Pick<IngestionRunMutation, "canary">,
  config: IngestRunWriteAuthorityConfig,
) {
  if (config.authority === "d1") return true;
  return config.authority === "d1-canary" && mutation.canary;
}

export function parseIngestionRunMutation(value: unknown): IngestionRunMutationParseResult {
  if (!isRecord(value)) return { ok: false, error: "body" };
  const action = value.action;
  const canary = value.canary === true;

  if (action === "start") {
    const id = text(value.id, 64);
    const sourceKey = text(value.sourceKey, 80);
    const startedAt = timestamp(value.startedAt);
    if (!id || !UUID_PATTERN.test(id)) return { ok: false, error: "id" };
    if (!sourceKey || !SOURCE_KEY_PATTERN.test(sourceKey)) return { ok: false, error: "source_key" };
    if (!startedAt) return { ok: false, error: "started_at" };
    return { ok: true, mutation: { action, id, sourceKey, startedAt, canary } };
  }

  if (action === "finish") {
    const id = text(value.id, 64);
    const status = text(value.status, 40);
    const finishedAt = timestamp(value.finishedAt);
    const discoveredCount = count(value.discoveredCount);
    const fetchedCount = count(value.fetchedCount);
    const summarizedCount = count(value.summarizedCount);
    const failedCount = count(value.failedCount);
    const runMetadata = metadata(value.metadata);
    if (!id || !UUID_PATTERN.test(id)) return { ok: false, error: "id" };
    if (!status || !STATUS_PATTERN.test(status)) return { ok: false, error: "status" };
    if (!finishedAt) return { ok: false, error: "finished_at" };
    if (discoveredCount === null || fetchedCount === null || summarizedCount === null || failedCount === null) {
      return { ok: false, error: "counts" };
    }
    if (!runMetadata) return { ok: false, error: "metadata" };
    const errorMessage = value.errorMessage === null
      ? null
      : typeof value.errorMessage === "string" && value.errorMessage.length <= 2_000
        ? value.errorMessage
        : null;
    return {
      ok: true,
      mutation: {
        action,
        id,
        status,
        finishedAt,
        discoveredCount,
        fetchedCount,
        summarizedCount,
        failedCount,
        errorMessage,
        metadata: runMetadata,
        canary,
      },
    };
  }

  if (action === "summary") {
    const id = text(value.id, 64);
    const summarizedCount = count(value.summarizedCount);
    if (!id || !UUID_PATTERN.test(id)) return { ok: false, error: "id" };
    if (summarizedCount === null) return { ok: false, error: "summarized_count" };
    return { ok: true, mutation: { action, id, summarizedCount, canary } };
  }

  if (action === "recover-stale") {
    const sourceKey = text(value.sourceKey, 80);
    const cutoff = timestamp(value.cutoff);
    const finishedAt = timestamp(value.finishedAt);
    const errorMessage = text(value.errorMessage, 2_000);
    if (!sourceKey || !SOURCE_KEY_PATTERN.test(sourceKey)) return { ok: false, error: "source_key" };
    if (!cutoff) return { ok: false, error: "cutoff" };
    if (!finishedAt) return { ok: false, error: "finished_at" };
    if (!errorMessage) return { ok: false, error: "error_message" };
    return { ok: true, mutation: { action, sourceKey, cutoff, finishedAt, errorMessage, canary } };
  }

  return { ok: false, error: "action" };
}

function resultChanges(result: { success?: boolean; error?: string | null; meta?: Record<string, unknown> }) {
  if (result.success === false || result.error) throw new Error("ingestion_run_d1_authority.write_failed");
  const changes = result.meta?.changes;
  const parsed = typeof changes === "number" ? changes : Number(changes);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("ingestion_run_d1_authority.invalid_changes");
  return parsed;
}

async function run(
  binding: D1RuntimeDatabase,
  sql: string,
  values: unknown[],
) {
  const statement = binding.prepare(sql).bind(...values);
  if (!statement.run) throw new Error("ingestion_run_d1_authority.run_unavailable");
  return resultChanges(await statement.run());
}

export async function applyIngestionRunMutationToD1(
  binding: D1RuntimeDatabase,
  mutation: IngestionRunMutation,
) {
  if (mutation.action === "start") {
    const affected = await run(
      binding,
      "INSERT INTO ingestion_runs (id, source_key, started_at, status, discovered_count, fetched_count, summarized_count, failed_count, metadata) VALUES (?, ?, ?, 'running', 0, 0, 0, 0, NULL)",
      [mutation.id, mutation.sourceKey, mutation.startedAt],
    );
    if (affected !== 1) throw new Error("ingestion_run_d1_authority.unexpected_changes");
    return affected;
  }

  if (mutation.action === "finish") {
    const affected = await run(
      binding,
      "UPDATE ingestion_runs SET status = ?, finished_at = ?, discovered_count = ?, fetched_count = ?, summarized_count = ?, failed_count = ?, error_message = ?, metadata = ? WHERE id = ?",
      [
        mutation.status,
        mutation.finishedAt,
        mutation.discoveredCount,
        mutation.fetchedCount,
        mutation.summarizedCount,
        mutation.failedCount,
        mutation.errorMessage,
        JSON.stringify(mutation.metadata),
        mutation.id,
      ],
    );
    if (affected !== 1) throw new Error("ingestion_run_d1_authority.unexpected_changes");
    return affected;
  }

  if (mutation.action === "summary") {
    const affected = await run(
      binding,
      "UPDATE ingestion_runs SET summarized_count = ? WHERE id = ?",
      [mutation.summarizedCount, mutation.id],
    );
    if (affected !== 1) throw new Error("ingestion_run_d1_authority.unexpected_changes");
    return affected;
  }

  return run(
    binding,
    "UPDATE ingestion_runs SET status = 'failed', finished_at = ?, error_message = ? WHERE source_key = ? AND status = 'running' AND started_at < ?",
    [mutation.finishedAt, mutation.errorMessage, mutation.sourceKey, mutation.cutoff],
  );
}
