import type { ArticleDetail, ArticleListFilters, ArticleListItem, ArticleListResult } from "@/lib/db/types";

/**
 * Which projection of an article row a public detail surface reads:
 *
 * - `list`   — the compact list projection (no `source_metadata` / `summary_json`);
 * - `page`   — the list projection plus page/detail metadata;
 * - `detail` — the full detail projection with raw/cleaned text and blob metadata.
 *
 * The kind stays platform-neutral on purpose: the Supabase adapter maps it to the
 * exact PostgREST select strings, so callers never build select shapes.
 */
export type ArticleReadSelect = "list" | "page" | "detail";

export interface ArticleReadOptions {
  includeUnpublished?: boolean;
}

export interface ArticleSourceTextRecord {
  slug: string;
  sourceKey: string | null;
  sourceMetadata: Record<string, unknown> | null;
  officialUrl: string | null;
  cleanedText: string | null;
  contentHash: string | null;
}

/** A single sitemap article entry: the public slug and its last-modified witness. */
export interface SitemapArticleEntry {
  slug: string;
  lastModified: string | null;
}

/** The public filters `listTopViewedArticles` accepts (view-count ranking ignores tag filtering). */
export type TopViewedArticleFilters = Pick<
  ArticleListFilters,
  "range" | "source" | "jurisdiction" | "type" | "language" | "tag"
>;

export interface RelatedArticleIdsOptions {
  excludeArticleId?: string | null;
  limit: number;
}

/**
 * Platform-neutral contract for the public article read domain: the compact
 * filtered/paginated list read, the slug-keyed detail/preview row fetch, and the
 * slug-keyed source-text snapshot.
 *
 * The contract exposes no Postgres/Supabase types so a future D1 repository can
 * implement it without callers changing. The Supabase-backed implementation
 * remains authoritative during M4. Raw-text Blob (R2) hydration deliberately
 * stays outside this boundary because it is a storage concern owned by the
 * caller.
 */
export interface ArticleReadRepository {
  listArticles(filters?: ArticleListFilters): Promise<ArticleListResult>;
  listPublicSitemapArticles(): Promise<SitemapArticleEntry[]>;
  listTopViewedArticles(limit?: number, filters?: TopViewedArticleFilters): Promise<ArticleListItem[]>;
  listRelatedArticleIds(tagId: string, options: RelatedArticleIdsOptions): Promise<string[]>;
  getArticleBySelect(
    slug: string,
    select: ArticleReadSelect,
    options?: ArticleReadOptions,
  ): Promise<ArticleDetail | null>;
  getArticleSourceTextBySlug(
    slug: string,
    options?: ArticleReadOptions,
  ): Promise<ArticleSourceTextRecord | null>;
}
