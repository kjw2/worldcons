import { NextResponse } from "next/server";
import { recordSiteEvent } from "@/lib/analytics/events";
import { runRefreshTagCounts, runSummarizeArticle, runSummarizePending } from "@/lib/ingest/summary";
import { isAuthorizedRequest } from "@/lib/utils/auth";
import { boundedInteger } from "@/lib/utils/numbers";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 60;

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export async function POST(request: Request) {
  if (!isAuthorizedRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

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
          action,
          limit,
          summarizeLimit,
          shouldSummarize,
          shouldIngest,
          shouldRefreshTags,
          allowVercelCrawling,
        },
      },
      request.headers,
    ).catch(() => null);

    return NextResponse.json({ ingest: result, summarize, tags });
  } catch (error) {
    const message = errorMessage(error);
    console.error(`[admin ingest] ${message}`, error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
