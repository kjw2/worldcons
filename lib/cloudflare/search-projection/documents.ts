import { caseNumberKey, normalizeCaseNumber } from "@/lib/search/case-number";
import {
  CASE_NUMBER_SEPARATOR,
  SEARCH_TEXT_COMPONENT_SEPARATOR,
  TAG_TOKEN_SEPARATOR,
  asMetadataRecord,
  canonicalSummaryText,
  isNonBlankString,
  nullableTrim,
} from "./canonical";
import { searchDocumentChecksum } from "./checksum";
import { projectionError } from "./errors";
import {
  SEARCH_PROJECTION_VERSION,
  type SearchProjectionDocument,
  type SearchProjectionDocumentBody,
  type SearchPublicationP3Row,
  type SearchTagRow,
  type SearchVersionP3Row,
  type SelectedSearchProjectionSource,
} from "./types";

/**
 * Version snapshot -> `search_documents` identity.
 *
 * The authoritative content is `article_content_versions_p3`; base `articles`
 * are never consulted for content. Publication authority is already fixed to
 * `published` by the source selector.
 */

/** Version snapshot fields inspected for case-number-like values (matches P3). */
const CASE_METADATA_KEYS = [
  "caseNumber",
  "case_number",
  "docketNumber",
  "docket_number",
  "docket",
  "decisionNumber",
  "resolutionNumber",
] as const;

/**
 * `display_title`: prefer a non-blank Korean title, then the original title,
 * then the empty string (the column is nullable, FTS5 treats empty as no
 * title). No base-article title is ever considered.
 */
export function projectionDisplayTitle(version: SearchVersionP3Row): string {
  if (isNonBlankString(version.korean_title)) return version.korean_title.trim();
  if (isNonBlankString(version.original_title)) return version.original_title.trim();
  return "";
}

/**
 * `case_numbers`: the canonical stored `case_key` plus every normalized
 * case-number-like value already present in the authoritative version snapshot
 * (never a URL scrape). Deduped and sorted for determinism; the display and
 * canonical-key forms are both retained so M7.2 exact-case filtering can match
 * either.
 */
export function projectionCaseNumbers(version: SearchVersionP3Row): string[] {
  const tokens = new Set<string>();
  if (isNonBlankString(version.case_key)) tokens.add(version.case_key.trim());
  const metadata = asMetadataRecord(version.source_metadata);
  if (metadata) {
    for (const key of CASE_METADATA_KEYS) {
      const raw = metadata[key];
      if (!isNonBlankString(raw)) continue;
      const normalized = normalizeCaseNumber(version.source_key, raw);
      if (normalized) tokens.add(normalized);
      const canonical = caseNumberKey(version.source_key, raw);
      if (canonical) tokens.add(canonical);
    }
  }
  return [...tokens].sort();
}

/** Safe searchable tag tokens: slug/name/normalized_name/type only. */
export function tagSearchTokens(tag: SearchTagRow): string[] {
  return [tag.slug, tag.name, tag.normalized_name, tag.type].filter(isNonBlankString).map((value) => value.trim());
}

/** Deterministic tag ordering: slug, then tag id as a stable tie-breaker. */
export function sortProjectionTags(tags: readonly SearchTagRow[]): SearchTagRow[] {
  return [...tags].sort((left, right) => {
    const bySlug = left.slug.trim().localeCompare(right.slug.trim());
    if (bySlug !== 0) return bySlug;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

/** Builds the `tags_text` component in deterministic tag order. */
export function projectionTagsText(tags: readonly SearchTagRow[]): string {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const tag of sortProjectionTags(tags)) {
    for (const token of tagSearchTokens(tag)) {
      if (seen.has(token)) continue;
      seen.add(token);
      ordered.push(token);
    }
  }
  return ordered.join(TAG_TOKEN_SEPARATOR);
}

/**
 * `search_text`: deterministic concatenation of the authoritative version
 * components: original title, Korean title, cleaned_text, canonicalized
 * summary_json text, institution name and source key label. Raw text/R2 is
 * never fetched or used. Component weights are intentionally NOT applied here;
 * FTS5 rank-weight parity is deferred to M7.2.
 */
export function projectionSearchText(version: SearchVersionP3Row): string {
  const components = [
    version.original_title,
    version.korean_title,
    version.cleaned_text,
    canonicalSummaryText(version.summary_json),
    version.institution_name,
    version.source_key,
  ];
  return components
    .filter(isNonBlankString)
    .map((value) => value.trim())
    .join(SEARCH_TEXT_COMPONENT_SEPARATOR);
}

/**
 * `updated_at` formula: the maximum parseable ISO-8601 timestamp across the
 * publication and version authority inputs (publication created/updated/
 * published, version created/fetched/summarized/original-published). Never the
 * wall clock. Fails closed when no authority timestamp is present.
 */
export function projectionUpdatedAt(publication: SearchPublicationP3Row, version: SearchVersionP3Row): string {
  const candidates = [
    publication.created_at,
    publication.updated_at,
    publication.published_at,
    version.created_at,
    version.fetched_at,
    version.summarized_at,
    version.original_published_at,
  ];
  let latest: number | null = null;
  for (const candidate of candidates) {
    if (!isNonBlankString(candidate)) continue;
    const parsed = Date.parse(candidate);
    if (!Number.isFinite(parsed)) continue;
    if (latest === null || parsed > latest) latest = parsed;
  }
  if (latest === null) {
    throw projectionError(
      "missing_updated_at",
      `no parseable authority timestamp for article ${version.article_id}`,
      version.article_id,
    );
  }
  return new Date(latest).toISOString();
}

/** Builds one deterministic `search_documents` row from a selected source. */
export function buildSearchProjectionDocument(source: SelectedSearchProjectionSource): SearchProjectionDocument {
  const { publication, version, reviewState, tags } = source;
  const caseNumbers = projectionCaseNumbers(version);
  const body: SearchProjectionDocumentBody = {
    article_id: version.article_id,
    jurisdiction: nullableTrim(version.jurisdiction),
    source_key: nullableTrim(version.source_key),
    language: nullableTrim(version.original_language),
    content_type: nullableTrim(version.content_type),
    publication_state: "published",
    review_state: reviewState,
    original_published_at: nullableTrim(version.original_published_at),
    display_title: projectionDisplayTitle(version),
    case_numbers: caseNumbers.join(CASE_NUMBER_SEPARATOR),
    search_text: projectionSearchText(version),
    tags_text: projectionTagsText(tags),
    projection_version: SEARCH_PROJECTION_VERSION,
    updated_at: projectionUpdatedAt(publication, version),
  };
  return { ...body, checksum: searchDocumentChecksum(body) };
}
