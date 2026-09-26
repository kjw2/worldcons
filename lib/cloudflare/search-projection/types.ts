/**
 * M7.1 search projection foundation types.
 *
 * `worldcons_search` is a disposable, rebuildable projection. This module is the
 * platform-neutral, runtime-safe contract for turning authoritative
 * `article_publications_p3` + `article_content_versions_p3` rows into
 * deterministic `search_documents` rows and parameterized FTS5 synchronization
 * plans. Supabase remains the sole search authority; nothing here reads or
 * writes a remote database.
 *
 * The types deliberately expose only the source columns the projection needs.
 * `article_content_versions_p3.search_vector` and `embedding` are relocated out
 * of the relational schema, so the projection derives searchable text from the
 * source columns and never requires them.
 */

/** The authored projection version constant stored on every projected row. */
export const SEARCH_PROJECTION_VERSION = 1 as const;

/** The only D1 database the projection plan may touch. */
export const SEARCH_PROJECTION_SCOPE = "worldcons_search" as const;

export const SEARCH_DOCUMENT_TABLE = "search_documents" as const;
export const SEARCH_FTS_TABLE = "search_fts" as const;

/** Authored `search_documents` columns, in D1 schema order. */
export const SEARCH_DOCUMENT_COLUMNS = [
  "article_id",
  "jurisdiction",
  "source_key",
  "language",
  "content_type",
  "publication_state",
  "review_state",
  "original_published_at",
  "display_title",
  "case_numbers",
  "search_text",
  "tags_text",
  "projection_version",
  "checksum",
  "updated_at",
] as const;

/** Authored `search_fts` FTS5 columns, in index order. */
export const SEARCH_FTS_COLUMNS = ["article_id", "title", "case_numbers", "search_text", "tags_text"] as const;

/**
 * Legacy search text weights (Korean title A, original title B, cleaned_text C,
 * summary_json D). M7.1 preserves the source components but cannot reproduce
 * Postgres rank weights; FTS5 rank parity belongs to M7.2.
 */
export const SEARCH_TEXT_COMPONENT_WEIGHTS = ["korean_title:A", "original_title:B", "cleaned_text:C", "summary_json:D"] as const;

export type SearchDocumentColumn = (typeof SEARCH_DOCUMENT_COLUMNS)[number];
export type SearchFtsColumn = (typeof SEARCH_FTS_COLUMNS)[number];

/**
 * One sidecar FTS5 index row, one-to-one with a `search_documents` row.
 *
 * `search_documents` keeps its authored shape (a single Korean-preferred
 * `display_title`). This sidecar is the only place both authoritative titles are
 * represented: `title` deterministically encodes normalized variants of the
 * original and Korean titles (see `lib/cloudflare/search-fts/title.ts`), so
 * exact-title detection works for either. The remaining columns mirror the
 * projected document; raw text, URLs and R2 content are never read.
 */
export interface SearchProjectionFtsDocument {
  article_id: string;
  title: string;
  case_numbers: string;
  search_text: string;
  tags_text: string;
}

/** One denormalized `search_documents` row. */
export interface SearchProjectionDocument {
  article_id: string;
  jurisdiction: string | null;
  source_key: string | null;
  language: string | null;
  content_type: string | null;
  publication_state: string;
  review_state: string | null;
  original_published_at: string | null;
  display_title: string | null;
  case_numbers: string | null;
  search_text: string | null;
  tags_text: string | null;
  projection_version: number;
  checksum: string;
  updated_at: string;
}

/** A projected document without its derived checksum. */
export type SearchProjectionDocumentBody = Omit<SearchProjectionDocument, "checksum">;

/** Authoritative `article_publications_p3` row (P3 publication authority). */
export interface SearchPublicationP3Row {
  id: string;
  article_id: string;
  state: string;
  version_id: string;
  revision?: string | number | null;
  published_at?: string | null;
  withdrawn_at?: string | null;
  created_at: string;
  updated_at?: string | null;
}

/** Authoritative `article_content_versions_p3` snapshot row. */
export interface SearchVersionP3Row {
  id: string;
  article_id: string;
  revision?: string | number | null;
  slug?: string | null;
  source_key: string;
  jurisdiction: string;
  institution_name?: string | null;
  content_type: string;
  original_language?: string | null;
  original_title?: string | null;
  korean_title?: string | null;
  original_published_at?: string | null;
  cleaned_text?: string | null;
  summary_json?: unknown;
  source_metadata?: unknown;
  case_key?: string | null;
  created_at: string;
  fetched_at?: string | null;
  summarized_at?: string | null;
  /**
   * M7.4 additive field: the immutable P3 content hash the embedding artifact is
   * provenance-locked to (`article_embedding_artifacts.content_hash`). Optional so
   * the existing M7.1/M7.2/M7.3 projection callers are unchanged; the vector
   * projection requires it to match the current published version.
   */
  content_hash?: string | null;
  /**
   * M7.7-A additive fields mirroring the gate2 `article_content_versions_p3`
   * columns required by the `public_article_projection_p3` eligibility predicate.
   * Optional so existing callers/fixtures are unchanged; they are only read when
   * `SearchProjectionSourceInput.gate2Eligibility` is supplied.
   */
  version_role?: string | null;
  source_anchor_version_id?: string | null;
  /** Gate2 `enrichment_full` source hash; compared to the anchor's `source_content_hash`. */
  enrichment_source_content_hash?: string | null;
  /** Gate2 `source_content_hash`; the authoritative anchor exposes this value. */
  source_content_hash?: string | null;
}

/** One `legacy_version_freshness_classifications_v4` gate2 freshness row. */
export interface SearchLegacyFreshnessRow {
  version_id: string;
  freshness: string;
}

/** One `case_catalog_publications_v1` gate2 catalog publication head row. */
export interface SearchCatalogPublicationV1Row {
  id: string;
  article_id: string;
  state: string;
  source_anchor_version_id: string;
}

/**
 * M7.7-A gate2 public eligibility inputs.
 *
 * Supplying this makes `selectPublishedSearchProjectionSources` apply the exact
 * `public_article_projection_p3` gate2 freshness/catalog predicate. When it is
 * omitted the historical published-only P3 selection is retained so existing
 * local fixtures and canary plans are unchanged; exact gate2 parity is only
 * claimed when these rows are supplied.
 */
export interface SearchProjectionGate2Eligibility {
  legacyFreshnessClassifications: readonly SearchLegacyFreshnessRow[];
  catalogPublications: readonly SearchCatalogPublicationV1Row[];
}

/**
 * Base `articles` row. Only non-authoritative operational metadata is exposed;
 * base article content can never substitute for the version snapshot. Missing
 * base metadata (for example a row for an article that was not exported) leaves
 * `review_state` null and does not change content authority.
 */
export interface SearchBaseArticleRow {
  id: string;
  review_state?: string | null;
}

/** One `tags` row. Only the safe searchable fields are modeled. */
export interface SearchTagRow {
  id: string;
  slug: string;
  name?: string | null;
  normalized_name?: string | null;
  type?: string | null;
}

/** One `article_tags` join row. */
export interface SearchArticleTagRow {
  article_id: string;
  tag_id: string;
  confidence?: number | null;
}

export interface SearchProjectionSourceInput {
  publications: readonly SearchPublicationP3Row[];
  versions: readonly SearchVersionP3Row[];
  articles?: readonly SearchBaseArticleRow[];
  tags?: readonly SearchTagRow[];
  articleTags?: readonly SearchArticleTagRow[];
  /** M7.7-A gate2 eligibility rows; see `SearchProjectionGate2Eligibility`. */
  gate2Eligibility?: SearchProjectionGate2Eligibility;
}

/** A published publication joined to its authoritative version snapshot. */
export interface SelectedSearchProjectionSource {
  publication: SearchPublicationP3Row;
  version: SearchVersionP3Row;
  reviewState: string | null;
  tags: SearchTagRow[];
}

/** Deterministic count/hash manifest over a projected corpus (no text emitted). */
export interface SearchProjectionManifest {
  version: 1;
  documentCount: number;
  projectionVersion: number;
  hash: string;
}

export interface SearchProjectionBuildResult {
  documents: SearchProjectionDocument[];
  /** Sidecar FTS rows, same length/order/article_id as `documents` (1:1). */
  ftsDocuments: SearchProjectionFtsDocument[];
  manifest: SearchProjectionManifest;
}

/** A bound SQLite parameter value. Table/column names are never parameters. */
export type SearchProjectionParam = string | number | null;

export interface SearchProjectionStatement {
  sql: string;
  params: readonly SearchProjectionParam[];
}

export interface SearchProjectionPlanChanges {
  added: number;
  changed: number;
  removed: number;
  unchanged: number;
}

/**
 * A local, not-yet-executed synchronization plan. `atomic` is false because M7.1
 * deliberately does not choose or execute a remote application primitive yet.
 * A later execution slice may use D1 batch transaction semantics after focused
 * failure/rollback verification; this slice never executes remote writes.
 */
export interface SearchProjectionPlan {
  scope: typeof SEARCH_PROJECTION_SCOPE;
  operation: "full-rebuild" | "incremental";
  destructive: boolean;
  atomic: false;
  executionDeferred: true;
  noop: boolean;
  changes: SearchProjectionPlanChanges;
  statements: SearchProjectionStatement[];
}

/** Safe plan view for operator output: statement text and param counts only. */
export interface SearchProjectionPlanSummary {
  scope: typeof SEARCH_PROJECTION_SCOPE;
  operation: "full-rebuild" | "incremental";
  destructive: boolean;
  atomic: false;
  executionDeferred: true;
  noop: boolean;
  changes: SearchProjectionPlanChanges;
  statementCount: number;
  paramCount: number;
  statements: { sql: string; paramCount: number }[];
}

export interface SearchProjectionDocumentRow {
  article_id: string;
  checksum?: string | null;
  projection_version?: number | null;
}

export type SearchProjectionVerificationIssueCode =
  | "duplicate_projected_id"
  | "checksum_mismatch"
  | "projection_version_mismatch"
  | "missing_document"
  | "extra_document"
  | "duplicate_document"
  | "missing_fts"
  | "extra_fts"
  | "duplicate_fts";

export interface SearchProjectionVerificationIssue {
  code: SearchProjectionVerificationIssueCode;
  articleId: string | null;
}

export interface SearchProjectionVerificationInput {
  projected: readonly SearchProjectionDocument[];
  /** Materialized `search_documents` rows, when an operator read is available. */
  documents?: readonly SearchProjectionDocumentRow[];
  /** Materialized `search_fts.article_id` values, when an operator read is available. */
  ftsArticleIds?: readonly string[];
}

export interface SearchProjectionVerificationReport {
  version: 1;
  ok: boolean;
  projectedCount: number;
  documentCount: number;
  ftsCount: number;
  hash: string;
  issues: SearchProjectionVerificationIssue[];
}
