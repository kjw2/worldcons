/**
 * Fail-closed error surface for the M7.4 Vectorize semantic/hybrid foundation.
 *
 * Every malformed artifact, unsafe plan, unsupported branch or malformed
 * Vectorize response raises a typed `SearchVectorError` with a stable code
 * instead of being coerced, approximated or silently dropped.
 */
export type SearchVectorErrorCode =
  | "invalid_artifact"
  | "duplicate_artifact"
  | "duplicate_vector_id"
  | "invalid_embedding"
  | "embedding_required"
  | "tag_filter_deferred"
  | "vector_exact_count_deferred"
  | "vector_window_exceeded"
  | "vectorize_unavailable"
  | "invalid_response"
  | "query_failed"
  | "invalid_projection";

export class SearchVectorError extends Error {
  readonly code: SearchVectorErrorCode;

  constructor(code: SearchVectorErrorCode, message?: string) {
    super(message ?? code);
    this.name = "SearchVectorError";
    this.code = code;
  }
}

export function vectorError(code: SearchVectorErrorCode, message?: string): SearchVectorError {
  return new SearchVectorError(code, message);
}

/**
 * Stable deferred codes and messages for the current Vectorize constraints.
 * These are deliberately NOT approximations:
 * - `p_tag` cannot be applied to a Vectorize metadata filter because tag metadata
 *   is an array and arrays are not currently indexable/filterable, and post-filtering
 *   the topK window would fabricate a different page than Postgres.
 * - an exact COUNT cannot be derived from a Vectorize query because the query only
 *   returns the nearest topK, not the full matching set.
 * - the local no-values/indexed-metadata Vectorize query caps topK at 100.
 */
export const SEARCH_VECTOR_TAG_DEFERRED_MESSAGE =
  "TAG_FILTER_DEFERRED: p_tag cannot be applied on a Vectorize semantic/hybrid query (array metadata is not filterable); not approximated by post-filtering topK";

export const SEARCH_VECTOR_EXACT_COUNT_DEFERRED_MESSAGE =
  "VECTOR_EXACT_COUNT_DEFERRED: count=exact is not derivable from a Vectorize topK query; not fabricated";

export const SEARCH_VECTOR_WINDOW_EXCEEDED_MESSAGE =
  "VECTOR_WINDOW_EXCEEDED: the required candidate/topK window exceeds the Vectorize no-values/indexed-metadata maximum of 100";

export const SEARCH_VECTOR_UNAVAILABLE_MESSAGE =
  "VECTORIZE_UNAVAILABLE: no Vectorize binding is available for a non-exact semantic/hybrid request; lexical fallback is not allowed";

export const SEARCH_VECTOR_EMBEDDING_REQUIRED_MESSAGE =
  "WORLDCONS_SEARCH_EMBEDDING_REQUIRED: a non-exact semantic/hybrid request requires a 1536-d query embedding";

export const SEARCH_VECTOR_TAG_DEFERRED_CODE = "tag_filter_deferred" as const;
export const SEARCH_VECTOR_EXACT_COUNT_DEFERRED_CODE = "vector_exact_count_deferred" as const;
export const SEARCH_VECTOR_WINDOW_EXCEEDED_CODE = "vector_window_exceeded" as const;
export const SEARCH_VECTOR_UNAVAILABLE_CODE = "vectorize_unavailable" as const;
export const SEARCH_VECTOR_EMBEDDING_REQUIRED_CODE = "embedding_required" as const;
