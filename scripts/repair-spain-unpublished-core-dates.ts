/**
 * Source-confirmed date repair for PRIVATE, E2E-unmanaged Spanish Core records.
 * Does not mutate published content, P3 versions, publication states, or E2E
 * generations. Live D1 mutation is explicit (--apply); dry-run by default.
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractSpainHjId, fetchSpainOfficialDateEvidence } from "@/lib/ingest/spain-decision-date-recovery";
import { normalizeSpainResolutionType } from "@/lib/ingest/spain-decision-date";

const ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const CLI = resolve(ROOT, "node_modules/wrangler/bin/wrangler.js");
const CONFIG = resolve(ROOT, "workers/async-pipeline/wrangler.jsonc");
interface Row { id: string; original_title: string; canonical_url: string; updated_at: string; }
const q = (value: string) => "'" + value.replace(/'/g, "''") + "'";

function query(sql: string) {
  const run = spawnSync(process.execPath,
    [CLI, "d1", "execute", "worldcons_core", "--remote", "--yes", "--json", "--config", CONFIG, "--command", sql],
    { cwd: ROOT, encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  if (run.error || run.status !== 0) throw new Error("D1 query failed (exit " + run.status + "): " + (run.error?.message ?? run.stderr?.slice(0, 600)) + " OUTPUT: " + run.stdout?.slice(0, 900));
  const parsed = JSON.parse(run.stdout) as Array<{ success: boolean; results: unknown[]; meta?: { changes?: number } }>;
  if (parsed.length !== 1 || parsed[0].success !== true) throw new Error("D1 query incomplete");
  return parsed[0];
}
const candidateSql = `SELECT a.id,a.original_title,a.canonical_url,a.updated_at
  FROM articles a WHERE a.source_key='es-tribunal-constitucional'
  AND a.original_published_at IS NULL
  AND NOT EXISTS(SELECT 1 FROM article_publications_p3 p WHERE p.article_id=a.id AND p.state='published')
  AND NOT EXISTS(SELECT 1 FROM e2e_generation_heads_v1 g WHERE g.article_id=a.id)
  ORDER BY a.original_title`;

async function main() {
  const rows = query(candidateSql).results as Row[];
  const results: Array<{ title: string; id: string; status: string; date?: string; reason?: string }> = [];
  for (const row of rows) {
    const match = /^\s*(SENTENCIA|AUTO|DECLARACI[OÓ]N)\s+(\d+)\/(\d{4})\s*$/i.exec(row.original_title);
    const hjId = extractSpainHjId({ canonical_url: row.canonical_url });
    if (!match || !hjId) {
      results.push({ title: row.original_title, id: row.id, status: "skipped", reason: "unidentified article / invalid HJ id" });
      continue;
    }
    const evidence = await fetchSpainOfficialDateEvidence(hjId, row.canonical_url);
    const heading = evidence.heading;
    const identityOk = heading?.resolutionType === normalizeSpainResolutionType(match[1]) &&
      heading?.resolutionNumber === Number(match[2]) && heading?.resolutionYear === Number(match[3]);
    if (!evidence.ok || !evidence.decisionDate || !identityOk) {
      results.push({ title: row.original_title, id: row.id, status: "skipped", reason: evidence.reason ?? "official heading identity mismatch" });
      continue;
    }
    const date = evidence.decisionDate + "T00:00:00.000Z";
    if (!process.argv.includes("--apply")) {
      results.push({ title: row.original_title, id: row.id, status: "verified-dry-run", date });
      continue;
    }
    const sql = `UPDATE articles SET original_published_at=${q(date)},updated_at=${q(new Date().toISOString())}
      WHERE id=${q(row.id)} AND source_key='es-tribunal-constitucional'
      AND original_title=${q(row.original_title)} AND canonical_url=${q(row.canonical_url)}
      AND updated_at IS ${q(row.updated_at)} AND original_published_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM article_publications_p3 p WHERE p.article_id=articles.id AND p.state='published')
      AND NOT EXISTS(SELECT 1 FROM e2e_generation_heads_v1 g WHERE g.article_id=articles.id)`;
    const changes = query(sql).meta?.changes ?? 0;
    results.push({ title: row.original_title, id: row.id, status: changes === 1 ? "repaired" : "stale-skipped", date });
  }
  process.stdout.write(JSON.stringify({ total: rows.length, apply: process.argv.includes("--apply"),
    repaired: results.filter(x => x.status === "repaired").length,
    verified: results.filter(x => x.status === "verified-dry-run").length, results }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
