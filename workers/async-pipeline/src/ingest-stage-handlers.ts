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
 * `translate` and `public-judgment` intentionally have NO handler here. The
 * consumer treats a missing handler as an explicit terminal block
 * (`ingest_stage.handler_missing`) and, critically, refuses to register a
 * downstream job for a stage with no handler. So a pipeline halts at a real
 * boundary instead of manufacturing work nothing can process.
 */
import type { D1RuntimeDatabase } from "../../../lib/cloudflare/d1/runtime-binding";
import { registerIngestStageJob } from "../../../lib/cloudflare/ingest-stages/repository";
import {
  NATIVE_CRAWLER_SOURCES,
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

interface PublicJudgmentResult {
  ok: boolean;
  retry: boolean;
  code: string;
  summary: string;
}

/** Review states that must never be auto-published by the staged pipeline. */
const PUBLIC_JUDGMENT_PRIVATE_REVIEW_STATES = new Set(["needs_review", "needs_triage", "closed_private", "rejected", "blocked"]);

/**
 * The fail-closed public gate. It re-derives the real authority anchors rather
 * than trusting an upstream "success":
 *
 *   1. the core article exists, is summarized, has a Korean summary/title;
 *   2. translation is durably complete, or legitimately not required;
 *   3. the collection metadata grants publishable, verified-source, full-text
 *      access (never source_only / metadata_only / robots-blocked / seed);
 *   4. the review state is not a private/terminal block;
 *   5. if a Case Catalog publication exists, the authoritative anchor version's
 *      immutable `source_content_hash` must equal the current enrichment's
 *      `enrichment_source_content_hash` (the exact gate2 predicate) — otherwise
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
  const discovery: IngestStageHandler = async (context) => {
    const payload = context.job.payload_ref ? await readJsonArtifact(deps.rawBucket, context.job.payload_ref) : null;
    const request = discoveryRequestFrom(payload);
    if (!request) {
      return { status: "blocked", errorCode: "ingest_stage.discovery_request_invalid", errorSummary: "Discovery job payload_ref must reference a {sourceKey,limit?,rangeDays?} JSON artifact." };
    }
    let candidates: NativeStageCandidate[];
    try {
      candidates = await discoverNativeStageCandidates(request.sourceKey, deps.crawlerBindings, {
        fetch: deps.fetch,
        now: new Date(context.now),
        limit: request.limit,
        rangeDays: request.rangeDays,
        browserNavigate: deps.browserNavigate,
      });
    } catch (error) {
      return { status: "retry", errorCode: "ingest_stage.discovery_failed", errorSummary: (error instanceof Error ? error.message : String(error)).slice(0, 500) };
    }
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
    const artifactKey = nativeStageCrawlArtifactKey(candidate.sourceKey, contentHash);
    const artifact: IngestStageCrawlArtifact = {
      candidate,
      text: result.text,
      canonicalUrl: result.canonicalUrl,
      fetchedAt: context.now,
    };
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
      // address the verified core id instead — otherwise they would reference a
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
        nextArticleId: coreArticleId,
        nextSourceVersion: persisted.contentHash,
        nextContentHash: persisted.contentHash,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryable = /r2_|artifact_blob|timeout|network|temporar|lifecycle_read|query_failed/i.test(message);
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
    let outcome: Awaited<ReturnType<IngestStageTranslationAdapter["summarize"]>>;
    try {
      outcome = await deps.translation.summarize(articleId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryable = /quota|429|rate.?limit|timeout|temporar|network| 5\d\d\b|unavailable|api_key/i.test(message);
      return { status: retryable ? "retry" : "blocked", errorCode: "ingest_stage.translate_call_failed", errorSummary: message.slice(0, 500) };
    }
    if (outcome.status === "summarized") {
      // Durable-effect proof: only a *verified* translated/summarized row is a
      // success. A successful API response alone is never sufficient.
      const verified = await verifyTranslationDurableEffect(context.coreDb, articleId);
      if (!verified.ok) {
        return { status: "retry", errorCode: verified.code, errorSummary: verified.summary };
      }
      return {
        status: "succeeded",
        resultRef: articleId,
        nextArticleId: articleId,
        nextSourceVersion: verified.contentHash,
        nextContentHash: verified.contentHash,
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
    const gate = await evaluatePublicJudgment(context.coreDb, articleId);
    if (!gate.ok) {
      // A gate that can never open from this state (missing/mismatched anchor,
      // private review, unpermitted text) is a terminal block; a transient read
      // failure retries.
      return gate.retry
        ? { status: "retry", errorCode: gate.code, errorSummary: gate.summary }
        : { status: "blocked", errorCode: gate.code, errorSummary: gate.summary };
    }
    return { status: "succeeded", resultRef: articleId, nextArticleId: articleId };
  };

  const publish: IngestStageHandler = async (context) => {
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
    ...(deps.publication ? { publish } : {}),
    ...(deps.search ? { search } : {}),
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

/** The stage handlers this module can wire, subject to adapter availability. */
export const INGEST_STAGE_WIRED_STAGES = ["discovery", "crawl", "normalize", "translate", "public-judgment", "publish", "search"] as const;

/** Unused guard so the context type is part of the public surface. */
export type { IngestStageHandlerContext, IngestStageHandlerOutcome };
