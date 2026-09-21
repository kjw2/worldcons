import { NextResponse } from "next/server";
import { adminIngestResultSucceeded } from "@/lib/admin/admin-ingest-jobs";
import { executeAdminCompatibilityCommand } from "@/lib/admin/command-control-plane/compatibility";
import { recordAdminSiteEvent } from "@/lib/analytics/events";
import { invalidatePublicContentCaches } from "@/lib/public-content-cache";
import { parseAdminReviewBody } from "@/lib/security/admin-api-validation";
import { adminMutationAuthFailureStatus } from "@/lib/utils/auth";
import { isCloudflareWorkerRuntime } from "@/lib/runtime/platform";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reviewChangedPublicContent(value: unknown) {
  if (!isRecord(value) || value.mode !== "database") return false;
  if (value.status === "published" || value.status === "closed_private") return true;
  if (isRecord(value.summarize) && value.summarize.status === "summarized") return true;
  return "ingest" in value;
}

function reviewActionSucceeded(value: unknown) {
  if (!isRecord(value) || value.mode !== "database") return false;
  if (value.status === "published" || value.status === "closed_private") return true;
  if (isRecord(value.summarize)) return value.summarize.status === "summarized";
  return adminIngestResultSucceeded(value.ingest);
}

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

  if (action === "retry-source-ingest" && isCloudflareWorkerRuntime()) {
    await recordAdminSiteEvent(
      {
        eventType: "admin_review_action",
        path: "/api/admin/review",
        articleId,
        articleSlug: slug,
        metadata: { action, status: "external_worker_required" },
      },
      request.headers,
    ).catch(() => null);
    return NextResponse.json({ error: "admin.external_worker_required", action }, { status: 503 });
  }

  const compatibility = await executeAdminCompatibilityCommand(
    {
      commandType: "admin.article.review",
      payloadRef: { action, articleId, slug, provider, model, notePresent: Boolean(note) },
      request,
    },
    () => import("@/lib/ingest/review").then(({ runAdminReviewAction }) =>
      runAdminReviewAction({ action, articleId, slug, note, provider, model })
    ),
    { isLegacySuccess: reviewActionSucceeded },
  );
  const result = compatibility.value;
  if (reviewChangedPublicContent(result)) {
    invalidatePublicContentCaches({ articleSlug: slug });
  }
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
