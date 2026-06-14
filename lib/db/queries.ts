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
import { expandRelatedTagNames } from "@/lib/glossary/tag-aliases";

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

function sortGlossaryTerms(terms: GlossaryTerm[]) {
  return [...terms].sort((left, right) => {
    const leftLabel = left.koreanTerm || left.term;
    const rightLabel = right.koreanTerm || right.term;
    return leftLabel.localeCompare(rightLabel, "ko");
  });
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

function toFullTextQuery(q?: string) {
  const terms =
    q
      ?.toLowerCase()
      .split(/\s+/)
      .map((term) => term.replace(/[^\p{L}\p{N}]+/gu, ""))
      .filter(Boolean) ?? [];

  return terms.map((term) => `${term}:*`).join(" & ");
}

function getRangeStartIso(rangeValue?: ArticleListFilters["range"]) {
  const range = normalizeRange(rangeValue);
  if (range === "today") {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  }
  if (range === "week" || range === "month") {
    const days = range === "week" ? 7 : 30;
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  }

  return null;
}

async function articleIdsForTagFilter(tag: string) {
  const supabase = getSupabaseAdmin();
  if (!supabase) return null;

  const [slugResult, nameResult] = await Promise.all([
    supabase.from("tags").select("id").eq("slug", tag),
    supabase.from("tags").select("id").eq("name", tag),
  ]);
  if (slugResult.error) throw new Error(slugResult.error.message);
  if (nameResult.error) throw new Error(nameResult.error.message);

  const tagIds = Array.from(
    new Set(
      [...(slugResult.data ?? []), ...(nameResult.data ?? [])]
        .map((row) => (typeof row.id === "string" ? row.id : null))
        .filter((id): id is string => Boolean(id)),
    ),
  );
  if (tagIds.length === 0) return [];

  const { data, error } = await supabase.from("article_tags").select("article_id").in("tag_id", tagIds);
  if (error) throw new Error(error.message);
  return data?.map((row) => String(row.article_id)) ?? [];
}

async function listArticlesByFullText(filters: ArticleListFilters, tagArticleIds: string[] | null): Promise<ArticleListResult> {
  const { page, pageSize } = normalizePagination(filters.page, filters.pageSize);
  const supabase = getSupabaseAdmin();
  const tsQuery = toFullTextQuery(filters.q);

  if (!supabase || !tsQuery) {
    const items = filterMockArticles(filters);
    const start = (page - 1) * pageSize;
    return {
      items: items.slice(start, start + pageSize),
      pageInfo: { page, pageSize, total: items.length },
    };
  }

  let query = supabase
    .from("articles")
    .select("id")
    .textSearch("search_vector", tsQuery, { config: "simple" })
    .order("original_published_at", { ascending: false, nullsFirst: false })
    .order("id", { ascending: true })
    .limit(Number.isFinite(Number(process.env.SEARCH_MAX_CANDIDATES)) ? Math.min(Number(process.env.SEARCH_MAX_CANDIDATES), 100) : 100);

  if (!filters.includeUnpublished) {
    query = query.eq("status", "summarized").filter("source_metadata->collection->>publishable", "eq", "true");
  }
  if (filters.ids) query = query.in("id", filters.ids);
  if (filters.source) query = query.eq("source_key", filters.source);
  if (filters.jurisdiction) query = query.eq("jurisdiction", filters.jurisdiction);
  if (filters.type) query = query.eq("content_type", filters.type);
  if (filters.language) query = query.eq("original_language", filters.language);
  if (tagArticleIds) query = query.in("id", tagArticleIds);

  const startIso = getRangeStartIso(filters.range);
  if (startIso) query = query.gte("original_published_at", startIso);

  const { data, error } = await query;
  if (error) {
    return { items: [], pageInfo: { page, pageSize, total: 0 } };
  }

  const ids = ((data ?? []) as Array<{ id?: string }>).map((row) => row.id).filter((id): id is string => Boolean(id));
  if (ids.length === 0) {
    return { items: [], pageInfo: { page, pageSize, total: 0 } };
  }

  const result = await listArticles({ ...filters, q: undefined, ids, page: 1, pageSize: ids.length });
  const order = new Map(ids.map((id, index) => [id, index]));
  const matched = [...result.items]
    .sort((left, right) => (order.get(left.id ?? "") ?? 9999) - (order.get(right.id ?? "") ?? 9999))
    .filter((article) => matchesText(article, filters.q));
  const start = (page - 1) * pageSize;

  return {
    items: matched.slice(start, start + pageSize),
    pageInfo: { page, pageSize, total: matched.length },
  };
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
    tagArticleIds = (await articleIdsForTagFilter(filters.tag)) ?? [];
    if (tagArticleIds.length === 0) {
      return { items: [], pageInfo: { page, pageSize, total: 0 } };
    }
  }

  if (filters.q) {
    return listArticlesByFullText(filters, tagArticleIds);
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

  const startIso = getRangeStartIso(filters.range);
  if (startIso) query = query.gte("original_published_at", startIso);

  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;
  const { data, error, count } = await query.range(from, to);
  if (error) {
    throw new Error(error.message);
  }

  return {
    items: ((data ?? []) as SupabaseArticleRow[]).map(articleRowToItem),
    pageInfo: { page, pageSize, total: count ?? 0 },
  };
}

export async function getArticleBySlug(slug: string, options: { includeUnpublished?: boolean } = {}): Promise<ArticleDetail | null> {
  const supabase = getSupabaseAdmin();

  if (!supabase) {
    const article = mockArticles.find((item) => item.slug === slug) ?? null;
    return options.includeUnpublished || article?.status === "summarized" ? article : null;
  }

  let query = supabase
    .from("articles")
    .select("*, article_tags(confidence, tags(*))")
    .eq("slug", slug);

  if (!options.includeUnpublished) {
    query = query.eq("status", "summarized").filter("source_metadata->collection->>publishable", "eq", "true");
  }

  const { data, error } = await query.maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  if (!data || (!options.includeUnpublished && !isPublishableListItem(data as SupabaseArticleRow))) {
    return null;
  }

  return articleRowToItem(data as SupabaseArticleRow);
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
  if (!supabase) return sortGlossaryTerms(mockGlossaryTerms);

  const { data, error } = await supabase.from("glossary_terms").select("*").order("term");
  if (error) throw new Error(error.message);

  return sortGlossaryTerms((data ?? []).map((row) => ({
    slug: row.slug,
    term: row.term,
    koreanTerm: row.korean_term,
    definition: row.definition,
    jurisdiction: row.jurisdiction,
    relatedTags: row.related_tags ?? [],
  })));
}

export async function getGlossaryTerm(slug: string) {
  const terms = await listGlossaryTerms();
  return terms.find((term) => term.slug === slug) ?? null;
}

export async function listArticlesForGlossaryTerm(term: GlossaryTerm, limit = 8): Promise<ArticleListItem[]> {
  const articles = new Map<string, ArticleListItem>();
  for (const tag of expandRelatedTagNames(term.relatedTags)) {
    if (articles.size >= limit) break;
    const result = await listArticles({ tag, pageSize: limit });
    for (const article of result.items) {
      articles.set(article.slug, article);
      if (articles.size >= limit) break;
    }
  }

  return [...articles.values()]
    .sort((left, right) => (right.originalPublishedAt || "").localeCompare(left.originalPublishedAt || ""))
    .slice(0, limit);
}
