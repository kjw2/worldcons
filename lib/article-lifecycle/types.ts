export const ARTICLE_COLLECTION_STATES = ["discovered", "metadata_only", "source_fetched", "source_text_ready"] as const;
export const ARTICLE_PROCESSING_STATES = ["not_ready", "ready", "running", "complete"] as const;
export const ARTICLE_LIFECYCLE_REVIEW_STATES = [
  "unreviewed",
  "needs_review",
  "approved_for_processing",
  "approved",
  "closed_private",
] as const;
export const ARTICLE_ATTENTION_STATES = ["clear", "active", "anomaly"] as const;
export const ARTICLE_ATTENTION_SEVERITIES = ["low", "medium", "high"] as const;
export const ARTICLE_ATTENTION_SOURCES = ["collection", "processing", "review", "backfill", "system"] as const;
export const ARTICLE_LIFECYCLE_ACTOR_TYPES = [
  "ingestion",
  "summary_worker",
  "admin",
  "candidate",
  "backfill",
  "system",
  "compatibility",
] as const;

export type ArticleCollectionState = (typeof ARTICLE_COLLECTION_STATES)[number];
export type ArticleProcessingState = (typeof ARTICLE_PROCESSING_STATES)[number];
export type ArticleLifecycleReviewState = (typeof ARTICLE_LIFECYCLE_REVIEW_STATES)[number];
export type ArticleAttentionState = (typeof ARTICLE_ATTENTION_STATES)[number];
export type ArticleAttentionSeverity = (typeof ARTICLE_ATTENTION_SEVERITIES)[number];
export type ArticleAttentionSource = (typeof ARTICLE_ATTENTION_SOURCES)[number];
export type ArticleLifecycleActorType = (typeof ARTICLE_LIFECYCLE_ACTOR_TYPES)[number];

export interface ArticleLifecycleSnapshot {
  articleId: string;
  revision: number;
  collectionState: ArticleCollectionState | null;
  processingState: ArticleProcessingState | null;
  reviewState: ArticleLifecycleReviewState | null;
  attentionState: ArticleAttentionState | null;
  attentionCode: string | null;
  attentionRetryable: boolean | null;
  attentionSeverity: ArticleAttentionSeverity | null;
  attentionSource: ArticleAttentionSource | null;
}

export type ArticleAttentionTransition =
  | { operation: "keep" }
  | { operation: "clear"; resolvesCodes: string[] }
  | {
      operation: "raise" | "quarantine";
      code: string;
      retryable: boolean;
      severity: ArticleAttentionSeverity;
      source: ArticleAttentionSource;
    };

export interface ArticleLifecycleTransitionInput {
  articleId: string;
  expectedRevision: number;
  idempotencyKey: string;
  actorType: ArticleLifecycleActorType;
  actorId?: string | null;
  source: string;
  reasonCode: string;
  collectionState?: ArticleCollectionState;
  processingState?: ArticleProcessingState;
  reviewState?: ArticleLifecycleReviewState;
  attention?: ArticleAttentionTransition;
}

export interface ArticleLifecycleTransitionResult extends ArticleLifecycleSnapshot {
  applied: boolean;
  idempotent: boolean;
}

export const ARTICLE_LIFECYCLE_ERROR_CODES = [
  "unavailable",
  "invalid_input",
  "not_found",
  "stale_revision",
  "illegal_transition",
  "forbidden",
  "internal",
] as const;

export type ArticleLifecycleErrorCode = (typeof ARTICLE_LIFECYCLE_ERROR_CODES)[number];

export interface ArticleLifecycleError {
  code: ArticleLifecycleErrorCode;
  message: string;
  retryable: boolean;
  unavailable?: boolean;
}

export type ArticleLifecycleResult<T> = { ok: true; data: T } | { ok: false; error: ArticleLifecycleError };

export interface ArticleLifecycleRepository {
  get(articleId: string): Promise<ArticleLifecycleResult<ArticleLifecycleSnapshot>>;
  transition(input: ArticleLifecycleTransitionInput): Promise<ArticleLifecycleResult<ArticleLifecycleTransitionResult>>;
}
