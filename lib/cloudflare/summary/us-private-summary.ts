/**
 * WorldCons P2-M4 — owner-controlled **private** single-case US summarization.
 *
 * US SCOTUS opinions are deliberately held at `collection.publishable=false` /
 * `review.required=true` (private review) until an authenticated human reviews
 * the exact source + summary. The general summary eligibility predicate
 * (`canSummarizeArticle`) and the normal candidate selector both require
 * `publishable===true`, so a genuine `metadata_only` US opinion has **no** path
 * to a reviewable `SummarySchema` — it is honestly blocked. This module adds the
 * missing, narrowly-scoped bridge: it produces a real Korean `summary_json` +
 * `korean_title` for ONE named US case **without** ever releasing the private
 * hold, publishing, staging Search, or recording a human approval.
 *
 * This is PRIVATE PROCESSING, not human approval. Every state it writes keeps:
 *   - `source_metadata.collection.publishable === false`
 *   - `source_metadata.review.required === true`
 * and it never touches `article_publications_p3`, `article_cache_outbox_p3`,
 * `e2e_approval_evidence_v1`, the Search projection, or source ownership.
 *
 * Hard, fail-closed preconditions (checked before any provider call):
 *   - exact `us-scotus` source and an exact v4 UUID Core id;
 *   - the persisted row's `source_key` equals `us-scotus` (source mismatch fails);
 *   - status is the private `metadata_only` hold (a repeated call on an
 *     already-privately-summarized row is an idempotent no-op);
 *   - `collection.publishable=false` AND `review.required=true` (an already
 *     released hold is refused — this op must never be the one that opened it);
 *   - cleaned text present and bounded-length;
 *   - verified official PDF provenance on the trusted host with a matching
 *     sha256 + `artifacts/scotus_pdf/<sha>.pdf` R2 key, plus a STRICT one-object
 *     `head`/`get` check on the bound R2 bucket: an absent binding is refused
 *     (`r2_binding_missing`, never treated as valid provenance), the object must
 *     exist, be non-empty, be within the 8 MiB cap, and — when bytes are
 *     readable — carry the `%PDF-` signature and hash to the exact stored sha256;
 *   - no pre-existing P3 publication and no pre-existing human approval receipt.
 *
 * The write is a two-phase CAS: a claim (`status -> summarizing`) then a success
 * write (`status -> summarized`), both guarding id + source + updated_at +
 * content_hash + `publishable=false` + `review.required=true`, so a concurrent
 * mutation or a stale read can never be overwritten. Provider errors roll the
 * claim back to the exact private hold.
 */
import type { ArticleContentType, SummaryJson } from "@/lib/db/types";
import { getRuntimeD1Binding, type D1RuntimeDatabase, type D1RuntimePreparedStatement } from "@/lib/cloudflare/d1/runtime-binding";
import { summarizeArticle } from "@/lib/ai/summarize";
import { SummarySchema } from "@/lib/ai/schema";
import { transitionArticleLifecycleInD1 } from "@/lib/cloudflare/core-write/authority";
import {
  ARTICLE_LIFECYCLE_COLLECTION_ATTENTION_CODES,
  ARTICLE_LIFECYCLE_SUMMARY_ATTENTION_CODES,
} from "@/lib/article-lifecycle/compatibility";
import { isOfficialScotusPdfUrl } from "@/lib/ingest/official-source-verify";
import { US_SOURCE_KEY } from "@/lib/cloudflare/ingest-stages/us-cutover-readiness";

/** The exact private US summarization mode; bounded to one case. */
export const US_PRIVATE_SUMMARY_SOURCE_KEY = US_SOURCE_KEY;

/** Minimum cleaned-text length required before a provider call. */
export const US_PRIVATE_SUMMARY_MIN_TEXT_LENGTH = 500;

/** Maximum accepted official-PDF blob size (8 MiB). */
export const US_PRIVATE_SUMMARY_MAX_PDF_BYTES = 8 * 1024 * 1024;

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const SCOTUS_R2_KEY_PATTERN = /^artifacts\/scotus_pdf\/([0-9a-f]{64})\.pdf$/i;
const KOREAN_TITLE_PATTERN = /[가-힣]/;
const STALE_SUMMARIZING_MINUTES = 30;
/** The 5-byte PDF magic header (`%PDF-`). */
const PDF_SIGNATURE = [0x25, 0x50, 0x44, 0x46, 0x2d] as const;

export interface UsPrivateSummaryRow {
  id: string;
  slug: string;
  source_key: string;
  jurisdiction: string;
  institution_name: string;
  content_type: ArticleContentType;
  original_url: string;
  canonical_url: string;
  original_language: string;
  original_title: string | null;
  original_published_at: string | null;
  cleaned_text: string | null;
  summary_json: string | null;
  korean_title: string | null;
  status: string;
  content_hash: string | null;
  source_metadata: unknown;
  review_state: string | null;
  updated_at: string;
  translation_status: string | null;
}

/** The one-object R2 surface used for the provenance existence/hash check. */
export interface UsPrivateSummaryRawBucket {
  head?(key: string): Promise<{ size: number } | null>;
  get?(key: string): Promise<{ arrayBuffer?(): Promise<ArrayBuffer>; body?: ReadableStream<Uint8Array> | null; size?: number } | null>;
}

export type UsPrivateSummaryStatus = "summarized" | "already_summarized" | "blocked" | "failed";

export interface UsPrivateSummaryResult {
  status: UsPrivateSummaryStatus;
  articleId: string | null;
  reason?: string;
  errorMessage?: string;
  retryable?: boolean;
  provider?: string;
  model?: string | null;
  /** True only when the lifecycle processing/collection axes were synchronized. */
  lifecycleSynced?: boolean;
  /** Always true: this op never publishes or stages Search. */
  publicationUntouched: true;
  searchUntouched: true;
  /** Always true: the private review hold remains `publishable=false`/`required=true`. */
  reviewHoldPreserved: true;
}

const ROW_COLUMNS =
  "id,slug,source_key,jurisdiction,institution_name,content_type,original_url,canonical_url,original_language,original_title,original_published_at,cleaned_text,summary_json,korean_title,status,content_hash,source_metadata,review_state,updated_at,translation_status";

function blocked(articleId: string | null, code: string): UsPrivateSummaryResult {
  return {
    status: "blocked",
    articleId,
    reason: code,
    publicationUntouched: true,
    searchUntouched: true,
    reviewHoldPreserved: true,
  };
}

function ensureSuccess<T>(result: { success?: boolean; error?: string | null; results?: T[] }): T[] {
  if (result.success === false || result.error) throw new Error("us_private_summary.query_failed");
  return result.results ?? [];
}

function changes(result: { meta?: Record<string, unknown> }): number | null {
  const value = result.meta?.changes;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseJson(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Reads `collection.publishable` from either the top-level or the legacy `case` nesting. */
function collectionOf(metadata: Record<string, unknown>): Record<string, unknown> {
  const direct = parseJson(metadata.collection);
  if (Object.keys(direct).length > 0) return direct;
  const nested = parseJson(parseJson(metadata.case).collection);
  return nested;
}

function reviewOf(metadata: Record<string, unknown>): Record<string, unknown> {
  return parseJson(metadata.review);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readRow(core: D1RuntimeDatabase, articleId: string): Promise<UsPrivateSummaryRow | null> {
  const rows = ensureSuccess(await core.prepare(`SELECT ${ROW_COLUMNS} FROM articles WHERE id=? LIMIT 1`).bind(articleId).all<UsPrivateSummaryRow>());
  return rows[0] ?? null;
}

async function hasPublicationRow(core: D1RuntimeDatabase, articleId: string): Promise<boolean> {
  const rows = ensureSuccess(await core.prepare("SELECT article_id FROM article_publications_p3 WHERE article_id=? LIMIT 1").bind(articleId).all<{ article_id: string }>());
  return rows.length > 0;
}

async function hasApprovalReceipt(core: D1RuntimeDatabase, articleId: string): Promise<boolean> {
  const rows = ensureSuccess(await core.prepare("SELECT article_id FROM e2e_approval_evidence_v1 WHERE article_id=? LIMIT 1").bind(articleId).all<{ article_id: string }>());
  return rows.length > 0;
}

function statementRun(statement: D1RuntimePreparedStatement) {
  if (!statement.run) throw new Error("us_private_summary.write_unavailable");
  return statement.run();
}

interface Provenance {
  url: string;
  sha256: string;
  r2Key: string;
}

/**
 * Verifies the stored `officialPdf` provenance: trusted SCOTUS host, verified
 * docket, 64-hex sha256, and a matching `artifacts/scotus_pdf/<sha>.pdf` R2 key.
 * Returns null when the provenance is absent or unverifiable.
 */
function verifyOfficialPdfProvenance(metadata: Record<string, unknown>): Provenance | null {
  const officialPdf = parseJson(metadata.officialPdf);
  if (officialPdf.docketVerified !== true) return null;
  const url = typeof officialPdf.url === "string" ? officialPdf.url.trim() : "";
  const sha256 = typeof officialPdf.sha256 === "string" ? officialPdf.sha256.trim().toLowerCase() : "";
  const r2Key = typeof officialPdf.r2Key === "string" ? officialPdf.r2Key.trim() : "";
  if (!url || !isOfficialScotusPdfUrl(url)) return null;
  if (!SHA256_PATTERN.test(sha256)) return null;
  const keyMatch = SCOTUS_R2_KEY_PATTERN.exec(r2Key);
  if (!keyMatch || keyMatch[1].toLowerCase() !== sha256) return null;
  return { url, sha256, r2Key };
}

/**
 * One-object R2 head/get provenance check against the exact official PDF key.
 *
 * This is STRICT: an absent R2 binding is NOT accepted as valid provenance
 * (`r2_binding_missing`) — Production always binds `WORLDCONS_RAW`, so a missing
 * binding means provenance cannot be proven and the op fails closed. When the
 * binding exposes `head` the object must exist, be non-empty and within the
 * 8 MiB cap; when it exposes `get` the bytes are additionally validated for the
 * `%PDF-` signature and the stored sha256 hash.
 */
async function verifyR2Object(bucket: UsPrivateSummaryRawBucket | undefined, provenance: Provenance): Promise<string | null> {
  if (!bucket || (!bucket.head && !bucket.get)) return "us_private_summary.r2_binding_missing";
  try {
    if (bucket.head) {
      const head = await bucket.head(provenance.r2Key);
      if (!head) return "us_private_summary.r2_object_missing";
      if (!(head.size > 0)) return "us_private_summary.r2_object_empty";
      if (head.size > US_PRIVATE_SUMMARY_MAX_PDF_BYTES) return "us_private_summary.r2_object_too_large";
    }
    if (bucket.get) {
      const object = await bucket.get(provenance.r2Key);
      if (!object) return "us_private_summary.r2_object_missing";
      const bytes = await readR2ObjectBytes(object);
      if (bytes.byteLength === 0) return "us_private_summary.r2_object_empty";
      if (bytes.byteLength > US_PRIVATE_SUMMARY_MAX_PDF_BYTES) return "us_private_summary.r2_object_too_large";
      if (!hasPdfSignature(bytes)) return "us_private_summary.r2_not_pdf";
      const hash = await sha256Hex(bytes);
      if (hash !== provenance.sha256) return "us_private_summary.r2_hash_mismatch";
    }
  } catch {
    return "us_private_summary.r2_read_failed";
  }
  return null;
}

/** True only when the first five bytes are the `%PDF-` magic header. */
function hasPdfSignature(bytes: Uint8Array): boolean {
  if (bytes.byteLength < PDF_SIGNATURE.length) return false;
  for (let index = 0; index < PDF_SIGNATURE.length; index += 1) {
    if (bytes[index] !== PDF_SIGNATURE[index]) return false;
  }
  return true;
}

async function readR2ObjectBytes(object: { arrayBuffer?(): Promise<ArrayBuffer>; body?: ReadableStream<Uint8Array> | null }): Promise<Uint8Array> {
  if (typeof object.arrayBuffer === "function") return new Uint8Array(await object.arrayBuffer());
  if (object.body) {
    const reader = object.body.getReader();
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return merged;
  }
  return new Uint8Array();
}

function isKoreanTitle(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0 && KOREAN_TITLE_PATTERN.test(value);
}

function translationReady(language: string, status: string | null): boolean {
  const normalized = language.trim().toLowerCase();
  if (normalized === "ko") return status === "translated" || status === "not_required";
  return status === "translated";
}

/** The durable private summary already present, if valid and hold-preserved. */
function durablePrivateSummary(row: UsPrivateSummaryRow): SummaryJson | null {
  if (row.status !== "summarized") return null;
  if (typeof row.summary_json !== "string" || !row.summary_json.trim() || row.summary_json === "null") return null;
  if (!isKoreanTitle(row.korean_title)) return null;
  if (!translationReady(row.original_language, row.translation_status)) return null;
  try {
    const parsed = JSON.parse(row.summary_json) as unknown;
    const validated = SummarySchema.safeParse(parsed);
    return validated.success ? (validated.data as SummaryJson) : null;
  } catch {
    return null;
  }
}

interface Claim {
  claimedStatus: "summarizing";
  claimUpdatedAt: string;
  contentHash: string | null;
}

/**
 * Phase 1 CAS: claim the private row for summarization. Guards the exact id +
 * source + status + updated_at + content_hash AND re-asserts the private hold
 * (`publishable=false`, `review.required=true`) in SQL, so a stale/competing
 * writer can never be overwritten.
 */
async function claimUsPrivateSummary(core: D1RuntimeDatabase, row: UsPrivateSummaryRow): Promise<Claim> {
  const claimUpdatedAt = new Date().toISOString();
  let result;
  try {
    result = await statementRun(core.prepare(
      `UPDATE articles
          SET status='summarizing',translation_status='running',translation_started_at=?,translation_attempt_count=translation_attempt_count+1,updated_at=?,error_metadata=NULL,error_class=NULL,error_context=NULL
        WHERE id=? AND source_key=? AND status='metadata_only' AND updated_at=? AND content_hash IS ?
          AND COALESCE(json_extract(source_metadata,'$.collection.publishable'),json_extract(source_metadata,'$.case.collection.publishable'))=0
          AND json_extract(source_metadata,'$.review.required')=1`,
    ).bind(claimUpdatedAt, claimUpdatedAt, row.id, US_SOURCE_KEY, row.updated_at, row.content_hash ?? null));
  } catch {
    throw new Error("us_private_summary.claim_transient");
  }
  if (result.success === false || result.error) throw new Error("us_private_summary.claim_transient");
  if (changes(result) !== 1) throw new Error("us_private_summary.claim_cas_conflict");
  return { claimedStatus: "summarizing", claimUpdatedAt, contentHash: row.content_hash ?? null };
}

/** Phase 2 CAS: persist the summary, keeping the private hold and review state. */
async function persistUsPrivateSummary(
  core: D1RuntimeDatabase,
  row: UsPrivateSummaryRow,
  claim: Claim,
  summary: SummaryJson,
): Promise<{ disposition: "written" | "already_summarized" }> {
  const now = new Date().toISOString();
  const saved = await statementRun(core.prepare(
    `UPDATE articles
        SET status='summarized',
            translation_status=CASE WHEN lower(COALESCE(original_language,''))='ko' THEN 'not_required' ELSE 'translated' END,
            translated_at=?,translation_started_at=NULL,
            translation_error_code=NULL,translation_error_summary=NULL,translation_next_attempt_at=NULL,
            summarized_at=?,summary_json=?,korean_title=?,error_metadata=NULL,error_class=NULL,error_context=NULL,
            review_state='needs_review',updated_at=?
      WHERE id=? AND source_key=? AND status=? AND updated_at=? AND content_hash IS ?
        AND COALESCE(json_extract(source_metadata,'$.collection.publishable'),json_extract(source_metadata,'$.case.collection.publishable'))=0
        AND json_extract(source_metadata,'$.review.required')=1`,
  ).bind(now, now, JSON.stringify(summary), summary.koreanTitle, now, row.id, US_SOURCE_KEY, claim.claimedStatus, claim.claimUpdatedAt, claim.contentHash));
  if (saved.success === false || saved.error) throw new Error("us_private_summary.success_write_transient");
  if (changes(saved) === 1) return { disposition: "written" };
  // A competing/durable summary may already exist; converge idempotently.
  const current = await readRow(core, row.id);
  if (current && durablePrivateSummary(current)) return { disposition: "already_summarized" };
  throw new Error("us_private_summary.success_write_cas_conflict");
}

/** Rolls the claim back to the exact private hold after a provider error. */
async function rollbackUsPrivateSummary(
  core: D1RuntimeDatabase,
  row: UsPrivateSummaryRow,
  claim: Claim,
  input: { errorClass: string; errorContext: Record<string, unknown>; retryable: boolean; originalTranslationStatus: string | null },
): Promise<void> {
  const now = new Date().toISOString();
  await statementRun(core.prepare(
    `UPDATE articles
        SET status='metadata_only',translation_status=?,translation_error_code=?,translation_error_summary=?,
            translation_next_attempt_at=?,error_metadata=?,error_class=?,error_context=?,updated_at=?
      WHERE id=? AND status=? AND updated_at=? AND content_hash IS ?
        AND COALESCE(json_extract(source_metadata,'$.collection.publishable'),json_extract(source_metadata,'$.case.collection.publishable'))=0
        AND json_extract(source_metadata,'$.review.required')=1`,
  ).bind(
    input.originalTranslationStatus ?? "pending",
    input.errorClass,
    input.errorContext.message ?? null,
    input.retryable ? new Date(Date.now() + 15 * 60_000).toISOString() : null,
    JSON.stringify(input.errorContext),
    input.errorClass,
    JSON.stringify(input.errorContext),
    now,
    row.id,
    claim.claimedStatus,
    claim.claimUpdatedAt,
    claim.contentHash,
  ));
}

async function recoverStaleSummarizing(core: D1RuntimeDatabase, articleId: string, now = Date.now()): Promise<boolean> {
  const cutoff = new Date(now - STALE_SUMMARIZING_MINUTES * 60_000).toISOString();
  const saved = await statementRun(core.prepare(
    `UPDATE articles SET status='metadata_only',translation_status='pending',error_class='job.stale_running',updated_at=?
      WHERE id=? AND source_key=? AND status='summarizing' AND updated_at<?
        AND COALESCE(json_extract(source_metadata,'$.collection.publishable'),json_extract(source_metadata,'$.case.collection.publishable'))=0
        AND json_extract(source_metadata,'$.review.required')=1`,
  ).bind(new Date(now).toISOString(), articleId, US_SOURCE_KEY, cutoff));
  return changes(saved) === 1;
}

/** Synchronizes the lifecycle axes so the case becomes human-reviewable, keeping reviewState=needs_review. */
async function synchronizeLifecycle(core: D1RuntimeDatabase, articleId: string): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const read = await core.prepare(
      "SELECT lifecycle_revision,lifecycle_collection_state,lifecycle_processing_state,lifecycle_review_state FROM articles WHERE id=?",
    ).bind(articleId).all<{ lifecycle_revision: string | number | null; lifecycle_collection_state: string | null; lifecycle_processing_state: string | null; lifecycle_review_state: string | null }>();
    const row = ensureSuccess(read)[0];
    if (!row) return false;
    const revision = Number(row.lifecycle_revision ?? 0) || 0;
    if (row.lifecycle_collection_state === "source_text_ready" && row.lifecycle_processing_state === "complete" && row.lifecycle_review_state === "needs_review") {
      return true;
    }
    const result = await transitionArticleLifecycleInD1(core, {
      articleId,
      expectedRevision: revision,
      idempotencyKey: `us-private-summary:legacy.summary.completed:${articleId}:${revision}`,
      actorType: "summary_worker",
      actorId: "us-private-summary",
      source: "summary.generate",
      reasonCode: "legacy.summary.completed",
      collectionState: "source_text_ready",
      processingState: "complete",
      reviewState: "needs_review",
      attention: {
        operation: "clear",
        resolvesCodes: [...ARTICLE_LIFECYCLE_SUMMARY_ATTENTION_CODES, ...ARTICLE_LIFECYCLE_COLLECTION_ATTENTION_CODES],
      },
    });
    if (result.ok) return true;
    if (!result.error.retryable) return false;
  }
  return false;
}

/**
 * Runs the bounded private summarization for exactly ONE US case. It returns a
 * structured result and never throws for a policy/provenance failure — those are
 * `blocked` with a stable code and ZERO writes. A transient storage CAS conflict
 * throws (retryable). A provider failure rolls the claim back and returns
 * `failed`.
 */
export async function runD1PrivateUsSummary(input: {
  articleId: string;
  apiKeys: string[];
  model?: string;
  summarize?: typeof summarizeArticle;
  rawBucket?: UsPrivateSummaryRawBucket;
  now?: string;
}): Promise<UsPrivateSummaryResult> {
  const articleId = (input.articleId ?? "").trim().toLowerCase();
  if (!UUID_V4_PATTERN.test(articleId)) return blocked(null, "us_private_summary.article_id_invalid");

  const db = getRuntimeD1Binding("worldcons_core");
  if (!db) return blocked(articleId, "us_private_summary.core_binding_missing");

  // Recover a genuinely stale `summarizing` claim before evaluating eligibility.
  await recoverStaleSummarizing(db, articleId).catch(() => false);

  const row = await readRow(db, articleId);
  if (!row) return blocked(articleId, "us_private_summary.article_not_found");
  if (row.source_key !== US_SOURCE_KEY) return blocked(articleId, "us_private_summary.source_mismatch");

  const metadata = parseJson(row.source_metadata);
  const collection = collectionOf(metadata);
  const review = reviewOf(metadata);

  // The private hold must still be intact. If it was already released, this op
  // must never be the one that proceeds (fail closed, no provider call).
  if (collection.publishable !== false) return blocked(articleId, "us_private_summary.hold_publishable_not_false");
  if (review.required !== true) return blocked(articleId, "us_private_summary.hold_review_not_required");

  // Idempotence: a genuinely completed private summary is a no-op.
  const existing = durablePrivateSummary(row);
  if (existing) {
    return {
      status: "already_summarized",
      articleId,
      provider: existing.aiMetadata?.provider,
      model: existing.aiMetadata?.model ?? null,
      lifecycleSynced: await synchronizeLifecycle(db, articleId).catch(() => false),
      publicationUntouched: true,
      searchUntouched: true,
      reviewHoldPreserved: true,
    };
  }

  if (row.status !== "metadata_only") return blocked(articleId, "us_private_summary.status_not_private");
  if (row.summary_json && row.summary_json !== "null") return blocked(articleId, "us_private_summary.summary_already_present");
  if (typeof row.cleaned_text !== "string" || row.cleaned_text.trim().length < US_PRIVATE_SUMMARY_MIN_TEXT_LENGTH) {
    return blocked(articleId, "us_private_summary.cleaned_text_missing");
  }

  const provenance = verifyOfficialPdfProvenance(metadata);
  if (!provenance) return blocked(articleId, "us_private_summary.official_pdf_provenance_invalid");
  const r2Problem = await verifyR2Object(input.rawBucket, provenance);
  if (r2Problem) return blocked(articleId, r2Problem);

  if (await hasPublicationRow(db, articleId)) return blocked(articleId, "us_private_summary.publication_preexisting");
  if (await hasApprovalReceipt(db, articleId)) return blocked(articleId, "us_private_summary.human_receipt_preexisting");

  const keys = input.apiKeys.map((key) => key.trim()).filter(Boolean);
  if (keys.length === 0) return blocked(articleId, "us_private_summary.api_key_missing");

  const claim = await claimUsPrivateSummary(db, row);

  const summarize = input.summarize ?? summarizeArticle;
  let summary: SummaryJson;
  try {
    summary = await summarize(
      {
        sourceKey: row.source_key,
        jurisdiction: row.jurisdiction,
        institutionName: row.institution_name,
        contentType: row.content_type,
        originalUrl: row.original_url,
        canonicalUrl: row.canonical_url,
        originalLanguage: row.original_language,
        originalTitle: row.original_title ?? undefined,
        originalPublishedAt: row.original_published_at ?? undefined,
        cleanedText: row.cleaned_text ?? undefined,
        metadata,
      },
      {
        provider: "gemini",
        model: input.model,
        providerApiKeys: { gemini: keys },
        allowProviderFallback: true,
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const retryable = /quota|429|rate.?limit|timeout|temporar|network|unavailable| 5\d\d\b/i.test(message);
    const errorClass = retryable ? "summary.retryable_quota" : "summary.model_error";
    try {
      await rollbackUsPrivateSummary(db, row, claim, {
        errorClass,
        errorContext: { message, retryable, requestedProvider: "gemini", requestedModel: input.model ?? null },
        retryable,
        originalTranslationStatus: row.translation_status,
      });
    } catch {
      // Rollback failure leaves the stale claim; recoverStaleSummarizing heals it.
    }
    return {
      status: "failed",
      articleId,
      errorMessage: message,
      retryable,
      publicationUntouched: true,
      searchUntouched: true,
      reviewHoldPreserved: true,
    };
  }

  const persisted = await persistUsPrivateSummary(db, row, claim, summary);
  const lifecycleSynced = await synchronizeLifecycle(db, articleId).catch(() => false);
  return {
    status: persisted.disposition === "written" ? "summarized" : "already_summarized",
    articleId,
    provider: summary.aiMetadata?.provider ?? "gemini",
    model: summary.aiMetadata?.model ?? input.model ?? null,
    lifecycleSynced,
    publicationUntouched: true,
    searchUntouched: true,
    reviewHoldPreserved: true,
  };
}

/**
 * Resolves the Core D1 binding from the runtime registry, keeping this module
 * testable with a SqliteD1 binding and free of any Worker-entry import.
 */
