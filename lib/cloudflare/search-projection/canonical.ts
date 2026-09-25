import { canonicalJson } from "@/lib/backfill/canonical-json";

/**
 * Runtime-neutral canonicalization helpers for the M7.1 search projection.
 *
 * These never import a Node builtin: the projection builder is used by the
 * Worker-safe library and the operator CLI is the only place allowed `node:*`.
 */

/** Stable component separators for the derived searchable text. */
export const SEARCH_TEXT_COMPONENT_SEPARATOR = "\n\n";
export const CASE_NUMBER_SEPARATOR = "\n";
export const TAG_TOKEN_SEPARATOR = " ";

/** True when a value is a non-blank string. */
export function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Trims a non-blank string, otherwise returns null. */
export function nullableTrim(value: unknown): string | null {
  return isNonBlankString(value) ? value.trim() : null;
}

/** A plain (non-array) record, or null. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

/**
 * Parses a possibly JSON-text or object value into a plain record. Returns null
 * for missing, malformed or non-record values.
 */
export function asMetadataRecord(value: unknown): Record<string, unknown> | null {
  const direct = asRecord(value);
  if (direct) return direct;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  try {
    return asRecord(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

/**
 * Canonical text for `summary_json`. Mirrors the legacy `summary_json::text`
 * search component but deterministically: objects/arrays are canonicalized,
 * JSON strings are parsed and re-canonicalized when possible, and any other
 * value falls back to its trimmed string form.
 */
export function canonicalSummaryText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) return "";
    try {
      return canonicalJson(JSON.parse(trimmed));
    } catch {
      return trimmed;
    }
  }
  if (typeof value === "object") return canonicalJson(value);
  return String(value);
}
