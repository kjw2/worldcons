import type { RankCorpusCase } from "./types";
import type { RankStrictTarget } from "./invariants";
import { RANK_POLICY_INVARIANTS, type RankPolicyInvariant } from "./decision";

/**
 * M7.8-B product-neutral equivalence invariant evaluation (runtime-neutral).
 *
 * This module evaluates ONLY the four candidate-coverage-equivalence invariants
 * a human may sign as a non-numeric acceptance policy:
 *
 * - E1: the strict exact-case/exact-title invariants hold for 100% of evaluable
 *   strict holdout cases (the local authoritative top id belongs to the frozen
 *   target set, and the production oracle top id does too whenever the oracle
 *   window is non-empty);
 * - E2: whenever production returned a non-empty window, the production top-1 id
 *   appears anywhere in the local first-page top `limit`;
 * - E3: every local returned id belongs to the same prevalidated scope/filter id
 *   set (no scope leak outside the case's own filter scope);
 * - E4: the local window is non-empty iff the production window is non-empty.
 *
 * Exact-order, same-set and overlap remain INFORMATIONAL: they are reported but
 * NEVER gate candidate-coverage-equivalence mode. The result is content-free:
 * counts and pass/fail only, plus the ids are never copied into the result.
 */

export interface EquivalenceCaseInput {
  case: RankCorpusCase;
  /** Local (D1 FTS5 / ranked) observed ids over the case limit. */
  observedIds: readonly string[];
  /** Production oracle ids over the like-for-like scope. */
  oracleIds: readonly string[];
  /** True when a production oracle window was actually queried. */
  oracleCompared: boolean;
  /** Frozen/validated strict target, or null for informational cases. */
  target: RankStrictTarget | null;
  /**
   * The prevalidated scope/filter id set for E3: the exact id set the case's
   * filters are allowed to return. Every local id must belong to it. When null
   * the case is informational and E3 is not applicable.
   */
  scopeIds: ReadonlySet<string> | null;
}

export interface EquivalenceCaseResult {
  caseId: string;
  category: string;
  invariant: RankPolicyInvariant[];
  /** Per-invariant pass/fail (only the invariants applicable to this case). */
  e1: boolean | null;
  e2: boolean | null;
  e3: boolean | null;
  e4: boolean | null;
}

export interface EquivalenceInvariantCounts {
  /** Number of cases where the invariant was applicable. */
  applicable: number;
  passed: number;
  failed: number;
}

export interface EquivalenceReport {
  policy: "candidate-coverage-equivalence";
  invariants: typeof RANK_POLICY_INVARIANTS;
  cases: number;
  /** Per-invariant applicable/passed/failed counts. */
  counts: Record<RankPolicyInvariant, EquivalenceInvariantCounts>;
  /** True only when EVERY applicable invariant passed with no failures. */
  passed: boolean;
  failures: string[];
}

const EMPTY_COUNTS = (): Record<RankPolicyInvariant, EquivalenceInvariantCounts> => ({
  E1: { applicable: 0, passed: 0, failed: 0 },
  E2: { applicable: 0, passed: 0, failed: 0 },
  E3: { applicable: 0, passed: 0, failed: 0 },
  E4: { applicable: 0, passed: 0, failed: 0 },
});

/**
 * Evaluates E1 for one strict case: the strict invariant holds (same rule as the
 * M7.7-B `evaluateRankPolicyCase`) whenever the target is frozen+validated and
 * both the local top id and any non-empty production oracle top id belong to the
 * frozen target set. Informational cases are not applicable.
 */
export function evaluateE1(input: EquivalenceCaseInput): boolean | null {
  if (input.case.invariant === "informational") return null;
  const expectedIds = input.target?.expectedIds ?? [];
  if (expectedIds.length === 0) return null;
  if (input.target?.frozen === true && input.target.frozenValidated !== true) return false;
  const observedId = input.observedIds.length > 0 ? input.observedIds[0] : null;
  const oracleTopId = input.oracleCompared && input.oracleIds.length > 0 ? input.oracleIds[0] : null;
  const localMatches = observedId !== null && expectedIds.includes(observedId);
  const oracleMatches = oracleTopId === null ? true : expectedIds.includes(oracleTopId);
  return localMatches && oracleMatches;
}

/**
 * Evaluates E2: the production top-1 id appears anywhere in the local first-page
 * top `limit`. Not applicable when the production window is empty.
 */
export function evaluateE2(input: EquivalenceCaseInput): boolean | null {
  if (!input.oracleCompared || input.oracleIds.length === 0) return null;
  const productionTop = input.oracleIds[0];
  const localWindow = input.observedIds.slice(0, input.case.limit);
  return localWindow.includes(productionTop);
}

/**
 * Evaluates E3: every local id belongs to the prevalidated scope/filter id set.
 * Not applicable when no scope set is supplied.
 */
export function evaluateE3(input: EquivalenceCaseInput): boolean | null {
  if (input.scopeIds === null) return null;
  return input.observedIds.every((id) => input.scopeIds?.has(id) === true);
}

/** Evaluates E4: local non-empty iff production non-empty. */
export function evaluateE4(input: EquivalenceCaseInput): boolean | null {
  const localNonEmpty = input.observedIds.length > 0;
  const productionNonEmpty = input.oracleCompared && input.oracleIds.length > 0;
  return localNonEmpty === productionNonEmpty;
}

export function evaluateEquivalenceCase(input: EquivalenceCaseInput): EquivalenceCaseResult {
  const e1 = evaluateE1(input);
  const e2 = evaluateE2(input);
  const e3 = evaluateE3(input);
  const e4 = evaluateE4(input);
  const invariant: RankPolicyInvariant[] = [];
  if (e1 !== null) invariant.push("E1");
  if (e2 !== null) invariant.push("E2");
  if (e3 !== null) invariant.push("E3");
  if (e4 !== null) invariant.push("E4");
  return {
    caseId: input.case.id,
    category: input.case.category,
    invariant,
    e1,
    e2,
    e3,
    e4,
  };
}

function record(
  counts: Record<RankPolicyInvariant, EquivalenceInvariantCounts>,
  invariant: RankPolicyInvariant,
  value: boolean | null,
): void {
  if (value === null) return;
  counts[invariant].applicable += 1;
  if (value) counts[invariant].passed += 1;
  else counts[invariant].failed += 1;
}

/**
 * Evaluates the whole holdout and returns a content-free pass/fail report.
 * Exact-order/same-set/overlap are deliberately absent: they are informational
 * and never gate this policy.
 */
export function evaluateCandidateCoverageEquivalence(
  inputs: readonly EquivalenceCaseInput[],
): EquivalenceReport {
  const counts = EMPTY_COUNTS();
  const failures: string[] = [];
  const results = inputs.map((input) => evaluateEquivalenceCase(input));
  results.forEach((result, index) => {
    record(counts, "E1", result.e1);
    record(counts, "E2", result.e2);
    record(counts, "E3", result.e3);
    record(counts, "E4", result.e4);
    const input = inputs[index];
    for (const invariant of result.invariant) {
      const value =
        invariant === "E1" ? result.e1 : invariant === "E2" ? result.e2 : invariant === "E3" ? result.e3 : result.e4;
      if (value === false) failures.push(`${invariant}:${input.case.id}`);
    }
  });
  const passed = failures.length === 0 && results.length > 0;
  return {
    policy: "candidate-coverage-equivalence",
    invariants: RANK_POLICY_INVARIANTS,
    cases: results.length,
    counts,
    passed,
    failures,
  };
}
