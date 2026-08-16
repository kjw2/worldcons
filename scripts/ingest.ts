import "dotenv/config";
import { applyIpv4FirstForSource } from "@/lib/crawler/dns-policy";
import { ingestSourceOutcomeLine } from "@/lib/ingest/incremental";
import { ingestProcessExitCode, ingestResultFailureMessage } from "@/lib/ingest/results";
import { effectiveRangeDaysForSource, runIngest } from "@/lib/ingest/run";
import { boundedInteger } from "@/lib/utils/numbers";
import type { CrawlStrategyOption } from "@/lib/crawler/types";

async function main() {
  const sourceKey = process.argv.find((arg) => arg.startsWith("--source="))?.split("=")[1];
  applyIpv4FirstForSource(sourceKey);
  const limitArg = process.argv.find((arg) => arg.startsWith("--limit="))?.split("=")[1];
  const strategyArg = process.argv.find((arg) => arg.startsWith("--strategy="))?.split("=")[1] as CrawlStrategyOption | undefined;
  const limit = boundedInteger(limitArg ?? process.env.INGEST_LIMIT_PER_SOURCE, 20, { min: 1, max: 100 });
  const debug = process.argv.includes("--debug");
  const usePlaywright = process.argv.includes("--use-playwright") ? true : process.argv.includes("--no-playwright") ? false : undefined;
  const rangeArg = process.argv.find((arg) => arg.startsWith("--range-days="))?.split("=")[1];
  const parsedRange = Number(rangeArg ?? process.env.INGEST_RANGE_DAYS);
  const configuredRangeDays = Number.isFinite(parsedRange) && parsedRange > 0 ? Math.floor(parsedRange) : undefined;
  const rangeDays = effectiveRangeDaysForSource(sourceKey, configuredRangeDays);
  const refreshExisting = process.argv.includes("--refresh-existing")
    ? true
    : process.argv.includes("--no-refresh-existing")
      ? false
      : undefined;

  const result = await runIngest({
    sourceKey,
    limit,
    debug,
    usePlaywright,
    strategy: strategyArg ?? "auto",
    rangeDays,
    refreshExisting,
  });
  if (debug) {
    for (const sourceResult of result.results ?? []) {
      console.log(`\n[${sourceResult.sourceKey}]`);
      for (const attempt of sourceResult.diagnostics?.attempts ?? []) {
        console.log(
          [
            `strategy=${attempt.strategy}`,
            attempt.url ? `url=${attempt.url}` : null,
            attempt.status !== undefined ? `status=${attempt.status}` : null,
            attempt.finalUrl ? `final=${attempt.finalUrl}` : null,
            attempt.selectorMatchCount !== undefined ? `selectorMatches=${attempt.selectorMatchCount}` : null,
            attempt.discoveredCount !== undefined ? `discovered=${attempt.discoveredCount}` : null,
            attempt.fallback ? "fallback=true" : null,
            attempt.errorCode ? `errorCode=${attempt.errorCode}` : null,
            attempt.errorMessage ? `error=${attempt.errorMessage}` : null,
          ]
            .filter(Boolean)
            .join(" | "),
        );
      }
    }
  }
  const compact = {
    mode: result.mode,
    results: (result.results ?? []).map((sourceResult) => ingestSourceOutcomeLine(sourceResult)),
  };
  console.log(JSON.stringify(compact));
  if (debug) console.log(JSON.stringify(result, null, 2));
  const exitCode = ingestProcessExitCode(result);
  if (exitCode !== 0) {
    console.error(ingestResultFailureMessage(result));
    process.exit(exitCode);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
