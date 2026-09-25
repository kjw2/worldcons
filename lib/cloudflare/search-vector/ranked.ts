import type { D1RuntimeDatabase } from "@/lib/cloudflare/d1/runtime-binding";
import {
  primaryCaseReference,
  resolveRankedSearchInput,
  runRankedSearchPage,
} from "@/lib/cloudflare/search-ranked";
import type { RankedSearchPageInput, RankedSearchPagePayload } from "@/lib/cloudflare/search-ranked";
import { normalizeQueryEmbedding } from "./embedding";
import { SEARCH_VECTOR_EMBEDDING_REQUIRED_MESSAGE, SEARCH_VECTOR_UNAVAILABLE_MESSAGE, vectorError } from "./errors";
import { runHybridVectorPage } from "./hybrid";
import { runSemanticVectorPage } from "./semantic";
import type { VectorizeIndexBinding } from "./types";

/**
 * M7.4 Cloudflare ranked-search orchestrator (local only).
 *
 * SELECTED BY NOTHING IN PRODUCTION: `lib/search/repository/index.ts` still
 * returns the Supabase-authoritative repository. This orchestrator preserves the
 * M7.3 exact-case/latest/fulltext behavior by delegating those branches
 * unchanged, and adds semantic/hybrid only through an injected Vectorize binding.
 * Exact-case and empty-query requests work WITHOUT a Vectorize binding even when
 * the requested mode is semantic/hybrid; a non-exact semantic/hybrid request
 * without a binding fails closed with `vectorize_unavailable` and is NEVER
 * answered with a lexical fallback. A non-exact semantic/hybrid request without
 * an embedding fails closed with the RPC-equivalent `embedding_required`.
 */
export interface VectorRankedSearchRequest {
  readonly d1: D1RuntimeDatabase;
  readonly vector?: VectorizeIndexBinding | null;
  readonly input: RankedSearchPageInput;
}

export async function runVectorRankedSearchPage(request: VectorRankedSearchRequest): Promise<RankedSearchPagePayload> {
  const resolved = resolveRankedSearchInput(request.input);
  const exact = primaryCaseReference(resolved.queryText);

  // Exact-case, empty-query latest and fulltext keep the frozen M7.3 behavior;
  // none of them require a Vectorize binding or query embedding.
  if (exact !== null || resolved.queryText === "" || resolved.mode === "fulltext") {
    return runRankedSearchPage({ binding: request.d1, input: request.input });
  }

  // Non-empty, non-exact semantic/hybrid.
  if (!resolved.hasEmbedding) {
    throw vectorError("embedding_required", SEARCH_VECTOR_EMBEDDING_REQUIRED_MESSAGE);
  }
  const embedding = normalizeQueryEmbedding(request.input.embedding);

  const vector = request.vector;
  if (!vector || typeof vector.query !== "function") {
    throw vectorError("vectorize_unavailable", SEARCH_VECTOR_UNAVAILABLE_MESSAGE);
  }

  if (resolved.mode === "semantic") {
    return runSemanticVectorPage({ binding: vector, resolved, embedding });
  }
  return runHybridVectorPage({ d1: request.d1, vector, resolved, embedding });
}
