/**
 * Fail-closed error surface for the M7.3 ranked-search page foundation.
 *
 * Every malformed input, unsupported branch or malformed D1 response raises a
 * typed `RankedSearchError` with a stable code instead of being coerced,
 * approximated or silently dropped.
 */
export type RankedSearchErrorCode =
  | "invalid_query"
  | "invalid_mode"
  | "invalid_limit"
  | "invalid_offset"
  | "invalid_count"
  | "invalid_range"
  | "invalid_filter"
  | "invalid_clock"
  | "semantic_deferred"
  | "invalid_response"
  | "query_failed"
  | "unavailable";

export class RankedSearchError extends Error {
  readonly code: RankedSearchErrorCode;

  constructor(code: RankedSearchErrorCode, message?: string) {
    super(message ?? code);
    this.name = "RankedSearchError";
    this.code = code;
  }
}

export function rankedError(code: RankedSearchErrorCode, message?: string): RankedSearchError {
  return new RankedSearchError(code, message);
}

/**
 * Stable deferred code for a non-empty, non-exact `semantic`/`hybrid` request.
 * M7.3 does NOT approximate semantic/hybrid with lexical search; Vectorize is a
 * later slice. The RPC's own `WORLDCONS_SEARCH_EMBEDDING_REQUIRED` only fires
 * when no embedding is supplied, so this code is intentionally distinct and
 * always applies locally until a real semantic branch exists.
 */
export const RANKED_SEARCH_SEMANTIC_DEFERRED_MESSAGE =
  "WORLDCONS_SEARCH_SEMANTIC_DEFERRED: semantic/hybrid retrieval is deferred (M7.3 is local exact/latest/fulltext only)";
