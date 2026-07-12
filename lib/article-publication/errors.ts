import type { ArticlePublicationError, ArticlePublicationErrorCode } from "@/lib/article-publication/types";

export function articlePublicationError(code: ArticlePublicationErrorCode): ArticlePublicationError {
  return { code, retryable: code === "stale_revision" || code === "unavailable" || code === "internal" };
}

export function mapArticlePublicationDatabaseError(error: { code?: string; message?: string }): ArticlePublicationError {
  const message = error.message ?? "";
  if (error.code === "40001" || message.includes("STALE_")) return articlePublicationError("stale_revision");
  if (error.code === "P0002" || message.includes("NOT_FOUND")) return articlePublicationError("not_found");
  if (error.code === "42501" || message.includes("FORBIDDEN")) return articlePublicationError("forbidden");
  if (message.includes("INELIGIBLE")) return articlePublicationError("ineligible");
  if (message.includes("ILLEGAL_TRANSITION") || message.includes("REPUBLISH_REASON_REQUIRED")) {
    return articlePublicationError("illegal_transition");
  }
  if (error.code === "22023" || error.code === "23514") return articlePublicationError("invalid_input");
  return articlePublicationError("internal");
}
