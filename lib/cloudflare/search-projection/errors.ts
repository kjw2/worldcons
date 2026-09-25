/**
 * Fail-closed error surface for the M7.1 search projection.
 *
 * The projection must never silently substitute a base article for version
 * content, pick one of two competing authorities, or drop a malformed tag row.
 * Every ambiguity raises a typed `SearchProjectionError` instead.
 */
export type SearchProjectionErrorCode =
  | "duplicate_publication_id"
  | "duplicate_published_authority"
  | "missing_publication_version"
  | "publication_version_mismatch"
  | "duplicate_version_id"
  | "duplicate_base_article_id"
  | "duplicate_tag_id"
  | "duplicate_article_tag"
  | "missing_tag"
  | "missing_updated_at"
  | "duplicate_fts_document_id"
  | "fts_document_count_mismatch"
  | "missing_fts_document"
  | "extra_fts_document"
  | "fts_document_identity_mismatch";

export class SearchProjectionError extends Error {
  readonly code: SearchProjectionErrorCode;
  readonly articleId: string | null;

  constructor(code: SearchProjectionErrorCode, message: string, articleId: string | null = null) {
    super(message);
    this.name = "SearchProjectionError";
    this.code = code;
    this.articleId = articleId;
  }
}

export function projectionError(
  code: SearchProjectionErrorCode,
  message: string,
  articleId: string | null = null,
): SearchProjectionError {
  return new SearchProjectionError(code, message, articleId);
}
