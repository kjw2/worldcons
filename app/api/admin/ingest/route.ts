import { NextResponse } from "next/server";
import { recordAdminSiteEvent } from "@/lib/analytics/events";
import { buildAdminJobIdempotencyKey, createAdminJob, type AdminJobRecord, type AdminJobType } from "@/lib/db/admin-jobs";
import { runRefreshTagCounts, runSummarizeArticle, runSummarizePending } from "@/lib/ingest/summary";
import { parseAdminIngestBody, type AdminIngestBody } from "@/lib/security/admin-api-validation";
import { adminMutationAuthFailureStatus } from "@/lib/utils/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 60;

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function countFromResults(value: unknown, key: string) {
  if (!isRecord(value) || !Array.isArray(value.results)) return 0;
  return value.results.reduce((sum, item) => (isRecord(item) && typeof item[key] === "number" ? sum + item[key] : sum), 0);
}

function ingestResultSummary(value: unknown) {
  if (!isRecord(value)) return undefined;
  const mode = typeof value.mode === "string" ? value.mode : undefined;
  return {
    mode,
    sourceCount: Array.isArray(value.results) ? value.results.length : 0,
    discoveredCount: countFromResults(value, "discoveredCount"),
    fetchedCount: countFromResults(value, "fetchedCount"),
    summarizedCount: countFromResults(value, "summarizedCount"),
    failedCount: countFromResults(value, "failedCount"),
  };
}

function summarizeResultSummary(value: unknown) {
  if (!isRecord(value)) return undefined;
  return {
    mode: typeof value.mode === "string" ? value.mode : undefined,
    status: typeof value.status === "string" ? value.status : undefined,
    summarizedCount: typeof value.summarizedCount === "number" ? value.summarizedCount : 0,
    failedCount: typeof value.failedCount === "number" ? value.failedCount : 0,
    skippedCount: typeof value.skippedCount === "number" ? value.skippedCount : 0,
  };
}

function tagResultSummary(value: unknown) {
  if (!isRecord(value)) return undefined;
  return {
    refreshed: value.refreshed === true,
    updatedTags: typeof value.updatedTags === "number" ? value.updatedTags : undefined,
  };
}

type AdminIngestJobType = Extract<AdminJobType, "ingest" | "ingest-and-summarize" | "summarize" | "retry-summary" | "refresh-tags">;

interface AdminIngestRequestContext {
  action: AdminIngestJobType;
  requestedAction: AdminIngestJobType;
  sourceKey?: string;
  articleId?: string;
  slug?: string;
  limit?: number;
  summarizeLimit: number;
  allowVercelCrawling: boolean;
  shouldSummarize: boolean;
  shouldIngest: boolean;
  shouldRefreshTags: boolean;
  requestedOptions: Record<string, unknown>;
  jobOptions: Record<string, unknown>;
  auditMetadata: Record<string, unknown>;
}

function buildIngestRequestContext(input: AdminIngestBody): AdminIngestRequestContext {
  const { action, sourceKey, articleId, slug, limit, allowVercelCrawling } = input;
  const requestedAction = action;
  const summarizeLimit = input.summarizeLimit ?? limit ?? 20;
  const shouldSummarize = action === "summarize" || action === "retry-summary" || action === "ingest-and-summarize" || input.summarize;
  const shouldIngest = action === "ingest" || action === "ingest-and-summarize";
  const shouldRefreshTags = action === "refresh-tags" || input.refreshTags || shouldSummarize;
  const jobOptions = {
    action,
    sourceKey: sourceKey ?? null,
    limit: limit ?? null,
    summarizeLimit,
    summarize: input.summarize,
    refreshTags: input.refreshTags,
    allowVercelCrawling,
    articleId: articleId ?? null,
    slug: slug ?? null,
  };
  const requestedOptions = {
    requestedAction,
    ...jobOptions,
  };
  const auditMetadata = {
    action,
    requestedAction,
    requestedSourceKey: sourceKey ?? null,
    requestedArticleId: articleId ?? null,
    requestedArticleSlug: slug ?? null,
    requestedLimit: limit ?? null,
    requestedSummarizeLimit: summarizeLimit,
    requestedSummarize: input.summarize,
    requestedRefreshTags: input.refreshTags,
    requestedAllowVercelCrawling: allowVercelCrawling,
    shouldSummarize,
    shouldIngest,
    shouldRefreshTags,
    result: "started",
  };

  return {
    action,
    requestedAction,
    sourceKey,
    articleId,
    slug,
    limit,
    summarizeLimit,
    allowVercelCrawling,
    shouldSummarize,
    shouldIngest,
    shouldRefreshTags,
    requestedOptions,
    jobOptions,
    auditMetadata,
  };
}

function canRunInlineFallback() {
  return process.env.NODE_ENV !== "production" || process.env.ADMIN_INGEST_INLINE_FALLBACK === "true";
}

function publicJob(job: AdminJobRecord) {
  return {
    id: job.id,
    status: job.status,
    jobType: job.jobType,
    sourceKey: job.sourceKey,
    articleId: job.articleId,
    articleSlug: job.articleSlug,
    requestedAt: job.requestedAt,
  };
}

async function enqueueAdminIngestJob(context: AdminIngestRequestContext) {
  const idempotencyKey = buildAdminJobIdempotencyKey({
    jobType: context.action,
    sourceKey: context.sourceKey,
    articleId: context.articleId,
    articleSlug: context.slug,
    options: context.jobOptions,
  });
  return createAdminJob({
    jobType: context.action,
    sourceKey: context.sourceKey,
    articleId: context.articleId,
    articleSlug: context.slug,
    priority: context.action === "retry-summary" ? 20 : context.action === "summarize" ? 10 : 0,
    idempotencyKey,
    options: context.jobOptions,
  });
}

async function runInlineAdminIngest(context: AdminIngestRequestContext) {
  const { summarizeLimit, sourceKey } = context;
  const result = context.shouldIngest
    ? await import("@/lib/ingest/run").then(({ runIngest }) =>
        runIngest({ sourceKey, limit: context.limit, allowVercelCrawling: context.allowVercelCrawling }),
      )
    : null;
  const summarize = context.action === "retry-summary"
    ? await runSummarizeArticle({ articleId: context.articleId, slug: context.slug })
    : context.shouldSummarize
      ? await runSummarizePending({ limit: summarizeLimit, sourceKey })
      : null;
  const tags = context.shouldRefreshTags && context.action !== "retry-summary"
    ? await runRefreshTagCounts().catch((refreshError) => {
        if (context.action === "refresh-tags") throw refreshError;
        return { refreshed: false, errorMessage: errorMessage(refreshError) };
      })
    : null;

  return { ingest: result, summarize, tags };
}

export async function POST(request: Request) {
  const authFailureStatus = adminMutationAuthFailureStatus(request);
  if (authFailureStatus) {
    return NextResponse.json({ error: authFailureStatus === 401 ? "Unauthorized" : "Forbidden" }, { status: authFailureStatus });
  }

  let auditMetadata: Record<string, unknown> = {
    action: "ingest",
    requestedAction: "ingest",
    result: "error",
  };

  try {
    const body = await request.json().catch(() => ({} as Record<string, unknown>));
    const parsed = parseAdminIngestBody(body);
    if (!parsed.ok) {
      return NextResponse.json({ error: "Invalid admin ingest request", detail: parsed.error }, { status: 400 });
    }
    const context = buildIngestRequestContext(parsed.data);
    const { action, sourceKey, articleId, slug } = context;
    auditMetadata = context.auditMetadata;

    if (action === "retry-summary" && !articleId && !slug) {
      return NextResponse.json({ error: "articleId or slug is required" }, { status: 400 });
    }

    const queued = await enqueueAdminIngestJob(context);
    if (queued.ok) {
      await recordAdminSiteEvent(
        {
          eventType: "admin_action",
          path: "/api/admin/ingest",
          sourceKey,
          articleId,
          articleSlug: slug,
          metadata: {
            ...auditMetadata,
            result: "queued",
            jobId: queued.data.job.id,
            jobType: queued.data.job.jobType,
            created: queued.data.created,
          },
        },
        request.headers,
      ).catch(() => null);

      return NextResponse.json(
        {
          requested: context.requestedOptions,
          mode: "queued",
          job: publicJob(queued.data.job),
          created: queued.data.created,
        },
        { status: 202 },
      );
    }

    if (!queued.unavailable || !canRunInlineFallback()) {
      await recordAdminSiteEvent(
        {
          eventType: "admin_action",
          path: "/api/admin/ingest",
          sourceKey,
          articleId,
          articleSlug: slug,
          metadata: {
            ...auditMetadata,
            result: "queue_unavailable",
            error: queued.error,
          },
        },
        request.headers,
      ).catch(() => null);
      return NextResponse.json(
        {
          error: queued.unavailable ? "Admin job queue is unavailable. Apply the admin_jobs migration before running admin ingest jobs in production." : queued.error,
          detail: queued.error,
          requested: context.requestedOptions,
          mode: "queue_unavailable",
        },
        { status: queued.unavailable ? 503 : 500 },
      );
    }

    const { ingest, summarize, tags } = await runInlineAdminIngest(context);

    await recordAdminSiteEvent(
      {
        eventType: "admin_action",
        path: "/api/admin/ingest",
        sourceKey,
        articleId,
        articleSlug: slug,
        metadata: {
          ...auditMetadata,
          result: "completed",
          mode: "inline",
          queueFallback: queued.error,
          ingest: ingestResultSummary(ingest),
          summarize: summarizeResultSummary(summarize),
          tags: tagResultSummary(tags),
        },
      },
      request.headers,
    ).catch(() => null);

    return NextResponse.json({ requested: context.requestedOptions, mode: "inline", ingest, summarize, tags });
  } catch (error) {
    const message = errorMessage(error);
    console.error(`[admin ingest] ${message}`, error);
    await recordAdminSiteEvent(
      {
        eventType: "admin_action",
        path: "/api/admin/ingest",
        metadata: {
          ...auditMetadata,
          result: "error",
          error: message,
        },
      },
      request.headers,
    ).catch(() => null);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
