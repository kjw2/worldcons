import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  AdminOpsArticleRow,
  AdminOpsCandidateRow,
  AdminOpsCountTable,
  AdminOpsReadRepository,
} from "@/lib/admin/ops-read-repository/types";

const ARTICLE_ROW_SELECT =
  "id, slug, source_key, jurisdiction, institution_name, original_url, original_title, korean_title, original_published_at, fetched_at, summarized_at, status, source_metadata, error_metadata, updated_at";
const CANDIDATE_ROW_SELECT = "source_key, status, candidate_type, created_at, last_attempt_at";
const PAGE_SIZE = 1000;

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

  return {
    isConfigured,
    loadDashboardSnapshot,
    loadArticleRows,
    loadCandidateRows,
    countTableRows,
  };
}
