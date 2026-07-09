import { NextResponse } from "next/server";
import { recordAdminSiteEvent } from "@/lib/analytics/events";
import { runAdminArticleBulkAction } from "@/lib/db/admin-queries";
import { parseAdminArticleBulkBody } from "@/lib/security/admin-api-validation";
import { adminMutationAuthFailureStatus } from "@/lib/utils/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(request: Request) {
  const authFailureStatus = adminMutationAuthFailureStatus(request);
  if (authFailureStatus) {
    return NextResponse.json({ error: authFailureStatus === 401 ? "Unauthorized" : "Forbidden" }, { status: authFailureStatus });
  }

  const body = await request.json().catch(() => ({}));
  const parsed = parseAdminArticleBulkBody(body);
  if (!parsed.ok) {
    return NextResponse.json({ error: "Invalid admin bulk request", detail: parsed.error }, { status: 400 });
  }
  const { action, refs, note } = parsed.data;
  const result = await runAdminArticleBulkAction({ action, refs, note });

  await recordAdminSiteEvent(
    {
      eventType: "admin_review_action",
      path: "/api/admin/articles/bulk",
      metadata: {
        action,
        requestedCount: result.requestedCount,
        matchedCount: result.matchedCount,
        updatedCount: result.updatedCount,
      },
    },
    request.headers,
  );

  return NextResponse.json({ bulk: result });
}
