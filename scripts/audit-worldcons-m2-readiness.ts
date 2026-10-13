/**
 * Read-only WorldCons P2-M2 readiness matrix (Germany BVerfG + US SCOTUS).
 *
 * Uses actual production D1 aggregates (indexed/aggregate SELECT only, no write)
 * plus the code-native ownership policy resolvers, so the DE/US staged ownership
 * readiness decision is auditable and reproducible. Never mutates Production.
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveM8CrawlerSourcePolicy } from "../lib/cloudflare/async-pipeline/crawler-source-ownership";
import { NATIVE_CRAWLER_SOURCES } from "../workers/async-pipeline/src/native-crawler";

type Section = { name: string; database: string; sql: string };

const SOURCES = ["de-bverfg", "us-scotus"] as const;
const IN_LIST = SOURCES.map((source) => `'${source}'`).join(",");

export const SECTIONS: Section[] = [
  {
    name: "core_status_review_translation",
    database: "worldcons_core",
    sql: `SELECT source_key AS source, status, COALESCE(review_state,'<null>') AS review_state, translation_status, COUNT(*) AS n FROM articles WHERE source_key IN (${IN_LIST}) GROUP BY source_key, status, review_state, translation_status`,
  },
  {
    name: "core_collection_provenance",
    database: "worldcons_core",
    sql: `SELECT source_key AS source, COUNT(*) AS total, SUM(CASE WHEN json_extract(source_metadata,'$.collection.publishable')=1 THEN 1 ELSE 0 END) AS collection_publishable, SUM(CASE WHEN json_extract(source_metadata,'$.collection.sourceUrlVerified')=1 THEN 1 ELSE 0 END) AS url_verified, SUM(CASE WHEN json_extract(source_metadata,'$.collection.sourceTextAvailable')=1 THEN 1 ELSE 0 END) AS text_available, SUM(CASE WHEN json_extract(source_metadata,'$.officialPdf.r2Key') IS NOT NULL THEN 1 ELSE 0 END) AS official_pdf FROM articles WHERE source_key IN (${IN_LIST}) GROUP BY source_key`,
  },
  {
    name: "core_p3_published",
    database: "worldcons_core",
    sql: `SELECT a.source_key AS source, COUNT(*) AS published_p3 FROM article_publications_p3 p JOIN articles a ON a.id=p.article_id WHERE p.state='published' AND a.source_key IN (${IN_LIST}) GROUP BY a.source_key`,
  },
  {
    name: "ingest_candidates",
    database: "worldcons_ingest",
    sql: `SELECT source_key AS source, status, COALESCE(last_error_code,'<null>') AS last_error_code, COUNT(*) AS n, MAX(updated_at) AS last_update FROM source_url_candidates WHERE source_key IN (${IN_LIST}) GROUP BY source_key, status, last_error_code`,
  },
  {
    name: "ingest_latest_runs",
    database: "worldcons_ingest",
    sql: `SELECT source_key AS source, MAX(started_at) AS latest_run, COUNT(*) AS runs FROM ingestion_runs WHERE source_key IN (${IN_LIST}) GROUP BY source_key`,
  },
  {
    name: "search_documents",
    database: "worldcons_search",
    sql: `SELECT source_key AS source, COUNT(*) AS search_docs FROM search_documents WHERE source_key IN (${IN_LIST}) GROUP BY source_key`,
  },
];

export function assertSelectOnly(statements: Section[]): void {
  for (const statement of statements) {
    const normalized = statement.sql.trim();
    if (!/^SELECT\s/i.test(normalized)) throw new Error(`m2_readiness.non_select:${statement.name}`);
    if (/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE)\b/i.test(normalized)) {
      throw new Error(`m2_readiness.forbidden_keyword:${statement.name}`);
    }
  }
}

function runRemote(root: string, statement: Section) {
  const wrangler = resolve(root, "node_modules/wrangler/bin/wrangler.js");
  const config = resolve(root, "workers/async-pipeline/wrangler.jsonc");
  const result = spawnSync(process.execPath, [wrangler, "d1", "execute", statement.database,
    "--remote", "--yes", "--json", "--config", config, "--command", statement.sql], {
    cwd: root, encoding: "utf8", timeout: 60_000, maxBuffer: 5 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    return { ok: false, error: `${result.error?.message ?? String(result.stderr).slice(0, 400)}` };
  }
  const response = JSON.parse(result.stdout) as Array<{ success?: boolean; results?: unknown[] }>;
  if (!Array.isArray(response) || response.some((entry) => entry.success !== true)) {
    return { ok: false, error: "incomplete_response" };
  }
  return { ok: true, rows: response.flatMap((entry) => entry.results ?? []) };
}

function ownership() {
  const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
  const parsed = JSON.parse(readFileSync(resolve(root, "workers/async-pipeline/wrangler.jsonc"), "utf8")) as { vars: Record<string, string> };
  const staged = (parsed.vars.WORLDCONS_INGEST_STAGE_SOURCE_ALLOWLIST ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  const policy = resolveM8CrawlerSourcePolicy(parsed.vars.M8_CRAWLER_SOURCE_EXCLUDE, [...NATIVE_CRAWLER_SOURCES]);
  return {
    nativeSources: [...NATIVE_CRAWLER_SOURCES],
    stagedAllowlist: staged,
    m8ExcludeRaw: parsed.vars.M8_CRAWLER_SOURCE_EXCLUDE,
    policyValid: policy.valid,
    policyExcluded: policy.excluded,
    policyEffective: policy.effective,
    pairedExact: policy.valid && JSON.stringify(policy.excluded) === JSON.stringify(staged),
    deUsM8Owned: SOURCES.every((source) => policy.effective.includes(source)),
    deUsNotStaged: SOURCES.every((source) => !staged.includes(source)),
  };
}

function main() {
  assertSelectOnly(SECTIONS);
  const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
  const queries = SECTIONS.map((statement) => ({ name: statement.name, database: statement.database, ...runRemote(root, statement) }));
  process.stdout.write(`${JSON.stringify({ mode: "production_read_only", generatedAt: new Date().toISOString(), ownership: ownership(), queries }, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    console.error(error instanceof Error ? error.message : "m2_readiness.unknown_failure");
    process.exitCode = 1;
  }
}
