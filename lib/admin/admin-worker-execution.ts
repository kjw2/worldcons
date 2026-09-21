import type { AdminJobWorkerResult, RunAdminJobWorkerInput } from "@/lib/admin/admin-job-runner";
import { isCloudflareWorkerRuntime } from "@/lib/runtime/platform";

export const ADMIN_EXTERNAL_WORKER_REQUIRED = "admin.external_worker_required";

export type RuntimeAdminJobWorkerResult = AdminJobWorkerResult | {
  mode: "external_worker_required";
  workerId: string;
  processed: 0;
  claimed: 0;
  succeeded: 0;
  failed: 0;
  jobs: [];
  error: typeof ADMIN_EXTERNAL_WORKER_REQUIRED;
};

export interface ScheduledIngestInput {
  ingestLimit: number;
  rangeDays: number;
  summaryLimit: number;
}

export type RuntimeScheduledIngestResult = {
  mode: "external_worker_required";
  complete: false;
  error: typeof ADMIN_EXTERNAL_WORKER_REQUIRED;
} | {
  mode: "inline";
  ingest: unknown;
  summarize: unknown;
  tags: unknown;
  analyticsRetention: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function summaryDeferred(value: unknown) {
  return isRecord(value) && (value.status === "deferred" || Number(value.deferredCount ?? 0) > 0);
}

function summaryFailed(value: unknown) {
  return isRecord(value) && (value.status === "failed" || Number(value.failedCount ?? 0) > 0);
}

export function runtimeAdminJobWorkerResultSucceeded(result: RuntimeAdminJobWorkerResult) {
  return result.mode === "worker"
    && !result.error
    && result.claimed > 0
    && result.processed > 0
    && result.processed === result.claimed
    && result.failed === 0;
}

export function runtimeScheduledIngestSucceeded(result: RuntimeScheduledIngestResult) {
  if (result.mode !== "inline") return false;
  const ingestSucceeded = isRecord(result.ingest)
    && result.ingest.mode !== "blocked"
    && (!Array.isArray(result.ingest.results)
      || result.ingest.results.every((row) => !isRecord(row) || Number(row.failedCount ?? 0) === 0));
  return ingestSucceeded
    && !summaryDeferred(result.summarize)
    && !summaryFailed(result.summarize)
    && isRecord(result.tags)
    && result.tags.refreshed === true;
}

export function inlineAdminExecutionAllowed(
  environment: Record<string, string | undefined> = process.env,
): boolean {
  if (isCloudflareWorkerRuntime()) return false;
  return environment.NODE_ENV !== "production" || environment.ADMIN_INGEST_INLINE_FALLBACK === "true";
}

export async function runAdminJobWorkerForRuntime(
  input: RunAdminJobWorkerInput,
): Promise<RuntimeAdminJobWorkerResult> {
  if (isCloudflareWorkerRuntime()) {
    return {
      mode: "external_worker_required",
      workerId: input.workerId?.trim() || "cloudflare-worker",
      processed: 0,
      claimed: 0,
      succeeded: 0,
      failed: 0,
      jobs: [],
      error: ADMIN_EXTERNAL_WORKER_REQUIRED,
    };
  }
  const { runAdminJobWorker } = await import("@/lib/admin/admin-job-runner");
  return runAdminJobWorker(input);
}

export async function runScheduledIngestForRuntime(
  input: ScheduledIngestInput,
): Promise<RuntimeScheduledIngestResult> {
  if (isCloudflareWorkerRuntime()) {
    return { mode: "external_worker_required", complete: false, error: ADMIN_EXTERNAL_WORKER_REQUIRED };
  }
  const [ingestModule, summaryModule, retentionModule, cacheModule] = await Promise.all([
    import("@/lib/ingest/run"),
    import("@/lib/ingest/summary"),
    import("@/lib/analytics/retention"),
    import("@/lib/public-content-cache"),
  ]);
  const ingest = await ingestModule.runIngest({
    limit: input.ingestLimit,
    rangeDays: input.rangeDays,
    refreshExisting: true,
  });
  const summarize = await summaryModule.runSummarizePending({ limit: input.summaryLimit });
  const tags = await summaryModule.runRefreshTagCounts();
  const analyticsRetention = await retentionModule.runSiteAnalyticsRetention();
  cacheModule.invalidatePublicContentCaches();
  return { mode: "inline", ingest, summarize, tags, analyticsRetention };
}

