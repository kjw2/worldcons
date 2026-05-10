import { getSupabaseAdmin } from "@/lib/db/client";
import { mockArticles, mockSources, mockTags } from "@/lib/db/mock-data";
import { listIngestionRuns, listSources } from "@/lib/db/queries";
import type { IngestionRunRecord, SourceRecord } from "@/lib/db/types";

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
  updated_at?: string | null;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectionFor(row: AdminArticleRow) {
  const collection = row.source_metadata?.collection;
  return isRecord(collection) ? collection : {};
}

function isPublicArticle(row: AdminArticleRow) {
  return row.status === "summarized" && collectionFor(row).publishable === true;
}

function isPendingSummary(row: AdminArticleRow) {
  return row.status === "cleaned" || row.status === "failed_summary";
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
    if (ATTENTION_STATUSES.has(row.status)) summary.attentionCount += 1;
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
    .filter((row) => ATTENTION_STATUSES.has(row.status))
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
      errorMessage: errorMessage(row),
    }));
}

export async function getAdminDashboardData(): Promise<AdminDashboardData> {
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
  const attentionArticles = rows.filter((row) => ATTENTION_STATUSES.has(row.status)).length;

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
