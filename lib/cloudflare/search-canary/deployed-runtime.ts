import { canonicalJson } from "@/lib/backfill/canonical-json";
import { shadowDigest } from "@/lib/cloudflare/d1/shadow/digest";
import { primaryCaseReference, type RankedSearchMode } from "@/lib/cloudflare/search-ranked";
import type { SearchCanaryCase } from "./types";

export const DEPLOYED_SEARCH_CANARY_WORKER = "worldcons-search-canary";
export const DEPLOYED_SEARCH_CANARY_ENDPOINT = "https://worldcons-search-canary.cclib.workers.dev";
export const DEPLOYED_SEARCH_CANARY_MAX_ARTICLES = 100;
export const DEPLOYED_SEARCH_CANARY_MAX_CASES_PER_MODE = 2;

export interface DeployedRuntimeResult {
  caseId: string;
  latencyMs: number;
  topIds: string[];
  retrievalMode: string | null;
  errorCode: string | null;
}

export interface DeployedRuntimeObservation {
  caseId: string;
  mode: RankedSearchMode;
  status: "pass" | "mismatch" | "error";
  latencyMs: number;
  errorCode: string | null;
}

export interface DeployedRuntimeModeMetrics {
  mode: RankedSearchMode;
  cases: number;
  passed: number;
  mismatched: number;
  errored: number;
  mismatchRate: number;
  errorRate: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  pass: boolean;
}

export interface DeployedRuntimeReport {
  version: 1;
  generatedAt: string;
  scope: "deployed-search-canary-runtime";
  worker: typeof DEPLOYED_SEARCH_CANARY_WORKER;
  endpointHost: "worldcons-search-canary.cclib.workers.dev";
  source: "supabase";
  maxArticles: typeof DEPLOYED_SEARCH_CANARY_MAX_ARTICLES;
  projection: {
    documents: number;
    vectorRecords: number;
    missingArtifacts: number;
    staleArtifacts: number;
  };
  cases: number;
  observations: DeployedRuntimeObservation[];
  modes: DeployedRuntimeModeMetrics[];
  latencyP50Ms: number;
  latencyP95Ms: number;
  state: "pass" | "fail";
  blockers: Array<{ code: string; detail: string }>;
  stableHash: string;
  boundaries: string[];
}

const MODES: readonly RankedSearchMode[] = ["fulltext", "semantic", "hybrid"];
const MAX_P50_MS = 500;
const MAX_P95_MS = 1500;

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.ceil(sorted.length * fraction);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!;
}

function expectationPasses(caseDef: SearchCanaryCase, topIds: readonly string[]): boolean {
  const expectation = caseDef.expectation;
  if (expectation.kind === "exact-order") {
    return expectation.ids.every((id, index) => topIds[index] === id);
  }
  if (expectation.kind === "top-id") return topIds[0] === expectation.id;
  if (expectation.kind === "contains") return topIds.slice(0, expectation.withinTop).includes(expectation.id);
  return topIds[0] === expectation.id;
}

function expectedRetrievalMode(caseDef: SearchCanaryCase): string {
  // Ranked search resolves recognized case references before the requested
  // lexical/semantic mode. The frozen canary intentionally classifies these
  // cases under the fulltext gate, while the runtime truthfully reports the
  // narrower `exact-case` branch.
  if (primaryCaseReference(caseDef.query) !== null) return "exact-case";
  if (caseDef.query.trim() === "") return "latest";
  return caseDef.mode;
}

function observe(
  caseDef: SearchCanaryCase,
  result: DeployedRuntimeResult | null,
): DeployedRuntimeObservation {
  if (result === null) {
    return { caseId: caseDef.id, mode: caseDef.mode, status: "error", latencyMs: 0, errorCode: "missing_observation" };
  }
  if (result.errorCode !== null) {
    return {
      caseId: caseDef.id,
      mode: caseDef.mode,
      status: "error",
      latencyMs: result.latencyMs,
      errorCode: result.errorCode,
    };
  }
  const modeMatches = result.retrievalMode === expectedRetrievalMode(caseDef);
  const expectationMatches = expectationPasses(caseDef, result.topIds);
  return {
    caseId: caseDef.id,
    mode: caseDef.mode,
    status: modeMatches && expectationMatches ? "pass" : "mismatch",
    latencyMs: result.latencyMs,
    errorCode: modeMatches ? (expectationMatches ? null : "expectation_mismatch") : "retrieval_mode_mismatch",
  };
}

function summarizeMode(mode: RankedSearchMode, observations: readonly DeployedRuntimeObservation[]): DeployedRuntimeModeMetrics {
  const scoped = observations.filter((observation) => observation.mode === mode);
  const passed = scoped.filter((observation) => observation.status === "pass").length;
  const mismatched = scoped.filter((observation) => observation.status === "mismatch").length;
  const errored = scoped.filter((observation) => observation.status === "error").length;
  const denominator = scoped.length === 0 ? 1 : scoped.length;
  const latency = scoped.filter((observation) => observation.status !== "error").map((observation) => observation.latencyMs);
  const latencyP50Ms = percentile(latency, 0.5);
  const latencyP95Ms = percentile(latency, 0.95);
  const pass =
    scoped.length > 0 &&
    passed === scoped.length &&
    mismatched === 0 &&
    errored === 0 &&
    latencyP50Ms <= MAX_P50_MS &&
    latencyP95Ms <= MAX_P95_MS;
  return {
    mode,
    cases: scoped.length,
    passed,
    mismatched,
    errored,
    mismatchRate: mismatched / denominator,
    errorRate: errored / denominator,
    latencyP50Ms,
    latencyP95Ms,
    pass,
  };
}

export function buildDeployedRuntimeReport(input: {
  generatedAt: string;
  cases: readonly SearchCanaryCase[];
  results: readonly DeployedRuntimeResult[];
  projection: DeployedRuntimeReport["projection"];
}): DeployedRuntimeReport {
  const byId = new Map<string, DeployedRuntimeResult>();
  const duplicateIds = new Set<string>();
  for (const result of input.results) {
    if (byId.has(result.caseId)) duplicateIds.add(result.caseId);
    byId.set(result.caseId, result);
  }
  const rawObservations = input.cases.map((caseDef) => observe(caseDef, byId.get(caseDef.id) ?? null));
  const modeOrdinals = new Map<RankedSearchMode, number>();
  const observations = rawObservations.map((observation) => {
    const ordinal = (modeOrdinals.get(observation.mode) ?? 0) + 1;
    modeOrdinals.set(observation.mode, ordinal);
    return { ...observation, caseId: `${observation.mode}-${ordinal}` };
  });
  const modes = MODES.map((mode) => summarizeMode(mode, observations));
  const latencies = observations.filter((observation) => observation.status !== "error").map((observation) => observation.latencyMs);
  const blockers: DeployedRuntimeReport["blockers"] = [];
  if (duplicateIds.size > 0) blockers.push({ code: "duplicate_observation", detail: `${duplicateIds.size} duplicate case ids` });
  const unexpected = input.results.filter((result) => !input.cases.some((caseDef) => caseDef.id === result.caseId)).length;
  if (unexpected > 0) blockers.push({ code: "unexpected_observation", detail: `${unexpected} unexpected case ids` });
  for (const mode of modes) {
    if (!mode.pass) blockers.push({ code: "deployed_runtime_mode_failed", detail: `${mode.mode} runtime gate failed` });
  }
  const body = {
    version: 1 as const,
    scope: "deployed-search-canary-runtime" as const,
    worker: DEPLOYED_SEARCH_CANARY_WORKER,
    endpointHost: "worldcons-search-canary.cclib.workers.dev" as const,
    source: "supabase" as const,
    maxArticles: DEPLOYED_SEARCH_CANARY_MAX_ARTICLES,
    projection: input.projection,
    cases: input.cases.length,
    observations,
    modes,
    latencyP50Ms: percentile(latencies, 0.5),
    latencyP95Ms: percentile(latencies, 0.95),
    state: blockers.length === 0 ? ("pass" as const) : ("fail" as const),
    blockers,
    boundaries: [
      "read-only: the runner calls only the deployed Worker POST /canary/run path and linked Supabase SELECT/RPC source reads",
      "the bearer token is read from process environment, sent only to the pinned workers.dev origin and never logged or persisted",
      "no D1/Vectorize write, schema command, deploy, SearchRepository switch, DNS change or traffic change",
      "report is content-free: no query text, document text, top ids, URLs, vectors or bearer value are persisted",
      "latency gates are p50 <= 500 ms and p95 <= 1500 ms independently for fulltext, semantic and hybrid",
    ],
  } satisfies Omit<DeployedRuntimeReport, "generatedAt" | "stableHash">;
  const stableHash = shadowDigest(`deployed-search-canary-runtime/v1\n${canonicalJson(body)}`);
  return { ...body, generatedAt: input.generatedAt, stableHash };
}

export function renderDeployedRuntimeMarkdown(report: DeployedRuntimeReport): string {
  const lines = [
    "# WorldCons M7.9 deployed Search Canary runtime evidence",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- worker: ${report.worker}`,
    `- state: **${report.state}**`,
    `- stableHash: ${report.stableHash}`,
    `- projection: documents=${report.projection.documents}, vectors=${report.projection.vectorRecords}, missing=${report.projection.missingArtifacts}, stale=${report.projection.staleArtifacts}`,
    `- cases: ${report.cases}`,
    `- aggregate latency: p50=${report.latencyP50Ms}ms, p95=${report.latencyP95Ms}ms`,
    "",
    "| mode | cases | passed | mismatched | errored | mismatch rate | error rate | p50 ms | p95 ms | pass |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
    ...report.modes.map(
      (mode) =>
        `| ${mode.mode} | ${mode.cases} | ${mode.passed} | ${mode.mismatched} | ${mode.errored} | ${mode.mismatchRate} | ${mode.errorRate} | ${mode.latencyP50Ms} | ${mode.latencyP95Ms} | ${mode.pass} |`,
    ),
    "",
    "## Blockers",
    "",
    ...(report.blockers.length === 0 ? ["(none)"] : report.blockers.map((blocker) => `- ${blocker.code}: ${blocker.detail}`)),
    "",
    "## Boundaries",
    "",
    ...report.boundaries.map((boundary) => `- ${boundary}`),
    "",
  ];
  return lines.join("\n");
}
