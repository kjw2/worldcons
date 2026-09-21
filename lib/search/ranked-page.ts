import { publicProjectionReadsEnabled } from "@/lib/article-publication";
import type { ArticleListFilters, PageInfo } from "@/lib/db/types";
import { searchRepository, type RankedSearchMode } from "@/lib/search/repository";

export type { RankedSearchMode };

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

  const data = await searchRepository().rankedSearchPageRpc({
    query: filters.q ?? "",
    mode,
    embedding,
    limit: pageSize,
    offset,
    source: filters.source ?? null,
    jurisdiction: filters.jurisdiction ?? null,
    contentType: filters.type ?? null,
    language: filters.language ?? null,
    tag: filters.tag ?? null,
    range: filters.range ?? "latest",
    count: filters.count ?? "none",
  });
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;

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
