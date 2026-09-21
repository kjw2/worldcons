import type { SearchRepository } from "@/lib/search/repository/types";

/**
 * In-memory fallback selected when Supabase configuration is absent. Search is
 * fail-closed: with no database the ranked page is unavailable and the
 * exact-case lookup resolves no ids, so callers fall back to their existing
 * empty/`listArticles` behavior exactly as before the extraction.
 */
export const failClosedSearchRepository: SearchRepository = {
  async rankedSearchPageRpc() {
    return null;
  },
  async findExactCaseArticleIds() {
    return [];
  },
};
