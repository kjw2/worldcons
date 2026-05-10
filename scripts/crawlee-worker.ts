import "dotenv/config";
import { runIngest } from "@/lib/ingest/run";
import { getSourceAdapter } from "@/lib/sources";
import { createDiagnosticsCollector } from "@/lib/crawler/diagnostics";
import { applyIpv4FirstForSource } from "@/lib/crawler/dns-policy";
import { boundedInteger } from "@/lib/utils/numbers";
import type { CrawlStrategyOption } from "@/lib/crawler/types";

process.env.CRAWLEE_WORKER = "true";

function argValue(name: string) {
  return process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function boolArg(name: string) {
  return process.argv.includes(`--${name}`);
}

async function dryRun(sourceKey: string, limit: number, strategy: CrawlStrategyOption, usePlaywright: boolean | undefined) {
  const adapter = getSourceAdapter(sourceKey);
  if (!adapter) throw new Error(`Unknown source: ${sourceKey}`);
  const diagnostics = createDiagnosticsCollector(sourceKey);
  const items = (await adapter.discover({ strategy, usePlaywright, diagnostics, debug: true, dryRun: true, limit })).slice(0, limit);
  return {
    mode: "dry-run",
    sourceKey,
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

  if (boolArg("dry-run")) {
    if (!normalizedSourceKey) throw new Error("--dry-run requires --source=de-bverfg|fr-conseil-constitutionnel|fr-qpc360|us-scotus");
    console.log(JSON.stringify(await dryRun(normalizedSourceKey, limit, strategy, usePlaywright), null, 2));
    return;
  }

  const result = await runIngest({ sourceKey: normalizedSourceKey, limit, strategy, usePlaywright, debug: boolArg("debug") });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
