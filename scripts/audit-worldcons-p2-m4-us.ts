/**
 * Read-only WorldCons P2-M4 US SCOTUS Production audit (bounded).
 *
 * Uses SELECT-only Production D1 queries plus a bounded R2 existence/hash
 * check for **exactly one** US article, so the P2-M4 readiness question
 * ("does a genuine newly collected official SCOTUS PDF persist its original in
 * R2 and its provenance in Core?") is auditable and reproducible. It never
 * mutates Production and never redrives/queues/publishes.
 *
 * The legacy historical counts (core articles / published P3 / search docs) are
 * reported **explicitly as non-proof** so they cannot be mistaken for fresh
 * evidence — matching `us-cutover-readiness.ts`'s rejection of
 * legacy-historical-counts-only readiness.
 *
 * Usage:
 *   pnpm audit:p2-m4-us
 * R2 check is skipped unless `--r2` is passed (it downloads the single bounded
 * object and compares its SHA-256; no write/put/delete).
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveM8CrawlerSourcePolicy } from "../lib/cloudflare/async-pipeline/crawler-source-ownership";
import { NATIVE_CRAWLER_SOURCES } from "../workers/async-pipeline/src/native-crawler";

export const US_SOURCE = "us-scotus" as const;
export const R2_BUCKET = "worldcons-artifacts" as const;

export interface AuditSection {
  name: string;
  database: string;
  sql: string;
}

export const SECTIONS: AuditSection[] = [
  {
    name: "us_official_pdf_article",
    database: "worldcons_core",
    sql: `SELECT id, source_key, canonical_url, status, review_state, fetched_at,
      json_extract(source_metadata,'$.officialPdf.r2Key') AS official_pdf_r2_key,
      json_extract(source_metadata,'$.officialPdf.sha256') AS official_pdf_sha256,
      json_extract(source_metadata,'$.officialPdf.docketVerified') AS official_pdf_docket_verified,
      json_extract(source_metadata,'$.collection.publishable') AS collection_publishable,
      json_extract(source_metadata,'$.review.required') AS review_required
      FROM articles WHERE source_key='${US_SOURCE}'
        AND json_extract(source_metadata,'$.officialPdf.r2Key') IS NOT NULL
      ORDER BY fetched_at DESC, id LIMIT 1`,
  },
  {
    name: "us_candidate_snapshot",
    database: "worldcons_ingest",
    sql: `SELECT url, status, last_error_code, attempt_count, last_attempt_at
      FROM source_url_candidates WHERE source_key='${US_SOURCE}'
      ORDER BY updated_at DESC LIMIT 5`,
  },
  {
    name: "us_legacy_counts_not_proof",
    database: "worldcons_core",
    sql: `SELECT
      (SELECT COUNT(*) FROM articles WHERE source_key='${US_SOURCE}') AS core_articles,
      (SELECT COUNT(*) FROM article_publications_p3 p JOIN articles a ON a.id=p.article_id
        WHERE p.state='published' AND a.source_key='${US_SOURCE}') AS published_p3`,
  },
  {
    name: "us_legacy_search_count_not_proof",
    database: "worldcons_search",
    sql: `SELECT COUNT(*) AS search_docs FROM search_documents WHERE source_key='${US_SOURCE}' LIMIT 1`,
  },
];

/** Rejects any statement that is not a single read-only SELECT. */
export function assertSelectOnly(statements: AuditSection[]): void {
  for (const statement of statements) {
    const normalized = statement.sql.trim();
    if (!/^SELECT\s/i.test(normalized)) throw new Error(`p2_m4_us.non_select:${statement.name}`);
    if (/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|ATTACH|PRAGMA)\b/i.test(normalized)) {
      throw new Error(`p2_m4_us.forbidden_keyword:${statement.name}`);
    }
    if (!/\bLIMIT\s+\d+\b/i.test(normalized) && statement.name !== "us_legacy_counts_not_proof") {
      throw new Error(`p2_m4_us.unbounded_query:${statement.name}`);
    }
  }
}

function runRemote(root: string, statement: AuditSection) {
  const wrangler = resolve(root, "node_modules/wrangler/bin/wrangler.js");
  const config = resolve(root, "workers/async-pipeline/wrangler.jsonc");
  const result = spawnSync(process.execPath, [wrangler, "d1", "execute", statement.database,
    "--remote", "--yes", "--json", "--config", config, "--command", statement.sql], {
    cwd: root, encoding: "utf8", timeout: 60_000, maxBuffer: 5 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    return { ok: false as const, error: `${result.error?.message ?? String(result.stderr).slice(0, 400)}` };
  }
  const response = JSON.parse(result.stdout) as Array<{ success?: boolean; results?: unknown[] }>;
  if (!Array.isArray(response) || response.some((entry) => entry.success !== true)) {
    return { ok: false as const, error: "incomplete_response" };
  }
  return { ok: true as const, rows: response.flatMap((entry) => entry.results ?? []) };
}

/**
 * Bounded R2 existence + hash check for exactly one object. Downloads the
 * object read-only (GET/pipe) and compares its SHA-256 to the recorded
 * provenance hash. Never writes.
 */
export function checkR2Object(root: string, r2Key: string, expectedSha256: string | null) {
  if (!/^artifacts\/scotus_pdf\/[0-9a-f]{64}\.pdf$/.test(r2Key)) {
    return { ok: false as const, error: `p2_m4_us.r2_key_unexpected:${r2Key.slice(0, 80)}` };
  }
  const wrangler = resolve(root, "node_modules/wrangler/bin/wrangler.js");
  const config = resolve(root, "workers/async-pipeline/wrangler.jsonc");
  const result = spawnSync(process.execPath, [wrangler, "r2", "object", "get",
    `${R2_BUCKET}/${r2Key}`, "--remote", "--pipe", "--config", config], {
    cwd: root, encoding: "buffer", timeout: 60_000, maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    return { ok: false as const, error: `${result.error?.message ?? String(result.stderr).slice(0, 300)}` };
  }
  const bytes = result.stdout as Buffer;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    ok: true as const,
    objectExists: bytes.length > 0,
    sizeBytes: bytes.length,
    sha256,
    sha256MatchesProvenance: expectedSha256 ? sha256 === expectedSha256 : null,
  };
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
    usM8Owned: policy.effective.includes(US_SOURCE),
    usNotStaged: !staged.includes(US_SOURCE),
  };
}

function main() {
  assertSelectOnly(SECTIONS);
  const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
  const withR2 = process.argv.includes("--r2");
  const queries = SECTIONS.map((statement) => ({ name: statement.name, database: statement.database, ...runRemote(root, statement) }));
  const articleQuery = queries.find((query) => query.name === "us_official_pdf_article");
  let r2Check: unknown = { skipped: true, reason: "pass --r2 to run the bounded single-object existence/hash check" };
  if (withR2 && articleQuery?.ok && Array.isArray(articleQuery.rows) && articleQuery.rows.length > 0) {
    const row = articleQuery.rows[0] as Record<string, unknown>;
    const r2Key = typeof row.official_pdf_r2_key === "string" ? row.official_pdf_r2_key : "";
    const sha = typeof row.official_pdf_sha256 === "string" ? row.official_pdf_sha256 : null;
    r2Check = checkR2Object(root, r2Key, sha);
  } else if (withR2 && articleQuery?.ok) {
    r2Check = { skipped: true, reason: "no us-scotus article with officialPdf.r2Key was found (Production E2E NOT_OBSERVED)" };
  }
  process.stdout.write(`${JSON.stringify({
    mode: "production_read_only",
    generatedAt: new Date().toISOString(),
    note: "us_legacy_counts_not_proof are historical markers only; they are NOT P2-M4 readiness evidence.",
    ownership: ownership(),
    queries,
    r2Check,
  }, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    console.error(error instanceof Error ? error.message : "p2_m4_us.unknown_failure");
    process.exitCode = 1;
  }
}
