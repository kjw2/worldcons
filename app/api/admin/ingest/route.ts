import { NextResponse } from "next/server";
import { recordSiteEvent } from "@/lib/analytics/events";
import { runRefreshTagCounts, runSummarizeArticle, runSummarizePending } from "@/lib/ingest/summary";
import { adminMutationAuthFailureStatus } from "@/lib/utils/auth";
import { boundedInteger } from "@/lib/utils/numbers";

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
    const requestedAction = typeof body.action === "string" ? body.action : "ingest";
    const action = ["ingest", "ingest-and-summarize", "summarize", "retry-summary", "refresh-tags"].includes(requestedAction)
      ? requestedAction
      : "ingest";
    const sourceKey = typeof body.sourceKey === "string" ? body.sourceKey : undefined;
    const articleId = typeof body.articleId === "string" ? body.articleId : undefined;
    const slug = typeof body.slug === "string" ? body.slug : undefined;
    const limit = body.limit === undefined ? undefined : boundedInteger(body.limit, 20, { min: 1, max: 100 });
    const summarizeLimit = boundedInteger(body.summarizeLimit ?? limit ?? 20, 20, { min: 1, max: 100 });
    const allowVercelCrawling = body.allowVercelCrawling === true;
    const shouldSummarize = action === "summarize" || action === "retry-summary" || action === "ingest-and-summarize" || body.summarize === true;
    const shouldIngest = action === "ingest" || action === "ingest-and-summarize";
    const shouldRefreshTags = action === "refresh-tags" || body.refreshTags === true || shouldSummarize;
    const requestedOptions = {
      requestedAction,
      action,
      sourceKey: sourceKey ?? null,
      articleId: articleId ?? null,
      slug: slug ?? null,
      limit: limit ?? null,
      summarizeLimit,
      summarize: body.summarize === true,
      refreshTags: body.refreshTags === true,
      allowVercelCrawling,
    };

    auditMetadata = {
      action,
      requestedAction,
      requestedSourceKey: sourceKey ?? null,
      requestedArticleId: articleId ?? null,
      requestedArticleSlug: slug ?? null,
      requestedLimit: limit ?? null,
      requestedSummarizeLimit: summarizeLimit,
      requestedSummarize: body.summarize === true,
      requestedRefreshTags: body.refreshTags === true,
      requestedAllowVercelCrawling: allowVercelCrawling,
      shouldSummarize,
      shouldIngest,
      shouldRefreshTags,
      result: "started",
    };

    if (action === "retry-summary" && !articleId && !slug) {
      return NextResponse.json({ error: "articleId or slug is required" }, { status: 400 });
    }

    const result = shouldIngest
      ? await import("@/lib/ingest/run").then(({ runIngest }) => runIngest({ sourceKey, limit, allowVercelCrawling }))
      : null;
    const summarize = action === "retry-summary"
      ? await runSummarizeArticle({ articleId, slug })
      : shouldSummarize
        ? await runSummarizePending({ limit: summarizeLimit })
        : null;
    const tags = shouldRefreshTags && action !== "retry-summary"
      ? await runRefreshTagCounts().catch((refreshError) => {
          if (action === "refresh-tags") throw refreshError;
          return { refreshed: false, errorMessage: errorMessage(refreshError) };
        })
      : null;

    await recordSiteEvent(
      {
        eventType: "admin_action",
        path: "/api/admin/ingest",
        sourceKey,
        articleId,
        articleSlug: slug,
        metadata: {
          ...auditMetadata,
          result: "completed",
          ingest: ingestResultSummary(result),
          summarize: summarizeResultSummary(summarize),
          tags: tagResultSummary(tags),
        },
      },
      request.headers,
    ).catch(() => null);

    return NextResponse.json({ requested: requestedOptions, ingest: result, summarize, tags });
  } catch (error) {
    const message = errorMessage(error);
    console.error(`[admin ingest] ${message}`, error);
    await recordSiteEvent(
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
