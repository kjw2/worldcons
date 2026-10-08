import { NextResponse } from "next/server";
import { getRuntimeD1Binding } from "@/lib/cloudflare/d1/runtime-binding";
import { isIngestStage, type IngestStage } from "@/lib/cloudflare/ingest-stages/contracts";
import {
  diagnoseIngestStageJobs,
  listIngestStageDeadLetterJobs,
  listIngestStageRedriveRecords,
  redriveIngestStageDeadLetter,
} from "@/lib/cloudflare/ingest-stages/redrive";
import { parseAdminIngestStageRedriveBody } from "@/lib/security/admin-api-validation";
import {
  adminMutationAuthFailureStatus,
  adminSessionIdentityFromRequest,
  isAuthorizedRequest,
} from "@/lib/utils/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Authenticated operator dead-letter diagnosis and redrive for the staged
 * ingestion pipeline. There is intentionally NO public/unauthenticated redrive
 * route: every method here requires an admin session/secret, and the POST
 * additionally requires an admin-session CSRF token or the operator secret.
 *
 * GET  ?stage=<stage>&jobId=<optional>  -> per-stage status counts, oldest lease,
 *                                          and the bounded dead-letter list.
 * POST {stage,jobId,fencingToken?,reason,confirmation:"redrive"} -> one fenced,
 *      audited redrive. A denial is returned as data with 200 (the operator can
 *      see why); an unauthenticated or malformed request is 401/403/400.
 */
function ingestBinding() {
  return getRuntimeD1Binding("worldcons_ingest");
}

function stageFrom(value: string | null): IngestStage | null {
  return isIngestStage(value) ? value : null;
}

export function GET(request: Request) {
  if (!isAuthorizedRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const url = new URL(request.url);
  const stage = stageFrom(url.searchParams.get("stage"));
  if (!stage) {
    return NextResponse.json({ error: "A valid stage query parameter is required." }, { status: 400 });
  }
  const binding = ingestBinding();
  if (!binding) {
    return NextResponse.json({ error: "worldcons_ingest D1 binding is not available." }, { status: 503 });
  }
  const jobId = url.searchParams.get("jobId")?.trim() || null;
  return diagnose(binding, stage, jobId).then(
    (payload) => NextResponse.json(payload),
    () => NextResponse.json({ error: "Dead-letter diagnosis failed." }, { status: 502 }),
  );
}

async function diagnose(binding: NonNullable<ReturnType<typeof ingestBinding>>, stage: IngestStage, jobId: string | null) {
  const [diagnosis, jobs, ledger] = await Promise.all([
    diagnoseIngestStageJobs(binding, { stage }),
    listIngestStageDeadLetterJobs(binding, { stage }),
    jobId
      ? listIngestStageRedriveRecords(binding, { jobId })
      : listIngestStageRedriveRecords(binding, { stage }),
  ]);
  return {
    stage,
    counts: diagnosis.counts,
    deadLetterCount: diagnosis.deadLetterCount,
    oldestPendingCreatedAt: diagnosis.oldestPendingCreatedAt,
    oldestPendingJobId: diagnosis.oldestPendingJobId,
    oldestLeaseExpiresAt: diagnosis.oldestLeaseExpiresAt,
    oldestLeaseJobId: diagnosis.oldestLeaseJobId,
    deadLetter: jobs,
    redriveHistory: ledger.map((entry) => ({
      id: entry.id,
      jobId: entry.job_id,
      outcome: entry.outcome,
      operatorId: entry.operator_id,
      reason: entry.reason,
      previousStatus: entry.previous_status,
      createdAt: entry.created_at,
    })),
  };
}

export async function POST(request: Request) {
  const authFailureStatus = adminMutationAuthFailureStatus(request);
  if (authFailureStatus) {
    return NextResponse.json({ error: authFailureStatus === 401 ? "Unauthorized" : "Forbidden" }, { status: authFailureStatus });
  }
  const binding = ingestBinding();
  if (!binding) {
    return NextResponse.json({ error: "worldcons_ingest D1 binding is not available." }, { status: 503 });
  }
  const parsed = parseAdminIngestStageRedriveBody(await request.json().catch(() => ({})));
  if (!parsed.ok) {
    return NextResponse.json({ error: "Invalid redrive request", detail: parsed.error }, { status: 400 });
  }
  const operatorId =
    adminSessionIdentityFromRequest(request) ??
    request.headers.get("x-operator-id")?.trim() ??
    "operator-secret";
  try {
    const result = await redriveIngestStageDeadLetter(binding, {
      stage: parsed.data.stage,
      jobId: parsed.data.jobId,
      operatorId,
      reason: parsed.data.reason,
      expectedFencingToken: parsed.data.fencingToken,
      now: new Date().toISOString(),
    });
    return NextResponse.json({
      outcome: result.outcome,
      jobId: result.jobId,
      stage: result.stage,
      status: result.status,
      detail: result.detail,
      recordId: result.recordId,
    });
  } catch {
    return NextResponse.json({ error: "Redrive failed closed." }, { status: 502 });
  }
}
