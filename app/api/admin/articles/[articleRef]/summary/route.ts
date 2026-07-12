import { NextResponse } from "next/server";
import { executeAdminCompatibilityCommand } from "@/lib/admin/command-control-plane/compatibility";
import { recordAdminSiteEvent } from "@/lib/analytics/events";
import { updateArticleSummaryManually } from "@/lib/ingest/manual-summary-edit";
import { invalidatePublicContentCaches } from "@/lib/public-content-cache";
import { adminMutationAuthFailureStatus } from "@/lib/utils/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(request: Request, { params }: { params: Promise<{ articleRef: string }> }) {
  const authFailureStatus = adminMutationAuthFailureStatus(request);
  if (authFailureStatus) {
    return NextResponse.json({ error: authFailureStatus === 401 ? "Unauthorized" : "Forbidden" }, { status: authFailureStatus });
  }

  const { articleRef: articleId } = await params;
  const body = await request.json().catch(() => ({}));
  const compatibility = await executeAdminCompatibilityCommand(
    {
      commandType: "admin.article.summary.manual",
      payloadRef: { articleId, requestedFields: body && typeof body === "object" ? Object.keys(body as Record<string, unknown>) : [] },
      request,
    },
    () => updateArticleSummaryManually({ articleId, body }),
  );
  const result = compatibility.value;
  if (result.status === "updated") {
    invalidatePublicContentCaches({ articleSlug: result.slug });
  }

  await recordAdminSiteEvent(
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
