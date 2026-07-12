import { articlePublicationError } from "@/lib/article-publication/errors";
import { postgresArticlePublicationRepository } from "@/lib/article-publication/repository";
import {
  ARTICLE_PUBLICATION_ACTORS,
  ARTICLE_PUBLICATION_STATES,
  ARTICLE_VERSION_PROVENANCE_ACTORS,
  type ArticlePublicationRepository,
  type ArticlePublicationTransitionInput,
} from "@/lib/article-publication/types";
import { recordCompatibilityObservation } from "@/lib/admin/p5/observations";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function bounded(value: string | null | undefined, max: number, required = false) {
  const length = value?.trim().length ?? 0;
  return required ? length >= 1 && length <= max : length <= max;
}

function validTransition(input: ArticlePublicationTransitionInput) {
  return UUID_PATTERN.test(input.articleId)
    && Number.isSafeInteger(input.expectedVersionRevision) && input.expectedVersionRevision >= 0
    && Number.isSafeInteger(input.expectedPublicationRevision) && input.expectedPublicationRevision >= 0
    && bounded(input.idempotencyKey, 240, true)
    && ARTICLE_PUBLICATION_STATES.includes(input.targetState)
    && ARTICLE_PUBLICATION_ACTORS.includes(input.actorType)
    && bounded(input.actorId, 160)
    && bounded(input.reason, 500, true)
    && bounded(input.requestId, 160)
    && bounded(input.correlationId, 160)
    && (!input.provenanceActorType || ARTICLE_VERSION_PROVENANCE_ACTORS.includes(input.provenanceActorType))
    && bounded(input.provenanceActorId, 160)
    && bounded(input.modelRef, 200)
    && bounded(input.promptRef, 200)
    && (input.captureLegacy === true ? !input.versionId : Boolean(input.versionId && UUID_PATTERN.test(input.versionId)));
}

export function createArticlePublicationService(repository: ArticlePublicationRepository = postgresArticlePublicationRepository) {
  const observed = <T extends { ok: boolean }>(promise: Promise<T>, direction: "read" | "write") => promise.then((result) => {
    recordCompatibilityObservation({ surface: "article_publication", domain: "publication", direction, authority: "new", outcome: result.ok ? "succeeded" : "failed" });
    return result;
  }, (error) => {
    recordCompatibilityObservation({ surface: "article_publication", domain: "publication", direction, authority: "new", outcome: "failed" });
    throw error;
  });
  return {
    getSnapshot(articleId: string) {
      return UUID_PATTERN.test(articleId)
        ? observed(repository.getSnapshot(articleId), "read")
        : Promise.resolve({ ok: false as const, error: articlePublicationError("invalid_input") });
    },

    transition(input: ArticlePublicationTransitionInput) {
      return validTransition(input)
        ? observed(repository.transition(input), "write")
        : Promise.resolve({ ok: false as const, error: articlePublicationError("invalid_input") });
    },
  };
}

export const articlePublicationService = createArticlePublicationService();
