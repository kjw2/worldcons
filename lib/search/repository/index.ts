import { getSupabaseAdmin } from "@/lib/db/client";
import { getRuntimeD1Binding, getRuntimeSearchVectorBinding } from "@/lib/cloudflare/d1/runtime-binding";
import { runVectorRankedSearchPage } from "@/lib/cloudflare/search-vector/ranked";
import { isCloudflareWorkerRuntime } from "@/lib/runtime/platform";
import { failClosedSearchRepository } from "@/lib/search/repository/fail-closed-repository";
import { createSupabaseSearchRepository } from "@/lib/search/repository/supabase-repository";
import type {
  ExactCaseArticleIdRequest,
  SearchRepository,
  RankedSearchPageRpcRequest,
  VectorMatchRpcRequest,
} from "@/lib/search/repository/types";

export * from "@/lib/search/repository/fail-closed-repository";
export * from "@/lib/search/repository/supabase-repository";
export * from "@/lib/search/repository/types";

/**
 * Selection point for the search data-access seam. Supabase remains
 * authoritative whenever configuration is present; without it the fail-closed
 * adapter is used, preserving the pre-extraction no-config behavior.
 */
function createD1SearchRepository(): SearchRepository {
  const search = getRuntimeD1Binding("worldcons_search");
  const core = getRuntimeD1Binding("worldcons_core");
  const vector = getRuntimeSearchVectorBinding();

  return {
    isConfigured: () => Boolean(search && core),
    async rankedSearchPageRpc(request: RankedSearchPageRpcRequest) {
      if (!search) return null;
      return runVectorRankedSearchPage({
        d1: search,
        vector,
        input: {
          ...request,
          referenceNow: new Date(),
        },
      });
    },
    async catalogCaseSearchRpc() {
      return { status: "unavailable" };
    },
    async fullTextRankedIdsRpc() {
      return null;
    },
    async vectorMatchRpc(_request: VectorMatchRpcRequest) {
      return null;
    },
    async findSemanticEmbeddingRows() {
      return null;
    },
    async findExactCaseArticleIds(request: ExactCaseArticleIdRequest) {
      if (!search || request.references.length === 0) return [];
      const found: string[] = [];
      for (const reference of request.references) {
        const predicates = [
          "source_key = ?",
          "instr(char(10) || case_numbers || char(10), char(10) || ? || char(10)) > 0",
        ];
        const values: unknown[] = [reference.sourceKey, reference.caseKey];
        if (request.jurisdiction) { predicates.push("jurisdiction = ?"); values.push(request.jurisdiction); }
        if (request.type) { predicates.push("content_type = ?"); values.push(request.type); }
        if (request.language) { predicates.push("language = ?"); values.push(request.language); }
        const result = await search.prepare(
          `SELECT article_id FROM search_documents WHERE ${predicates.join(" AND ")} ORDER BY article_id LIMIT 100`,
        ).bind(...values).all<{ article_id: string }>();
        if (result.success === false || !Array.isArray(result.results)) throw new Error("D1 exact-case search failed.");
        for (const row of result.results) if (typeof row.article_id === "string" && !found.includes(row.article_id)) found.push(row.article_id);
      }
      return found;
    },
  };
}

export function searchRepository(): SearchRepository {
  if (isCloudflareWorkerRuntime()) return createD1SearchRepository();
  const supabase = getSupabaseAdmin();
  if (!supabase) return failClosedSearchRepository;
  const adminClient = supabase;
  return createSupabaseSearchRepository({ client: () => adminClient });
}
