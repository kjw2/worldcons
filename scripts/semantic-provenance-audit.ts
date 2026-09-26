import process from "node:process";
import {
  createSupabaseLinkedQueryRunner,
  parseSupabaseLinkedRows,
} from "@/lib/cloudflare/d1/convert/supabase-linked-source";
import {
  SEMANTIC_PROVENANCE_AUDIT_SQL,
  parseSemanticProvenanceAuditRow,
} from "@/lib/cloudflare/search-vector";

/**
 * M7.7-A read-only semantic provenance audit operator CLI.
 *
 *   pnpm audit:semantic-provenance --dry-run
 *   pnpm audit:semantic-provenance --json
 *
 * It runs ONE authored read-only `supabase db query --linked` statement and
 * prints counts only: current published P3 rows, artifact-backed rows,
 * projection embedding NULLs, legacy-v.embedding-only rows, and
 * provider/model/dimensions/content_hash/version mismatches. It never selects or
 * prints a vector value, article text, summary, URL or id, never writes a
 * Supabase row and has no `--apply`. Supabase remains the sole production
 * authority; this audit does not change `SearchRepository`, traffic or DNS.
 */
function main(): void {
  const args = process.argv.slice(2);
  if (args.includes("--apply")) {
    throw new Error("--apply is not available: the semantic provenance audit is read-only by construction");
  }
  if (args.includes("--dry-run")) {
    process.stdout.write(`${SEMANTIC_PROVENANCE_AUDIT_SQL}\n`);
    process.stdout.write("dry-run: no Supabase query executed\n");
    return;
  }

  const query = createSupabaseLinkedQueryRunner();
  query(SEMANTIC_PROVENANCE_AUDIT_SQL)
    .then((stdout) => {
      const rows = parseSupabaseLinkedRows(stdout);
      if (rows.length !== 1) {
        throw new Error(`semantic provenance audit expected exactly one count row, received ${rows.length}`);
      }
      const report = parseSemanticProvenanceAuditRow(rows[0]);
      if (args.includes("--json")) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        return;
      }
      process.stdout.write("WorldCons semantic provenance audit (read-only, counts only)\n");
      for (const [column, count] of Object.entries(report.counts)) {
        process.stdout.write(`  ${column}: ${count}\n`);
      }
      process.stdout.write(`  total_mismatch_count: ${report.totalMismatchCount}\n`);
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `semantic-provenance-audit failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `semantic-provenance-audit failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
