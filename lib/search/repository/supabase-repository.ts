import type { SupabaseClient } from "@supabase/supabase-js";
import {
  publicArticleRelation,
  publicProjectionReadsEnabled,
  publicVectorMatchRpc,
} from "@/lib/article-publication";
import { normalizeRange } from "@/lib/utils/dates";
import type {
  CatalogCaseSearchRpcRequest,
  CatalogCaseSearchRpcResult,
  ExactCaseArticleIdRequest,
  FullTextRankedIdsRpcRequest,
  RankedSearchPageRpcRequest,
  SearchRepository,
  SemanticEmbeddingRowRequest,
  VectorMatchRpcRequest,
} from "@/lib/search/repository/types";

const RANKED_SEARCH_PAGE_RPC = "worldcons_ranked_search_page_v1";
const CATALOG_CASE_SEARCH_RPC = "worldcons_case_search_page_v2";
const FULLTEXT_RANKED_IDS_RPC = "public_fulltext_ranked_ids_v1";
const EXACT_CASE_LOOKUP_LIMIT = 100;

export interface SupabaseSearchDependencies {
  /** Resolves the admin client. Resolved once by the selection point. */
  client: () => SupabaseClient;
  environment?: Record<string, string | undefined>;
}

/**
 * Supabase-backed search data access. This is the authoritative M4
 * implementation: it preserves the exact pre-extraction RPC calls and table
 * reads, including the public relation/projection choice, the legacy
 * publishable filter, the indexed `case_key` lookup with its metadata/
 * `original_url` rollout fallback, and every RPC argument shape.
 */
export function createSupabaseSearchRepository(
  dependencies: SupabaseSearchDependencies,
): SearchRepository {
  const client = dependencies.client;
  const environment = dependencies.environment ?? process.env;

  function isConfigured() {
    return true;
  }

  async function rankedSearchPageRpc(request: RankedSearchPageRpcRequest): Promise<unknown | null> {
    const supabase = client();
    const { data, error } = await supabase.rpc(RANKED_SEARCH_PAGE_RPC, {
      p_query: request.query,
      p_mode: request.mode,
      p_query_embedding: request.embedding,
      p_limit: request.limit,
      p_offset: request.offset,
      p_source: request.source,
      p_jurisdiction: request.jurisdiction,
      p_content_type: request.contentType,
      p_language: request.language,
      p_tag: request.tag,
      p_range: request.range,
      p_count: request.count,
    });
    if (error) return null;
    return data ?? null;
  }

  async function catalogCaseSearchRpc(
    request: CatalogCaseSearchRpcRequest,
  ): Promise<CatalogCaseSearchRpcResult> {
    const supabase = client();
    const { data, error } = await supabase.rpc(CATALOG_CASE_SEARCH_RPC, {
      p_query: request.query,
      p_limit: request.limit,
      p_cursor: request.cursor,
      p_source: request.source,
      p_jurisdiction: request.jurisdiction,
      p_content_type: request.contentType,
      p_language: request.language,
      p_tag: request.tag,
      p_range: request.range,
    });
    if (error) {
      return {
        status: "error",
        error: { code: error.code, message: error.message, details: error.details, hint: error.hint },
      };
    }
    return { status: "ok", data: data ?? null };
  }

  async function fullTextRankedIdsRpc(request: FullTextRankedIdsRpcRequest): Promise<unknown[] | null> {
    const supabase = client();
    const { data, error } = await supabase.rpc(FULLTEXT_RANKED_IDS_RPC, {
      p_query: request.query,
      p_limit: request.limit,
      p_source: request.source,
      p_jurisdiction: request.jurisdiction,
      p_content_type: request.contentType,
      p_language: request.language,
      p_range: request.range,
    });
    if (error || !Array.isArray(data)) return null;
    return data;
  }

  async function vectorMatchRpc(request: VectorMatchRpcRequest): Promise<unknown[] | null> {
    const supabase = client();
    const { data, error } = await supabase.rpc(publicVectorMatchRpc(false, environment), {
      query_embedding: request.embedding,
      match_count: request.matchCount,
      source_filter: request.source,
      jurisdiction_filter: request.jurisdiction,
      content_type_filter: request.contentType,
      language_filter: request.language,
    });
    if (error || !Array.isArray(data)) return null;
    return data;
  }

  async function findSemanticEmbeddingRows(
    request: SemanticEmbeddingRowRequest,
  ): Promise<unknown[] | null> {
    const supabase = client();
    let query = supabase
      .from(publicArticleRelation(false, environment))
      .select("id, embedding")
      .not("embedding", "is", null)
      .eq("status", "summarized")
      .limit(Math.max(request.matchCount, 100));

    if (!publicProjectionReadsEnabled(false, environment)) {
      query = query.filter("source_metadata->collection->>publishable", "eq", "true");
    }

    if (request.source) query = query.eq("source_key", request.source);
    if (request.jurisdiction) query = query.eq("jurisdiction", request.jurisdiction);
    if (request.contentType) query = query.eq("content_type", request.contentType);
    if (request.language) query = query.eq("original_language", request.language);

    const range = normalizeRange(request.range);
    if (range === "today") {
      const now = new Date();
      query = query.gte(
        "original_published_at",
        new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString(),
      );
    } else if (range === "week" || range === "month") {
      const days = range === "week" ? 7 : 30;
      query = query.gte("original_published_at", new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString());
    }

    const { data, error } = await query;
    if (error || !Array.isArray(data)) return null;
    return data;
  }

  async function findExactCaseArticleIds(request: ExactCaseArticleIdRequest): Promise<string[]> {
    const supabase = client();
    const relation = publicArticleRelation(false, environment);
    const projectionEnabled = publicProjectionReadsEnabled(false, environment);
    const ids: string[] = [];

    for (const reference of request.references) {
      const baseQuery = () => {
        let query = supabase.from(relation).select("id").eq("source_key", reference.sourceKey);
        if (!projectionEnabled) {
          query = query.eq("status", "summarized").filter("source_metadata->collection->>publishable", "eq", "true");
        }
        if (request.jurisdiction) query = query.eq("jurisdiction", request.jurisdiction);
        if (request.type) query = query.eq("content_type", request.type);
        if (request.language) query = query.eq("original_language", request.language);
        return query;
      };

      const indexedResult = await baseQuery().eq("case_key", reference.caseKey).limit(EXACT_CASE_LOOKUP_LIMIT);
      if (!indexedResult.error && Array.isArray(indexedResult.data)) {
        for (const row of indexedResult.data as Array<{ id?: string }>) {
          if (row.id && !ids.includes(row.id)) ids.push(row.id);
        }
        continue;
      }

      // Rollout fallback for databases that have not applied the indexed case_key migration yet.
      const metadataResult = await baseQuery()
        .ilike("source_metadata->>caseNumber", `%${reference.caseNumber}%`)
        .limit(EXACT_CASE_LOOKUP_LIMIT);
      const urlToken = reference.sourceKey === "de-bverfg" ? reference.caseKey : reference.caseNumber;
      const urlResult = reference.sourceKey === "de-bverfg" || reference.sourceKey === "us-scotus"
        ? await baseQuery().ilike("original_url", `%${urlToken}%`).limit(EXACT_CASE_LOOKUP_LIMIT)
        : { data: [], error: null };

      for (const result of [metadataResult, urlResult]) {
        if (result.error || !Array.isArray(result.data)) continue;
        for (const row of result.data as Array<{ id?: string }>) {
          if (row.id && !ids.includes(row.id)) ids.push(row.id);
        }
      }
    }

    return ids;
  }

  return {
    isConfigured,
    rankedSearchPageRpc,
    catalogCaseSearchRpc,
    fullTextRankedIdsRpc,
    vectorMatchRpc,
    findSemanticEmbeddingRows,
    findExactCaseArticleIds,
  };
}
