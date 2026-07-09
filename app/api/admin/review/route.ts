import { NextResponse } from "next/server";
import { recordAdminSiteEvent } from "@/lib/analytics/events";
import { runAdminReviewAction } from "@/lib/ingest/review";
import { parseAdminReviewBody } from "@/lib/security/admin-api-validation";
import { adminMutationAuthFailureStatus } from "@/lib/utils/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(request: Request) {
  const authFailureStatus = adminMutationAuthFailureStatus(request);
  if (authFailureStatus) {
    return NextResponse.json({ error: authFailureStatus === 401 ? "Unauthorized" : "Forbidden" }, { status: authFailureStatus });
  }

  const body = await request.json().catch(() => ({} as Record<string, unknown>));
  const parsed = parseAdminReviewBody(body);
  if (!parsed.ok) {
    return NextResponse.json({ error: "Invalid admin review request", detail: parsed.error }, { status: 400 });
  }
  const { action, articleId, slug, note, provider, model } = parsed.data;

  const result = await runAdminReviewAction({ action, articleId, slug, note, provider, model });
  await recordAdminSiteEvent(
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
