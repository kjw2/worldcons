import type { SearchProjectionDocument } from "@/lib/cloudflare/search-projection";
import type {
  RankedSearchCount,
  RankedSearchMode,
  RankedSearchPagePayload,
  RankedSearchRange,
} from "@/lib/cloudflare/search-ranked";
import type { RankedIdParityReport } from "@/lib/cloudflare/search-fts";
import type { VectorizeProjectionRecord } from "@/lib/cloudflare/search-vector";

/**
 * M7.5 remote search canary / parity evidence types (runtime-neutral).
 *
 * M7.5 is the first M7 slice that may touch Cloudflare, but only an ISOLATED,
 * non-production canary Vectorize index and an ISOLATED canary D1 search
 * database. Supabase remains the sole production search/read authority; no
 * production binding, DNS, traffic or `GO-SEARCH`/`GO-D1-READ` flag is changed.
 * This module imports no Node builtin and performs no remote read or write.
 */

export const SEARCH_CANARY_VERSION = 2 as const;

/**
 * The isolated, non-production canary Vectorize index. It is deliberately a
 * distinct name from the production plan index (`worldcons-search`): M7.5/M7.6
 * must never modify an existing production index. Defaults target the v2 index
 * created by the bounded M7.5 canary; override with `--index-name`.
 */
export const SEARCH_CANARY_VECTOR_INDEX = "worldcons-search-canary-v2" as const;

/**
 * The isolated, non-production canary D1 database for the search projection.
 * Defaults target the v2 database created by the bounded M7.5 canary; override
 * with `--database`.
 */
export const SEARCH_CANARY_D1_DATABASE = "worldcons_search_canary_v2" as const;

/** Default bounded canary size; the ceiling is enforced fail-closed. */
export const SEARCH_CANARY_MAX_ARTICLES_DEFAULT = 100 as const;
export const SEARCH_CANARY_MAX_ARTICLES_CEILING = 1000 as const;

/** Bounded Vectorize upsert batch size (Vectorize accepts up to 5000). */
export const SEARCH_CANARY_VECTOR_BATCH_SIZE = 500 as const;

/** Default topK for the remote retrieval canary (`offset + limit + 1`). */
export const SEARCH_CANARY_DEFAULT_TOPK = 5 as const;

/**
 * Explicit blocker accounting. A blocker is a limitation that is recorded, not
 * approximated: M7.5 never fabricates a result to hide one.
 */
export const SEARCH_CANARY_BLOCKER_CODES = [
  "production_oracle_unavailable",
  "supabase_not_linked",
  "remote_search_projection_not_populated",
  "tag_filter_deferred",
  "vector_exact_count_deferred",
  "vector_window_exceeded",
  "metadata_high_cardinality_range",
  "remote_access_unavailable",
  "d1_sql_statement_limit",
  "production_semantic_oracle_drift",
  "canary_index_absent",
  "canary_index_mismatch",
  "canary_metadata_index_capacity",
  "parameterized_writer_unavailable",
  "binding_canary_unavailable",
  "runtime_latency_threshold",
  "fulltext_rank_threshold_unagreed",
] as const;

export type SearchCanaryBlockerCode = (typeof SEARCH_CANARY_BLOCKER_CODES)[number];

export interface SearchCanaryBlocker {
  code: SearchCanaryBlockerCode;
  detail: string;
}

/** Explicit pass/fail thresholds agreed before any evidence is collected. */
export interface SearchCanaryThresholds {
  /** Minimum comparable cases required per mode before the mode can pass. */
  minCasesPerMode: number;
  /** Mismatched observations / compared observations must not exceed this. */
  maxMismatchRate: number;
  /** Errored observations / compared observations must not exceed this. */
  maxErrorRate: number;
  /** Timed-out observations / compared observations must not exceed this. */
  maxTimeoutRate: number;
  /** Median observed latency ceiling, in milliseconds. */
  maxLatencyP50Ms: number;
  /** 95th-percentile observed latency ceiling, in milliseconds. */
  maxLatencyP95Ms: number;
  /**
   * Optional median BINDING latency ceiling, in milliseconds. M7.6 separates
   * true D1/Vectorize binding latency from operator wall time; this ceiling is
   * enforced only when at least one observation carries a binding latency, so a
   * legacy operator-only run is not suddenly gated by an unmeasured dimension.
   */
  maxBindingLatencyP50Ms?: number;
  /** Optional 95th-percentile binding latency ceiling, in milliseconds. */
  maxBindingLatencyP95Ms?: number;
}

export const SEARCH_CANARY_DEFAULT_THRESHOLDS: SearchCanaryThresholds = {
  minCasesPerMode: 1,
  maxMismatchRate: 0,
  maxErrorRate: 0,
  maxTimeoutRate: 0,
  maxLatencyP50Ms: 2000,
  maxLatencyP95Ms: 5000,
  maxBindingLatencyP50Ms: 500,
  maxBindingLatencyP95Ms: 1500,
};

export type SearchCanaryObservationStatus = "pass" | "mismatch" | "error" | "timeout" | "skipped";

/**
 * A frozen expectation. `exact-order` is an ordered id list (used when a
 * deterministic local oracle exists); `top-id` requires the id first;
 * `contains` requires the id within the top N; `self-top` requires the queried
 * vector id first with a minimum cosine score.
 */
export type SearchCanaryExpectation =
  | { kind: "exact-order"; ids: string[] }
  | { kind: "top-id"; id: string }
  | { kind: "contains"; id: string; withinTop: number }
  | { kind: "self-top"; id: string; minScore: number };

/** One frozen regression case (no production oracle is implied). */
export interface SearchCanaryCase {
  id: string;
  mode: RankedSearchMode;
  query: string;
  source?: string | null;
  jurisdiction?: string | null;
  contentType?: string | null;
  language?: string | null;
  range?: RankedSearchRange;
  limit: number;
  offset: number;
  count?: RankedSearchCount;
  /** Query vector for semantic/hybrid cases; null for lexical cases. */
  embedding?: number[] | null;
  /** When set, a remote Vectorize query uses this indexed id instead of values. */
  vectorId?: string | null;
  expectation: SearchCanaryExpectation;
}

export type SearchCanaryOracleParity = "match" | "mismatch" | "informational" | "absent";

/**
 * Content-free rank comparison between the observed page and the production
 * oracle page, computed with the M7.2 `compareRankedIds` evidence helper.
 *
 * It is stored as a diagnostic, not a threshold: `strict` records whether this
 * comparison is allowed to gate the case at all. A generic lexical (`contains`)
 * fulltext case is `strict: false` because M7.2 documents that FTS5 bm25 does
 * NOT reproduce Postgres `ts_rank_cd`, so production ordering is informational
 * until an acceptance threshold is agreed. IDs only: no search text.
 */
export interface SearchCanaryRankComparison extends RankedIdParityReport {
  /** True when the production ordering is a pass/fail gate for this case. */
  strict: boolean;
}

/**
 * Explicit oracle modes. `production-rpc` compares against the Supabase
 * `worldcons_ranked_search_page_v1` RPC; `artifact-reference` compares against
 * the provenance-locked `article_embedding_artifacts` projection (the M7.4
 * authority) and is used when the production projection embedding is NULL;
 * `none` means no oracle was requested/available.
 */
export const SEARCH_CANARY_ORACLE_MODES = ["none", "production-rpc", "artifact-reference"] as const;
export type SearchCanaryOracleMode = (typeof SEARCH_CANARY_ORACLE_MODES)[number];

/**
 * The transport that executed the parameterized canary writes.
 *
 * `local-dev` is the loopback-only, unauthenticated `wrangler dev` transport: it
 * is never selected by `auto`, requires an explicit `--writer=local-dev` (or the
 * explicit `WORLDCONS_SEARCH_CANARY_DEV_UNAUTH=true` opt-in), and fails closed
 * on any non-loopback or non-`http` endpoint.
 */
export const SEARCH_CANARY_WRITE_TRANSPORTS = ["none", "worker-binding", "d1-http", "local-dev"] as const;
export type SearchCanaryWriteTransportKind = (typeof SEARCH_CANARY_WRITE_TRANSPORTS)[number];

/** A JSON-safe bound parameter; blobs are never accepted on the canary path. */
export type SearchCanaryWriteParam = string | number | null;

/** One parameterized statement: authored `?` SQL plus bound params. */
export interface SearchCanaryParameterizedStatement {
  sql: string;
  params: SearchCanaryWriteParam[];
}

export interface SearchCanaryWritePlanCounts {
  statements: number;
  parameters: number;
  /** Largest authored `?` SQL statement, in bytes, with bound params excluded. */
  maxAuthoredSqlBytes: number;
  /** Largest single bound parameter, in bytes; authored content only. */
  maxParamBytes: number;
  /** Largest literal rendering if the statement were literalized (diagnostic). */
  maxLiteralBytes: number;
  /** Statements whose literal rendering would exceed the D1 statement limit. */
  literalOversizedStatements: number;
  /** Total literal bytes of the statements that would exceed the limit (0 when none). */
  literalOversizedBytes: number;
}

/** A parameterized write plan; never carries a literalized statement. */
export interface SearchCanaryWritePlan {
  version: 1;
  destructive: false;
  limitBytes: number;
  counts: SearchCanaryWritePlanCounts;
  /** Authored `?` SQL plus bound params. MUTABLE in-memory only: never serialize. */
  statements: SearchCanaryParameterizedStatement[];
}

/**
 * The content-free view of a write plan that is safe to attach to a
 * `SearchCanaryReport`, serialize to JSON, render as Markdown or log. It carries
 * counts and byte sizes only: the authored `?` SQL and every bound parameter
 * (which may embed document/search text) stay in the in-memory
 * `SearchCanaryWritePlan` and are never copied into this summary.
 */
export interface SearchCanaryWritePlanSummary {
  version: 1;
  destructive: false;
  limitBytes: number;
  counts: SearchCanaryWritePlanCounts;
}

export interface SearchCanaryWriteResult {
  transport: SearchCanaryWriteTransportKind;
  executedStatements: number;
  totalChanges: number;
}

/** Operator wall time and binding/runtime time, reported separately. */
export interface SearchCanaryTimingSummary {
  samples: number;
  operatorP50Ms: number;
  operatorP95Ms: number;
  bindingP50Ms: number;
  bindingP95Ms: number;
}

export interface SearchCanaryTimings {
  operator: { samples: number; p50Ms: number; p95Ms: number };
  binding: { samples: number; p50Ms: number; p95Ms: number };
}

export interface SearchCanaryOracleModeSummary {
  productionRpc: number;
  artifactReference: number;
  none: number;
  /** Observations whose artifact-reference mode was forced by production drift. */
  drift: number;
}

export interface SearchCanaryObservation {
  caseId: string;
  mode: RankedSearchMode;
  status: SearchCanaryObservationStatus;
  /** Operator wall time (process/CLI boundary) in milliseconds. */
  latencyMs: number;
  /**
   * Binding/runtime latency in milliseconds when measured through the isolated
   * canary Worker's real D1 + Vectorize bindings; `null` for an operator-only run.
   */
  bindingLatencyMs: number | null;
  /** D1 row reads attributed to this observation (0 when unknown/skipped). */
  rowReads: number;
  /** Bounded top ids actually observed (never search text). */
  topIds: string[];
  /** Bounded top ids returned by the Supabase RPC oracle (empty when absent). */
  oracleTopIds: string[];
  /** The explicit oracle mode used for this observation. */
  oracleMode: SearchCanaryOracleMode;
  /** True when artifact-reference mode was forced by production embedding drift. */
  oracleDrift: boolean;
  /** Whether the observed page agreed with the selected oracle. */
  oracleParity: SearchCanaryOracleParity;
  /**
   * Content-free rank comparison against a production lexical oracle, when one
   * was available; `null` for artifact-reference/none or non-lexical modes.
   */
  rankComparison: SearchCanaryRankComparison | null;
  /** Stable error code when `status` is error/timeout. */
  errorCode: string | null;
  /** Deterministic detail for a mismatch, never document content. */
  detail: string | null;
}

export interface SearchCanaryModeMetrics {
  mode: RankedSearchMode;
  cases: number;
  compared: number;
  passed: number;
  mismatched: number;
  errored: number;
  timedOut: number;
  skipped: number;
  mismatchRate: number;
  errorRate: number;
  timeoutRate: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  /** Observations with a measured binding latency. */
  bindingSamples: number;
  bindingLatencyP50Ms: number;
  bindingLatencyP95Ms: number;
  rowReads: number;
  oracleCompared: number;
  oracleMatched: number;
  /** Observations whose lexical production rank diverged but is non-gating. */
  oracleInformational: number;
  pass: boolean;
}

export interface SearchCanaryMetrics {
  modes: SearchCanaryModeMetrics[];
  totalCases: number;
  totalCompared: number;
  totalPassed: number;
  totalRowReads: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  bindingSamples: number;
  bindingLatencyP50Ms: number;
  bindingLatencyP95Ms: number;
  pass: boolean;
}

export interface SearchCanaryVectorIndexState {
  name: string;
  exists: boolean;
  dimensions: number | null;
  metric: string | null;
}

export interface SearchCanaryVectorBootstrapAction {
  propertyName: string;
  type: "string" | "number";
  exists: boolean;
  action: "none" | "create";
}

export interface SearchCanaryVectorBootstrapPlan {
  version: 1;
  index: {
    name: string;
    exists: boolean;
    dimensions: number;
    metric: "cosine";
    action: "none" | "create";
  };
  metadataIndexes: SearchCanaryVectorBootstrapAction[];
  blockers: SearchCanaryBlocker[];
  destructive: false;
  ok: boolean;
}

export interface SearchCanaryPlanChanges {
  projectedDocuments: number;
  vectorRecords: number;
  missingArtifacts: number;
  staleArtifacts: number;
}

/** A bounded, deterministic canary projection plan (no remote call). */
export interface SearchCanaryProjectionPlan {
  version: 1;
  maxArticles: number;
  truncated: boolean;
  documents: SearchProjectionDocument[];
  records: VectorizeProjectionRecord[];
  changes: SearchCanaryPlanChanges;
  blockers: SearchCanaryBlocker[];
  manifest: {
    searchHash: string;
    vectorHash: string;
  };
}

export interface SearchCanaryRemoteWrites {
  indexCreated: boolean;
  metadataIndexesCreated: string[];
  vectorsUpserted: number;
  searchRowsInserted: number;
  databaseCreated: boolean;
  /** M7.6: which parameterized transport executed the projection writes. */
  writer?: SearchCanaryWriteTransportKind;
  /** M7.6: parameterized statements executed (0 in dry-run/reuse). */
  parameterizedStatements?: number;
  /** M7.6: statements whose literal rendering exceeds the D1 statement limit. */
  literalOversizedStatements?: number;
}

export interface SearchCanaryReport {
  version: typeof SEARCH_CANARY_VERSION;
  generatedAt: string;
  scope: "search-canary";
  vectorIndex: string;
  database: string;
  source: "supabase" | "remote-d1" | "fixture";
  maxArticles: number;
  projection: {
    projectedDocuments: number;
    vectorRecords: number;
    missingArtifacts: number;
    staleArtifacts: number;
    truncated: boolean;
  };
  vectorBootstrap: SearchCanaryVectorBootstrapPlan | null;
  remoteWrites: SearchCanaryRemoteWrites;
  /**
   * The content-free parameterized write-plan summary, or null when no projection
   * write was planned. The executable plan (with bound params) is never attached
   * here, so no report serialization can leak SQL parameter values.
   */
  writePlan: SearchCanaryWritePlanSummary | null;
  metrics: SearchCanaryMetrics;
  /** Operator wall time and binding/runtime time, reported separately. */
  timings: SearchCanaryTimings;
  /** Explicit oracle-mode accounting (never fabricated parity). */
  oracle: SearchCanaryOracleModeSummary;
  observations: SearchCanaryObservation[];
  thresholds: SearchCanaryThresholds;
  blockers: SearchCanaryBlocker[];
  verdict: "pass" | "fail" | "insufficient_evidence";
}

/** The observed remote retrieval result for one vector-id query. */
export interface SearchCanaryVectorQueryObservation {
  vectorId: string;
  status: SearchCanaryObservationStatus;
  latencyMs: number;
  topIds: string[];
  topScore: number | null;
  metadataPresent: boolean;
  errorCode: string | null;
}

export type { RankedSearchPagePayload };
