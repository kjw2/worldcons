import "dotenv/config";
import { applyIpv4FirstForSource } from "@/lib/crawler/dns-policy";
import { runIngest } from "@/lib/ingest/run";
import type { CrawlStrategyOption } from "@/lib/crawler/types";

process.env.CRAWLEE_WORKER = "true";

function argValue(name: string) {
  return process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function boolArg(name: string) {
  return process.argv.includes(`--${name}`);
}

async function main() {
  const sourceKey = argValue("source");
  const normalizedSourceKey = sourceKey === "fr-qpc360" ? "fr-conseil-constitutionnel" : sourceKey;
  applyIpv4FirstForSource(normalizedSourceKey);
  const limit = Number(argValue("limit") ?? process.env.INGEST_LIMIT_PER_SOURCE ?? 20);
  const strategy = (argValue("strategy") as CrawlStrategyOption | undefined) ?? "auto";
  const usePlaywright = boolArg("use-playwright") ? true : boolArg("no-playwright") ? false : undefined;
  const result = await runIngest({ sourceKey: normalizedSourceKey, limit, strategy, usePlaywright, debug: boolArg("debug") });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
