import { getSupabaseServiceRoleAdmin } from "@/lib/db/client";
import { articleLifecycleError, mapArticleLifecycleDatabaseError } from "@/lib/article-lifecycle/errors";
import type {
  ArticleAttentionSeverity,
  ArticleAttentionSource,
  ArticleAttentionState,
  ArticleCollectionState,
  ArticleLifecycleRepository,
  ArticleLifecycleResult,
  ArticleLifecycleReviewState,
  ArticleLifecycleSnapshot,
  ArticleLifecycleTransitionInput,
  ArticleLifecycleTransitionResult,
  ArticleProcessingState,
} from "@/lib/article-lifecycle/types";

type Row = Record<string, unknown>;

function isRecord(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstRow(value: unknown) {
  if (Array.isArray(value)) return isRecord(value[0]) ? value[0] : null;
  return isRecord(value) ? value : null;
}

function nullableText(row: Row, key: string) {
  return typeof row[key] === "string" ? row[key] as string : null;
}

function number(row: Row, key: string) {
  const value = row[key];
  return typeof value === "number" ? value : typeof value === "string" ? Number(value) : 0;
}

function snapshot(row: Row): ArticleLifecycleSnapshot {
  return {
    articleId: String(row.article_id ?? row.id ?? ""),
    revision: number(row, "revision") || number(row, "lifecycle_revision"),
    collectionState: nullableText(row, "collection_state") as ArticleCollectionState | null
      ?? nullableText(row, "lifecycle_collection_state") as ArticleCollectionState | null,
    processingState: nullableText(row, "processing_state") as ArticleProcessingState | null
      ?? nullableText(row, "lifecycle_processing_state") as ArticleProcessingState | null,
    reviewState: nullableText(row, "review_state") as ArticleLifecycleReviewState | null
      ?? nullableText(row, "lifecycle_review_state") as ArticleLifecycleReviewState | null,
    attentionState: nullableText(row, "attention_state") as ArticleAttentionState | null
      ?? nullableText(row, "lifecycle_attention_state") as ArticleAttentionState | null,
    attentionCode: nullableText(row, "attention_code") ?? nullableText(row, "lifecycle_attention_code"),
    attentionRetryable: typeof (row.attention_retryable ?? row.lifecycle_attention_retryable) === "boolean"
      ? (row.attention_retryable ?? row.lifecycle_attention_retryable) as boolean
      : null,
    attentionSeverity: (nullableText(row, "attention_severity") ?? nullableText(row, "lifecycle_attention_severity")) as ArticleAttentionSeverity | null,
    attentionSource: (nullableText(row, "attention_source") ?? nullableText(row, "lifecycle_attention_source")) as ArticleAttentionSource | null,
  };
}

export const postgresArticleLifecycleRepository: ArticleLifecycleRepository = {
  async get(articleId: string) {
    const supabase = getSupabaseServiceRoleAdmin();
    if (!supabase) return { ok: false, error: articleLifecycleError("unavailable") };
    const { data, error } = await supabase
      .from("articles")
      .select(
        "id,lifecycle_revision,lifecycle_collection_state,lifecycle_processing_state,lifecycle_review_state,lifecycle_attention_state,lifecycle_attention_code,lifecycle_attention_retryable,lifecycle_attention_severity,lifecycle_attention_source",
      )
      .eq("id", articleId)
      .maybeSingle();
    if (error) return { ok: false, error: mapArticleLifecycleDatabaseError(error) };
    if (!data) return { ok: false, error: articleLifecycleError("not_found") };
    return { ok: true, data: snapshot(data as Row) };
  },

  async transition(input: ArticleLifecycleTransitionInput): Promise<ArticleLifecycleResult<ArticleLifecycleTransitionResult>> {
    const supabase = getSupabaseServiceRoleAdmin();
    if (!supabase) return { ok: false, error: articleLifecycleError("unavailable") };
    const attention = input.attention ?? { operation: "keep" as const };
    const { data, error } = await supabase.rpc("article_lifecycle_transition_p2", {
      p_article_id: input.articleId,
      p_expected_revision: input.expectedRevision,
      p_idempotency_key: input.idempotencyKey,
      p_actor_type: input.actorType,
      p_actor_id: input.actorId ?? null,
      p_source: input.source,
      p_reason_code: input.reasonCode,
      p_collection_state: input.collectionState ?? null,
      p_processing_state: input.processingState ?? null,
      p_review_state: input.reviewState ?? null,
      p_attention_operation: attention.operation,
      p_attention_code: attention.operation === "raise" || attention.operation === "quarantine" ? attention.code : null,
      p_attention_retryable: attention.operation === "raise" || attention.operation === "quarantine" ? attention.retryable : null,
      p_attention_severity: attention.operation === "raise" || attention.operation === "quarantine" ? attention.severity : null,
      p_attention_source: attention.operation === "raise" || attention.operation === "quarantine" ? attention.source : null,
      p_resolves_attention_codes: attention.operation === "clear" ? attention.resolvesCodes : [],
    });
    if (error) return { ok: false, error: mapArticleLifecycleDatabaseError(error) };
    const row = firstRow(data);
    if (!row) return { ok: false, error: articleLifecycleError("internal") };
    return {
      ok: true,
      data: {
        ...snapshot(row),
        applied: row.applied === true,
        idempotent: row.idempotent === true,
      },
    };
  },
};
