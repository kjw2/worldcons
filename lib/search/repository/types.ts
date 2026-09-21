import type { ArticleListFilters } from "@/lib/db/types";

/** Search retrieval mode forwarded to the ranked-search RPC. */
export type RankedSearchMode = "fulltext" | "semantic" | "hybrid";

/** The public filters the exact-case id lookup applies to every reference. */
export type ExactCaseLookupFilters = Pick<ArticleListFilters, "jurisdiction" | "type" | "language">;

/** A normalized case reference resolved from a query, keyed for indexed lookup. */
export interface ExactCaseLookupReference {
  sourceKey: string;
  caseNumber: string;
  caseKey: string;
}

export interface ExactCaseArticleIdRequest extends ExactCaseLookupFilters {
  references: readonly ExactCaseLookupReference[];
}

export interface RankedSearchPageRpcRequest {
  query: string;
  mode: RankedSearchMode;
  embedding: number[] | null;
  limit: number;
  offset: number;
  source: string | null;
  jurisdiction: string | null;
  contentType: string | null;
  language: string | null;
  tag: string | null;
  range: string;
  count: string;
}

/**
 * Platform-neutral contract for the search data-access seam: the ranked-search
 * page RPC and the exact-case article-id lookup over the public article relation.
 *
 * The contract exposes no Postgres/Supabase types so a future D1 repository can
 * implement it without callers changing. Catalog search, vector search, the
 * ranked re-list, and the payload/page-info parsing deliberately stay outside
 * this boundary; the Supabase-backed implementation remains authoritative
 * during M4.
 */
export interface SearchRepository {
  /** Raw `worldcons_ranked_search_page_v1` payload, or null when unavailable. */
  rankedSearchPageRpc(request: RankedSearchPageRpcRequest): Promise<unknown | null>;
  /** Ordered, de-duplicated article ids matching the exact-case references. */
  findExactCaseArticleIds(request: ExactCaseArticleIdRequest): Promise<string[]>;
}
