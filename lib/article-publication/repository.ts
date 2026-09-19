import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseServiceRoleAdmin } from "@/lib/db/client";
import { articleRawBlobWriteReady } from "@/lib/article-raw/flags";
import { externalizeArticleRawText } from "@/lib/article-raw/publication";
import { articlePublicationError, mapArticlePublicationDatabaseError } from "@/lib/article-publication/errors";
import type {
  ArticleCacheOutboxEvent,
  ArticleCacheOutboxRepository,
  ArticlePublicationRepository,
  ArticlePublicationResult,
  ArticlePublicationSnapshot,
  ArticlePublicationState,
  ArticlePublicationTransitionInput,
  ArticlePublicationTransitionResult,
} from "@/lib/article-publication/types";
import { createArtifactBlobStore, type ArtifactBlobStore } from "@/lib/storage/blob";

type Row = Record<string, unknown>;

function row(value: unknown): Row | null {
  if (Array.isArray(value)) return value[0] && typeof value[0] === "object" ? value[0] as Row : null;
  return value && typeof value === "object" ? value as Row : null;
}

function numberValue(value: unknown) {
  return typeof value === "number" ? value : Number(value ?? 0);
}

function snapshot(value: Row): ArticlePublicationSnapshot {
  return {
    articleId: String(value.article_id ?? ""),
    versionRevision: numberValue(value.version_revision),
    publicationRevision: numberValue(value.publication_revision),
    publicationState: typeof value.publication_state === "string" ? value.publication_state as ArticlePublicationState : null,
    legacyUpdatedAt: String(value.legacy_updated_at ?? ""),
  };
}

function transitionResult(value: Row): ArticlePublicationTransitionResult {
  return {
    articleId: String(value.article_id ?? ""),
    versionId: String(value.version_id ?? ""),
    versionRevision: numberValue(value.version_revision),
    publicationId: String(value.publication_id ?? ""),
    publicationRevision: numberValue(value.publication_revision),
    publicationState: String(value.publication_state ?? "draft") as ArticlePublicationState,
    versionCreated: value.version_created === true,
    publicationApplied: value.publication_applied === true,
    idempotent: value.idempotent === true,
  };
}

export interface ArticlePublicationRepositoryDependencies {
  client?: () => SupabaseClient | null;
  blobStore?: ArtifactBlobStore | null;
  environment?: Record<string, string | undefined>;
}

function captureRpcArgs(input: ArticlePublicationTransitionInput) {
  return {
    p_article_id: input.articleId,
    p_expected_version_revision: input.expectedVersionRevision,
    p_expected_publication_revision: input.expectedPublicationRevision,
    p_idempotency_key: input.idempotencyKey,
    p_target_state: input.targetState,
    p_capture_legacy: input.captureLegacy === true,
    p_actor_type: input.actorType,
    p_actor_id: input.actorId ?? null,
    p_reason: input.reason,
    p_request_id: input.requestId ?? null,
    p_correlation_id: input.correlationId ?? null,
    p_provenance_actor_type: input.provenanceActorType ?? "human",
    p_provenance_actor_id: input.provenanceActorId ?? null,
    p_model_ref: input.modelRef ?? null,
    p_prompt_ref: input.promptRef ?? null,
    p_safe_metadata: input.safeMetadata ?? {},
    p_expected_legacy_updated_at: input.expectedLegacyUpdatedAt ?? null,
  };
}

/**
 * The flag-off transition is the exact legacy RPC call with the exact legacy
 * arguments, so turning either Blob flag off restores the pre-M6A behavior
 * byte-for-byte.
 */
async function runLegacyTransition(
  supabase: SupabaseClient,
  input: ArticlePublicationTransitionInput,
): Promise<ArticlePublicationResult<ArticlePublicationTransitionResult>> {
  const { data, error } = await supabase.rpc("article_publication_transition_p3", {
    ...captureRpcArgs(input),
    p_version_id: input.versionId ?? null,
  });
  if (error) return { ok: false, error: mapArticlePublicationDatabaseError(error) };
  const value = row(data);
  return value
    ? { ok: true, data: transitionResult(value) }
    : { ok: false, error: articlePublicationError("internal") };
}

/**
 * Flag-on capture: read the source article's inline raw_text, externalize it to a
 * verified private Blob object, then capture a version with `raw_text` NULL plus
 * the content-addressed Blob metadata. The Blob object is uploaded and verified
 * before the RPC is called; any Blob failure returns `unavailable` without
 * recording a version and without falling back to an inline capture. When the
 * article has no inline raw_text there is nothing to externalize, so the legacy
 * capture is used unchanged.
 */
async function runBlobTransition(
  supabase: SupabaseClient,
  input: ArticlePublicationTransitionInput,
  dependencies: ArticlePublicationRepositoryDependencies,
): Promise<ArticlePublicationResult<ArticlePublicationTransitionResult>> {
  const { data: source, error: sourceError } = await supabase
    .from("articles")
    .select("source_key,raw_text")
    .eq("id", input.articleId)
    .maybeSingle();
  if (sourceError) return { ok: false, error: articlePublicationError("unavailable") };

  const sourceRow = source as { source_key?: string | null; raw_text?: string | null } | null;
  const rawText = sourceRow?.raw_text;
  const sourceKey = sourceRow?.source_key?.trim();
  if (typeof rawText !== "string" || !sourceKey) return runLegacyTransition(supabase, input);

  const store = dependencies.blobStore ?? createArtifactBlobStore();
  let externalization;
  try {
    externalization = await externalizeArticleRawText(store, sourceKey, rawText);
  } catch {
    return { ok: false, error: articlePublicationError("unavailable") };
  }

  const { data, error } = await supabase.rpc("article_publication_transition_p3_blob", {
    ...captureRpcArgs(input),
    p_raw_text_storage_ref: externalization.storageRef,
    p_raw_text_blob_hash: externalization.sha256,
    p_raw_text_blob_size: externalization.size,
    p_raw_text_blob_contract_version: externalization.contractVersion,
  });
  if (error) return { ok: false, error: mapArticlePublicationDatabaseError(error) };
  const value = row(data);
  return value
    ? { ok: true, data: transitionResult(value) }
    : { ok: false, error: articlePublicationError("internal") };
}

export function createPostgresArticlePublicationRepository(
  dependencies: ArticlePublicationRepositoryDependencies = {},
): ArticlePublicationRepository {
  const client = dependencies.client ?? getSupabaseServiceRoleAdmin;
  return {
    async getSnapshot(articleId) {
      const supabase = client();
      if (!supabase) return { ok: false, error: articlePublicationError("unavailable") };
      const { data, error } = await supabase.rpc("article_publication_snapshot_p3", { p_article_id: articleId });
      if (error) return { ok: false, error: mapArticlePublicationDatabaseError(error) };
      const value = row(data);
      if (!value) return { ok: false, error: articlePublicationError("not_found") };
      return { ok: true, data: snapshot(value) };
    },

    async transition(input): Promise<ArticlePublicationResult<ArticlePublicationTransitionResult>> {
      const supabase = client();
      if (!supabase) return { ok: false, error: articlePublicationError("unavailable") };
      const environment = dependencies.environment ?? process.env;
      if (input.captureLegacy === true && articleRawBlobWriteReady(environment)) {
        return runBlobTransition(supabase, input, dependencies);
      }
      return runLegacyTransition(supabase, input);
    },
  };
}

export const postgresArticlePublicationRepository = createPostgresArticlePublicationRepository();

function outboxEvent(value: Row): ArticleCacheOutboxEvent {
  return {
    eventId: String(value.event_id ?? ""),
    eventKey: String(value.event_key ?? ""),
    articleId: String(value.article_id ?? ""),
    publicationId: String(value.publication_id ?? ""),
    publicationRevision: numberValue(value.publication_revision),
    versionId: String(value.version_id ?? ""),
    publicationState: String(value.publication_state ?? "draft") as ArticlePublicationState,
    articleSlug: String(value.article_slug ?? ""),
    leaseToken: String(value.lease_token ?? ""),
    leaseExpiresAt: String(value.lease_expires_at ?? ""),
    attemptCount: numberValue(value.attempt_count),
  };
}

export const postgresArticleCacheOutboxRepository: ArticleCacheOutboxRepository = {
  async claim(workerId, limit, leaseSeconds) {
    const supabase = getSupabaseServiceRoleAdmin();
    if (!supabase) throw new Error("ARTICLE_OUTBOX_UNAVAILABLE");
    const { data, error } = await supabase.rpc("article_cache_outbox_claim_p3", {
      p_worker_id: workerId,
      p_limit: limit,
      p_lease_seconds: leaseSeconds,
    });
    if (error) throw new Error(mapArticlePublicationDatabaseError(error).code);
    return (Array.isArray(data) ? data : []).map((value) => outboxEvent(value as Row));
  },

  async deliver(event, workerId) {
    const supabase = getSupabaseServiceRoleAdmin();
    if (!supabase) throw new Error("ARTICLE_OUTBOX_UNAVAILABLE");
    const { error } = await supabase.rpc("article_cache_outbox_deliver_p3", {
      p_event_id: event.eventId,
      p_worker_id: workerId,
      p_lease_token: event.leaseToken,
    });
    if (error) throw new Error(mapArticlePublicationDatabaseError(error).code);
  },

  async fail(event, workerId, errorCode) {
    const supabase = getSupabaseServiceRoleAdmin();
    if (!supabase) throw new Error("ARTICLE_OUTBOX_UNAVAILABLE");
    const { data, error } = await supabase.rpc("article_cache_outbox_fail_p3", {
      p_event_id: event.eventId,
      p_worker_id: workerId,
      p_lease_token: event.leaseToken,
      p_error_code: errorCode,
    });
    if (error) throw new Error(mapArticlePublicationDatabaseError(error).code);
    return data === "dead_letter" ? "dead_letter" : "pending";
  },
};
