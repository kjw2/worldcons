import "dotenv/config";
import { runSummarizePending } from "@/lib/ingest/summary";
import {
  DEFAULT_SUMMARY_RETRY_DELAY_MS,
  summaryBatchFailureMessage,
  summaryBatchHasHardFailure,
  summaryBatchNeedsFollowUp,
  summaryBatchWasDeferred,
} from "@/lib/ingest/summary-batch";
import { boundedInteger } from "@/lib/utils/numbers";
import { runWithWorkflowHeartbeats } from "@/lib/ops/workflow-heartbeat";

function argumentValue(name: string) {
  return process.argv.find((argument) => argument.startsWith(`--${name}=`))?.split("=", 2)[1];
}

function hasFlag(name: string) {
  return process.argv.includes(`--${name}`);
}

function wait(delayMs: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

async function main() {
  const limit = argumentValue("limit");
  const sourceKey = argumentValue("source");
  const drain = hasFlag("drain");
  const strict = hasFlag("strict");
  const maxPasses = drain ? boundedInteger(argumentValue("max-passes"), 4, { min: 1, max: 10 }) : 1;
  const passDelayMs = boundedInteger(argumentValue("pass-delay-ms"), 5 * 60 * 1000, { min: 1_000, max: 15 * 60 * 1000 });
  const retryAttempts = boundedInteger(argumentValue("retry-attempts"), 0, { min: 0, max: 3 });
  const retryDelayMs = boundedInteger(argumentValue("retry-delay-ms"), DEFAULT_SUMMARY_RETRY_DELAY_MS, {
    min: 1_000,
    max: 5 * 60 * 1000,
  });

  for (let pass = 1; pass <= maxPasses; pass += 1) {
    const result = await runSummarizePending({ limit: limit ? Number(limit) : undefined, sourceKey, retryAttempts, retryDelayMs });
    console.log(JSON.stringify({ event: "summary_batch_pass", pass, maxPasses, result }, null, 2));

    const hardFailure = summaryBatchHasHardFailure(result);
    const needsFollowUp = summaryBatchNeedsFollowUp(result);
    if (hardFailure) {
      if (strict) {
        console.error(summaryBatchFailureMessage(result));
        process.exitCode = 1;
      }
      return;
    }

    if (needsFollowUp && drain && pass < maxPasses) {
      if (summaryBatchWasDeferred(result)) {
        console.log(JSON.stringify({ event: "summary_batch_retry_wait", pass, delayMs: passDelayMs }));
        await wait(passDelayMs);
      }
      continue;
    }

    if (needsFollowUp && strict) {
      console.error(summaryBatchFailureMessage(result));
      process.exitCode = 1;
    }
    return;
  }
}

runWithWorkflowHeartbeats(["summary", "embedding"], main).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
