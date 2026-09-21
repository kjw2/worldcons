import { mockArticles } from "@/lib/db/mock-data";
import type { ArticleListFilters, ArticleListResult } from "@/lib/db/types";
import { filterMockArticles, normalizePagination } from "@/lib/article-reads/shared";
import type {
  ArticleReadOptions,
  ArticleReadRepository,
  ArticleReadSelect,
  TopViewedArticleFilters,
} from "@/lib/article-reads/types";

/**
 * In-memory fallback selected when Supabase configuration is absent. It
 * reproduces the pre-extraction mock behavior exactly: the list read filters,
 * sorts, and paginates the mock corpus (with view counts defaulting to zero),
 * the detail/preview fetch returns the full mock article (regardless of select)
 * with published-only filtering, and the source-text fetch returns the mapped
 * snapshot.
 */
export const mockArticleReads: ArticleReadRepository = {
  async listArticles(filters: ArticleListFilters = {}): Promise<ArticleListResult> {
    const { page, pageSize } = normalizePagination(filters.page, filters.pageSize);

    if (filters.ids && filters.ids.length === 0) {
      return { items: [], pageInfo: { page, pageSize, total: 0, hasMore: false, totalIsExact: true } };
    }

    const items = filterMockArticles(filters);
    const start = (page - 1) * pageSize;
    const pageItems = items.slice(start, start + pageSize);
    return {
      items: filters.includeViewCounts === false ? pageItems : pageItems.map((item) => ({ ...item, viewCount: 0 })),
      pageInfo: { page, pageSize, total: items.length, hasMore: start + pageSize < items.length, totalIsExact: true },
    };
  },

  async listPublicSitemapArticles() {
    return filterMockArticles({}).map((article) => ({
      slug: article.slug,
      lastModified: article.summarizedAt || article.fetchedAt || article.discoveredAt || null,
    }));
  },

  async listTopViewedArticles(limit = 5, filters: TopViewedArticleFilters = {}) {
    const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 20) : 5;
    return (await mockArticleReads.listArticles({ ...filters, pageSize: safeLimit, count: "none" })).items;
  },

  async listRelatedArticleIds() {
    return [];
  },

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
