import type { RankedSearchMode, RankedSearchPagePayload } from "@/lib/cloudflare/search-ranked";
import {
  SEARCH_CANARY_DEFAULT_THRESHOLDS,
  type SearchCanaryCase,
  type SearchCanaryExpectation,
  type SearchCanaryMetrics,
  type SearchCanaryModeMetrics,
  type SearchCanaryObservation,
  type SearchCanaryOracleParity,
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

function evaluateExpectation(
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
  /** Production oracle page when available; `null`/omitted means not compared. */
  oracle?: RankedSearchPagePayload | null;
}

/**
 * Oracle parity rule: for lexical modes the top id must match exactly (a
 * deterministic lexical ranking); for semantic/hybrid the oracle's top id must
 * appear in the observed page, because Vectorize and pgvector can legitimately
 * re-order near-equal candidates.
 */
export function oracleParity(
  mode: RankedSearchMode,
  observedIds: readonly string[],
  oracleIds: readonly string[],
): SearchCanaryOracleParity {
  if (oracleIds.length === 0) return "absent";
  if (observedIds.length === 0) return "mismatch";
  if (mode === "fulltext") return observedIds[0] === oracleIds[0] ? "match" : "mismatch";
  return observedIds.includes(oracleIds[0]) ? "match" : "mismatch";
}

export function evaluateSearchCanaryCase(input: EvaluateSearchCanaryCaseInput): SearchCanaryObservation {
  const { case: caseDef, payload } = input;
  const observedIds = entryIds(payload);
  const evaluated = evaluateExpectation(caseDef.expectation, payload);
  const oracleIds = input.oracle ? entryIds(input.oracle) : [];
  const parity = oracleParity(caseDef.mode, observedIds, oracleIds);
  const ok = evaluated.ok && parity !== "mismatch";
  const details: string[] = [];
  if (!evaluated.ok) details.push(evaluated.detail);
  if (parity === "mismatch") details.push(`oracle top ${oracleIds[0] ?? "(none)"} vs observed ${observedIds[0] ?? "(none)"}`);
  return {
    caseId: caseDef.id,
    mode: caseDef.mode,
    status: ok ? "pass" : "mismatch",
    latencyMs: input.latencyMs,
    rowReads: input.rowReads ?? 0,
    topIds: observedIds.slice(0, 10),
    oracleTopIds: oracleIds.slice(0, 10),
    oracleParity: parity,
    errorCode: null,
    detail: ok ? null : details.join("; "),
  };
}

export function searchCanaryErrorObservation(params: {
  case: SearchCanaryCase;
  status: "error" | "timeout" | "skipped";
  latencyMs: number;
  errorCode: string;
  detail?: string | null;
}): SearchCanaryObservation {
  return {
    caseId: params.case.id,
    mode: params.case.mode,
    status: params.status,
    latencyMs: params.latencyMs,
    rowReads: 0,
    topIds: [],
    oracleTopIds: [],
    oracleParity: "absent",
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
  const oracleCompared = compared.filter((observation) => observation.oracleParity !== "absent").length;
  const oracleMatched = compared.filter((observation) => observation.oracleParity === "match").length;
  const enoughCases = compared.length >= thresholds.minCasesPerMode;
  const pass =
    enoughCases &&
    mismatchRate <= thresholds.maxMismatchRate &&
    errorRate <= thresholds.maxErrorRate &&
    timeoutRate <= thresholds.maxTimeoutRate &&
    p50 <= thresholds.maxLatencyP50Ms &&
    p95 <= thresholds.maxLatencyP95Ms;
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
    rowReads: scoped.reduce((total, observation) => total + observation.rowReads, 0),
    oracleCompared,
    oracleMatched,
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
  return {
    modes,
    totalCases: observations.length,
    totalCompared: compared.length,
    totalPassed: observations.filter((observation) => observation.status === "pass").length,
    totalRowReads: observations.reduce((total, observation) => total + observation.rowReads, 0),
    latencyP50Ms: p50,
    latencyP95Ms: p95,
    pass: modes.every((mode) => mode.pass),
  };
}
