import type {
  ArticleDetail,
  ArticleListFilters,
  ArticleListItem,
  ArticleListResult,
  GlossaryTerm,
  IngestionRunRecord,
  SourceRecord,
} from "@/lib/db/types";
import { expandRelatedTagNames } from "@/lib/glossary/tag-aliases";
import { observeArticlePublicationReadDecision } from "@/lib/article-publication";
import { hydrateArticleRawText } from "@/lib/article-raw/detail-read";
import type { ArtifactBlobStore } from "@/lib/storage/blob";
import { createRuntimeArtifactBlobStore } from "@/lib/storage/runtime-blob";
import { referenceReads } from "@/lib/reference-reads";
import type { JurisdictionCountOptions, TagListOptions } from "@/lib/reference-reads/types";
import { articleReads } from "@/lib/article-reads";
import type { ArticleReadSelect, TopViewedArticleFilters } from "@/lib/article-reads/types";

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
  return articleReads().listPublicSitemapArticles();
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
  const strongestTag = [...article.tags]
    .filter((tag) => (tag.articleCount ?? 0) >= 3)
    .sort((left, right) => (right.articleCount ?? 0) - (left.articleCount ?? 0))[0];
  const tagId = strongestTag?.id;
  if (tagId) {
    const ids = await articleReads().listRelatedArticleIds(tagId, {
      excludeArticleId: article.id ?? "",
      limit: Math.max(limit * 4, limit),
    });
    if (ids.length > 0) {
      const result = await listArticles({ ids, pageSize: ids.length, count: "none", includeViewCounts: false });
      return result.items.filter((item) => item.slug !== article.slug).slice(0, limit);
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
  filters: TopViewedArticleFilters = {},
) {
  observePublicProjectionRead();
  return articleReads().listTopViewedArticles(limit, filters);
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
  const tag = await referenceReads().getTagBySlug(slug);
  if (!tag) return null;
  const articles = await listArticles({ tag: slug, pageSize: 50 });
  return { tag, articles: articles.items };
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
