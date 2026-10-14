import {captureDiscoverySnapshot,readDiscoverySnapshot} from "../../../lib/cloudflare/ingest-stages/discovery-coverage";
import { AutomaticApprovalBlocked, recordAutomaticApproval } from "../../../lib/cloudflare/e2e/automatic-approval";
import { approvalIdentity, HUMAN_APPROVAL_POLICY, sha256Canonical, type E2EApprovalContext, type E2EGenerationReceipt } from "../../../lib/cloudflare/e2e/contracts";
import { approvalSourceMetadata } from "../../../lib/cloudflare/core-write/authority";
import { evaluateSameCaseManualApprovalReceipt, US_SOURCE_KEY } from "../../../lib/cloudflare/ingest-stages/us-cutover-readiness";
import { publishStagedApproved, finishStagedSearch, type StagedE2EOptions } from "./staged-e2e";
/**
 * Targeted staged-ingestion business handlers (M3).
 *
 * These are *real* per-item handlers, not dummy acks. The priority (per the
 * approved plan) is a safely functional `discovery -> crawl -> normalize` chain
 * that reuses the audited native crawler/persistence path exactly, with every
 * later stage failing closed rather than faking completion:
 *
 * - `discovery`: enumerates one bounded source listing via the official parsers
 *   and fans out one durable `crawl` job per discovered target record. It records
 *   nothing public and never fetches article bodies.
 * - `crawl`: performs a *targeted single-record* fetch of exactly one discovered
 *   candidate from its official URL (never a whole-country crawl), stores the raw
 *   text in R2 under a content-addressed key and hands that key to normalize.
 * - `normalize`: cleans and persists exactly one record through the shared
 *   `persistNativeStageRecord` path (status derivation, publishability gates,
 *   lifecycle, R2 raw snapshot). The staged path can therefore never diverge from
 *   the legacy collection semantics, and can never auto-publish metadata-only or
 *   unverified-origin records.
 * - `publish`: exposes the existing P3 publication service as a per-article
 *   handler so an operator can run publication as a fenced stage job. It is only
 *   wired when a real publication adapter is supplied.
 * - `search`: exposes the existing per-version search projection as a per-article
 *   handler, again only when a real adapter is supplied.
 *
 * `translate` requires a real per-article adapter and verifies persisted results.
 * `public-judgment` checks source/review authority and records opt-in FR/ES
 * approval proof. Protected publish/search use Core CAS, outbox, and the final
 * content/API verifier. An absent adapter remains an explicit terminal block.
 */
import type { D1RuntimeDatabase } from "../../../lib/cloudflare/d1/runtime-binding";
import { registerIngestStageJob } from "../../../lib/cloudflare/ingest-stages/repository";
import {
  CANARY_DISCOVERY_LIMIT,
  canaryDiscoveryCandidateHasOfficialIdentity,
  canaryDiscoveryDefaultRangeDays,
  canaryDiscoveryMaxLinks,
  canaryDiscoveryCandidateRef,
  canaryDiscoveryRequestRef,
  parseCanaryDiscoveryRequest,
  selectCanaryDiscoveryCandidate,
  type CanaryDiscoveryRequest,
  type CanaryDiscoverySourceKey,
} from "../../../lib/cloudflare/ingest-stages/canary-discovery";
import { isOfficialHost } from "../../../lib/ingest/official-source-verify";
import { readArticleLifecycleFromD1, transitionArticleLifecycleInD1 } from "../../../lib/cloudflare/core-write/authority";
import { ARTICLE_LIFECYCLE_SUMMARY_ATTENTION_CODES } from "../../../lib/article-lifecycle/compatibility";
import {
  NATIVE_CRAWLER_SOURCES,
  canonicalNativeArticleUrl,
  normalizeNativeSourceText,
  crawlNativeStageCandidate,
  discoverNativeStageCandidates,
  nativeStageCandidateId,
  nativeStageCrawlArtifactKey,
  parseNativeStageCandidate,
  persistNativeStageRecord,
  type NativeCrawlerBindings,
  type NativeCrawlerSource,
  type NativeStageCandidate,
} from "./native-crawler";
import type {
  IngestStageHandler,
  IngestStageHandlerContext,
  IngestStageHandlerOutcome,
  IngestStageHandlerRegistry,
} from "./ingest-stage-consumer";

/** A minimal read/write R2 surface for the crawl-stage artifact hand-off. */
export interface IngestStageRawBucket {
  put(key: string, value: Uint8Array, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
}

export interface IngestStageDiscoveryRequest {
  sourceKey: NativeCrawlerSource;
  limit?: number;
  rangeDays?: number;
}

export interface IngestStageCrawlArtifact {
  candidate: NativeStageCandidate;
  text: string;
  canonicalUrl: string;
  fetchedAt: string;
}

/**
 * Per-article translation/summary adapter. In the Worker this is backed by
 * `WorldconsOpsService.runSummaryArticle({articleId})`, i.e. the real per-item
 * D1 summarization of the *single* article. It must not be a whole-queue drain.
 */
export interface IngestStageTranslationAdapter {
  summarize(articleId: string): Promise<{ status: "summarized" | "failed" | "skipped" | "unavailable"; retryable?: boolean; errorCode?: string; errorSummary?: string | null }>;
}

/** Per-article publication adapter (backed by the P3 per-article service in the Worker). */
export interface IngestStagePublicationAdapter {
  publish(articleId: string): Promise<{
    published: boolean;
    skippedReason?: "not_found" | "ineligible" | null;
    errorCode?: string;
    errorSummary?: string;
    versionId?: string | null;
    state?: string | null;
    publicationRevision?: number | null;
    idempotent?: boolean;
  }>;
}

/** Per-article search projection adapter (backed by the per-article search sync in the Worker). */
export interface IngestStageSearchAdapter {
  project(articleId: string): Promise<{ projected: boolean; errorCode?: string; errorSummary?: string; documentCount?: number; ftsCount?: number }>;
}

export interface IngestStageHandlerDependencies {
  crawlerBindings: NativeCrawlerBindings;
  rawBucket: IngestStageRawBucket;
  fetch?: typeof fetch;
  browserNavigate?: (input: { url: string; timeoutMs: number; waitUntil: "domcontentloaded"; userAgent: string }) => Promise<{ html: string; finalUrl: string; status: number; headers: Record<string, string> }>;
  translation?: IngestStageTranslationAdapter;
  publication?: IngestStagePublicationAdapter;
  search?: IngestStageSearchAdapter;
  now?: () => string;
  e2e?: StagedE2EOptions;
  /**
   * Explicit operator-canary sources (`de-bverfg`, `us-scotus`). These are NOT
   * staged sources and are never auto-approved/published; they only carry the
   * candidate payload forward across stages so a single-case canary lineage can
   * be observed. Every downstream gate stays fail-closed.
   */
  canarySources?: readonly string[];
}

function isSourceKey(value: unknown): value is NativeCrawlerSource {
  return typeof value === "string" && (NATIVE_CRAWLER_SOURCES as readonly string[]).includes(value);
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer));
  return [...hash].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readJsonArtifact(bucket: IngestStageRawBucket, key: string): Promise<Record<string, unknown> | null> {
  const object = await bucket.get(key);
  if (!object) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(await object.arrayBuffer())) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function classifyCrawlFailure(error: unknown): { status: "retry" | "blocked"; errorCode: string; errorSummary: string } {
  const message = error instanceof Error ? error.message : String(error);
  const summary = message.slice(0, 500);
  if (message === "crawler.robots_disallowed") return { status: "blocked", errorCode: "crawler.robots_disallowed", errorSummary: summary };
  if (message === "crawler.non_official_host" || message === "crawler.redirect_non_official_host") {
    return { status: "blocked", errorCode: message, errorSummary: summary };
  }
  if (/crawler\.http_429\b/.test(message)) return { status: "retry", errorCode: "crawler.http_429", errorSummary: summary };
  if (/crawler\.http_5\d\d\b/.test(message)) return { status: "retry", errorCode: message.slice(0, 120), errorSummary: summary };
  if (/crawler\.http_4\d\d\b/.test(message)) return { status: "retry", errorCode: message.slice(0, 120), errorSummary: summary };
  if (message === "crawler.fetch_timeout" || /timeout|network|temporar/i.test(message)) {
    return { status: "retry", errorCode: "crawler.transient", errorSummary: summary };
  }
  return { status: "retry", errorCode: "crawler.crawl_failed", errorSummary: summary };
}

function discoveryRequestFrom(payload: Record<string, unknown> | null): IngestStageDiscoveryRequest | null {
  if (!payload) return null;
  if (!isSourceKey(payload.sourceKey)) return null;
  const limit = payload.limit === undefined ? undefined : Number(payload.limit);
  const rangeDays = payload.rangeDays === undefined ? undefined : Number(payload.rangeDays);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 20)) return null;
  if (rangeDays !== undefined && (!Number.isInteger(rangeDays) || rangeDays < 1 || rangeDays > 730)) return null;
  return { sourceKey: payload.sourceKey, ...(limit !== undefined ? { limit } : {}), ...(rangeDays !== undefined ? { rangeDays } : {}) };
}

type CoreRow = Record<string, unknown>;

async function readOne(db: D1RuntimeDatabase, sql: string, values: unknown[]): Promise<{ ok: boolean; row: CoreRow | null }> {
  const result = await db.prepare(sql).bind(...values).all<CoreRow>();
  if (result.success === false || result.error) return { ok: false, row: null };
  return { ok: true, row: result.results?.[0] ?? null };
}

async function readAll(db: D1RuntimeDatabase, sql: string, values: unknown[]): Promise<{ ok: boolean; rows: CoreRow[] }> {
  const result = await db.prepare(sql).bind(...values).all<CoreRow>();
  if (result.success === false || result.error) return { ok: false, rows: [] };
  return { ok: true, rows: result.results ?? [] };
}

function parseMetadata(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function collectionOf(metadata: Record<string, unknown>): Record<string, unknown> {
  const direct = metadata.collection;
  if (direct && typeof direct === "object" && !Array.isArray(direct)) return direct as Record<string, unknown>;
  const nested = metadata.case;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    const nestedCollection = (nested as Record<string, unknown>).collection;
    if (nestedCollection && typeof nestedCollection === "object" && !Array.isArray(nestedCollection)) return nestedCollection as Record<string, unknown>;
  }
  return {};
}

/**
 * Only Korean originals legitimately skip translation. Every non-Korean source
 * (de/en/fr/es) must have a real Korean translation, so `not_required` is only
 * accepted for `ko`.
 */
function translationReady(language: unknown, translationStatus: unknown): boolean {
  const status = String(translationStatus ?? "");
  const normalizedLanguage = String(language ?? "").trim().toLowerCase();
  if (normalizedLanguage === "ko") return status === "translated" || status === "not_required";
  return status === "translated";
}

interface DurableEffectCheck {
  ok: boolean;
  code: string;
  summary: string;
  contentHash: string;
  retry: boolean;
}

/**
 * Verifies the *durable* effect of a translate/summary call by re-reading the
 * core row it claims to have written. A successful API response on its own is
 * never sufficient: the article must actually be `summarized`, carry a Korean
 * summary/title, be marked translated (or legitimately not-required), and
 * expose verified authority source provenance.
 */
async function verifyTranslationDurableEffect(coreDb: D1RuntimeDatabase, articleId: string): Promise<DurableEffectCheck> {
  const read = await readOne(coreDb, "SELECT status,translation_status,summary_json,korean_title,source_metadata,content_hash,original_language FROM articles WHERE id=?", [articleId]);
  if (!read.ok) {
    return { ok: false, code: "ingest_stage.translation_read_failed", summary: "Could not re-read the translated article from the core database.", contentHash: "", retry: true };
  }
  const row = read.row;
  if (!row) {
    return { ok: false, code: "ingest_stage.translation_article_missing", summary: "Translate reported success but no core article exists for the id.", contentHash: "", retry: false };
  }
  if (row.status !== "summarized") {
    return { ok: false, code: "ingest_stage.translation_not_durable", summary: `Article status is "${String(row.status)}" not "summarized".`, contentHash: "", retry: true };
  }
  if (typeof row.summary_json !== "string" || row.summary_json.trim().length === 0 || row.summary_json === "null") {
    return { ok: false, code: "ingest_stage.translation_summary_missing", summary: "Summarized article has no persisted summary_json.", contentHash: "", retry: false };
  }
  if (typeof row.korean_title !== "string" || row.korean_title.trim().length === 0) {
    return { ok: false, code: "ingest_stage.translation_korean_title_missing", summary: "Summarized article has no mandatory Korean title.", contentHash: "", retry: false };
  }
  const metadata = parseMetadata(row.source_metadata);
  if (!translationReady(metadata.originalLanguage ?? row.original_language, row.translation_status)) {
    return { ok: false, code: "ingest_stage.translation_status_incomplete", summary: `translation_status="${String(row.translation_status)}" is not ready.`, contentHash: "", retry: true };
  }
  const collection = collectionOf(metadata);
  if (collection.publishable !== true || collection.sourceTextAvailable !== true || collection.sourceUrlVerified !== true || collection.robotsDisallowed === true || collection.strategy === "seed") {
    return { ok: false, code: "ingest_stage.translation_provenance_unverified", summary: "Article does not carry verified authority source provenance.", contentHash: "", retry: false };
  }
  const contentHash = typeof row.content_hash === "string" ? row.content_hash.trim() : "";
  if (!contentHash) {
    return { ok: false, code: "ingest_stage.translation_content_hash_missing", summary: "Article has no immutable source content hash.", contentHash: "", retry: false };
  }
  return { ok: true, code: "", summary: "", contentHash, retry: false };
}

interface TranslationLifecycleSyncResult {
  ok: boolean;
  retry: boolean;
  code: string;
  summary: string;
}

/**
 * Reconciles the lifecycle axis after a durable summary is observed. This is
 * deliberately idempotent and CAS-retried: a service-binding response can fail
 * after the Core article write committed, and the staged job must then converge
 * to the durable Core state instead of dead-lettering valid content.
 */
async function synchronizeTranslationLifecycle(coreDb: D1RuntimeDatabase, articleId: string): Promise<TranslationLifecycleSyncResult> {
  let lastCode = "unavailable";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await readArticleLifecycleFromD1(coreDb, articleId);
    if (!current.ok) {
      lastCode = current.error.code;
      if (current.error.retryable) continue;
      return { ok: false, retry: false, code: `ingest_stage.translation_state_${lastCode}`, summary: current.error.message };
    }
    if (current.data.processingState === "complete" && current.data.collectionState === "source_text_ready") {
      return { ok: true, retry: false, code: "", summary: "" };
    }
    const result = await transitionArticleLifecycleInD1(coreDb, {
      articleId,
      expectedRevision: current.data.revision,
      idempotencyKey: `summary:legacy.summary.completed:${articleId}:${current.data.revision}`,
      actorType: "summary_worker",
      actorId: "ingest-stage-translate-reconcile",
      source: "summary.generate",
      reasonCode: "legacy.summary.completed",
      collectionState: "source_text_ready",
      processingState: "complete",
      ...(current.data.reviewState === null ? { reviewState: "unreviewed" as const } : {}),
      attention: { operation: "clear", resolvesCodes: [...ARTICLE_LIFECYCLE_SUMMARY_ATTENTION_CODES] },
    });
    if (result.ok) return { ok: true, retry: false, code: "", summary: "" };
    lastCode = result.error.code;
    if (!result.error.retryable) {
      return { ok: false, retry: false, code: `ingest_stage.translation_state_${lastCode}`, summary: result.error.message };
    }
  }
  return {
    ok: false,
    retry: true,
    code: "ingest_stage.translation_state_sync_failed",
    summary: `Could not synchronize the durable summary lifecycle after bounded retries (${lastCode}).`,
  };
}

function classifyTranslateCallFailure(message: string): { retry: boolean; code: string } {
  if (/summary_d1\.(?:start|success)_write_not_eligible/i.test(message)) {
    return { retry: false, code: "ingest_stage.translate_summary_write_not_eligible" };
  }
  if (/summary_d1\.(?:start|success)_write_stale/i.test(message)) {
    return { retry: false, code: "ingest_stage.translate_summary_write_stale" };
  }
  if (/summary_d1\.(?:start|success)_write_cas_conflict/i.test(message)) {
    return { retry: true, code: "ingest_stage.translate_summary_write_cas_conflict" };
  }
  if (/summary_d1\.(?:start|success)_write_transient|summary_d1\.(?:query|write)_failed/i.test(message)) {
    return { retry: true, code: "ingest_stage.translate_summary_storage_transient" };
  }
  return {
    retry: /quota|429|rate.?limit|timeout|temporar|network| 5\d\d\b|unavailable|api_key/i.test(message),
    code: "ingest_stage.translate_call_failed",
  };
}

interface PublicJudgmentResult {
  ok: boolean;
  retry: boolean;
  code: string;
  summary: string;
}

/** Review states that must never be auto-published by the staged pipeline. */
const PUBLIC_JUDGMENT_PRIVATE_REVIEW_STATES = new Set(["needs_review", "needs_triage", "closed_private", "rejected", "blocked"]);

interface UsManualApprovalGuardResult {
  ok: boolean;
  retry: boolean;
  code: string;
  summary: string;
}

/**
 * US-only fail-closed manual-approval guard. US opinions (`us-scotus`) must
 * NEVER be published on the strength of a legacy generic flag
 * (`collection.publishable=1`), a pre-existing P3 `published` row, an automatic
 * FR/ES ledger entry, a caller-supplied boolean, or a Workflow/operator id.
 * Only an *immutable, same-case human-review receipt* bound to the exact current
 * snapshot AND the current verified official-PDF proof may open the gate.
 *
 * It re-derives the anchors independently rather than trusting the caller:
 *   - the exact Core article id, its current `source_metadata` snapshot and its
 *     current `cleaned_text`;
 *   - the recomputed approval snapshot hash via the shared `approvalIdentity`
 *     under `HUMAN_APPROVAL_POLICY`;
 *   - the current `officialPdf.docketVerified===true` provenance with sha256 and
 *     r2Key (a legacy published row does not carry this, so it can never pass);
 *   - the immutable ledger rows for this exact article and human policy.
 *
 * Read failures retry; a missing/stale/unauthenticated receipt is a terminal
 * block. It is a no-op for every non-US source (DE / FR / ES untouched).
 */
async function evaluateUsManualApprovalGuard(coreDb: D1RuntimeDatabase, articleId: string, sourceKey: string | null | undefined): Promise<UsManualApprovalGuardResult> {
  if (sourceKey !== US_SOURCE_KEY) return { ok: true, retry: false, code: "", summary: "" };
  const read = await readOne(coreDb, "SELECT * FROM articles WHERE id=?", [articleId]);
  if (!read.ok) return { ok: false, retry: true, code: "ingest_stage.us_manual_approval_read_failed", summary: "Could not read the US article for manual-approval verification." };
  const row = read.row;
  if (!row) return { ok: false, retry: false, code: "ingest_stage.us_manual_approval_article_missing", summary: "No core article exists for the US manual-approval check." };
  const metadata = parseMetadata(row.source_metadata);
  const officialPdf = parseMetadata(metadata.officialPdf);
  const pdfProof = {
    docketVerified: officialPdf.docketVerified === true,
    sha256: typeof officialPdf.sha256 === "string" ? officialPdf.sha256 : null,
    r2Key: typeof officialPdf.r2Key === "string" ? officialPdf.r2Key : null,
    url: typeof officialPdf.url === "string" ? officialPdf.url : null,
  };
  if (!pdfProof.docketVerified || !pdfProof.sha256 || !pdfProof.r2Key) {
    return { ok: false, retry: false, code: "ingest_stage.us_manual_approval_pdf_proof_missing", summary: "US publication requires prior verified official SCOTUS PDF provenance; a legacy published row is not proof." };
  }
  // The receipt is bound to the exact reviewed snapshot; recompute it from the
  // current row so a receipt that predates the current PDF/content fails closed.
  const snapshot = { ...row, source_metadata: approvalSourceMetadata(row.source_metadata, true) };
  const identity = await approvalIdentity(articleId, snapshot, HUMAN_APPROVAL_POLICY);
  const rows = await readAll(coreDb,
    "SELECT article_id, policy_version, evidence_document, approval_snapshot_hash, source_content_hash FROM e2e_approval_evidence_v1 WHERE article_id=? AND policy_version=? ORDER BY created_at DESC LIMIT 5",
    [articleId, HUMAN_APPROVAL_POLICY]);
  if (!rows.ok) return { ok: false, retry: true, code: "ingest_stage.us_manual_approval_receipt_read_failed", summary: "Could not read the US human-approval receipt ledger." };
  const assessment = evaluateSameCaseManualApprovalReceipt(articleId, rows.rows.map((receipt) => ({
    articleId: receipt.article_id == null ? null : String(receipt.article_id),
    policyVersion: receipt.policy_version == null ? null : String(receipt.policy_version),
    evidenceDocument: receipt.evidence_document == null ? null : String(receipt.evidence_document),
    approvalSnapshotHash: receipt.approval_snapshot_hash == null ? null : String(receipt.approval_snapshot_hash),
    sourceContentHash: receipt.source_content_hash == null ? null : String(receipt.source_content_hash),
  })), {
    currentApprovalSnapshotHash: identity.approvalSnapshotHash,
    currentSourceContentHash: identity.sourceContentHash,
    officialPdf: pdfProof,
  });
  if (assessment.authenticated) return { ok: true, retry: false, code: "", summary: "" };
  return {
    ok: false,
    retry: false,
    code: `ingest_stage.us_manual_approval_${assessment.present ? "unauthenticated" : "receipt_required"}`,
    summary: assessment.present
      ? `A US human-approval receipt exists but is not bound to the current snapshot/PDF proof (${assessment.reason}).`
      : "US publication requires an immutable same-case human-review receipt; a legacy published row or automatic flag is not authorization.",
  };
}

/**
 * The fail-closed public gate. It re-derives the real authority anchors rather
 * than trusting an upstream "success":
 *   1. the core article exists, is summarized, has a Korean summary/title;
 *   2. translation is durably complete, or legitimately not required;
 *   3. the collection metadata grants publishable, verified-source, full-text
 *      access (never source_only / metadata_only / robots-blocked / seed);
 *   4. the review state is not a private/terminal block;
 *   5. if a Case Catalog publication exists, the authoritative anchor version's
 *      immutable `source_content_hash` must equal the current enrichment's
 *      `enrichment_source_content_hash` (the exact gate2 predicate) ??otherwise
 *      the anchor is unverified and the record is blocked.
 *
 * Any missing/ambiguous anchor fails closed (blocked), never partial-published.
 */
async function evaluatePublicJudgment(coreDb: D1RuntimeDatabase, articleId: string): Promise<PublicJudgmentResult> {
  const read = await readOne(coreDb, "SELECT status,translation_status,summary_json,korean_title,source_metadata,review_state,original_language FROM articles WHERE id=?", [articleId]);
  if (!read.ok) return { ok: false, retry: true, code: "ingest_stage.public_judgment_read_failed", summary: "Could not read the article from the core database." };
  const row = read.row;
  if (!row) return { ok: false, retry: false, code: "ingest_stage.public_judgment_article_missing", summary: "No core article exists for the judged id." };
  if (row.status !== "summarized") return { ok: false, retry: false, code: "ingest_stage.public_judgment_not_summarized", summary: `Article status is "${String(row.status)}" not "summarized".` };
  if (typeof row.summary_json !== "string" || row.summary_json.trim().length === 0 || row.summary_json === "null") {
    return { ok: false, retry: false, code: "ingest_stage.public_judgment_summary_missing", summary: "Article has no persisted summary_json." };
  }
  if (typeof row.korean_title !== "string" || row.korean_title.trim().length === 0) {
    return { ok: false, retry: false, code: "ingest_stage.public_judgment_korean_title_missing", summary: "Article has no mandatory Korean title." };
  }
  if (!translationReady(row.original_language, row.translation_status)) {
    return { ok: false, retry: false, code: "ingest_stage.public_judgment_translation_incomplete", summary: `translation_status="${String(row.translation_status)}" is not ready.` };
  }
  const metadata = parseMetadata(row.source_metadata);
  const collection = collectionOf(metadata);
  if (collection.publishable !== true || collection.sourceTextAvailable !== true || collection.sourceUrlVerified !== true || collection.robotsDisallowed === true || collection.strategy === "seed") {
    return { ok: false, retry: false, code: "ingest_stage.public_judgment_not_publishable", summary: "Collection metadata does not grant verified, publishable full-text access." };
  }
  const catalog = parseMetadata(metadata.catalog);
  if (catalog.sourceOnly === true || catalog.sourceOnly === 1 || catalog.sourceOnly === "1") {
    return { ok: false, retry: false, code: "ingest_stage.public_judgment_source_only", summary: "Article is marked source-only and must not be published." };
  }
  if (typeof row.review_state === "string" && PUBLIC_JUDGMENT_PRIVATE_REVIEW_STATES.has(row.review_state.trim().toLowerCase())) {
    return { ok: false, retry: false, code: "ingest_stage.public_judgment_review_blocked", summary: `review_state="${row.review_state}" blocks public release.` };
  }

  // Case Catalog authority anchor check (only when a catalog publication head
  // exists). Mirrors `public_article_projection_p3` exactly.
  const catalogRead = await readOne(coreDb, "SELECT state,source_anchor_version_id FROM case_catalog_publications_v1 WHERE article_id=?", [articleId]);
  if (!catalogRead.ok) return { ok: false, retry: true, code: "ingest_stage.public_judgment_catalog_read_failed", summary: "Could not read the Case Catalog publication head." };
  const catalogPublication = catalogRead.row;
  if (catalogPublication && catalogPublication.state === "published") {
    const anchorId = typeof catalogPublication.source_anchor_version_id === "string" ? catalogPublication.source_anchor_version_id : "";
    const anchorRead = await readOne(coreDb, "SELECT source_content_hash FROM article_content_versions_p3 WHERE id=? AND article_id=?", [anchorId, articleId]);
    if (!anchorRead.ok) return { ok: false, retry: true, code: "ingest_stage.public_judgment_anchor_read_failed", summary: "Could not read the authoritative anchor version." };
    const anchorHash = anchorRead.row && typeof anchorRead.row.source_content_hash === "string" ? anchorRead.row.source_content_hash.trim() : "";
    if (!anchorRead.row || !anchorHash) {
      return { ok: false, retry: false, code: "ingest_stage.public_judgment_anchor_missing", summary: "Case Catalog publication has no verifiable anchor source hash." };
    }
    const matchingRead = await readOne(
      coreDb,
      `SELECT v.id
         FROM article_publications_p3 p
         JOIN article_content_versions_p3 v ON v.id=p.version_id AND v.article_id=p.article_id
        WHERE p.article_id=? AND p.state='published'
          AND v.version_role='enrichment_full'
          AND v.source_anchor_version_id=?
          AND v.enrichment_source_content_hash=?
        LIMIT 1`,
      [articleId, anchorId, anchorHash],
    );
    if (!matchingRead.ok) return { ok: false, retry: true, code: "ingest_stage.public_judgment_anchor_read_failed", summary: "Could not verify the enrichment anchor." };
    if (!matchingRead.row) {
      return { ok: false, retry: false, code: "ingest_stage.public_judgment_anchor_unverified", summary: "Published Case Catalog anchor does not match the current enrichment source hash." };
    }
  }
  return { ok: true, retry: false, code: "", summary: "" };
}

/**
 * Builds the handler registry. Only stages backed by a real implementation are
 * present; everything else stays missing so the consumer fails closed.
 */
export function createIngestStageHandlers(deps: IngestStageHandlerDependencies): IngestStageHandlerRegistry {
  // Sources that carry a single-case approval artifact forward across stages.
  // FR/ES staged E2E plus the explicit operator-canary sources. This only
  // preserves the crawl candidate/artifact references; it never grants approval
  // (auto-approval/publish/search stay strictly FR/ES below).
  const carriesApprovalArtifact = (sourceKey: string | null | undefined) =>
    sourceKey != null && (deps.e2e?.sources.includes(sourceKey) === true || deps.canarySources?.includes(sourceKey) === true);

  /**
   * The discover-one canary runner. It performs a GENUINE official discovery for
   * the canary source (`de-bverfg` homepage SSR anchors, or the official
   * `supremecourt.gov` slip-opinion term listing for `us-scotus`) — never a
   * caller-supplied candidate. It selects exactly one candidate, writes its
   * artifact under the explicit canary prefix and returns a single-next-job
   * outcome so the consumer's audited `completeStageAndRegisterNext` registers
   * exactly one child `crawl` job with a durable `job_stage_advanced` provenance
   * edge. Every failure is an explicit terminal block; nothing is fanned out.
   */
  const canaryDiscovery = async (context: IngestStageHandlerContext, request: CanaryDiscoveryRequest): Promise<IngestStageHandlerOutcome> => {
    const maxLinks = canaryDiscoveryMaxLinks(request.sourceKey);
    let observed: NativeStageCandidate[];
    try {
      observed = await discoverNativeStageCandidates(request.sourceKey, deps.crawlerBindings, {
        fetch: deps.fetch,
        now: new Date(context.now),
        // Observe one more link than the bound so a page that advertises an
        // implausibly large decision set is detected and rejected, while the
        // step stays bounded (discoverNativeStageCandidates caps its own limit).
        limit: maxLinks + 1,
        rangeDays: request.rangeDays,
        browserNavigate: deps.browserNavigate,
      });
    } catch (error) {
      return { status: "retry", errorCode: "ingest_stage.discovery_failed", errorSummary: (error instanceof Error ? error.message : String(error)).slice(0, 500) };
    }
    const selection = selectCanaryDiscoveryCandidate(observed, maxLinks);
    if (!selection.candidate) {
      return { status: "blocked", errorCode: selection.reason ?? "canary_discovery.candidate_not_found", errorSummary: `Official ${request.sourceKey} listing yielded ${selection.observed} decision link(s).` };
    }
    const candidate = selection.candidate;
    // The general crawler may fall back to a third-party metadata index when
    // the official listing is empty. A discover-one canary must NEVER count a
    // guessed/third-party index URL as proof of official-source discovery.
    if (candidate.metadata.discoveryIndex !== "official-listing") {
      return { status: "blocked", errorCode: "canary_discovery.official_listing_required", errorSummary: `Discovery was not proven from an official ${request.sourceKey} listing.` };
    }
    if (candidate.sourceKey !== request.sourceKey || !isOfficialHost(request.sourceKey, candidate.url)
      || !canaryDiscoveryCandidateHasOfficialIdentity(request.sourceKey, candidate.url)) {
      return { status: "blocked", errorCode: "canary_discovery.candidate_not_official_identity", errorSummary: `The discovered candidate is not a parseable official ${request.sourceKey} document URL.` };
    }
    const candidateId = await nativeStageCandidateId(candidate.sourceKey, candidate.url);
    const contentHash = await sha256Hex(candidate.url);
    const artifactKey = canaryDiscoveryCandidateRef(request.sourceKey, contentHash);
    await deps.rawBucket.put(artifactKey, new TextEncoder().encode(JSON.stringify(candidate)), { httpMetadata: { contentType: "application/json" } });
    // A single next job (the child crawl) is registered atomically by the
    // consumer's `completeStageAndRegisterNext`, which also writes the durable
    // `job_stage_advanced` edge the lineage audit follows. The child must not
    // register itself, so `registerNext` is left at its default (true) here.
    return {
      status: "succeeded",
      resultRef: `canary-discovery:${request.sourceKey}:${request.canaryDiscovery.canaryId}:1`,
      nextArticleId: candidateId,
      nextSourceVersion: `canary-discovery-v1:${request.canaryDiscovery.canaryId}`,
      nextContentHash: contentHash,
      nextPayloadRef: artifactKey,
    };
  };

  const discovery: IngestStageHandler = async (context) => {
    const payload = context.job.payload_ref ? await readJsonArtifact(deps.rawBucket, context.job.payload_ref) : null;
    // ---- discover-one canary branch -------------------------------------
    // A discover-one discovery-request carries the explicit `canaryDiscovery`
    // marker. It runs a GENUINE official-homepage discovery for Germany only,
    // selects exactly ONE candidate, and hands exactly one child `crawl` job the
    // same `canary-owner:<canaryId>` provenance. It never accepts a caller-
    // supplied candidate URL, so it can neither fabricate nor masquerade the
    // discovery step.
    const canaryRequest = parseCanaryDiscoveryRequest(payload);
    if (canaryRequest.ok) return canaryDiscovery(context, canaryRequest.value);
    if (payload && typeof payload === "object" && !Array.isArray(payload) && "canaryDiscovery" in payload) {
      // A present but invalid canary marker must never silently fall through to
      // the ordinary fan-out path.
      return { status: "blocked", errorCode: "ingest_stage.discovery_canary_request_invalid", errorSummary: canaryRequest.error };
    }
    const request = discoveryRequestFrom(payload);
    if (!request) {
      return { status: "blocked", errorCode: "ingest_stage.discovery_request_invalid", errorSummary: "Discovery job payload_ref must reference a {sourceKey,limit?,rangeDays?} JSON artifact." };
    }
    const protectedSource=deps.e2e?.sources.includes(request.sourceKey)===true;
    const clock=deps.now??(()=>new Date().toISOString());
    const owner={jobId:context.job.id,fencingToken:context.message.fencingToken,now:context.now,clock};
    const capture=async(candidates:NativeStageCandidate[])=>{
      const snapshot=await captureDiscoverySnapshot(context.ingestDb,context.coreDb,deps.rawBucket,owner,
        {sourceKey:request.sourceKey,candidates,recheckLimit:request.limit??1,
          rangeDays:request.sourceKey==="fr-conseil-constitutionnel"?Math.max(14,request.rangeDays??14):Math.min(730,Math.max(180,request.rangeDays??180))});
      return {status:"succeeded" as const,resultRef:"discovery-snapshot:"+snapshot.jobId+":"+snapshot.items.length,registerNext:false};
    };
    // A retry resumes the committed snapshot even if the official page has changed.
    if(protectedSource&&await readDiscoverySnapshot(context.ingestDb,deps.rawBucket,context.job.id))return capture([]);
    let candidates: NativeStageCandidate[];
    try {
      candidates = await discoverNativeStageCandidates(request.sourceKey, deps.crawlerBindings, {
        fetch: deps.fetch,
        now: new Date(context.now),
        limit: request.limit,
        rangeDays: request.rangeDays,
        retainAllObserved: protectedSource,
        browserNavigate: deps.browserNavigate,
      });
    } catch (error) {
      return { status: "retry", errorCode: "ingest_stage.discovery_failed", errorSummary: (error instanceof Error ? error.message : String(error)).slice(0, 500) };
    }
    if(protectedSource)return capture(candidates);
    // Fan out exactly one durable crawl job per discovered target record. The
    // candidate JSON is stored in R2 and referenced by the crawl job's payload.
    let fanned = 0;
    for (const candidate of candidates) {
      const candidateId = await nativeStageCandidateId(candidate.sourceKey, candidate.url);
      const contentHash = await sha256Hex(candidate.url);
      const artifactKey = `stages/ingest-discovery/${candidate.sourceKey}/${contentHash}.json`;
      await deps.rawBucket.put(artifactKey, new TextEncoder().encode(JSON.stringify(candidate)), { httpMetadata: { contentType: "application/json" } });
      await registerIngestStageJob(context.ingestDb, {
        stage: "crawl",
        articleId: candidateId,
        sourceKey: candidate.sourceKey,
        // Repeat the targeted source fetch on a new discovery day. Normalize
        // still dedupes identical source text by its *actual* content hash,
        // so unchanged documents never trigger duplicate downstream work.
        sourceVersion: context.job.source_version,
        contentHash,
        payloadRef: artifactKey,
        now: context.now,
      });
      fanned += 1;
    }
    // The discovery request itself advances to no single next job; it fans out.
    return { status: "succeeded", resultRef: `fanout:${request.sourceKey}:${fanned}`, registerNext: false };
  };

  const crawl: IngestStageHandler = async (context) => {
    if (!context.job.payload_ref) {
      return { status: "blocked", errorCode: "ingest_stage.crawl_payload_missing", errorSummary: "Crawl job has no candidate payload_ref." };
    }
    const payload = await readJsonArtifact(deps.rawBucket, context.job.payload_ref);
    const candidate = parseNativeStageCandidate(payload);
    if (!candidate) {
      return { status: "blocked", errorCode: "ingest_stage.candidate_invalid", errorSummary: "Crawl payload_ref does not hold a valid candidate." };
    }
    let result;
    try {
      result = await crawlNativeStageCandidate(candidate, deps.crawlerBindings, {
        fetch: deps.fetch,
        now: new Date(context.now),
        browserNavigate: deps.browserNavigate,
      });
    } catch (error) {
      const failure = classifyCrawlFailure(error);
      return { status: failure.status, errorCode: failure.errorCode, errorSummary: failure.errorSummary };
    }
    // A transport failure or an unpublished/404 official URL stays a bounded
    // retry candidate; it must never persist an empty record.
    if (!result.fetched && (result.status === 0 || result.status === 404 || result.status >= 400)) {
      return {
        status: "retry",
        errorCode: `crawler.source_unavailable_${result.status || "transport"}`,
        errorSummary: `Official source text unavailable (status ${result.status}); keep the discovery candidate for bounded recheck.`,
      };
    }
    const contentHash = await sha256Hex(result.text);
    const artifact: IngestStageCrawlArtifact = {
      candidate: result.candidate,
      text: result.text,
      canonicalUrl: result.canonicalUrl,
      fetchedAt: context.now,
    };
    // Preserve the exact approval source artifact across timestamp-only recrawls.
    const artifactKey = nativeStageCrawlArtifactKey(candidate.sourceKey,
      carriesApprovalArtifact(candidate.sourceKey) ? await sha256Canonical(artifact) : contentHash);
    await deps.rawBucket.put(artifactKey, new TextEncoder().encode(JSON.stringify(artifact)), { httpMetadata: { contentType: "application/json" } });
    return {
      status: "succeeded",
      resultRef: result.canonicalUrl,
      nextPayloadRef: artifactKey,
      nextSourceVersion: candidate.publishedAt ?? "crawl-v1",
      nextContentHash: contentHash,
    };
  };

  const normalize: IngestStageHandler = async (context) => {
    if (!context.job.payload_ref) {
      return { status: "blocked", errorCode: "ingest_stage.normalize_payload_missing", errorSummary: "Normalize job has no crawl artifact payload_ref." };
    }
    const payload = await readJsonArtifact(deps.rawBucket, context.job.payload_ref);
    const candidate = parseNativeStageCandidate(payload?.candidate);
    if (!payload || !candidate || typeof payload.text !== "string") {
      return { status: "blocked", errorCode: "ingest_stage.crawl_artifact_invalid", errorSummary: "Crawl artifact is missing or malformed." };
    }
    try {
      const persisted = await persistNativeStageRecord(candidate, payload.text, deps.crawlerBindings, {
        runId: `ingest-stage:${context.job.id}`,
        fetchedAt: typeof payload.fetchedAt === "string" ? payload.fetchedAt : context.now,
      });
      // Identity adoption: `persistNativeStageRecord` returns the real
      // `worldcons_core.articles.id` (a UUID) when it created or matched a row.
      // The incoming job's `article_id` is only a `native:` candidate hash, so
      // every downstream stage (translate/public-judgment/publish/search) must
      // address the verified core id instead ??otherwise they would reference a
      // candidate that does not exist in the core DB. When persistence cannot
      // resolve an id (preserved/duplicate edge cases), we fail closed rather
      // than push a `native:` id downstream.
      const coreArticleId = persisted.articleId?.trim();
      if (!coreArticleId) {
        return {
          status: "blocked",
          errorCode: "ingest_stage.normalize_article_id_unresolved",
          errorSummary: `Normalize produced outcome ${persisted.outcome} without a core article id.`,
        };
      }
      return {
        status: "succeeded",
        resultRef: persisted.articleId,
        ...(persisted.outcome === "preserved" ? { registerNext: false } : {}),
        nextArticleId: coreArticleId,
        nextSourceVersion: persisted.contentHash,
        nextContentHash: persisted.contentHash,
        ...(carriesApprovalArtifact(candidate.sourceKey)?{nextPayloadRef:context.job.payload_ref}:{}),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryable = /r2_|artifact_blob|timeout|network|temporar|lifecycle_read|lifecycle_transition|query_failed/i.test(message);
      return {
        status: retryable ? "retry" : "blocked",
        errorCode: retryable ? "ingest_stage.normalize_retry" : "ingest_stage.normalize_failed",
        errorSummary: message.slice(0, 500),
      };
    }
  };

  const translate: IngestStageHandler = async (context) => {
    if (!deps.translation) {
      return { status: "blocked", errorCode: "ingest_stage.translation_adapter_missing", errorSummary: "Translation adapter is not configured." };
    }
    const articleId = context.job.article_id;
    if (articleId.startsWith("native:")) {
      return { status: "blocked", errorCode: "ingest_stage.translate_article_unresolved", errorSummary: "Translate requires the verified core article id (native candidate id is not a core id)." };
    }
    const alreadyDurable = await verifyTranslationDurableEffect(context.coreDb, articleId);
    if (alreadyDurable.ok) {
      const synchronized = await synchronizeTranslationLifecycle(context.coreDb, articleId);
      if (!synchronized.ok) {
        return { status: synchronized.retry ? "retry" : "blocked", errorCode: synchronized.code, errorSummary: synchronized.summary };
      }
      return {
        status: "succeeded",
        resultRef: articleId,
        nextArticleId: articleId,
        nextSourceVersion: alreadyDurable.contentHash,
        nextContentHash: alreadyDurable.contentHash,
        ...(carriesApprovalArtifact(context.job.source_key) ? { nextPayloadRef: context.job.payload_ref } : {}),
      };
    }
    let outcome: Awaited<ReturnType<IngestStageTranslationAdapter["summarize"]>>;
    try {
      outcome = await deps.translation.summarize(articleId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // An RPC/storage response may be lost after the Core write commits. Treat
      // the durable row as authority and finish lifecycle synchronization before
      // classifying the call error.
      const recovered = await verifyTranslationDurableEffect(context.coreDb, articleId);
      if (recovered.ok) {
        const synchronized = await synchronizeTranslationLifecycle(context.coreDb, articleId);
        if (!synchronized.ok) {
          return { status: synchronized.retry ? "retry" : "blocked", errorCode: synchronized.code, errorSummary: synchronized.summary };
        }
        return {
          status: "succeeded",
          resultRef: articleId,
          nextArticleId: articleId,
          nextSourceVersion: recovered.contentHash,
          nextContentHash: recovered.contentHash,
          ...(carriesApprovalArtifact(context.job.source_key) ? { nextPayloadRef: context.job.payload_ref } : {}),
        };
      }
      const classified = classifyTranslateCallFailure(message);
      return { status: classified.retry ? "retry" : "blocked", errorCode: classified.code, errorSummary: message.slice(0, 500) };
    }
    if (outcome.status === "summarized") {
      // Durable-effect proof: only a *verified* translated/summarized row is a
      // success. A successful API response alone is never sufficient.
      const verified = await verifyTranslationDurableEffect(context.coreDb, articleId);
      if (!verified.ok) {
        return { status: "retry", errorCode: verified.code, errorSummary: verified.summary };
      }
      const synchronized = await synchronizeTranslationLifecycle(context.coreDb, articleId);
      if (!synchronized.ok) {
        return { status: synchronized.retry ? "retry" : "blocked", errorCode: synchronized.code, errorSummary: synchronized.summary };
      }
      return {
        status: "succeeded",
        resultRef: articleId,
        nextArticleId: articleId,
        nextSourceVersion: verified.contentHash,
        nextContentHash: verified.contentHash,
        ...(carriesApprovalArtifact(context.job.source_key)?{nextPayloadRef:context.job.payload_ref}:{}),
      };
    }
    if (outcome.status === "skipped" || outcome.status === "unavailable") {
      return {
        status: "blocked",
        errorCode: outcome.errorCode ?? `ingest_stage.translate_${outcome.status}`,
        errorSummary: outcome.errorSummary ?? "Translation service reported the article is not eligible or unavailable.",
      };
    }
    // failed: only a bounded retry keeps the job alive; a terminal failure the
    // service marked non-retryable fails closed.
    return {
      status: outcome.retryable === false ? "blocked" : "retry",
      errorCode: outcome.errorCode ?? "ingest_stage.translate_failed",
      errorSummary: outcome.errorSummary ?? null,
    };
  };

  const publicJudgment: IngestStageHandler = async (context) => {
    const articleId = context.job.article_id;
    if (articleId.startsWith("native:")) {
      return { status: "blocked", errorCode: "ingest_stage.public_judgment_article_unresolved", errorSummary: "Public judgment requires the verified core article id." };
    }
    // US-only fail-closed manual-approval guard, evaluated BEFORE the FR/ES
    // automatic-approval branch so a US job can never reach it. It is a no-op for
    // every non-US source.
    const usGuard = await evaluateUsManualApprovalGuard(context.coreDb, articleId, context.job.source_key);
    if (!usGuard.ok) {
      return usGuard.retry
        ? { status: "retry", errorCode: usGuard.code, errorSummary: usGuard.summary }
        : { status: "blocked", errorCode: usGuard.code, errorSummary: usGuard.summary };
    }
    const gate = await evaluatePublicJudgment(context.coreDb, articleId);
    if (!gate.ok) {
      // A gate that can never open from this state (missing/mismatched anchor,
      // private review, unpermitted text) is a terminal block; a transient read
      // failure retries.
      return gate.retry
        ? { status: "retry", errorCode: gate.code, errorSummary: gate.summary }
        : { status: "blocked", errorCode: gate.code, errorSummary: gate.summary };
    }
    if (deps.e2e?.sources.includes(context.job.source_key??"")) {
      try {
        const artifact=context.job.payload_ref?await readJsonArtifact(deps.rawBucket,context.job.payload_ref):null;
        const candidate=parseNativeStageCandidate(artifact?.candidate);
        if (!artifact||!candidate||candidate.sourceKey!==context.job.source_key||typeof artifact.text!=="string"||typeof artifact.canonicalUrl!=="string") throw new AutomaticApprovalBlocked("e2e.source_artifact_missing");
        const approval=await recordAutomaticApproval(context.coreDb,{articleId,sourceKey:context.job.source_key!,
          candidateId:await nativeStageCandidateId(candidate.sourceKey,candidate.url),pipelineRunId:`ingest-stage:${context.job.id}`,
          sourceArtifactRef:context.job.payload_ref!,sourceArtifactHash:await sha256Canonical(artifact),
          cleanedSourceText:normalizeNativeSourceText(artifact.text),candidateUrl:canonicalNativeArticleUrl(candidate.sourceKey,candidate.url),canonicalUrl:canonicalNativeArticleUrl(candidate.sourceKey,artifact.canonicalUrl),
          candidateTitle:candidate.title,now:context.now});
        const key=`stages/e2e-approval/${articleId}/${await sha256Canonical(approval)}.json`;
        await deps.rawBucket.put(key,new TextEncoder().encode(JSON.stringify({articleId,approval})),{httpMetadata:{contentType:"application/json"}});
        return {status:"succeeded",resultRef:approval.evidenceRef,nextArticleId:articleId,nextPayloadRef:key};
      } catch (error) {
        return {status:error instanceof AutomaticApprovalBlocked?"blocked":"retry",errorCode:error instanceof AutomaticApprovalBlocked?error.message:"e2e.approval_record_unavailable"};
      }
    }
    return { status: "succeeded", resultRef: articleId, nextArticleId: articleId };
  };

  const publish: IngestStageHandler = async (context) => {
    if (deps.e2e?.sources.includes(context.job.source_key??"")) {
      try {
        const payload=context.job.payload_ref?await readJsonArtifact(deps.rawBucket,context.job.payload_ref):null;
        if (payload?.articleId!==context.job.article_id) throw new Error("e2e.staged_approval_missing");
        const result=await publishStagedApproved(context.coreDb,context.job.article_id,payload.approval as E2EApprovalContext);
        const key=`stages/e2e-publication/${result.generation!.generationId}.json`;
        await deps.rawBucket.put(key,new TextEncoder().encode(JSON.stringify({articleId:context.job.article_id,generation:result.generation})),{httpMetadata:{contentType:"application/json"}});
        return {status:"succeeded",resultRef:`generation:${result.generation!.generationId}`,nextPayloadRef:key};
      } catch (error) {return {status:"retry",errorCode:"e2e.staged_publication_failed",errorSummary:error instanceof Error?error.message.slice(0,500):null};}
    }
    // Defense in depth: a US publish job must independently satisfy the
    // manual-approval guard even if it somehow bypassed public-judgment. A native
    // (unresolved) US id is an EXPLICIT terminal block and must never bypass the
    // guard by short-circuiting on the id shape.
    if (context.job.source_key === US_SOURCE_KEY) {
      if (context.job.article_id.startsWith("native:")) {
        return { status: "blocked", errorCode: "ingest_stage.publish_us_article_unresolved", errorSummary: "US publication requires the verified core article id; a native candidate id is not resolved and can never bypass manual approval." };
      }
      const usGuard = await evaluateUsManualApprovalGuard(context.coreDb, context.job.article_id, context.job.source_key);
      if (!usGuard.ok) {
        return usGuard.retry
          ? { status: "retry", errorCode: usGuard.code, errorSummary: usGuard.summary }
          : { status: "blocked", errorCode: usGuard.code, errorSummary: usGuard.summary };
      }
    }
    if (!deps.publication) {
      return { status: "blocked", errorCode: "ingest_stage.publication_adapter_missing", errorSummary: "Publication adapter is not configured." };
    }
    if (context.job.article_id.startsWith("native:")) {
      // A native candidate id is not a core article id; publication requires the
      // normalized article id produced by normalize (resultRef).
      return { status: "blocked", errorCode: "ingest_stage.publish_article_unresolved", errorSummary: "Publication requires a normalized article id." };
    }
    let outcome: Awaited<ReturnType<IngestStagePublicationAdapter["publish"]>>;
    try {
      outcome = await deps.publication.publish(context.job.article_id);
    } catch (error) {
      return { status: "retry", errorCode: "ingest_stage.publish_call_failed", errorSummary: (error instanceof Error ? error.message : String(error)).slice(0, 500) };
    }
    if (outcome.published) return { status: "succeeded", resultRef: context.job.article_id };
    // A publish that reports "not eligible"/"not found" is a terminal, honest
    // block (the upstream public-judgment gate failed or the row drifted); it is
    // never retried into a false success.
    if (outcome.skippedReason) {
      return {
        status: "blocked",
        errorCode: `ingest_stage.publish_${outcome.skippedReason}`,
        errorSummary: outcome.errorSummary ?? `Publication skipped: ${outcome.skippedReason}.`,
      };
    }
    return { status: "retry", errorCode: outcome.errorCode ?? "ingest_stage.publish_failed", errorSummary: outcome.errorSummary ?? null };
  };

  const search: IngestStageHandler = async (context) => {
    if (deps.e2e?.sources.includes(context.job.source_key??"")) {
      try {
        const payload=context.job.payload_ref?await readJsonArtifact(deps.rawBucket,context.job.payload_ref):null;
        if (payload?.articleId!==context.job.article_id||!payload.generation) throw new Error("e2e.staged_generation_missing");
        const result=await finishStagedSearch(context.coreDb,deps.e2e,payload.generation as E2EGenerationReceipt);
        if (result.status==="completed_verified"||result.status==="already_verified") return {status:"succeeded",resultRef:`generation:${(payload.generation as E2EGenerationReceipt).generationId}`};
        return {status:["dead_letter","blocked","superseded","withdrawal_verified"].includes(result.status)?"blocked":"retry",errorCode:`e2e.staged_${result.status}`};
      } catch {return {status:"retry",errorCode:"e2e.staged_search_verification_failed"};}
    }
    // Defense in depth: a US search projection must independently satisfy the
    // manual-approval guard even if it somehow bypassed public-judgment/publish.
    // A native (unresolved) US id is an EXPLICIT terminal block and must never
    // bypass the guard by short-circuiting on the id shape.
    if (context.job.source_key === US_SOURCE_KEY) {
      if (context.job.article_id.startsWith("native:")) {
        return { status: "blocked", errorCode: "ingest_stage.search_us_article_unresolved", errorSummary: "US search projection requires the verified core article id; a native candidate id is not resolved and can never bypass manual approval." };
      }
      const usGuard = await evaluateUsManualApprovalGuard(context.coreDb, context.job.article_id, context.job.source_key);
      if (!usGuard.ok) {
        return usGuard.retry
          ? { status: "retry", errorCode: usGuard.code, errorSummary: usGuard.summary }
          : { status: "blocked", errorCode: usGuard.code, errorSummary: usGuard.summary };
      }
    }
    if (!deps.search) {
      return { status: "blocked", errorCode: "ingest_stage.search_adapter_missing", errorSummary: "Search projection adapter is not configured." };
    }
    let outcome: Awaited<ReturnType<IngestStageSearchAdapter["project"]>>;
    try {
      outcome = await deps.search.project(context.job.article_id);
    } catch (error) {
      return { status: "retry", errorCode: "ingest_stage.search_call_failed", errorSummary: (error instanceof Error ? error.message : String(error)).slice(0, 500) };
    }
    if (outcome.projected) return { status: "succeeded", resultRef: context.job.article_id };
    // The article is not (or is no longer) a published/eligible projection
    // source: a terminal, honest block, never a false "projected" success.
    if (outcome.errorCode === "ingest_stage.search_article_not_eligible") {
      return { status: "blocked", errorCode: outcome.errorCode, errorSummary: outcome.errorSummary ?? "Article is not an eligible published search source." };
    }
    return { status: "retry", errorCode: outcome.errorCode ?? "ingest_stage.search_failed", errorSummary: outcome.errorSummary ?? null };
  };

  const registry: IngestStageHandlerRegistry = {
    discovery,
    crawl,
    normalize,
    ...(deps.translation ? { translate } : {}),
    "public-judgment": publicJudgment,
    ...(deps.publication||deps.e2e ? { publish } : {}),
    ...(deps.search||deps.e2e ? { search } : {}),
  };
  return registry;
}

/**
 * Registers a discovery request as a durable job. External producers (the
 * scheduled dispatcher or an operator CLI) call this to seed the pipeline for
 * one source without doing any network work themselves. The request is stored in
 * R2 and referenced by the job's `payload_ref` so the discovery handler can read
 * it back.
 */
export async function enqueueIngestStageDiscovery(
  ingestDb: D1RuntimeDatabase,
  rawBucket: IngestStageRawBucket,
  input: { sourceKey: NativeCrawlerSource; limit?: number; rangeDays?: number; now: string },
): Promise<{ jobId: string; created: boolean }> {
  const request: IngestStageDiscoveryRequest = {
    sourceKey: input.sourceKey,
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
    ...(input.rangeDays !== undefined ? { rangeDays: input.rangeDays } : {}),
  };
  const requestId = `native-discovery:${input.sourceKey}:${input.limit ?? "default"}:${input.rangeDays ?? "default"}`;
  const contentHash = await sha256Hex(JSON.stringify({ sourceKey: input.sourceKey, limit: input.limit ?? null, rangeDays: input.rangeDays ?? null }));
  const payloadRef = `stages/ingest-discovery-request/${input.sourceKey}/${contentHash}.json`;
  await rawBucket.put(payloadRef, new TextEncoder().encode(JSON.stringify(request)), { httpMetadata: { contentType: "application/json" } });
  // The scheduled discovery request must be idempotent within one day, NOT
  // across the entire lifetime of the service. A constant sourceVersion made
  // the first successful discovery permanently suppress every future daily
  // crawl. Keep the immutable payload artifact shared but version the job by
  // its scheduled UTC day (the bootstrap cron fires once daily).
  const scheduledDay = new Date(input.now).toISOString().slice(0, 10);
  const { job, created } = await registerIngestStageJob(ingestDb, {
    stage: "discovery",
    articleId: requestId,
    sourceKey: input.sourceKey,
    sourceVersion: "discovery-request-v1:" + scheduledDay,
    contentHash,
    payloadRef,
    now: input.now,
  });
  return { jobId: job.id, created };
}

/**
 * Registers a **discover-one** canary discovery job for Germany. Unlike
 * `enqueueIngestStageDiscovery`, the request artifact carries the explicit
 * `canaryDiscovery` marker (so the discovery handler runs the genuine official
 * homepage discovery and yields exactly one child crawl job) and lives under the
 * preserved `stages/canary/` prefix. It performs no network work itself.
 *
 * The job is versioned by `(canaryId, day)`: replaying the same canary on the
 * same day is idempotent, while a distinct canary id (or a new day) is a
 * distinct case. The caller supplies a deterministic `canaryId` (see
 * `canaryDiscoveryId`).
 */
export async function enqueueCanaryDiscovery(
  ingestDb: D1RuntimeDatabase,
  rawBucket: IngestStageRawBucket,
  input: { sourceKey: CanaryDiscoverySourceKey; rangeDays?: number; canaryId: string; operatorId: string; now: string },
): Promise<{ jobId: string; created: boolean; payloadRef: string }> {
  const request: CanaryDiscoveryRequest = {
    sourceKey: input.sourceKey,
    limit: CANARY_DISCOVERY_LIMIT,
    rangeDays: input.rangeDays ?? canaryDiscoveryDefaultRangeDays(input.sourceKey),
    canaryDiscovery: { canaryId: input.canaryId, operatorId: input.operatorId },
  };
  const payloadRef = canaryDiscoveryRequestRef(input.sourceKey, input.canaryId);
  await rawBucket.put(payloadRef, new TextEncoder().encode(JSON.stringify(request)), { httpMetadata: { contentType: "application/json" } });
  const contentHash = await sha256Hex(JSON.stringify({ ...request, limit: CANARY_DISCOVERY_LIMIT }));
  // Unlike the daily bootstrap, discover-one is an explicit single case: the job
  // key is versioned by the canary id only, so replaying the same canary — even
  // across a UTC day boundary — cannot create a second discovery job.
  const { job, created } = await registerIngestStageJob(ingestDb, {
    stage: "discovery",
    articleId: `canary-discovery:${input.sourceKey}:${input.canaryId}`,
    sourceKey: input.sourceKey,
    sourceVersion: `canary-discovery-request-v1:${input.canaryId}`,
    contentHash,
    payloadRef,
    now: input.now,
  });
  return { jobId: job.id, created, payloadRef };
}

/** The stage handlers this module can wire, subject to adapter availability. */
export const INGEST_STAGE_WIRED_STAGES = ["discovery", "crawl", "normalize", "translate", "public-judgment", "publish", "search"] as const;

/** Unused guard so the context type is part of the public surface. */
export type { IngestStageHandlerContext, IngestStageHandlerOutcome };
