import "dotenv/config";
import { effectiveRangeDaysForSource, runIngest } from "@/lib/ingest/run";
import { getSourceAdapter } from "@/lib/sources";
import { createDiagnosticsCollector } from "@/lib/crawler/diagnostics";
import { applyIpv4FirstForSource } from "@/lib/crawler/dns-policy";
import { boundedInteger } from "@/lib/utils/numbers";
import { parseDate } from "@/lib/utils/dates";
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

function rangeStartForDays(days: number) {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - days));
}

function isInRange(publishedAt: string | undefined, rangeDays?: number) {
  if (!rangeDays) return true;
  const parsed = parseDate(publishedAt);
  return Boolean(parsed && parsed >= rangeStartForDays(rangeDays));
}

async function dryRun(sourceKey: string, limit: number, strategy: CrawlStrategyOption, usePlaywright: boolean | undefined, rangeDays?: number) {
  const adapter = getSourceAdapter(sourceKey);
  if (!adapter) throw new Error(`Unknown source: ${sourceKey}`);
  const diagnostics = createDiagnosticsCollector(sourceKey);
  const discovered = await adapter.discover({ strategy, usePlaywright, diagnostics, debug: true, dryRun: true, limit, rangeDays });
  const items = discovered.filter((item) => isInRange(item.publishedAt, rangeDays)).slice(0, limit);
  return {
    mode: "dry-run",
    sourceKey,
    rangeDays,
    discoveredCountBeforeRange: discovered.length,
    discoveredCount: items.length,
    items: items.map((item) => ({
      title: item.title,
      url: item.url,
      publishedAt: item.publishedAt,
      strategy: item.metadata?.collection?.strategy,
      confidence: item.metadata?.collection?.confidence,
      textLength: "text" in item && typeof item.text === "string" ? item.text.length : undefined,
    })),
    diagnostics,
  };
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

  if (boolArg("dry-run")) {
    if (!normalizedSourceKey) throw new Error("--dry-run requires --source=de-bverfg|fr-conseil-constitutionnel|fr-qpc360|us-scotus");
    console.log(JSON.stringify(await dryRun(normalizedSourceKey, limit, strategy, usePlaywright, rangeDays), null, 2));
    return;
  }

  const result = await runIngest({ sourceKey: normalizedSourceKey, limit, strategy, usePlaywright, debug: boolArg("debug"), rangeDays, refreshExisting });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
