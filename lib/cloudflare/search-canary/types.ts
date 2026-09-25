import type { SearchProjectionDocument } from "@/lib/cloudflare/search-projection";
import type {
  RankedSearchCount,
  RankedSearchMode,
  RankedSearchPagePayload,
  RankedSearchRange,
} from "@/lib/cloudflare/search-ranked";
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

export const SEARCH_CANARY_VERSION = 1 as const;

/**
 * The isolated, non-production canary Vectorize index. It is deliberately a
 * distinct name from the production plan index (`worldcons-search`): M7.5 must
 * never modify an existing production index.
 */
export const SEARCH_CANARY_VECTOR_INDEX = "worldcons-search-canary-v1" as const;

/** The isolated, non-production canary D1 database for the search projection. */
export const SEARCH_CANARY_D1_DATABASE = "worldcons_search_canary" as const;

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
}

export const SEARCH_CANARY_DEFAULT_THRESHOLDS: SearchCanaryThresholds = {
  minCasesPerMode: 1,
  maxMismatchRate: 0,
  maxErrorRate: 0,
  maxTimeoutRate: 0,
  maxLatencyP50Ms: 2000,
  maxLatencyP95Ms: 5000,
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

export type SearchCanaryOracleParity = "match" | "mismatch" | "absent";

export interface SearchCanaryObservation {
  caseId: string;
  mode: RankedSearchMode;
  status: SearchCanaryObservationStatus;
  latencyMs: number;
  /** D1 row reads attributed to this observation (0 when unknown/skipped). */
  rowReads: number;
  /** Bounded top ids actually observed (never search text). */
  topIds: string[];
  /** Bounded top ids returned by the Supabase RPC oracle (empty when absent). */
  oracleTopIds: string[];
  /** Whether the observed page agreed with the production oracle. */
  oracleParity: SearchCanaryOracleParity;
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
  rowReads: number;
  oracleCompared: number;
  oracleMatched: number;
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

export interface SearchCanaryReport {
  version: 1;
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
  remoteWrites: {
    indexCreated: boolean;
    metadataIndexesCreated: string[];
    vectorsUpserted: number;
    searchRowsInserted: number;
    databaseCreated: boolean;
  };
  metrics: SearchCanaryMetrics;
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
