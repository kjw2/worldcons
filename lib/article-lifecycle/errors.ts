import type { ArticleLifecycleError, ArticleLifecycleErrorCode } from "@/lib/article-lifecycle/types";

const ERROR_MESSAGES: Record<ArticleLifecycleErrorCode, string> = {
  unavailable: "The article lifecycle state store is unavailable.",
  invalid_input: "The article lifecycle transition request is invalid.",
  not_found: "The article lifecycle record was not found.",
  stale_revision: "The article lifecycle revision is stale.",
  illegal_transition: "The article lifecycle transition is not legal.",
  forbidden: "Direct article lifecycle state writes are forbidden.",
  internal: "The article lifecycle transition failed.",
};

export function articleLifecycleError(code: ArticleLifecycleErrorCode): ArticleLifecycleError {
  return {
    code,
    message: ERROR_MESSAGES[code],
    retryable: code === "unavailable" || code === "stale_revision" || code === "internal",
    unavailable: code === "unavailable" || undefined,
  };
}

function databaseErrorText(error: unknown) {
  if (!error || typeof error !== "object") return "";
  const candidate = error as { code?: unknown; message?: unknown; details?: unknown; hint?: unknown };
  return [candidate.code, candidate.message, candidate.details, candidate.hint]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toUpperCase();
}

export function mapArticleLifecycleDatabaseError(error: unknown): ArticleLifecycleError {
  const text = databaseErrorText(error);
  if (/42P01|42703|42883|PGRST202|SCHEMA CACHE/.test(text)) return articleLifecycleError("unavailable");
  if (text.includes("ARTICLE_LIFECYCLE_STALE_REVISION") || text.includes("40001")) return articleLifecycleError("stale_revision");
  if (text.includes("ARTICLE_LIFECYCLE_NOT_FOUND") || text.includes("P0002")) return articleLifecycleError("not_found");
  if (text.includes("ARTICLE_LIFECYCLE_DIRECT_WRITE_FORBIDDEN") || text.includes("42501")) return articleLifecycleError("forbidden");
  if (/ILLEGAL_TRANSITION|REQUIRES_TEXT|INCOMPLETE_AXES|23514/.test(text)) return articleLifecycleError("illegal_transition");
  if (text.includes("INVALID_") || text.includes("22023")) return articleLifecycleError("invalid_input");
  return articleLifecycleError("internal");
}
