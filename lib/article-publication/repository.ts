import { getSupabaseServiceRoleAdmin } from "@/lib/db/client";
import { articlePublicationError, mapArticlePublicationDatabaseError } from "@/lib/article-publication/errors";
import type {
  ArticleCacheOutboxEvent,
  ArticleCacheOutboxRepository,
  ArticlePublicationRepository,
  ArticlePublicationResult,
  ArticlePublicationSnapshot,
  ArticlePublicationState,
  ArticlePublicationTransitionResult,
} from "@/lib/article-publication/types";

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

export const postgresArticlePublicationRepository: ArticlePublicationRepository = {
  async getSnapshot(articleId) {
    const supabase = getSupabaseServiceRoleAdmin();
    if (!supabase) return { ok: false, error: articlePublicationError("unavailable") };
    const { data, error } = await supabase.rpc("article_publication_snapshot_p3", { p_article_id: articleId });
    if (error) return { ok: false, error: mapArticlePublicationDatabaseError(error) };
    const value = row(data);
    if (!value) return { ok: false, error: articlePublicationError("not_found") };
    return { ok: true, data: snapshot(value) };
  },

  async transition(input): Promise<ArticlePublicationResult<ArticlePublicationTransitionResult>> {
    const supabase = getSupabaseServiceRoleAdmin();
    if (!supabase) return { ok: false, error: articlePublicationError("unavailable") };
    const { data, error } = await supabase.rpc("article_publication_transition_p3", {
      p_article_id: input.articleId,
      p_expected_version_revision: input.expectedVersionRevision,
      p_expected_publication_revision: input.expectedPublicationRevision,
      p_idempotency_key: input.idempotencyKey,
      p_target_state: input.targetState,
      p_version_id: input.versionId ?? null,
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
    });
    if (error) return { ok: false, error: mapArticlePublicationDatabaseError(error) };
    const value = row(data);
    return value
      ? { ok: true, data: transitionResult(value) }
      : { ok: false, error: articlePublicationError("internal") };
  },
};

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
