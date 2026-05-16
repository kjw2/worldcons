import { getSupabaseAdmin } from "@/lib/db/client";

const DEFAULT_ANALYTICS_DAYS = 30;

interface SiteEventRow {
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

export interface AdminActionStat {
  action: string;
  count: number;
}

export interface AnalyticsDashboardData {
  generatedAt: string;
  hasDatabase: boolean;
  schemaReady: boolean;
  days: number;
  totals: {
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
  referrers: DimensionStat[];
  devices: DimensionStat[];
  userAgents: DimensionStat[];
  collectionHealth: CollectionHealthStat[];
  modelHealth: ModelHealthStat[];
  adminActions: AdminActionStat[];
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

function numberValue(value?: number | null) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function percent(numerator: number, denominator: number) {
  return denominator > 0 ? Math.round((numerator / denominator) * 100) : 0;
}

async function loadSiteEvents(days: number) {
  const supabase = getSupabaseAdmin();
  if (!supabase) return { rows: [] as SiteEventRow[], schemaReady: false };

  const { data, error } = await supabase
    .from("site_events")
    .select(
      "occurred_at, event_type, path, article_slug, article_title, tag_slug, tag_name, source_key, jurisdiction, institution_name, search_query, search_mode, result_count, referrer_host, user_agent_family, device_type, metadata",
    )
    .gte("occurred_at", sinceIso(days))
    .order("occurred_at", { ascending: false })
    .limit(10_000);

  if (error) {
    return { rows: [] as SiteEventRow[], schemaReady: false };
  }

  return { rows: (data ?? []) as SiteEventRow[], schemaReady: true };
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
  const referrers = new Map<string, number>();
  const devices = new Map<string, number>();
  const userAgents = new Map<string, number>();

  for (const event of events) {
    if (event.jurisdiction) increment(jurisdictions, event.jurisdiction);
    if (event.source_key) increment(sources, event.source_key);
    if (event.referrer_host) increment(referrers, event.referrer_host);
    if (event.device_type) increment(devices, event.device_type);
    if (event.user_agent_family) increment(userAgents, event.user_agent_family);
  }

  return {
    jurisdictionViews: topDimensions(jurisdictions),
    sourceViews: topDimensions(sources),
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
  return /^gpt-|^o\d|^chatgpt-/i.test(model) ? "openai" : model.includes("gemini") ? "gemini" : "unknown";
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
  const [{ rows: events, schemaReady }, ingestionRuns, articleRows] = await Promise.all([
    loadSiteEvents(days),
    loadIngestionRunRows(days),
    loadArticleSummaryRows(),
  ]);

  const searchQueries = buildSearchQueries(events);
  const popularArticles = buildPopularArticles(events);
  const tagInteractions = buildTagInteractions(events);
  const collectionHealth = buildCollectionHealth(ingestionRuns);
  const modelHealth = buildModelHealth(articleRows);
  const dimensions = buildEventDimensions(events);
  const adminActions = buildAdminActions(events);
  const totals = {
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
    referrers: dimensions.referrers,
    devices: dimensions.devices,
    userAgents: dimensions.userAgents,
    collectionHealth,
    modelHealth,
    adminActions,
    recommendations: buildRecommendations({ schemaReady, searchQueries, collectionHealth, modelHealth, popularArticles, tagInteractions }),
  };
}
