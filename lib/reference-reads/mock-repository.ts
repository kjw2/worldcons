import { mockArticles, mockGlossaryTerms, mockIngestionRuns, mockSources, mockTags } from "@/lib/db/mock-data";
import { isWithinRange, normalizeRange } from "@/lib/utils/dates";
import {
  normalizeJurisdictions,
  normalizeTagListOptions,
  sortGlossaryTerms,
} from "@/lib/reference-reads/shared";
import type { JurisdictionCountOptions, ReferenceReadRepository, TagListOptions } from "@/lib/reference-reads/types";

/**
 * In-memory fallback selected when Supabase configuration is absent. It
 * reproduces the pre-extraction mock behavior exactly so local/CI runs and the
 * demo dataset stay unchanged.
 */
export const mockReferenceReads: ReferenceReadRepository = {
  async listSources() {
    return mockSources;
  },

  async listTags(options: TagListOptions = {}) {
    const { type, sort, limit, minArticleCount } = normalizeTagListOptions(options);
    const tags = [...mockTags]
      .filter((tag) => !type || tag.type === type)
      .filter((tag) => !minArticleCount || (tag.articleCount ?? 0) >= minArticleCount)
      .sort((left, right) => {
        if (sort === "name") return left.name.localeCompare(right.name);
        if (sort === "latest") return (right.latestArticleAt || "").localeCompare(left.latestArticleAt || "");
        return (right.articleCount ?? 0) - (left.articleCount ?? 0);
      });
    return limit ? tags.slice(0, limit) : tags;
  },

  async listJurisdictionArticleCounts(jurisdictions: string[] = [], options: JurisdictionCountOptions = {}) {
    const normalizedJurisdictions = normalizeJurisdictions(jurisdictions);
    const range = normalizeRange(options.range);
    const counts: Record<string, number> = {};
    for (const article of mockArticles) {
      if (article.status !== "summarized") continue;
      if (!isWithinRange(article.originalPublishedAt, range)) continue;
      counts[article.jurisdiction] = (counts[article.jurisdiction] ?? 0) + 1;
    }
    return normalizedJurisdictions.length
      ? Object.fromEntries(normalizedJurisdictions.map((jurisdiction) => [jurisdiction, counts[jurisdiction] ?? 0]))
      : counts;
  },

  async listGlossaryTerms() {
    return sortGlossaryTerms(mockGlossaryTerms);
  },

  async getGlossaryTerm(slug: string) {
    const terms = await mockReferenceReads.listGlossaryTerms();
    return terms.find((term) => term.slug === slug) ?? null;
  },

  async listIngestionRuns(limit = 20) {
    return mockIngestionRuns.slice(0, limit);
  },

  async getTagBySlug(slug: string) {
    return mockTags.find((item) => item.slug === slug) ?? null;
  },
};
