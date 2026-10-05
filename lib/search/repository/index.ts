import { getRuntimeD1Binding, getRuntimeSearchVectorBinding } from "@/lib/cloudflare/d1/runtime-binding";
import { runD1CaseCatalogSearch } from "@/lib/cloudflare/search-catalog/case-catalog-search";
import { runVectorRankedSearchPage } from "@/lib/cloudflare/search-vector/ranked";
import { failClosedSearchRepository } from "@/lib/search/repository/fail-closed-repository";
import type {
  CatalogCaseSearchRpcRequest,
  ExactCaseArticleIdRequest,
  SearchRepository,
  RankedSearchPageRpcRequest,
  VectorMatchRpcRequest,
} from "@/lib/search/repository/types";

export * from "@/lib/search/repository/fail-closed-repository";
export * from "@/lib/search/repository/types";

/**
 * Cloudflare D1/Vectorize are the only search authority. Missing bindings fail
 * closed rather than selecting another database backend.
 */
export function createD1SearchRepository(): SearchRepository {
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
    async catalogCaseSearchRpc(request: CatalogCaseSearchRpcRequest) {
      if (!core) return { status: "unavailable" };
      return runD1CaseCatalogSearch({ binding: core, request });
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
  const repository = createD1SearchRepository();
  return repository.isConfigured() ? repository : failClosedSearchRepository;
}
