import type { RankedSearchMode, RankedSearchPagePayload } from "@/lib/cloudflare/search-ranked";
import { compareRankedIds } from "@/lib/cloudflare/search-fts";
import {
  SEARCH_CANARY_DEFAULT_THRESHOLDS,
  type SearchCanaryCase,
  type SearchCanaryExpectation,
  type SearchCanaryMetrics,
  type SearchCanaryModeMetrics,
  type SearchCanaryObservation,
  type SearchCanaryOracleMode,
  type SearchCanaryOracleParity,
  type SearchCanaryRankComparison,
  type SearchCanaryThresholds,
} from "./types";

/**
 * Runtime-neutral canary evaluation + threshold accounting.
 *
 * The evaluator only inspects ids, scores and latencies. It never reads or emits
 * document/search text, so a report is safe to persist. Thresholds are explicit
 * and evaluated per mode; a mode with fewer than `minCasesPerMode` compared cases
 * can never pass.
 */

function entryIds(payload: RankedSearchPagePayload): string[] {
  return payload.entries.map((entry) => entry.id);
}

export function evaluateExpectation(
  expectation: SearchCanaryExpectation,
  payload: RankedSearchPagePayload,
): { ok: boolean; detail: string } {
  const ids = entryIds(payload);
  switch (expectation.kind) {
    case "exact-order": {
      const expected = expectation.ids;
      const observed = ids.slice(0, expected.length);
      const ok = observed.length === expected.length && observed.every((id, index) => id === expected[index]);
      return { ok, detail: ok ? "ordered ids match" : `expected [${expected.join(", ")}] got [${observed.join(", ")}]` };
    }
    case "top-id": {
      const ok = ids.length > 0 && ids[0] === expectation.id;
      return { ok, detail: ok ? "top id matches" : `expected top ${expectation.id} got ${ids[0] ?? "(none)"}` };
    }
    case "contains": {
      const within = ids.slice(0, expectation.withinTop);
      const ok = within.includes(expectation.id);
      return { ok, detail: ok ? `id present within top ${expectation.withinTop}` : `id ${expectation.id} absent from top ${expectation.withinTop}` };
    }
    case "self-top": {
      const top = payload.entries[0];
      if (!top) return { ok: false, detail: "no results" };
      const score = top.semanticSimilarity ?? top.score ?? -1;
      const ok = top.id === expectation.id && score >= expectation.minScore;
      return {
        ok,
        detail: ok ? "self vector ranked first" : `expected ${expectation.id}@>=${expectation.minScore} got ${top.id}@${score}`,
      };
    }
  }
}

export interface EvaluateSearchCanaryCaseInput {
  case: SearchCanaryCase;
  payload: RankedSearchPagePayload;
  latencyMs: number;
  rowReads?: number;
  /** Binding/runtime latency measured through the Worker bindings, when known. */
  bindingLatencyMs?: number | null;
  /** Production oracle page when available; `null`/omitted means not compared. */
  oracle?: RankedSearchPagePayload | null;
  /**
   * Explicit oracle mode. Defaults to `production-rpc` when an oracle page is
   * provided and `none` otherwise, preserving the M7.5 call sites.
   */
  oracleMode?: SearchCanaryOracleMode;
  /** True when artifact-reference mode was forced by production drift. */
  oracleDrift?: boolean;
}

export interface OracleParityOptions {
  /**
   * Whether a lexical top-id divergence is a pass/fail gate. Defaults to `true`
   * to preserve the M7.5 helper contract; `false` yields `"informational"`.
   */
  strict?: boolean;
}

/**
 * A lexical (fulltext) production comparison is only a strict gate when the
 * frozen expectation is top-anchored (the deterministic exact-case `top-id` /
 * `exact-order` forms). Generic lexical title-token cases assert membership
 * (`contains`), and M7.2 explicitly documents that FTS5 bm25 does NOT reproduce
 * Postgres `ts_rank_cd` and claims no rank parity or agreed threshold, so their
 * production ordering is informational rather than a false correctness failure.
 */
export function isStrictLexicalOracle(expectation: SearchCanaryExpectation): boolean {
  return expectation.kind === "top-id" || expectation.kind === "exact-order";
}

/**
 * Oracle parity rule: for a strict lexical comparison the top id must match
 * exactly (a deterministic ranking); a non-strict lexical comparison returns
 * `"informational"` when only the ordering differs. For semantic/hybrid the
 * oracle's top id must appear in the observed page, because Vectorize and
 * pgvector can legitimately re-order near-equal candidates.
 */
export function oracleParity(
  mode: RankedSearchMode,
  observedIds: readonly string[],
  oracleIds: readonly string[],
  options: OracleParityOptions = {},
): SearchCanaryOracleParity {
  if (oracleIds.length === 0) return "absent";
  if (observedIds.length === 0) return "mismatch";
  if (mode === "fulltext") {
    if (observedIds[0] === oracleIds[0]) return "match";
    return options.strict === false ? "informational" : "mismatch";
  }
  return observedIds.includes(oracleIds[0]) ? "match" : "mismatch";
}

export function evaluateSearchCanaryCase(input: EvaluateSearchCanaryCaseInput): SearchCanaryObservation {
  const { case: caseDef, payload } = input;
  const observedIds = entryIds(payload);
  const evaluated = evaluateExpectation(caseDef.expectation, payload);
  const oracleIds = input.oracle ? entryIds(input.oracle) : [];
  const oracleMode: SearchCanaryOracleMode =
    input.oracleMode ?? (input.oracle ? "production-rpc" : "none");
  const strictLexical = caseDef.mode !== "fulltext" || isStrictLexicalOracle(caseDef.expectation);
  const parity: SearchCanaryOracleParity =
    oracleMode === "production-rpc"
      ? oracleParity(caseDef.mode, observedIds, oracleIds, { strict: strictLexical })
      : oracleMode === "artifact-reference"
        ? evaluated.ok
          ? "match"
          : "mismatch"
        : "absent";
  // Rank comparison metrics use the M7.2 evidence helper. They are computed for
  // a production LEXICAL comparison only; `strict` records whether the ordering
  // gates the case (see `isStrictLexicalOracle`).
  const rankComparison: SearchCanaryRankComparison | null =
    oracleMode === "production-rpc" && caseDef.mode === "fulltext" && oracleIds.length > 0
      ? { strict: strictLexical, ...compareRankedIds(oracleIds, observedIds) }
      : null;
  const ok = evaluated.ok && parity !== "mismatch";
  const details: string[] = [];
  if (!evaluated.ok) details.push(evaluated.detail);
  if (parity === "informational" && rankComparison) {
    details.push(
      `lexical rank informational (strict=false), oracle top ${oracleIds[0] ?? "(none)"} vs observed ` +
        `${observedIds[0] ?? "(none)"}, overlap@${rankComparison.k}=${rankComparison.overlapAtKCount}`,
    );
  } else if (parity === "mismatch" && oracleMode === "production-rpc") {
    details.push(`oracle top ${oracleIds[0] ?? "(none)"} vs observed ${observedIds[0] ?? "(none)"}`);
  }
  return {
    caseId: caseDef.id,
    mode: caseDef.mode,
    status: ok ? "pass" : "mismatch",
    latencyMs: input.latencyMs,
    bindingLatencyMs: input.bindingLatencyMs ?? null,
    rowReads: input.rowReads ?? 0,
    topIds: observedIds.slice(0, 10),
    oracleTopIds: oracleIds.slice(0, 10),
    oracleMode,
    oracleDrift: input.oracleDrift ?? false,
    oracleParity: parity,
    rankComparison,
    errorCode: null,
    detail: details.length > 0 ? details.join("; ") : null,
  };
}

export function searchCanaryErrorObservation(params: {
  case: SearchCanaryCase;
  status: "error" | "timeout" | "skipped";
  latencyMs: number;
  errorCode: string;
  detail?: string | null;
  bindingLatencyMs?: number | null;
}): SearchCanaryObservation {
  return {
    caseId: params.case.id,
    mode: params.case.mode,
    status: params.status,
    latencyMs: params.latencyMs,
    bindingLatencyMs: params.bindingLatencyMs ?? null,
    rowReads: 0,
    topIds: [],
    oracleTopIds: [],
    oracleMode: "none",
    oracleDrift: false,
    oracleParity: "absent",
    rankComparison: null,
    errorCode: params.errorCode,
    detail: params.detail ?? null,
  };
}

/** Nearest-rank percentile over a non-empty sorted array of numbers. */
export function percentile(sortedValues: readonly number[], fraction: number): number {
  if (sortedValues.length === 0) return 0;
  const rank = Math.ceil(fraction * sortedValues.length);
  const index = Math.min(sortedValues.length - 1, Math.max(0, rank - 1));
  return sortedValues[index];
}

function latencyPercentiles(values: readonly number[]): { p50: number; p95: number } {
  const sorted = [...values].sort((left, right) => left - right);
  return { p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95) };
}

const MODES: readonly RankedSearchMode[] = ["fulltext", "semantic", "hybrid"];

function modeMetrics(
  mode: RankedSearchMode,
  observations: readonly SearchCanaryObservation[],
  thresholds: SearchCanaryThresholds,
): SearchCanaryModeMetrics {
  const scoped = observations.filter((observation) => observation.mode === mode);
  const compared = scoped.filter((observation) => observation.status === "pass" || observation.status === "mismatch");
  const passed = scoped.filter((observation) => observation.status === "pass").length;
  const mismatched = scoped.filter((observation) => observation.status === "mismatch").length;
  const errored = scoped.filter((observation) => observation.status === "error").length;
  const timedOut = scoped.filter((observation) => observation.status === "timeout").length;
  const skipped = scoped.filter((observation) => observation.status === "skipped").length;
  const denominator = compared.length === 0 ? 1 : compared.length;
  const mismatchRate = mismatched / denominator;
  const errorRate = errored / denominator;
  const timeoutRate = timedOut / denominator;
  const { p50, p95 } = latencyPercentiles(compared.map((observation) => observation.latencyMs));
  const bindingValues = compared
    .map((observation) => observation.bindingLatencyMs)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const binding = latencyPercentiles(bindingValues);
  const oracleCompared = compared.filter((observation) => observation.oracleParity !== "absent").length;
  const oracleMatched = compared.filter((observation) => observation.oracleParity === "match").length;
  const oracleInformational = compared.filter((observation) => observation.oracleParity === "informational").length;
  const enoughCases = compared.length >= thresholds.minCasesPerMode;
  // M7.6 latency policy: when real binding/runtime samples exist they are the
  // SLO gate and operator wall time is evidence only. Operator thresholds gate
  // ONLY the legacy/no-binding case, so an operator-only run is not silently
  // assumed fast and a binding run is not falsely failed by CLI wall time.
  const latencyWithin =
    bindingValues.length > 0
      ? (thresholds.maxBindingLatencyP50Ms === undefined || binding.p50 <= thresholds.maxBindingLatencyP50Ms) &&
        (thresholds.maxBindingLatencyP95Ms === undefined || binding.p95 <= thresholds.maxBindingLatencyP95Ms)
      : p50 <= thresholds.maxLatencyP50Ms && p95 <= thresholds.maxLatencyP95Ms;
  const pass =
    enoughCases &&
    mismatchRate <= thresholds.maxMismatchRate &&
    errorRate <= thresholds.maxErrorRate &&
    timeoutRate <= thresholds.maxTimeoutRate &&
    latencyWithin;
  return {
    mode,
    cases: scoped.length,
    compared: compared.length,
    passed,
    mismatched,
    errored,
    timedOut,
    skipped,
    mismatchRate,
    errorRate,
    timeoutRate,
    latencyP50Ms: p50,
    latencyP95Ms: p95,
    bindingSamples: bindingValues.length,
    bindingLatencyP50Ms: binding.p50,
    bindingLatencyP95Ms: binding.p95,
    rowReads: scoped.reduce((total, observation) => total + observation.rowReads, 0),
    oracleCompared,
    oracleMatched,
    oracleInformational,
    pass,
  };
}

export function summarizeSearchCanary(
  observations: readonly SearchCanaryObservation[],
  thresholds: SearchCanaryThresholds = SEARCH_CANARY_DEFAULT_THRESHOLDS,
): SearchCanaryMetrics {
  const modes = MODES.map((mode) => modeMetrics(mode, observations, thresholds));
  const compared = observations.filter((observation) => observation.status === "pass" || observation.status === "mismatch");
  const { p50, p95 } = latencyPercentiles(compared.map((observation) => observation.latencyMs));
  const bindingValues = compared
    .map((observation) => observation.bindingLatencyMs)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const binding = latencyPercentiles(bindingValues);
  return {
    modes,
    totalCases: observations.length,
    totalCompared: compared.length,
    totalPassed: observations.filter((observation) => observation.status === "pass").length,
    totalRowReads: observations.reduce((total, observation) => total + observation.rowReads, 0),
    latencyP50Ms: p50,
    latencyP95Ms: p95,
    bindingSamples: bindingValues.length,
    bindingLatencyP50Ms: binding.p50,
    bindingLatencyP95Ms: binding.p95,
    pass: modes.every((mode) => mode.pass),
  };
}
