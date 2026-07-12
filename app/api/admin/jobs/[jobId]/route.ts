import { NextResponse } from "next/server";
import { executeAdminCompatibilityCommand } from "@/lib/admin/command-control-plane/compatibility";
import { recordAdminSiteEvent } from "@/lib/analytics/events";
import {
  appendAdminJobEvent,
  markAdminJobCancelled,
  retryAdminJob,
  type AdminJobRecord,
} from "@/lib/db/admin-jobs";
import { parseAdminJobActionBody } from "@/lib/security/admin-api-validation";
import { adminMutationAuthFailureStatus } from "@/lib/utils/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function publicJob(job: AdminJobRecord) {
  return {
    id: job.id,
    status: job.status,
    jobType: job.jobType,
    sourceKey: job.sourceKey,
    articleId: job.articleId,
    articleSlug: job.articleSlug,
    parentJobId: job.parentJobId,
    requestedAt: job.requestedAt,
  };
}

function errorStatus(error: string, unavailable?: boolean) {
  if (unavailable) return 503;
  const lower = error.toLowerCase();
  if (lower.includes("not found")) return 404;
  if (lower.includes("cannot") || lower.includes("already")) return 409;
  return 500;
}

async function appendJobEventSafe(input: Parameters<typeof appendAdminJobEvent>[0]) {
  await appendAdminJobEvent(input).catch(() => null);
}

export function GET() {
  return new Response(null, { status: 405, headers: { allow: "POST" } });
}

export async function POST(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const authFailureStatus = adminMutationAuthFailureStatus(request);
  if (authFailureStatus) {
    return NextResponse.json({ error: authFailureStatus === 401 ? "Unauthorized" : "Forbidden" }, { status: authFailureStatus });
  }

  const { jobId: rawJobId } = await params;
  const jobId = rawJobId.trim();
  if (!jobId || jobId.length > 120) {
    return NextResponse.json({ error: "Invalid admin job id" }, { status: 400 });
  }

  const body = await request.json().catch(() => ({} as Record<string, unknown>));
  const parsed = parseAdminJobActionBody(body);
  if (!parsed.ok) {
    return NextResponse.json({ error: "Invalid admin job action request", detail: parsed.error }, { status: 400 });
  }

  if (parsed.data.action === "cancel") {
    const compatibility = await executeAdminCompatibilityCommand(
      { commandType: "admin.jobs.cancel", payloadRef: { jobId, reasonPresent: Boolean(parsed.data.reason) }, request, priority: 100 },
      () => markAdminJobCancelled({ jobId, reason: parsed.data.reason }),
      { isLegacySuccess: (result) => result.ok },
    );
    const cancelled = compatibility.value;
    if (!cancelled.ok) {
      await recordAdminSiteEvent(
        {
          eventType: "admin_action",
          path: `/api/admin/jobs/${jobId}`,
          metadata: {
            action: "job_cancel",
            jobId,
            result: "failed",
            error: cancelled.error,
          },
        },
        request.headers,
      ).catch(() => null);
      return NextResponse.json({ error: cancelled.error }, { status: errorStatus(cancelled.error, cancelled.unavailable) });
    }

    const eventType = cancelled.data.status === "cancel_requested" ? "cancel_requested" : "cancelled";
    await appendJobEventSafe({
      jobId,
      eventType,
      message: cancelled.data.status === "cancel_requested" ? "Admin requested cancellation for a running job." : "Admin cancelled a queued job.",
      metadata: {
        jobId,
        status: cancelled.data.status,
        reason: parsed.data.reason ?? null,
      },
    });
    await recordAdminSiteEvent(
      {
        eventType: "admin_action",
        path: `/api/admin/jobs/${jobId}`,
        sourceKey: cancelled.data.sourceKey,
        articleId: cancelled.data.articleId,
        articleSlug: cancelled.data.articleSlug,
        metadata: {
          action: "job_cancel",
          jobId,
          jobType: cancelled.data.jobType,
          result: cancelled.data.status === "cancel_requested" ? "cancel_requested" : "cancelled",
          status: cancelled.data.status,
        },
      },
      request.headers,
    ).catch(() => null);

    return NextResponse.json({ action: "cancel", job: publicJob(cancelled.data) });
  }

  const compatibility = await executeAdminCompatibilityCommand(
    { commandType: "admin.jobs.retry", payloadRef: { jobId, reasonPresent: Boolean(parsed.data.reason) }, request, priority: 50 },
    () => retryAdminJob({ jobId, reason: parsed.data.reason }),
    { isLegacySuccess: (result) => result.ok },
  );
  const retried = compatibility.value;
  if (!retried.ok) {
    await recordAdminSiteEvent(
      {
        eventType: "admin_action",
        path: `/api/admin/jobs/${jobId}`,
        metadata: {
          action: "job_retry",
          jobId,
          result: "failed",
          error: retried.error,
        },
      },
      request.headers,
    ).catch(() => null);
    return NextResponse.json({ error: retried.error }, { status: errorStatus(retried.error, retried.unavailable) });
  }

  await appendJobEventSafe({
    jobId,
    eventType: "retried",
    message: "Admin created a retry job.",
    metadata: {
      jobId,
      newJobId: retried.data.job.id,
      reason: parsed.data.reason ?? null,
    },
  });
  await appendJobEventSafe({
    jobId: retried.data.job.id,
    eventType: "retry_created",
    message: "Retry job was created from an admin action.",
    metadata: {
      parentJobId: jobId,
      reason: parsed.data.reason ?? null,
    },
  });
  await recordAdminSiteEvent(
    {
      eventType: "admin_action",
      path: `/api/admin/jobs/${jobId}`,
      sourceKey: retried.data.parent.sourceKey,
      articleId: retried.data.parent.articleId,
      articleSlug: retried.data.parent.articleSlug,
      metadata: {
        action: "job_retry",
        jobId,
        newJobId: retried.data.job.id,
        jobType: retried.data.job.jobType,
        result: "queued",
      },
    },
    request.headers,
  ).catch(() => null);

  return NextResponse.json(
    {
      action: "retry",
      parentJob: publicJob(retried.data.parent),
      job: publicJob(retried.data.job),
    },
    { status: 202 },
  );
}
