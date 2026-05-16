import { NextResponse } from "next/server";
import { recordSiteEvent } from "@/lib/analytics/events";
import { runAdminReviewAction, type AdminReviewAction } from "@/lib/ingest/review";
import { isAuthorizedRequest } from "@/lib/utils/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const REVIEW_ACTIONS = new Set<AdminReviewAction>([
  "approve-and-summarize",
  "retry-summary",
  "resummarize-with-model",
  "publish-reviewed",
  "close-private",
  "retry-source-ingest",
]);

export async function POST(request: Request) {
  if (!isAuthorizedRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => ({} as Record<string, unknown>));
  const action = typeof body.action === "string" && REVIEW_ACTIONS.has(body.action as AdminReviewAction)
    ? (body.action as AdminReviewAction)
    : null;
  const articleId = typeof body.articleId === "string" ? body.articleId : undefined;
  const slug = typeof body.slug === "string" ? body.slug : undefined;
  const note = typeof body.note === "string" ? body.note : undefined;
  const provider = body.provider === "openai" || body.provider === "gemini" ? body.provider : undefined;
  const model = typeof body.model === "string" ? body.model : undefined;

  if (!action) {
    return NextResponse.json({ error: "Unsupported review action" }, { status: 400 });
  }
  if (!articleId && !slug) {
    return NextResponse.json({ error: "articleId or slug is required" }, { status: 400 });
  }

  const result = await runAdminReviewAction({ action, articleId, slug, note, provider, model });
  await recordSiteEvent(
    {
      eventType: "admin_review_action",
      path: "/api/admin/review",
      articleId,
      articleSlug: slug,
      metadata: {
        action,
        provider,
        model,
        status: "status" in result ? result.status : undefined,
      },
    },
    request.headers,
  );
  return NextResponse.json({ review: result });
}
