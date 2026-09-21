/**
 * Platform-neutral contract for the privileged admin/ops read domain that backs
 * the admin dashboard (`getAdminDashboardData`): the dashboard snapshot RPC, the
 * paged private article rows, the paged source-url candidate rows, and the
 * exact head counts for the catalog tables.
 *
 * This is a privileged authority and is deliberately kept separate from the
 * public `ArticleReadRepository` / `ReferenceReadRepository`: these reads expose
 * private/unpublished state and must never be composed into a public surface.
 *
 * The contract exposes no Postgres/Supabase types so a future platform adapter
 * can implement it without callers changing. The Supabase-backed implementation
 * remains authoritative during M4.
 */

export interface AdminOpsArticleRow {
  id?: string;
  slug?: string;
  source_key: string;
  jurisdiction?: string | null;
  institution_name?: string | null;
  original_url?: string | null;
  original_title?: string | null;
  korean_title?: string | null;
  original_published_at?: string | null;
  fetched_at?: string | null;
  summarized_at?: string | null;
  status: string;
  source_metadata?: Record<string, unknown> | null;
  error_metadata?: Record<string, unknown> | null;
  error_class?: string | null;
  review_state?: string | null;
  updated_at?: string | null;
}

export interface AdminOpsCandidateRow {
  source_key: string;
  status: string;
  candidate_type?: string | null;
  created_at?: string | null;
  last_attempt_at?: string | null;
}

export type AdminOpsCountTable = "tags" | "source_url_candidates";

export interface AdminOpsArticleListRow extends AdminOpsArticleRow {
  summary_json?: unknown;
}

export type AdminOpsArticlePublishableFilter = "all" | "yes" | "no";
export type AdminOpsArticleSummaryFilter = "all" | "yes" | "no";

export interface AdminOpsArticleListFilters {
  q?: string;
  status?: string;
  sourceKey?: string;
  jurisdiction?: string;
  publishable?: AdminOpsArticlePublishableFilter;
  hasSummary?: AdminOpsArticleSummaryFilter;
  page?: number;
  pageSize?: number;
}

export interface AdminOpsArticleListPageInfo {
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
  totalIsExact: boolean;
}

export interface AdminOpsArticleListPage {
  rows: AdminOpsArticleListRow[];
  pageInfo: AdminOpsArticleListPageInfo;
}

export interface AdminOpsReadRepository {
  /** True when an authoritative database is configured. */
  isConfigured(): boolean;
  /**
   * The raw `rpc_admin_dashboard_snapshot` payload, or `null` when no database
   * is configured or the RPC fails. Callers parse and fall back, so an invalid
   * or empty payload still resolves to the legacy path.
   */
  loadDashboardSnapshot(): Promise<unknown | null>;
  /** The paged private article rows used by the dashboard legacy fallback. */
  loadArticleRows(): Promise<AdminOpsArticleRow[]>;
  /** The paged `source_url_candidates` rows used by the dashboard legacy fallback. */
  loadCandidateRows(): Promise<AdminOpsCandidateRow[]>;
  /** The exact head count for a catalog table, or `fallback` on error/no database. */
  countTableRows(table: AdminOpsCountTable, fallback: number): Promise<number>;
  /**
   * The paged, filtered private article rows backing the admin article list.
   * The page/pageSize bounds, mock fallback filtering/sorting, exact count with
   * fallback, and page-info semantics are all owned here; callers map rows to
   * their list-item shape.
   */
  listAdminArticles(filters?: AdminOpsArticleListFilters): Promise<AdminOpsArticleListPage>;
}
