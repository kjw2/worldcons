import "dotenv/config";
import { effectiveRangeDaysForSource, isDiscoveredItemInCollectionRange, runIngest } from "@/lib/ingest/run";
import { getSourceAdapter } from "@/lib/sources";
import { createDiagnosticsCollector } from "@/lib/crawler/diagnostics";
import { applyIpv4FirstForSource } from "@/lib/crawler/dns-policy";
import { boundedInteger } from "@/lib/utils/numbers";
import { parseDate } from "@/lib/utils/dates";
import type { CrawlStrategyOption } from "@/lib/crawler/types";
import { SPAIN_TC_BACKFILL_START_DECISION_DATE, SPAIN_TC_SOURCE_KEY } from "@/lib/crawlee";
import { ingestSourceOutcomeLine } from "@/lib/ingest/incremental";
import { ingestProcessExitCode, ingestResultFailureMessage } from "@/lib/ingest/results";
import { runWithWorkflowHeartbeats } from "@/lib/ops/workflow-heartbeat";

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
  const revisionRangeDays = sourceKey === "us-scotus"
    ? optionalPositiveInteger(process.env.SCOTUS_REVISION_RECHECK_DAYS) ?? 90
    : undefined;
  const revisionRangeStart = revisionRangeDays ? rangeStartForDays(revisionRangeDays) : undefined;
  const primaryItems = discovered.filter((item) => isInRange(item.publishedAt, rangeDays)).slice(0, limit);
  const revisionItems = sourceKey === "us-scotus" && revisionRangeStart
    ? discovered
      .filter((item) => !isInRange(item.publishedAt, rangeDays) && isDiscoveredItemInCollectionRange(item, undefined, revisionRangeStart))
      .slice(0, optionalPositiveInteger(process.env.SCOTUS_REVISION_RECHECK_LIMIT) ?? 100)
    : [];
  const items = [...new Map([...primaryItems, ...revisionItems].map((item) => [item.canonicalUrl, item])).values()];
  return {
    mode: "dry-run",
    sourceKey,
    rangeDays,
    revisionRangeDays,
    spainDateBasis: sourceKey === SPAIN_TC_SOURCE_KEY
      ? {
          dateBasis: "HJ FECHA_REGISTRO",
          datePrecision: "date",
          boeDateUsedForFiltering: false,
          backfillStartDecisionDate: SPAIN_TC_BACKFILL_START_DECISION_DATE,
          note: "publishedAt/original_published_at use HJ decision date; BOE dates are stored only as supplementary metadata.",
        }
      : undefined,
    discoveredCountBeforeRange: discovered.length,
    discoveredCount: items.length,
    items: items.map((item) => ({
      title: item.title,
      url: item.url,
      publishedAt: item.publishedAt,
      strategy: item.metadata?.collection?.strategy,
      confidence: item.metadata?.collection?.confidence,
      decisionDate: typeof item.metadata?.decisionDate === "string" ? item.metadata.decisionDate : undefined,
      boePublishedAt: typeof item.metadata?.boePublishedAt === "string" ? item.metadata.boePublishedAt : undefined,
      revisionDate: typeof item.metadata?.revisionDate === "string" ? item.metadata.revisionDate : undefined,
      publishable: item.metadata?.collection?.publishable,
      sourceTextAvailable: item.metadata?.collection?.sourceTextAvailable,
      reviewReason:
        item.metadata?.review && typeof item.metadata.review === "object" && "reason" in item.metadata.review
          ? String(item.metadata.review.reason)
          : undefined,
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
    if (!normalizedSourceKey) throw new Error("--dry-run requires --source=de-bverfg|es-tribunal-constitucional|fr-conseil-constitutionnel|fr-qpc360|us-scotus");
    console.log(JSON.stringify(await dryRun(normalizedSourceKey, limit, strategy, usePlaywright, rangeDays), null, 2));
    return;
  }

  const result = await runIngest({ sourceKey: normalizedSourceKey, limit, strategy, usePlaywright, debug: boolArg("debug"), rangeDays, refreshExisting });
  const compact = {
    mode: result.mode,
    results: (result.results ?? []).map((sourceResult) => ingestSourceOutcomeLine(sourceResult)),
  };
  console.log(JSON.stringify(compact));
  if (boolArg("debug")) console.log(JSON.stringify(result, null, 2));
  const exitCode = ingestProcessExitCode(result);
  if (exitCode !== 0) {
    console.error(ingestResultFailureMessage(result));
    process.exitCode = exitCode;
  }
}

const operation = boolArg("dry-run") ? main() : runWithWorkflowHeartbeats(["collection"], main);
operation.catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
