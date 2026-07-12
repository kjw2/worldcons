import "dotenv/config";
import { getSupabaseServiceRoleAdmin } from "@/lib/db/client";
import { boundedInteger } from "@/lib/utils/numbers";

interface BackfillCheckpoint {
  selected_count?: number;
  mapped_count?: number;
  anomaly_count?: number;
  unchanged_count?: number;
  next_after_id?: string | null;
  batch_complete?: boolean;
}

function argument(name: string) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function firstRow(value: unknown): BackfillCheckpoint | null {
  if (Array.isArray(value)) return (value[0] ?? null) as BackfillCheckpoint | null;
  return value && typeof value === "object" ? value as BackfillCheckpoint : null;
}

async function main() {
  const supabase = getSupabaseServiceRoleAdmin();
  if (!supabase) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");

  if (process.argv.includes("--backfill")) {
    const limit = boundedInteger(argument("limit"), 500, { min: 1, max: 2_000 });
    const after = argument("after")?.trim() || null;
    const { data, error } = await supabase.rpc("article_lifecycle_backfill_batch_p2", {
      p_after_id: after,
      p_limit: limit,
    });
    if (error) throw new Error(`P2 backfill batch failed: ${error.code ?? "unknown"}`);
    const checkpoint = firstRow(data);
    if (!checkpoint) throw new Error("P2 backfill returned no aggregate checkpoint.");
    console.log(JSON.stringify({ mode: "backfill", checkpoint }));
    return;
  }

  const { data, error } = await supabase.rpc("article_lifecycle_evidence_p2");
  if (error) throw new Error(`P2 evidence query failed: ${error.code ?? "unknown"}`);
  console.log(JSON.stringify({ mode: "evidence", evidence: data }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "P2 lifecycle tooling failed.");
  process.exitCode = 1;
});
