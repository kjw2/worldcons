import { articleLifecycleError } from "@/lib/article-lifecycle/errors";
import type {
  ArticleAttentionState,
  ArticleCollectionState,
  ArticleLifecycleResult,
  ArticleLifecycleReviewState,
  ArticleLifecycleSnapshot,
  ArticleLifecycleTransitionInput,
  ArticleLifecycleTransitionResult,
  ArticleProcessingState,
} from "@/lib/article-lifecycle/types";
import { articlePublicationError } from "@/lib/article-publication/errors";
import type {
  ArticlePublicationResult,
  ArticlePublicationSnapshot,
  ArticlePublicationState,
  ArticlePublicationTransitionInput,
  ArticlePublicationTransitionResult,
} from "@/lib/article-publication/types";
import type {
  D1RuntimeDatabase,
  D1RuntimePreparedStatement,
  D1RuntimeResult,
} from "@/lib/cloudflare/d1/runtime-binding";

export const CORE_WRITE_AUTHORITY_ENV = "WORLDCONS_CORE_WRITE_AUTHORITY";
export const CORE_WRITE_CANARY_MARKER_ENV = "WORLDCONS_CORE_WRITE_CANARY_MARKER";
export const CORE_LIFECYCLE_BOUNDARY_PATH = "/v1/core/lifecycle";
export const CORE_PUBLICATION_BOUNDARY_PATH = "/v1/core/publication";

export type CoreWriteAuthority = "supabase" | "d1-canary" | "d1";

export interface CoreWriteAuthorityConfig {
  authority: CoreWriteAuthority;
}

interface RuntimeCoreWriteGlobal {
  __worldconsCoreWriteAuthorityV1?: CoreWriteAuthorityConfig;
}

function runtimeGlobal() {
  return globalThis as typeof globalThis & RuntimeCoreWriteGlobal;
}

export function resolveCoreWriteAuthorityConfig(
  environment: Record<string, string | undefined> = {},
): CoreWriteAuthorityConfig {
  const raw = environment[CORE_WRITE_AUTHORITY_ENV]?.trim().toLowerCase();
  return raw === "d1" || raw === "d1-canary" ? { authority: raw } : { authority: "supabase" };
}

export function setRuntimeCoreWriteAuthorityConfig(config: CoreWriteAuthorityConfig) {
  runtimeGlobal().__worldconsCoreWriteAuthorityV1 = config;
}

export function getRuntimeCoreWriteAuthorityConfig(
  environment: Record<string, string | undefined> = process.env,
) {
  return runtimeGlobal().__worldconsCoreWriteAuthorityV1 ?? resolveCoreWriteAuthorityConfig(environment);
}

export function resolveCoreWriteCanaryMarker(
  environment: Record<string, string | undefined> = process.env,
) {
  const marker = environment[CORE_WRITE_CANARY_MARKER_ENV]?.trim();
  if (!marker) return false;
  if (marker === "1" || marker.toLowerCase() === "true") return true;
  const runId = environment.GITHUB_RUN_ID?.trim();
  return Boolean(runId && marker === runId);
}

export function shouldUseD1CoreWrite(
  config: CoreWriteAuthorityConfig,
  canary = resolveCoreWriteCanaryMarker(),
) {
  return config.authority === "d1" || (config.authority === "d1-canary" && canary);
}

type Row = Record<string, unknown>;

function asNumber(value: unknown) {
  const n = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function nullableText(value: unknown) {
  return typeof value === "string" ? value : null;
}

function asBool(value: unknown) {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1") return true;
  if (value === 0 || value === "0") return false;
  return null;
}

function ensureSuccess(result: D1RuntimeResult, code: string) {
  if (result.success === false || result.error) throw new Error(code);
  return result;
}

async function one<T extends Row>(
  binding: D1RuntimeDatabase,
  sql: string,
  values: unknown[] = [],
): Promise<T | null> {
  const result = ensureSuccess(await binding.prepare(sql).bind(...values).all<T>(), "core_d1.read_failed");
  return (result.results?.[0] as T | undefined) ?? null;
}

async function many<T extends Row>(
  binding: D1RuntimeDatabase,
  sql: string,
  values: unknown[] = [],
): Promise<T[]> {
  const result = ensureSuccess(await binding.prepare(sql).bind(...values).all<T>(), "core_d1.read_failed");
  return (result.results ?? []) as T[];
}

function changes(result: D1RuntimeResult) {
  ensureSuccess(result, "core_d1.write_failed");
  const raw = result.meta?.changes;
  const n = typeof raw === "number" ? raw : Number(raw ?? 0);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("core_d1.invalid_changes");
  return n;
}

async function run(binding: D1RuntimeDatabase, sql: string, values: unknown[] = []) {
  const statement = binding.prepare(sql).bind(...values);
  if (!statement.run) throw new Error("core_d1.run_unavailable");
  return changes(await statement.run());
}

async function batch(binding: D1RuntimeDatabase, statements: D1RuntimePreparedStatement[]) {
  if (!binding.batch) throw new Error("core_d1.batch_unavailable");
  const results = await binding.batch(statements);
  for (const result of results) ensureSuccess(result, "core_d1.batch_failed");
  return results;
}

function decimalIdentity() {
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  return (BigInt(Date.now()) * 1_000_000n + BigInt(random[0] % 1_000_000)).toString();
}

async function sha256Hex(input: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)));
  return [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function deterministicVersionId(articleId: string, contentHash: string) {
  const hash = await sha256Hex(`${articleId}:${contentHash}`);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function jsonObject(value: unknown) {
  if (typeof value !== "string") return value && typeof value === "object" ? value as Record<string, unknown> : {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function safeSourceMetadata(value: unknown) {
  const source = jsonObject(value);
  const collection = jsonObject(source.collection);
  return {
    ...(source.resolutionType !== undefined ? { resolutionType: source.resolutionType } : {}),
    ...(source.caseNumber !== undefined ? { caseNumber: source.caseNumber } : {}),
    ...(source.boeUsedForFiltering !== undefined ? { boeUsedForFiltering: source.boeUsedForFiltering } : {}),
    ...(source.boePublishedAt !== undefined ? { boePublishedAt: source.boePublishedAt } : {}),
    ...(source.referenceBoe !== undefined ? { referenceBoe: source.referenceBoe } : {}),
    ...(source.boeNumber !== undefined ? { boeNumber: source.boeNumber } : {}),
    ...(source.boeUrl !== undefined ? { boeUrl: source.boeUrl } : {}),
    collection: {
      ...(collection.strategy !== undefined ? { strategy: collection.strategy } : {}),
      ...(collection.confidence !== undefined ? { confidence: collection.confidence } : {}),
      ...(collection.sourceUrlVerified !== undefined ? { sourceUrlVerified: collection.sourceUrlVerified } : {}),
      ...(collection.publishable !== undefined ? { publishable: collection.publishable } : {}),
      ...(collection.sourceTextAvailable !== undefined ? { sourceTextAvailable: collection.sourceTextAvailable } : {}),
      ...(collection.strictSourceTextAvailable !== undefined ? { strictSourceTextAvailable: collection.strictSourceTextAvailable } : {}),
      ...(collection.sourceTextPolicy !== undefined ? { sourceTextPolicy: collection.sourceTextPolicy } : {}),
      ...(collection.robotsDisallowed !== undefined ? { robotsDisallowed: collection.robotsDisallowed } : {}),
    },
  };
}

function safeErrorMetadata(value: unknown, errorClass: unknown) {
  const source = jsonObject(value);
  const result: Record<string, unknown> = {};
  if (typeof errorClass === "string" && /^[a-z][a-z0-9._-]{0,119}$/u.test(errorClass)) result.errorClass = errorClass;
  if (typeof source.retryable === "boolean") result.retryable = source.retryable;
  if (typeof source.requestedProvider === "string" && source.requestedProvider.length <= 80) result.requestedProvider = source.requestedProvider;
  if (typeof source.requestedModel === "string" && source.requestedModel.length <= 200) result.requestedModel = source.requestedModel;
  return result;
}

function lifecycleSnapshot(row: Row): ArticleLifecycleSnapshot {
  return {
    articleId: String(row.article_id ?? row.id ?? ""),
    revision: asNumber(row.lifecycle_revision ?? row.revision),
    collectionState: nullableText(row.lifecycle_collection_state ?? row.collection_state) as ArticleCollectionState | null,
    processingState: nullableText(row.lifecycle_processing_state ?? row.processing_state) as ArticleProcessingState | null,
    reviewState: nullableText(row.lifecycle_review_state ?? row.review_state) as ArticleLifecycleReviewState | null,
    attentionState: nullableText(row.lifecycle_attention_state ?? row.attention_state) as ArticleAttentionState | null,
    attentionCode: nullableText(row.lifecycle_attention_code ?? row.attention_code),
    attentionRetryable: asBool(row.lifecycle_attention_retryable ?? row.attention_retryable),
    attentionSeverity: nullableText(row.lifecycle_attention_severity ?? row.attention_severity) as ArticleLifecycleSnapshot["attentionSeverity"],
    attentionSource: nullableText(row.lifecycle_attention_source ?? row.attention_source) as ArticleLifecycleSnapshot["attentionSource"],
  };
}

function axisAllowed(axis: "collection" | "processing" | "review", from: string | null, to: string, source: string) {
  if (!from || from === to || source === "backfill.reconcile") return true;
  if (axis === "collection") {
    if (from === "discovered") return ["metadata_only", "source_fetched", "source_text_ready"].includes(to);
    if (from === "metadata_only") return ["source_fetched", "source_text_ready"].includes(to);
    if (from === "source_fetched") return ["metadata_only", "source_text_ready"].includes(to);
    if (from === "source_text_ready") return to === "metadata_only" && source === "ingestion.refresh";
  }
  if (axis === "processing") {
    if (from === "not_ready") return ["ready", "complete"].includes(to);
    if (from === "ready") return ["not_ready", "running", "complete"].includes(to);
    if (from === "running") return ["ready", "complete"].includes(to);
    if (from === "complete") return (to === "ready" && ["ingestion.refresh", "summary.resummary"].includes(source))
      || (to === "running" && source === "summary.resummary");
  }
  if (axis === "review") {
    if (from === "unreviewed") return ["needs_review", "approved_for_processing", "approved", "closed_private"].includes(to);
    if (from === "needs_review") return ["approved_for_processing", "approved", "closed_private"].includes(to);
    if (from === "approved_for_processing") return ["needs_review", "approved", "closed_private"].includes(to);
    if (from === "approved") return ["needs_review", "closed_private"].includes(to);
    if (from === "closed_private") return ["needs_review", "approved_for_processing", "approved"].includes(to);
  }
  return false;
}

export async function readArticleLifecycleFromD1(
  binding: D1RuntimeDatabase,
  articleId: string,
): Promise<ArticleLifecycleResult<ArticleLifecycleSnapshot>> {
  try {
    const row = await one<Row>(
      binding,
      "SELECT id,lifecycle_revision,lifecycle_collection_state,lifecycle_processing_state,lifecycle_review_state,lifecycle_attention_state,lifecycle_attention_code,lifecycle_attention_retryable,lifecycle_attention_severity,lifecycle_attention_source FROM articles WHERE id = ?",
      [articleId],
    );
    return row
      ? { ok: true, data: lifecycleSnapshot(row) }
      : { ok: false, error: articleLifecycleError("not_found") };
  } catch {
    return { ok: false, error: articleLifecycleError("unavailable") };
  }
}

export async function transitionArticleLifecycleInD1(
  binding: D1RuntimeDatabase,
  input: ArticleLifecycleTransitionInput,
): Promise<ArticleLifecycleResult<ArticleLifecycleTransitionResult>> {
  try {
    const existing = await one<Row>(
      binding,
      "SELECT article_id,to_revision,collection_state,processing_state,review_state,attention_state,attention_code,attention_retryable,attention_severity,attention_source FROM article_lifecycle_events_p2 WHERE article_id = ? AND idempotency_key = ?",
      [input.articleId, input.idempotencyKey],
    );
    if (existing) {
      return { ok: true, data: { ...lifecycleSnapshot(existing), revision: asNumber(existing.to_revision), applied: false, idempotent: true } };
    }
    const article = await one<Row>(binding, "SELECT * FROM articles WHERE id = ?", [input.articleId]);
    if (!article) return { ok: false, error: articleLifecycleError("not_found") };
    const current = lifecycleSnapshot(article);
    if (current.revision !== input.expectedRevision) return { ok: false, error: articleLifecycleError("stale_revision") };

    const collectionState = input.collectionState ?? current.collectionState;
    const processingState = input.processingState ?? current.processingState;
    const reviewState = input.reviewState ?? current.reviewState;
    let attentionState = current.attentionState;
    let attentionCode = current.attentionCode;
    let attentionRetryable = current.attentionRetryable;
    let attentionSeverity = current.attentionSeverity;
    let attentionSource = current.attentionSource;
    const attention = input.attention ?? { operation: "keep" as const };
    const now = new Date().toISOString();
    let attentionRaisedAt = nullableText(article.lifecycle_attention_raised_at);
    let attentionClearedAt = nullableText(article.lifecycle_attention_cleared_at);
    if (attention.operation === "raise" || attention.operation === "quarantine") {
      attentionState = attention.operation === "quarantine" ? "anomaly" : "active";
      attentionCode = attention.code;
      attentionRetryable = attention.retryable;
      attentionSeverity = attention.severity;
      attentionSource = attention.source;
      attentionRaisedAt = now;
      attentionClearedAt = null;
    } else if (
      attention.operation === "clear"
      && (current.attentionState === "active" || current.attentionState === "anomaly")
      && current.attentionCode
      && attention.resolvesCodes.includes(current.attentionCode)
    ) {
      attentionState = "clear";
      attentionCode = null;
      attentionRetryable = null;
      attentionSeverity = null;
      attentionSource = null;
      attentionClearedAt = now;
    }
    if (!attentionState && collectionState && processingState && reviewState) attentionState = "clear";
    if (attentionState !== "anomaly") {
      if (!collectionState || !processingState || !reviewState) return { ok: false, error: articleLifecycleError("illegal_transition") };
      if (!axisAllowed("collection", current.collectionState, collectionState, input.source)
        || !axisAllowed("processing", current.processingState, processingState, input.source)
        || !axisAllowed("review", current.reviewState, reviewState, input.source)) {
        return { ok: false, error: articleLifecycleError("illegal_transition") };
      }
      if (processingState !== "not_ready" && collectionState !== "source_text_ready") {
        return { ok: false, error: articleLifecycleError("illegal_transition") };
      }
      if (["approved_for_processing", "approved"].includes(reviewState) && collectionState !== "source_text_ready") {
        return { ok: false, error: articleLifecycleError("illegal_transition") };
      }
    }
    const applied = JSON.stringify([
      collectionState, processingState, reviewState, attentionState, attentionCode,
      attentionRetryable, attentionSeverity, attentionSource,
    ]) !== JSON.stringify([
      current.collectionState, current.processingState, current.reviewState, current.attentionState,
      current.attentionCode, current.attentionRetryable, current.attentionSeverity, current.attentionSource,
    ]);
    const revision = current.revision + (applied ? 1 : 0);
    const statements: D1RuntimePreparedStatement[] = [];
    if (applied) {
      statements.push(binding.prepare(
        "UPDATE articles SET lifecycle_collection_state=?,lifecycle_processing_state=?,lifecycle_review_state=?,lifecycle_attention_state=?,lifecycle_attention_code=?,lifecycle_attention_retryable=?,lifecycle_attention_severity=?,lifecycle_attention_source=?,lifecycle_attention_raised_at=?,lifecycle_attention_cleared_at=?,lifecycle_revision=?,lifecycle_changed_at=?,lifecycle_collection_changed_at=CASE WHEN lifecycle_collection_state IS NOT ? THEN ? ELSE lifecycle_collection_changed_at END,lifecycle_processing_changed_at=CASE WHEN lifecycle_processing_state IS NOT ? THEN ? ELSE lifecycle_processing_changed_at END,lifecycle_review_changed_at=CASE WHEN lifecycle_review_state IS NOT ? THEN ? ELSE lifecycle_review_changed_at END,lifecycle_attention_changed_at=CASE WHEN lifecycle_attention_state IS NOT ? OR lifecycle_attention_code IS NOT ? THEN ? ELSE lifecycle_attention_changed_at END WHERE id=? AND lifecycle_revision=?",
      ).bind(
        collectionState, processingState, reviewState, attentionState, attentionCode,
        attentionRetryable, attentionSeverity, attentionSource, attentionRaisedAt, attentionClearedAt,
        revision, now, collectionState, now, processingState, now, reviewState, now,
        attentionState, attentionCode, now, input.articleId, String(current.revision),
      ));
    }
    const eventValues = [
      decimalIdentity(), input.articleId, input.idempotencyKey, String(current.revision), String(revision),
      input.actorType, input.actorId ?? null, input.source, input.reasonCode, applied,
      collectionState, processingState, reviewState, attentionState, attentionCode,
      attentionRetryable, attentionSeverity, attentionSource, now,
    ];
    statements.push(applied
      ? binding.prepare(
          "INSERT INTO article_lifecycle_events_p2 (id,article_id,idempotency_key,from_revision,to_revision,actor_type,actor_id,transition_source,reason_code,applied,collection_state,processing_state,review_state,attention_state,attention_code,attention_retryable,attention_severity,attention_source,occurred_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM articles WHERE id=? AND lifecycle_revision=?)",
        ).bind(...eventValues, input.articleId, String(revision))
      : binding.prepare(
          "INSERT INTO article_lifecycle_events_p2 (id,article_id,idempotency_key,from_revision,to_revision,actor_type,actor_id,transition_source,reason_code,applied,collection_state,processing_state,review_state,attention_state,attention_code,attention_retryable,attention_severity,attention_source,occurred_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        ).bind(...eventValues));
    const results = await batch(binding, statements);
    if (applied && (changes(results[0]) !== 1 || changes(results[1]) !== 1)) {
      return { ok: false, error: articleLifecycleError("stale_revision") };
    }
    return {
      ok: true,
      data: {
        articleId: input.articleId,
        revision,
        collectionState,
        processingState,
        reviewState,
        attentionState,
        attentionCode,
        attentionRetryable,
        attentionSeverity,
        attentionSource,
        applied,
        idempotent: false,
      },
    };
  } catch {
    return { ok: false, error: articleLifecycleError("unavailable") };
  }
}

function publicationSnapshot(row: Row): ArticlePublicationSnapshot {
  return {
    articleId: String(row.article_id ?? ""),
    versionRevision: asNumber(row.version_revision),
    publicationRevision: asNumber(row.publication_revision),
    publicationState: nullableText(row.publication_state) as ArticlePublicationState | null,
    legacyUpdatedAt: String(row.legacy_updated_at ?? ""),
  };
}

function publicationTransitionAllowed(
  from: ArticlePublicationState | null,
  to: ArticlePublicationState,
  actorType: string,
  versionChanged: boolean,
) {
  if (!from) return ["draft", "in_review"].includes(to) || (to === "published" && ["compatibility", "backfill"].includes(actorType));
  if (from === to) return versionChanged;
  if (from === "draft") return to === "in_review" || (to === "published" && ["compatibility", "backfill"].includes(actorType));
  if (from === "in_review") return ["draft", "published", "withdrawn"].includes(to);
  if (from === "published") return to === "withdrawn";
  if (from === "withdrawn") return to === "in_review" || (to === "published" && ["human", "compatibility", "backfill"].includes(actorType));
  return false;
}

function publicationEligible(article: Row, version: Row) {
  const metadata = jsonObject(version.source_metadata);
  const collection = jsonObject(metadata.collection);
  return article.lifecycle_collection_state === "source_text_ready"
    && article.lifecycle_processing_state === "complete"
    && ["unreviewed", "approved"].includes(String(article.lifecycle_review_state ?? ""))
    && article.lifecycle_attention_state === "clear"
    && String(version.slug ?? "").trim().length > 0
    && String(version.source_key ?? "").trim().length > 0
    && String(version.jurisdiction ?? "").trim().length > 0
    && String(version.institution_name ?? "").trim().length > 0
    && String(version.original_url ?? "").trim().length > 0
    && String(version.canonical_url ?? "").trim().length > 0
    && String(version.original_language ?? "").trim().length > 0
    && String(version.korean_title ?? version.original_title ?? "").trim().length > 0
    && Boolean(version.summary_json)
    && String(version.cleaned_text ?? "").trim().length >= 500
    && collection.publishable === true
    && collection.sourceTextAvailable === true
    && collection.sourceUrlVerified === true
    && collection.robotsDisallowed !== true
    && collection.strategy !== "seed";
}

export async function readArticlePublicationSnapshotFromD1(
  binding: D1RuntimeDatabase,
  articleId: string,
): Promise<ArticlePublicationResult<ArticlePublicationSnapshot>> {
  try {
    const row = await one<Row>(
      binding,
      "SELECT a.id AS article_id,a.updated_at AS legacy_updated_at,COALESCE(h.current_revision,0) AS version_revision,COALESCE(p.revision,0) AS publication_revision,p.state AS publication_state FROM articles a LEFT JOIN article_version_heads_p3 h ON h.article_id=a.id LEFT JOIN article_publications_p3 p ON p.article_id=a.id WHERE a.id=?",
      [articleId],
    );
    return row ? { ok: true, data: publicationSnapshot(row) } : { ok: false, error: articlePublicationError("not_found") };
  } catch {
    return { ok: false, error: articlePublicationError("unavailable") };
  }
}

async function auditStatements(
  binding: D1RuntimeDatabase,
  articleId: string,
  events: Array<{
    eventType: string;
    versionId: string | null;
    publicationId: string | null;
    publicationRevision: number | null;
    actorType: string;
    actorId: string | null;
    reason: string;
    requestId: string | null;
    correlationId: string | null;
    metadata: Record<string, unknown>;
    occurredAt: string;
  }>,
) {
  const previous = await one<Row>(
    binding,
    "SELECT ledger_revision,entry_hash FROM article_audit_ledger_p3 WHERE article_id=? ORDER BY CAST(ledger_revision AS INTEGER) DESC LIMIT 1",
    [articleId],
  );
  let revision = asNumber(previous?.ledger_revision);
  let previousHash = nullableText(previous?.entry_hash);
  const statements: D1RuntimePreparedStatement[] = [];
  for (const event of events) {
    revision += 1;
    const metadata = JSON.stringify(event.metadata);
    const entryHash = await sha256Hex([
      articleId, String(revision), event.eventType, event.versionId ?? "", event.publicationId ?? "",
      event.publicationRevision === null ? "" : String(event.publicationRevision), event.actorType,
      event.actorId ?? "", event.reason, event.requestId ?? "", event.correlationId ?? "",
      metadata, previousHash ?? "", event.occurredAt,
    ].join("|"));
    statements.push(binding.prepare(
      "INSERT INTO article_audit_ledger_p3 (id,article_id,ledger_revision,event_type,article_version_id,publication_id,publication_revision,actor_type,actor_id,reason,request_id,correlation_id,safe_metadata,previous_entry_hash,entry_hash,occurred_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).bind(
      decimalIdentity(), articleId, String(revision), event.eventType, event.versionId,
      event.publicationId, event.publicationRevision === null ? null : String(event.publicationRevision),
      event.actorType, event.actorId, event.reason, event.requestId, event.correlationId,
      metadata, previousHash, entryHash, event.occurredAt,
    ));
    previousHash = entryHash;
  }
  return statements;
}

export async function transitionArticlePublicationInD1(
  binding: D1RuntimeDatabase,
  input: ArticlePublicationTransitionInput,
): Promise<ArticlePublicationResult<ArticlePublicationTransitionResult>> {
  try {
    const previousRequest = await one<Row>(
      binding,
      "SELECT article_id,publication_id,publication_revision,version_id,version_revision,state,version_created,publication_applied FROM article_publication_requests_p3 WHERE article_id=? AND idempotency_key=?",
      [input.articleId, input.idempotencyKey],
    );
    if (previousRequest) {
      return {
        ok: true,
        data: {
          articleId: String(previousRequest.article_id),
          versionId: String(previousRequest.version_id),
          versionRevision: asNumber(previousRequest.version_revision),
          publicationId: String(previousRequest.publication_id),
          publicationRevision: asNumber(previousRequest.publication_revision),
          publicationState: String(previousRequest.state) as ArticlePublicationState,
          versionCreated: asBool(previousRequest.version_created) === true,
          publicationApplied: asBool(previousRequest.publication_applied) === true,
          idempotent: true,
        },
      };
    }
    const article = await one<Row>(binding, "SELECT * FROM articles WHERE id=?", [input.articleId]);
    if (!article) return { ok: false, error: articlePublicationError("not_found") };
    if (input.expectedLegacyUpdatedAt && String(article.updated_at ?? "") !== input.expectedLegacyUpdatedAt) {
      return { ok: false, error: articlePublicationError("stale_revision") };
    }
    const head = await one<Row>(binding, "SELECT * FROM article_version_heads_p3 WHERE article_id=?", [input.articleId]);
    const currentVersionRevision = asNumber(head?.current_revision);
    if (currentVersionRevision !== input.expectedVersionRevision) {
      return { ok: false, error: articlePublicationError("stale_revision") };
    }
    let version: Row | null = null;
    let versionCreated = false;
    let versionId = input.versionId ?? null;
    let versionRevision = currentVersionRevision;
    let versionInsert: D1RuntimePreparedStatement | null = null;
    let headUpsert: D1RuntimePreparedStatement | null = null;
    const now = new Date().toISOString();
    if (input.captureLegacy === true) {
      const sourceMetadata = safeSourceMetadata(article.source_metadata);
      const errorMetadata = safeErrorMetadata(article.error_metadata, article.error_class);
      const versionDocument = {
        slug: article.slug,
        sourceKey: article.source_key,
        jurisdiction: article.jurisdiction,
        institutionName: article.institution_name,
        contentType: article.content_type,
        originalUrl: article.original_url,
        canonicalUrl: article.canonical_url,
        originalLanguage: article.original_language,
        originalTitle: article.original_title,
        koreanTitle: article.korean_title,
        originalPublishedAt: article.original_published_at,
        discoveredAt: article.discovered_at,
        fetchedAt: article.fetched_at,
        summarizedAt: article.summarized_at,
        rawText: article.raw_text,
        cleanedText: article.cleaned_text,
        summaryJson: jsonObject(article.summary_json),
        sourceMetadata,
        errorMetadata,
      };
      const contentHash = await sha256Hex(JSON.stringify(versionDocument));
      version = await one<Row>(
        binding,
        "SELECT * FROM article_content_versions_p3 WHERE article_id=? AND content_hash=?",
        [input.articleId, contentHash],
      );
      if (!version) {
        versionRevision = currentVersionRevision + 1;
        versionId = await deterministicVersionId(input.articleId, contentHash);
        version = {
          id: versionId,
          article_id: input.articleId,
          revision: String(versionRevision),
          content_hash: contentHash,
          slug: article.slug,
          source_key: article.source_key,
          jurisdiction: article.jurisdiction,
          institution_name: article.institution_name,
          content_type: article.content_type,
          original_url: article.original_url,
          canonical_url: article.canonical_url,
          original_language: article.original_language,
          original_title: article.original_title,
          korean_title: article.korean_title,
          original_published_at: article.original_published_at,
          discovered_at: article.discovered_at,
          fetched_at: article.fetched_at,
          summarized_at: article.summarized_at,
          raw_text: article.raw_text,
          cleaned_text: article.cleaned_text,
          summary_json: JSON.stringify(versionDocument.summaryJson),
          source_metadata: JSON.stringify(sourceMetadata),
          error_metadata: JSON.stringify(errorMetadata),
        };
        versionInsert = binding.prepare(
          "INSERT INTO article_content_versions_p3 (id,article_id,revision,parent_version_id,content_hash,provenance_actor_type,provenance_actor_id,model_ref,prompt_ref,slug,source_key,jurisdiction,institution_name,content_type,original_url,canonical_url,original_language,original_title,korean_title,original_published_at,discovered_at,fetched_at,summarized_at,raw_text,cleaned_text,summary_json,source_metadata,error_metadata,created_at,case_key,version_document_schema,raw_text_storage_ref,raw_text_blob_hash,raw_text_blob_size,raw_text_externalized_at,raw_text_blob_contract_version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        ).bind(
          versionId, input.articleId, String(versionRevision), head?.current_version_id ?? null, contentHash,
          input.provenanceActorType ?? "human", input.provenanceActorId ?? null, input.modelRef ?? null,
          input.promptRef ?? null, article.slug, article.source_key, article.jurisdiction,
          article.institution_name, article.content_type, article.original_url, article.canonical_url,
          article.original_language, article.original_title ?? null, article.korean_title ?? null,
          article.original_published_at ?? null, article.discovered_at ?? null, article.fetched_at ?? null,
          article.summarized_at ?? null, article.raw_text ?? null, article.cleaned_text ?? null,
          JSON.stringify(versionDocument.summaryJson), JSON.stringify(sourceMetadata), JSON.stringify(errorMetadata),
          now, article.case_key ?? null, "p3.article.v1", article.raw_text_storage_ref ?? null,
          article.raw_text_blob_hash ?? null, article.raw_text_blob_size ?? null,
          article.raw_text_externalized_at ?? null, article.raw_text_blob_contract_version ?? null,
        );
        headUpsert = binding.prepare(
          "INSERT INTO article_version_heads_p3 (article_id,current_version_id,current_revision,updated_at) VALUES (?,?,?,?) ON CONFLICT(article_id) DO UPDATE SET current_version_id=excluded.current_version_id,current_revision=excluded.current_revision,updated_at=excluded.updated_at",
        ).bind(input.articleId, versionId, String(versionRevision), now);
        versionCreated = true;
      } else {
        versionId = String(version.id);
        versionRevision = asNumber(version.revision);
      }
    } else {
      if (!versionId) return { ok: false, error: articlePublicationError("invalid_input") };
      version = await one<Row>(
        binding,
        "SELECT * FROM article_content_versions_p3 WHERE id=? AND article_id=?",
        [versionId, input.articleId],
      );
      if (!version) return { ok: false, error: articlePublicationError("not_found") };
      versionRevision = asNumber(version.revision);
    }
    if (!version || !versionId) return { ok: false, error: articlePublicationError("internal") };

    const publication = await one<Row>(binding, "SELECT * FROM article_publications_p3 WHERE article_id=?", [input.articleId]);
    const currentPublicationRevision = asNumber(publication?.revision);
    if (currentPublicationRevision !== input.expectedPublicationRevision) {
      return { ok: false, error: articlePublicationError("stale_revision") };
    }
    const oldState = nullableText(publication?.state) as ArticlePublicationState | null;
    const oldVersionId = nullableText(publication?.version_id);
    const publicationApplied = !publication
      || input.targetState !== oldState
      || versionId !== oldVersionId;
    if (publicationApplied && !publicationTransitionAllowed(oldState, input.targetState, input.actorType, versionId !== oldVersionId)) {
      return { ok: false, error: articlePublicationError("illegal_transition") };
    }
    if (oldState === "withdrawn" && input.targetState === "published" && input.reason.trim().length < 8) {
      return { ok: false, error: articlePublicationError("illegal_transition") };
    }
    if (input.targetState === "published" && !publicationEligible(article, version)) {
      return { ok: false, error: articlePublicationError("ineligible") };
    }
    const publicationId = publication ? String(publication.id) : crypto.randomUUID();
    const publicationRevision = publication
      ? currentPublicationRevision + (publicationApplied ? 1 : 0)
      : 1;
    const statements: D1RuntimePreparedStatement[] = [];
    if (versionInsert) statements.push(versionInsert);
    if (headUpsert) statements.push(headUpsert);
    if (!publication) {
      statements.push(binding.prepare(
        "INSERT INTO article_publications_p3 (id,article_id,state,version_id,revision,decided_by_type,decided_by_id,reason,published_at,withdrawn_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      ).bind(
        publicationId, input.articleId, input.targetState, versionId, String(publicationRevision),
        input.actorType, input.actorId ?? null, input.reason,
        input.targetState === "published" ? now : null, input.targetState === "withdrawn" ? now : null, now, now,
      ));
    } else if (publicationApplied) {
      statements.push(binding.prepare(
        "UPDATE article_publications_p3 SET state=?,version_id=?,revision=?,decided_by_type=?,decided_by_id=?,reason=?,published_at=CASE WHEN ?='published' THEN COALESCE(published_at,?) ELSE published_at END,withdrawn_at=CASE WHEN ?='withdrawn' THEN ? WHEN ?='published' THEN NULL ELSE withdrawn_at END,updated_at=? WHERE id=? AND revision=?",
      ).bind(
        input.targetState, versionId, String(publicationRevision), input.actorType, input.actorId ?? null,
        input.reason, input.targetState, now, input.targetState, now, input.targetState, now,
        publicationId, String(currentPublicationRevision),
      ));
    }
    const auditEvents: Parameters<typeof auditStatements>[2] = [];
    if (versionCreated) {
      auditEvents.push({
        eventType: "article.version.created",
        versionId,
        publicationId: null,
        publicationRevision: null,
        actorType: input.provenanceActorType ?? "human",
        actorId: input.provenanceActorId ?? null,
        reason: input.reason,
        requestId: input.requestId ?? null,
        correlationId: input.correlationId ?? null,
        metadata: { contentHash: version.content_hash, revision: versionRevision },
        occurredAt: now,
      });
    }
    if (publicationApplied) {
      statements.push(binding.prepare(
        "INSERT INTO article_publication_history_p3 (id,publication_id,article_id,publication_revision,from_state,to_state,from_version_id,to_version_id,idempotency_key,actor_type,actor_id,reason,request_id,correlation_id,occurred_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      ).bind(
        decimalIdentity(), publicationId, input.articleId, String(publicationRevision), oldState,
        input.targetState, oldVersionId, versionId, input.idempotencyKey, input.actorType,
        input.actorId ?? null, input.reason, input.requestId ?? null, input.correlationId ?? null, now,
      ));
      auditEvents.push({
        eventType: input.targetState === "published"
          ? "article.publication.published"
          : input.targetState === "withdrawn"
            ? "article.publication.withdrawn"
            : `article.publication.${input.targetState}`,
        versionId,
        publicationId,
        publicationRevision,
        actorType: input.actorType,
        actorId: input.actorId ?? null,
        reason: input.reason,
        requestId: input.requestId ?? null,
        correlationId: input.correlationId ?? null,
        metadata: { ...(input.safeMetadata ?? {}), fromState: oldState, toState: input.targetState },
        occurredAt: now,
      });
      statements.push(binding.prepare(
        "INSERT OR IGNORE INTO article_cache_outbox_p3 (id,event_key,event_type,article_id,publication_id,publication_revision,version_id,publication_state,article_slug,status,attempt_count,max_attempts,available_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,'pending',0,12,?,?,?)",
      ).bind(
        crypto.randomUUID(), `article-publication:${publicationId}:${publicationRevision}`,
        "publication.changed", input.articleId, publicationId, String(publicationRevision),
        versionId, input.targetState, String(version.slug ?? ""), now, now, now,
      ));
    } else {
      auditEvents.push({
        eventType: input.captureLegacy ? "article.version.capture_noop" : "article.publication.noop",
        versionId,
        publicationId,
        publicationRevision,
        actorType: input.captureLegacy ? input.provenanceActorType ?? "human" : input.actorType,
        actorId: input.captureLegacy ? input.provenanceActorId ?? null : input.actorId ?? null,
        reason: input.reason,
        requestId: input.requestId ?? null,
        correlationId: input.correlationId ?? null,
        metadata: input.safeMetadata ?? {},
        occurredAt: now,
      });
    }
    statements.push(...await auditStatements(binding, input.articleId, auditEvents));
    statements.push(binding.prepare(
      "INSERT INTO article_publication_requests_p3 (id,article_id,idempotency_key,publication_id,publication_revision,version_id,version_revision,state,version_created,publication_applied,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    ).bind(
      decimalIdentity(), input.articleId, input.idempotencyKey, publicationId, String(publicationRevision),
      versionId, String(versionRevision), input.targetState, versionCreated, publicationApplied, now,
    ));
    await batch(binding, statements);
    return {
      ok: true,
      data: {
        articleId: input.articleId,
        versionId,
        versionRevision,
        publicationId,
        publicationRevision,
        publicationState: input.targetState,
        versionCreated,
        publicationApplied,
        idempotent: false,
      },
    };
  } catch {
    return { ok: false, error: articlePublicationError("unavailable") };
  }
}

export async function deleteCoreCanaryArticleFromD1(binding: D1RuntimeDatabase, articleId: string) {
  const statements = [
    "DELETE FROM article_cache_outbox_p3 WHERE article_id=?",
    "DELETE FROM article_publication_requests_p3 WHERE article_id=?",
    "DELETE FROM article_audit_ledger_p3 WHERE article_id=?",
    "DELETE FROM article_publication_history_p3 WHERE article_id=?",
    "DELETE FROM article_publications_p3 WHERE article_id=?",
    "DELETE FROM article_version_heads_p3 WHERE article_id=?",
    "DELETE FROM article_content_versions_p3 WHERE article_id=?",
    "DELETE FROM article_lifecycle_events_p2 WHERE article_id=?",
    "DELETE FROM articles WHERE id=?",
  ].map((sql) => binding.prepare(sql).bind(articleId));
  await batch(binding, statements);
}
