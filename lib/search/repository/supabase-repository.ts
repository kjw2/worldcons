import type { SupabaseClient } from "@supabase/supabase-js";
import { publicArticleRelation, publicProjectionReadsEnabled } from "@/lib/article-publication";
import type {
  ExactCaseArticleIdRequest,
  RankedSearchPageRpcRequest,
  SearchRepository,
} from "@/lib/search/repository/types";

const RANKED_SEARCH_PAGE_RPC = "worldcons_ranked_search_page_v1";
const EXACT_CASE_LOOKUP_LIMIT = 100;

export interface SupabaseSearchDependencies {
  /** Resolves the admin client. Resolved once by the selection point. */
  client: () => SupabaseClient;
  environment?: Record<string, string | undefined>;
}

/**
 * Supabase-backed search data access. This is the authoritative M4
 * implementation: it preserves the exact pre-extraction RPC call and the
 * exact-case lookup semantics, including the public relation/projection choice,
 * the legacy publishable filter, the indexed `case_key` lookup, the
 * metadata/`original_url` rollout fallback, and the per-reference id order and
 * dedupe.
 */
export function createSupabaseSearchRepository(
  dependencies: SupabaseSearchDependencies,
): SearchRepository {
  const client = dependencies.client;
  const environment = dependencies.environment ?? process.env;

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

  return { rankedSearchPageRpc, findExactCaseArticleIds };
}
