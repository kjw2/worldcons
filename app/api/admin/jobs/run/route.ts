import { NextResponse } from "next/server";
import { adminJobWorkerResultSucceeded, runAdminJobWorker } from "@/lib/admin/admin-job-runner";
import { executeAdminCompatibilityCommand } from "@/lib/admin/command-control-plane/compatibility";
import { parseAdminJobRunBody } from "@/lib/security/admin-api-validation";
import { adminMutationAuthFailureStatus } from "@/lib/utils/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 60;

export function GET() {
  return new Response(null, { status: 405, headers: { allow: "POST" } });
}

export async function POST(request: Request) {
  const authFailureStatus = adminMutationAuthFailureStatus(request);
  if (authFailureStatus) {
    return NextResponse.json({ error: authFailureStatus === 401 ? "Unauthorized" : "Forbidden" }, { status: authFailureStatus });
  }

  const body = await request.json().catch(() => ({}));
  const parsed = parseAdminJobRunBody(body);
  if (!parsed.ok) {
    return NextResponse.json({ error: "Invalid admin job worker request", detail: parsed.error }, { status: 400 });
  }

  const compatibility = await executeAdminCompatibilityCommand(
    { commandType: "admin.jobs.drain", payloadRef: parsed.data, request },
    () => runAdminJobWorker({
      workerId: `admin-worker:${Date.now()}`,
      maxJobs: parsed.data.maxJobs,
      leaseSeconds: parsed.data.leaseSeconds,
      jobTypes: parsed.data.jobTypes,
    }),
    { isLegacySuccess: adminJobWorkerResultSucceeded },
  );
  const result = compatibility.value;

  if (result.mode === "unavailable") {
    return NextResponse.json(result, { status: 503 });
  }

  return NextResponse.json(result, { status: result.error ? 500 : 200 });
}
