export const ARTICLE_PUBLICATION_STATES = ["draft", "in_review", "published", "withdrawn"] as const;
export type ArticlePublicationState = (typeof ARTICLE_PUBLICATION_STATES)[number];

export const ARTICLE_VERSION_PROVENANCE_ACTORS = ["human", "llm", "import"] as const;
export type ArticleVersionProvenanceActor = (typeof ARTICLE_VERSION_PROVENANCE_ACTORS)[number];

export const ARTICLE_PUBLICATION_ACTORS = ["human", "compatibility", "backfill", "system"] as const;
export type ArticlePublicationActor = (typeof ARTICLE_PUBLICATION_ACTORS)[number];

export interface ArticlePublicationSnapshot {
  articleId: string;
  versionRevision: number;
  publicationRevision: number;
  publicationState: ArticlePublicationState | null;
  legacyUpdatedAt: string;
}

export interface ArticlePublicationTransitionInput {
  articleId: string;
  expectedVersionRevision: number;
  expectedPublicationRevision: number;
  idempotencyKey: string;
  targetState: ArticlePublicationState;
  versionId?: string | null;
  captureLegacy?: boolean;
  actorType: ArticlePublicationActor;
  actorId?: string | null;
  reason: string;
  requestId?: string | null;
  correlationId?: string | null;
  provenanceActorType?: ArticleVersionProvenanceActor;
  provenanceActorId?: string | null;
  modelRef?: string | null;
  promptRef?: string | null;
  safeMetadata?: Record<string, unknown>;
  expectedLegacyUpdatedAt?: string | null;
}

export interface ArticlePublicationTransitionResult {
  articleId: string;
  versionId: string;
  versionRevision: number;
  publicationId: string;
  publicationRevision: number;
  publicationState: ArticlePublicationState;
  versionCreated: boolean;
  publicationApplied: boolean;
  idempotent: boolean;
}

export type ArticlePublicationErrorCode =
  | "invalid_input"
  | "not_found"
  | "stale_revision"
  | "ineligible"
  | "illegal_transition"
  | "forbidden"
  | "unavailable"
  | "internal";

export interface ArticlePublicationError {
  code: ArticlePublicationErrorCode;
  retryable: boolean;
}

export type ArticlePublicationResult<T> = { ok: true; data: T } | { ok: false; error: ArticlePublicationError };

export interface ArticlePublicationRepository {
  getSnapshot(articleId: string): Promise<ArticlePublicationResult<ArticlePublicationSnapshot>>;
  transition(input: ArticlePublicationTransitionInput): Promise<ArticlePublicationResult<ArticlePublicationTransitionResult>>;
}

export interface ArticleCacheOutboxEvent {
  eventId: string;
  eventKey: string;
  articleId: string;
  publicationId: string;
  publicationRevision: number;
  versionId: string;
  publicationState: ArticlePublicationState;
  articleSlug: string;
  leaseToken: string;
  leaseExpiresAt: string;
  attemptCount: number;
}

export interface ArticleCacheOutboxRepository {
  claim(workerId: string, limit: number, leaseSeconds: number): Promise<ArticleCacheOutboxEvent[]>;
  deliver(event: ArticleCacheOutboxEvent, workerId: string): Promise<void>;
  fail(event: ArticleCacheOutboxEvent, workerId: string, errorCode: string): Promise<"pending" | "dead_letter">;
}
