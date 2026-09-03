import { caseCatalogSearchEnabled } from "@/lib/case-catalog/flags";
import { getSupabaseAdmin } from "@/lib/db/client";
import { listArticles } from "@/lib/db/queries";
import type { ArticleListFilters, ArticleListResult } from "@/lib/db/types";

type CatalogSearchEntry = {
  id?: unknown;
};

type CatalogSearchPayload = {
  entries?: unknown;
  retrievalMode?: unknown;
  rankingVersion?: unknown;
  nextCursor?: unknown;
  total?: unknown;
  hasMore?: unknown;
  totalIsExact?: unknown;
};

export type CatalogSearchOptions = {
  environment?: Record<string, string | undefined>;
};

function nonNegativeInteger(value: unknown) {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function parseIds(value: unknown) {
  if (!Array.isArray(value)) throw new Error("case_catalog.search_entries_invalid");
  const ids: string[] = [];
  for (const entry of value as CatalogSearchEntry[]) {
    if (!entry || typeof entry !== "object" || typeof entry.id !== "string" || !entry.id) {
      throw new Error("case_catalog.search_entry_invalid");
    }
    if (!ids.includes(entry.id)) ids.push(entry.id);
  }
  return ids;
}

export async function catalogCaseSearch(
  filters: ArticleListFilters,
  options: CatalogSearchOptions = {},
): Promise<ArticleListResult> {
  if (!caseCatalogSearchEnabled(options.environment ?? process.env)) {
    throw new Error("case_catalog.search_disabled");
  }

  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 20;
  if (page > 1 && !filters.cursor) throw new Error("case_catalog.search_cursor_required");

  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("case_catalog.search_database_unavailable");
  const { data, error } = await supabase.rpc("worldcons_case_search_page_v2", {
    p_query: filters.q ?? "",
    p_limit: pageSize,
    p_cursor: filters.cursor ?? null,
    p_source: filters.source ?? null,
    p_jurisdiction: filters.jurisdiction ?? null,
    p_content_type: filters.type ?? null,
    p_language: filters.language ?? null,
    p_tag: filters.tag ?? null,
    p_range: filters.range ?? "latest",
  });
  if (error) throw new Error(`case_catalog.search_failed:${error.code ?? "unknown"}`);
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("case_catalog.search_payload_invalid");

  const payload = data as CatalogSearchPayload;
  const ids = parseIds(payload.entries);
  const result = ids.length === 0
    ? { items: [], pageInfo: { page: 1, pageSize, total: 0 } }
    : await listArticles({
        ...filters,
        ids,
        q: undefined,
        cursor: undefined,
        page: 1,
        pageSize: ids.length,
        count: "none",
      });
  const byId = new Map(result.items.map((item) => [item.id ?? "", item]));
  const items = ids.map((id) => byId.get(id)).filter((item): item is NonNullable<typeof item> => Boolean(item));
  if (items.length !== ids.length) throw new Error("case_catalog.search_materialization_mismatch");

  const hasMore = payload.hasMore === true;
  const nextCursor = payload.nextCursor === null || payload.nextCursor === undefined
    ? null
    : typeof payload.nextCursor === "string" && payload.nextCursor
      ? payload.nextCursor
      : null;
  if (hasMore && !nextCursor) throw new Error("case_catalog.search_cursor_missing");

  return {
    items,
    pageInfo: {
      page,
      pageSize,
      total: nonNegativeInteger(payload.total) ?? items.length + (hasMore ? 1 : 0),
      hasMore,
      totalIsExact: payload.totalIsExact === true,
      nextCursor,
    },
    retrievalMode: typeof payload.retrievalMode === "string" ? payload.retrievalMode : "lexical",
    rankingVersion: typeof payload.rankingVersion === "string" ? payload.rankingVersion : "gate3-exact-lexical-v1",
  };
}
