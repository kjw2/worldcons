/**
 * M7.2 runtime-neutral FTS5 lexical search types.
 *
 * Scope is intentionally the D1 local foundation for
 * `public_fulltext_ranked_ids_v1` only: validate the authored input, compile a
 * safe FTS5 MATCH expression, build one parameterized `search_fts` JOIN
 * `search_documents` query and read it through an injected D1 binding. It does
 * NOT select a D1 search adapter, emit a shadow event or claim query-language,
 * rank or threshold parity with Postgres. Supabase remains the sole search
 * authority.
 *
 * No `node:*` import may appear in this module.
 */

/** The authored RPC name this local foundation mirrors. */
export const SEARCH_FTS_AUTHORITY_RPC = "public_fulltext_ranked_ids_v1" as const;

/** `p_query` trimmed length floor/ceiling (matches the RPC's 200-char guard). */
export const SEARCH_FTS_MAX_QUERY_LENGTH = 200;

/** `p_limit` inclusive bounds (matches the RPC). */
export const SEARCH_FTS_MIN_LIMIT = 1;
export const SEARCH_FTS_MAX_LIMIT = 100;

/** `p_range` enum (matches the RPC). */
export const SEARCH_FTS_RANGES = ["latest", "today", "week", "month"] as const;
export type SearchFtsRange = (typeof SEARCH_FTS_RANGES)[number];

/** Hard-coded, authored table/column names. User text is never an identifier. */
export const SEARCH_FTS_TABLE = "search_fts" as const;
export const SEARCH_FTS_DOCUMENT_TABLE = "search_documents" as const;

/**
 * FTS5 bm25 column weights, in `search_fts` column order
 * (`article_id`, `title`, `case_numbers`, `search_text`, `tags_text`).
 *
 * These are PROVISIONAL local parity-tuning constants. They are NOT an agreed
 * production threshold and they do NOT reproduce the legacy Postgres
 * `ts_rank_cd(..., 32)` weighting. They only have to be deterministic and
 * monotonic for the local D1 foundation.
 */
export const SEARCH_FTS_BM25_WEIGHTS = {
  article_id: 0,
  title: 10,
  case_numbers: 8,
  search_text: 4,
  tags_text: 2,
} as const;

/** A bound SQLite parameter value. Table/column names are never parameters. */
export type SearchFtsParam = string | number;

/** One compiled, parameterized FTS5 query. */
export interface SearchFtsStatement {
  /** Parameterized SQL over `search_fts` JOIN `search_documents`. */
  sql: string;
  /** Bound values, in textual `?` order. Never user text inside `sql`. */
  params: readonly SearchFtsParam[];
  /** The FTS5 MATCH expression bound as the first parameter. */
  matchExpression: string;
  /** Normalized (NFKC/whitespace/case-folded) query text used for exact-title detection. */
  exactQueryText: string;
  limit: number;
  range: SearchFtsRange;
  /** UTC range threshold ISO string, or null for `latest`. */
  rangeThreshold: string | null;
  /** True when the compiled query carries at least one negative clause. */
  hasNegation: boolean;
}

/**
 * Caller input. `referenceNow` is an INJECTED UTC reference instant so the pure
 * builder never reads the wall clock. Filter fields mirror the RPC's optional
 * source/jurisdiction/content_type/language arguments.
 */
export interface SearchFtsQueryInput {
  query: string;
  limit: number;
  range?: string | null;
  source?: string | null;
  jurisdiction?: string | null;
  contentType?: string | null;
  language?: string | null;
  referenceNow: Date | string | number;
}

/** One ranked result row. `relevance_score` is `-bm25(...)` (higher is better). */
export interface SearchFtsRankedRow {
  article_id: string;
  relevance_score: number;
}

/** Evidence-only ordered-list parity report. No pass/fail threshold is claimed. */
export interface RankedIdParityReport {
  expectedCount: number;
  actualCount: number;
  k: number;
  exactOrder: boolean;
  sameSet: boolean;
  overlapAtKCount: number;
  overlapAtK: number;
  prefixMatchCount: number;
  prefixMatchRate: number;
  missing: string[];
  extra: string[];
}
