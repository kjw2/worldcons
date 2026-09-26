import type { RankedIdParityReport } from "@/lib/cloudflare/search-fts";
import { aggregateRankComparisons } from "./metrics";
import type { RankStrictTarget } from "./invariants";
import {
  RANK_POLICY_VERSION,
  type RankAggregateMetrics,
  type RankCategoryMetrics,
  type RankCorpusCase,
  type RankCorpusCategory,
  type RankInformationalSummary,
  type RankPolicyBlocker,
  type RankPolicyCaseOutcome,
  type RankPolicyReport,
  type RankPolicyState,
  type RankPolicyThresholds,
  type RankStrictInvariantSummary,
} from "./types";

/**
 * M7.7-B rank policy evaluation (runtime-neutral).
 *
 * Policy rules, in order:
 *
 * 1. any strict exact-case/exact-title invariant failure => `fail`;
 * 2. no evaluable strict case                                  => `insufficient_evidence`;
 * 3. generic lexical cases present with NO independently
 *    pre-registered threshold                                  => `insufficient_evidence`
 *    (the `fulltext_rank_threshold_unagreed` blocker is raised);
 * 4. generic lexical cases present with a threshold that is
 *    not met on any category                                   => `fail`;
 * 5. otherwise                                                 => `pass`.
 *
 * A strict invariant is exact, not numeric: the local top id must belong to the
 * frozen authoritative target set, and the production oracle top id must belong
 * to that same set whenever the production oracle returned a non-empty window.
 * No threshold is ever invented for a generic lexical category.
 */

export interface RankPolicyCaseInput {
  case: RankCorpusCase;
  /** D1 FTS5 observed ranked ids (bounded by the case limit). */
  observedIds: readonly string[];
  /** Production oracle ranked ids over the same like-for-like corpus. */
  oracleIds: readonly string[];
  /** True when a production oracle window was actually queried. */
  oracleCompared: boolean;
  /** Content-free overlap metric (production expected vs D1 actual), or null. */
  metrics: RankedIdParityReport | null;
  /** Frozen/validated strict target, or null when not resolved. */
  target: RankStrictTarget | null;
}

export function evaluateRankPolicyCase(input: RankPolicyCaseInput): RankPolicyCaseOutcome {
  const observedId = input.observedIds.length > 0 ? input.observedIds[0] : null;
  const oracleTopId = input.oracleCompared && input.oracleIds.length > 0 ? input.oracleIds[0] : null;
  const strict = input.case.invariant !== "informational";
  if (!strict) {
    return {
      caseId: input.case.id,
      category: input.case.category,
      invariant: input.case.invariant,
      status: "informational",
      strict: false,
      expectedIds: [],
      observedId,
      oracleTopId,
      oracleCompared: input.oracleCompared,
      metrics: input.metrics,
    };
  }

  const expectedIds = input.target?.expectedIds ?? [];
  if (expectedIds.length === 0) {
    return {
      caseId: input.case.id,
      category: input.case.category,
      invariant: input.case.invariant,
      status: "not_applicable",
      strict: true,
      expectedIds: [],
      observedId,
      oracleTopId,
      oracleCompared: input.oracleCompared,
      metrics: input.metrics,
    };
  }

  // Fail closed: a frozen manifest expected id that no longer resolves against
  // the local authoritative projection is an invariant failure, never a pass.
  if (input.target?.frozen === true && input.target.frozenValidated !== true) {
    return {
      caseId: input.case.id,
      category: input.case.category,
      invariant: input.case.invariant,
      status: "fail",
      strict: true,
      expectedIds: [...expectedIds],
      observedId,
      oracleTopId,
      oracleCompared: input.oracleCompared,
      metrics: input.metrics,
    };
  }

  const localMatches = observedId !== null && expectedIds.includes(observedId);
  const oracleMatches = oracleTopId === null ? true : expectedIds.includes(oracleTopId);
  const passed = localMatches && oracleMatches;
  return {
    caseId: input.case.id,
    category: input.case.category,
    invariant: input.case.invariant,
    status: passed ? "pass" : "fail",
    strict: true,
    expectedIds: [...expectedIds],
    observedId,
    oracleTopId,
    oracleCompared: input.oracleCompared,
    metrics: input.metrics,
  };
}

function hasAnyThreshold(thresholds: RankPolicyThresholds | null | undefined): boolean {
  if (!thresholds) return false;
  return (
    thresholds.minOverlapAtKMacro !== undefined ||
    thresholds.minPrefixMatchMacro !== undefined ||
    thresholds.minExactOrderMacro !== undefined ||
    thresholds.minSameSetMacro !== undefined
  );
}

/** Evaluates the supplied thresholds against one aggregate block. */
export function rankAggregateMeetsThresholds(
  aggregate: RankAggregateMetrics,
  thresholds: RankPolicyThresholds,
): boolean {
  if (thresholds.minOverlapAtKMacro !== undefined && aggregate.overlapAtKMacro < thresholds.minOverlapAtKMacro) {
    return false;
  }
  if (thresholds.minPrefixMatchMacro !== undefined && aggregate.prefixMatchMacro < thresholds.minPrefixMatchMacro) {
    return false;
  }
  if (thresholds.minExactOrderMacro !== undefined && aggregate.exactOrderMacro < thresholds.minExactOrderMacro) {
    return false;
  }
  if (thresholds.minSameSetMacro !== undefined && aggregate.sameSetMacro < thresholds.minSameSetMacro) {
    return false;
  }
  return true;
}

function categoryMetrics(
  category: RankCorpusCategory,
  outcomes: readonly RankPolicyCaseOutcome[],
  thresholds: RankPolicyThresholds | null,
  hasThreshold: boolean,
): RankCategoryMetrics {
  const scoped = outcomes.filter((outcome) => outcome.category === category);
  const strictOutcomes = scoped.filter((outcome) => outcome.strict);
  const strictPassed = strictOutcomes.filter((outcome) => outcome.status === "pass").length;
  const strictFailed = strictOutcomes.filter((outcome) => outcome.status === "fail").length;
  const notApplicable = strictOutcomes.filter((outcome) => outcome.status === "not_applicable").length;
  const informational = scoped.filter((outcome) => !outcome.strict);
  const aggregate = aggregateRankComparisons(
    scoped.map((outcome) => outcome.metrics).filter((metric): metric is RankedIdParityReport => metric !== null),
  );

  let thresholdState: RankPolicyState;
  if (category === "exact-case" || category === "exact-title") {
    thresholdState = strictFailed > 0 ? "fail" : strictPassed > 0 ? "pass" : "insufficient_evidence";
  } else if (!hasThreshold || aggregate.compared === 0) {
    thresholdState = "insufficient_evidence";
  } else {
    thresholdState = rankAggregateMeetsThresholds(aggregate, thresholds ?? {}) ? "pass" : "fail";
  }

  return {
    category,
    cases: scoped.length,
    strictCases: strictOutcomes.length - notApplicable,
    strictPassed,
    strictFailed,
    notApplicable,
    compared: informational.filter((outcome) => outcome.metrics !== null).length,
    aggregate,
    hasPreRegisteredThreshold: hasThreshold,
    thresholdState,
  };
}

export interface SummarizeRankPolicyInput {
  corpusHash: string;
  cases: readonly RankCorpusCase[];
  outcomes: readonly RankPolicyCaseOutcome[];
  thresholds?: RankPolicyThresholds | null;
}

export function summarizeRankPolicy(input: SummarizeRankPolicyInput): RankPolicyReport {
  const thresholds = input.thresholds ?? null;
  const hasThreshold = hasAnyThreshold(thresholds);
  const categories = (["exact-case", "exact-title", "multilingual-legal-term", "case-number-identifier", "jurisdiction-source", "cclrag2-shape", "cclmetasearch-shape"] as RankCorpusCategory[]).map(
    (category) => categoryMetrics(category, input.outcomes, thresholds, hasThreshold),
  );

  const strictAll = input.outcomes.filter((outcome) => outcome.strict);
  const passed = strictAll.filter((outcome) => outcome.status === "pass").length;
  const failed = strictAll.filter((outcome) => outcome.status === "fail").length;
  const notApplicable = strictAll.filter((outcome) => outcome.status === "not_applicable").length;
  const evaluable = passed + failed;
  const strict: RankStrictInvariantSummary = {
    cases: passed + failed,
    passed,
    failed,
    notApplicable,
    strictPassRate: evaluable === 0 ? 0 : passed / evaluable,
    exactCaseCases: input.outcomes.filter((outcome) => outcome.category === "exact-case" && outcome.status !== "not_applicable").length,
    exactCasePassed: input.outcomes.filter((outcome) => outcome.category === "exact-case" && outcome.status === "pass").length,
    exactTitleCases: input.outcomes.filter((outcome) => outcome.category === "exact-title" && outcome.status !== "not_applicable").length,
    exactTitlePassed: input.outcomes.filter((outcome) => outcome.category === "exact-title" && outcome.status === "pass").length,
  };

  const informationalOutcomes = input.outcomes.filter((outcome) => !outcome.strict);
  const informational: RankInformationalSummary = {
    cases: informationalOutcomes.length,
    compared: informationalOutcomes.filter((outcome) => outcome.metrics !== null).length,
    hasPreRegisteredThreshold: hasThreshold,
  };

  const informationalCategories = categories.filter(
    (category) => category.category !== "exact-case" && category.category !== "exact-title",
  );
  const informationalWithCases = informationalCategories.filter((category) => category.cases > 0);

  const blockers: RankPolicyBlocker[] = [];
  const thresholdUnagreed = informationalWithCases.length > 0 && !hasThreshold;
  if (thresholdUnagreed) {
    blockers.push({
      code: "fulltext_rank_threshold_unagreed",
      detail:
        `${informational.compared}/${informational.cases} generic lexical fulltext case(s) were compared against production ` +
        "ordering; no independently pre-registered FTS5-bm25-vs-Postgres acceptance threshold exists, so the aggregate " +
        "overlap/prefix/order/set metrics are evidence only and GO-SEARCH stays blocked",
    });
  }
  let state: RankPolicyState;
  if (failed > 0 || categories.some((category) => category.thresholdState === "fail")) {
    state = "fail";
    if (failed > 0) {
      blockers.push({
        code: "rank_policy_strict_invariant_failed",
        detail: `${failed}/${evaluable} strict exact-case/exact-title invariant(s) failed; the exact invariants must hold for 100% of evaluable cases`,
      });
    }
  } else if (evaluable === 0) {
    state = "insufficient_evidence";
    blockers.push({
      code: "rank_policy_no_strict_cases",
      detail: "no exact-case/exact-title target could be resolved against the bounded corpus, so no strict invariant was evaluable",
    });
  } else if (thresholdUnagreed) {
    state = "insufficient_evidence";
  } else if (informationalWithCases.length > 0 && !informationalWithCases.every((category) => category.compared > 0)) {
    state = "insufficient_evidence";
    blockers.push({
      code: "rank_policy_no_comparable_cases",
      detail: "no generic lexical case had a comparable D1/production pair, so a threshold cannot be evaluated",
    });
  } else {
    state = "pass";
  }

  // The exact-case branch is not FTS5-vs-ts_rank_cd ranking; it is the separate
  // M7.3 exact-case retrieval branch. Keep it as a strict safety invariant but
  // exclude its metrics from the lexical rank aggregate.
  const aggregate = aggregateRankComparisons(
    input.outcomes
      .filter((outcome) => outcome.category !== "exact-case")
      .map((outcome) => outcome.metrics)
      .filter((metric): metric is RankedIdParityReport => metric !== null),
  );

  return {
    version: RANK_POLICY_VERSION,
    state,
    corpusHash: input.corpusHash,
    strict,
    informational,
    aggregate,
    categories,
    thresholds: hasThreshold ? thresholds : null,
    blockers,
    outcomes: [...input.outcomes],
  };
}

/**
 * Convenience: evaluate per-case inputs into outcomes, then summarize. The
 * optional thresholds are the ONLY place a generic lexical acceptance number
 * can enter the policy; M7.7-B supplies none.
 */
export function buildRankPolicyReport(
  input: Omit<SummarizeRankPolicyInput, "outcomes"> & { cases: readonly RankCorpusCase[]; caseInputs: readonly RankPolicyCaseInput[] },
): RankPolicyReport {
  const outcomes = input.caseInputs.map((caseInput) => evaluateRankPolicyCase(caseInput));
  return summarizeRankPolicy({
    corpusHash: input.corpusHash,
    cases: input.cases,
    outcomes,
    thresholds: input.thresholds ?? null,
  });
}
