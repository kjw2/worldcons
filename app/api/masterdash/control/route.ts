import { NextResponse } from "next/server";
import { recordAdminSiteEvent } from "@/lib/analytics/events";
import { createAdminJob } from "@/lib/db/admin-jobs";
import { INCREMENTAL_SOURCE_KEYS, incrementalJobOptionsForSource } from "@/lib/ingest/incremental";
import {
  MasterdashSecurityError,
  verifyMasterdashControlRequest,
  type MasterdashControlRequest,
} from "@/lib/masterdash/security";
import {
  CollectionPausedError,
  assertCollectionCanStart,
  claimControlRequest,
  completeControlRequest,
  setCollectionPaused,
} from "@/lib/masterdash/store";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function json(body: Record<string, unknown>, status: number) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

async function queueIncrementalCollection(body: MasterdashControlRequest) {
  await assertCollectionCanStart();
  const queuedIds: string[] = [];
  const reusedIds: string[] = [];
  for (const sourceKey of INCREMENTAL_SOURCE_KEYS) {
    const queued = await createAdminJob({
      jobType: "ingest",
      requestedBy: `masterdash:${body.requestedBy.userId}`,
      idempotencyKey: `masterdash-control:${body.requestId}:${sourceKey}`,
      options: incrementalJobOptionsForSource(sourceKey),
    });
    if (!queued.ok) throw new Error(queued.error);
    if (queued.data.created) queuedIds.push(queued.data.job.id);
    else reusedIds.push(queued.data.job.id);
  }
  return `Incremental collection jobs ${[...queuedIds, ...reusedIds].join(", ")} ${reusedIds.length === INCREMENTAL_SOURCE_KEYS.length ? "were already queued" : "were queued"} for ${INCREMENTAL_SOURCE_KEYS.join(", ")}.`;
}

async function executeControl(body: MasterdashControlRequest) {
  if (body.action === "incremental_collect") {
    return { status: 202, message: await queueIncrementalCollection(body) };
  }
  if (body.action === "pause_collection") {
    await setCollectionPaused(true, body.requestId);
    return {
      status: 200,
      message: "New scheduled and manual collection starts are paused. Already-running work was not interrupted.",
    };
  }
  await setCollectionPaused(false, body.requestId);
  return { status: 200, message: "New scheduled and manual collection starts are enabled." };
}

export async function POST(request: Request) {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > 64 * 1024) return json({ error: "Request body is too large." }, 413);
  const rawBody = await request.text();
  let verified: ReturnType<typeof verifyMasterdashControlRequest>;
  try {
    verified = verifyMasterdashControlRequest({
      rawBody,
      signature: request.headers.get("x-masterdash-signature"),
      timestamp: request.headers.get("x-masterdash-timestamp"),
      requestId: request.headers.get("x-masterdash-request-id"),
    });
  } catch (error) {
    const status = error instanceof MasterdashSecurityError ? error.status : 401;
    return json({ error: error instanceof MasterdashSecurityError ? error.message : "Invalid MasterDash control request." }, status);
  }

  const { body, bodyHash } = verified;
  let claimed = false;
  try {
    const claim = await claimControlRequest({
      requestId: body.requestId,
      action: body.action,
      requestedAt: body.requestedAt,
      bodyHash,
    });
    if (claim.kind === "duplicate") {
      if (claim.status === "succeeded" || claim.status === "failed") {
        return json({ message: claim.message ?? "MasterDash control request was already completed.", duplicate: true }, claim.httpStatus ?? 200);
      }
      return json({ message: "Request was already accepted and remains in processing state; no duplicate action was started.", duplicate: true }, 202);
    }
    claimed = true;

    const result = await executeControl(body);
    try {
      await completeControlRequest(body.requestId, "succeeded", result.status, result.message);
    } catch {
      return json(
        { error: "The action was applied, but its durable outcome could not be recorded; no duplicate action should be started." },
        503,
      );
    }
    await recordAdminSiteEvent(
      {
        eventType: "admin_action",
        path: "/api/masterdash/control",
        metadata: {
          action: `masterdash.${body.action}`,
          result: "accepted",
          actorId: body.requestedBy.userId,
          actorRole: body.requestedBy.role,
          targetType: "collection_control",
          targetId: "worldcons",
          requestId: body.requestId,
        },
      },
      request.headers,
    ).catch(() => null);
    return json({ message: result.message }, result.status);
  } catch (error) {
    const isPaused = error instanceof CollectionPausedError;
    const isConflict = error instanceof Error && error.message.startsWith("requestId was already used");
    const status = isPaused ? error.status : isConflict ? 409 : 503;
    const message = isPaused || isConflict ? error.message : "MasterDash control action could not be completed.";
    if (claimed) await completeControlRequest(body.requestId, "failed", status, message).catch(() => undefined);
    return json({ error: message }, status);
  }
}
