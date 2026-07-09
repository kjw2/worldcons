import { getSupabaseAdmin } from "@/lib/db/client";
import { fallbackErrorClassForArticleStatus, fallbackReviewStateForArticleStatus } from "@/lib/db/article-triage";
import { mockArticles, mockSources, mockTags } from "@/lib/db/mock-data";
import { listIngestionRuns, listSources } from "@/lib/db/queries";
import type { ArticleStatus, IngestionRunRecord, SourceRecord } from "@/lib/db/types";

const ARTICLE_STATUSES = [
  "discovered",
  "metadata_only",
  "robots_disallowed",
  "blocked",
  "timeout",
  "fetched",
  "cleaned",
  "summarizing",
  "summarized",
  "failed_fetch",
  "failed_summary",
  "needs_review",
] as const;

const ATTENTION_STATUSES = new Set([
  "metadata_only",
  "robots_disallowed",
  "blocked",
  "timeout",
  "failed_fetch",
  "failed_summary",
  "needs_review",
]);

const FAILURE_STATUSES = new Set(["blocked", "timeout", "failed_fetch", "failed_summary"]);
const DEFAULT_STALE_SUMMARIZING_MINUTES = 30;

interface AdminArticleRow {
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

interface AdminArticleListRow extends AdminArticleRow {
  summary_json?: unknown;
}

interface CandidateRow {
  source_key: string;
  status: string;
  candidate_type?: string | null;
  created_at?: string | null;
  last_attempt_at?: string | null;
}

export interface AdminStatusCount {
  status: string;
  count: number;
}

export interface AdminSourceSummary {
  sourceKey: string;
  name: string;
  jurisdiction: string;
  language: string;
  baseUrl: string;
  isActive: boolean;
  totalCount: number;
  publicCount: number;
  pendingSummaryCount: number;
  failedCount: number;
  attentionCount: number;
  latestPublishedAt?: string | null;
  latestFetchedAt?: string | null;
  latestRunStatus?: string | null;
  latestRunStartedAt?: string | null;
}

export interface AdminCandidateSummary {
  sourceKey: string;
  pendingCount: number;
  retryingCount: number;
  fetchedCount: number;
  failedCount: number;
  ignoredCount: number;
  latestCreatedAt?: string | null;
  latestAttemptAt?: string | null;
}

export interface AdminAttentionArticle {
  id?: string;
  slug: string;
  sourceKey: string;
  jurisdiction: string;
  institutionName: string;
  originalUrl: string;
  title: string;
  originalPublishedAt?: string | null;
  status: string;
  errorMessage?: string | null;
  errorClass?: string | null;
  reviewState?: string | null;
}

export interface AdminDashboardData {
  generatedAt: string;
  hasDatabase: boolean;
  totals: {
    sources: number;
    articles: number;
    publicArticles: number;
    pendingSummaries: number;
    failedArticles: number;
    attentionArticles: number;
    tags: number;
    candidates: number;
  };
  statusCounts: AdminStatusCount[];
  sourceSummaries: AdminSourceSummary[];
  candidateSummaries: AdminCandidateSummary[];
  latestRuns: IngestionRunRecord[];
  attentionArticles: AdminAttentionArticle[];
}

interface AdminDashboardSnapshotStatusCount {
  sourceKey?: string | null;
  status?: string | null;
  count?: number | string | null;
}

interface AdminDashboardSnapshotSourceSummary {
  sourceKey?: string | null;
  name?: string | null;
  jurisdiction?: string | null;
  baseUrl?: string | null;
  language?: string | null;
  isActive?: boolean | null;
  totalCount?: number | string | null;
  publicCount?: number | string | null;
  pendingSummaryCount?: number | string | null;
  attentionCount?: number | string | null;
  failedCount?: number | string | null;
  latestPublishedAt?: string | null;
  latestFetchedAt?: string | null;
  latestRunStatus?: string | null;
  latestRunStartedAt?: string | null;
}

interface AdminDashboardSnapshotCandidateSummary {
  sourceKey?: string | null;
  pendingCount?: number | string | null;
  retryingCount?: number | string | null;
  fetchedCount?: number | string | null;
  failedCount?: number | string | null;
  ignoredCount?: number | string | null;
  latestCreatedAt?: string | null;
  latestAttemptAt?: string | null;
}

interface AdminDashboardSnapshotAttentionArticle {
  id?: string | null;
  slug?: string | null;
  sourceKey?: string | null;
  jurisdiction?: string | null;
  institutionName?: string | null;
  originalUrl?: string | null;
  title?: string | null;
  originalPublishedAt?: string | null;
  status?: string | null;
  errorMessage?: string | null;
  errorClass?: string | null;
  reviewState?: string | null;
}

interface AdminDashboardSnapshot {
  totals?: {
    sources?: number | string | null;
    articles?: number | string | null;
    publicArticles?: number | string | null;
    pendingSummaries?: number | string | null;
    failedArticles?: number | string | null;
    attentionArticles?: number | string | null;
    tags?: number | string | null;
    candidates?: number | string | null;
  } | null;
  statusCounts?: AdminDashboardSnapshotStatusCount[] | null;
  sourceSummaries?: AdminDashboardSnapshotSourceSummary[] | null;
  candidateSummaries?: AdminDashboardSnapshotCandidateSummary[] | null;
  attentionArticles?: AdminDashboardSnapshotAttentionArticle[] | null;
}

export type AdminArticlePublishableFilter = "all" | "yes" | "no";
export type AdminArticleSummaryFilter = "all" | "yes" | "no";
export type AdminArticleBulkAction = "mark-needs-review" | "close-private";

export interface AdminArticleListFilters {
  q?: string;
  status?: string;
  sourceKey?: string;
  jurisdiction?: string;
  publishable?: AdminArticlePublishableFilter;
  hasSummary?: AdminArticleSummaryFilter;
  page?: number;
  pageSize?: number;
}

export interface AdminArticleListItem {
  id?: string;
  slug: string;
  title: string;
  originalTitle?: string | null;
  sourceKey: string;
  institutionName: string;
  jurisdiction: string;
  status: string;
  publishable: boolean;
  hasSummary: boolean;
  originalPublishedAt?: string | null;
  summarizedAt?: string | null;
  fetchedAt?: string | null;
}

export interface AdminArticleListResult {
  items: AdminArticleListItem[];
  pageInfo: {
    page: number;
    pageSize: number;
    total: number;
    hasMore: boolean;
    totalIsExact: boolean;
  };
}

export interface AdminArticleBulkRef {
  id?: string;
  slug?: string;
}

export interface AdminArticleBulkResult {
  mode: "database" | "no-database";
  action: AdminArticleBulkAction;
  requestedCount: number;
  matchedCount: number;
  updatedCount: number;
  notFound: AdminArticleBulkRef[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function optionalText(value: unknown) {
  return typeof value === "string" && value ? value : null;
}

function boundedAdminArticlePage(value?: number) {
  return Number.isFinite(value) && value && value > 0 ? Math.floor(value) : 1;
}

function boundedAdminArticlePageSize(value?: number) {
  return Number.isFinite(value) && value && value > 0 ? Math.min(Math.floor(value), 50) : 25;
}

function collectionFor(row: AdminArticleRow) {
  const collection = row.source_metadata?.collection;
  return isRecord(collection) ? collection : {};
}

function isPublicArticle(row: AdminArticleRow) {
  return row.status === "summarized" && collectionFor(row).publishable === true;
}

function isPublishableArticle(row: AdminArticleRow) {
  return collectionFor(row).publishable === true;
}

function isPendingSummary(row: AdminArticleRow) {
  return row.status === "cleaned" || row.status === "failed_summary" || isStaleSummarizing(row);
}

function isReviewClosed(row: AdminArticleRow) {
  const review = row.source_metadata?.review;
  return isRecord(review) && review.decision === "closed_private";
}

function staleSummarizingMinutes() {
  const value = Number(process.env.STALE_SUMMARIZING_MINUTES ?? DEFAULT_STALE_SUMMARIZING_MINUTES);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_STALE_SUMMARIZING_MINUTES;
}

function isStaleSummarizing(row: AdminArticleRow) {
  if (row.status !== "summarizing") return false;
  const updatedAt = row.updated_at ? new Date(row.updated_at).getTime() : 0;
  return Number.isFinite(updatedAt) && updatedAt > 0 && Date.now() - updatedAt > staleSummarizingMinutes() * 60 * 1000;
}

function isAttentionRow(row: AdminArticleRow) {
  return (ATTENTION_STATUSES.has(row.status) || isStaleSummarizing(row)) && !isReviewClosed(row);
}

function maxIsoDate(current?: string | null, next?: string | null) {
  if (!next) return current ?? null;
  if (!current) return next;
  return next > current ? next : current;
}

function errorMessage(row: AdminArticleRow) {
  const metadata = row.error_metadata;
  if (!metadata) return null;
  const message = metadata.message;
  return typeof message === "string" ? message : null;
}

function adminArticleTitle(row: AdminArticleRow) {
  return row.korean_title || row.original_title || "제목 미상";
}

function adminArticleRowToListItem(row: AdminArticleListRow): AdminArticleListItem {
  return {
    id: row.id,
    slug: row.slug ?? row.id ?? row.source_key,
    title: adminArticleTitle(row),
    originalTitle: row.original_title,
    sourceKey: row.source_key,
    institutionName: row.institution_name ?? row.source_key,
    jurisdiction: row.jurisdiction ?? "Unknown",
    status: row.status,
    publishable: isPublishableArticle(row),
    hasSummary: Boolean(row.summary_json),
    originalPublishedAt: row.original_published_at,
    summarizedAt: row.summarized_at,
    fetchedAt: row.fetched_at,
  };
}

function matchesAdminArticleText(row: AdminArticleListRow, q?: string) {
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

function filterAdminMockArticles(filters: AdminArticleListFilters) {
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
  })) satisfies AdminArticleListRow[];

  return rows
    .filter((row) => matchesAdminArticleText(row, filters.q))
    .filter((row) => !filters.status || row.status === filters.status)
    .filter((row) => !filters.sourceKey || row.source_key === filters.sourceKey)
    .filter((row) => !filters.jurisdiction || row.jurisdiction === filters.jurisdiction)
    .filter((row) => filters.publishable === "yes" ? isPublishableArticle(row) : filters.publishable === "no" ? !isPublishableArticle(row) : true)
    .filter((row) => filters.hasSummary === "yes" ? Boolean(row.summary_json) : filters.hasSummary === "no" ? !row.summary_json : true)
    .sort((a, b) => (b.original_published_at ?? b.fetched_at ?? "").localeCompare(a.original_published_at ?? a.fetched_at ?? ""));
}

function toAdminFullTextQuery(q?: string) {
  const terms =
    q
      ?.toLowerCase()
      .split(/\s+/)
      .map((term) => term.replace(/[^\p{L}\p{N}]+/gu, ""))
      .filter(Boolean) ?? [];

  return terms.map((term) => `${term}:*`).join(" & ");
}

function reviewMetadataForBulk(
  row: AdminArticleRow,
  action: AdminArticleBulkAction,
  note?: string,
) {
  const metadata = isRecord(row.source_metadata) ? row.source_metadata : {};
  const collection = isRecord(metadata.collection) ? metadata.collection : {};
  const reviewHistory = Array.isArray(metadata.reviewHistory) ? metadata.reviewHistory : [];
  const reviewedAt = new Date().toISOString();
  const decision = action === "close-private" ? "closed_private" : "needs_review";
  const review = {
    decision,
    note: note?.trim() || undefined,
    reviewedAt,
    previousStatus: row.status,
    action: "admin_bulk",
  };

  return {
    ...metadata,
    collection: {
      ...collection,
      publishable: false,
      confidence: "human_reviewed",
      reason:
        action === "close-private"
          ? note?.trim() || "Human review closed this item as private."
          : note?.trim() || "Human review marked this item as needing review.",
    },
    review,
    reviewHistory: [...reviewHistory.slice(-19), review],
  };
}

async function countTableRows(table: "tags" | "source_url_candidates", fallback: number) {
  const supabase = getSupabaseAdmin();
  if (!supabase) return fallback;

  const { count, error } = await supabase.from(table).select("*", { count: "exact", head: true });
  if (error) return fallback;
  return count ?? fallback;
}

async function loadArticleRows(): Promise<AdminArticleRow[]> {
  const supabase = getSupabaseAdmin();
  if (!supabase) {
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
  }

  const rows: AdminArticleRow[] = [];
  const pageSize = 1000;
  let start = 0;

  while (true) {
    const { data, error } = await supabase
      .from("articles")
      .select(
        "id, slug, source_key, jurisdiction, institution_name, original_url, original_title, korean_title, original_published_at, fetched_at, summarized_at, status, source_metadata, error_metadata, updated_at",
      )
      .range(start, start + pageSize - 1);

    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as AdminArticleRow[]));
    if (!data || data.length < pageSize) break;
    start += pageSize;
  }

  return rows;
}

async function loadCandidateRows(): Promise<CandidateRow[]> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return [];

  const rows: CandidateRow[] = [];
  const pageSize = 1000;
  let start = 0;

  while (true) {
    const { data, error } = await supabase
      .from("source_url_candidates")
      .select("source_key, status, candidate_type, created_at, last_attempt_at")
      .range(start, start + pageSize - 1);

    if (error) return [];
    rows.push(...((data ?? []) as CandidateRow[]));
    if (!data || data.length < pageSize) break;
    start += pageSize;
  }

  return rows;
}

function buildSourceSummaries(sources: SourceRecord[], rows: AdminArticleRow[], runs: IngestionRunRecord[]) {
  const summaries = new Map<string, AdminSourceSummary>();

  for (const source of sources) {
    summaries.set(source.sourceKey, {
      sourceKey: source.sourceKey,
      name: source.name,
      jurisdiction: source.jurisdiction,
      language: source.language,
      baseUrl: source.baseUrl,
      isActive: source.isActive,
      totalCount: 0,
      publicCount: 0,
      pendingSummaryCount: 0,
      failedCount: 0,
      attentionCount: 0,
      latestPublishedAt: null,
      latestFetchedAt: null,
      latestRunStatus: null,
      latestRunStartedAt: null,
    });
  }

  for (const row of rows) {
    const summary =
      summaries.get(row.source_key) ??
      {
        sourceKey: row.source_key,
        name: row.source_key,
        jurisdiction: row.jurisdiction ?? "Unknown",
        language: "-",
        baseUrl: row.original_url ?? "",
        isActive: true,
        totalCount: 0,
        publicCount: 0,
        pendingSummaryCount: 0,
        failedCount: 0,
        attentionCount: 0,
        latestPublishedAt: null,
        latestFetchedAt: null,
        latestRunStatus: null,
        latestRunStartedAt: null,
      };

    summary.totalCount += 1;
    if (isPublicArticle(row)) summary.publicCount += 1;
    if (isPendingSummary(row)) summary.pendingSummaryCount += 1;
    if (FAILURE_STATUSES.has(row.status)) summary.failedCount += 1;
    if (isAttentionRow(row)) summary.attentionCount += 1;
    summary.latestPublishedAt = maxIsoDate(summary.latestPublishedAt, row.original_published_at);
    summary.latestFetchedAt = maxIsoDate(summary.latestFetchedAt, row.fetched_at);
    summaries.set(row.source_key, summary);
  }

  for (const run of runs) {
    const summary = summaries.get(run.sourceKey);
    if (!summary || summary.latestRunStartedAt) continue;
    summary.latestRunStatus = run.status;
    summary.latestRunStartedAt = run.startedAt;
  }

  return [...summaries.values()].sort((a, b) => a.sourceKey.localeCompare(b.sourceKey));
}

function buildCandidateSummaries(sources: SourceRecord[], rows: CandidateRow[]) {
  const summaries = new Map<string, AdminCandidateSummary>();

  for (const source of sources) {
    summaries.set(source.sourceKey, {
      sourceKey: source.sourceKey,
      pendingCount: 0,
      retryingCount: 0,
      fetchedCount: 0,
      failedCount: 0,
      ignoredCount: 0,
      latestCreatedAt: null,
      latestAttemptAt: null,
    });
  }

  for (const row of rows) {
    const summary =
      summaries.get(row.source_key) ??
      {
        sourceKey: row.source_key,
        pendingCount: 0,
        retryingCount: 0,
        fetchedCount: 0,
        failedCount: 0,
        ignoredCount: 0,
        latestCreatedAt: null,
        latestAttemptAt: null,
      };

    if (row.status === "pending") summary.pendingCount += 1;
    else if (row.status === "retrying") summary.retryingCount += 1;
    else if (row.status === "fetched") summary.fetchedCount += 1;
    else if (row.status === "failed") summary.failedCount += 1;
    else if (row.status === "ignored") summary.ignoredCount += 1;
    summary.latestCreatedAt = maxIsoDate(summary.latestCreatedAt, row.created_at);
    summary.latestAttemptAt = maxIsoDate(summary.latestAttemptAt, row.last_attempt_at);
    summaries.set(row.source_key, summary);
  }

  return [...summaries.values()].sort((a, b) => a.sourceKey.localeCompare(b.sourceKey));
}

function buildAttentionArticles(rows: AdminArticleRow[]) {
  return rows
    .filter(isAttentionRow)
    .sort((a, b) => (b.updated_at ?? b.fetched_at ?? b.original_published_at ?? "").localeCompare(a.updated_at ?? a.fetched_at ?? a.original_published_at ?? ""))
    .slice(0, 8)
    .map((row) => ({
      id: row.id,
      slug: row.slug ?? row.id ?? row.source_key,
      sourceKey: row.source_key,
      jurisdiction: row.jurisdiction ?? "Unknown",
      institutionName: row.institution_name ?? row.source_key,
      originalUrl: row.original_url ?? "",
      title: row.korean_title || row.original_title || "제목 미상",
      originalPublishedAt: row.original_published_at,
      status: row.status,
      errorMessage: isStaleSummarizing(row) ? "요약 작업이 중단된 오래된 summarizing 상태입니다. 재요약 또는 비공개 결정을 내려야 합니다." : errorMessage(row),
      errorClass: row.error_class ?? fallbackErrorClassForArticleStatus(row.status),
      reviewState: row.review_state ?? fallbackReviewStateForArticleStatus(row.status),
    }));
}

function parseAdminDashboardSnapshot(input: unknown): AdminDashboardSnapshot | null {
  const value = typeof input === "string" ? JSON.parse(input) : input;
  if (!isRecord(value)) return null;
  return value as AdminDashboardSnapshot;
}

function snapshotStatusCounts(rows: AdminDashboardSnapshotStatusCount[] | null | undefined) {
  const statusMap = new Map<string, number>();
  ARTICLE_STATUSES.forEach((status) => statusMap.set(status, 0));
  for (const row of rows ?? []) {
    if (!row.status) continue;
    statusMap.set(row.status, (statusMap.get(row.status) ?? 0) + numberValue(row.count));
  }
  return [...statusMap.entries()].map(([status, count]) => ({ status, count }));
}

function snapshotSourceSummaries(rows: AdminDashboardSnapshotSourceSummary[] | null | undefined): AdminSourceSummary[] {
  return (rows ?? [])
    .filter((row) => Boolean(row.sourceKey))
    .map((row) => ({
      sourceKey: row.sourceKey ?? "",
      name: row.name ?? row.sourceKey ?? "",
      jurisdiction: row.jurisdiction ?? "Unknown",
      baseUrl: row.baseUrl ?? "",
      language: row.language ?? "-",
      isActive: row.isActive ?? true,
      totalCount: numberValue(row.totalCount),
      publicCount: numberValue(row.publicCount),
      pendingSummaryCount: numberValue(row.pendingSummaryCount),
      failedCount: numberValue(row.failedCount),
      attentionCount: numberValue(row.attentionCount),
      latestPublishedAt: optionalText(row.latestPublishedAt),
      latestFetchedAt: optionalText(row.latestFetchedAt),
      latestRunStatus: optionalText(row.latestRunStatus),
      latestRunStartedAt: optionalText(row.latestRunStartedAt),
    }))
    .sort((a, b) => a.sourceKey.localeCompare(b.sourceKey));
}

function snapshotCandidateSummaries(rows: AdminDashboardSnapshotCandidateSummary[] | null | undefined): AdminCandidateSummary[] {
  return (rows ?? [])
    .filter((row) => Boolean(row.sourceKey))
    .map((row) => ({
      sourceKey: row.sourceKey ?? "",
      pendingCount: numberValue(row.pendingCount),
      retryingCount: numberValue(row.retryingCount),
      fetchedCount: numberValue(row.fetchedCount),
      failedCount: numberValue(row.failedCount),
      ignoredCount: numberValue(row.ignoredCount),
      latestCreatedAt: optionalText(row.latestCreatedAt),
      latestAttemptAt: optionalText(row.latestAttemptAt),
    }))
    .sort((a, b) => a.sourceKey.localeCompare(b.sourceKey));
}

function snapshotAttentionArticles(rows: AdminDashboardSnapshotAttentionArticle[] | null | undefined): AdminAttentionArticle[] {
  return (rows ?? [])
    .filter((row) => Boolean(row.slug || row.id || row.sourceKey))
    .slice(0, 8)
    .map((row) => ({
      id: row.id ?? undefined,
      slug: row.slug ?? row.id ?? row.sourceKey ?? "",
      sourceKey: row.sourceKey ?? "",
      jurisdiction: row.jurisdiction ?? "Unknown",
      institutionName: row.institutionName ?? row.sourceKey ?? "",
      originalUrl: row.originalUrl ?? "",
      title: row.title ?? "제목 미상",
      originalPublishedAt: optionalText(row.originalPublishedAt),
      status: row.status ?? "needs_review",
      errorMessage: optionalText(row.errorMessage),
      errorClass: optionalText(row.errorClass),
      reviewState: optionalText(row.reviewState),
    }));
}

async function loadAdminDashboardSnapshot(): Promise<AdminDashboardData | null> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return null;

  const [{ data, error }, latestRuns] = await Promise.all([
    supabase.rpc("rpc_admin_dashboard_snapshot"),
    listIngestionRuns(12),
  ]);
  if (error) return null;

  try {
    const snapshot = parseAdminDashboardSnapshot(data);
    if (!snapshot) return null;
    const sourceSummaries = snapshotSourceSummaries(snapshot.sourceSummaries);
    const candidateSummaries = snapshotCandidateSummaries(snapshot.candidateSummaries);
    const attentionArticles = snapshotAttentionArticles(snapshot.attentionArticles);
    const totals = snapshot.totals ?? {};

    return {
      generatedAt: new Date().toISOString(),
      hasDatabase: true,
      totals: {
        sources: numberValue(totals.sources) || sourceSummaries.length || mockSources.length,
        articles: numberValue(totals.articles),
        publicArticles: numberValue(totals.publicArticles),
        pendingSummaries: numberValue(totals.pendingSummaries),
        failedArticles: numberValue(totals.failedArticles),
        attentionArticles: numberValue(totals.attentionArticles),
        tags: numberValue(totals.tags),
        candidates: numberValue(totals.candidates),
      },
      statusCounts: snapshotStatusCounts(snapshot.statusCounts),
      sourceSummaries,
      candidateSummaries,
      latestRuns,
      attentionArticles,
    };
  } catch {
    return null;
  }
}

async function loadAdminDashboardLegacyData(): Promise<AdminDashboardData> {
  const supabase = getSupabaseAdmin();
  const [sources, rows, candidateRows, latestRuns, tagCount, candidateCount] = await Promise.all([
    listSources(),
    loadArticleRows(),
    loadCandidateRows(),
    listIngestionRuns(12),
    countTableRows("tags", mockTags.length),
    countTableRows("source_url_candidates", 0),
  ]);

  const statusMap = new Map<string, number>();
  ARTICLE_STATUSES.forEach((status) => statusMap.set(status, 0));

  for (const row of rows) {
    statusMap.set(row.status, (statusMap.get(row.status) ?? 0) + 1);
  }

  const publicArticles = rows.filter(isPublicArticle).length;
  const pendingSummaries = rows.filter(isPendingSummary).length;
  const failedArticles = rows.filter((row) => FAILURE_STATUSES.has(row.status)).length;
  const attentionArticles = rows.filter(isAttentionRow).length;

  return {
    generatedAt: new Date().toISOString(),
    hasDatabase: Boolean(supabase),
    totals: {
      sources: sources.length || mockSources.length,
      articles: rows.length,
      publicArticles,
      pendingSummaries,
      failedArticles,
      attentionArticles,
      tags: tagCount,
      candidates: candidateCount || candidateRows.length,
    },
    statusCounts: [...statusMap.entries()].map(([status, count]) => ({ status, count })),
    sourceSummaries: buildSourceSummaries(sources, rows, latestRuns),
    candidateSummaries: buildCandidateSummaries(sources, candidateRows),
    latestRuns,
    attentionArticles: buildAttentionArticles(rows),
  };
}

export async function getAdminDashboardData(): Promise<AdminDashboardData> {
  return (await loadAdminDashboardSnapshot()) ?? loadAdminDashboardLegacyData();
}

export async function listAdminArticles(filters: AdminArticleListFilters = {}): Promise<AdminArticleListResult> {
  const page = boundedAdminArticlePage(filters.page);
  const pageSize = boundedAdminArticlePageSize(filters.pageSize);
  const supabase = getSupabaseAdmin();

  if (!supabase) {
    const rows = filterAdminMockArticles(filters);
    const start = (page - 1) * pageSize;
    const items = rows.slice(start, start + pageSize).map(adminArticleRowToListItem);
    return {
      items,
      pageInfo: {
        page,
        pageSize,
        total: rows.length,
        hasMore: start + pageSize < rows.length,
        totalIsExact: true,
      },
    };
  }

  let query = supabase
    .from("articles")
    .select(
      "id, slug, source_key, jurisdiction, institution_name, original_url, original_title, korean_title, original_published_at, fetched_at, summarized_at, status, source_metadata, summary_json, updated_at",
      { count: "exact" },
    )
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

  const rows = (data ?? []) as AdminArticleListRow[];
  const total = count ?? from + rows.length;

  return {
    items: rows.map(adminArticleRowToListItem),
    pageInfo: {
      page,
      pageSize,
      total,
      hasMore: from + rows.length < total,
      totalIsExact: true,
    },
  };
}

async function loadBulkAdminArticleRows(refs: AdminArticleBulkRef[]) {
  const supabase = getSupabaseAdmin();
  if (!supabase) return { supabase: null, rows: [] as AdminArticleRow[] };

  const ids = Array.from(new Set(refs.map((ref) => ref.id?.trim()).filter(Boolean) as string[]));
  const slugs = Array.from(new Set(refs.map((ref) => ref.slug?.trim()).filter(Boolean) as string[]));
  const rowByKey = new Map<string, AdminArticleRow>();

  if (ids.length > 0) {
    const { data, error } = await supabase
      .from("articles")
      .select("id, slug, source_key, status, source_metadata")
      .in("id", ids);
    if (error) throw new Error(error.message);
    for (const row of (data ?? []) as AdminArticleRow[]) {
      if (row.id) rowByKey.set(`id:${row.id}`, row);
      if (row.slug) rowByKey.set(`slug:${row.slug}`, row);
    }
  }

  if (slugs.length > 0) {
    const missingSlugs = slugs.filter((slug) => !rowByKey.has(`slug:${slug}`));
    if (missingSlugs.length > 0) {
      const { data, error } = await supabase
        .from("articles")
        .select("id, slug, source_key, status, source_metadata")
        .in("slug", missingSlugs);
      if (error) throw new Error(error.message);
      for (const row of (data ?? []) as AdminArticleRow[]) {
        if (row.id) rowByKey.set(`id:${row.id}`, row);
        if (row.slug) rowByKey.set(`slug:${row.slug}`, row);
      }
    }
  }

  const uniqueRows = new Map<string, AdminArticleRow>();
  for (const row of rowByKey.values()) {
    uniqueRows.set(row.id ?? row.slug ?? `${row.source_key}:${uniqueRows.size}`, row);
  }

  return { supabase, rows: [...uniqueRows.values()] };
}

function unresolvedBulkRefs(refs: AdminArticleBulkRef[], rows: AdminArticleRow[]) {
  const foundIds = new Set(rows.map((row) => row.id).filter(Boolean));
  const foundSlugs = new Set(rows.map((row) => row.slug).filter(Boolean));
  return refs.filter((ref) => {
    if (ref.id && foundIds.has(ref.id)) return false;
    if (ref.slug && foundSlugs.has(ref.slug)) return false;
    return true;
  });
}

export async function runAdminArticleBulkAction(input: {
  action: AdminArticleBulkAction;
  refs: AdminArticleBulkRef[];
  note?: string;
}): Promise<AdminArticleBulkResult> {
  const { action, refs, note } = input;
  const { supabase, rows } = await loadBulkAdminArticleRows(refs);
  if (!supabase) {
    return {
      mode: "no-database",
      action,
      requestedCount: refs.length,
      matchedCount: 0,
      updatedCount: 0,
      notFound: refs,
    };
  }

  let updatedCount = 0;
  for (const row of rows) {
    if (!row.id) continue;
    const { error } = await supabase
      .from("articles")
      .update({
        status: "needs_review" satisfies ArticleStatus,
        source_metadata: reviewMetadataForBulk(row, action, note),
        error_metadata: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id);
    if (error) throw new Error(error.message);
    updatedCount += 1;
  }

  return {
    mode: "database",
    action,
    requestedCount: refs.length,
    matchedCount: rows.length,
    updatedCount,
    notFound: unresolvedBulkRefs(refs, rows),
  };
}
