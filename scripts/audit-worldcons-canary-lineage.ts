/**
 * Read-only WorldCons single-case canary lineage + manual-approval policy audit.
 *
 * Given a canary crawl job id and/or a normalized core article id, this script
 * performs SELECT-only, indexed, bounded Production reads and reports the
 * observed stage lineage plus the durable Core/P3/Search effects, so an operator
 * can *observe* a real per-case lineage instead of trusting a claim.
 *
 * Hard honesty rules enforced here (all fail-closed / NOT_OBSERVED, never PASS by
 * inference):
 *
 * - A stage is only "verified" when a durable `ingest_stage_jobs` row for that
 *   exact stage has `status='succeeded'`. Mere presence is never success.
 * - The operator canary is **crawl-first by design**: it intentionally does NOT
 *   create a `discovery` job. `sevenStageComplete` therefore can never be true
 *   for a canary, and `discovery` is reported as `discovery_not_executed`. This
 *   canary is a lower-scope control, NOT proof of the literal
 *   Discovery->Search seven-stage criterion.
 * - A crawl job's `article_id` is a `native:` candidate hash while `normalize`
 *   and later stages use the real core UUID. A query filtered only by the core
 *   UUID cannot observe crawl (and vice versa). When the two identities cannot
 *   both be resolved from observed rows, the relation is reported as
 *   `native_core_relation: "unresolved"` and the missing side is NOT_OBSERVED.
 * - `e2e_approval_evidence_v1` is the **automatic** FR/ES staged approval ledger,
 *   NOT a US manual publication authorization. It is never counted as manual
 *   consent: `manualAuthorizationPresent` is always reported unproven here.
 * - Search/FTS same-case proof is reported unobserved unless an explicit
 *   `search_documents` row for the resolved case identity is observed.
 *
 * It never mutates Production, never redrives/queues/publishes, and never
 * fabricates evidence.
 *
 * Usage:
 *   pnpm audit:canary-lineage -- --job <crawlStageJobId>
 *   pnpm audit:canary-lineage -- --article <coreUuid> [--source de-bverfg|us-scotus]
 *   pnpm audit:canary-lineage -- --job <crawlJobId> --article <coreUuid>
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveM8CrawlerSourcePolicy } from "../lib/cloudflare/async-pipeline/crawler-source-ownership";
import { NATIVE_CRAWLER_SOURCES } from "../workers/async-pipeline/src/native-crawler";
import { INGEST_STAGE_NAMES } from "../lib/cloudflare/ingest-stages/contracts";

export interface AuditSection {
  name: string;
  database: string;
  sql: string;
}

/**
 * The seven canonical stages. `discovery` is included because the literal
 * Discovery->Search criterion names it; a crawl-first canary will not satisfy it
 * and is reported honestly rather than papered over.
 */
export const SEVEN_STAGES: readonly string[] = INGEST_STAGE_NAMES;

/** Rejects any statement that is not a single read-only SELECT. */
export function assertSelectOnly(statements: AuditSection[]): void {
  for (const statement of statements) {
    const normalized = statement.sql.trim();
    if (!/^SELECT\s/i.test(normalized)) throw new Error(`canary_lineage.non_select:${statement.name}`);
    if (/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|ATTACH|PRAGMA)\b/i.test(normalized)) {
      throw new Error(`canary_lineage.forbidden_keyword:${statement.name}`);
    }
  }
}

/**
 * Pure evaluation of the observed stage rows into a verified lineage. A stage is
 * verified only with a `status='succeeded'` row for that exact stage. `discovery`
 * is expected to be absent for a crawl-first canary and is labelled as such.
 */
export function evaluateSevenStageLineage(
  rows: ReadonlyArray<{ stage: string; status: string }>,
): {
  verifiedStages: string[];
  missingStages: string[];
  sevenStageComplete: boolean;
  discoveryExecuted: boolean;
  discoveryNotExecutedByCanary: boolean;
} {
  const verified = new Set(rows.filter((row) => row.status === "succeeded").map((row) => row.stage));
  const verifiedStages = SEVEN_STAGES.filter((stage) => verified.has(stage));
  const missingStages = SEVEN_STAGES.filter((stage) => !verified.has(stage));
  const discoveryExecuted = verified.has("discovery");
  return {
    verifiedStages: [...verifiedStages],
    missingStages: [...missingStages],
    sevenStageComplete: missingStages.length === 0,
    discoveryExecuted,
    discoveryNotExecutedByCanary: !discoveryExecuted,
  };
}

/**
 * Resolves the native->core identity relation from observed rows only. The crawl
 * job addresses a `native:` candidate id; normalize/later address the core UUID.
 * A single unconstrained query cannot span both, so this returns `unresolved`
 * unless both sides are genuinely observed (for example via the normalize
 * advance event that records `resolvedArticleId`/`fromArticleId`).
 */
export function evaluateNativeCoreRelation(input: {
  crawlArticleId: string | null;
  coreArticleId: string | null;
  advanceEventArticleIds: ReadonlyArray<{ resolvedArticleId?: string; fromArticleId?: string }>;
}): { relation: "resolved" | "unresolved"; nativeArticleId: string | null; coreArticleId: string | null; reason: string } {
  const crawl = input.crawlArticleId?.trim() || null;
  if (!crawl || !crawl.startsWith("native:")) {
    return { relation: "unresolved", nativeArticleId: crawl, coreArticleId: input.coreArticleId ?? null, reason: "canary_lineage.crawl_article_not_native" };
  }
  const resolved = input.advanceEventArticleIds.find((event) => event.fromArticleId === crawl && typeof event.resolvedArticleId === "string");
  if (resolved?.resolvedArticleId) {
    return { relation: "resolved", nativeArticleId: crawl, coreArticleId: resolved.resolvedArticleId, reason: "canary_lineage.native_core_resolved_via_advance_event" };
  }
  if (input.coreArticleId && input.coreArticleId === crawl) {
    return { relation: "resolved", nativeArticleId: crawl, coreArticleId: input.coreArticleId, reason: "canary_lineage.same_identity" };
  }
  return { relation: "unresolved", nativeArticleId: crawl, coreArticleId: input.coreArticleId ?? null, reason: "canary_lineage.native_core_relation_not_observed" };
}

/**
 * Pure manual-approval policy evaluation. US opinions must never be published
 * without an explicit manual authorization. IMPORTANT: `automaticApprovalRows`
 * is the FR/ES automatic staged ledger and must NEVER be treated as manual
 * consent, so `manualAuthorizationPresent` is always false here.
 */
export function evaluateManualApprovalPolicy(input: {
  sourceKey: string;
  collectionPublishable: boolean | null;
  reviewRequired: boolean | null;
  publishedP3: boolean;
  automaticApprovalRows: number;
}): { compliant: boolean; reason: string; manualAuthorizationPresent: false } {
  if (input.sourceKey !== "us-scotus") {
    return { compliant: true, reason: "canary_lineage.policy_not_us", manualAuthorizationPresent: false };
  }
  if (input.collectionPublishable === true) {
    return { compliant: false, reason: "canary_lineage.us_publishable_without_manual_authorization", manualAuthorizationPresent: false };
  }
  if (input.publishedP3) {
    return { compliant: false, reason: "canary_lineage.us_published_without_manual_authorization", manualAuthorizationPresent: false };
  }
  // The automatic ledger is not manual consent; even when rows exist, manual
  // authorization remains unproven.
  void input.automaticApprovalRows;
  return { compliant: true, reason: "canary_lineage.us_private_hold_preserved", manualAuthorizationPresent: false };
}

function argumentValue(name: string): string | undefined {
  return process.argv.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3).trim()
    ?? (process.argv.includes(`--${name}`) ? process.argv[process.argv.indexOf(`--${name}`) + 1]?.trim() : undefined);
}

function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function sectionsFor(input: { articleId?: string; jobId?: string }): AuditSection[] {
  const sections: AuditSection[] = [];
  if (input.jobId) {
    sections.push({
      name: "canary_crawl_job",
      database: "worldcons_ingest",
      sql: `SELECT id, stage, article_id, source_key, status, attempt_count, payload_ref, result_ref, created_at, completed_at
        FROM ingest_stage_jobs WHERE id = ${quote(input.jobId)} LIMIT 1`,
    });
    // Identity linkage observed through the append-only advance events. This is a
    // bounded, indexed read scoped to the crawl job's own article lineage.
    sections.push({
      name: "crawl_advance_events",
      database: "worldcons_ingest",
      sql: `SELECT safe_details FROM ingest_stage_job_events
        WHERE job_id = ${quote(input.jobId)} AND event_type = 'job_stage_advanced'
        ORDER BY occurred_at ASC LIMIT 10`,
    });
  }
  // The stage lineage is keyed by whichever identity the operator supplied. The
  // crawl identity is native:, normalize+ are core UUIDs, so both may be needed.
  const lineageKey = input.articleId ? quote(input.articleId) : null;
  if (lineageKey) {
    sections.push({
      name: "stage_lineage",
      database: "worldcons_ingest",
      sql: `SELECT stage, status, attempt_count, source_key, article_id, completed_at
        FROM ingest_stage_jobs
        WHERE article_id = ${lineageKey}
          AND stage IN (${SEVEN_STAGES.map((stage) => `'${stage}'`).join(", ")})
        ORDER BY stage, created_at DESC LIMIT 50`,
    });
    sections.push({
      name: "canary_audit",
      database: "worldcons_ingest",
      sql: `SELECT canary_id, source_key, outcome, operator_id, identity_ecli, identity_docket, created_at
        FROM ingest_stage_canary_records_v1
        WHERE candidate_id = ${lineageKey} OR source_key IN (SELECT source_key FROM ingest_stage_jobs WHERE article_id = ${lineageKey})
        ORDER BY created_at ASC LIMIT 50`,
    });
    sections.push({
      name: "core_article_and_provenance",
      database: "worldcons_core",
      sql: `SELECT id, source_key, canonical_url, status, review_state, translation_status,
        json_extract(source_metadata,'$.collection.publishable') AS collection_publishable,
        json_extract(source_metadata,'$.collection.sourceUrlVerified') AS collection_source_url_verified,
        json_extract(source_metadata,'$.review.required') AS review_required,
        json_extract(source_metadata,'$.officialPdf.r2Key') AS official_pdf_r2_key,
        json_extract(source_metadata,'$.officialPdf.sha256') AS official_pdf_sha256,
        json_extract(source_metadata,'$.officialPdf.docketVerified') AS official_pdf_docket_verified
        FROM articles WHERE id = ${lineageKey} LIMIT 1`,
    });
    sections.push({
      name: "p3_publication",
      database: "worldcons_core",
      sql: `SELECT state, version_id, revision, published_at FROM article_publications_p3
        WHERE article_id = ${lineageKey} ORDER BY created_at DESC LIMIT 5`,
    });
    sections.push({
      name: "automatic_approval_ledger_not_manual",
      database: "worldcons_core",
      sql: `SELECT COUNT(*) AS automatic_approval_rows FROM e2e_approval_evidence_v1 WHERE article_id = ${lineageKey} LIMIT 1`,
    });
    sections.push({
      name: "search_projection",
      database: "worldcons_search",
      sql: `SELECT article_id, source_key, case_numbers FROM search_documents WHERE article_id = ${lineageKey} LIMIT 1`,
    });
  }
  return sections;
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

function ownership() {
  const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
  const parsed = JSON.parse(readFileSync(resolve(root, "workers/async-pipeline/wrangler.jsonc"), "utf8")) as { vars: Record<string, string> };
  const staged = (parsed.vars.WORLDCONS_INGEST_STAGE_SOURCE_ALLOWLIST ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  const policy = resolveM8CrawlerSourcePolicy(parsed.vars.M8_CRAWLER_SOURCE_EXCLUDE, [...NATIVE_CRAWLER_SOURCES]);
  return {
    stagedAllowlist: staged,
    m8Exclude: policy.excluded,
    pairedExact: policy.valid && JSON.stringify(policy.excluded) === JSON.stringify(staged),
  };
}

function main() {
  const articleId = argumentValue("article");
  const jobId = argumentValue("job");
  const sourceKey = argumentValue("source") ?? "us-scotus";
  if (!articleId && !jobId) throw new Error("canary_lineage.requires_article_or_job");
  const sections = sectionsFor({ articleId, jobId });
  assertSelectOnly(sections);
  const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
  const queries = Object.fromEntries(sections.map((statement) => [statement.name, runRemote(root, statement)]));

  const crawlQuery = queries.canary_crawl_job;
  const crawlRow = crawlQuery?.ok ? (crawlQuery.rows as Array<Record<string, unknown>>)[0] : undefined;
  const crawlArticleId = crawlRow && typeof crawlRow.article_id === "string" ? crawlRow.article_id : null;

  const lineageQuery = queries.stage_lineage;
  const lineageRows = lineageQuery?.ok ? (lineageQuery.rows as Array<{ stage: string; status: string }>) : [];
  const lineage = evaluateSevenStageLineage(lineageRows);

  const advanceQuery = queries.crawl_advance_events;
  const advanceEvents = advanceQuery?.ok
    ? (advanceQuery.rows as Array<{ safe_details: string }>).map((row) => {
        try { return JSON.parse(row.safe_details) as { resolvedArticleId?: string; fromArticleId?: string }; } catch { return {}; }
      })
    : [];
  const relation = evaluateNativeCoreRelation({
    crawlArticleId,
    coreArticleId: articleId ?? null,
    advanceEventArticleIds: advanceEvents,
  });

  const coreQuery = queries.core_article_and_provenance;
  const coreRow = coreQuery?.ok ? (coreQuery.rows as Array<Record<string, unknown>>)[0] : undefined;
  const pubQuery = queries.p3_publication;
  const publishedP3 = pubQuery?.ok ? (pubQuery.rows as Array<Record<string, unknown>>).some((row) => row.state === "published") : false;
  const approvalQuery = queries.automatic_approval_ledger_not_manual;
  const automaticApprovalRows = approvalQuery?.ok ? Number((approvalQuery.rows as Array<{ automatic_approval_rows: number }>)[0]?.automatic_approval_rows ?? 0) : 0;

  const policy = evaluateManualApprovalPolicy({
    sourceKey: String(coreRow?.source_key ?? sourceKey),
    collectionPublishable: coreRow
      ? (coreRow.collection_publishable === 1 || coreRow.collection_publishable === true ? true
          : coreRow.collection_publishable === null || coreRow.collection_publishable === undefined ? null
          : Boolean(coreRow.collection_publishable))
      : null,
    reviewRequired: coreRow ? (coreRow.review_required === 1 || coreRow.review_required === true) : null,
    publishedP3,
    automaticApprovalRows,
  });

  const searchQuery = queries.search_projection;
  const searchRow = searchQuery?.ok ? (searchQuery.rows as Array<Record<string, unknown>>)[0] : undefined;

  process.stdout.write(`${JSON.stringify({
    mode: "production_read_only",
    generatedAt: new Date().toISOString(),
    note: "Observes lineage and policy only. NOT a publication authorization; does NOT fabricate 7/7. The automatic FR/ES approval ledger is never treated as US manual consent.",
    target: { articleId: articleId ?? null, jobId: jobId ?? null, sourceKey },
    ownership: ownership(),
    lineage: {
      verifiedStages: lineage.verifiedStages,
      missingStages: lineage.missingStages,
      sevenStageComplete: lineage.sevenStageComplete,
      discoveryExecuted: lineage.discoveryExecuted,
      discoveryNotExecutedByCanary: lineage.discoveryNotExecutedByCanary,
      keying: "stages verified only when ingest_stage_jobs.status='succeeded' for that exact stage; canary is crawl-first and cannot satisfy the literal seven-stage criterion",
    },
    identity: relation,
    manualApprovalPolicy: policy,
    manualAuthorizationPresent: false,
    searchSameCaseObserved: Boolean(searchRow),
    queries,
  }, null, 2)}\n`);
  if (!policy.compliant) process.exitCode = 3;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    console.error(error instanceof Error ? error.message : "canary_lineage.unknown_failure");
    process.exitCode = 1;
  }
}
