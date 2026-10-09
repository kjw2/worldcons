/**
 * Runtime-neutral parser for the `M8_CRAWLER_SOURCE_EXCLUDE` env allowlist.
 *
 * This is the explicit, source-specific ownership split between the legacy M8
 * `crawler-daily` collection path and the staged-ingestion pipeline. It only
 * narrows which native sources the legacy daily crawler still owns; it never
 * disables an M8 *kind* (M8_ENABLED_KINDS is untouched) and it never widens the
 * staged side.
 *
 * Semantics:
 * - An absent/empty value means "no exclusion": every native source stays owned
 *   by the legacy crawler, so this is a safe no-op default.
 * - Comma-separated exact native source keys. Whitespace around entries is
 *   trimmed and empty entries are ignored.
 * - An unknown source key, or a non-empty value that parses to zero entries, is
 *   INVALID (fail closed): the effective source list collapses to empty rather
 *   than silently producing an ambiguous ownership split.
 *
 * An invalid policy makes the legacy `crawler-daily` Workflow collect nothing
 * (and report the misconfiguration) instead of guessing.
 */
export interface M8CrawlerSourcePolicy {
  /** Legacy-owned native sources: the native list minus the excluded set. */
  effective: readonly string[];
  /** Explicitly excluded native sources (empty when the config is invalid). */
  excluded: readonly string[];
  /** Raw env value as supplied. */
  raw: string;
  /** Config validation result; a false value is a permanently closed cutover. */
  valid: boolean;
  /** Human-readable reason when `valid` is false. */
  reason?: string;
}

export function resolveM8CrawlerSourcePolicy(
  raw: string | null | undefined,
  nativeSources: readonly string[],
): M8CrawlerSourcePolicy {
  const value = (raw ?? "").trim();
  if (value === "") {
    return { effective: [...nativeSources], excluded: [], raw: value, valid: true };
  }
  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) {
    return {
      effective: [],
      excluded: [],
      raw: value,
      valid: false,
      reason: "m8.crawler_source_exclude_empty",
    };
  }
  const unknown = entries.filter((entry) => !nativeSources.includes(entry));
  if (unknown.length > 0) {
    return {
      effective: [],
      excluded: [],
      raw: value,
      valid: false,
      reason: `m8.crawler_source_exclude_unknown:${unknown.join("|")}`,
    };
  }
  const excluded = [...new Set(entries)];
  const effective = nativeSources.filter((source) => !excluded.includes(source));
  return { effective, excluded, raw: value, valid: true };
}
