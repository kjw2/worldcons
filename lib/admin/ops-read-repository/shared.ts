import type { AdminOpsArticleRow } from "@/lib/admin/ops-read-repository/types";

export const DEFAULT_ADMIN_ARTICLE_PAGE_SIZE = 25;
export const MAX_ADMIN_ARTICLE_PAGE_SIZE = 50;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The `source_metadata.collection` object for an article row, or an empty
 * object when it is absent/malformed. Shared by the admin list mapping and the
 * mock list filtering so the publishability read cannot drift.
 */
export function collectionFor(
  row: Pick<AdminOpsArticleRow, "source_metadata">,
): Record<string, unknown> {
  const collection = row.source_metadata?.collection;
  return isRecord(collection) ? collection : {};
}

export function isPublishableArticle(row: Pick<AdminOpsArticleRow, "source_metadata">) {
  return collectionFor(row).publishable === true;
}

/** The exact pre-extraction page bound: a positive finite floor, default 1. */
export function boundedAdminArticlePage(value?: number) {
  return Number.isFinite(value) && value && value > 0 ? Math.floor(value) : 1;
}

/** The exact pre-extraction page-size bound: a positive finite floor, capped at 50, default 25. */
export function boundedAdminArticlePageSize(value?: number) {
  return Number.isFinite(value) && value && value > 0
    ? Math.min(Math.floor(value), MAX_ADMIN_ARTICLE_PAGE_SIZE)
    : DEFAULT_ADMIN_ARTICLE_PAGE_SIZE;
}
