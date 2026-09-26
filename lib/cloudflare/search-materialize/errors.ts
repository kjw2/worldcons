/**
 * Fail-closed error surface for the M7.5 remote search materialization operator.
 *
 * Supabase remains the sole search authority. Every ambiguity (an unstable
 * source page, a remote identity mismatch, an out-of-scope statement, a missing
 * confirmation) raises a typed `SearchMaterializeError` with a stable code. The
 * message carries relation/offset/identifier context only and never raw source
 * rows, search text, URLs, embeddings or credentials.
 */
export type SearchMaterializeErrorCode =
  | "source_page_failed"
  | "source_safe_max_exceeded"
  | "source_mutation_detected"
  | "source_row_invalid"
  | "cloudflare_preflight_failed"
  | "d1_current_duplicate"
  | "d1_current_identity_mismatch"
  | "d1_statement_out_of_scope"
  | "d1_apply_failed"
  | "d1_verification_failed"
  | "d1_snapshot_invalid"
  | "d1_confirmation_required"
  | "vector_index_mismatch"
  | "vector_metadata_index_mismatch"
  | "vector_completeness_refused"
  | "vector_apply_failed"
  | "vector_mutation_timeout"
  | "vector_verification_failed"
  | "vector_confirmation_required"
  | "vector_index_missing"
  | "vector_response_invalid";

export class SearchMaterializeError extends Error {
  readonly code: SearchMaterializeErrorCode;

  constructor(code: SearchMaterializeErrorCode, detail?: string) {
    super(detail === undefined || detail.length === 0 ? code : `${code}: ${detail}`);
    this.name = "SearchMaterializeError";
    this.code = code;
  }
}

export function materializeError(code: SearchMaterializeErrorCode, detail?: string): SearchMaterializeError {
  return new SearchMaterializeError(code, detail);
}

/** Extracts a bounded message without ever echoing a raw payload. */
export function boundedMessage(error: unknown): string {
  if (error instanceof SearchMaterializeError || error instanceof Error) return error.message;
  return String(error);
}
