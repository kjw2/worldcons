import type { SearchRepository } from "@/lib/search/repository/types";

/**
 * In-memory fallback selected when Supabase configuration is absent. Search is
 * fail-closed: with no database the ranked page, full-text ids, vector matches,
 * and embedding rows are unavailable, the catalog search reports `unavailable`,
 * and the exact-case lookup resolves no ids, so callers fall back to their
 * existing empty/`listArticles` behavior exactly as before the extraction.
 */
export const failClosedSearchRepository: SearchRepository = {
  isConfigured() {
    return false;
  },
  async rankedSearchPageRpc() {
    return null;
  },
  async catalogCaseSearchRpc() {
    return { status: "unavailable" };
  },
  async fullTextRankedIdsRpc() {
    return null;
  },
  async vectorMatchRpc() {
    return null;
  },
  async findSemanticEmbeddingRows() {
    return null;
  },
  async findExactCaseArticleIds() {
    return [];
  },
};
