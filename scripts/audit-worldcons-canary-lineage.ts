/**
 * Read-only WorldCons single-case canary lineage + manual-approval policy audit.
 *
 * This script follows a canary's *durable linkage* from the original Crawl job
 * through every later stage, instead of trusting a caller-supplied identity. The
 * operator canary is crawl-first: the Crawl job addresses a `native:` candidate
 * id, while normalize and later stages address the real Core UUID (the native->
 * core identity resolution recorded on the Normalize `job_stage_advanced` event).
 * A single query keyed only by the Core UUID therefore cannot observe Crawl, and a
 * query keyed only by the native id cannot observe later stages. This audit walks
 * the exact chain via each stage's durable `job_stage_advanced.safe_details.nextKey`
 * (`= the next job's idempotency_key`), so no unrelated job of the same source can
 * ever be counted.
 *
 * Hard honesty rules (all fail-closed / NOT_OBSERVED, never PASS by inference):
 *
 * - Every stage in the chain must be a real `ingest_stage_jobs` row with
 *   `status='succeeded'` for that exact stage; a missing/broken link fails closed
 *   with a named reason.
 * - Every job's `source_key` must equal the original Crawl job's `source_key`
 *   (one audited chain, one source; mixed sources fail closed).
 * - The operator canary starts at Crawl by design and creates no `discovery` job,
 *   so `sevenStageComplete` can only be true when a genuine discovery job is also
 *   present in the chain. It is never back-filled.
 * - `e2e_approval_evidence_v1` is the automatic FR/ES approval ledger, NOT a US
 *   manual authorization; `manualAuthorizationPresent` is always unproven.
 * - A pre-existing published case that has no publish/search stage in THIS chain
 *   is reported `legacy_published_preexisting`, never as a staged publication.
 * - Search proof requires a `search_documents` row AND a `search_fts` row for the
 *   exact same article with the same FTS rowid; otherwise it is unobserved.
 *
 * It never mutates Production, never redrives/queues/publishes, and never
 * fabricates evidence.
 *
 * Usage:
 *   pnpm audit:canary-lineage -- --job <originalCrawlJobId> [--source de-bverfg|us-scotus]
 *   pnpm audit:canary-lineage -- --article <coreUuid>
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

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Strict, fail-closed job-id validation (never interpolate arbitrary text). */
export function parseJobId(raw: string | undefined | null): { ok: true; value: string } | { ok: false; error: string } {
  const value = raw?.trim() ?? "";
  return UUID_PATTERN.test(value) ? { ok: true, value } : { ok: false, error: "canary_lineage.invalid_job_id" };
}

export type LinkedLineageFailure =
  | "canary_lineage.chain_empty"
  | "canary_lineage.chain_stage_not_succeeded"
  | "canary_lineage.chain_mixed_source"
  | "canary_lineage.chain_non_canary_source"
  | "canary_lineage.chain_out_of_order"
  | "canary_lineage.chain_stage_duplicate";

export interface LinkedLineageResult {
  ok: boolean;
  reason: string | null;
  sourceKey: string | null;
  stageCount: number;
  verifiedStages: string[];
  missingStages: string[];
  /** All six crawl..search stages succeeded (the canary's real chain). */
  stagedChainComplete: boolean;
  /** A genuine discovery job is also present in the chain (never true for a canary). */
  discoveryExecuted: boolean;
  /** Literal seven-stage Discovery->Search; requires an actual discovery job. */
  sevenStageComplete: boolean;
  /** The native candidate id addressed by the original Crawl job. */
  nativeArticleId: string | null;
  /** The Core UUID resolved across the native->core boundary, when observed. */
  coreArticleId: string | null;
  nativeCoreRelation: "resolved" | "unresolved";
}

export interface LinkedJob {
  stage: string;
  jobId: string;
  articleId: string;
  sourceKey: string | null;
  status: string;
  resultRef?: string | null;
}

/**
 * Pure evaluation of an ordered, linked job chain (Crawl -> ... -> Search, plus an
 * optional genuine Discovery). It verifies a single source, contiguous stage
 * order, one row per stage, and `succeeded` status on every stage. Any deviation
 * fails closed with a stable reason. `discovery` is only counted when an actual
 * discovery row is present; it is never inferred.
 */
export function evaluateLinkedLineage(chain: ReadonlyArray<LinkedJob>): LinkedLineageResult {
  const empty: LinkedLineageResult = {
    ok: false, reason: "canary_lineage.chain_empty", sourceKey: null, stageCount: 0,
    verifiedStages: [], missingStages: [...SEVEN_STAGES], stagedChainComplete: false,
    discoveryExecuted: false, sevenStageComplete: false, nativeArticleId: null, coreArticleId: null,
    nativeCoreRelation: "unresolved",
  };
  if (chain.length === 0) return empty;

  const source = chain[0].sourceKey ?? null;
  const CANARY_SOURCES = new Set(["de-bverfg", "us-scotus"]);
  if (!source || !CANARY_SOURCES.has(source)) {
    return { ...empty, reason: "canary_lineage.chain_non_canary_source", sourceKey: source, stageCount: chain.length, nativeArticleId: chain[0].articleId };
  }
  // One audited chain, one source.
  if (chain.some((job) => job.sourceKey !== source)) {
    return { ...empty, reason: "canary_lineage.chain_mixed_source", sourceKey: source, stageCount: chain.length, nativeArticleId: chain[0].articleId };
  }
  // One row per stage, in canonical order (crawl..search, discovery optional first).
  const seen = new Set<string>();
  let lastIndex = -1;
  for (const job of chain) {
    if (!SEVEN_STAGES.includes(job.stage)) continue;
    if (seen.has(job.stage)) {
      return { ...empty, reason: "canary_lineage.chain_stage_duplicate", sourceKey: source, stageCount: chain.length, nativeArticleId: chain[0].articleId };
    }
    seen.add(job.stage);
    const index = SEVEN_STAGES.indexOf(job.stage);
    if (index <= lastIndex) {
      return { ...empty, reason: "canary_lineage.chain_out_of_order", sourceKey: source, stageCount: chain.length, nativeArticleId: chain[0].articleId };
    }
    lastIndex = index;
  }
  // Every linked stage must be durably succeeded.
  for (const job of chain) {
    if (job.status !== "succeeded") {
      return { ...empty, reason: "canary_lineage.chain_stage_not_succeeded", sourceKey: source, stageCount: chain.length, nativeArticleId: chain[0].articleId };
    }
  }

  const succeededStages = chain.map((job) => job.stage);
  const verifiedStages = SEVEN_STAGES.filter((stage) => succeededStages.includes(stage));
  const missingStages = SEVEN_STAGES.filter((stage) => !succeededStages.includes(stage));
  const discoveryExecuted = succeededStages.includes("discovery");

  // The native candidate id is the Crawl job's article_id; the Core UUID is the
  // resolvedArticleId observed on the Normalize (or any later) stage, or a later
  // stage's article_id once the identity has been adopted.
  const crawlJob = chain.find((job) => job.stage === "crawl");
  const nativeArticleId = crawlJob?.articleId ?? null;
  const coreJob = chain.find((job) =>
    ["translate", "public-judgment", "publish", "search"].includes(job.stage) && UUID_PATTERN.test(job.articleId));
  // Normalize retains the native candidate id as its job article_id, but its
  // succeeded result_ref is the actual durable Core UUID. This also resolves
  // a preserved legacy US case, for which no Translate job is registered.
  const normalizeJob = chain.find((job) => job.stage === "normalize");
  const normalizedCoreId = normalizeJob?.status === "succeeded" && typeof normalizeJob.resultRef === "string"
    && UUID_PATTERN.test(normalizeJob.resultRef) && normalizeJob.articleId === nativeArticleId
    ? normalizeJob.resultRef : null;
  const coreArticleId = coreJob?.articleId ?? normalizedCoreId;
  const nativeCoreRelation = nativeArticleId?.startsWith("native:") && coreArticleId
    && (!coreJob || !normalizedCoreId || coreJob.articleId === normalizedCoreId) ? "resolved" : "unresolved";
  const stagedChainComplete = nativeCoreRelation === "resolved"
    && ["crawl", "normalize", "translate", "public-judgment", "publish", "search"]
      .every((stage) => succeededStages.includes(stage));

  return {
    ok: true,
    reason: null,
    sourceKey: source,
    stageCount: chain.length,
    verifiedStages: [...verifiedStages],
    missingStages: [...missingStages],
    stagedChainComplete,
    discoveryExecuted,
    sevenStageComplete: missingStages.length === 0 && stagedChainComplete,
    nativeArticleId,
    coreArticleId,
    nativeCoreRelation,
  };
}

/**
 * Applies the official-identity honesty rule to a linked-stage lineage. A
 * literal seven-stage completion is only claimed when the six successor stages
 * all succeeded *and* the linked discovery's resulting Core article carries
 * verified official-source identity (`collection.sourceUrlVerified === true`).
 * A missing/unverified identity downgrades `sevenStageComplete` to false while
 * preserving the underlying stage facts; it never fabricates or removes a stage.
 */
export function applyOfficialIdentityGate(
  lineage: LinkedLineageResult,
  officialIdentityVerified: boolean,
): LinkedLineageResult {
  if (lineage.sevenStageComplete && !officialIdentityVerified) {
    return { ...lineage, sevenStageComplete: false };
  }
  return lineage;
}

/**
 * Resolves the native->core identity relation from observed rows only. Kept for
 * direct unit testing; the audit's chain walker derives the same relation from the
 * linked Normalize advance event (`fromArticleId`/`resolvedArticleId`).
 */
export function evaluateNativeCoreRelation(input: {
  crawlArticleId: string | null;
  coreArticleId: string | null;
  advanceEventArticleIds: ReadonlyArray<{ resolvedArticleId?: string; fromArticleId?: string }>;
  normalizeArticleId?: string | null;
  normalizeResultRef?: string | null;
}): { relation: "resolved" | "unresolved"; nativeArticleId: string | null; coreArticleId: string | null; reason: string } {
  const crawl = input.crawlArticleId?.trim() || null;
  if (!crawl || !crawl.startsWith("native:")) {
    return { relation: "unresolved", nativeArticleId: crawl, coreArticleId: input.coreArticleId ?? null, reason: "canary_lineage.crawl_article_not_native" };
  }
  const resolved = input.advanceEventArticleIds.find((event) => event.fromArticleId === crawl && typeof event.resolvedArticleId === "string");
  if (resolved?.resolvedArticleId) {
    return { relation: "resolved", nativeArticleId: crawl, coreArticleId: resolved.resolvedArticleId, reason: "canary_lineage.native_core_resolved_via_advance_event" };
  }
  if (input.normalizeArticleId === crawl && input.normalizeResultRef
    && UUID_PATTERN.test(input.normalizeResultRef)
    && (!input.coreArticleId || input.coreArticleId === input.normalizeResultRef)) {
    return { relation: "resolved", nativeArticleId: crawl, coreArticleId: input.normalizeResultRef, reason: "canary_lineage.native_core_resolved_via_normalize_result" };
  }
  if (input.coreArticleId && input.coreArticleId === crawl) {
    return { relation: "resolved", nativeArticleId: crawl, coreArticleId: input.coreArticleId, reason: "canary_lineage.same_identity" };
  }
  return { relation: "unresolved", nativeArticleId: crawl, coreArticleId: input.coreArticleId ?? null, reason: "canary_lineage.native_core_relation_not_observed" };
}

/**
 * Pure search-projection proof. Search is verified only when BOTH a
 * `search_documents` row and a `search_fts` row exist for the exact same
 * article_id, with identical FTS rowid. Anything else is unobserved.
 */
export function evaluateSearchProjection(input: {
  documents: { articleId: string; rowid: number | string; state?: string | null } | null;
  fts: { articleId: string; rowid: number | string } | null;
}): {
  documentsObserved: boolean;
  ftsObserved: boolean;
  sameArticle: boolean;
  documentRowid: number | string | null;
  ftsRowid: number | string | null;
  rowidMatch: boolean;
  verified: boolean;
  publicationState: string | null;
} {
  const doc = input.documents;
  const fts = input.fts;
  const documentsObserved = Boolean(doc);
  const ftsObserved = Boolean(fts);
  const sameArticle = Boolean(doc && fts && doc.articleId === fts.articleId);
  const documentRowid = doc?.rowid ?? null;
  const ftsRowid = fts?.rowid ?? null;
  const rowidMatch = Boolean(doc && fts && String(doc.rowid) === String(fts.rowid));
  return {
    documentsObserved,
    ftsObserved,
    sameArticle,
    documentRowid,
    ftsRowid,
    rowidMatch,
    verified: documentsObserved && ftsObserved && sameArticle && rowidMatch,
    publicationState: doc?.state ?? null,
  };
}

/**
 * Distinguishes a legacy pre-existing published case from a publication produced
 * by THIS canary chain. If the chain contains a succeeded publish stage, the
 * publication is staged; otherwise a pre-existing `published` P3 row is reported
 * as `legacy_published_preexisting` and must NOT be attributed to this run.
 */
export function classifyPublication(input: {
  chainHasPublishSucceeded: boolean;
  p3Published: boolean;
}): { classification: "staged_publication" | "legacy_published_preexisting" | "not_published" | "chain_publish_without_p3" } {
  if (input.chainHasPublishSucceeded && input.p3Published) return { classification: "staged_publication" };
  if (input.chainHasPublishSucceeded && !input.p3Published) return { classification: "chain_publish_without_p3" };
  if (!input.chainHasPublishSucceeded && input.p3Published) return { classification: "legacy_published_preexisting" };
  return { classification: "not_published" };
}

/**
 * Pure manual-approval policy evaluation. US opinions must never be published
 * without an explicit manual authorization. `automaticApprovalRows` is the FR/ES
 * automatic ledger and must NEVER be treated as manual consent, so
 * `manualAuthorizationPresent` is always false here.
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

function runRemote(root: string, database: string, name: string, sql: string) {
  assertSelectOnly([{ name, database, sql }]);
  const wrangler = resolve(root, "node_modules/wrangler/bin/wrangler.js");
  const config = resolve(root, "workers/async-pipeline/wrangler.jsonc");
  const result = spawnSync(process.execPath, [wrangler, "d1", "execute", database,
    "--remote", "--yes", "--json", "--config", config, "--command", sql], {
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

/** Fetches a job row by its durable id, or null. */
function jobById(root: string, jobId: string): LinkedJob | null {
  const rows = runRemote(root, "worldcons_ingest", "job_by_id",
    `SELECT id, stage, article_id, source_key, status, result_ref FROM ingest_stage_jobs WHERE id = ${quote(jobId)} LIMIT 1`);
  if (!rows.ok || !rows.rows.length) return null;
  const row = rows.rows[0] as Record<string, unknown>;
  return {
    stage: String(row.stage ?? ""),
    jobId: String(row.id ?? ""),
    articleId: String(row.article_id ?? ""),
    sourceKey: row.source_key == null ? null : String(row.source_key),
    status: String(row.status ?? ""),
    resultRef: row.result_ref == null ? null : String(row.result_ref),
  };
}

function jobByKey(root: string, idempotencyKey: string): LinkedJob | null {
  const rows = runRemote(root, "worldcons_ingest", "job_by_key",
    `SELECT id, stage, article_id, source_key, status, result_ref FROM ingest_stage_jobs WHERE idempotency_key = ${quote(idempotencyKey)} LIMIT 1`);
  if (!rows.ok || !rows.rows.length) return null;
  const row = rows.rows[0] as Record<string, unknown>;
  return {
    stage: String(row.stage ?? ""),
    jobId: String(row.id ?? ""),
    articleId: String(row.article_id ?? ""),
    sourceKey: row.source_key == null ? null : String(row.source_key),
    status: String(row.status ?? ""),
    resultRef: row.result_ref == null ? null : String(row.result_ref),
  };
}

/**
 * Walks the durable chain from the given start job (Crawl for a canary; a real
 * Discovery job id is accepted too, but discovery does not advance to crawl so it
 * contributes only its own stage). Each hop uses the current job's
 * `job_stage_advanced.nextKey` -> the next job's idempotency_key. Returns the
 * ordered linked jobs and any observed native->core resolution events.
 */
function walkChain(root: string, startJobId: string): {
  jobs: LinkedJob[];
  relationEvents: Array<{ fromArticleId?: string; resolvedArticleId?: string }>;
  error: string | null;
} {
  const jobs: LinkedJob[] = [];
  const relationEvents: Array<{ fromArticleId?: string; resolvedArticleId?: string }> = [];
  let currentId: string | null = startJobId;
  const seen = new Set<string>();
  for (let hop = 0; hop < 8 && currentId; hop += 1) {
    if (seen.has(currentId)) break;
    seen.add(currentId);
    const job = jobById(root, currentId);
    if (!job) { if (jobs.length === 0) return { jobs, relationEvents, error: "canary_lineage.start_job_not_found" }; break; }
    jobs.push(job);
    // Collect native->core resolution from this job's advance event (if any).
    const evRows = runRemote(root, "worldcons_ingest", "advance_event_full",
      `SELECT safe_details FROM ingest_stage_job_events WHERE job_id = ${quote(currentId)} AND event_type = 'job_stage_advanced' ORDER BY occurred_at DESC LIMIT 1`);
    if (!evRows.ok || !evRows.rows.length) break;
    const raw = (evRows.rows[0] as { safe_details?: unknown }).safe_details;
    if (typeof raw !== "string") break;
    let parsed: { nextKey?: unknown; fromArticleId?: unknown; resolvedArticleId?: unknown };
    try { parsed = JSON.parse(raw) as typeof parsed; } catch { break; }
    if (typeof parsed.fromArticleId === "string" || typeof parsed.resolvedArticleId === "string") {
      relationEvents.push({
        ...(typeof parsed.fromArticleId === "string" ? { fromArticleId: parsed.fromArticleId } : {}),
        ...(typeof parsed.resolvedArticleId === "string" ? { resolvedArticleId: parsed.resolvedArticleId } : {}),
      });
    }
    if (typeof parsed.nextKey !== "string" || parsed.nextKey.length === 0) break;
    const next = jobByKey(root, parsed.nextKey);
    if (!next) break;
    currentId = next.jobId;
  }
  return { jobs, relationEvents, error: null };
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
  const startJobIdRaw = argumentValue("job");
  const articleId = argumentValue("article")?.trim() || null;
  const sourceKey = argumentValue("source") ?? "us-scotus";
  const root = resolve(fileURLToPath(new URL("../", import.meta.url)));

  let lineage: LinkedLineageResult;
  let relation: ReturnType<typeof evaluateNativeCoreRelation>;
  let coreArticleId: string | null = articleId;
  let chain: LinkedJob[] = [];

  if (startJobIdRaw) {
    const parsed = parseJobId(startJobIdRaw);
    if (!parsed.ok) throw new Error(parsed.error);
    const walked = walkChain(root, parsed.value);
    chain = walked.jobs;
    lineage = evaluateLinkedLineage(chain);
    const crawlJob = chain.find((job) => job.stage === "crawl") ?? chain[0];
    const normalizeJob = chain.find((job) => job.stage === "normalize");
    relation = evaluateNativeCoreRelation({
      crawlArticleId: crawlJob?.articleId ?? null,
      coreArticleId,
      advanceEventArticleIds: walked.relationEvents,
      normalizeArticleId: normalizeJob?.articleId ?? null,
      normalizeResultRef: normalizeJob?.resultRef ?? null,
    });
    if (relation.relation === "resolved") coreArticleId = relation.coreArticleId;
    // A single-case completion requires the same observed Core UUID at every
    // later step, not a coincidental successful stage at the same source.
    if (lineage.coreArticleId !== coreArticleId || relation.relation !== "resolved") {
      lineage = { ...lineage, stagedChainComplete: false, sevenStageComplete: false, nativeCoreRelation: "unresolved" };
    }
  } else if (articleId) {
    // Article-only mode: no linked chain can be walked, so stages are reported
    // from the exact core-UUID rows (never claiming crawl/discovery).
    const rows = runRemote(root, "worldcons_ingest", "stage_lineage_by_article",
      `SELECT id, stage, article_id, source_key, status FROM ingest_stage_jobs WHERE article_id = ${quote(articleId)} ORDER BY stage, created_at DESC LIMIT 50`);
    const jobs = rows.ok ? (rows.rows as Array<Record<string, unknown>>).map((row) => ({
      stage: String(row.stage ?? ""), jobId: String(row.id ?? ""), articleId: String(row.article_id ?? ""),
      sourceKey: row.source_key == null ? null : String(row.source_key), status: String(row.status ?? ""),
    })) : [];
    // Keep the newest per stage for the summary, then evaluate.
    const perStage = new Map<string, LinkedJob>();
    for (const job of jobs) if (!perStage.has(job.stage)) perStage.set(job.stage, job);
    chain = [...perStage.values()];
    lineage = evaluateLinkedLineage(chain);
    relation = { relation: "unresolved", nativeArticleId: null, coreArticleId: articleId, reason: "canary_lineage.article_only_mode_no_chain" };
  } else {
    throw new Error("canary_lineage.requires_job_or_article");
  }

  const coreQuery = coreArticleId
    ? runRemote(root, "worldcons_core", "core_article_and_provenance",
      `SELECT id, source_key, canonical_url, status, review_state, translation_status,
        json_extract(source_metadata,'$.collection.publishable') AS collection_publishable,
        json_extract(source_metadata,'$.collection.sourceUrlVerified') AS collection_source_url_verified,
        json_extract(source_metadata,'$.review.required') AS review_required,
        json_extract(source_metadata,'$.officialPdf.r2Key') AS official_pdf_r2_key,
        json_extract(source_metadata,'$.officialPdf.sha256') AS official_pdf_sha256,
        json_extract(source_metadata,'$.officialPdf.docketVerified') AS official_pdf_docket_verified
        FROM articles WHERE id = ${quote(coreArticleId)} LIMIT 1`)
    : { ok: true as const, rows: [] as unknown[] };
  const coreRow = coreQuery.ok ? (coreQuery.rows[0] as Record<string, unknown> | undefined) : undefined;

  const pubQuery = coreArticleId
    ? runRemote(root, "worldcons_core", "p3_publication",
      `SELECT state, version_id, revision, published_at, created_at FROM article_publications_p3 WHERE article_id = ${quote(coreArticleId)} ORDER BY created_at DESC LIMIT 5`)
    : { ok: true as const, rows: [] as unknown[] };
  const p3Rows = pubQuery.ok ? (pubQuery.rows as Array<Record<string, unknown>>) : [];
  const publishedP3 = p3Rows.some((row) => row.state === "published");

  const approvalQuery = coreArticleId
    ? runRemote(root, "worldcons_core", "automatic_approval_ledger_not_manual",
      `SELECT COUNT(*) AS automatic_approval_rows FROM e2e_approval_evidence_v1 WHERE article_id = ${quote(coreArticleId)} LIMIT 1`)
    : { ok: true as const, rows: [] as unknown[] };
  const automaticApprovalRows = approvalQuery.ok ? Number((approvalQuery.rows as Array<{ automatic_approval_rows: number }>)[0]?.automatic_approval_rows ?? 0) : 0;

  // Search proof: search_documents and search_fts must be the SAME article + rowid.
  const docQuery = coreArticleId
    ? runRemote(root, "worldcons_search", "search_documents",
      `SELECT rowid AS rid, article_id, source_key, publication_state FROM search_documents WHERE article_id = ${quote(coreArticleId)} LIMIT 1`)
    : { ok: true as const, rows: [] as unknown[] };
  const docRow = docQuery.ok ? (docQuery.rows[0] as Record<string, unknown> | undefined) : undefined;
  const ftsRowid = Number(docRow?.rid);
  const ftsQuery = coreArticleId && Number.isSafeInteger(ftsRowid) && ftsRowid > 0
    ? runRemote(root, "worldcons_search", "search_fts",
      `SELECT rowid AS rid, article_id FROM search_fts WHERE rowid = ${ftsRowid} LIMIT 1`)
    : { ok: true as const, rows: [] as unknown[] };
  const ftsRow = ftsQuery.ok ? (ftsQuery.rows[0] as Record<string, unknown> | undefined) : undefined;
  const search = evaluateSearchProjection({
    documents: docRow ? { articleId: String(docRow.article_id), rowid: docRow.rid as number, state: docRow.publication_state == null ? null : String(docRow.publication_state) } : null,
    fts: ftsRow ? { articleId: String(ftsRow.article_id), rowid: ftsRow.rid as number } : null,
  });

  const chainHasPublishSucceeded = lineage.ok && lineage.verifiedStages.includes("publish");
  const publication = classifyPublication({ chainHasPublishSucceeded, p3Published: publishedP3 });

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

  const officialPdfPresent = Boolean(coreRow && coreRow.official_pdf_r2_key && coreRow.official_pdf_sha256);
  const usProvenanceNote = String(coreRow?.source_key ?? sourceKey) === "us-scotus" && !officialPdfPresent
    ? "canary_lineage.us_core_provenance_missing_officialPdf"
    : null;

  // Official-identity honesty gate: a literal seven-stage completion requires the
  // linked discovery's Core article to carry verified official-source identity.
  const officialIdentityVerified = Boolean(
    coreRow && (coreRow.collection_source_url_verified === 1 || coreRow.collection_source_url_verified === true),
  );
  lineage = applyOfficialIdentityGate(lineage, officialIdentityVerified);

  process.stdout.write(`${JSON.stringify({
    mode: "production_read_only",
    generatedAt: new Date().toISOString(),
    note: "Observes the durable linked chain and policy only. NOT a publication authorization; does NOT fabricate 7/7. The automatic FR/ES approval ledger is never treated as US manual consent.",
    target: { startJobId: startJobIdRaw ?? null, articleId, sourceKey },
    ownership: ownership(),
    chain: chain.map((job) => ({ stage: job.stage, jobId: job.jobId, articleId: job.articleId, sourceKey: job.sourceKey, status: job.status })),
    lineage: {
      ok: lineage.ok,
      failureReason: lineage.reason,
      sourceKey: lineage.sourceKey,
      verifiedStages: lineage.verifiedStages,
      missingStages: lineage.missingStages,
      stagedChainComplete: lineage.stagedChainComplete,
      discoveryExecuted: lineage.discoveryExecuted,
      sevenStageComplete: lineage.sevenStageComplete,
      nativeArticleId: lineage.nativeArticleId,
      coreArticleId: lineage.coreArticleId,
      nativeCoreRelation: lineage.nativeCoreRelation,
      officialIdentityVerified,
      keying: "stages verified only when a durable linked ingest_stage_jobs row has status='succeeded'; a literal sevenStageComplete additionally requires the linked chain's Core article to carry verified official-source identity (collection.sourceUrlVerified); no fake discovery",
    },
    identity: relation,
    publication,
    searchProjection: search,
    manualApprovalPolicy: policy,
    manualAuthorizationPresent: false,
    usCoreProvenanceNote: usProvenanceNote,
    queries: { coreRow: coreRow ?? null, p3Rows, automaticApprovalRows },
  }, null, 2)}\n`);
  if (!policy.compliant) process.exitCode = 3;
  if (!lineage.ok && startJobIdRaw) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    console.error(error instanceof Error ? error.message : "canary_lineage.unknown_failure");
    process.exitCode = 1;
  }
}
