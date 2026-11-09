/**
 * Operator-only, dry-run-by-default P0-2 Spain decision-date correction.
 *
 * The default path only reads. `--emit-sql` materializes the exact literal SQL
 * batch without touching D1. `--apply` additionally requires a per-article
 * authorization file and the exact dry-run plan hash; it executes one atomic
 * `wrangler d1 execute --file` against WorldCons Core. This repository task does
 * not run that remote apply.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildSpainDateCorrectionPlan,
  renderSpainDateCorrectionSql,
  SPAIN_DATE_CORRECTION_POLICY,
  type SpainDateCorrectionAuthorization,
  type SpainDateCorrectionPlan,
  type SpainDateCorrectionRow,
  type SpainDateCorrectionStatement,
} from "@/lib/ingest/spain-decision-date-correction";
import { buildSpainDateCorrectionStatements } from "@/lib/ingest/spain-decision-date-correction";
import {
  fetchSpainOfficialDateEvidence,
} from "@/lib/ingest/spain-decision-date-recovery";

const ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const SOURCE_KEY = "es-tribunal-constitucional";
const DEFAULT_SQL_PATH = resolve(ROOT, "artifacts/spain-date-correction/spain-fecha-registro-correction.sql");

export const SPAIN_DATE_CORRECTION_READ_SQL = `SELECT
  a.id AS article_id,a.source_key AS article_source_key,a.canonical_url,
  a.original_published_at AS article_original_published_at,a.updated_at AS article_updated_at,
  a.content_hash AS article_content_hash,
  p.id AS publication_id,p.state AS publication_state,p.revision AS publication_revision,
  p.version_id AS publication_version_id,
  v.id AS version_id,v.revision AS version_revision,v.content_hash AS version_content_hash,
  v.original_published_at AS version_original_published_at,v.created_at AS version_created_at,
  v.slug AS version_slug,v.source_key AS version_source_key,v.jurisdiction AS version_jurisdiction,
  v.institution_name AS version_institution_name,v.content_type AS version_content_type,
  v.original_url AS version_original_url,v.canonical_url AS version_canonical_url,
  v.original_language AS version_original_language,v.original_title AS version_original_title,
  v.korean_title AS version_korean_title,v.discovered_at AS version_discovered_at,
  v.fetched_at AS version_fetched_at,v.summarized_at AS version_summarized_at,
  v.cleaned_text AS version_cleaned_text,v.summary_json AS version_summary_json,
  v.source_metadata AS version_source_metadata,v.error_metadata AS version_error_metadata,
  v.case_key AS version_case_key,
  h.current_version_id AS p3_head_version_id,h.current_revision AS p3_head_revision,
  v4.current_version_id AS v4_head_version_id,v4.current_revision AS v4_head_revision,
  CASE WHEN EXISTS(SELECT 1 FROM e2e_generation_heads_v1 g WHERE g.article_id=a.id) THEN 1 ELSE 0 END AS has_generation,
  COALESCE((SELECT s.required FROM e2e_source_policies_v1 s WHERE s.source_key=a.source_key),0) AS source_policy_required,
  (SELECT l.ledger_revision FROM article_audit_ledger_p3 l WHERE l.article_id=a.id ORDER BY CAST(l.ledger_revision AS INTEGER) DESC LIMIT 1) AS audit_ledger_revision,
  (SELECT l.entry_hash FROM article_audit_ledger_p3 l WHERE l.article_id=a.id ORDER BY CAST(l.ledger_revision AS INTEGER) DESC LIMIT 1) AS audit_entry_hash
FROM articles a
JOIN article_publications_p3 p ON p.article_id=a.id AND p.state='published'
JOIN article_content_versions_p3 v ON v.id=p.version_id AND v.article_id=a.id
LEFT JOIN article_version_heads_p3 h ON h.article_id=a.id
LEFT JOIN article_revision_heads_v4 v4 ON v4.article_id=a.id
WHERE a.source_key='${SOURCE_KEY}'
  AND v.original_published_at IS NULL
ORDER BY a.id`;

function arg(name: string) {
  return process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function flag(name: string) {
  return process.argv.includes(`--${name}`);
}

function readRemote(query: string) {
  const cli = resolve(ROOT, "node_modules/wrangler/bin/wrangler.js");
  const config = resolve(ROOT, "workers/async-pipeline/wrangler.jsonc");
  const response = spawnSync(process.execPath, [cli, "d1", "execute", "worldcons_core", "--remote", "--yes", "--json", "--config", config, "--command", query], { cwd: ROOT, encoding: "utf8", timeout: 90_000, maxBuffer: 64 * 1024 * 1024 });
  if (response.error || response.status !== 0) {
    throw new Error(`spain_date_correction.production_read_failed: ${response.error?.message ?? String(response.stderr).slice(0, 400)}`);
  }
  const payload = JSON.parse(response.stdout) as Array<{ success?: boolean; results?: Array<Record<string, unknown>> }>;
  if (!Array.isArray(payload) || payload.length !== 1 || payload[0]?.success !== true) {
    throw new Error("spain_date_correction.production_read_incomplete");
  }
  return payload[0].results ?? [];
}

function readRows(path: string) {
  const parsed = JSON.parse(readFileSync(resolve(ROOT, path), "utf8").replace(/^\uFEFF/, "")) as unknown;
  const rows = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { rows?: unknown }).rows)
      ? (parsed as { rows: unknown[] }).rows
      : null;
  if (!rows) throw new Error("spain_date_correction.input_must_be_an_array_or_contain_rows");
  return rows as SpainDateCorrectionRow[];
}

function readAuthorization(path: string | undefined): SpainDateCorrectionAuthorization | undefined {
  if (!path) return undefined;
  const parsed = JSON.parse(readFileSync(resolve(ROOT, path), "utf8").replace(/^\uFEFF/, "")) as SpainDateCorrectionAuthorization;
  if (!parsed || parsed.policyVersion !== SPAIN_DATE_CORRECTION_POLICY
    || typeof parsed.actorId !== "string" || !parsed.actorId.trim()
    || typeof parsed.approvedAt !== "string" || !Number.isFinite(Date.parse(parsed.approvedAt))
    || !Array.isArray(parsed.entries)) {
    throw new Error("spain_date_correction.invalid_authorization");
  }
  return parsed;
}

async function statementsForPlan(plan: SpainDateCorrectionPlan, actorId: string) {
  const statements: SpainDateCorrectionStatement[] = [];
  for (const row of plan.rows) {
    if (row.status !== "repairable") continue;
    statements.push(...await buildSpainDateCorrectionStatements(row, { actorId, now: plan.generatedAt }));
  }
  return statements;
}

function runRemoteSqlFile(path: string) {
  const cli = resolve(ROOT, "node_modules/wrangler/bin/wrangler.js");
  const config = resolve(ROOT, "workers/async-pipeline/wrangler.jsonc");
  const response = spawnSync(process.execPath, [cli, "d1", "execute", "worldcons_core", "--remote", "--yes", "--config", config, "--file", path], { cwd: ROOT, encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
  if (response.error || response.status !== 0) {
    throw new Error(`spain_date_correction.apply_failed: ${response.error?.message ?? String(response.stderr).slice(0, 600)}`);
  }
}

async function main() {
  const inputPath = arg("input");
  const remote = flag("remote");
  if (!inputPath && !remote) throw new Error("spain_date_correction.requires_--input=<json>_or_--remote");
  if (inputPath && remote) throw new Error("spain_date_correction.choose_one_of_--input_or_--remote");
  const maxOfficialFetches = Math.max(0, Math.trunc(Number(arg("max-fetches") ?? 500)));
  const delayMs = Math.max(0, Math.trunc(Number(arg("delay-ms") ?? 2_000)));
  const authorization = readAuthorization(arg("authorization"));
  const rows = inputPath ? readRows(inputPath) : readRemote(SPAIN_DATE_CORRECTION_READ_SQL) as unknown as SpainDateCorrectionRow[];
  const plan = await buildSpainDateCorrectionPlan({
    rows,
    authorization,
    maxOfficialFetches,
    now: arg("now"),
    fetchEvidence: (hjId, canonicalUrl) => fetchSpainOfficialDateEvidence(hjId, canonicalUrl, { delayMs }),
  });

  const sqlPath = arg("emit-sql") ?? (flag("apply") ? DEFAULT_SQL_PATH : undefined);
  if (sqlPath) {
    if (!authorization) throw new Error("spain_date_correction.emit_sql_requires_authorization");
    if (!plan.applyReady) throw new Error("spain_date_correction.plan_not_apply_ready");
    const actorId = authorization.actorId;
    const statements = await statementsForPlan(plan, actorId);
    if (statements.length === 0) throw new Error("spain_date_correction.no_repairable_rows");
    mkdirSync(dirname(resolve(ROOT, sqlPath)), { recursive: true });
    writeFileSync(resolve(ROOT, sqlPath), `${renderSpainDateCorrectionSql(statements)}\n`, "utf8");
  }

  if (flag("apply")) {
    if (!authorization) throw new Error("spain_date_correction.apply_requires_authorization");
    const confirm = arg("confirm")?.trim();
    if (!confirm || confirm !== plan.planHash) throw new Error("spain_date_correction.confirm_plan_hash_mismatch");
    if (!plan.applyReady) throw new Error("spain_date_correction.plan_not_apply_ready");
    if (!sqlPath) throw new Error("spain_date_correction.apply_sql_path_missing");
    runRemoteSqlFile(resolve(ROOT, sqlPath));
  }

  process.stdout.write(`${JSON.stringify({
    ...plan,
    source: inputPath ? `input:${inputPath}` : "production-read-only",
    emittedSql: sqlPath ? resolve(ROOT, sqlPath) : null,
    applied: flag("apply"),
  }, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "spain_date_correction.unknown_failure");
    process.exitCode = 1;
  });
}
