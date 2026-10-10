/** Read-only Production preflight: reuse the exact bounded P3 refresh gate. */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assessP3RefreshCandidate, P3_DRIFT_REFRESH_CANARY_IDS, type P3RefreshCandidate } from "@/lib/admin/p4/p3-drift-refresh";

const ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));

export function readinessSql(ids: readonly string[]): string {
  if (ids.length !== 4 || ids.some((id) => !P3_DRIFT_REFRESH_CANARY_IDS.has(id) || !/^[0-9a-f-]{36}$/u.test(id))) {
    throw new Error("p3_preflight.invalid_cohort");
  }
  return `SELECT
    a.id,a.source_key,a.updated_at,a.status,a.original_language,a.translation_status,
    a.lifecycle_collection_state,a.lifecycle_processing_state,a.lifecycle_review_state,a.lifecycle_attention_state,
    a.source_metadata,a.canonical_url,a.cleaned_text,a.summary_json,a.korean_title,
    p.state AS publication_state,p.version_id,p.revision AS publication_revision,
    v.cleaned_text AS version_cleaned_text,v.summary_json AS version_summary_json,
    v.korean_title AS version_korean_title,v.canonical_url AS version_canonical_url
    FROM articles a JOIN article_publications_p3 p ON p.article_id=a.id
    JOIN article_content_versions_p3 v ON v.id=p.version_id AND v.article_id=a.id
    WHERE a.id IN (${ids.map((id) => `'${id}'`).join(",")}) ORDER BY a.id`;
}

export function summarizeReadiness(rows: P3RefreshCandidate[]) {
  const ids = [...P3_DRIFT_REFRESH_CANARY_IDS].sort();
  const found = new Set(rows.map((row) => row.id));
  if (rows.length !== ids.length || ids.some((id) => !found.has(id))) {
    throw new Error("p3_preflight.candidate_missing_or_duplicate");
  }
  return rows.map((row) => ({
    articleId: row.id,
    sourceKey: row.source_key,
    publicationRevision: Number(row.publication_revision),
    currentCoreUpdatedAt: row.updated_at,
    verdict: assessP3RefreshCandidate(row),
  }));
}

function main() {
  const statement = readinessSql([...P3_DRIFT_REFRESH_CANARY_IDS]);
  const cli = resolve(ROOT, "node_modules/wrangler/bin/wrangler.js");
  const config = resolve(ROOT, "workers/async-pipeline/wrangler.jsonc");
  const response = spawnSync(process.execPath, [cli, "d1", "execute", "worldcons_core", "--remote", "--yes", "--json",
    "--config", config, "--command", statement], { cwd: ROOT, encoding: "utf8", timeout: 50_000, maxBuffer: 6 * 1024 * 1024 });
  if (response.error || response.status !== 0) {
    throw new Error(`p3_preflight.production_query_failed: ${response.error?.message ?? String(response.stderr).slice(0, 400)}`);
  }
  const payload = JSON.parse(response.stdout) as Array<{ success?: boolean; results?: P3RefreshCandidate[] }>;
  if (!Array.isArray(payload) || payload.length !== 1 || payload[0]?.success !== true) {
    throw new Error("p3_preflight.query_incomplete");
  }
  process.stdout.write(`${JSON.stringify({ mode: "read_only", canaryCount: 4, candidates: summarizeReadiness(payload[0].results ?? []) }, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    console.error(error instanceof Error ? error.message : "p3_preflight.unknown_failure");
    process.exitCode = 1;
  }
}
