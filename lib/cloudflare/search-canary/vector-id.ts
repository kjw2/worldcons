import { VECTORIZE_MAX_DIMENSIONS } from "@/lib/cloudflare/search-vector/types";

/**
 * M7.6 isolated canary vectorId helper (runtime-neutral).
 *
 * The isolated search-canary Worker exercises semantic/hybrid ONLY through a
 * pre-projected, artifact-backed Vectorize record addressed by `vectorId`. No
 * operator-supplied query vector crosses HTTP in either direction. But
 * `runVectorRankedSearchPage` still refuses a non-exact semantic/hybrid request
 * whose embedding is absent (`embedding_required`) before it will call the
 * Vectorize adapter, so the Worker synthesizes a neutral, unit-length 1536-d
 * vector LOCALLY. The vectorId adapter discards it and calls
 * `queryById(vectorId, options)`; the synthesized value is never sent to
 * Vectorize, never returned and never logged.
 *
 * This module imports no Node builtin and performs no remote read or write.
 */

/** The dimension the ranked-search orchestrator requires for a query embedding. */
export const SEARCH_CANARY_QUERY_EMBEDDING_DIMENSIONS = VECTORIZE_MAX_DIMENSIONS;

/** Bounded, fail-closed code for a semantic/hybrid case without a vectorId. */
export const SEARCH_CANARY_VECTOR_ID_REQUIRED_CODE = "canary_vector_id_required" as const;

/**
 * Builds the Worker-local, exactly-unit-length query embedding used ONLY to pass
 * the orchestrator's non-empty-embedding guard. A one-hot vector has L2 norm 1,
 * so it needs no floating-point normalization and is fully deterministic. The
 * vectorId adapter ignores the value, so it never reaches Vectorize.
 */
export function buildCanaryQueryEmbedding(): number[] {
  const embedding = new Array<number>(SEARCH_CANARY_QUERY_EMBEDDING_DIMENSIONS).fill(0);
  embedding[0] = 1;
  return embedding;
}

/** True when a canary case carries a usable (non-blank string) vectorId. */
export function hasCanaryVectorId(vectorId: unknown): vectorId is string {
  return typeof vectorId === "string" && vectorId.trim().length > 0;
}
