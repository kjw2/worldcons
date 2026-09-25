import type { ExactCaseReference } from "@/lib/search/case-number";

/**
 * M7.3 runtime-neutral ranked-search page types.
 *
 * This module mirrors the JSON-compatible contract of
 * `worldcons_ranked_search_page_v1`
 * (`supabase/migrations/20260826400000_case_keys_and_ranked_pagination.sql`) for
 * the exact-case, empty-query latest and fulltext branches only. Semantic/hybrid
 * are deferred and never approximated. No `node:*` import may appear here, and
 * nothing here selects a D1 search adapter or claims production parity.
 */

/** The authored RPC this local foundation mirrors. */
export const RANKED_SEARCH_AUTHORITY_RPC = "worldcons_ranked_search_page_v1" as const;

/** `p_query` trimmed length ceiling (matches the RPC's 200-char guard). */
export const RANKED_SEARCH_MAX_QUERY_LENGTH = 200;

/** `p_limit` inclusive bounds (matches the RPC). */
export const RANKED_SEARCH_MIN_LIMIT = 1;
export const RANKED_SEARCH_MAX_LIMIT = 100;

/** `p_offset` inclusive bounds (matches the RPC). */
export const RANKED_SEARCH_MIN_OFFSET = 0;
export const RANKED_SEARCH_MAX_OFFSET = 10000;

/** `p_mode` enum (matches the RPC). */
export const RANKED_SEARCH_MODES = ["fulltext", "semantic", "hybrid"] as const;
export type RankedSearchMode = (typeof RANKED_SEARCH_MODES)[number];

/** `p_range` enum (matches the RPC). */
export const RANKED_SEARCH_RANGES = ["latest", "today", "week", "month"] as const;
export type RankedSearchRange = (typeof RANKED_SEARCH_RANGES)[number];

/** `p_count` enum (matches the RPC). */
export const RANKED_SEARCH_COUNTS = ["exact", "planned", "estimated", "none"] as const;
export type RankedSearchCount = (typeof RANKED_SEARCH_COUNTS)[number];

/** Retrieval modes this local slice can actually produce. */
export type RankedSearchRetrievalMode = "exact-case" | "latest" | "fulltext";

/** Hard-coded, authored table names. User text is never an identifier. */
export const RANKED_SEARCH_DOCUMENT_TABLE = "search_documents" as const;
export const RANKED_SEARCH_FTS_TABLE = "search_fts" as const;

/** A bound SQLite parameter value. Table/column names are never parameters. */
export type RankedSearchParam = string | number;

/** One parameterized statement over `search_documents` (and `search_fts`). */
export interface RankedSearchStatement {
  sql: string;
  params: readonly RankedSearchParam[];
}

/**
 * Caller input. `referenceNow` is an INJECTED UTC instant so the pure builder
 * never reads the wall clock. Filter fields mirror the RPC's optional
 * source/jurisdiction/content_type/language/tag arguments; `embedding` is
 * accepted structurally but never executed in M7.3.
 */
export interface RankedSearchPageInput {
  query: string;
  mode?: string | null;
  limit?: number | null;
  offset?: number | null;
  source?: string | null;
  jurisdiction?: string | null;
  contentType?: string | null;
  language?: string | null;
  tag?: string | null;
  range?: string | null;
  count?: string | null;
  embedding?: unknown;
  referenceNow: Date | string | number;
}

/** Validated, normalized request. */
export interface RankedSearchResolvedRequest {
  queryText: string;
  mode: RankedSearchMode;
  limit: number;
  offset: number;
  source: string | null;
  jurisdiction: string | null;
  contentType: string | null;
  language: string | null;
  tag: string | null;
  range: RankedSearchRange;
  count: RankedSearchCount;
  hasEmbedding: boolean;
  /** Injected UTC reference instant, in epoch milliseconds. */
  referenceNow: number;
}

/** One ranked result entry. `score` is present only for the fulltext branch. */
export interface RankedSearchEntry {
  id: string;
  score?: number;
}

/** RPC-shaped, JSON-compatible page payload. */
export interface RankedSearchPagePayload {
  entries: RankedSearchEntry[];
  retrievalMode: RankedSearchRetrievalMode;
  total: number;
  hasMore: boolean;
  totalIsExact: boolean;
}

/** The resolved branch for a request. */
export interface RankedSearchQueryPlan {
  retrievalMode: RankedSearchRetrievalMode;
  /**
   * True when `p_source` conflicts with the exact-case reference source. The RPC
   * returns an empty `exact-case` page without reading; M7.3 mirrors that.
   */
  sourceConflict: boolean;
  /** The exact-case reference when the exact-case branch was selected. */
  exactCase: ExactCaseReference | null;
  /** The page query, or `null` when `sourceConflict` short-circuits the read. */
  page: RankedSearchStatement | null;
  /** The separate COUNT query, present only when `p_count = 'exact'`. */
  count: RankedSearchStatement | null;
}

/** One validated page row read from D1. */
export interface RankedSearchPageRow {
  id: string;
  score?: number;
}
