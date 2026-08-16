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

export type CollectionRunStatus = "success" | "failed" | "running" | "degraded" | null;

export interface CollectionSourceHealth {
  sourceKey: string;
  lastCollectionAt: string | null;
  lastSuccessfulCollectionAt: string | null;
  lastVerifiedPublishedAt: string | null;
  lastRunStatus: CollectionRunStatus;
  recordsCollected: number | null;
  recordsAdded: number | null;
  verifiedSourceText: number | null;
  uncollectedCount: number | null;
  pendingRetryCount: number | null;
  runId: string | null;
  checkpoint: string | null;
  failureReason: string | null;
}

export interface CollectionHealthMetrics {
  lastCollectionAt: string | null;
  lastSuccessfulCollectionAt: string | null;
  lastRunStatus: CollectionRunStatus;
  recordsCollected: number | null;
  recordsAdded: number | null;
  pendingItems: number | null;
  errorCount: number | null;
  failureReason: string | null;
  failureTarget: string | null;
  runId: string | null;
  durationMs: number | null;
  checkpoint: string | null;
  bySource: CollectionSourceHealth[];
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

function runStatus(value: unknown, metadata?: Record<string, unknown> | null): CollectionRunStatus {
  const outcome = textValue(metadata?.outcome);
  if (outcome === "degraded") return "degraded";
  if (outcome === "failed") return "failed";
  if (outcome === "success") return "success";
  if (value === "completed" || value === "success" || value === "succeeded") return "success";
  if (value === "failed" || value === "error") return "failed";
  if (value === "degraded") return "degraded";
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

function verifiedCount(row: CollectionHealthRunRow | null) {
  const metadata = recordValue(row?.metadata);
  return metadataNumber(metadata, "verifiedSourceTextCount", "verifiedCount") ?? null;
}

function collectedCount(row: CollectionHealthRunRow | null) {
  return verifiedCount(row) ?? numberValue(row?.fetched_count);
}

function checkpointFor(row: CollectionHealthRunRow | null) {
  const metadata = recordValue(row?.metadata);
  const explicit = textValue(metadata?.checkpoint);
  if (explicit) return explicit;
  const verifiedAt = textValue(metadata?.lastVerifiedPublishedAt);
  const source = textValue(row?.source_key);
  const finishedAt = textValue(row?.finished_at);
  if (source && verifiedAt) return `${source}:${verifiedAt}`;
  if (source && finishedAt) return `${source}:${finishedAt}`;
  return null;
}

export function collectionHealthBySource(runs: CollectionHealthRunRow[] = []): CollectionSourceHealth[] {
  const latestBySource = new Map<string, CollectionHealthRunRow>();
  const successfulBySource = new Map<string, CollectionHealthRunRow>();
  for (const run of runs) {
    const sourceKey = textValue(run.source_key);
    if (!sourceKey) continue;
    if (!latestBySource.has(sourceKey)) latestBySource.set(sourceKey, run);
    const metadata = recordValue(run.metadata);
    const status = runStatus(run.status, metadata);
    if (status === "success" && !successfulBySource.has(sourceKey)) successfulBySource.set(sourceKey, run);
  }

  return [...latestBySource.entries()].map(([sourceKey, latest]) => {
    const successful = successfulBySource.get(sourceKey) ?? null;
    const latestMetadata = recordValue(latest.metadata);
    const successfulMetadata = recordValue(successful?.metadata);
    return {
      sourceKey,
      lastCollectionAt: textValue(latest.started_at),
      lastSuccessfulCollectionAt: textValue(successful?.finished_at),
      lastVerifiedPublishedAt: textValue(latestMetadata?.lastVerifiedPublishedAt) ?? textValue(successfulMetadata?.lastVerifiedPublishedAt),
      lastRunStatus: runStatus(latest.status, latestMetadata),
      recordsCollected: collectedCount(latest),
      recordsAdded: metadataNumber(latestMetadata, "recordsAdded", "addedCount"),
      verifiedSourceText: verifiedCount(latest),
      uncollectedCount: metadataNumber(latestMetadata, "uncollectedCandidateCount", "uncollectedCount"),
      pendingRetryCount: metadataNumber(latestMetadata, "openCandidateCount"),
      runId: textValue(latest.id),
      checkpoint: checkpointFor(successful ?? latest),
      failureReason: textValue(latest.error_message) ?? metadataError(latestMetadata),
    };
  });
}

export function collectionHealthMetrics(input: {
  latest?: CollectionHealthRunRow | null;
  successful?: CollectionHealthRunRow | null;
  recentRuns?: CollectionHealthRunRow[] | null;
  pendingItems?: number | null;
  failedJobCount?: number | null;
  now?: number;
}): CollectionHealthMetrics {
  const latest = input.latest ?? null;
  const successful = input.successful ?? null;
  const latestMetadata = recordValue(latest?.metadata);
  const successfulMetadata = recordValue(successful?.metadata);
  const latestStatus = runStatus(latest?.status, latestMetadata);
  const latestStartedAt = textValue(latest?.started_at);
  const latestFinishedAt = textValue(latest?.finished_at);
  const successfulFinishedAt = textValue(successful?.finished_at);
  const errorCount = numberValue(latest?.failed_count) ?? numberValue(input.failedJobCount);
  const failureReason = textValue(latest?.error_message) ?? metadataError(latestMetadata);
  const bySource = collectionHealthBySource(input.recentRuns ?? (latest ? [latest] : []));

  return {
    lastCollectionAt: latestStartedAt,
    lastSuccessfulCollectionAt: successfulFinishedAt,
    lastRunStatus: latestStatus,
    recordsCollected: collectedCount(latest),
    recordsAdded: metadataNumber(latestMetadata, "recordsAdded", "addedCount"),
    pendingItems: numberValue(input.pendingItems),
    errorCount,
    failureReason,
    failureTarget: latestStatus === "failed" || latestStatus === "degraded" ? textValue(latest?.source_key) : null,
    runId: textValue(latest?.id),
    durationMs: duration(latestStartedAt, latestFinishedAt, input.now ?? Date.now()),
    checkpoint: checkpointFor(successful) ?? textValue(successfulMetadata?.checkpoint),
    bySource,
  };
}
