import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

type TransactionMode = "transactional" | "outside_transaction";

interface ManifestEntry {
  phase: "P0" | "P1" | "P2" | "P3" | "P5";
  file: string;
  transactionMode: TransactionMode;
  scope: "new_objects" | "legacy_table_metadata" | "new_table_indexes" | "existing_table_indexes" | "reconciliation" | "forward_fix";
}

export const ADMIN_REDESIGN_MIGRATION_MANIFEST: readonly ManifestEntry[] = [
  { phase: "P0", file: "20260712090000_admin_command_control_plane.sql", transactionMode: "transactional", scope: "new_objects" },
  { phase: "P1", file: "20260712130000_admin_command_worker_p1.sql", transactionMode: "transactional", scope: "new_objects" },
  { phase: "P2", file: "20260712170000_article_lifecycle_p2.sql", transactionMode: "transactional", scope: "legacy_table_metadata" },
  { phase: "P2", file: "20260712171000_article_lifecycle_p2_indexes.sql", transactionMode: "outside_transaction", scope: "existing_table_indexes" },
  { phase: "P2", file: "20260712172000_article_lifecycle_p2_evidence_reconciliation.sql", transactionMode: "transactional", scope: "reconciliation" },
  { phase: "P3", file: "20260712200000_article_publication_p3.sql", transactionMode: "transactional", scope: "new_objects" },
  { phase: "P3", file: "20260712201000_article_publication_p3_indexes.sql", transactionMode: "transactional", scope: "new_table_indexes" },
  { phase: "P3", file: "20260712202000_article_publication_p3_reconciliation.sql", transactionMode: "transactional", scope: "reconciliation" },
  { phase: "P3", file: "20260712203000_article_publication_p3_authority_correction.sql", transactionMode: "transactional", scope: "forward_fix" },
  { phase: "P5", file: "20260712230000_admin_governance_p5.sql", transactionMode: "transactional", scope: "new_objects" },
  { phase: "P5", file: "20260712231000_admin_governance_p5_indexes.sql", transactionMode: "outside_transaction", scope: "existing_table_indexes" },
  { phase: "P5", file: "20260712233000_admin_governance_p5_acceptance_corrections.sql", transactionMode: "transactional", scope: "forward_fix" },
  { phase: "P3", file: "20260713090000_article_publication_p3_review_eligibility.sql", transactionMode: "transactional", scope: "forward_fix" },
  { phase: "P5", file: "20260713093000_admin_governance_p5_quarantine_resolution.sql", transactionMode: "transactional", scope: "forward_fix" },
] as const;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function statements(sql: string) {
  return sql
    .replace(/^\s*--.*$/gm, "")
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

function run() {
  const migrationRoot = path.join(process.cwd(), "supabase", "migrations");
  const timestamps = ADMIN_REDESIGN_MIGRATION_MANIFEST.map(({ file }) => file.slice(0, 14));
  assert(new Set(timestamps).size === timestamps.length, "migration timestamps must be unique");
  assert([...timestamps].sort().join("\n") === timestamps.join("\n"), "migration manifest must be timestamp ordered");

  let securityDefinerCount = 0;
  let concurrentIndexCount = 0;
  const hashes: string[] = [];
  for (const entry of ADMIN_REDESIGN_MIGRATION_MANIFEST) {
    const filePath = path.join(migrationRoot, entry.file);
    assert(fs.existsSync(filePath), `missing migration: ${entry.file}`);
    const sql = fs.readFileSync(filePath, "utf8");
    const normalized = sql.toLowerCase();
    const withoutQualifiedDigest = normalized.replaceAll("extensions.digest", "");
    hashes.push(crypto.createHash("sha256").update(sql).digest("hex"));
    assert(!/\b(drop\s+table|drop\s+column|truncate)\b/i.test(sql), `${entry.file} contains destructive schema/data SQL`);
    assert(!/\bdigest\s*\(/i.test(withoutQualifiedDigest), `${entry.file} must schema-qualify pgcrypto digest calls`);

    const definers = normalized.match(/security\s+definer/g)?.length ?? 0;
    const fixedSearchPaths = normalized.match(/set\s+search_path\s*=\s*public,\s*pg_temp/g)?.length ?? 0;
    assert(fixedSearchPaths >= definers, `${entry.file} has SECURITY DEFINER without fixed search_path`);
    securityDefinerCount += definers;

    if (entry.transactionMode === "outside_transaction") {
      assert(!/\b(begin|commit|rollback)\b/i.test(sql), `${entry.file} must not contain transaction control`);
      const indexStatements = statements(sql);
      assert(indexStatements.length > 0, `${entry.file} must contain index statements`);
      for (const statement of indexStatements) {
        assert(/^create\s+index\s+concurrently\s+if\s+not\s+exists\b/i.test(statement), `${entry.file} must contain only rerunnable concurrent indexes`);
      }
      concurrentIndexCount += indexStatements.length;
    }
  }

  const p2 = fs.readFileSync(path.join(migrationRoot, "20260712170000_article_lifecycle_p2.sql"), "utf8");
  assert((p2.match(/not\s+valid/gi)?.length ?? 0) >= 3, "P2 checks must be added NOT VALID before validation scans");
  assert((p2.match(/validate\s+constraint/gi)?.length ?? 0) >= 3, "P2 checks must have an explicit validation strategy");

  const p3Indexes = fs.readFileSync(path.join(migrationRoot, "20260712201000_article_publication_p3_indexes.sql"), "utf8");
  assert(!/\bon\s+(articles|sources|ingestion_runs|admin_jobs)\b/i.test(p3Indexes), "P3 transactional indexes must remain limited to new P3 tables");
  assert(/extensions\.vector_cosine_ops/i.test(p3Indexes), "P3 vector index must schema-qualify the extension opclass");

  const p3 = fs.readFileSync(path.join(migrationRoot, "20260712200000_article_publication_p3.sql"), "utf8");
  assert(/extensions\.vector\s*\(1536\)/i.test(p3), "P3 vector types must be schema-qualified");
  assert(/operator\s*\(extensions\.<=>\)/i.test(p3), "P3 vector distance operators must be schema-qualified");

  const p5 = fs.readFileSync(path.join(migrationRoot, "20260712230000_admin_governance_p5.sql"), "utf8");
  assert(!/create\s+index/i.test(p5), "P5 base migration must not build indexes while holding its transaction");

  const manifestDigest = crypto.createHash("sha256").update(hashes.join(":"), "utf8").digest("hex");
  console.log(JSON.stringify({
    status: "pass",
    migrations: ADMIN_REDESIGN_MIGRATION_MANIFEST.length,
    phases: [...new Set(ADMIN_REDESIGN_MIGRATION_MANIFEST.map(({ phase }) => phase))],
    outsideTransactionFiles: ADMIN_REDESIGN_MIGRATION_MANIFEST.filter(({ transactionMode }) => transactionMode === "outside_transaction").length,
    concurrentIndexes: concurrentIndexCount,
    securityDefinerFunctions: securityDefinerCount,
    manifestDigest,
  }));
}

run();
