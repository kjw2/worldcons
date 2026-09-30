import {
  appendAdminJobEvent,
  claimAdminJob,
  getAdminJob,
  markAdminJobCancelled,
  markAdminJobFailed,
  markAdminJobSucceeded,
  type AdminJobRecord,
} from "../../../lib/db/admin-jobs";
import { NATIVE_CRAWLER_SOURCES, runNativeSourceCollection, type NativeCrawlerBindings, type NativeCrawlerSource } from "./native-crawler";

const NATIVE_ADMIN_JOB_TYPES = ["ingest", "ingest-and-summarize", "summarize", "retry-summary", "refresh-tags"] as const;

interface AdminJobAppService {
  runSummaryDrain(input: { limit?: number; maxPasses?: number; sourceKey?: string; retryAttempts?: number; retryDelayMs?: number }): Promise<unknown>;
  runSummaryArticle(input: { articleId?: string; slug?: string; model?: string }): Promise<unknown>;
  runRefreshTagCounts(): Promise<unknown>;
}

interface AdminJobDrainEnvironment extends NativeCrawlerBindings {
  WORLDCONS_APP_SERVICE: AdminJobAppService;
}

function integer(value: unknown, fallback: number, min: number, max: number) {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.trunc(parsed))) : fallback;
}

function sourceFor(job: AdminJobRecord): NativeCrawlerSource | null {
  const candidate = job.sourceKey ?? (typeof job.options.sourceKey === "string" ? job.options.sourceKey : null);
  return candidate && NATIVE_CRAWLER_SOURCES.includes(candidate as NativeCrawlerSource) ? candidate as NativeCrawlerSource : null;
}

async function event(jobId: string, eventType: string, message: string, metadata: Record<string, unknown> = {}) {
  await appendAdminJobEvent({ jobId, eventType, message, metadata }).catch(() => undefined);
}

async function finalizeCancellation(job: AdminJobRecord, reason: string) {
  let cancelled = await markAdminJobCancelled({ jobId: job.id, reason });
  if (!cancelled.ok) throw new Error(cancelled.error);
  if (cancelled.data.status === "cancel_requested") {
    cancelled = await markAdminJobCancelled({ jobId: job.id, reason });
    if (!cancelled.ok) throw new Error(cancelled.error);
  }
  if (cancelled.data.status !== "cancelled") throw new Error(`admin_job.cancel_not_final:${cancelled.data.status}`);
  await event(job.id, "cancelled", "Cloudflare-native admin job cancelled.", { jobType: job.jobType });
  return cancelled.data;
}

async function executeJob(
  env: AdminJobDrainEnvironment,
  job: AdminJobRecord,
  browserNavigate: (input: { url: string; timeoutMs: number; waitUntil: "domcontentloaded"; userAgent: string }) => Promise<{ html: string; finalUrl: string; status: number; headers: Record<string, string> }>,
) {
  const source = sourceFor(job);
  const limit = integer(job.options.limit, 20, 1, 20);
  const rangeDays = integer(job.options.rangeDays, 0, 0, 730) || undefined;
  const summarizeLimit = integer(job.options.summarizeLimit ?? job.options.limit, 20, 1, 100);
  let ingest: unknown = null;
  let summarize: unknown = null;
  let tags: unknown = null;

  if (job.jobType === "ingest" || job.jobType === "ingest-and-summarize") {
    const sources = source ? [source] : [...NATIVE_CRAWLER_SOURCES];
    const results = [];
    for (const item of sources) {
      results.push(await runNativeSourceCollection(item, env, {
        limit,
        rangeDays,
        idempotencyKey: `admin-job:${job.id}:${item}`,
        browserNavigate,
      }));
    }
    ingest = { mode: "cloudflare-native", results };
  }

  if (job.jobType === "retry-summary") {
    const provider = typeof job.options.provider === "string" ? job.options.provider : "gemini";
    if (provider !== "gemini") throw new Error("admin_job.unsupported_summary_provider");
    summarize = await env.WORLDCONS_APP_SERVICE.runSummaryArticle({
      articleId: job.articleId ?? (typeof job.options.articleId === "string" ? job.options.articleId : undefined),
      slug: job.articleSlug ?? (typeof job.options.slug === "string" ? job.options.slug : undefined),
      model: typeof job.options.model === "string" ? job.options.model : undefined,
    });
  } else if (job.jobType === "summarize" || job.jobType === "ingest-and-summarize") {
    summarize = await env.WORLDCONS_APP_SERVICE.runSummaryDrain({
      limit: summarizeLimit,
      maxPasses: 6,
      sourceKey: source ?? undefined,
      retryAttempts: 1,
      retryDelayMs: 65_000,
    });
  }

  if (job.jobType === "refresh-tags") tags = await env.WORLDCONS_APP_SERVICE.runRefreshTagCounts();
  return { ingest, summarize, tags, jobType: job.jobType, sourceKey: source };
}

export async function runNativeAdminJobDrain(input: {
  env: AdminJobDrainEnvironment;
  idempotencyKey: string;
  maxJobs?: number;
  leaseSeconds?: number;
  browserNavigate: (input: { url: string; timeoutMs: number; waitUntil: "domcontentloaded"; userAgent: string }) => Promise<{ html: string; finalUrl: string; status: number; headers: Record<string, string> }>;
}) {
  const workerId = `m8:${input.idempotencyKey}`;
  const maxJobs = integer(input.maxJobs, 2, 1, 10);
  const leaseSeconds = integer(input.leaseSeconds, 1200, 10, 3600);
  const jobs: Array<{ id: string; jobType: string; status: "succeeded" | "failed" | "cancelled"; error?: string }> = [];
  let claimed = 0;
  let succeeded = 0;
  let failed = 0;

  for (let index = 0; index < maxJobs; index += 1) {
    const claim = await claimAdminJob({ workerId, jobTypes: [...NATIVE_ADMIN_JOB_TYPES], leaseSeconds });
    if (!claim.ok) throw new Error(claim.error);
    const job = claim.data;
    if (!job) break;
    claimed += 1;
    if (job.status === "cancel_requested" || job.cancelRequestedAt) {
      await finalizeCancellation(job, job.cancelReason ?? "Cancellation requested before native execution.");
      jobs.push({ id: job.id, jobType: job.jobType, status: "cancelled" });
      continue;
    }
    await event(job.id, "started", "Cloudflare-native admin job started.", { workerId });
    try {
      const resultSummary = await executeJob(input.env, job, input.browserNavigate);
      const latest = await getAdminJob(job.id);
      if (!latest.ok) throw new Error(latest.error);
      if (latest.data.status === "cancel_requested" || latest.data.cancelRequestedAt) {
        await finalizeCancellation(latest.data, latest.data.cancelReason ?? "Cancellation requested during native execution.");
        jobs.push({ id: job.id, jobType: job.jobType, status: "cancelled" });
        continue;
      }
      const marked = await markAdminJobSucceeded({ jobId: job.id, resultSummary });
      if (!marked.ok) {
        const raced = await getAdminJob(job.id);
        if (raced.ok && (raced.data.status === "cancel_requested" || raced.data.cancelRequestedAt)) {
          await finalizeCancellation(raced.data, raced.data.cancelReason ?? "Cancellation won the completion race.");
          jobs.push({ id: job.id, jobType: job.jobType, status: "cancelled" });
          continue;
        }
        throw new Error(marked.error);
      }
      succeeded += 1;
      jobs.push({ id: job.id, jobType: job.jobType, status: "succeeded" });
      await event(job.id, "succeeded", "Cloudflare-native admin job completed.", resultSummary as Record<string, unknown>);
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      await markAdminJobFailed({ jobId: job.id, errorClass: "admin_job.cloudflare_native_failed", errorMessage: message, resultSummary: { jobType: job.jobType, status: "failed" } });
      await event(job.id, "failed", message, { jobType: job.jobType });
      failed += 1;
      jobs.push({ id: job.id, jobType: job.jobType, status: "failed", error: message });
    }
  }

  return { mode: "worker" as const, workerId, processed: jobs.length, claimed, succeeded, failed, jobs };
}
