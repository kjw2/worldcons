import { TAG_TOKEN_SEPARATOR, isNonBlankString } from "./canonical";
import type { SearchTagRow } from "./types";

/**
 * M7.3 deterministic tag encoding for the existing `search_documents.tags_text`
 * column (no schema change).
 *
 * The Postgres authority distinguishes an *exact* tag match against the
 * authoritative slug/name values:
 *
 *   item.tags.slug = p_tag OR item.tags.name = p_tag
 *
 * while `normalized_name`/`type` are searchable text only and must never satisfy
 * an exact `p_tag`. A flat `tags_text` cannot express that distinction, so the
 * slug and name values are wrapped in an internal control-character boundary and
 * `normalized_name`/`type` are emitted as plain searchable tokens:
 *
 *   \u0001<slug>\u0001 \u0001<name>\u0001 <normalized_name> <type>
 *
 * The boundary (`U+0001`) is an FTS5 token separator, so the wrapped slug/name
 * remain fully searchable while `instr(tags_text, \u0001<value>\u0001)` gives an
 * exact, case-sensitive value test. The boundary is deliberately NOT followed by
 * a letter/digit marker: such a marker would itself be indexed as a real token,
 * so a single-character query (for example `o`) could match every document.
 *
 * Normalization is deterministic and locale-free (NFKC, control-character strip,
 * trim) and identical at projection and query time. Raw text, R2 content and URLs
 * are never read or emitted. No `node:*` import may appear in this module.
 */

/** Internal exact-value boundary marker. Not a legal user-authored tag value. */
export const TAG_VALUE_BOUNDARY = "\u0001";

/**
 * `tags_text` component separator. Kept as a single space so the FTS5 index sees
 * exactly the same token stream as before and the boundary markers stay adjacent
 * to their values.
 */
export const TAG_COMPONENT_SEPARATOR = TAG_TOKEN_SEPARATOR;

/** NFKC + control-character strip + trim. Case and internal whitespace preserved. */
export function normalizeTagValue(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .trim();
}

/**
 * Deterministic tag ordering: slug, then tag id as a stable tie-breaker. Locale
 * behavior is not relied upon for correctness; the id tie-breaks every collision.
 */
export function sortProjectionTags(tags: readonly SearchTagRow[]): SearchTagRow[] {
  return [...tags].sort((left, right) => {
    const leftSlug = normalizeTagValue(left.slug);
    const rightSlug = normalizeTagValue(right.slug);
    if (leftSlug !== rightSlug) return leftSlug < rightSlug ? -1 : 1;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

/** Authoritative exact-filter values: slug and name only. */
export function exactTagValues(tag: SearchTagRow): string[] {
  return [tag.slug, tag.name]
    .filter(isNonBlankString)
    .map((value) => normalizeTagValue(value))
    .filter((value) => value.length > 0);
}

/** Searchable-only values: normalized_name and type. */
export function searchableTagTokens(tag: SearchTagRow): string[] {
  return [tag.normalized_name, tag.type]
    .filter(isNonBlankString)
    .map((value) => normalizeTagValue(value))
    .filter((value) => value.length > 0);
}

/** Wraps one exact tag value in the control-character boundary. */
export function wrapExactTagValue(value: string): string {
  return `${TAG_VALUE_BOUNDARY}${value}${TAG_VALUE_BOUNDARY}`;
}

/**
 * Builds the exact-tag needle for a `p_tag` filter. Returns `null` when the value
 * is not a non-blank string so callers can fail closed instead of matching the
 * bare boundary pair.
 */
export function buildExactTagNeedle(value: unknown): string | null {
  const normalized = normalizeTagValue(value);
  if (normalized.length === 0) return null;
  return wrapExactTagValue(normalized);
}

/** True when an encoded `tags_text` contains the exact slug/name tag filter. */
export function tagHasExactFilter(encodedTagsText: string | null | undefined, tag: unknown): boolean {
  const needle = buildExactTagNeedle(tag);
  if (needle === null) return false;
  return typeof encodedTagsText === "string" && encodedTagsText.includes(needle);
}

/**
 * Builds the `tags_text` component: exact slug/name values (boundary-wrapped)
 * plus searchable normalized_name/type tokens, in deterministic tag order,
 * deduped.
 */
export function encodeSearchTags(tags: readonly SearchTagRow[]): string {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const tag of sortProjectionTags(tags)) {
    for (const value of exactTagValues(tag)) {
      const wrapped = wrapExactTagValue(value);
      if (seen.has(wrapped)) continue;
      seen.add(wrapped);
      ordered.push(wrapped);
    }
    for (const value of searchableTagTokens(tag)) {
      if (seen.has(value)) continue;
      seen.add(value);
      ordered.push(value);
    }
  }
  return ordered.join(TAG_COMPONENT_SEPARATOR);
}

/** Backwards-compatible alias used by the projection document builder. */
export const projectionTagsText = encodeSearchTags;
