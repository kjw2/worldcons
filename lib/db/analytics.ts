import { getSupabaseAdmin } from "@/lib/db/client";
import { recordCompatibilityObservation } from "@/lib/admin/p5/observations";

const DEFAULT_ANALYTICS_DAYS = 30;

interface SiteEventRow {
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

interface AnalyticsIngestionRunRow {
  source_key: string;
  status: string;
  discovered_count?: number | null;
  fetched_count?: number | null;
  summarized_count?: number | null;
  failed_count?: number | null;
  started_at?: string | null;
}

interface AnalyticsArticleRow {
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

export interface PopularArticleStat {
  slug: string;
  title: string;
  sourceKey?: string | null;
  jurisdiction?: string | null;
  views: number;
}

export interface SearchQueryStat {
  query: string;
  count: number;
  zeroResultCount: number;
  averageResults: number;
  modes: string[];
}

export interface TagInteractionStat {
  slug: string;
  name: string;
  clicks: number;
  views: number;
  total: number;
}

export interface DimensionStat {
  key: string;
  count: number;
}

export interface CollectionHealthStat {
  sourceKey: string;
  runs: number;
  completedRuns: number;
  failedRuns: number;
  discovered: number;
  fetched: number;
  failedItems: number;
  summarized: number;
  fetchRate: number;
}

export interface ModelHealthStat {
  provider: string;
  model: string;
  successes: number;
  failures: number;
  total: number;
  failureRate: number;
}

interface AnalyticsHealthSnapshot {
  collectionHealth?: Array<{
    sourceKey?: string | null;
    runs?: number | string | null;
    completedRuns?: number | string | null;
    failedRuns?: number | string | null;
    discovered?: number | string | null;
    fetched?: number | string | null;
    failedItems?: number | string | null;
    summarized?: number | string | null;
    fetchRate?: number | string | null;
  }> | null;
  modelHealth?: Array<{
    provider?: string | null;
    model?: string | null;
    successes?: number | string | null;
    failures?: number | string | null;
    total?: number | string | null;
    failureRate?: number | string | null;
  }> | null;
}

interface AnalyticsHealthData {
  collectionHealth: CollectionHealthStat[];
  modelHealth: ModelHealthStat[];
}

export interface AdminActionStat {
  action: string;
  count: number;
}

export interface AccessLogEntry {
  occurredAt: string;
  eventType: string;
  path?: string | null;
  label: string;
  referrerHost?: string | null;
  userAgentFamily?: string | null;
  deviceType?: string | null;
  clientIpHash?: string | null;
  acceptLanguage?: string | null;
  location?: string | null;
  isBot?: boolean | null;
  resultCount?: number | null;
}

export interface AdminAuditLogEntry {
  id: string;
  createdAt: string;
  eventType: string;
  action: string;
  path?: string | null;
  articleSlug?: string | null;
  sourceKey?: string | null;
  provider?: string | null;
  model?: string | null;
  result?: string | null;
  error?: string | null;
  metadata: Record<string, unknown>;
}

export interface AdminAuditLogData {
  generatedAt: string;
  hasDatabase: boolean;
  schemaReady: boolean;
  filters: {
    eventType?: string;
    action?: string;
    q?: string;
    page: number;
    pageSize: number;
  };
  entries: AdminAuditLogEntry[];
  actionOptions: string[];
  pageInfo: {
    page: number;
    pageSize: number;
    total: number;
    hasMore: boolean;
  };
}

export interface TimelineBucket {
  key: string;
  label: string;
  total: number;
  pageViews: number;
  articleViews: number;
  searches: number;
  zeroResultSearches: number;
  tagEvents: number;
  adminActions: number;
}

export interface AnalyticsDashboardData {
  generatedAt: string;
  hasDatabase: boolean;
  schemaReady: boolean;
  days: number;
  totals: {
    totalEvents: number;
    pageViews: number;
    articleViews: number;
    searches: number;
    zeroResultSearches: number;
    tagClicks: number;
    tagViews: number;
    sourceViews: number;
    adminActions: number;
  };
  popularArticles: PopularArticleStat[];
  searchQueries: SearchQueryStat[];
  zeroResultQueries: SearchQueryStat[];
  tagInteractions: TagInteractionStat[];
  jurisdictionViews: DimensionStat[];
  sourceViews: DimensionStat[];
  clientIps: DimensionStat[];
  clientCountries: DimensionStat[];
  referrers: DimensionStat[];
  devices: DimensionStat[];
  userAgents: DimensionStat[];
  collectionHealth: CollectionHealthStat[];
  modelHealth: ModelHealthStat[];
  adminActions: AdminActionStat[];
  dailyTimeline: TimelineBucket[];
  monthlyTimeline: TimelineBucket[];
  accessLogs: AccessLogEntry[];
  recommendations: string[];
}

function sinceIso(days: number) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function safeDays(days?: number) {
  return Number.isFinite(days) && days && days > 0 ? Math.min(Math.round(days), 180) : DEFAULT_ANALYTICS_DAYS;
}

function increment(map: Map<string, number>, key?: string | null, amount = 1) {
  const normalized = key?.trim() || "unknown";
  map.set(normalized, (map.get(normalized) ?? 0) + amount);
}

function topDimensions(map: Map<string, number>, limit = 10): DimensionStat[] {
  return [...map.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, limit);
}

function clientIpHashPreview(hash?: string | null) {
  const normalized = hash?.trim();
  return normalized ? normalized.slice(0, 12) : "hash 없음";
}

function numberValue(value?: number | null) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function numericValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function stringMetadataValue(metadata: Record<string, unknown> | null | undefined, keys: string[]) {
  for (const key of keys) {
    const value = metadata?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    if (typeof value === "boolean") return value ? "true" : "false";
  }
  return null;
}

function normalizeAuditPage(page?: number) {
  return Number.isFinite(page) && page && page > 0 ? Math.floor(page) : 1;
}

function normalizeAuditPageSize(pageSize?: number) {
  return Number.isFinite(pageSize) && pageSize && pageSize > 0 ? Math.min(Math.floor(pageSize), 100) : 25;
}

function normalizeAuditFilter(value?: string | null, max = 120) {
  const text = value?.trim();
  return text ? text.slice(0, max) : undefined;
}

function isAdminAuditEventType(value?: string | null) {
  return value === "admin_action" || value === "admin_review_action";
}

function percent(numerator: number, denominator: number) {
  return denominator > 0 ? Math.round((numerator / denominator) * 100) : 0;
}

function kstParts(input: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(input));
  const year = parts.find((part) => part.type === "year")?.value ?? "1970";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  return { year, month, day };
}

function dayKey(input: string) {
  const parts = kstParts(input);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function monthKey(input: string) {
  const parts = kstParts(input);
  return `${parts.year}-${parts.month}`;
}

function labelForEvent(event: SiteEventRow) {
  if (event.event_type === "article_view") return event.article_title || event.article_slug || event.path || "자료 조회";
  if (event.event_type === "search") return event.search_query ? `검색: ${event.search_query}` : "검색";
  if (event.event_type === "tag_click") return event.tag_name ? `태그 클릭: ${event.tag_name}` : "태그 클릭";
  if (event.event_type === "tag_view") return event.tag_name ? `태그 조회: ${event.tag_name}` : "태그 조회";
  if (event.event_type === "source_view") return event.institution_name || event.source_key || "기관 조회";
  if (event.event_type === "admin_action" || event.event_type === "admin_review_action") {
    return typeof event.metadata?.action === "string" ? `관리자: ${event.metadata.action}` : "관리자 작업";
  }
  return event.path || event.event_type;
}

function redactSensitiveText(value?: string | null) {
  if (!value) return value;
  return value
    .replace(/sk-(?:proj-)?[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, "[redacted]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]{16,}/gi, "$1[redacted]")
    .replace(/([?&](?:secret|token|key|api_key)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/((?:api[_-]?key|token|secret|password)\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]");
}

export function adminAuditEntryFromSiteEvent(event: SiteEventRow): AdminAuditLogEntry {
  const metadata = event.metadata ?? {};
  const action = redactSensitiveText(stringMetadataValue(metadata, ["action", "resolvedAction", "requestedAction"]) ?? event.event_type) ?? event.event_type;
  const result = redactSensitiveText(
    stringMetadataValue(metadata, ["result", "status", "reviewStatus", "mode"]) ??
      (metadata.refreshed === true ? "refreshed" : metadata.refreshed === false ? "not_refreshed" : null),
  );

  return {
    id: event.id ?? `${event.occurred_at}:${event.event_type}:${event.path ?? ""}:${action}`,
    createdAt: event.occurred_at,
    eventType: event.event_type,
    action,
    path: redactSensitiveText(event.path),
    articleSlug: redactSensitiveText(event.article_slug ?? stringMetadataValue(metadata, ["articleSlug", "slug"])),
    sourceKey: redactSensitiveText(event.source_key ?? stringMetadataValue(metadata, ["sourceKey", "requestedSourceKey"])),
    provider: redactSensitiveText(stringMetadataValue(metadata, ["provider", "requestedProvider"])),
    model: redactSensitiveText(stringMetadataValue(metadata, ["model", "requestedModel"])),
    result,
    error: redactSensitiveText(stringMetadataValue(metadata, ["error", "errorMessage", "message"])),
    metadata,
  };
}

function matchesAuditFilters(entry: AdminAuditLogEntry, filters: { action?: string; q?: string }) {
  if (filters.action && entry.action !== filters.action) return false;
  if (!filters.q) return true;

  const needle = filters.q.toLowerCase();
  const haystack = [
    entry.eventType,
    entry.action,
    entry.path,
    entry.articleSlug,
    entry.sourceKey,
    entry.provider,
    entry.model,
    entry.result,
    entry.error,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(needle);
}

function auditActionOptionsFromEvents(rows: SiteEventRow[]) {
  return Array.from(new Set(rows.map(adminAuditEntryFromSiteEvent).map((entry) => entry.action).filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

async function loadAdminAuditActionOptions(eventType?: string) {
  const supabase = getSupabaseAdmin();
  if (!supabase) return [] as string[];

  const { data, error } = await supabase
    .from("site_events")
    .select("id, occurred_at, event_type, path, article_slug, source_key, metadata")
    .in("event_type", isAdminAuditEventType(eventType) ? [eventType] : ["admin_action", "admin_review_action"])
    .order("occurred_at", { ascending: false })
    .limit(1000);

  if (error) return [];
  return auditActionOptionsFromEvents((data ?? []) as SiteEventRow[]);
}

async function loadSiteEvents(days: number) {
  const supabase = getSupabaseAdmin();
  if (!supabase) return { rows: [] as SiteEventRow[], schemaReady: false };

  const baseSelect =
    "occurred_at, event_type, path, article_slug, article_title, tag_slug, tag_name, source_key, jurisdiction, institution_name, search_query, search_mode, result_count, referrer_host, user_agent_family, device_type, metadata";
  const accessInfoSelect = `${baseSelect}, client_ip_hash, accept_language, client_country, is_bot`;

  const { data, error } = await supabase
    .from("site_events")
    .select(accessInfoSelect)
    .gte("occurred_at", sinceIso(days))
    .order("occurred_at", { ascending: false })
    .limit(10_000);

  if (error) {
    const fallback = await supabase
      .from("site_events")
      .select(baseSelect)
      .gte("occurred_at", sinceIso(days))
      .order("occurred_at", { ascending: false })
      .limit(10_000);

    if (fallback.error) return { rows: [] as SiteEventRow[], schemaReady: false };
    return { rows: (fallback.data ?? []) as SiteEventRow[], schemaReady: true };
  }

  return { rows: (data ?? []) as SiteEventRow[], schemaReady: true };
}

export async function getAdminAuditLogData(options: {
  eventType?: string;
  action?: string;
  q?: string;
  page?: number;
  pageSize?: number;
} = {}): Promise<AdminAuditLogData> {
  const supabase = getSupabaseAdmin();
  const page = normalizeAuditPage(options.page);
  const pageSize = normalizeAuditPageSize(options.pageSize);
  const eventType = normalizeAuditFilter(options.eventType);
  const action = normalizeAuditFilter(options.action);
  const q = normalizeAuditFilter(options.q, 200);

  if (!supabase) {
    return {
      generatedAt: new Date().toISOString(),
      hasDatabase: false,
      schemaReady: true,
      filters: { eventType, action, q, page, pageSize },
      entries: [],
      actionOptions: [],
      pageInfo: { page, pageSize, total: 0, hasMore: false },
    };
  }

  const actionOptions = await loadAdminAuditActionOptions(eventType);
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;
  const baseQuery = supabase
    .from("site_events")
    .select("id, occurred_at, event_type, path, article_slug, source_key, metadata", { count: "exact" })
    .in("event_type", isAdminAuditEventType(eventType) ? [eventType] : ["admin_action", "admin_review_action"])
    .order("occurred_at", { ascending: false });

  if (action || q) {
    const { data, error } = await baseQuery.limit(1000);
    if (error) {
      return {
        generatedAt: new Date().toISOString(),
        hasDatabase: true,
        schemaReady: false,
        filters: { eventType, action, q, page, pageSize },
        entries: [],
        actionOptions,
        pageInfo: { page, pageSize, total: 0, hasMore: false },
      };
    }

    const filteredEntries = ((data ?? []) as SiteEventRow[])
      .map(adminAuditEntryFromSiteEvent)
      .filter((entry) => matchesAuditFilters(entry, { action, q }));
    const entries = filteredEntries.slice(from, from + pageSize);

    return {
      generatedAt: new Date().toISOString(),
      hasDatabase: true,
      schemaReady: true,
      filters: { eventType, action, q, page, pageSize },
      entries,
      actionOptions,
      pageInfo: {
        page,
        pageSize,
        total: filteredEntries.length,
        hasMore: from + entries.length < filteredEntries.length,
      },
    };
  }

  const { data, error, count } = await baseQuery.range(from, to);
  if (error) {
    return {
      generatedAt: new Date().toISOString(),
      hasDatabase: true,
      schemaReady: false,
      filters: { eventType, action, q, page, pageSize },
      entries: [],
      actionOptions,
      pageInfo: { page, pageSize, total: 0, hasMore: false },
    };
  }

  const entries = ((data ?? []) as SiteEventRow[]).map(adminAuditEntryFromSiteEvent);
  const total = count ?? from + entries.length;
  return {
    generatedAt: new Date().toISOString(),
    hasDatabase: true,
    schemaReady: true,
    filters: { eventType, action, q, page, pageSize },
    entries,
    actionOptions,
    pageInfo: {
      page,
      pageSize,
      total,
      hasMore: from + entries.length < total,
    },
  };
}

async function loadIngestionRunRows(days: number): Promise<AnalyticsIngestionRunRow[]> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("ingestion_runs")
    .select("source_key, status, discovered_count, fetched_count, summarized_count, failed_count, started_at")
    .gte("started_at", sinceIso(days))
    .order("started_at", { ascending: false })
    .limit(1000);

  if (error) return [];
  return (data ?? []) as AnalyticsIngestionRunRow[];
}

async function loadArticleSummaryRows(): Promise<AnalyticsArticleRow[]> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return [];

  const rows: AnalyticsArticleRow[] = [];
  const pageSize = 1000;
  let start = 0;

  while (true) {
    const { data, error } = await supabase
      .from("articles")
      .select("status, source_key, summary_json, error_metadata, source_metadata, summarized_at, updated_at")
      .range(start, start + pageSize - 1);

    if (error) return rows;
    rows.push(...((data ?? []) as AnalyticsArticleRow[]));
    if (!data || data.length < pageSize) break;
    start += pageSize;
  }

  return rows;
}

function parseAnalyticsHealthSnapshot(input: unknown): AnalyticsHealthSnapshot | null {
  const value = typeof input === "string" ? JSON.parse(input) : input;
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as AnalyticsHealthSnapshot) : null;
}

async function loadAnalyticsHealthSnapshot(days: number): Promise<AnalyticsHealthData | null> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return null;

  const { data, error } = await supabase.rpc("rpc_admin_analytics_health_snapshot", { days });
  if (error) return null;

  try {
    const snapshot = parseAnalyticsHealthSnapshot(data);
    if (!snapshot) return null;
    const collectionHealth = (snapshot.collectionHealth ?? [])
      .map((row) => ({
        sourceKey: row.sourceKey || "unknown",
        runs: numericValue(row.runs),
        completedRuns: numericValue(row.completedRuns),
        failedRuns: numericValue(row.failedRuns),
        discovered: numericValue(row.discovered),
        fetched: numericValue(row.fetched),
        failedItems: numericValue(row.failedItems),
        summarized: numericValue(row.summarized),
        fetchRate: numericValue(row.fetchRate),
      }))
      .sort((a, b) => a.fetchRate - b.fetchRate || b.runs - a.runs || a.sourceKey.localeCompare(b.sourceKey))
      .slice(0, 60);
    const modelHealth = (snapshot.modelHealth ?? [])
      .map((row) => ({
        provider: row.provider || "unknown",
        model: row.model || "unknown",
        successes: numericValue(row.successes),
        failures: numericValue(row.failures),
        total: numericValue(row.total),
        failureRate: numericValue(row.failureRate),
      }))
      .sort((a, b) => b.total - a.total || b.failureRate - a.failureRate || a.model.localeCompare(b.model))
      .slice(0, 15);
    return { collectionHealth, modelHealth };
  } catch {
    return null;
  }
}

async function loadAnalyticsHealthData(days: number): Promise<AnalyticsHealthData> {
  const snapshot = await loadAnalyticsHealthSnapshot(days);
  if (snapshot) {
    recordCompatibilityObservation({ surface: "admin_analytics", domain: "operations", direction: "read", authority: "new", outcome: "succeeded" });
    return snapshot;
  }
  recordCompatibilityObservation({ surface: "admin_analytics", domain: "operations", direction: "read", authority: "fallback", outcome: "fallback" });

  const [ingestionRuns, articleRows] = await Promise.all([
    loadIngestionRunRows(days),
    loadArticleSummaryRows(),
  ]);
  return {
    collectionHealth: buildCollectionHealth(ingestionRuns),
    modelHealth: buildModelHealth(articleRows),
  };
}

function buildPopularArticles(events: SiteEventRow[]) {
  const groups = new Map<string, PopularArticleStat>();
  for (const event of events) {
    if (event.event_type !== "article_view" || !event.article_slug) continue;
    const current = groups.get(event.article_slug) ?? {
      slug: event.article_slug,
      title: event.article_title || event.article_slug,
      sourceKey: event.source_key,
      jurisdiction: event.jurisdiction,
      views: 0,
    };
    current.views += 1;
    current.title = event.article_title || current.title;
    current.sourceKey = event.source_key || current.sourceKey;
    current.jurisdiction = event.jurisdiction || current.jurisdiction;
    groups.set(event.article_slug, current);
  }
  return [...groups.values()].sort((a, b) => b.views - a.views || a.title.localeCompare(b.title)).slice(0, 12);
}

function buildSearchQueries(events: SiteEventRow[]) {
  const groups = new Map<string, { count: number; zeroResultCount: number; resultTotal: number; modes: Set<string> }>();
  for (const event of events) {
    if (event.event_type !== "search" || !event.search_query) continue;
    const current = groups.get(event.search_query) ?? { count: 0, zeroResultCount: 0, resultTotal: 0, modes: new Set<string>() };
    const resultCount = numberValue(event.result_count);
    current.count += 1;
    current.resultTotal += resultCount;
    if (resultCount === 0) current.zeroResultCount += 1;
    if (event.search_mode) current.modes.add(event.search_mode);
    groups.set(event.search_query, current);
  }

  return [...groups.entries()]
    .map(([query, value]) => ({
      query,
      count: value.count,
      zeroResultCount: value.zeroResultCount,
      averageResults: value.count > 0 ? Math.round(value.resultTotal / value.count) : 0,
      modes: [...value.modes].sort(),
    }))
    .sort((a, b) => b.count - a.count || b.zeroResultCount - a.zeroResultCount || a.query.localeCompare(b.query));
}

function buildTagInteractions(events: SiteEventRow[]) {
  const groups = new Map<string, TagInteractionStat>();
  for (const event of events) {
    if ((event.event_type !== "tag_click" && event.event_type !== "tag_view") || !event.tag_slug) continue;
    const current = groups.get(event.tag_slug) ?? {
      slug: event.tag_slug,
      name: event.tag_name || event.tag_slug,
      clicks: 0,
      views: 0,
      total: 0,
    };
    if (event.event_type === "tag_click") current.clicks += 1;
    if (event.event_type === "tag_view") current.views += 1;
    current.total += 1;
    current.name = event.tag_name || current.name;
    groups.set(event.tag_slug, current);
  }
  return [...groups.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name)).slice(0, 15);
}

function buildEventDimensions(events: SiteEventRow[]) {
  const jurisdictions = new Map<string, number>();
  const sources = new Map<string, number>();
  const clientIpIdentifiers = new Map<string, number>();
  const clientCountries = new Map<string, number>();
  const referrers = new Map<string, number>();
  const devices = new Map<string, number>();
  const userAgents = new Map<string, number>();

  for (const event of events) {
    if (event.jurisdiction) increment(jurisdictions, event.jurisdiction);
    if (event.source_key) increment(sources, event.source_key);
    increment(clientIpIdentifiers, clientIpHashPreview(event.client_ip_hash));
    if (event.client_country) increment(clientCountries, event.client_country);
    if (event.referrer_host) increment(referrers, event.referrer_host);
    if (event.device_type) increment(devices, event.device_type);
    if (event.user_agent_family) increment(userAgents, event.user_agent_family);
  }

  return {
    jurisdictionViews: topDimensions(jurisdictions),
    sourceViews: topDimensions(sources),
    clientIps: topDimensions(clientIpIdentifiers),
    clientCountries: topDimensions(clientCountries),
    referrers: topDimensions(referrers),
    devices: topDimensions(devices),
    userAgents: topDimensions(userAgents),
  };
}

function buildCollectionHealth(rows: AnalyticsIngestionRunRow[]) {
  const groups = new Map<string, CollectionHealthStat>();
  for (const row of rows) {
    const sourceKey = row.source_key || "unknown";
    const current = groups.get(sourceKey) ?? {
      sourceKey,
      runs: 0,
      completedRuns: 0,
      failedRuns: 0,
      discovered: 0,
      fetched: 0,
      failedItems: 0,
      summarized: 0,
      fetchRate: 0,
    };
    current.runs += 1;
    if (row.status === "completed") current.completedRuns += 1;
    if (row.status === "failed") current.failedRuns += 1;
    current.discovered += numberValue(row.discovered_count);
    current.fetched += numberValue(row.fetched_count);
    current.failedItems += numberValue(row.failed_count);
    current.summarized += numberValue(row.summarized_count);
    current.fetchRate = percent(current.fetched, current.discovered);
    groups.set(sourceKey, current);
  }
  return [...groups.values()].sort((a, b) => a.fetchRate - b.fetchRate || b.runs - a.runs || a.sourceKey.localeCompare(b.sourceKey));
}

function providerForModel(model: string, fallback?: string | null) {
  if (fallback) return fallback;
  if (/^claude-/i.test(model)) return "anthropic";
  if (/^gpt-|^o\d|^chatgpt-/i.test(model)) return "openai";
  return model.includes("gemini") ? "gemini" : "unknown";
}

function parsedFailureModels(row: AnalyticsArticleRow) {
  const metadata = row.error_metadata ?? {};
  const requestedModel = typeof metadata.requestedModel === "string" && metadata.requestedModel.trim() ? metadata.requestedModel.trim() : null;
  if (requestedModel) return [requestedModel];

  const message = typeof metadata.message === "string" ? metadata.message : "";
  const models = new Set<string>();
  for (const match of message.matchAll(/(?:Gemini route |"route"\s*:\s*")([^/"\s]+)\/key-\d+/g)) {
    if (match[1]) models.add(match[1]);
  }
  return [...models];
}

function buildModelHealth(rows: AnalyticsArticleRow[]) {
  const groups = new Map<string, ModelHealthStat>();

  function entry(provider: string, model: string) {
    const key = `${provider}:${model}`;
    const current = groups.get(key) ?? { provider, model, successes: 0, failures: 0, total: 0, failureRate: 0 };
    groups.set(key, current);
    return current;
  }

  for (const row of rows) {
    const aiMetadata = row.summary_json?.aiMetadata;
    if (row.status === "summarized" && aiMetadata?.model) {
      const current = entry(aiMetadata.provider || providerForModel(aiMetadata.model), aiMetadata.model);
      current.successes += 1;
      current.total += 1;
    }

    if (row.status === "failed_summary") {
      const metadata = row.error_metadata ?? {};
      const requestedProvider = typeof metadata.requestedProvider === "string" ? metadata.requestedProvider : null;
      const models = parsedFailureModels(row);
      if (models.length === 0) {
        const current = entry(requestedProvider ?? "unknown", "unknown");
        current.failures += 1;
        current.total += 1;
      } else {
        for (const model of models) {
          const current = entry(providerForModel(model, requestedProvider), model);
          current.failures += 1;
          current.total += 1;
        }
      }
    }
  }

  for (const item of groups.values()) {
    item.failureRate = percent(item.failures, item.total);
  }

  return [...groups.values()].sort((a, b) => b.total - a.total || b.failureRate - a.failureRate || a.model.localeCompare(b.model)).slice(0, 15);
}

function buildAdminActions(events: SiteEventRow[]) {
  const groups = new Map<string, number>();
  for (const event of events) {
    if (event.event_type !== "admin_action" && event.event_type !== "admin_review_action") continue;
    const action = typeof event.metadata?.action === "string" ? event.metadata.action : event.event_type;
    increment(groups, action);
  }
  return [...groups.entries()]
    .map(([action, count]) => ({ action, count }))
    .sort((a, b) => b.count - a.count || a.action.localeCompare(b.action))
    .slice(0, 10);
}

function updateTimelineBucket(bucket: TimelineBucket, event: SiteEventRow) {
  bucket.total += 1;
  if (event.event_type === "page_view") bucket.pageViews += 1;
  if (event.event_type === "article_view") bucket.articleViews += 1;
  if (event.event_type === "search") {
    bucket.searches += 1;
    if (numberValue(event.result_count) === 0) bucket.zeroResultSearches += 1;
  }
  if (event.event_type === "tag_click" || event.event_type === "tag_view") bucket.tagEvents += 1;
  if (event.event_type === "admin_action" || event.event_type === "admin_review_action") bucket.adminActions += 1;
}

function emptyTimelineBucket(key: string): TimelineBucket {
  return {
    key,
    label: key,
    total: 0,
    pageViews: 0,
    articleViews: 0,
    searches: 0,
    zeroResultSearches: 0,
    tagEvents: 0,
    adminActions: 0,
  };
}

function buildTimeline(events: SiteEventRow[], keyFor: (input: string) => string) {
  const groups = new Map<string, TimelineBucket>();
  for (const event of events) {
    const key = keyFor(event.occurred_at);
    const bucket = groups.get(key) ?? emptyTimelineBucket(key);
    updateTimelineBucket(bucket, event);
    groups.set(key, bucket);
  }
  return [...groups.values()].sort((a, b) => b.key.localeCompare(a.key)).slice(0, 60);
}

function buildAccessLogs(events: SiteEventRow[]) {
  return events.slice(0, 80).map((event) => ({
    occurredAt: event.occurred_at,
    eventType: event.event_type,
    path: event.path,
    label: labelForEvent(event),
    referrerHost: event.referrer_host,
    userAgentFamily: event.user_agent_family,
    deviceType: event.device_type,
    clientIpHash: event.client_ip_hash,
    acceptLanguage: event.accept_language,
    location: event.client_country || null,
    isBot: event.is_bot,
    resultCount: event.result_count,
  }));
}

function buildRecommendations(data: {
  schemaReady: boolean;
  searchQueries: SearchQueryStat[];
  collectionHealth: CollectionHealthStat[];
  modelHealth: ModelHealthStat[];
  popularArticles: PopularArticleStat[];
  tagInteractions: TagInteractionStat[];
}) {
  const recommendations: string[] = [];
  if (!data.schemaReady) {
    recommendations.push("site_events 테이블이 아직 없어서 이용 통계가 비어 있습니다. 최신 Supabase migration을 적용하세요.");
  }

  const topZero = data.searchQueries.find((item) => item.zeroResultCount > 0);
  if (topZero) {
    recommendations.push(`무결과 검색 '${topZero.query}'가 ${topZero.zeroResultCount}회 발생했습니다. 관련 태그, 용어사전, 공개 자료 보강 후보입니다.`);
  }

  const weakSource = data.collectionHealth.find((item) => item.runs >= 2 && item.fetchRate < 70);
  if (weakSource) {
    recommendations.push(`${weakSource.sourceKey} 수집 fetch rate가 ${weakSource.fetchRate}%입니다. robots, 목록 URL, timeout, Playwright fallback 상태를 우선 점검하세요.`);
  }

  const weakModel = data.modelHealth.find((item) => item.total >= 3 && item.failureRate >= 30);
  if (weakModel) {
    recommendations.push(`${weakModel.model} 요약 실패율이 ${weakModel.failureRate}%입니다. 모델명 전환, quota cooldown, JSON schema 응답 안정성을 확인하세요.`);
  }

  if (data.popularArticles.length > 0) {
    recommendations.push(`가장 많이 본 자료는 '${data.popularArticles[0].title}'입니다. 관련 태그와 추천 자료 연결을 우선 개선하면 사용자 체감이 큽니다.`);
  }

  if (data.tagInteractions.length > 0) {
    recommendations.push(`관심 태그 1위는 '${data.tagInteractions[0].name}'입니다. 해당 주제의 국가별/기관별 묶음 화면을 추가할 가치가 있습니다.`);
  }

  if (recommendations.length === 0) {
    recommendations.push("최근 이용 통계에서 즉시 조치할 이상 신호는 없습니다. 수집/요약 자동화와 무결과 검색만 주기적으로 확인하세요.");
  }

  return recommendations.slice(0, 6);
}

export async function getAnalyticsDashboardData(options: { days?: number } = {}): Promise<AnalyticsDashboardData> {
  const days = safeDays(options.days);
  const supabase = getSupabaseAdmin();
  const [{ rows: events, schemaReady }, healthData] = await Promise.all([
    loadSiteEvents(days),
    loadAnalyticsHealthData(days),
  ]);

  const searchQueries = buildSearchQueries(events);
  const popularArticles = buildPopularArticles(events);
  const tagInteractions = buildTagInteractions(events);
  const { collectionHealth, modelHealth } = healthData;
  const dimensions = buildEventDimensions(events);
  const adminActions = buildAdminActions(events);
  const dailyTimeline = buildTimeline(events, dayKey);
  const monthlyTimeline = buildTimeline(events, monthKey);
  const totals = {
    totalEvents: events.length,
    pageViews: events.filter((event) => event.event_type === "page_view").length,
    articleViews: events.filter((event) => event.event_type === "article_view").length,
    searches: events.filter((event) => event.event_type === "search").length,
    zeroResultSearches: events.filter((event) => event.event_type === "search" && numberValue(event.result_count) === 0).length,
    tagClicks: events.filter((event) => event.event_type === "tag_click").length,
    tagViews: events.filter((event) => event.event_type === "tag_view").length,
    sourceViews: events.filter((event) => event.event_type === "source_view").length,
    adminActions: events.filter((event) => event.event_type === "admin_action" || event.event_type === "admin_review_action").length,
  };

  return {
    generatedAt: new Date().toISOString(),
    hasDatabase: Boolean(supabase),
    schemaReady,
    days,
    totals,
    popularArticles,
    searchQueries: searchQueries.slice(0, 15),
    zeroResultQueries: searchQueries.filter((item) => item.zeroResultCount > 0).slice(0, 12),
    tagInteractions,
    jurisdictionViews: dimensions.jurisdictionViews,
    sourceViews: dimensions.sourceViews,
    clientIps: dimensions.clientIps,
    clientCountries: dimensions.clientCountries,
    referrers: dimensions.referrers,
    devices: dimensions.devices,
    userAgents: dimensions.userAgents,
    collectionHealth,
    modelHealth,
    adminActions,
    dailyTimeline,
    monthlyTimeline,
    accessLogs: buildAccessLogs(events),
    recommendations: buildRecommendations({ schemaReady, searchQueries, collectionHealth, modelHealth, popularArticles, tagInteractions }),
  };
}
