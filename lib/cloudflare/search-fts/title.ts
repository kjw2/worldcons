import { normalizeFtsTextFolded } from "./normalize";

/**
 * Deterministic exact-title encoding for the FTS5 sidecar.
 *
 * `search_documents.display_title` is a single Korean-preferred title, so it
 * cannot represent "query equals the original title" when a Korean title also
 * exists. The M7.2 sidecar therefore writes BOTH authoritative titles into the
 * FTS5 `title` column, each wrapped by an internal control-character boundary:
 *
 *   \u0001<normalized original title>\u0001 \u0001<normalized korean title>\u0001
 *
 * The control characters are FTS5 token separators, so the surrounding words
 * stay searchable, while `instr(title, \u0001<normalized query>\u0001)` gives an
 * exact full-title test for either title without relying on SQLite `lower()` or
 * on how SQLite tokenizes a raw title.
 *
 * The boundary is deliberately NOT followed by a letter/digit marker. Such a
 * marker (for example `\u0001O\u0001`) is itself an FTS5 token, so a
 * single-character query like `o` or `k` would then match every document.
 */

/** Internal boundary marker. Not a legal user-authored title character. */
export const FTS_TITLE_BOUNDARY = "\u0001";

const TITLE_PART_SEPARATOR = " ";

function wrapTitle(normalizedTitle: string): string {
  return `${FTS_TITLE_BOUNDARY}${normalizedTitle}${FTS_TITLE_BOUNDARY}`;
}

/**
 * Normalizes a single title the same way for both projection and query time so
 * the exact comparison is a plain code-point comparison.
 */
export function normalizeFtsTitle(title: string | null | undefined): string {
  if (typeof title !== "string") return "";
  return normalizeFtsTextFolded(title);
}

/**
 * Encodes the authoritative original + Korean titles. Missing/blank titles are
 * omitted; the result is `""` when neither title is present. The same
 * deterministic order is always used, regardless of input order.
 */
export function encodeFtsTitle(
  originalTitle: string | null | undefined,
  koreanTitle: string | null | undefined,
): string {
  const parts: string[] = [];
  const original = normalizeFtsTitle(originalTitle);
  if (original.length > 0) parts.push(wrapTitle(original));
  const korean = normalizeFtsTitle(koreanTitle);
  if (korean.length > 0) parts.push(wrapTitle(korean));
  return parts.join(TITLE_PART_SEPARATOR);
}

/**
 * Builds the exact-title needle for a raw query text. Returns `""` when the
 * normalized query is empty (an empty needle must never be treated as a match).
 */
export function buildFtsExactTitleNeedle(queryText: string): string {
  const normalized = normalizeFtsTitle(queryText);
  if (normalized.length === 0) return "";
  return `${FTS_TITLE_BOUNDARY}${normalized}${FTS_TITLE_BOUNDARY}`;
}

/** True when an encoded FTS title contains the exact normalized query title. */
export function ftsTitleHasExactTitle(encodedTitle: string, queryText: string): boolean {
  const needle = buildFtsExactTitleNeedle(queryText);
  if (needle.length === 0) return false;
  return encodedTitle.includes(needle);
}
