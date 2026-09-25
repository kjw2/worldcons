/**
 * Fail-closed error surface for the M7.2 FTS5 lexical foundation.
 *
 * Every malformed input, unsafe query or malformed D1 response raises a typed
 * `SearchFtsError` with a stable code instead of being coerced or silently
 * dropped.
 */
export type SearchFtsErrorCode =
  | "invalid_query"
  | "invalid_limit"
  | "invalid_range"
  | "invalid_filter"
  | "invalid_clock"
  | "empty_query"
  | "malformed_query"
  | "negative_only"
  | "invalid_response"
  | "query_failed"
  | "unavailable";

export class SearchFtsError extends Error {
  readonly code: SearchFtsErrorCode;

  constructor(code: SearchFtsErrorCode, message?: string) {
    super(message ?? code);
    this.name = "SearchFtsError";
    this.code = code;
  }
}

export function ftsError(code: SearchFtsErrorCode, message?: string): SearchFtsError {
  return new SearchFtsError(code, message);
}
