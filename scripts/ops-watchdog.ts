import "dotenv/config";
import {
  evaluateWatchdog,
  recordAdminOpsEvent,
  recordWatchdogEvents,
} from "@/lib/ops/watchdog";
import { runWithWorkflowHeartbeats } from "@/lib/ops/workflow-heartbeat";

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const compensate = process.argv.includes("--compensate");
  if (compensate) {
    throw new Error("ops-watchdog compensation is Cloudflare-native; use the deployed worldcons-ingest Workflow instead of the local CLI");
  }

  const now = new Date();
  const evaluation = await evaluateWatchdog(now);
  if (!dryRun) await recordWatchdogEvents(evaluation, now);

  console.log(
    JSON.stringify({
      ok: evaluation.ok,
      generatedAt: evaluation.generatedAt,
      paused: evaluation.paused,
      violationCount: evaluation.violations.length,
      violationKeys: evaluation.violations.map((violation) => violation.key),
      executionAuthority: "cloudflare",
      mode: dryRun ? "diagnostic" : "record-events",
    }),
  );
}

runWithWorkflowHeartbeats(["watchdog"], main)
  .catch(async (error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`watchdog failed: ${message}`);
    await recordAdminOpsEvent({
      eventType: "watchdog_error",
      severity: "critical",
      summary: `워치독 진단 실행 실패: ${message}`,
    }).catch(() => undefined);
    process.exitCode = 1;
  });
