import readingTime from "reading-time";
import { getSupabaseAdmin } from "@/lib/db/client";
import {
  mockArticles,
  mockGlossaryTerms,
  mockIngestionRuns,
  mockSources,
  mockTags,
} from "@/lib/db/mock-data";
import type {
  ArticleContentType,
  ArticleDetail,
  ArticleListFilters,
  ArticleListItem,
  ArticleListResult,
  GlossaryTerm,
  IngestionRunRecord,
  SourceRecord,
  SummaryJson,
  TagSummary,
  TagType,
} from "@/lib/db/types";
import { isWithinRange, normalizeRange } from "@/lib/utils/dates";
import { isPublishableListItem } from "@/lib/ingest/publishability";

interface SupabaseTagRow {
  id?: string;
  slug: string;
  name: string;
  normalized_name: string;
  type: string;
  description?: string | null;
  article_count?: number | null;
  latest_article_at?: string | null;
}

interface SupabaseArticleTagRow {
  confidence?: number | null;
  tags?: SupabaseTagRow | SupabaseTagRow[] | null;
}

interface SupabaseArticleRow {
  id?: string;
  slug: string;
  source_key: string;
  jurisdiction: string;
  institution_name: string;
  content_type: string;
  original_url: string;
  canonical_url: string;
  original_language: string;
  original_title?: string | null;
  korean_title?: string | null;
  original_published_at?: string | null;
  discovered_at?: string | null;
  fetched_at?: string | null;
  summarized_at?: string | null;
  status: string;
  raw_text?: string | null;
  cleaned_text?: string | null;
  summary_json?: SummaryJson | null;
  content_hash?: string | null;
  source_metadata?: Record<string, unknown> | null;
  error_metadata?: Record<string, unknown> | null;
  article_tags?: SupabaseArticleTagRow[] | null;
}

const DEFAULT_PAGE_SIZE = 20;

export function normalizePagination(page?: number, pageSize?: number) {
  const safePage = Number.isFinite(page) && page && page > 0 ? Math.floor(page) : 1;
  const safePageSize = Number.isFinite(pageSize) && pageSize && pageSize > 0 ? Math.min(Math.floor(pageSize), 100) : DEFAULT_PAGE_SIZE;
  return { page: safePage, pageSize: safePageSize };
}

function tagRowToSummary(row: SupabaseTagRow, confidence?: number | null): TagSummary {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    normalizedName: row.normalized_name,
    type: row.type as TagType,
    description: row.description,
    articleCount: row.article_count ?? undefined,
    latestArticleAt: row.latest_article_at,
    confidence,
  };
}

function articleRowToItem(row: SupabaseArticleRow): ArticleDetail {
  const tags =
    row.article_tags
      ?.flatMap((articleTag) => {
        const tagRows = Array.isArray(articleTag.tags) ? articleTag.tags : articleTag.tags ? [articleTag.tags] : [];
        return tagRows.map((tag) => tagRowToSummary(tag, articleTag.confidence));
      })
      .filter(Boolean) ?? [];
  const summary = row.summary_json ?? null;
  const textForReading = row.cleaned_text || row.raw_text || "";

  return {
    id: row.id,
    slug: row.slug,
    sourceKey: row.source_key,
    jurisdiction: row.jurisdiction,
    institutionName: row.institution_name,
    contentType: row.content_type as ArticleContentType,
    originalUrl: row.original_url,
    canonicalUrl: row.canonical_url,
    originalLanguage: row.original_language,
    originalTitle: row.original_title,
    koreanTitle: row.korean_title || summary?.koreanTitle || row.original_title,
    originalPublishedAt: row.original_published_at,
    discoveredAt: row.discovered_at,
    fetchedAt: row.fetched_at,
    summarizedAt: row.summarized_at,
    status: row.status as ArticleDetail["status"],
    summaryJson: summary,
    tags,
    oneLineSummary: summary?.summary.coreSummary[0] || "요약이 아직 생성되지 않았습니다.",
    rawText: row.raw_text,
    cleanedText: row.cleaned_text,
    contentHash: row.content_hash,
    sourceMetadata: row.source_metadata,
    errorMetadata: row.error_metadata,
    readingMinutes: textForReading ? Math.max(1, Math.ceil(readingTime(textForReading).minutes)) : undefined,
  };
}

function matchesText(article: ArticleDetail, q?: string) {
  if (!q) {
    return true;
  }

  const needles = q
    .toLowerCase()
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (needles.length === 0) return true;

  const haystack = [
    article.koreanTitle,
    article.originalTitle,
    article.oneLineSummary,
    article.cleanedText,
    article.summaryJson ? JSON.stringify(article.summaryJson) : null,
    article.originalUrl,
    article.jurisdiction,
    article.institutionName,
    ...article.tags.flatMap((tag) => [tag.name, tag.normalizedName, tag.type]),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return needles.every((needle) => haystack.includes(needle));
}

function filterMockArticles(filters: ArticleListFilters) {
  const range = normalizeRange(filters.range);

  return mockArticles
    .filter((article) => matchesText(article, filters.q))
    .filter((article) => filters.includeUnpublished || article.status === "summarized")
    .filter((article) => !filters.source || article.sourceKey === filters.source)
    .filter((article) => !filters.jurisdiction || article.jurisdiction === filters.jurisdiction)
    .filter((article) => !filters.type || article.contentType === filters.type)
    .filter((article) => !filters.language || article.originalLanguage === filters.language)
    .filter((article) => !filters.tag || article.tags.some((tag) => tag.slug === filters.tag || tag.name === filters.tag))
    .filter((article) => isWithinRange(article.originalPublishedAt, range))
    .sort((a, b) => (b.originalPublishedAt || "").localeCompare(a.originalPublishedAt || ""));
}

export async function listArticles(filters: ArticleListFilters = {}): Promise<ArticleListResult> {
  const { page, pageSize } = normalizePagination(filters.page, filters.pageSize);
  const supabase = getSupabaseAdmin();

  if (filters.ids && filters.ids.length === 0) {
    return { items: [], pageInfo: { page, pageSize, total: 0 } };
  }

  if (!supabase) {
    const items = filterMockArticles(filters);
    const start = (page - 1) * pageSize;
    return {
      items: items.slice(start, start + pageSize),
      pageInfo: { page, pageSize, total: items.length },
    };
  }

  let tagArticleIds: string[] | null = null;
  if (filters.tag) {
    const { data } = await supabase
      .from("article_tags")
      .select("article_id, tags!inner(slug,name)")
      .or(`slug.eq.${filters.tag},name.eq.${filters.tag}`, { foreignTable: "tags" });
    tagArticleIds = data?.map((row) => String(row.article_id)) ?? [];
    if (tagArticleIds.length === 0) {
      return { items: [], pageInfo: { page, pageSize, total: 0 } };
    }
  }

  let query = supabase
    .from("articles")
    .select("*, article_tags(confidence, tags(*))", { count: "exact" })
    .order("original_published_at", { ascending: false, nullsFirst: false })
    .order("id", { ascending: true });

  if (!filters.includeUnpublished) {
    query = query.eq("status", "summarized").filter("source_metadata->collection->>publishable", "eq", "true");
  }
  if (filters.ids) query = query.in("id", filters.ids);
  if (filters.source) query = query.eq("source_key", filters.source);
  if (filters.jurisdiction) query = query.eq("jurisdiction", filters.jurisdiction);
  if (filters.type) query = query.eq("content_type", filters.type);
  if (filters.language) query = query.eq("original_language", filters.language);
  if (tagArticleIds) query = query.in("id", tagArticleIds);

  const range = normalizeRange(filters.range);
  const startDate = range === "latest" ? null : new Date(Date.now() - (range === "today" ? 0 : range === "week" ? 7 : 30) * 24 * 60 * 60 * 1000);
  if (range === "today") {
    const now = new Date();
    startDate?.setUTCHours(0, 0, 0, 0);
    query = query.gte("original_published_at", new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString());
  } else if (startDate) {
    query = query.gte("original_published_at", startDate.toISOString());
  }

  const maxSearchCandidates = Number(process.env.SEARCH_MAX_CANDIDATES ?? 1000);
  const from = filters.q ? 0 : (page - 1) * pageSize;
  const to = filters.q ? Math.max(0, maxSearchCandidates - 1) : from + pageSize - 1;
  const { data, error, count } = await query.range(from, to);
  if (error) {
    throw new Error(error.message);
  }

  if (filters.q) {
    const matched = ((data ?? []) as SupabaseArticleRow[])
      .filter((row) => filters.includeUnpublished || isPublishableListItem(row))
      .map(articleRowToItem)
      .filter((article) => matchesText(article, filters.q));
    const pageStart = (page - 1) * pageSize;
    return {
      items: matched.slice(pageStart, pageStart + pageSize),
      pageInfo: { page, pageSize, total: matched.length },
    };
  }

  return {
    items: ((data ?? []) as SupabaseArticleRow[]).map(articleRowToItem),
    pageInfo: { page, pageSize, total: count ?? 0 },
  };
}

export async function getArticleBySlug(slug: string): Promise<ArticleDetail | null> {
  const supabase = getSupabaseAdmin();

  if (!supabase) {
    return mockArticles.find((article) => article.slug === slug) ?? null;
  }

  const { data, error } = await supabase
    .from("articles")
    .select("*, article_tags(confidence, tags(*))")
    .eq("slug", slug)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return data ? articleRowToItem(data as SupabaseArticleRow) : null;
}

export async function getRelatedArticles(article: ArticleListItem, limit = 3) {
  const tag = article.tags[0]?.slug;
  const result = await listArticles({ tag, pageSize: limit + 1 });
  return result.items.filter((item) => item.slug !== article.slug).slice(0, limit);
}

export async function listTags(options: { type?: string; sort?: "count" | "latest" | "name" } = {}) {
  const supabase = getSupabaseAdmin();

  if (!supabase) {
    return [...mockTags]
      .filter((tag) => !options.type || tag.type === options.type)
      .sort((a, b) => {
        if (options.sort === "name") return a.name.localeCompare(b.name);
        if (options.sort === "latest") return (b.latestArticleAt || "").localeCompare(a.latestArticleAt || "");
        return (b.articleCount ?? 0) - (a.articleCount ?? 0);
      });
  }

  let query = supabase.from("tags").select("*");
  if (options.type) query = query.eq("type", options.type);
  if (options.sort === "name") query = query.order("name");
  else if (options.sort === "latest") query = query.order("latest_article_at", { ascending: false, nullsFirst: false });
  else query = query.order("article_count", { ascending: false });

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return ((data ?? []) as SupabaseTagRow[]).map((tag) => tagRowToSummary(tag));
}

export async function getTagBySlug(slug: string) {
  const supabase = getSupabaseAdmin();

  if (!supabase) {
    const tag = mockTags.find((item) => item.slug === slug) ?? null;
    const articles = tag ? mockArticles.filter((article) => article.tags.some((articleTag) => articleTag.slug === slug)) : [];
    return tag ? { tag, articles } : null;
  }

  const { data: tagData, error: tagError } = await supabase.from("tags").select("*").eq("slug", slug).maybeSingle();
  if (tagError) throw new Error(tagError.message);
  if (!tagData) return null;

  const articles = await listArticles({ tag: slug, pageSize: 50 });
  return { tag: tagRowToSummary(tagData as SupabaseTagRow), articles: articles.items };
}

export async function listSources(): Promise<SourceRecord[]> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return mockSources;

  const { data, error } = await supabase.from("sources").select("*").order("jurisdiction");
  if (error) throw new Error(error.message);

  return (data ?? []).map((row) => ({
    id: row.id,
    sourceKey: row.source_key,
    name: row.name,
    jurisdiction: row.jurisdiction,
    baseUrl: row.base_url,
    language: row.language,
    isActive: row.is_active,
  }));
}

export async function getSourceByKey(sourceKey: string) {
  const sources = await listSources();
  return sources.find((source) => source.sourceKey === sourceKey) ?? null;
}

export async function listIngestionRuns(limit = 20): Promise<IngestionRunRecord[]> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return mockIngestionRuns.slice(0, limit);

  const { data, error } = await supabase
    .from("ingestion_runs")
    .select("*")
    .order("started_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);

  return (data ?? []).map((row) => ({
    id: row.id,
    sourceKey: row.source_key,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    status: row.status,
    discoveredCount: row.discovered_count,
    fetchedCount: row.fetched_count,
    summarizedCount: row.summarized_count,
    failedCount: row.failed_count,
    errorMessage: row.error_message,
    metadata: row.metadata,
  }));
}

export async function listGlossaryTerms(): Promise<GlossaryTerm[]> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return mockGlossaryTerms;

  const { data, error } = await supabase.from("glossary_terms").select("*").order("term");
  if (error) throw new Error(error.message);

  return (data ?? []).map((row) => ({
    slug: row.slug,
    term: row.term,
    koreanTerm: row.korean_term,
    definition: row.definition,
    jurisdiction: row.jurisdiction,
    relatedTags: row.related_tags ?? [],
  }));
}

export async function getGlossaryTerm(slug: string) {
  const terms = await listGlossaryTerms();
  return terms.find((term) => term.slug === slug) ?? null;
}
