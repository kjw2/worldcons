import { publicArticleRelation, publicProjectionReadsEnabled } from "@/lib/article-publication";
import { getSupabaseAdmin } from "@/lib/db/client";
import { listArticles } from "@/lib/db/queries";
import type { ArticleListFilters, ArticleListResult } from "@/lib/db/types";
import { extractExactCaseReferences } from "@/lib/search/case-number";

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

  const supabase = getSupabaseAdmin();
  if (!supabase) return empty;

  const relation = publicArticleRelation();
  const ids: string[] = [];

  for (const reference of references) {
    const baseQuery = () => {
      let query = supabase.from(relation).select("id").eq("source_key", reference.sourceKey);
      if (!publicProjectionReadsEnabled()) {
        query = query.eq("status", "summarized").filter("source_metadata->collection->>publishable", "eq", "true");
      }
      if (filters.jurisdiction) query = query.eq("jurisdiction", filters.jurisdiction);
      if (filters.type) query = query.eq("content_type", filters.type);
      if (filters.language) query = query.eq("original_language", filters.language);
      return query;
    };

    const indexedResult = await baseQuery().eq("case_key", reference.caseKey).limit(100);
    if (!indexedResult.error && Array.isArray(indexedResult.data)) {
      for (const row of indexedResult.data as Array<{ id?: string }>) {
        if (row.id && !ids.includes(row.id)) ids.push(row.id);
      }
      continue;
    }

    // Rollout fallback for databases that have not applied the indexed case_key migration yet.
    const metadataResult = await baseQuery().ilike("source_metadata->>caseNumber", `%${reference.caseNumber}%`).limit(100);
    const urlToken = reference.sourceKey === "de-bverfg" ? reference.caseKey : reference.caseNumber;
    const urlResult = reference.sourceKey === "de-bverfg" || reference.sourceKey === "us-scotus"
      ? await baseQuery().ilike("original_url", `%${urlToken}%`).limit(100)
      : { data: [], error: null };

    for (const result of [metadataResult, urlResult]) {
      if (result.error || !Array.isArray(result.data)) continue;
      for (const row of result.data as Array<{ id?: string }>) {
        if (row.id && !ids.includes(row.id)) ids.push(row.id);
      }
    }
  }

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
