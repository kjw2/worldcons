import { articleLifecycleError } from "@/lib/article-lifecycle/errors";
import { postgresArticleLifecycleRepository } from "@/lib/article-lifecycle/repository";
import {
  ARTICLE_ATTENTION_SEVERITIES,
  ARTICLE_ATTENTION_SOURCES,
  ARTICLE_COLLECTION_STATES,
  ARTICLE_LIFECYCLE_ACTOR_TYPES,
  ARTICLE_LIFECYCLE_REVIEW_STATES,
  ARTICLE_PROCESSING_STATES,
  type ArticleLifecycleRepository,
  type ArticleLifecycleTransitionInput,
} from "@/lib/article-lifecycle/types";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CODE_PATTERN = /^[a-z][a-z0-9._-]*$/;

function boundedCode(value: string, maxLength: number) {
  return value.length >= 1 && value.length <= maxLength && CODE_PATTERN.test(value);
}

function actorOwnsSource(input: ArticleLifecycleTransitionInput) {
  const owner = input.source.split(".", 1)[0];
  const expected = {
    ingestion: "ingestion",
    candidate: "candidate",
    summary: "summary_worker",
    admin: "admin",
    backfill: "backfill",
    system: "system",
    compatibility: "compatibility",
  }[owner];
  return expected === undefined || input.actorType === expected;
}

function validTransition(input: ArticleLifecycleTransitionInput) {
  const attention = input.attention ?? { operation: "keep" as const };
  if (!UUID_PATTERN.test(input.articleId) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) return false;
  if (input.idempotencyKey.length < 1 || input.idempotencyKey.length > 240) return false;
  if (!ARTICLE_LIFECYCLE_ACTOR_TYPES.includes(input.actorType) || (input.actorId?.length ?? 0) > 160) return false;
  if (!boundedCode(input.source, 120) || !boundedCode(input.reasonCode, 160)) return false;
  if (!actorOwnsSource(input)) return false;
  if (input.collectionState && !ARTICLE_COLLECTION_STATES.includes(input.collectionState)) return false;
  if (input.processingState && !ARTICLE_PROCESSING_STATES.includes(input.processingState)) return false;
  if (input.reviewState && !ARTICLE_LIFECYCLE_REVIEW_STATES.includes(input.reviewState)) return false;
  if (attention.operation === "clear") {
    return attention.resolvesCodes.length > 0
      && attention.resolvesCodes.length <= 16
      && attention.resolvesCodes.every((code) => boundedCode(code, 120));
  }
  if (attention.operation === "raise" || attention.operation === "quarantine") {
    return boundedCode(attention.code, 120)
      && ARTICLE_ATTENTION_SEVERITIES.includes(attention.severity)
      && ARTICLE_ATTENTION_SOURCES.includes(attention.source);
  }
  return true;
}

export function createArticleLifecycleService(repository: ArticleLifecycleRepository = postgresArticleLifecycleRepository) {
  return {
    get(articleId: string) {
      if (!UUID_PATTERN.test(articleId)) return Promise.resolve({ ok: false as const, error: articleLifecycleError("invalid_input") });
      return repository.get(articleId);
    },

    transition(input: ArticleLifecycleTransitionInput) {
      if (!validTransition(input)) return Promise.resolve({ ok: false as const, error: articleLifecycleError("invalid_input") });
      return repository.transition(input);
    },
  };
}

export const articleLifecycleService = createArticleLifecycleService();
