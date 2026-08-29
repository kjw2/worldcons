import { NextResponse } from "next/server";
import { isAuthorizedSecretRequest } from "@/lib/utils/auth";
import { evaluateWatchdog, recordWatchdogEvents } from "@/lib/ops/watchdog";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: Request) {
  if (!isAuthorizedSecretRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const evaluation = await evaluateWatchdog();
  await recordWatchdogEvents(evaluation);

  return NextResponse.json({
    ok: evaluation.ok,
    generatedAt: evaluation.generatedAt,
    paused: evaluation.paused,
    violationCount: evaluation.violations.length,
    violations: evaluation.violations,
    sources: evaluation.sources,
    lastCompletedRunAt: evaluation.lastCompletedRunAt,
    pendingCandidateCount: evaluation.pendingCandidateCount,
  });
}
