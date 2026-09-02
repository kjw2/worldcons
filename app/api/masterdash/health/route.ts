import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/db/client";
import { getSourceUrlCandidateHealthMetrics } from "@/lib/db/source-url-candidates";
import { getCollectionControlState } from "@/lib/masterdash/store";
import { getEmbeddingReadiness } from "@/lib/ingest/embedding-backlog";
import {
  getWorkflowHeartbeats,
  workflowHeartbeatIsStale,
  type WorkflowHeartbeatRecord,
  type WorkflowKey,
} from "@/lib/ops/workflow-heartbeat";
import {
  collectionHealthMetrics,
  FAILURE_RECENCY_WINDOW_HOURS,
  SUMMARY_BACKLOG_STATUSES,
  summaryBacklogIsStale,
} from "@/lib/masterdash/health";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const HEALTH_HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

function degradedHealth(message: string) {
  return NextResponse.json(
    {
      schemaVersion: 1,
      systemId: "worldcons",
      status: "degraded",
      message,
      version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) || "0.1.0",
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

export async function GET() {
  try {
    const supabase = getSupabaseAdmin();
    if (!supabase) return degradedHealth("Collector database is not configured.");

    // Collection freshness alone cannot reveal a stalled summariser: source text can keep
    // arriving while nothing reaches the public listing. Report that backlog as its own axis.
    const [latest, successful, recent, pending, failed, candidateMetrics, control, summaryBacklog, oldestSummaryBacklog, embeddingReadiness, heartbeats] = await Promise.all([
      supabase.from("ingestion_runs").select("id, source_key, status, started_at, finished_at, fetched_count, failed_count, error_message, metadata").order("started_at", { ascending: false }).limit(1).maybeSingle(),
      supabase.from("ingestion_runs").select("source_key, finished_at, metadata").eq("status", "completed").order("finished_at", { ascending: false, nullsFirst: false }).limit(1).maybeSingle(),
      supabase.from("ingestion_runs").select("id, source_key, status, started_at, finished_at, fetched_count, failed_count, error_message, metadata").order("started_at", { ascending: false }).limit(40),
      supabase.from("admin_jobs").select("id", { count: "exact", head: true }).in("status", ["queued", "running", "cancel_requested"]),
      supabase.from("admin_jobs").select("id", { count: "exact", head: true }).eq("status", "failed"),
      getSourceUrlCandidateHealthMetrics().catch(() => null),
      getCollectionControlState(),
      supabase
        .from("articles")
        .select("id", { count: "exact", head: true })
        .in("status", [...SUMMARY_BACKLOG_STATUSES])
        .contains("source_metadata", { collection: { publishable: true } }),
      supabase
        .from("articles")
        .select("created_at")
        .in("status", [...SUMMARY_BACKLOG_STATUSES])
        .contains("source_metadata", { collection: { publishable: true } })
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle(),
      getEmbeddingReadiness().catch(() => null),
      getWorkflowHeartbeats().catch(() => null),
    ]);
    const queryFailed = Boolean(
      latest.error ||
        successful.error ||
        recent.error ||
        pending.error ||
        failed.error ||
        summaryBacklog.error ||
        oldestSummaryBacklog.error ||
        candidateMetrics === null ||
        embeddingReadiness === null ||
        heartbeats === null,
    );
    const controlRequired = Boolean(process.env.MASTERDASH_CONTROL_SECRET?.trim());
    const paused = control.available && control.paused;
    const metrics = collectionHealthMetrics({
      latest: latest.data,
      successful: successful.data,
      recentRuns: recent.data ?? [],
      pendingItems: (pending.count ?? 0) + (candidateMetrics?.openCandidateCount ?? 0),
      pendingAdminJobs: pending.error ? null : pending.count ?? 0,
      openCandidateCount: candidateMetrics?.openCandidateCount ?? null,
      retryableCandidateCount: candidateMetrics?.retryableCandidateCount ?? null,
      exhaustedCandidateCount: candidateMetrics?.exhaustedCandidateCount ?? null,
      oldestOpenCandidateAt: candidateMetrics?.oldestOpenCandidateAt ?? null,
      summaryBacklogCount: summaryBacklog.error ? null : summaryBacklog.count ?? 0,
      oldestSummaryBacklogAt: (oldestSummaryBacklog.data?.created_at as string | undefined) ?? null,
      failedJobCount: failed.count ?? null,
    });
    // Age the per-source signal the same way as failureTarget: once collection stops the
    // newest run stays failed forever and would pin this system to degraded permanently.
    const recencyCutoffMs = Date.now() - FAILURE_RECENCY_WINDOW_HOURS * 3_600_000;
    const sourceUnhealthy = metrics.bySource.some((source) => {
      if (source.lastRunStatus !== "degraded" && source.lastRunStatus !== "failed") return false;
      const observedMs = source.lastCollectionAt ? Date.parse(source.lastCollectionAt) : Number.NaN;
      return !Number.isFinite(observedMs) || observedMs >= recencyCutoffMs;
    });
    // A stalled summariser keeps articles out of the public listing even while collection
    // looks healthy, so it has to be able to move the status on its own.
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
        version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) || "0.1.0",
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
  heartbeats: Map<WorkflowKey, WorkflowHeartbeatRecord>,
  stalledWorkflows: WorkflowKey[],
) {
  const value = (key: WorkflowKey) => heartbeats.get(key);
  const observedAt = (key: WorkflowKey) => value(key)?.lastCompletedAt ?? value(key)?.lastStartedAt ?? null;
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
