import type { SupabaseClient } from "@supabase/supabase-js";
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
} from "@/lib/admin/ops-read-repository/shared";

const ARTICLE_ROW_SELECT =
  "id, slug, source_key, jurisdiction, institution_name, original_url, original_title, korean_title, original_published_at, fetched_at, summarized_at, status, source_metadata, error_metadata, updated_at";
const ADMIN_ARTICLE_LIST_SELECT =
  "id, slug, source_key, jurisdiction, institution_name, original_url, original_title, korean_title, original_published_at, fetched_at, summarized_at, status, source_metadata, summary_json, updated_at";
const CANDIDATE_ROW_SELECT = "source_key, status, candidate_type, created_at, last_attempt_at";
const PAGE_SIZE = 1000;

/** The existing admin full-text normalization: lowercased word prefixes joined with ` & `. */
function toAdminFullTextQuery(q?: string) {
  const terms =
    q
      ?.toLowerCase()
      .split(/\s+/)
      .map((term) => term.replace(/[^\p{L}\p{N}]+/gu, ""))
      .filter(Boolean) ?? [];

  return terms.map((term) => `${term}:*`).join(" & ");
}

export interface SupabaseAdminOpsReadDependencies {
  /** Resolves the admin client. Resolved once by the selection point. */
  client: () => SupabaseClient;
}

/**
 * Supabase-backed privileged admin/ops read access. This is the authoritative
 * M4 implementation: it preserves the exact pre-extraction RPC call, the
 * 1000-row paging loops with no artificial cap, the select shapes, the exact
 * head counts, and every error semantic (snapshot errors resolve to `null`;
 * candidate read/count errors use the fallback; article read errors rethrow).
 */
export function createSupabaseAdminOpsReadRepository(
  dependencies: SupabaseAdminOpsReadDependencies,
): AdminOpsReadRepository {
  const client = dependencies.client;

  function isConfigured() {
    return true;
  }

  async function loadDashboardSnapshot(): Promise<unknown | null> {
    const { data, error } = await client().rpc("rpc_admin_dashboard_snapshot");
    if (error) return null;
    return data ?? null;
  }

  async function loadArticleRows(): Promise<AdminOpsArticleRow[]> {
    const supabase = client();
    const rows: AdminOpsArticleRow[] = [];
    let start = 0;

    while (true) {
      const { data, error } = await supabase
        .from("articles")
        .select(ARTICLE_ROW_SELECT)
        .range(start, start + PAGE_SIZE - 1);

      if (error) throw new Error(error.message);
      rows.push(...((data ?? []) as AdminOpsArticleRow[]));
      if (!data || data.length < PAGE_SIZE) break;
      start += PAGE_SIZE;
    }

    return rows;
  }

  async function loadCandidateRows(): Promise<AdminOpsCandidateRow[]> {
    const supabase = client();
    const rows: AdminOpsCandidateRow[] = [];
    let start = 0;

    while (true) {
      const { data, error } = await supabase
        .from("source_url_candidates")
        .select(CANDIDATE_ROW_SELECT)
        .range(start, start + PAGE_SIZE - 1);

      if (error) return [];
      rows.push(...((data ?? []) as AdminOpsCandidateRow[]));
      if (!data || data.length < PAGE_SIZE) break;
      start += PAGE_SIZE;
    }

    return rows;
  }

  async function countTableRows(table: AdminOpsCountTable, fallback: number): Promise<number> {
    const { count, error } = await client().from(table).select("*", { count: "exact", head: true });
    if (error) return fallback;
    return count ?? fallback;
  }

  async function listAdminArticles(
    filters: AdminOpsArticleListFilters = {},
  ): Promise<AdminOpsArticleListPage> {
    const page = boundedAdminArticlePage(filters.page);
    const pageSize = boundedAdminArticlePageSize(filters.pageSize);

    let query = client()
      .from("articles")
      .select(ADMIN_ARTICLE_LIST_SELECT, { count: "exact" })
      .order("original_published_at", { ascending: false, nullsFirst: false })
      .order("updated_at", { ascending: false, nullsFirst: false })
      .order("id", { ascending: true });

    const tsQuery = toAdminFullTextQuery(filters.q);
    if (tsQuery) query = query.textSearch("search_vector", tsQuery, { config: "simple" });
    if (filters.status) query = query.eq("status", filters.status);
    if (filters.sourceKey) query = query.eq("source_key", filters.sourceKey);
    if (filters.jurisdiction) query = query.eq("jurisdiction", filters.jurisdiction);
    if (filters.publishable === "yes") query = query.filter("source_metadata->collection->>publishable", "eq", "true");
    if (filters.publishable === "no") query = query.or("source_metadata->collection->>publishable.is.null,source_metadata->collection->>publishable.neq.true");
    if (filters.hasSummary === "yes") query = query.not("summary_json", "is", null);
    if (filters.hasSummary === "no") query = query.is("summary_json", null);

    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;
    const { data, error, count } = await query.range(from, to);
    if (error) throw new Error(error.message);

    const rows = (data ?? []) as AdminOpsArticleListRow[];
    const total = count ?? from + rows.length;

    return {
      rows,
      pageInfo: {
        page,
        pageSize,
        total,
        hasMore: from + rows.length < total,
        totalIsExact: true,
      },
    };
  }

  return {
    isConfigured,
    loadDashboardSnapshot,
    loadArticleRows,
    loadCandidateRows,
    countTableRows,
    listAdminArticles,
  };
}
