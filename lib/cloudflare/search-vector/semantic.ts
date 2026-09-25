import { assembleRankedSearchPage } from "@/lib/cloudflare/search-ranked";
import type {
  RankedSearchPagePayload,
  RankedSearchPageRow,
  RankedSearchResolvedRequest,
} from "@/lib/cloudflare/search-ranked";
import { vectorError } from "./errors";
import {
  SEARCH_VECTOR_EXACT_COUNT_DEFERRED_MESSAGE,
  SEARCH_VECTOR_TAG_DEFERRED_MESSAGE,
  SEARCH_VECTOR_WINDOW_EXCEEDED_MESSAGE,
} from "./errors";
import { buildVectorMetadataFilter } from "./metadata";
import {
  VECTORIZE_QUERY_MAX_TOPK,
  type SemanticVectorQueryPlan,
  type VectorizeIndexBinding,
  type VectorizeMatch,
  type VectorizeQueryResult,
} from "./types";

/**
 * M7.4 semantic Vectorize query foundation.
 *
 * The semantic branch mirrors `worldcons_ranked_search_page_v1`'s semantic CTE
 * as closely as a Vectorize topK query allows: the metadata filter is applied
 * BEFORE nearest-neighbor topK, `topK = offset + limit + 1` (max 100 for the
 * no-values/indexed-metadata query), and the returned window is re-ordered
 * `score desc, publishedEpoch desc nulls last, id asc`. `p_tag` and
 * `count = exact` are deferred fail-closed, never approximated.
 */

/** The RPC hybrid candidate ceiling (`least(..., 30063)`). */
export const VECTOR_CANDIDATE_LIMIT_CEILING = 30063;

/**
 * Rejects the two branches that cannot be reproduced safely with a Vectorize
 * query: `p_tag` (array metadata is not filterable) and `count = exact` (a topK
 * query cannot yield the full matching set).
 */
export function assertVectorDeferredUnsupported(resolved: RankedSearchResolvedRequest): void {
  if (resolved.tag !== null) throw vectorError("tag_filter_deferred", SEARCH_VECTOR_TAG_DEFERRED_MESSAGE);
  if (resolved.count === "exact") {
    throw vectorError("vector_exact_count_deferred", SEARCH_VECTOR_EXACT_COUNT_DEFERRED_MESSAGE);
  }
}

/** Semantic `topK = offset + limit + 1`; fails closed above 100. */
export function semanticVectorTopK(resolved: RankedSearchResolvedRequest): number {
  const topK = resolved.offset + resolved.limit + 1;
  if (topK > VECTORIZE_QUERY_MAX_TOPK) {
    throw vectorError("vector_window_exceeded", SEARCH_VECTOR_WINDOW_EXCEEDED_MESSAGE);
  }
  return topK;
}

/** RPC hybrid `v_candidate_limit = min(max((offset+limit+1)*3, 100), 30063)`. */
export function hybridCandidateLimit(resolved: RankedSearchResolvedRequest): number {
  const raw = (resolved.offset + resolved.limit + 1) * 3;
  return Math.min(Math.max(raw, VECTORIZE_QUERY_MAX_TOPK), VECTOR_CANDIDATE_LIMIT_CEILING);
}

/** Validates one Vectorize candidate list, failing closed on any malformation. */
export function parseVectorizeMatches(result: VectorizeQueryResult, label: string): VectorizeMatch[] {
  if (result === null || typeof result !== "object") {
    throw vectorError("invalid_response", `${label}: Vectorize returned a non-object result`);
  }
  const matches = (result as { matches?: unknown }).matches;
  if (!Array.isArray(matches)) {
    throw vectorError("invalid_response", `${label}: Vectorize result did not carry a matches array`);
  }
  const seen = new Set<string>();
  return matches.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw vectorError("invalid_response", `${label}: match ${index} is not an object`);
    }
    const record = entry as Record<string, unknown>;
    const id = record.id;
    if (typeof id !== "string" || id.length === 0) {
      throw vectorError("invalid_response", `${label}: match ${index} is missing a non-empty string id`);
    }
    if (seen.has(id)) throw vectorError("invalid_response", `${label}: duplicate match id ${id}`);
    seen.add(id);
    const score = record.score;
    if (typeof score !== "number" || !Number.isFinite(score)) {
      throw vectorError("invalid_response", `${label}: match ${id} is missing a finite score`);
    }
    const metadata = record.metadata;
    if (metadata !== undefined && metadata !== null && (typeof metadata !== "object" || Array.isArray(metadata))) {
      throw vectorError("invalid_response", `${label}: match ${id} metadata is not an object`);
    }
    if (metadata !== undefined && metadata !== null) {
      const publishedEpoch = (metadata as Record<string, unknown>).publishedEpoch;
      if (publishedEpoch !== undefined && (typeof publishedEpoch !== "number" || !Number.isFinite(publishedEpoch))) {
        throw vectorError("invalid_response", `${label}: match ${id} publishedEpoch metadata is not a finite number`);
      }
    }
    return { id, score, metadata: (metadata as Record<string, unknown> | null | undefined) ?? null };
  });
}

/** `publishedEpoch` metadata as a finite number, or null (sorts last). */
export function matchPublishedEpoch(match: VectorizeMatch): number | null {
  const value = match.metadata?.publishedEpoch;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Semantic ordering: score desc, publishedEpoch desc nulls last, id asc. */
export function compareSemanticMatches(left: VectorizeMatch, right: VectorizeMatch): number {
  if (left.score !== right.score) return right.score - left.score;
  const leftEpoch = matchPublishedEpoch(left);
  const rightEpoch = matchPublishedEpoch(right);
  if (leftEpoch !== rightEpoch) {
    if (leftEpoch === null) return 1;
    if (rightEpoch === null) return -1;
    return rightEpoch - leftEpoch;
  }
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

export interface SemanticVectorQueryRequest {
  readonly binding: VectorizeIndexBinding;
  readonly resolved: RankedSearchResolvedRequest;
  readonly embedding: readonly number[];
}

export interface SemanticVectorQueryResult {
  readonly plan: SemanticVectorQueryPlan;
  readonly matches: VectorizeMatch[];
}

/** Validates/normalizes the semantic window + filter and queries Vectorize. */
export async function runSemanticVectorQuery(
  request: SemanticVectorQueryRequest,
): Promise<SemanticVectorQueryResult> {
  const plan = buildSemanticVectorQueryPlan(request.resolved);
  const result = await request.binding.query(request.embedding, {
    topK: plan.topK,
    // Vectorize rejects an empty filter object, so an unconstrained request must
    // omit the property entirely rather than send `filter: null`/`{}`.
    ...(plan.filter === null ? {} : { filter: plan.filter }),
    returnValues: false,
    returnMetadata: "indexed",
  });
  const matches = parseVectorizeMatches(result, "semantic").sort(compareSemanticMatches);
  return { plan, matches };
}

export function buildSemanticVectorQueryPlan(resolved: RankedSearchResolvedRequest): SemanticVectorQueryPlan {
  assertVectorDeferredUnsupported(resolved);
  const topK = semanticVectorTopK(resolved);
  const filter = buildVectorMetadataFilter(resolved);
  return { topK, filter };
}

/**
 * Assembles the RPC-shaped semantic page from a validated, already-ordered
 * Vectorize window: trim `offset`, keep `limit + 1` and use the RPC lower-bound
 * total (exact COUNT is never fabricated).
 */
export function assembleSemanticVectorPage(
  matches: readonly VectorizeMatch[],
  resolved: RankedSearchResolvedRequest,
): RankedSearchPagePayload {
  const window: RankedSearchPageRow[] = matches
    .slice(resolved.offset)
    .map((match) => ({ id: match.id, score: match.score, semanticSimilarity: match.score }));
  return assembleRankedSearchPage({
    retrievalMode: "semantic",
    rows: window,
    limit: resolved.limit,
    offset: resolved.offset,
    exactTotal: null,
  });
}

/** Full semantic page helper (build plan, query, assemble). */
export async function runSemanticVectorPage(
  request: SemanticVectorQueryRequest,
): Promise<RankedSearchPagePayload> {
  const { matches } = await runSemanticVectorQuery(request);
  return assembleSemanticVectorPage(matches, request.resolved);
}
