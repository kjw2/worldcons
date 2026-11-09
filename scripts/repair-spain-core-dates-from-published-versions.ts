/**
 * Reconcile a missing Core article date with its already-dated published P3 version.
 * The version's date must independently match the official HJ detail heading.
 * No version/publication row is changed. Dry-run unless --apply is specified.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchSpainOfficialDateEvidence, extractSpainHjId } from "@/lib/ingest/spain-decision-date-recovery";
import { normalizeSpainDateOnly } from "@/lib/ingest/spain-decision-date";

const ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const CLI = resolve(ROOT, "node_modules/wrangler/bin/wrangler.js");
const CONFIG = resolve(ROOT, "workers/async-pipeline/wrangler.jsonc");
const OUT = resolve(ROOT, "artifacts/spain-date-correction");

interface DateRow {
  id: string;
  original_title: string;
  canonical_url: string;
  updated_at: string;
  version_id: string;
  version_date: string;
}

function quote(v: string) { return "'" + v.replace(/'/g, "''") + "'"; }

function remoteSql(sql: string) {
  const p = spawnSync(process.execPath,
    [CLI, "d1", "execute", "worldcons_core", "--remote", "--yes", "--json", "--config", CONFIG, "--command", sql],
    { cwd: ROOT, encoding: "utf8", timeout: 120_000, maxBuffer: 24 * 1024 * 1024 });
  if (p.error || p.status !== 0) throw new Error("remote D1 failed (exit " + p.status + "): " + (p.error?.message ?? (p.stderr ?? "").slice(0, 700)) + " STDOUT: " + (p.stdout ?? "").slice(0, 800));
  const parsed = JSON.parse(p.stdout) as Array<{ success: boolean; results: Record<string, unknown>[]; meta?: { changes?: number } }>;
  if (parsed.length !== 1 || !parsed[0].success) throw new Error("remote D1 returned an invalid response");
  return parsed[0];
}

async function main() {
  const rows = remoteSql(`SELECT a.id,a.original_title,a.canonical_url,a.updated_at,p.version_id,
    v.original_published_at AS version_date
    FROM articles a JOIN article_publications_p3 p ON p.article_id=a.id AND p.state='published'
    JOIN article_content_versions_p3 v ON v.id=p.version_id AND v.article_id=a.id
    WHERE a.source_key='es-tribunal-constitucional' AND a.original_published_at IS NULL
      AND v.original_published_at IS NOT NULL ORDER BY a.id`).results as unknown as DateRow[];
  const verified: Array<DateRow & { officialDate: string; hjId: string }> = [];
  const skipped: Array<{ id: string; title: string; reason: string }> = [];
  for (const row of rows) {
    const hjId = extractSpainHjId({ canonical_url: row.canonical_url });
    const expected = /^\s*(SENTENCIA|AUTO|DECLARACI[OÓ]N)\s+(\d+)\/(\d{4})\s*$/i.exec(row.original_title);
    if (!hjId || !expected) { skipped.push({ id: row.id, title: row.original_title, reason: "missing official ID or exact title" }); continue; }
    const evidence = await fetchSpainOfficialDateEvidence(hjId, row.canonical_url, { delayMs: 150 });
    const heading = evidence.heading;
    const sameIdentity = heading &&
      heading.resolutionType?.toUpperCase() === expected[1].toUpperCase() &&
      Number(heading.resolutionNumber) === Number(expected[2]) &&
      Number(heading.resolutionYear) === Number(expected[3]);
    const date = evidence.decisionDate;
    if (!evidence.ok || !heading || !sameIdentity || !date ||
      normalizeSpainDateOnly(row.version_date) !== date) {
      skipped.push({ id: row.id, title: row.original_title, reason: evidence.reason ?? "identity or version date mismatch" });
      continue;
    }
    verified.push({ ...row, officialDate: date, hjId });
  }

  // Every row is guarded by the original updated_at, exact current publication version,
  // source, NULL date and verified published-version date. One atomic SQL statement.
  const clauses = verified.map((r) => `(id=${quote(r.id)} AND updated_at IS ${quote(r.updated_at)}
    AND EXISTS (SELECT 1 FROM article_publications_p3 p
      JOIN article_content_versions_p3 v ON v.id=p.version_id AND v.article_id=p.article_id
      WHERE p.article_id=articles.id AND p.state='published'
        AND p.version_id=${quote(r.version_id)} AND v.original_published_at=${quote(r.version_date)}))`);
  const sql = clauses.length ? `UPDATE articles SET original_published_at=(
    SELECT v.original_published_at FROM article_publications_p3 p
    JOIN article_content_versions_p3 v ON v.id=p.version_id AND v.article_id=p.article_id
    WHERE p.article_id=articles.id AND p.state='published'),
    updated_at=${quote(new Date().toISOString())}
    WHERE source_key='es-tribunal-constitucional' AND original_published_at IS NULL
      AND (${clauses.join(" OR\n")});` : "";
  mkdirSync(OUT, { recursive: true });
  writeFileSync(resolve(OUT, "core-date-reconciliation-verified.json"), JSON.stringify({ verified, skipped }, null, 2));
  if (sql) writeFileSync(resolve(OUT, "core-date-reconciliation.sql"), sql + "\n");
  let changes = 0;
  if (process.argv.includes("--apply") && sql) changes = remoteSql(sql).meta?.changes ?? 0;
  process.stdout.write(JSON.stringify({
    candidates: rows.length, officialVerified: verified.length, skipped,
    applied: process.argv.includes("--apply"), changes,
    restoredRemaining: process.argv.includes("--apply") ?
      remoteSql("SELECT COUNT(*) AS n FROM articles WHERE source_key='es-tribunal-constitucional' AND original_published_at IS NULL").results[0]?.n : undefined,
  }, null, 2) + "\n");
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
