import { listArticles } from "@/lib/db/queries";
import type { ArticleListFilters, ArticleListResult } from "@/lib/db/types";
import { extractExactCaseReferences } from "@/lib/search/case-number";
import { searchRepository } from "@/lib/search/repository";

export { extractExactCaseReferences, type ExactCaseReference } from "@/lib/search/case-number";

function emptyResult(page: number, pageSize: number): ArticleListResult {
  return {
    items: [],
    pageInfo: { page, pageSize, total: 0, hasMore: false, totalIsExact: true },
  };
}

export async function exactCaseSearch(filters: ArticleListFilters): Promise<ArticleListResult> {
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 20;
  const empty = emptyResult(page, pageSize);
  if (!filters.q) return empty;

  const references = extractExactCaseReferences(filters.q).filter(
    (reference) => !filters.source || filters.source === reference.sourceKey,
  );
  if (references.length === 0) return empty;

  const ids = await searchRepository().findExactCaseArticleIds({
    references,
    jurisdiction: filters.jurisdiction,
    type: filters.type,
    language: filters.language,
  });

  if (ids.length === 0) return empty;

  const result = await listArticles({
    ...filters,
    ids,
    q: undefined,
    page: 1,
    pageSize: Math.min(Math.max(ids.length, pageSize), 100),
    count: "none",
  });
  const order = new Map(ids.map((id, index) => [id, index]));
  const orderedItems = [...result.items].sort(
    (left, right) => (order.get(left.id ?? "") ?? Number.MAX_SAFE_INTEGER) - (order.get(right.id ?? "") ?? Number.MAX_SAFE_INTEGER),
  );
  const start = (page - 1) * pageSize;
  const items = orderedItems.slice(start, start + pageSize);

  return {
    items,
    pageInfo: {
      page,
      pageSize,
      total: orderedItems.length,
      hasMore: start + pageSize < orderedItems.length,
      totalIsExact: true,
    },
  };
}
