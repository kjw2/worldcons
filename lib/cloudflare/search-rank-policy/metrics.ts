import type { RankedIdParityReport } from "@/lib/cloudflare/search-fts";
import type { RankAggregateMetrics } from "./types";

/**
 * M7.7-B aggregate evidence metrics (runtime-neutral).
 *
 * These wrap the M7.2 `RankedIdParityReport` list produced by
 * `compareRankedIds` for each corpus case and reduce it to macro
 * (mean-over-cases) overlap@K / prefix / exactOrder / sameSet numbers plus the
 * raw counts. They are evidence only: no pass/fail threshold lives here. A
 * threshold, when one exists at all, is supplied from outside via
 * `RankPolicyThresholds`.
 */

export const EMPTY_RANK_AGGREGATE: RankAggregateMetrics = {
  compared: 0,
  overlapAtKCount: 0,
  overlapAtKMacro: 0,
  prefixMatchCount: 0,
  prefixMatchMacro: 0,
  exactOrderCount: 0,
  exactOrderMacro: 0,
  sameSetCount: 0,
  sameSetMacro: 0,
};

export function aggregateRankComparisons(
  comparisons: readonly RankedIdParityReport[],
): RankAggregateMetrics {
  if (comparisons.length === 0) return { ...EMPTY_RANK_AGGREGATE };
  let overlapAtKCount = 0;
  let overlapAtKMacro = 0;
  let prefixMatchCount = 0;
  let prefixMatchMacro = 0;
  let exactOrderCount = 0;
  let sameSetCount = 0;
  for (const comparison of comparisons) {
    overlapAtKCount += comparison.overlapAtKCount;
    overlapAtKMacro += comparison.overlapAtK;
    prefixMatchCount += comparison.prefixMatchCount;
    prefixMatchMacro += comparison.prefixMatchRate;
    if (comparison.exactOrder) exactOrderCount += 1;
    if (comparison.sameSet) sameSetCount += 1;
  }
  const denominator = comparisons.length;
  return {
    compared: denominator,
    overlapAtKCount,
    overlapAtKMacro: overlapAtKMacro / denominator,
    prefixMatchCount,
    prefixMatchMacro: prefixMatchMacro / denominator,
    exactOrderCount,
    exactOrderMacro: exactOrderCount / denominator,
    sameSetCount,
    sameSetMacro: sameSetCount / denominator,
  };
}
