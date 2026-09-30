import { NextResponse } from "next/server";
import { getRuntimeD1Binding, type D1RuntimeDatabase } from "@/lib/cloudflare/d1/runtime-binding";
import {
  readOpsHeartbeatsFromD1,
  type OpsHeartbeatReadRecord,
  type OpsHeartbeatWorkflowKey,
} from "@/lib/cloudflare/ops-write/heartbeat";
import { getSourceUrlCandidateHealthMetrics } from "@/lib/db/source-url-candidates";
import { getEmbeddingReadiness } from "@/lib/ingest/embedding-backlog";
import {
  collectionHealthMetrics,
  FAILURE_RECENCY_WINDOW_HOURS,
  SUMMARY_BACKLOG_STATUSES,
  summaryBacklogIsStale,
  type CollectionHealthRunRow,
} from "@/lib/masterdash/health";
import { getCollectionControlState } from "@/lib/masterdash/store";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const HEALTH_HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const VERSION = process.env.WORLDCONS_VERSION?.slice(0, 12) || "0.1.0";
const WORKFLOW_EXPECTED_INTERVAL_SECONDS: Record<OpsHeartbeatWorkflowKey, number> = {
  collection: 86_400,
  summary: 21_600,
  embedding: 21_600,
  watchdog: 43_200,
  catalog_backfill: 86_400,
};

function degradedHealth(message: string) {
  return NextResponse.json(
    {
      schemaVersion: 1,
      systemId: "worldcons",
      status: "degraded",
      message,
      version: VERSION,
      metrics: {
        lastCollectionAt: null,
        lastSuccessfulCollectionAt: null,
        freshnessSeconds: null,
        checkpoint: null,
        lastRunStatus: null,
        recordsCollected: null,
        recordsAdded: null,
        pendingItems: null,
        pendingAdminJobs: null,
        openCandidateCount: null,
        retryableCandidateCount: null,
        exhaustedCandidateCount: null,
        oldestOpenCandidateAt: null,
        missingEmbeddingCount: null,
        publishedEmbeddingVersionCount: null,
        missingPublishedEmbeddingArtifactCount: null,
        summaryBacklogCount: null,
        oldestSummaryBacklogAt: null,
        errorCount: null,
        failureReason: null,
        failureTarget: null,
        failureObservedAt: null,
        runId: null,
        durationMs: null,
        collectionPaused: false,
        controlUpdatedAt: null,
        collectionWorkflowLastRunAt: null,
        collectionWorkflowLastStatus: null,
        summaryWorkflowLastRunAt: null,
        summaryWorkflowLastStatus: null,
        embeddingWorkflowLastRunAt: null,
        embeddingWorkflowLastStatus: null,
        watchdogWorkflowLastRunAt: null,
        watchdogWorkflowLastStatus: null,
        stalledWorkflows: [],
        bySource: [],
      },
    },
    { status: 200, headers: HEALTH_HEADERS },
  );
}

async function queryRows<T extends Record<string, unknown>>(binding: D1RuntimeDatabase, sql: string, values: unknown[] = []) {
  const statement = binding.prepare(sql).bind(...values);
  if (!statement.all) throw new Error("masterdash_health_d1.read_unavailable");
  const result = await statement.all<T>();
  if (!result || result.success === false || result.error || !Array.isArray(result.results)) {
    throw new Error(result?.error || "masterdash_health_d1.read_failed");
  }
  return result.results;
}

function parseMetadata(value: unknown) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function runRow(row: Record<string, unknown> | undefined): CollectionHealthRunRow | null {
  if (!row) return null;
  return {
    id: row.id,
    source_key: row.source_key,
    status: row.status,
    started_at: row.started_at,
    finished_at: row.finished_at,
    fetched_count: row.fetched_count,
    failed_count: row.failed_count,
    error_message: row.error_message,
    metadata: parseMetadata(row.metadata),
  };
}

async function loadCollectionHealthRows() {
  const ingest = getRuntimeD1Binding("worldcons_ingest");
  if (!ingest) return null;
  const columns = "id, source_key, status, started_at, finished_at, fetched_count, failed_count, error_message, metadata";
  const [recent, successful] = await Promise.all([
    queryRows<Record<string, unknown>>(ingest, `SELECT ${columns} FROM ingestion_runs ORDER BY started_at DESC LIMIT 40`),
    queryRows<Record<string, unknown>>(ingest, `SELECT ${columns} FROM ingestion_runs WHERE status = 'completed' AND finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1`),
  ]);
  return {
    latest: runRow(recent[0]),
    successful: runRow(successful[0]),
    recent: recent.map(runRow).filter((row): row is CollectionHealthRunRow => row !== null),
  };
}

async function loadAdminJobCounts() {
  const ops = getRuntimeD1Binding("worldcons_ops");
  if (!ops) return null;
  const [row] = await queryRows<Record<string, unknown>>(
    ops,
    [
      "SELECT",
      "SUM(CASE WHEN status IN ('queued','running','cancel_requested') THEN 1 ELSE 0 END) AS pending_count,",
      "SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count",
      "FROM admin_jobs",
    ].join(" "),
  );
  return {
    pending: Number(row?.pending_count ?? 0),
    failed: Number(row?.failed_count ?? 0),
  };
}

async function loadSummaryBacklog() {
  const core = getRuntimeD1Binding("worldcons_core");
  if (!core) return null;
  const [row] = await queryRows<Record<string, unknown>>(
    core,
    [
      "SELECT COUNT(*) AS count, MIN(created_at) AS oldest_created_at",
      "FROM articles",
      "WHERE status IN (?, ?)",
      "AND lower(CAST(json_extract(source_metadata, '$.collection.publishable') AS TEXT)) = 'true'",
    ].join(" "),
    [...SUMMARY_BACKLOG_STATUSES],
  );
  const count = Number(row?.count ?? 0);
  return {
    count: Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0,
    oldestAt: typeof row?.oldest_created_at === "string" ? row.oldest_created_at : null,
  };
}

async function loadWorkflowHeartbeats() {
  const ops = getRuntimeD1Binding("worldcons_ops");
  return ops ? readOpsHeartbeatsFromD1(ops) : null;
}

function workflowHeartbeatIsStale(record: OpsHeartbeatReadRecord | null | undefined, now = Date.now()) {
  if (!record || record.lastStatus === "failed") return true;
  const observedAt = record.lastCompletedAt ?? record.lastStartedAt;
  const observedMs = Date.parse(observedAt);
  if (!Number.isFinite(observedMs)) return true;
  return now - observedMs > WORKFLOW_EXPECTED_INTERVAL_SECONDS[record.workflowKey] * 2.5 * 1_000;
}

export async function GET() {
  try {
    const [collection, jobs, candidateMetrics, control, summaryBacklog, embeddingReadiness, heartbeats] = await Promise.all([
      loadCollectionHealthRows().catch(() => null),
      loadAdminJobCounts().catch(() => null),
      getSourceUrlCandidateHealthMetrics().catch(() => null),
      getCollectionControlState(),
      loadSummaryBacklog().catch(() => null),
      getEmbeddingReadiness().catch(() => null),
      loadWorkflowHeartbeats().catch(() => null),
    ]);
    const queryFailed = collection === null || jobs === null || candidateMetrics === null || summaryBacklog === null || embeddingReadiness === null || heartbeats === null;
    const controlRequired = Boolean(process.env.MASTERDASH_CONTROL_SECRET?.trim());
    const paused = control.available && control.paused;
    const metrics = collectionHealthMetrics({
      latest: collection?.latest ?? null,
      successful: collection?.successful ?? null,
      recentRuns: collection?.recent ?? [],
      pendingItems: (jobs?.pending ?? 0) + (candidateMetrics?.openCandidateCount ?? 0),
      pendingAdminJobs: jobs?.pending ?? null,
      openCandidateCount: candidateMetrics?.openCandidateCount ?? null,
      retryableCandidateCount: candidateMetrics?.retryableCandidateCount ?? null,
      exhaustedCandidateCount: candidateMetrics?.exhaustedCandidateCount ?? null,
      oldestOpenCandidateAt: candidateMetrics?.oldestOpenCandidateAt ?? null,
      summaryBacklogCount: summaryBacklog?.count ?? null,
      oldestSummaryBacklogAt: summaryBacklog?.oldestAt ?? null,
      failedJobCount: jobs?.failed ?? null,
    });
    const recencyCutoffMs = Date.now() - FAILURE_RECENCY_WINDOW_HOURS * 3_600_000;
    const sourceUnhealthy = metrics.bySource.some((source) => {
      if (source.lastRunStatus !== "degraded" && source.lastRunStatus !== "failed") return false;
      const observedMs = source.lastCollectionAt ? Date.parse(source.lastCollectionAt) : Number.NaN;
      return !Number.isFinite(observedMs) || observedMs >= recencyCutoffMs;
    });
    const summaryStalled = summaryBacklogIsStale(metrics.summaryBacklogCount, metrics.oldestSummaryBacklogAt);
    const heartbeatByKey = new Map((heartbeats ?? []).map((heartbeat) => [heartbeat.workflowKey, heartbeat]));
    const stalledWorkflows = ([
      ["collection", true],
      ["summary", (metrics.summaryBacklogCount ?? 0) > 0],
      ["embedding", (embeddingReadiness?.missingArticleCount ?? 0) > 0],
      ["watchdog", true],
    ] as const)
      .filter(([key, required]) => required && workflowHeartbeatIsStale(heartbeatByKey.get(key)))
      .map(([key]) => key);
    const workflowStalled = stalledWorkflows.length > 0;
    const embeddingIncomplete = (embeddingReadiness?.missingArticleCount ?? 0) > 0 ||
      (embeddingReadiness?.missingPublishedArtifactCount ?? 0) > 0;
    const degraded = queryFailed || (controlRequired && !control.available) || sourceUnhealthy || summaryStalled || workflowStalled || embeddingIncomplete;
    const lastSuccessAt = metrics.lastSuccessfulCollectionAt;
    const lastSuccessMs = lastSuccessAt ? Date.parse(lastSuccessAt) : Number.NaN;
    const freshnessSeconds = Number.isFinite(lastSuccessMs)
      ? Math.max(0, Math.floor((Date.now() - lastSuccessMs) / 1000))
      : null;

    return NextResponse.json(
      {
        schemaVersion: 1,
        systemId: "worldcons",
        status: degraded ? "degraded" : "healthy",
        message: queryFailed || (controlRequired && !control.available)
          ? "Collector metrics or control state are unavailable."
          : sourceUnhealthy
            ? "Collector is ready, but at least one source completed in a degraded or failed state."
            : summaryStalled
              ? "Collection is running, but summarization is behind, so verified material is not reaching the public listing."
              : workflowStalled
                ? `Scheduled workflow heartbeat is stale or missing: ${stalledWorkflows.join(", ")}.`
                : embeddingIncomplete
                  ? "Gemini embedding corpus or published P3 artifact coverage is incomplete."
                  : paused
                    ? "Collector is ready; new collection starts are paused."
                    : "Collector is ready.",
        version: VERSION,
        metrics: {
          ...metrics,
          freshnessSeconds,
          missingEmbeddingCount: embeddingReadiness?.missingArticleCount ?? null,
          publishedEmbeddingVersionCount: embeddingReadiness?.publishedVersionCount ?? null,
          missingPublishedEmbeddingArtifactCount: embeddingReadiness?.missingPublishedArtifactCount ?? null,
          collectionPaused: paused,
          controlUpdatedAt: control.updatedAt,
          ...workflowHealthFields(heartbeatByKey, stalledWorkflows),
        },
      },
      { status: 200, headers: HEALTH_HEADERS },
    );
  } catch {
    return degradedHealth("Collector metrics are temporarily unavailable.");
  }
}

function workflowHealthFields(
  heartbeats: Map<OpsHeartbeatWorkflowKey, OpsHeartbeatReadRecord>,
  stalledWorkflows: OpsHeartbeatWorkflowKey[],
) {
  const value = (key: OpsHeartbeatWorkflowKey) => heartbeats.get(key);
  const observedAt = (key: OpsHeartbeatWorkflowKey) => value(key)?.lastCompletedAt ?? value(key)?.lastStartedAt ?? null;
  return {
    collectionWorkflowLastRunAt: observedAt("collection"),
    collectionWorkflowLastStatus: value("collection")?.lastStatus ?? null,
    summaryWorkflowLastRunAt: observedAt("summary"),
    summaryWorkflowLastStatus: value("summary")?.lastStatus ?? null,
    embeddingWorkflowLastRunAt: observedAt("embedding"),
    embeddingWorkflowLastStatus: value("embedding")?.lastStatus ?? null,
    watchdogWorkflowLastRunAt: observedAt("watchdog"),
    watchdogWorkflowLastStatus: value("watchdog")?.lastStatus ?? null,
    stalledWorkflows,
  };
}
