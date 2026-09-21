/**
 * Platform-neutral contract for the privileged admin analytics/audit read
 * domain that backs `getAdminAuditLogData` and `getAnalyticsDashboardData`:
 * the admin audit `site_events` reads, the analytics `site_events` read, the
 * legacy `ingestion_runs` / `articles` health reads, and the
 * `rpc_admin_analytics_health_snapshot` snapshot.
 *
 * This is a privileged authority and is deliberately kept separate from the
 * public `ArticleReadRepository` / `ReferenceReadRepository`: these reads expose
 * private/unpublished administrative state and must never be composed into a
 * public surface.
 *
 * The contract exposes no Postgres/Supabase types so a future platform adapter
 * can implement it without callers changing. Aggregation, redaction, timeline
 * bucketing, recommendations, snapshot parsing/mapping, compatibility
 * observations, audit filtering, and page assembly stay in `lib/db/analytics.ts`
 * — this seam owns only the data access. The Supabase-backed implementation
 * remains authoritative during M4.
 */

export interface AdminAnalyticsSiteEventRow {
  id?: string | null;
  occurred_at: string;
  event_type: string;
  path?: string | null;
  article_slug?: string | null;
  article_title?: string | null;
  tag_slug?: string | null;
  tag_name?: string | null;
  source_key?: string | null;
  jurisdiction?: string | null;
  institution_name?: string | null;
  search_query?: string | null;
  search_mode?: string | null;
  result_count?: number | null;
  referrer_host?: string | null;
  user_agent_family?: string | null;
  device_type?: string | null;
  client_ip_hash?: string | null;
  accept_language?: string | null;
  client_country?: string | null;
  is_bot?: boolean | null;
  metadata?: Record<string, unknown> | null;
}

export interface AdminAnalyticsIngestionRunRow {
  source_key: string;
  status: string;
  discovered_count?: number | null;
  fetched_count?: number | null;
  summarized_count?: number | null;
  failed_count?: number | null;
  started_at?: string | null;
}

export interface AdminAnalyticsArticleRow {
  status: string;
  source_key?: string | null;
  summary_json?: {
    aiMetadata?: {
      provider?: string;
      model?: string;
      generatedAt?: string;
    };
  } | null;
  error_metadata?: Record<string, unknown> | null;
  source_metadata?: Record<string, unknown> | null;
  summarized_at?: string | null;
  updated_at?: string | null;
}

export interface AdminAnalyticsSiteEventsResult {
  rows: AdminAnalyticsSiteEventRow[];
  /**
   * Preserves the pre-extraction semantics exactly: `true` when the access-info
   * read (or its legacy fallback) succeeded, `false` when no database is
   * configured or both reads failed.
   */
  schemaReady: boolean;
}

export interface AdminAuditEntryRowsRequest {
  /** The admin event types to include; the caller owns the event-set choice. */
  eventTypes: string[];
  /**
   * True for the `action`/`q` branch, where the caller filters and pages
   * client-side: the read takes the most recent 1000 rows with no count/range.
   * False for the unfiltered branch, where the read uses exact-count range
   * pagination.
   */
  filtered: boolean;
  from: number;
  to: number;
}

export type AdminAuditEntryRowsResult =
  | { status: "ok"; rows: AdminAnalyticsSiteEventRow[]; count: number | null }
  | { status: "error" };

export interface AdminAnalyticsReadRepository {
  /** True when an authoritative database is configured. */
  isConfigured(): boolean;
  /**
   * The most recent admin audit `site_events` rows (select/event-type filter/
   * `occurred_at desc`/limit 1000) used to derive the audit action options.
   * Resolves to `[]` on error or when no database is configured.
   */
  loadAdminAuditActionOptionRows(eventTypes: string[]): Promise<AdminAnalyticsSiteEventRow[]>;
  /**
   * The admin audit `site_events` rows backing the audit log. The exact select,
   * event-type filter, `occurred_at desc` ordering, the `action`/`q` limit-1000
   * branch, and the exact-count range branch are owned here; the caller maps,
   * redacts, filters, and assembles the page. An error resolves to
   * `{ status: "error" }` so the caller keeps its `schemaReady: false` result.
   */
  loadAdminAuditEntryRows(request: AdminAuditEntryRowsRequest): Promise<AdminAuditEntryRowsResult>;
  /**
   * The analytics `site_events` read: the access-info select first, then the
   * legacy base select when the access-info column set is not available. Both
   * carry `occurred_at >= since`, `occurred_at desc`, and limit 10,000.
   */
  loadSiteEvents(since: string): Promise<AdminAnalyticsSiteEventsResult>;
  /**
   * The legacy `ingestion_runs` health read (`started_at >= since`,
   * `started_at desc`, limit 1000). Resolves to `[]` on error or when no
   * database is configured.
   */
  loadIngestionRunRows(since: string): Promise<AdminAnalyticsIngestionRunRow[]>;
  /**
   * The legacy `articles` health read, paged in 1000-row windows with no
   * artificial cap. A later page error keeps the rows already read.
   */
  loadArticleSummaryRows(): Promise<AdminAnalyticsArticleRow[]>;
  /**
   * The raw `rpc_admin_analytics_health_snapshot` payload, or `null` when no
   * database is configured or the RPC fails. The caller parses, maps, and falls
   * back, so an invalid payload still resolves to the legacy path.
   */
  loadAnalyticsHealthSnapshot(days: number): Promise<unknown | null>;
}
