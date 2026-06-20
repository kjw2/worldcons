import { NextResponse } from "next/server";
import { recordSiteEvent } from "@/lib/analytics/events";
import { updateArticleSummaryManually } from "@/lib/ingest/manual-summary-edit";
import { adminMutationAuthFailureStatus } from "@/lib/utils/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(request: Request, { params }: { params: Promise<{ articleId: string }> }) {
  const authFailureStatus = adminMutationAuthFailureStatus(request);
  if (authFailureStatus) {
    return NextResponse.json({ error: authFailureStatus === 401 ? "Unauthorized" : "Forbidden" }, { status: authFailureStatus });
  }

  const { articleId } = await params;
  const body = await request.json().catch(() => ({}));
  const result = await updateArticleSummaryManually({ articleId, body });

  await recordSiteEvent(
    {
      eventType: "admin_review_action",
      path: "/api/admin/articles/[articleId]/summary",
      articleId,
      articleSlug: "slug" in result ? result.slug : undefined,
      metadata: {
        action: "manual_summary_edit",
        status: "status" in result ? result.status : undefined,
        changedFields: "changedFields" in result ? result.changedFields : undefined,
      },
    },
    request.headers,
  );

  const status = result.status === "not_found" ? 404 : result.status === "invalid" ? 400 : 200;
  return NextResponse.json({ edit: result }, { status });
}
