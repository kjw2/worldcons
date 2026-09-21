import { mockArticles } from "@/lib/db/mock-data";
import type {
  AdminOpsArticleListFilters,
  AdminOpsArticleListPage,
  AdminOpsArticleListRow,
  AdminOpsArticleRow,
  AdminOpsCandidateRow,
  AdminOpsCountTable,
  AdminOpsReadRepository,
} from "@/lib/admin/ops-read-repository/types";
import {
  boundedAdminArticlePage,
  boundedAdminArticlePageSize,
  isPublishableArticle,
} from "@/lib/admin/ops-read-repository/shared";

function matchesAdminArticleText(row: AdminOpsArticleListRow, q?: string) {
  const normalized = q?.trim().toLowerCase();
  if (!normalized) return true;
  const terms = normalized.split(/\s+/).filter(Boolean);
  const haystack = [
    row.slug,
    row.korean_title,
    row.original_title,
    row.original_url,
    row.source_key,
    row.institution_name,
    row.jurisdiction,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

function filterMockAdminArticleRows(filters: AdminOpsArticleListFilters) {
  const rows = mockArticles.map((article) => ({
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
    summary_json: article.summaryJson,
    source_metadata: article.sourceMetadata ?? { collection: { publishable: article.status === "summarized" } },
  })) satisfies AdminOpsArticleListRow[];

  return rows
    .filter((row) => matchesAdminArticleText(row, filters.q))
    .filter((row) => !filters.status || row.status === filters.status)
    .filter((row) => !filters.sourceKey || row.source_key === filters.sourceKey)
    .filter((row) => !filters.jurisdiction || row.jurisdiction === filters.jurisdiction)
    .filter((row) => filters.publishable === "yes" ? isPublishableArticle(row) : filters.publishable === "no" ? !isPublishableArticle(row) : true)
    .filter((row) => filters.hasSummary === "yes" ? Boolean(row.summary_json) : filters.hasSummary === "no" ? !row.summary_json : true)
    .sort((a, b) => (b.original_published_at ?? b.fetched_at ?? "").localeCompare(a.original_published_at ?? a.fetched_at ?? ""));
}

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

  async listAdminArticles(filters: AdminOpsArticleListFilters = {}): Promise<AdminOpsArticleListPage> {
    const page = boundedAdminArticlePage(filters.page);
    const pageSize = boundedAdminArticlePageSize(filters.pageSize);
    const rows = filterMockAdminArticleRows(filters);
    const start = (page - 1) * pageSize;

    return {
      rows: rows.slice(start, start + pageSize),
      pageInfo: {
        page,
        pageSize,
        total: rows.length,
        hasMore: start + pageSize < rows.length,
        totalIsExact: true,
      },
    };
  },
};
