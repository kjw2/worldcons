import { NextResponse } from "next/server";
import { buildAdminIngestJobContext, executeAdminIngestJobContext, type AdminIngestRequestContext } from "@/lib/admin/admin-ingest-jobs";
import { recordAdminSiteEvent } from "@/lib/analytics/events";
import { buildAdminJobIdempotencyKey, createAdminJob, type AdminJobRecord } from "@/lib/db/admin-jobs";
import { parseAdminIngestBody } from "@/lib/security/admin-api-validation";
import { adminMutationAuthFailureStatus } from "@/lib/utils/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 60;

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
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
    const context = buildAdminIngestJobContext(parsed.data);
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

    const { ingest, summarize, tags, resultSummary } = await executeAdminIngestJobContext(context);

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
          ingest: resultSummary.ingest,
          summarize: resultSummary.summarize,
          tags: resultSummary.tags,
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
