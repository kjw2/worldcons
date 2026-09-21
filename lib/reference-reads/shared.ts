import type { TagSummary, TagType } from "@/lib/db/types";
import type { TagListOptions } from "@/lib/reference-reads/types";

/**
 * Shared, platform-neutral row mapping and option normalization used by every
 * reference-read adapter. Keeping it here means the Supabase adapter, the mock
 * adapter, and the legacy callers (for example `getTagBySlug`) agree on the
 * exact mapping and clamping rules.
 */
export interface SupabaseTagRow {
  id?: string;
  slug: string;
  name: string;
  normalized_name: string;
  type: string;
  description?: string | null;
  article_count?: number | null;
  latest_article_at?: string | null;
}

export function tagRowToSummary(row: SupabaseTagRow, confidence?: number | null): TagSummary {
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

export interface NormalizedTagListOptions {
  type?: string;
  sort?: "count" | "latest" | "name";
  limit: number | null;
  minArticleCount: number | null;
}

export function normalizeTagListOptions(options: TagListOptions = {}): NormalizedTagListOptions {
  const limit =
    Number.isFinite(options.limit) && options.limit && options.limit > 0
      ? Math.min(Math.floor(options.limit), 1_000)
      : null;
  const minArticleCount =
    Number.isFinite(options.minArticleCount) && (options.minArticleCount ?? 0) > 0
      ? Math.floor(options.minArticleCount ?? 0)
      : null;
  return { type: options.type, sort: options.sort, limit, minArticleCount };
}

export function normalizeJurisdictions(jurisdictions: string[]) {
  return Array.from(new Set(jurisdictions.map((jurisdiction) => jurisdiction.trim()).filter(Boolean)));
}
