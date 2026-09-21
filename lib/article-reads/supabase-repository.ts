import type { SupabaseClient } from "@supabase/supabase-js";
import type { ArticleDetail } from "@/lib/db/types";
import { isPublishableListItem } from "@/lib/ingest/publishability";
import {
  articleDetailRelation,
  articleMappingOptions,
  articleRowToItem,
  articleSelectForKind,
  detailProjectionSelect,
  publicationProjectionEnabled,
  type SupabaseArticleRow,
} from "@/lib/article-reads/shared";
import type {
  ArticleReadOptions,
  ArticleReadRepository,
  ArticleReadSelect,
  ArticleSourceTextRecord,
} from "@/lib/article-reads/types";

const ARTICLE_SOURCE_TEXT_SELECT = "slug,status,source_key,source_metadata,original_url,cleaned_text,content_hash";

export interface SupabaseArticleReadDependencies {
  /** Resolves the admin client. Resolved once by the selection point. */
  client: () => SupabaseClient;
  environment?: Record<string, string | undefined>;
}

/**
 * Supabase-backed public article detail reads. This is the authoritative M4
 * implementation: it preserves the exact pre-extraction queries, the publication
 * projection / detail-v4 relation and select selection, the publishability
 * filtering, and the row mapping.
 */
export function createSupabaseArticleReadRepository(
  dependencies: SupabaseArticleReadDependencies,
): ArticleReadRepository {
  const client = dependencies.client;
  const environment = dependencies.environment ?? process.env;

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

  return { getArticleBySelect, getArticleSourceTextBySlug };
}
