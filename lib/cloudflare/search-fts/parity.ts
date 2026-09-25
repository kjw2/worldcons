import type { RankedIdParityReport } from "./types";

/**
 * Evidence-only parity metrics for two ordered ID lists.
 *
 * These are diagnostic counts, not a GO/NO-GO threshold. There is deliberately
 * no `pass`/`ok` field: an operator compares the numbers against a threshold
 * agreed elsewhere, and `search_m7` stays blocked regardless of the output.
 * `exactOrder` and `prefixMatch*` are order-sensitive; `sameSet` and the
 * missing/extra sets are not.
 */
export interface RankedIdParityOptions {
  /** Window size for `overlapAtK`. Defaults to 10. */
  k?: number;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

export function compareRankedIds(
  expected: readonly string[],
  actual: readonly string[],
  options: RankedIdParityOptions = {},
): RankedIdParityReport {
  const k = options.k ?? 10;
  if (!Number.isInteger(k) || k <= 0) {
    throw new RangeError("compareRankedIds k must be a positive integer");
  }

  const prefixLimit = Math.min(expected.length, actual.length);
  let prefixMatchCount = 0;
  for (let index = 0; index < prefixLimit; index += 1) {
    if (expected[index] === actual[index]) prefixMatchCount += 1;
    else break;
  }

  const expectedWindow = new Set(expected.slice(0, k));
  const actualWindow = new Set(actual.slice(0, k));
  let overlapAtKCount = 0;
  for (const id of expectedWindow) if (actualWindow.has(id)) overlapAtKCount += 1;

  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const missing = sortedUnique(expected.filter((id) => !actualSet.has(id)));
  const extra = sortedUnique(actual.filter((id) => !expectedSet.has(id)));

  return {
    expectedCount: expected.length,
    actualCount: actual.length,
    k,
    exactOrder: expected.length === actual.length && prefixMatchCount === expected.length,
    sameSet: missing.length === 0 && extra.length === 0 && expectedSet.size === actualSet.size,
    overlapAtKCount,
    overlapAtK: k > 0 ? overlapAtKCount / k : 0,
    prefixMatchCount,
    prefixMatchRate: expected.length > 0 ? prefixMatchCount / expected.length : 0,
    missing,
    extra,
  };
}
