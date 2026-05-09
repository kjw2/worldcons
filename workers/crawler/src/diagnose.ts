import "dotenv/config";
import { applyIpv4FirstForSource } from "@/lib/crawler/dns-policy";
import { createDiagnosticsCollector } from "@/lib/crawler/diagnostics";
import { crawlUrl } from "@/lib/crawler/http-client";
import { diagnoseBverfgNetwork } from "@/lib/crawler/network-diagnostics";
import { getSourceAdapter } from "@/lib/sources";
import type { CrawlStrategyOption } from "@/lib/crawler/types";

process.env.CRAWLEE_WORKER = "true";

function argValue(name: string) {
  return process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}

async function main() {
  const sourceKey = argValue("source");
  const url = argValue("url");
  const limit = Number(argValue("limit") ?? 5);
  const strategy = (argValue("strategy") as CrawlStrategyOption | undefined) ?? "auto";
  const debug = process.argv.includes("--debug");

  if (url) {
    const response = await crawlUrl({ url });
    console.log(JSON.stringify(response, null, 2));
    return;
  }

  if (!sourceKey) throw new Error("Use --source=de-bverfg|fr-conseil-constitutionnel|fr-qpc360|us-scotus or --url=https://...");
  const normalizedSourceKey = sourceKey === "fr-qpc360" ? "fr-conseil-constitutionnel" : sourceKey;
  applyIpv4FirstForSource(normalizedSourceKey);
  if (normalizedSourceKey === "de-bverfg" && debug) {
    const report = await diagnoseBverfgNetwork({ includePlaywright: true });
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  const adapter = getSourceAdapter(normalizedSourceKey);
  if (!adapter) throw new Error(`Unknown source: ${sourceKey}`);
  const diagnostics = createDiagnosticsCollector(normalizedSourceKey);
  const items = await adapter.discover({ strategy, diagnostics, debug: true, limit, usePlaywright: true });
  console.log(
    JSON.stringify(
      {
        sourceKey,
        discoveredCount: items.length,
        items: items.slice(0, limit).map((item) => ({
          title: item.title,
          url: item.url,
          status: item.metadata?.collection?.sourceTextAvailable ? "candidate_with_text" : "metadata_only_candidate",
          strategy: item.metadata?.collection?.strategy,
          publishable: item.metadata?.collection?.publishable,
        })),
        diagnostics,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
