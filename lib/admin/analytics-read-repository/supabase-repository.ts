import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  AdminAnalyticsArticleRow,
  AdminAnalyticsIngestionRunRow,
  AdminAnalyticsReadRepository,
  AdminAnalyticsSiteEventRow,
  AdminAnalyticsSiteEventsResult,
  AdminAuditEntryRowsRequest,
  AdminAuditEntryRowsResult,
} from "@/lib/admin/analytics-read-repository/types";

const ADMIN_AUDIT_SELECT = "id, occurred_at, event_type, path, article_slug, source_key, metadata";
const ADMIN_AUDIT_LIMIT = 1000;

const SITE_EVENT_BASE_SELECT =
  "occurred_at, event_type, path, article_slug, article_title, tag_slug, tag_name, source_key, jurisdiction, institution_name, search_query, search_mode, result_count, referrer_host, user_agent_family, device_type, metadata";
const SITE_EVENT_ACCESS_INFO_SELECT = `${SITE_EVENT_BASE_SELECT}, client_ip_hash, accept_language, client_country, is_bot`;
const SITE_EVENT_LIMIT = 10_000;

const INGESTION_RUN_SELECT =
  "source_key, status, discovered_count, fetched_count, summarized_count, failed_count, started_at";
const INGESTION_RUN_LIMIT = 1000;

const ARTICLE_SUMMARY_SELECT =
  "status, source_key, summary_json, error_metadata, source_metadata, summarized_at, updated_at";
const ARTICLE_SUMMARY_PAGE_SIZE = 1000;

export interface SupabaseAdminAnalyticsReadDependencies {
  /** Resolves the admin client. Resolved once by the selection point. */
  client: () => SupabaseClient;
}

/**
 * Supabase-backed privileged admin analytics/audit read access. This is the
 * authoritative M4 implementation: it preserves the exact pre-extraction
 * selects, event-type filters, orderings, limits, 1000-row paging loop, and
 * every error semantic verbatim (audit action options resolve to `[]` on error;
 * audit entry reads report `{ status: "error" }`; the `site_events` analytics
 * read falls back to the legacy select and reports `schemaReady` exactly as
 * before; ingestion reads resolve to `[]`; the article read keeps partial rows
 * on a later page error; the snapshot resolves to `null` on error).
 */
export function createSupabaseAdminAnalyticsReadRepository(
  dependencies: SupabaseAdminAnalyticsReadDependencies,
): AdminAnalyticsReadRepository {
  const client = dependencies.client;

  function isConfigured() {
    return true;
  }

  async function loadAdminAuditActionOptionRows(eventTypes: string[]): Promise<AdminAnalyticsSiteEventRow[]> {
    const { data, error } = await client()
      .from("site_events")
      .select(ADMIN_AUDIT_SELECT)
      .in("event_type", eventTypes)
      .order("occurred_at", { ascending: false })
      .limit(ADMIN_AUDIT_LIMIT);

    if (error) return [];
    return (data ?? []) as AdminAnalyticsSiteEventRow[];
  }

  async function loadAdminAuditEntryRows(
    request: AdminAuditEntryRowsRequest,
  ): Promise<AdminAuditEntryRowsResult> {
    const query = client()
      .from("site_events")
      .select(ADMIN_AUDIT_SELECT, { count: "exact" })
      .in("event_type", request.eventTypes)
      .order("occurred_at", { ascending: false });

    if (request.filtered) {
      const { data, error } = await query.limit(ADMIN_AUDIT_LIMIT);
      if (error) return { status: "error" };
      return { status: "ok", rows: (data ?? []) as AdminAnalyticsSiteEventRow[], count: null };
    }

    const { data, error, count } = await query.range(request.from, request.to);
    if (error) return { status: "error" };
    return { status: "ok", rows: (data ?? []) as AdminAnalyticsSiteEventRow[], count: count ?? null };
  }

  async function loadSiteEvents(since: string): Promise<AdminAnalyticsSiteEventsResult> {
    const supabase = client();
    const { data, error } = await supabase
      .from("site_events")
      .select(SITE_EVENT_ACCESS_INFO_SELECT)
      .gte("occurred_at", since)
      .order("occurred_at", { ascending: false })
      .limit(SITE_EVENT_LIMIT);

    if (error) {
      const fallback = await supabase
        .from("site_events")
        .select(SITE_EVENT_BASE_SELECT)
        .gte("occurred_at", since)
        .order("occurred_at", { ascending: false })
        .limit(SITE_EVENT_LIMIT);

      if (fallback.error) return { rows: [], schemaReady: false };
      return { rows: (fallback.data ?? []) as AdminAnalyticsSiteEventRow[], schemaReady: true };
    }

    return { rows: (data ?? []) as AdminAnalyticsSiteEventRow[], schemaReady: true };
  }

  async function loadIngestionRunRows(since: string): Promise<AdminAnalyticsIngestionRunRow[]> {
    const { data, error } = await client()
      .from("ingestion_runs")
      .select(INGESTION_RUN_SELECT)
      .gte("started_at", since)
      .order("started_at", { ascending: false })
      .limit(INGESTION_RUN_LIMIT);

    if (error) return [];
    return (data ?? []) as AdminAnalyticsIngestionRunRow[];
  }

  async function loadArticleSummaryRows(): Promise<AdminAnalyticsArticleRow[]> {
    const supabase = client();
    const rows: AdminAnalyticsArticleRow[] = [];
    let start = 0;

    while (true) {
      const { data, error } = await supabase
        .from("articles")
        .select(ARTICLE_SUMMARY_SELECT)
        .range(start, start + ARTICLE_SUMMARY_PAGE_SIZE - 1);

      if (error) return rows;
      rows.push(...((data ?? []) as AdminAnalyticsArticleRow[]));
      if (!data || data.length < ARTICLE_SUMMARY_PAGE_SIZE) break;
      start += ARTICLE_SUMMARY_PAGE_SIZE;
    }

    return rows;
  }

  async function loadAnalyticsHealthSnapshot(days: number): Promise<unknown | null> {
    const { data, error } = await client().rpc("rpc_admin_analytics_health_snapshot", { days });
    if (error) return null;
    return data ?? null;
  }

  return {
    isConfigured,
    loadAdminAuditActionOptionRows,
    loadAdminAuditEntryRows,
    loadSiteEvents,
    loadIngestionRunRows,
    loadArticleSummaryRows,
    loadAnalyticsHealthSnapshot,
  };
}
