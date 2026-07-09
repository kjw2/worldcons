import { NextResponse } from "next/server";
import { ADMIN_INGEST_JOB_TYPES } from "@/lib/admin/admin-ingest-jobs";
import { runAdminJobWorker } from "@/lib/admin/admin-job-runner";
import { isAuthorizedSecretRequest } from "@/lib/utils/auth";
import { boundedInteger } from "@/lib/utils/numbers";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 60;

function cronJobTypes() {
  const configured = process.env.ADMIN_JOB_CRON_TYPES?.split(",")
    .map((jobType) => jobType.trim())
    .filter(Boolean);

  return configured?.length ? configured : ADMIN_INGEST_JOB_TYPES;
}

export async function GET(request: Request) {
  if (!isAuthorizedSecretRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const maxJobs = boundedInteger(process.env.ADMIN_JOB_CRON_MAX_JOBS, 2, { min: 1, max: 10 });
  const leaseSeconds = boundedInteger(process.env.ADMIN_JOB_CRON_LEASE_SECONDS, 120, { min: 10, max: 600 });
  const result = await runAdminJobWorker({
    workerId: `admin-job-cron:${Date.now()}`,
    maxJobs,
    leaseSeconds,
    jobTypes: cronJobTypes(),
  });

  if (result.mode === "unavailable") {
    return NextResponse.json(result, { status: 503 });
  }

  return NextResponse.json(result, { status: result.error ? 500 : 200 });
}
