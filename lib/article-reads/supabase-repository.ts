import type { SupabaseClient } from "@supabase/supabase-js";
import type { ArticleDetail, ArticleListFilters, ArticleListItem, ArticleListResult } from "@/lib/db/types";
import { isPublishableListItem } from "@/lib/ingest/publishability";
import { caseCatalogSearchEnabled } from "@/lib/case-catalog/flags";
import { rankedSearchPage } from "@/lib/search/ranked-page";
import { rangeStartIso as getRangeStartIso } from "@/lib/utils/dates";
import {
  ARTICLE_LIST_SELECT,
  ARTICLE_LIST_WITH_TAG_FILTER_SELECT,
  articleDetailRelation,
  articleMappingOptions,
  articleRelation,
  articleRowToItem,
  articleSelectForKind,
  detailProjectionSelect,
  normalizePagination,
  projectionSelect,
  publicationProjectionEnabled,
  toFullTextQuery,
  type SupabaseArticleRow,
} from "@/lib/article-reads/shared";
import type {
  ArticleReadOptions,
  ArticleReadRepository,
  ArticleReadSelect,
  ArticleSourceTextRecord,
  RelatedArticleIdsOptions,
  SitemapArticleEntry,
  TopViewedArticleFilters,
} from "@/lib/article-reads/types";

const ARTICLE_SOURCE_TEXT_SELECT = "slug,status,source_key,source_metadata,original_url,cleaned_text,content_hash";

export interface SupabaseArticleReadDependencies {
  /** Resolves the admin client. Resolved once by the selection point. */
  client: () => SupabaseClient;
  environment?: Record<string, string | undefined>;
}

/**
 * Supabase-backed public article reads. This is the authoritative M4
 * implementation: it preserves the exact pre-extraction queries, the publication
 * projection / detail-v4 relation and select selection, the legacy/projected tag
 * filtering, the full-text/ranked fallback, the pagination/ordering/count
 * semantics, the publishability filtering, and the row mapping.
 */
export function createSupabaseArticleReadRepository(
  dependencies: SupabaseArticleReadDependencies,
): ArticleReadRepository {
  const client = dependencies.client;
  const environment = dependencies.environment ?? process.env;

  async function articleViewCountsBySlug(slugs: string[]) {
    const uniqueSlugs = Array.from(new Set(slugs.map((slug) => slug.trim()).filter(Boolean)));
    if (uniqueSlugs.length === 0) return {};
    const supabase = client();

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

  async function tagIdsForTagFilter(tag: string) {
    const supabase = client();

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
    return tagIds;
  }

  async function articleIdsForTagFilter(tag: string) {
    const tagIds = await tagIdsForTagFilter(tag);
    if (tagIds.length === 0) return tagIds;

    const supabase = client();
    const { data, error } = await supabase.from("article_tags").select("article_id").in("tag_id", tagIds);
    if (error) throw new Error(error.message);
    return data?.map((row) => String(row.article_id)) ?? [];
  }

  async function getArticleBySelect(
    slug: string,
    select: ArticleReadSelect,
    options: ArticleReadOptions = {},
  ): Promise<ArticleDetail | null> {
    const supabase = client();
    let query = supabase
      .from(articleDetailRelation(options.includeUnpublished, environment))
      .select(detailProjectionSelect(articleSelectForKind(select), options.includeUnpublished, environment))
      .eq("slug", slug);

    if (!options.includeUnpublished && !publicationProjectionEnabled(options.includeUnpublished, environment)) {
      query = query.eq("status", "summarized").eq("catalog_ai_stale_v4", false).filter("source_metadata->collection->>publishable", "eq", "true");
    }

    const { data, error } = await query.maybeSingle();

    if (error) {
      throw new Error(error.message);
    }

    const row = data as unknown as SupabaseArticleRow;
    if (!data || (!options.includeUnpublished && row.source_metadata !== undefined && !isPublishableListItem(row))) {
      return null;
    }

    return articleRowToItem(row, articleMappingOptions(select));
  }

  async function listArticlesByFullText(filters: ArticleListFilters, tagArticleIds: string[] | null): Promise<ArticleListResult> {
    const { page, pageSize } = normalizePagination(filters.page, filters.pageSize);
    const supabase = client();
    const tsQuery = toFullTextQuery(filters.q);

    if (!filters.includeUnpublished && caseCatalogSearchEnabled(environment)) {
      const { catalogCaseSearch } = await import("@/lib/search/case-catalog");
      return catalogCaseSearch(filters);
    }

    if (!tsQuery) {
      return { items: [], pageInfo: { page, pageSize, total: 0, hasMore: false, totalIsExact: true } };
    }

    const { exactCaseSearch } = await import("@/lib/search/exact-case");
    const exactCaseResult = await exactCaseSearch(filters);
    if (exactCaseResult.items.length > 0) return exactCaseResult;

    const rankedPage = await rankedSearchPage(filters, "fulltext", null);
    if (rankedPage) {
      if (rankedPage.ids.length === 0) return { items: [], pageInfo: rankedPage.pageInfo };
      const rankedResult = await listArticles({
        ...filters,
        q: undefined,
        ids: rankedPage.ids,
        page: 1,
        pageSize: rankedPage.ids.length,
        count: "none",
      });
      const order = new Map(rankedPage.ids.map((id, index) => [id, index]));
      const items = [...rankedResult.items].sort(
        (left, right) => (order.get(left.id ?? "") ?? Number.MAX_SAFE_INTEGER) - (order.get(right.id ?? "") ?? Number.MAX_SAFE_INTEGER),
      );
      return {
        items,
        pageInfo: rankedPage.pageInfo,
      };
    }

    const fallbackCandidateLimit = Math.min(Math.max((page + 1) * pageSize, 200), 1000);
    let query = supabase
      .from(articleRelation(filters.includeUnpublished, environment))
      .select("id")
      .textSearch("search_vector", tsQuery, { config: "simple" })
      .order("original_published_at", { ascending: false, nullsFirst: false })
      .order("id", { ascending: true })
      .limit(fallbackCandidateLimit);

    if (!filters.includeUnpublished && !publicationProjectionEnabled(undefined, environment)) {
      query = query.eq("status", "summarized").eq("catalog_ai_stale_v4", false).filter("source_metadata->collection->>publishable", "eq", "true");
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

    const hasMore = start + pageSize < matched.length || matched.length >= fallbackCandidateLimit;
    return {
      items: matched.slice(start, start + pageSize),
      pageInfo: {
        page,
        pageSize,
        total: matched.length + (hasMore && start + pageSize >= matched.length ? 1 : 0),
        hasMore,
        totalIsExact: matched.length < fallbackCandidateLimit,
      },
    };
  }

  async function listArticles(filters: ArticleListFilters = {}): Promise<ArticleListResult> {
    const { page, pageSize } = normalizePagination(filters.page, filters.pageSize);
    const supabase = client();

    if (filters.ids && filters.ids.length === 0) {
      return { items: [], pageInfo: { page, pageSize, total: 0, hasMore: false, totalIsExact: true } };
    }

    const canFilterProjectedTagBySlug = Boolean(
      filters.tag &&
        !filters.q &&
        publicationProjectionEnabled(filters.includeUnpublished, environment) &&
        /^[a-z0-9][a-z0-9-]*$/i.test(filters.tag),
    );
    let tagIds: string[] | null = null;
    let tagArticleIds: string[] | null = null;
    if (filters.tag && !canFilterProjectedTagBySlug) {
      tagIds = (await tagIdsForTagFilter(filters.tag)) ?? [];
      if (tagIds.length === 0) {
        return { items: [], pageInfo: { page, pageSize, total: 0, hasMore: false, totalIsExact: true } };
      }
      if (filters.q && !publicationProjectionEnabled(filters.includeUnpublished, environment)) {
        tagArticleIds = (await articleIdsForTagFilter(filters.tag)) ?? [];
      }
    }

    if (filters.q) {
      return listArticlesByFullText(filters, tagArticleIds);
    }

    const countMode = filters.count ?? "exact";
    const useLegacyTagJoin = Boolean(tagIds?.length && !publicationProjectionEnabled(filters.includeUnpublished, environment));
    let query = supabase
      .from(articleDetailRelation(filters.includeUnpublished, environment))
      .select(
        detailProjectionSelect(useLegacyTagJoin ? ARTICLE_LIST_WITH_TAG_FILTER_SELECT : ARTICLE_LIST_SELECT, filters.includeUnpublished, environment),
        countMode === "none" ? undefined : { count: countMode },
      )
      .order("original_published_at", { ascending: false, nullsFirst: false })
      .order("id", { ascending: true });

    if (!filters.includeUnpublished && !publicationProjectionEnabled(undefined, environment)) {
      query = query.eq("status", "summarized").eq("catalog_ai_stale_v4", false).filter("source_metadata->collection->>publishable", "eq", "true");
    }
    if (filters.ids) query = query.in("id", filters.ids);
    if (filters.source) query = query.eq("source_key", filters.source);
    if (filters.jurisdiction) query = query.eq("jurisdiction", filters.jurisdiction);
    if (filters.type) query = query.eq("content_type", filters.type);
    if (filters.language) query = query.eq("original_language", filters.language);
    if (tagArticleIds) query = query.in("id", tagArticleIds);
    if (useLegacyTagJoin && tagIds) query = query.in("article_tag_filter.tag_id", tagIds);
    if (canFilterProjectedTagBySlug && filters.tag) {
      query = query.contains("article_tags", JSON.stringify([{ tags: { slug: filters.tag } }]));
    }

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

  async function getArticleSourceTextBySlug(
    slug: string,
    options: ArticleReadOptions = {},
  ): Promise<ArticleSourceTextRecord | null> {
    const supabase = client();
    let query = supabase.from(articleDetailRelation(options.includeUnpublished, environment))
      .select(ARTICLE_SOURCE_TEXT_SELECT)
      .eq("slug", slug);
    if (!options.includeUnpublished && !publicationProjectionEnabled(options.includeUnpublished, environment)) {
      query = query.eq("status", "summarized").eq("catalog_ai_stale_v4", false).filter("source_metadata->collection->>publishable", "eq", "true");
    }

    const { data, error } = await query.maybeSingle();
    if (error) throw new Error(error.message);
    if (!data || (!options.includeUnpublished && !isPublishableListItem(data as unknown as SupabaseArticleRow))) return null;

    const row = data as {
      slug?: string | null;
      source_key?: string | null;
      source_metadata?: Record<string, unknown> | null;
      original_url?: string | null;
      cleaned_text?: string | null;
      content_hash?: string | null;
    };
    return {
      slug: row.slug ?? slug,
      sourceKey: row.source_key ?? null,
      sourceMetadata: row.source_metadata ?? null,
      officialUrl: row.original_url ?? null,
      cleanedText: row.cleaned_text ?? null,
      contentHash: row.content_hash ?? null,
    };
  }

  async function listPublicSitemapArticles(): Promise<SitemapArticleEntry[]> {
    const supabase = client();
    const pageSize = 1000;
    const items: SitemapArticleEntry[] = [];

    for (let from = 0; from < 50_000; from += pageSize) {
      let query = supabase
        .from(articleRelation(undefined, environment))
        .select("slug, summarized_at, fetched_at, discovered_at")
        .order("original_published_at", { ascending: false, nullsFirst: false })
        .order("id", { ascending: true })
        .range(from, from + pageSize - 1);
      if (!publicationProjectionEnabled(undefined, environment)) {
        query = query.eq("status", "summarized").eq("catalog_ai_stale_v4", false).filter("source_metadata->collection->>publishable", "eq", "true");
      }
      const { data, error } = await query;
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as Array<{
        slug?: string | null;
        summarized_at?: string | null;
        fetched_at?: string | null;
        discovered_at?: string | null;
      }>;
      for (const row of rows) {
        if (!row.slug) continue;
        items.push({
          slug: row.slug,
          lastModified: row.summarized_at || row.fetched_at || row.discovered_at || null,
        });
      }
      if (rows.length < pageSize) break;
    }
    return items;
  }

  async function listTopViewedArticles(
    limit = 5,
    filters: TopViewedArticleFilters = {},
  ): Promise<ArticleListItem[]> {
    const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 20) : 5;
    const supabase = client();

    if (filters.tag) {
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
      .from(articleRelation(undefined, environment))
      .select(projectionSelect(ARTICLE_LIST_SELECT, undefined, environment))
      .in("slug", slugs)
      .eq("status", "summarized");

    if (!publicationProjectionEnabled(undefined, environment)) {
      query = query.eq("catalog_ai_stale_v4", false).filter("source_metadata->collection->>publishable", "eq", "true");
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

  async function listRelatedArticleIds(tagId: string, options: RelatedArticleIdsOptions): Promise<string[]> {
    const supabase = client();
    const { data, error } = await supabase
      .from("article_tags")
      .select("article_id")
      .eq("tag_id", tagId)
      .neq("article_id", options.excludeArticleId ?? "")
      .limit(options.limit);
    if (error) return [];
    return Array.from(
      new Set(
        (data ?? [])
          .map((row) => (typeof row.article_id === "string" ? row.article_id : null))
          .filter((id): id is string => Boolean(id)),
      ),
    );
  }

  return { listArticles, listPublicSitemapArticles, listTopViewedArticles, listRelatedArticleIds, getArticleBySelect, getArticleSourceTextBySlug };
}
