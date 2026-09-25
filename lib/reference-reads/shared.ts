import type { GlossaryTerm, IngestionRunRecord, SourceRecord, TagSummary, TagType } from "@/lib/db/types";
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

/**
 * A source row as returned by Supabase (`is_active` boolean) or D1 (boolean
 * stored as INTEGER 0/1). The mapper normalizes both to the contract boolean so
 * the two adapters map identically.
 */
export interface SupabaseSourceRow {
  id?: string;
  source_key: string;
  name: string;
  jurisdiction: string;
  base_url: string;
  language: string;
  is_active: boolean | number | string | null;
}

export function sourceRowToRecord(row: SupabaseSourceRow): SourceRecord {
  return {
    id: row.id,
    sourceKey: row.source_key,
    name: row.name,
    jurisdiction: row.jurisdiction,
    baseUrl: row.base_url,
    language: row.language,
    isActive: row.is_active === true || row.is_active === 1 || row.is_active === "1",
  };
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

export interface SupabaseGlossaryTermRow {
  slug: string;
  term: string;
  korean_term?: string | null;
  definition: string;
  jurisdiction?: string | null;
  related_tags?: string[] | null;
}

export function glossaryTermRowToRecord(row: SupabaseGlossaryTermRow): GlossaryTerm {
  return {
    slug: row.slug,
    term: row.term,
    koreanTerm: row.korean_term,
    definition: row.definition,
    jurisdiction: row.jurisdiction,
    relatedTags: row.related_tags ?? [],
  };
}

export function sortGlossaryTerms(terms: GlossaryTerm[]): GlossaryTerm[] {
  return [...terms].sort((left, right) => {
    const leftLabel = left.koreanTerm || left.term;
    const rightLabel = right.koreanTerm || right.term;
    return leftLabel.localeCompare(rightLabel, "ko");
  });
}

export interface SupabaseIngestionRunRow {
  id?: string;
  source_key: string;
  started_at: string;
  finished_at?: string | null;
  status: string;
  discovered_count: number;
  fetched_count: number;
  summarized_count: number;
  failed_count: number;
  error_message?: string | null;
  metadata?: Record<string, unknown> | null;
}

export function ingestionRunRowToRecord(row: SupabaseIngestionRunRow): IngestionRunRecord {
  return {
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
  };
}
