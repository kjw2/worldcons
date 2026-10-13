/**
 * WorldCons P2-M3 Germany (de-bverfg) staged-cutover readiness gate.
 *
 * This is a pure, runtime-neutral, FAIL-CLOSED evaluator. It exists so the
 * Germany ownership switchover (adding `de-bverfg` to the staged source
 * allowlist and to the legacy M8 crawler exclusion *in the same deploy*) can
 * never be performed on recorded `collection.publishable=1` legacy markers or
 * on the mere existence of a code path. Every gate must be backed by a real,
 * newly observed Production proof:
 *
 *   1. a newly discovered German candidate whose official ECLI/decision body
 *      was actually fetched from the official BVerfG host,
 *   2. the fetched final official URL identity matched the discovered ECLI,
 *   3. one full seven-stage Production E2E for that German article completed,
 *   4. Core holds verified official source text plus summary/translation,
 *   5. an immutable P3 `published` version exists for that article,
 *   6. the Search projection (and FTS) row exists for it.
 *
 * When any gate is missing/false the evaluator returns `ready=false` and the
 * cutover planner refuses to emit a mutation. It never reads the network or the
 * database; callers supply the observed proof. This module is intentionally
 * inert until an operator has genuine evidence.
 */

export const GERMANY_SOURCE_KEY = "de-bverfg" as const;

export interface GermanyCutoverProof {
  /** A new German candidate's official ECLI/body was fetched from the official host. */
  officialEcliFetched: boolean;
  /** The official final URL identity exactly matched the discovered ECLI. */
  ecliIdentityExact: boolean;
  /** One full Discovery->Search seven-stage Production E2E completed for a German article. */
  sevenStageE2E: boolean;
  /** Core holds verified official source text plus summary/translation for that article. */
  coreVerifiedContent: boolean;
  /** An immutable P3 `published` version exists for that article. */
  p3Published: boolean;
  /** The Search projection (and FTS) row exists for that article. */
  searchProjected: boolean;
}

export const GERMANY_CUTOVER_GATES = [
  "official_ecli_fetched",
  "ecli_identity_exact",
  "seven_stage_e2e",
  "core_verified_content",
  "p3_published",
  "search_projected",
] as const;

export type GermanyCutoverGate = (typeof GERMANY_CUTOVER_GATES)[number];

const GATE_TO_PROOF: Readonly<Record<GermanyCutoverGate, keyof GermanyCutoverProof>> = {
  official_ecli_fetched: "officialEcliFetched",
  ecli_identity_exact: "ecliIdentityExact",
  seven_stage_e2e: "sevenStageE2E",
  core_verified_content: "coreVerifiedContent",
  p3_published: "p3Published",
  search_projected: "searchProjected",
};

export interface GermanyCutoverReadiness {
  source: typeof GERMANY_SOURCE_KEY;
  ready: boolean;
  gates: ReadonlyArray<{ id: GermanyCutoverGate; required: true; passed: boolean }>;
  blockers: readonly string[];
}

/**
 * Evaluates the Germany cutover proof. Anything other than an explicit `true`
 * on every gate (including a missing/partial/undefined object) fails closed.
 */
export function evaluateGermanyCutoverReadiness(
  proof: Partial<GermanyCutoverProof> | null | undefined,
): GermanyCutoverReadiness {
  const gates = GERMANY_CUTOVER_GATES.map((id) => ({
    id,
    required: true as const,
    passed: proof?.[GATE_TO_PROOF[id]] === true,
  }));
  const blockers = gates.filter((gate) => !gate.passed).map((gate) => `germany_cutover.${gate.id}_not_observed`);
  return {
    source: GERMANY_SOURCE_KEY,
    ready: blockers.length === 0,
    gates,
    blockers,
  };
}

export interface GermanyCutoverOwnership {
  /** Current staged source allowlist (exact native keys). */
  stagedAllowlist: readonly string[];
  /** Current legacy M8 crawler exclusion (exact native keys). */
  m8Exclude: readonly string[];
}

function appendOnce(list: readonly string[], value: string): string[] {
  return [...new Set([...list, value])];
}

export interface GermanyCutoverPlan {
  source: typeof GERMANY_SOURCE_KEY;
  authorized: boolean;
  readiness: GermanyCutoverReadiness;
  /** Paired staged allowlist value to apply (empty when not authorized). */
  plannedAllowlist: string;
  /** Paired M8 crawler exclusion value to apply (empty when not authorized). */
  plannedExclude: string;
  /** Exact values to restore on rollback (captured regardless of authorization). */
  rollback: { allowlist: string; exclude: string };
  reason?: string;
}

/**
 * Computes the exact paired allowlist/exclude mutation for a Germany cutover.
 *
 * The cutover is authorized ONLY when the readiness gate is fully satisfied.
 * Otherwise it returns `authorized=false`, emits no planned mutation, and still
 * captures the current values as the rollback target. The staged allowlist and
 * the M8 exclusion always move together to the same value.
 */
export function planGermanyCutover(
  proof: Partial<GermanyCutoverProof> | null | undefined,
  current: GermanyCutoverOwnership,
): GermanyCutoverPlan {
  const readiness = evaluateGermanyCutoverReadiness(proof);
  const rollback = {
    allowlist: current.stagedAllowlist.join(","),
    exclude: current.m8Exclude.join(","),
  };
  if (!readiness.ready) {
    return {
      source: GERMANY_SOURCE_KEY,
      authorized: false,
      readiness,
      plannedAllowlist: "",
      plannedExclude: "",
      rollback,
      reason: readiness.blockers[0],
    };
  }
  return {
    source: GERMANY_SOURCE_KEY,
    authorized: true,
    readiness,
    plannedAllowlist: appendOnce(current.stagedAllowlist, GERMANY_SOURCE_KEY).join(","),
    plannedExclude: appendOnce(current.m8Exclude, GERMANY_SOURCE_KEY).join(","),
    rollback,
  };
}
