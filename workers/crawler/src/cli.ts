import "dotenv/config";
import { applyIpv4FirstForSource } from "@/lib/crawler/dns-policy";
import { ingestResultFailureMessage, ingestResultSucceeded } from "@/lib/ingest/results";
import { effectiveRangeDaysForSource, runIngest } from "@/lib/ingest/run";
import { boundedInteger } from "@/lib/utils/numbers";
import type { CrawlStrategyOption } from "@/lib/crawler/types";

process.env.CRAWLEE_WORKER = "true";

function argValue(name: string) {
  return process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function boolArg(name: string) {
  return process.argv.includes(`--${name}`);
}

function optionalPositiveInteger(value?: string) {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

async function main() {
  const sourceKey = argValue("source");
  const normalizedSourceKey = sourceKey === "fr-qpc360" ? "fr-conseil-constitutionnel" : sourceKey;
  applyIpv4FirstForSource(normalizedSourceKey);
  const limit = boundedInteger(argValue("limit") ?? process.env.INGEST_LIMIT_PER_SOURCE, 20, { min: 1, max: 100 });
  const strategy = (argValue("strategy") as CrawlStrategyOption | undefined) ?? "auto";
  const usePlaywright = boolArg("use-playwright") ? true : boolArg("no-playwright") ? false : undefined;
  const configuredRangeDays = optionalPositiveInteger(argValue("range-days") ?? process.env.INGEST_RANGE_DAYS);
  const rangeDays = effectiveRangeDaysForSource(normalizedSourceKey, configuredRangeDays);
  const refreshExisting = boolArg("refresh-existing") ? true : boolArg("no-refresh-existing") ? false : undefined;
  const result = await runIngest({
    sourceKey: normalizedSourceKey,
    limit,
    strategy,
    usePlaywright,
    debug: boolArg("debug"),
    rangeDays,
    refreshExisting,
  });
  console.log(JSON.stringify(result, null, 2));
  if (!ingestResultSucceeded(result)) throw new Error(ingestResultFailureMessage(result));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
