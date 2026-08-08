export interface CollectionHealthRunRow {
  id?: unknown;
  source_key?: unknown;
  status?: unknown;
  started_at?: unknown;
  finished_at?: unknown;
  fetched_count?: unknown;
  failed_count?: unknown;
  error_message?: unknown;
  metadata?: unknown;
}

export interface CollectionHealthMetrics {
  lastCollectionAt: string | null;
  lastSuccessfulCollectionAt: string | null;
  lastRunStatus: "success" | "failed" | "running" | null;
  recordsCollected: number | null;
  recordsAdded: number | null;
  pendingItems: number | null;
  errorCount: number | null;
  failureReason: string | null;
  failureTarget: string | null;
  runId: string | null;
  durationMs: number | null;
  checkpoint: string | null;
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function textValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function runStatus(value: unknown): CollectionHealthMetrics["lastRunStatus"] {
  if (value === "completed" || value === "success" || value === "succeeded") return "success";
  if (value === "failed" || value === "error") return "failed";
  if (value === "running" || value === "queued") return "running";
  return null;
}

function duration(startedAt: string | null, finishedAt: string | null, now: number) {
  if (!startedAt) return null;
  const started = Date.parse(startedAt);
  const ended = finishedAt ? Date.parse(finishedAt) : now;
  if (!Number.isFinite(started) || !Number.isFinite(ended)) return null;
  return Math.max(0, ended - started);
}

function metadataNumber(metadata: Record<string, unknown> | null, ...keys: string[]) {
  for (const key of keys) {
    const value = numberValue(metadata?.[key]);
    if (value !== null) return value;
  }
  return null;
}

function metadataError(metadata: Record<string, unknown> | null) {
  if (!Array.isArray(metadata?.errors)) return null;
  return metadata.errors.find((value): value is string => typeof value === "string" && Boolean(value.trim()))?.trim() ?? null;
}

export function collectionHealthMetrics(input: {
  latest?: CollectionHealthRunRow | null;
  successful?: CollectionHealthRunRow | null;
  pendingItems?: number | null;
  failedJobCount?: number | null;
  now?: number;
}): CollectionHealthMetrics {
  const latest = input.latest ?? null;
  const successful = input.successful ?? null;
  const latestStatus = runStatus(latest?.status);
  const latestStartedAt = textValue(latest?.started_at);
  const latestFinishedAt = textValue(latest?.finished_at);
  const successfulFinishedAt = textValue(successful?.finished_at);
  const latestMetadata = recordValue(latest?.metadata);
  const successfulMetadata = recordValue(successful?.metadata);
  const errorCount = numberValue(latest?.failed_count) ?? numberValue(input.failedJobCount);
  const failureReason = textValue(latest?.error_message) ?? metadataError(latestMetadata);
  const successfulSource = textValue(successful?.source_key);
  const checkpoint = textValue(successfulMetadata?.checkpoint)
    ?? (successfulSource && successfulFinishedAt ? `${successfulSource}:${successfulFinishedAt}` : null);

  return {
    lastCollectionAt: latestStartedAt,
    lastSuccessfulCollectionAt: successfulFinishedAt,
    lastRunStatus: latestStatus,
    recordsCollected: numberValue(latest?.fetched_count),
    recordsAdded: metadataNumber(latestMetadata, "recordsAdded", "addedCount"),
    pendingItems: numberValue(input.pendingItems),
    errorCount,
    failureReason,
    failureTarget: latestStatus === "failed" ? textValue(latest?.source_key) : null,
    runId: textValue(latest?.id),
    durationMs: duration(latestStartedAt, latestFinishedAt, input.now ?? Date.now()),
    checkpoint,
  };
}
