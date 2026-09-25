/**
 * M7.2 runtime-neutral Unicode normalization helpers for the FTS5 query
 * compiler and the exact-title sidecar encoding.
 *
 * These never import a Node builtin and never touch the network, so the same
 * functions run inside the Worker and inside local Node tests/CLIs. Every
 * normalization here is deterministic and stateless: no locale-specific
 * casing (`toLocaleLowerCase`) and no wall clock.
 */

/** Applies Unicode NFKC compatibility normalization. */
export function normalizeUnicode(value: string): string {
  return value.normalize("NFKC");
}

/**
 * Replaces C0/C1 control characters (including the internal title boundary
 * marker `U+0001`) with a single space so they can never smuggle structure into
 * the encoded FTS title or the compiled MATCH expression.
 */
export function stripControlCharacters(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ");
}

/** Collapses every run of Unicode whitespace to one space and trims. */
export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

/** NFKC -> control-strip -> whitespace-collapse/trim. Case is preserved. */
export function normalizeFtsText(value: string): string {
  return collapseWhitespace(stripControlCharacters(normalizeUnicode(value)));
}

/** As {@link normalizeFtsText}, then Unicode-default lowercasing. */
export function normalizeFtsTextFolded(value: string): string {
  return normalizeFtsText(value).toLowerCase();
}
