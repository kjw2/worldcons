import "dotenv/config";
import { getSupabaseServiceRoleAdmin } from "@/lib/db/client";
import { createExistingPublicCacheHandler, processArticleCacheOutboxBatch } from "@/lib/article-publication";
import { boundedInteger } from "@/lib/utils/numbers";
import { runRefreshTagCounts } from "@/lib/ingest/summary";

function argument(name: string) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function firstRow(value: unknown) {
  if (Array.isArray(value)) return value[0] ?? null;
  return value && typeof value === "object" ? value : null;
}

async function main() {
  const supabase = getSupabaseServiceRoleAdmin();
  if (!supabase) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");

  if (process.argv.includes("--backfill")) {
    const limit = boundedInteger(argument("limit"), 500, { min: 1, max: 2_000 });
    const after = argument("after")?.trim() || null;
    const { data, error } = await supabase.rpc("article_publication_backfill_batch_p3", { p_after_id: after, p_limit: limit });
    if (error) throw new Error(`P3 backfill batch failed: ${error.code ?? "unknown"}`);
    console.log(JSON.stringify({ mode: "backfill", checkpoint: firstRow(data) }));
    return;
  }

  if (process.argv.includes("--outbox")) {
    const workerId = argument("worker")?.trim() || `p3-cli-${process.pid}`;
    const cacheHandler = createExistingPublicCacheHandler();
    const result = await processArticleCacheOutboxBatch({
      workerId,
      limit: boundedInteger(argument("limit"), 20, { min: 1, max: 100 }),
      leaseSeconds: boundedInteger(argument("lease-seconds"), 120, { min: 15, max: 900 }),
      handler: {
        async invalidate(events) {
          await runRefreshTagCounts();
          await cacheHandler.invalidate(events);
        },
      },
    });
    console.log(JSON.stringify({ mode: "outbox", ...result }));
    return;
  }

  const { data, error } = await supabase.rpc("article_publication_evidence_p3");
  if (error) throw new Error(`P3 evidence query failed: ${error.code ?? "unknown"}`);
  console.log(JSON.stringify({ mode: "evidence", evidence: data }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "P3 publication tooling failed.");
  process.exitCode = 1;
});
