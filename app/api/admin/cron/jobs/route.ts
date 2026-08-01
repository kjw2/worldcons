import { NextResponse } from "next/server";
import { ADMIN_INGEST_JOB_TYPES } from "@/lib/admin/admin-ingest-jobs";
import { adminJobWorkerResultSucceeded, runAdminJobWorker } from "@/lib/admin/admin-job-runner";
import { executeAdminCompatibilityCommand } from "@/lib/admin/command-control-plane/compatibility";
import { getCollectionControlState } from "@/lib/masterdash/store";
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
  let jobTypes = cronJobTypes();
  const control = await getCollectionControlState();
  if (!control.available && process.env.MASTERDASH_CONTROL_SECRET?.trim()) {
    return NextResponse.json({ error: "Collection control state is unavailable; job drain was not started." }, { status: 503 });
  }
  if (control.paused) {
    jobTypes = jobTypes.filter((jobType) => jobType !== "ingest" && jobType !== "ingest-and-summarize");
    if (jobTypes.length === 0) {
      return NextResponse.json({ mode: "paused", message: "Collection jobs remain queued until collection is resumed." });
    }
  }
  const compatibility = await executeAdminCompatibilityCommand(
    { commandType: "cron.jobs.drain", payloadRef: { maxJobs, leaseSeconds, jobTypes }, request, requestedBy: "cron" },
    () => runAdminJobWorker({ workerId: `admin-job-cron:${Date.now()}`, maxJobs, leaseSeconds, jobTypes }),
    { isLegacySuccess: adminJobWorkerResultSucceeded },
  );
  const result = compatibility.value;

  if (result.mode === "unavailable") {
    return NextResponse.json(result, { status: 503 });
  }

  return NextResponse.json(result, { status: result.error ? 500 : 200 });
}
