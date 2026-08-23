import "dotenv/config";
import { getSupabaseServiceRoleAdmin } from "@/lib/db/client";
import { withCaseNumberMetadata } from "@/lib/ingest/case-number";

const BATCH_LIMIT = 500;

async function main() {
  const supabase = getSupabaseServiceRoleAdmin();
  if (!supabase) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");

  let scanned = 0;
  let updated = 0;
  let unchanged = 0;
  let missing = 0;
  const bySource: Record<string, number> = {};

  for (let offset = 0; ; offset += BATCH_LIMIT) {
    const { data, error } = await supabase
      .from("articles")
      .select("id,source_key,source_metadata,original_title,original_url")
      .order("id", { ascending: true })
      .range(offset, offset + BATCH_LIMIT - 1);
    if (error) throw new Error(`Case-number backfill query failed: ${error.message}`);
    if (!data || data.length === 0) break;

    for (const row of data) {
      scanned += 1;
      const metadata = row.source_metadata && typeof row.source_metadata === "object" && !Array.isArray(row.source_metadata)
        ? row.source_metadata as Record<string, unknown>
        : {};
      const nextMetadata = withCaseNumberMetadata({
        sourceKey: row.source_key,
        metadata,
        title: row.original_title,
        url: row.original_url,
      });
      const caseNumber = typeof nextMetadata.caseNumber === "string" ? nextMetadata.caseNumber.trim() : "";
      if (!caseNumber) {
        missing += 1;
        continue;
      }
      if (metadata.caseNumber === caseNumber) {
        unchanged += 1;
        continue;
      }

      const { error: updateError } = await supabase
        .from("articles")
        .update({ source_metadata: nextMetadata })
        .eq("id", row.id);
      if (updateError) throw new Error(`Case-number backfill update failed for ${row.id}: ${updateError.message}`);
      updated += 1;
      bySource[row.source_key] = (bySource[row.source_key] ?? 0) + 1;
    }

    if (data.length < BATCH_LIMIT) break;
  }

  console.log(JSON.stringify({ mode: "case-number-backfill", scanned, updated, unchanged, missing, bySource }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Case-number backfill failed.");
  process.exitCode = 1;
});
