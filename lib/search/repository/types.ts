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

/** Postgres error evidence surfaced by the search RPCs for caller-side parsing. */
export interface SearchDatabaseErrorEvidence {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
}

export interface CatalogCaseSearchRpcRequest {
  query: string;
  limit: number;
  cursor: string | null;
  source: string | null;
  jurisdiction: string | null;
  contentType: string | null;
  language: string | null;
  tag: string | null;
  range: string;
}

/**
 * Catalog search result union: the raw payload on success, database error
 * evidence so the caller keeps its exact cursor-error parsing, or
 * `unavailable` when no database is configured.
 */
export type CatalogCaseSearchRpcResult =
  | { status: "ok"; data: unknown }
  | { status: "error"; error: SearchDatabaseErrorEvidence }
  | { status: "unavailable" };

export interface FullTextRankedIdsRpcRequest {
  query: string;
  limit: number;
  source: string | null;
  jurisdiction: string | null;
  contentType: string | null;
  language: string | null;
  range: string;
}

export interface VectorMatchRpcRequest {
  embedding: number[];
  matchCount: number;
  source: string | null;
  jurisdiction: string | null;
  contentType: string | null;
  language: string | null;
}

export interface SemanticEmbeddingRowRequest {
  matchCount: number;
  source: string | null;
  jurisdiction: string | null;
  contentType: string | null;
  language: string | null;
  range: ArticleListFilters["range"];
}

/**
 * Platform-neutral contract for the search data-access seam: the ranked-search
 * page RPC, the catalog case-search RPC (with cursor error evidence), the
 * ranked full-text id RPC, the semantic vector-match RPC, the public article
 * embedding-row read, and the exact-case article-id lookup.
 *
 * The contract exposes no Postgres/Supabase types so a future D1 repository can
 * implement it without callers changing. Orchestration, payload/page-info
 * parsing, cursor parsing, legal reranking, embedding creation, cosine
 * similarity, fusion, pagination, fallback ordering, and the `listArticles`
 * re-materialization deliberately stay outside this boundary; the
 * Supabase-backed implementation remains authoritative during M4.
 */
export interface SearchRepository {
  /** Whether a backing database is configured (false for the fail-closed adapter). */
  isConfigured(): boolean;
  /** Raw `worldcons_ranked_search_page_v1` payload, or null when unavailable. */
  rankedSearchPageRpc(request: RankedSearchPageRpcRequest): Promise<unknown | null>;
  /** Raw `worldcons_case_search_page_v2` payload, error evidence, or unavailable. */
  catalogCaseSearchRpc(request: CatalogCaseSearchRpcRequest): Promise<CatalogCaseSearchRpcResult>;
  /** Raw `public_fulltext_ranked_ids_v1` rows, or null when unavailable. */
  fullTextRankedIdsRpc(request: FullTextRankedIdsRpcRequest): Promise<unknown[] | null>;
  /** Raw semantic vector-match rows (`match_public_article_versions_p3`/`match_articles`), or null. */
  vectorMatchRpc(request: VectorMatchRpcRequest): Promise<unknown[] | null>;
  /** Raw public article embedding rows for the local cosine fallback, or null. */
  findSemanticEmbeddingRows(request: SemanticEmbeddingRowRequest): Promise<unknown[] | null>;
  /** Ordered, de-duplicated article ids matching the exact-case references. */
  findExactCaseArticleIds(request: ExactCaseArticleIdRequest): Promise<string[]>;
}
