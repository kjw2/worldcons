import type { ArticleListFilters, SourceRecord, TagSummary } from "@/lib/db/types";

export interface TagListOptions {
  type?: string;
  sort?: "count" | "latest" | "name";
  limit?: number;
  minArticleCount?: number;
}

export type JurisdictionRange = ArticleListFilters["range"];

export interface JurisdictionCountOptions {
  range?: JurisdictionRange;
}

/**
 * Platform-neutral contract for the public reference-read domain: the source
 * inventory, the public tag catalog, and the jurisdiction article counts.
 *
 * The contract deliberately exposes no Postgres/Supabase types so a future D1
 * repository can implement it without callers changing. The Supabase-backed
 * implementation remains authoritative during M4.
 */
export interface ReferenceReadRepository {
  listSources(): Promise<SourceRecord[]>;
  listTags(options?: TagListOptions): Promise<TagSummary[]>;
  listJurisdictionArticleCounts(
    jurisdictions?: string[],
    options?: JurisdictionCountOptions,
  ): Promise<Record<string, number>>;
}
