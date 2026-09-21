import { mockArticles } from "@/lib/db/mock-data";
import type {
  ArticleReadOptions,
  ArticleReadRepository,
  ArticleReadSelect,
} from "@/lib/article-reads/types";

/**
 * In-memory fallback selected when Supabase configuration is absent. It
 * reproduces the pre-extraction mock behavior exactly: the detail/preview fetch
 * returns the full mock article (regardless of select) with published-only
 * filtering, and the source-text fetch returns the mapped snapshot.
 */
export const mockArticleReads: ArticleReadRepository = {
  async getArticleBySelect(slug: string, select: ArticleReadSelect, options: ArticleReadOptions = {}) {
    void select;
    const article = mockArticles.find((item) => item.slug === slug) ?? null;
    return options.includeUnpublished || article?.status === "summarized" ? article : null;
  },

  async getArticleSourceTextBySlug(slug: string, options: ArticleReadOptions = {}) {
    const article = mockArticles.find((item) => item.slug === slug) ?? null;
    if (!article || (!options.includeUnpublished && article.status !== "summarized")) return null;
    return {
      slug: article.slug,
      sourceKey: article.sourceKey,
      sourceMetadata: article.sourceMetadata ?? null,
      officialUrl: article.originalUrl,
      cleanedText: article.cleanedText ?? null,
      contentHash: article.contentHash ?? null,
    };
  },
};
