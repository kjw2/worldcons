import { publicProjectionReadsEnabled } from "@/lib/article-publication";
import { getSupabaseAdmin } from "@/lib/db/client";
import type { ArticleListFilters, PageInfo } from "@/lib/db/types";

export type RankedSearchMode = "fulltext" | "semantic" | "hybrid";

export type RankedSearchPage = {
  ids: string[];
  pageInfo: PageInfo;
  retrievalMode: string;
};

type RankedSearchRpcPayload = {
  entries?: unknown;
  retrievalMode?: unknown;
  total?: unknown;
  hasMore?: unknown;
  totalIsExact?: unknown;
};

function nonNegativeInteger(value: unknown) {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function entryId(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" && id ? id : null;
}

export async function rankedSearchPage(
  filters: ArticleListFilters,
  mode: RankedSearchMode,
  embedding: number[] | null,
): Promise<RankedSearchPage | null> {
  if (filters.includeUnpublished || !publicProjectionReadsEnabled()) return null;

  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 20;
  const offset = (page - 1) * pageSize;
  if (offset > 10_000) return null;

  const supabase = getSupabaseAdmin();
  if (!supabase) return null;

  const { data, error } = await supabase.rpc("worldcons_ranked_search_page_v1", {
    p_query: filters.q ?? "",
    p_mode: mode,
    p_query_embedding: embedding,
    p_limit: pageSize,
    p_offset: offset,
    p_source: filters.source ?? null,
    p_jurisdiction: filters.jurisdiction ?? null,
    p_content_type: filters.type ?? null,
    p_language: filters.language ?? null,
    p_tag: filters.tag ?? null,
    p_range: filters.range ?? "latest",
    p_count: filters.count ?? "none",
  });
  if (error || !data || typeof data !== "object" || Array.isArray(data)) return null;

  const payload = data as RankedSearchRpcPayload;
  const rawEntries = Array.isArray(payload.entries) ? payload.entries : [];
  const ids = rawEntries.map(entryId).filter((id): id is string => Boolean(id));
  const hasMore = payload.hasMore === true;
  const totalIsExact = payload.totalIsExact === true;
  const lowerBoundTotal = offset + ids.length + (hasMore ? 1 : 0);
  const total = Math.max(nonNegativeInteger(payload.total) ?? 0, lowerBoundTotal);

  return {
    ids,
    retrievalMode: typeof payload.retrievalMode === "string" ? payload.retrievalMode : mode,
    pageInfo: {
      page,
      pageSize,
      total,
      hasMore,
      totalIsExact,
    },
  };
}
