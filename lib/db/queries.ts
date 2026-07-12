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
import { articlePublicationV4ReadsEnabled } from "@/lib/article-publication";

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
  one_line_summary?: string | null;
  content_hash?: string | null;
  source_metadata?: Record<string, unknown> | null;
  resolution_type?: string | null;
  error_metadata?: Record<string, unknown> | null;
  article_tags?: SupabaseArticleTagRow[] | null;
}

interface SupabaseJurisdictionCountRow {
  jurisdiction?: string | null;
  article_count?: number | string | null;
}

const DEFAULT_PAGE_SIZE = 20;
const TAG_LIST_SELECT = "id,slug,name,normalized_name,type,description,article_count,latest_article_at";
const ARTICLE_LIST_SELECT = [
  "id",
  "slug",
  "source_key",
  "jurisdiction",
  "institution_name",
  "content_type",
  "original_url",
  "canonical_url",
  "original_language",
  "original_title",
  "korean_title",
  "original_published_at",
  "discovered_at",
  "fetched_at",
  "summarized_at",
  "status",
  "one_line_summary:summary_json->summary->coreSummary->>0",
  "resolution_type:source_metadata->>resolutionType",
  `article_tags(confidence,tags(${TAG_LIST_SELECT}))`,
].join(",");
const ARTICLE_PAGE_SELECT = `${ARTICLE_LIST_SELECT},source_metadata,summary_json,content_hash,error_metadata`;
const ARTICLE_DETAIL_SELECT = `${ARTICLE_PAGE_SELECT},raw_text,cleaned_text`;
const ARTICLE_P3_LIST_SELECT = [
  "id",
  "slug",
  "source_key",
  "jurisdiction",
  "institution_name",
  "content_type",
  "original_url",
  "canonical_url",
  "original_language",
  "original_title",
  "korean_title",
  "original_published_at",
  "discovered_at",
  "fetched_at",
  "summarized_at",
  "status",
  "one_line_summary:summary_json->summary->coreSummary->>0",
  "resolution_type:source_metadata->>resolutionType",
  "article_tags",
].join(",");
const ARTICLE_P3_PAGE_SELECT = `${ARTICLE_P3_LIST_SELECT},source_metadata,summary_json,content_hash,error_metadata`;
const ARTICLE_P3_DETAIL_SELECT = `${ARTICLE_P3_PAGE_SELECT},raw_text,cleaned_text`;

function publicationProjectionEnabled(includeUnpublished?: boolean) {
  return !includeUnpublished && articlePublicationV4ReadsEnabled(process.env, "public_query");
}

function articleRelation(includeUnpublished?: boolean) {
  return publicationProjectionEnabled(includeUnpublished) ? "public_article_projection_p3" : "articles";
}

function projectionSelect(select: string, includeUnpublished?: boolean) {
  if (!publicationProjectionEnabled(includeUnpublished)) return select;
  if (select === ARTICLE_DETAIL_SELECT) return ARTICLE_P3_DETAIL_SELECT;
  if (select === ARTICLE_PAGE_SELECT) return ARTICLE_P3_PAGE_SELECT;
  return ARTICLE_P3_LIST_SELECT;
}

function minimalSourceMetadata(row: SupabaseArticleRow) {
  const metadata: Record<string, unknown> = {};
  if (row.resolution_type) metadata.resolutionType = row.resolution_type;
  return Object.keys(metadata).length > 0 ? metadata : null;
}

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

function articleRowToItem(
  row: SupabaseArticleRow,
  options: { includeSummaryJson?: boolean; includeDetailFields?: boolean } = {},
): ArticleDetail {
  const includeSummaryJson = options.includeSummaryJson ?? true;
  const includeDetailFields = options.includeDetailFields ?? true;
  const tags =
    row.article_tags
      ?.flatMap((articleTag) => {
        const tagRows = Array.isArray(articleTag.tags) ? articleTag.tags : articleTag.tags ? [articleTag.tags] : [];
        return tagRows.map((tag) => tagRowToSummary(tag, articleTag.confidence));
      })
      .filter(Boolean) ?? [];
  const summary = row.summary_json ?? null;

  const item: ArticleDetail = {
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
    summaryJson: includeSummaryJson ? summary : null,
    tags,
    sourceMetadata: row.source_metadata ?? minimalSourceMetadata(row),
    oneLineSummary: row.one_line_summary || summary?.summary.coreSummary[0] || "요약이 아직 생성되지 않았습니다.",
    viewCount: 0,
  };

  if (includeDetailFields) {
    item.rawText = row.raw_text;
    item.cleanedText = row.cleaned_text;
    item.contentHash = row.content_hash;
    item.errorMetadata = row.error_metadata;
  }

  return item;
}

async function articleViewCountsBySlug(slugs: string[]) {
  const uniqueSlugs = Array.from(new Set(slugs.map((slug) => slug.trim()).filter(Boolean)));
  const supabase = getSupabaseAdmin();
  if (!supabase || uniqueSlugs.length === 0) return {};

  const { data: aggregateRows, error: aggregateError } = await supabase
    .from("article_view_counts")
    .select("article_slug,view_count")
    .in("article_slug", uniqueSlugs);

  if (!aggregateError) {
    return Object.fromEntries(
      ((aggregateRows ?? []) as Array<{ article_slug?: string | null; view_count?: number | string | null }>)
        .filter((row) => row.article_slug)
        .map((row) => [String(row.article_slug), Number(row.view_count ?? 0)]),
    );
  }

  const entries = await Promise.all(
    uniqueSlugs.map(async (slug) => {
      const { count, error } = await supabase
        .from("site_events")
        .select("id", { count: "exact", head: true })
        .eq("event_type", "article_view")
        .eq("article_slug", slug);

      return [slug, error ? 0 : count ?? 0] as const;
    }),
  );

  return Object.fromEntries(entries);
}

async function attachArticleViewCounts<T extends ArticleListItem>(items: T[]) {
  if (items.length === 0) return items;
  const counts = await articleViewCountsBySlug(items.map((item) => item.slug));
  return items.map((item) => ({
    ...item,
    viewCount: counts[item.slug] ?? 0,
  }));
}

async function attachArticleViewCountsIfNeeded<T extends ArticleListItem>(items: T[], filters: ArticleListFilters) {
  return filters.includeViewCounts === false ? items : attachArticleViewCounts(items);
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
      items: await attachArticleViewCountsIfNeeded(items.slice(start, start + pageSize), filters),
      pageInfo: { page, pageSize, total: items.length, hasMore: start + pageSize < items.length, totalIsExact: true },
    };
  }

  let query = supabase
    .from(articleRelation(filters.includeUnpublished))
    .select("id")
    .textSearch("search_vector", tsQuery, { config: "simple" })
    .order("original_published_at", { ascending: false, nullsFirst: false })
    .order("id", { ascending: true })
    .limit(Number.isFinite(Number(process.env.SEARCH_MAX_CANDIDATES)) ? Math.min(Number(process.env.SEARCH_MAX_CANDIDATES), 100) : 100);

  if (!filters.includeUnpublished && !publicationProjectionEnabled()) {
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
    .sort((left, right) => (order.get(left.id ?? "") ?? 9999) - (order.get(right.id ?? "") ?? 9999));
  const start = (page - 1) * pageSize;

  return {
    items: matched.slice(start, start + pageSize),
    pageInfo: { page, pageSize, total: matched.length, hasMore: start + pageSize < matched.length, totalIsExact: true },
  };
}

export async function listArticles(filters: ArticleListFilters = {}): Promise<ArticleListResult> {
  const { page, pageSize } = normalizePagination(filters.page, filters.pageSize);
  const supabase = getSupabaseAdmin();

  if (filters.ids && filters.ids.length === 0) {
    return { items: [], pageInfo: { page, pageSize, total: 0, hasMore: false, totalIsExact: true } };
  }

  if (!supabase) {
    const items = filterMockArticles(filters);
    const start = (page - 1) * pageSize;
    return {
      items: await attachArticleViewCountsIfNeeded(items.slice(start, start + pageSize), filters),
      pageInfo: { page, pageSize, total: items.length, hasMore: start + pageSize < items.length, totalIsExact: true },
    };
  }

  let tagArticleIds: string[] | null = null;
  if (filters.tag) {
    tagArticleIds = (await articleIdsForTagFilter(filters.tag)) ?? [];
    if (tagArticleIds.length === 0) {
      return { items: [], pageInfo: { page, pageSize, total: 0, hasMore: false, totalIsExact: true } };
    }
  }

  if (filters.q) {
    return listArticlesByFullText(filters, tagArticleIds);
  }

  const countMode = filters.count ?? "exact";
  let query = supabase
    .from(articleRelation(filters.includeUnpublished))
    .select(projectionSelect(ARTICLE_LIST_SELECT, filters.includeUnpublished), countMode === "none" ? undefined : { count: countMode })
    .order("original_published_at", { ascending: false, nullsFirst: false })
    .order("id", { ascending: true });

  if (!filters.includeUnpublished && !publicationProjectionEnabled()) {
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
  const to = from + pageSize;
  const { data, error, count } = await query.range(from, to);
  if (error) {
    throw new Error(error.message);
  }
  const rows = (data ?? []) as unknown as SupabaseArticleRow[];
  const hasMore = rows.length > pageSize;
  const items = await attachArticleViewCountsIfNeeded(
    rows.slice(0, pageSize).map((row) => articleRowToItem(row, { includeSummaryJson: false, includeDetailFields: false })),
    filters,
  );
  const minimumTotal = from + items.length + (hasMore ? 1 : 0);
  const total = Math.max(count ?? 0, minimumTotal);

  return {
    items,
    pageInfo: { page, pageSize, total, hasMore, totalIsExact: countMode === "exact" },
  };
}

async function getArticleBySlugWithSelect(slug: string, select: string, options: { includeUnpublished?: boolean } = {}): Promise<ArticleDetail | null> {
  const supabase = getSupabaseAdmin();

  if (!supabase) {
    const article = mockArticles.find((item) => item.slug === slug) ?? null;
    return options.includeUnpublished || article?.status === "summarized" ? article : null;
  }

  let query = supabase
    .from(articleRelation(options.includeUnpublished))
    .select(projectionSelect(select, options.includeUnpublished))
    .eq("slug", slug);

  if (!options.includeUnpublished && !publicationProjectionEnabled()) {
    query = query.eq("status", "summarized").filter("source_metadata->collection->>publishable", "eq", "true");
  }

  const { data, error } = await query.maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  const row = data as unknown as SupabaseArticleRow;
  if (!data || (!options.includeUnpublished && row.source_metadata !== undefined && !isPublishableListItem(row))) {
    return null;
  }

  return articleRowToItem(row, {
    includeSummaryJson: select === ARTICLE_DETAIL_SELECT || select === ARTICLE_PAGE_SELECT,
    includeDetailFields: select === ARTICLE_DETAIL_SELECT,
  });
}

export async function getArticleBySlug(slug: string, options: { includeUnpublished?: boolean; includeSourceText?: boolean } = {}): Promise<ArticleDetail | null> {
  return getArticleBySlugWithSelect(slug, options.includeSourceText === false ? ARTICLE_PAGE_SELECT : ARTICLE_DETAIL_SELECT, options);
}

export async function getArticlePreviewBySlug(slug: string, options: { includeUnpublished?: boolean } = {}): Promise<ArticleDetail | null> {
  return getArticleBySlugWithSelect(slug, ARTICLE_LIST_SELECT, options);
}

export async function getArticleSourceTextBySlug(slug: string, options: { includeUnpublished?: boolean } = {}) {
  const supabase = getSupabaseAdmin();

  if (!supabase) {
    const article = mockArticles.find((item) => item.slug === slug) ?? null;
    if (!article || (!options.includeUnpublished && article.status !== "summarized")) return null;
    return { slug: article.slug, cleanedText: article.cleanedText ?? null };
  }

  let query = supabase.from(articleRelation(options.includeUnpublished)).select("slug,status,source_metadata,cleaned_text").eq("slug", slug);
  if (!options.includeUnpublished && !publicationProjectionEnabled()) {
    query = query.eq("status", "summarized").filter("source_metadata->collection->>publishable", "eq", "true");
  }

  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(error.message);
  if (!data || (!options.includeUnpublished && !isPublishableListItem(data as unknown as SupabaseArticleRow))) return null;

  const row = data as { slug?: string | null; cleaned_text?: string | null };
  return {
    slug: row.slug ?? slug,
    cleanedText: row.cleaned_text ?? null,
  };
}

export async function getRelatedArticles(article: ArticleListItem, limit = 3) {
  const supabase = getSupabaseAdmin();
  const tagId = article.tags[0]?.id;
  if (supabase && tagId) {
    const { data: relatedTagRows, error: relatedTagError } = await supabase
      .from("article_tags")
      .select("article_id")
      .eq("tag_id", tagId)
      .neq("article_id", article.id ?? "")
      .limit(Math.max(limit * 4, limit));

    if (!relatedTagError) {
      const ids = Array.from(
        new Set(
          (relatedTagRows ?? [])
            .map((row) => (typeof row.article_id === "string" ? row.article_id : null))
            .filter((id): id is string => Boolean(id)),
        ),
      );
      if (ids.length > 0) {
        const result = await listArticles({ ids, pageSize: ids.length, count: "none" });
        return result.items.filter((item) => item.slug !== article.slug).slice(0, limit);
      }
    }
  }

  const tag = article.tags[0]?.slug;
  const result = await listArticles({ tag, pageSize: limit + 1, count: "none" });
  return result.items.filter((item) => item.slug !== article.slug).slice(0, limit);
}

export async function getArticleDetailPageData(slug: string) {
  const article = await getArticleBySlug(slug, { includeSourceText: false });
  if (!article) return null;
  const related = await getRelatedArticles(article);
  return { article, related };
}

export async function listTopViewedArticles(
  limit = 5,
  filters: Pick<ArticleListFilters, "range" | "source" | "jurisdiction" | "type" | "language" | "tag"> = {},
) {
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 20) : 5;
  const supabase = getSupabaseAdmin();

  if (!supabase || filters.tag) {
    return (await listArticles({ ...filters, pageSize: safeLimit, count: "none" })).items;
  }

  const { data: viewRows, error: viewError } = await supabase
    .from("article_view_counts")
    .select("article_slug,view_count")
    .order("view_count", { ascending: false })
    .limit(Math.max(safeLimit * 4, safeLimit));

  if (viewError || !viewRows?.length) {
    return (await listArticles({ ...filters, pageSize: safeLimit, count: "none" })).items;
  }

  const rankedViews = (viewRows as Array<{ article_slug?: string | null; view_count?: number | string | null }>)
    .filter((row) => row.article_slug)
    .map((row) => ({
      slug: String(row.article_slug),
      viewCount: Number(row.view_count ?? 0),
    }));
  const slugs = rankedViews.map((row) => row.slug);
  const viewCountBySlug = new Map(rankedViews.map((row) => [row.slug, row.viewCount]));

  let query = supabase
    .from(articleRelation())
    .select(projectionSelect(ARTICLE_LIST_SELECT))
    .in("slug", slugs)
    .eq("status", "summarized");

  if (!publicationProjectionEnabled()) {
    query = query.filter("source_metadata->collection->>publishable", "eq", "true");
  }

  if (filters.source) query = query.eq("source_key", filters.source);
  if (filters.jurisdiction) query = query.eq("jurisdiction", filters.jurisdiction);
  if (filters.type) query = query.eq("content_type", filters.type);
  if (filters.language) query = query.eq("original_language", filters.language);
  const startIso = getRangeStartIso(filters.range);
  if (startIso) query = query.gte("original_published_at", startIso);

  const { data, error } = await query;
  if (error || !data?.length) {
    return (await listArticles({ ...filters, pageSize: safeLimit, count: "none" })).items;
  }

  const order = new Map(slugs.map((slug, index) => [slug, index]));
  return (data as unknown as SupabaseArticleRow[])
    .map((row) => ({
      ...articleRowToItem(row, { includeSummaryJson: false, includeDetailFields: false }),
      viewCount: viewCountBySlug.get(row.slug) ?? 0,
    }))
    .sort((left, right) => (order.get(left.slug) ?? 9999) - (order.get(right.slug) ?? 9999))
    .slice(0, safeLimit);
}

export async function listJurisdictionArticleCounts(
  jurisdictions: string[] = [],
  options: { range?: ArticleListFilters["range"] } = {},
) {
  const normalizedJurisdictions = Array.from(new Set(jurisdictions.map((jurisdiction) => jurisdiction.trim()).filter(Boolean)));
  const supabase = getSupabaseAdmin();

  if (!supabase) {
    const counts: Record<string, number> = {};
    for (const article of filterMockArticles({ range: options.range })) {
      counts[article.jurisdiction] = (counts[article.jurisdiction] ?? 0) + 1;
    }
    return normalizedJurisdictions.length
      ? Object.fromEntries(normalizedJurisdictions.map((jurisdiction) => [jurisdiction, counts[jurisdiction] ?? 0]))
      : counts;
  }

  const startIso = getRangeStartIso(options.range);
  const countRpc = publicationProjectionEnabled() ? "public_jurisdiction_article_counts_p3" : "public_jurisdiction_article_counts";
  const { data: rpcRows, error: rpcError } = await supabase.rpc(countRpc, { range_start: startIso });
  if (!rpcError && Array.isArray(rpcRows)) {
    const counts = Object.fromEntries(
      (rpcRows as SupabaseJurisdictionCountRow[])
        .filter((row) => typeof row.jurisdiction === "string" && row.jurisdiction.trim())
        .map((row) => [String(row.jurisdiction), Number(row.article_count ?? 0)]),
    );
    return normalizedJurisdictions.length
      ? Object.fromEntries(normalizedJurisdictions.map((jurisdiction) => [jurisdiction, counts[jurisdiction] ?? 0]))
      : counts;
  }

  const targetJurisdictions = normalizedJurisdictions.length
    ? normalizedJurisdictions
    : Array.from(new Set((await listSources()).map((source) => source.jurisdiction)));

  const entries = await Promise.all(
    targetJurisdictions.map(async (jurisdiction) => {
      let query = supabase
        .from(articleRelation())
        .select("id", { count: "exact", head: true })
        .eq("status", "summarized")
        .eq("jurisdiction", jurisdiction);
      if (!publicationProjectionEnabled()) query = query.filter("source_metadata->collection->>publishable", "eq", "true");
      if (startIso) query = query.gte("original_published_at", startIso);

      const { count, error } = await query;
      if (error) throw new Error(error.message);
      return [jurisdiction, count ?? 0] as const;
    }),
  );

  return Object.fromEntries(entries);
}

export async function listTags(options: { type?: string; sort?: "count" | "latest" | "name"; limit?: number } = {}) {
  const supabase = getSupabaseAdmin();
  const limit = Number.isFinite(options.limit) && options.limit && options.limit > 0 ? Math.min(Math.floor(options.limit), 1_000) : null;

  if (!supabase) {
    const tags = [...mockTags]
      .filter((tag) => !options.type || tag.type === options.type)
      .sort((a, b) => {
        if (options.sort === "name") return a.name.localeCompare(b.name);
        if (options.sort === "latest") return (b.latestArticleAt || "").localeCompare(a.latestArticleAt || "");
        return (b.articleCount ?? 0) - (a.articleCount ?? 0);
      });
    return limit ? tags.slice(0, limit) : tags;
  }

  let query = supabase.from(publicationProjectionEnabled() ? "public_tag_projection_p3" : "tags").select("*");
  if (options.type) query = query.eq("type", options.type);
  if (options.sort === "name") query = query.order("name");
  else if (options.sort === "latest") query = query.order("latest_article_at", { ascending: false, nullsFirst: false });
  else query = query.order("article_count", { ascending: false });
  if (limit) query = query.limit(limit);

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

  const tagRelation = publicationProjectionEnabled() ? "public_tag_projection_p3" : "tags";
  const { data: tagData, error: tagError } = await supabase.from(tagRelation).select("*").eq("slug", slug).maybeSingle();
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
    const result = await listArticles({ tag, pageSize: limit, count: "none" });
    for (const article of result.items) {
      articles.set(article.slug, article);
      if (articles.size >= limit) break;
    }
  }

  return [...articles.values()]
    .sort((left, right) => (right.originalPublishedAt || "").localeCompare(left.originalPublishedAt || ""))
    .slice(0, limit);
}
