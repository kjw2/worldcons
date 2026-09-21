import type { SupabaseClient } from "@supabase/supabase-js";
import { publicArticleRelation, publicProjectionReadsEnabled } from "@/lib/article-publication";
import type { GlossaryTerm, IngestionRunRecord, SourceRecord, TagSummary } from "@/lib/db/types";
import { rangeStartIso } from "@/lib/utils/dates";
import {
  glossaryTermRowToRecord,
  ingestionRunRowToRecord,
  normalizeJurisdictions,
  normalizeTagListOptions,
  sortGlossaryTerms,
  tagRowToSummary,
  type SupabaseGlossaryTermRow,
  type SupabaseIngestionRunRow,
  type SupabaseTagRow,
} from "@/lib/reference-reads/shared";
import type { JurisdictionCountOptions, ReferenceReadRepository, TagListOptions } from "@/lib/reference-reads/types";

interface SupabaseJurisdictionCountRow {
  jurisdiction?: string | null;
  article_count?: number | string | null;
}

export interface SupabaseReferenceReadDependencies {
  /** Resolves the admin client. Resolved once by the selection point. */
  client: () => SupabaseClient;
  environment?: Record<string, string | undefined>;
}

/**
 * Supabase-backed public reference reads. This is the authoritative M4
 * implementation: it preserves the exact pre-extraction queries, the
 * publication-projection table/RPC selection, and the jurisdiction-count
 * RPC-then-per-jurisdiction fallback.
 */
export function createSupabaseReferenceReadRepository(
  dependencies: SupabaseReferenceReadDependencies,
): ReferenceReadRepository {
  const client = dependencies.client;
  const environment = dependencies.environment ?? process.env;

  function projectionEnabled() {
    return publicProjectionReadsEnabled(false, environment);
  }

  function articleRelation() {
    return publicArticleRelation(false, environment);
  }

  async function listSources(): Promise<SourceRecord[]> {
    const supabase = client();
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

  async function listTags(options: TagListOptions = {}): Promise<TagSummary[]> {
    const supabase = client();
    const { type, sort, limit, minArticleCount } = normalizeTagListOptions(options);

    let query = supabase.from(projectionEnabled() ? "public_tag_projection_p3" : "tags").select("*");
    if (type) query = query.eq("type", type);
    if (minArticleCount) query = query.gte("article_count", minArticleCount);
    if (sort === "name") query = query.order("name");
    else if (sort === "latest") query = query.order("latest_article_at", { ascending: false, nullsFirst: false });
    else query = query.order("article_count", { ascending: false });
    if (limit) query = query.limit(limit);

    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return ((data ?? []) as SupabaseTagRow[]).map((tag) => tagRowToSummary(tag));
  }

  async function listJurisdictionArticleCounts(
    jurisdictions: string[] = [],
    options: JurisdictionCountOptions = {},
  ): Promise<Record<string, number>> {
    const supabase = client();
    const normalizedJurisdictions = normalizeJurisdictions(jurisdictions);
    const startIso = rangeStartIso(options.range);
    const countRpc = projectionEnabled() ? "public_jurisdiction_article_counts_p3" : "public_jurisdiction_article_counts";
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
        if (!projectionEnabled()) query = query.eq("catalog_ai_stale_v4", false).filter("source_metadata->collection->>publishable", "eq", "true");
        if (startIso) query = query.gte("original_published_at", startIso);

        const { count, error } = await query;
        if (error) throw new Error(error.message);
        return [jurisdiction, count ?? 0] as const;
      }),
    );

    return Object.fromEntries(entries);
  }

  async function listGlossaryTerms(): Promise<GlossaryTerm[]> {
    const supabase = client();
    const { data, error } = await supabase.from("glossary_terms").select("*").order("term");
    if (error) throw new Error(error.message);

    return sortGlossaryTerms(((data ?? []) as SupabaseGlossaryTermRow[]).map((row) => glossaryTermRowToRecord(row)));
  }

  async function getGlossaryTerm(slug: string): Promise<GlossaryTerm | null> {
    const terms = await listGlossaryTerms();
    return terms.find((term) => term.slug === slug) ?? null;
  }

  async function listIngestionRuns(limit = 20): Promise<IngestionRunRecord[]> {
    const supabase = client();
    const { data, error } = await supabase
      .from("ingestion_runs")
      .select("*")
      .order("started_at", { ascending: false })
      .limit(limit);
    if (error) throw new Error(error.message);

    return ((data ?? []) as SupabaseIngestionRunRow[]).map((row) => ingestionRunRowToRecord(row));
  }

  async function getTagBySlug(slug: string): Promise<TagSummary | null> {
    const supabase = client();
    const { data, error } = await supabase
      .from(projectionEnabled() ? "public_tag_projection_p3" : "tags")
      .select("*")
      .eq("slug", slug)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    return tagRowToSummary(data as SupabaseTagRow);
  }

  return { listSources, listTags, listJurisdictionArticleCounts, listGlossaryTerms, getGlossaryTerm, listIngestionRuns, getTagBySlug };
}
