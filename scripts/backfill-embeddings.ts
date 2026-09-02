import "dotenv/config";
import { countMissingEmbeddings, getEmbeddingReadiness, runEmbeddingBacklog } from "@/lib/ingest/embedding-backlog";
import { boundedInteger } from "@/lib/utils/numbers";
import { runWithWorkflowHeartbeats } from "@/lib/ops/workflow-heartbeat";

function argumentValue(name: string) {
  return process.argv.find((argument) => argument.startsWith(`--${name}=`))?.split("=", 2)[1];
}

function hasFlag(name: string) {
  return process.argv.includes(`--${name}`);
}

async function main() {
  const sourceKey = argumentValue("source");
  const limit = boundedInteger(argumentValue("limit"), 50, { min: 1, max: 500 });
  const delayMs = boundedInteger(argumentValue("delay-ms"), 0, { min: 0, max: 60_000 });
  const drain = hasFlag("drain");
  const maxPasses = drain ? boundedInteger(argumentValue("max-passes"), 20, { min: 1, max: 100 }) : 1;
  // The router enforces a per-minute window, so a deferral usually just needs to wait
  // for that window to roll over rather than abandoning the run.
  const passDelayMs = boundedInteger(argumentValue("pass-delay-ms"), 65_000, { min: 1_000, max: 10 * 60_000 });

  const before = await countMissingEmbeddings(sourceKey);
  const readinessBefore = sourceKey ? null : await getEmbeddingReadiness();
  console.log(JSON.stringify({ event: "embedding_backlog_start", sourceKey: sourceKey ?? null, missingBefore: before, readinessBefore, limit, maxPasses }));

  let totalEmbedded = 0;
  for (let pass = 1; pass <= maxPasses; pass += 1) {
    const result = await runEmbeddingBacklog({ limit, sourceKey, delayMs });
    totalEmbedded += result.embedded;
    console.log(JSON.stringify({ event: "embedding_backlog_pass", pass, ...result }));

    if (result.status === "unavailable") {
      process.exitCode = 1;
      return;
    }

    if (result.scanned === 0) break;
    if (!drain) break;

    // Wait out the provider window instead of hammering it, then continue draining.
    if (result.status === "deferred") {
      if (pass >= maxPasses) break;
      console.log(JSON.stringify({ event: "embedding_backlog_wait", pass, delayMs: passDelayMs }));
      await new Promise((resolve) => setTimeout(resolve, passDelayMs));
    }
  }

  const after = await countMissingEmbeddings(sourceKey);
  const readinessAfter = sourceKey ? null : await getEmbeddingReadiness();
  console.log(JSON.stringify({ event: "embedding_backlog_done", embedded: totalEmbedded, missingAfter: after, readinessAfter }));
}

runWithWorkflowHeartbeats(["embedding"], main).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
