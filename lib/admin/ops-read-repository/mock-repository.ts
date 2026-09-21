import { mockArticles } from "@/lib/db/mock-data";
import type {
  AdminOpsArticleRow,
  AdminOpsCandidateRow,
  AdminOpsCountTable,
  AdminOpsReadRepository,
} from "@/lib/admin/ops-read-repository/types";

/**
 * In-memory fallback selected when Supabase configuration is absent. It
 * reproduces the pre-extraction no-database behavior exactly: the snapshot is
 * unavailable (so the dashboard uses the legacy path), article rows come from
 * the mock catalog with the same mapping, candidates are empty, and every table
 * count resolves to the supplied fallback.
 */
export const mockAdminOpsReads: AdminOpsReadRepository = {
  isConfigured() {
    return false;
  },

  async loadDashboardSnapshot() {
    return null;
  },

  async loadArticleRows(): Promise<AdminOpsArticleRow[]> {
    return mockArticles.map((article) => ({
      id: article.id,
      slug: article.slug,
      source_key: article.sourceKey,
      jurisdiction: article.jurisdiction,
      institution_name: article.institutionName,
      original_url: article.originalUrl,
      original_title: article.originalTitle,
      korean_title: article.koreanTitle,
      original_published_at: article.originalPublishedAt,
      fetched_at: article.fetchedAt,
      summarized_at: article.summarizedAt,
      status: article.status,
      source_metadata: article.sourceMetadata ?? { collection: { publishable: article.status === "summarized" } },
      error_metadata: article.errorMetadata,
    }));
  },

  async loadCandidateRows(): Promise<AdminOpsCandidateRow[]> {
    return [];
  },

  async countTableRows(_table: AdminOpsCountTable, fallback: number) {
    return fallback;
  },
};
