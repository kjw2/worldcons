import { getSupabaseAdmin } from "@/lib/db/client";
import { mockArticles, mockTags } from "@/lib/db/mock-data";
import type {
  ArticleDetail,
  ArticleListFilters,
  ArticleListItem,
  ArticleListResult,
  GlossaryTerm,
  IngestionRunRecord,
  SourceRecord,
} from "@/lib/db/types";
import { rangeStartIso as getRangeStartIso } from "@/lib/utils/dates";
import { expandRelatedTagNames } from "@/lib/glossary/tag-aliases";
import { observeArticlePublicationReadDecision } from "@/lib/article-publication";
import { hydrateArticleRawText } from "@/lib/article-raw/detail-read";
import type { ArtifactBlobStore } from "@/lib/storage/blob";
import { createRuntimeArtifactBlobStore } from "@/lib/storage/runtime-blob";
import { referenceReads } from "@/lib/reference-reads";
import { tagRowToSummary, type SupabaseTagRow } from "@/lib/reference-reads/shared";
import type { JurisdictionCountOptions, TagListOptions } from "@/lib/reference-reads/types";
import { articleReads } from "@/lib/article-reads";
import type { ArticleReadSelect } from "@/lib/article-reads/types";
import {
  articleRelation,
  articleRowToItem,
  filterMockArticles,
  projectionSelect,
  publicationProjectionEnabled,
  ARTICLE_LIST_SELECT,
  type SupabaseArticleRow,
} from "@/lib/article-reads/shared";

export { normalizePagination } from "@/lib/article-reads/shared";

function observePublicProjectionRead(includeUnpublished?: boolean) {
  if (!includeUnpublished) observeArticlePublicationReadDecision("public_query");
}

export async function listArticles(filters: ArticleListFilters = {}): Promise<ArticleListResult> {
  observePublicProjectionRead(filters.includeUnpublished);
  return articleReads().listArticles(filters);
}

export async function listPublicSitemapArticles() {
  observePublicProjectionRead();
  const supabase = getSupabaseAdmin();
  const pageSize = 1000;

  if (!supabase) {
    return filterMockArticles({}).map((article) => ({
      slug: article.slug,
      lastModified: article.summarizedAt || article.fetchedAt || article.discoveredAt || null,
    }));
  }

  const items: Array<{ slug: string; lastModified: string | null }> = [];
  for (let from = 0; from < 50_000; from += pageSize) {
    let query = supabase
      .from(articleRelation())
      .select("slug, summarized_at, fetched_at, discovered_at")
      .order("original_published_at", { ascending: false, nullsFirst: false })
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (!publicationProjectionEnabled()) {
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

export interface ArticleDetailReadOptions {
  includeUnpublished?: boolean;
  includeSourceText?: boolean;
  blobStore?: ArtifactBlobStore;
  environment?: Record<string, string | undefined>;
}

export async function getArticleBySlug(slug: string, options: ArticleDetailReadOptions = {}): Promise<ArticleDetail | null> {
  observePublicProjectionRead(options.includeUnpublished);
  const select: ArticleReadSelect = options.includeSourceText === false ? "page" : "detail";
  const article = await articleReads().getArticleBySelect(slug, select, options);
  if (!article || select !== "detail" || !article.rawTextBlob) return article;
  return hydrateArticleRawText(article, {
    store: options.blobStore ?? createRuntimeArtifactBlobStore(options.environment),
    environment: options.environment,
  });
}

export async function getArticlePreviewBySlug(slug: string, options: { includeUnpublished?: boolean } = {}): Promise<ArticleDetail | null> {
  observePublicProjectionRead(options.includeUnpublished);
  return articleReads().getArticleBySelect(slug, "list", options);
}

export async function getArticleSourceTextBySlug(slug: string, options: { includeUnpublished?: boolean } = {}) {
  observePublicProjectionRead(options.includeUnpublished);
  return articleReads().getArticleSourceTextBySlug(slug, options);
}

export async function getRelatedArticles(article: ArticleListItem, limit = 3) {
  observePublicProjectionRead();
  const supabase = getSupabaseAdmin();
  const strongestTag = [...article.tags]
    .filter((tag) => (tag.articleCount ?? 0) >= 3)
    .sort((left, right) => (right.articleCount ?? 0) - (left.articleCount ?? 0))[0];
  const tagId = strongestTag?.id;
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
        const result = await listArticles({ ids, pageSize: ids.length, count: "none", includeViewCounts: false });
        return result.items.filter((item) => item.slug !== article.slug).slice(0, limit);
      }
    }
  }

  if (strongestTag?.slug) {
    const result = await listArticles({ tag: strongestTag.slug, pageSize: limit + 1, count: "none", includeViewCounts: false });
    const related = result.items.filter((item) => item.slug !== article.slug).slice(0, limit);
    if (related.length > 0) return related;
  }

  const sourceFallback = await listArticles({
    source: article.sourceKey,
    pageSize: Math.max(limit + 1, 4),
    count: "none",
    includeViewCounts: false,
  });
  return sourceFallback.items.filter((item) => item.slug !== article.slug).slice(0, limit);
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
  observePublicProjectionRead();
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

export async function listJurisdictionArticleCounts(
  jurisdictions: string[] = [],
  options: JurisdictionCountOptions = {},
) {
  observePublicProjectionRead();
  return referenceReads().listJurisdictionArticleCounts(jurisdictions, options);
}

export async function listTags(options: TagListOptions = {}) {
  observePublicProjectionRead();
  return referenceReads().listTags(options);
}

export async function getTagBySlug(slug: string) {
  observePublicProjectionRead();
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
  return referenceReads().listSources();
}

export async function getSourceByKey(sourceKey: string) {
  const sources = await listSources();
  return sources.find((source) => source.sourceKey === sourceKey) ?? null;
}

export async function listIngestionRuns(limit = 20): Promise<IngestionRunRecord[]> {
  return referenceReads().listIngestionRuns(limit);
}

export async function listGlossaryTerms(): Promise<GlossaryTerm[]> {
  return referenceReads().listGlossaryTerms();
}

export async function getGlossaryTerm(slug: string) {
  return referenceReads().getGlossaryTerm(slug);
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
