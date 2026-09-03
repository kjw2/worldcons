import { caseCatalogSearchEnabled } from "@/lib/case-catalog/flags";
import { getSupabaseAdmin } from "@/lib/db/client";
import { listArticles } from "@/lib/db/queries";
import type { ArticleListFilters, ArticleListResult } from "@/lib/db/types";

type CatalogSearchEntry = {
  id?: unknown;
};

type CatalogSearchPayload = {
  schemaVersion?: unknown;
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

export type CatalogSearchCursorErrorReason = "expired" | "mismatch" | "invalid";

export class CatalogSearchCursorError extends Error {
  readonly reason: CatalogSearchCursorErrorReason;

  constructor(reason: CatalogSearchCursorErrorReason) {
    super(`case_catalog.search_cursor_${reason}`);
    this.name = "CatalogSearchCursorError";
    this.reason = reason;
  }
}

export function isCatalogSearchCursorError(error: unknown): error is CatalogSearchCursorError {
  return error instanceof CatalogSearchCursorError;
}

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
    if (ids.includes(entry.id)) throw new Error("case_catalog.search_entry_duplicate");
    ids.push(entry.id);
  }
  return ids;
}

function databaseCursorError(error: { code?: string; message?: string; details?: string; hint?: string }) {
  if (error.code !== "22023") return null;
  const evidence = [error.message,error.details,error.hint].filter(Boolean).join(" ");
  if (evidence.includes("WORLDCONS_CASE_SEARCH_CURSOR_RANKING_VERSION_EXPIRED")) {
    return new CatalogSearchCursorError("expired");
  }
  if (evidence.includes("WORLDCONS_CASE_SEARCH_CURSOR_MISMATCH") || evidence.includes("WORLDCONS_CASE_SEARCH_CURSOR_MODE_CHANGED")) {
    return new CatalogSearchCursorError("mismatch");
  }
  if (evidence.includes("WORLDCONS_CASE_SEARCH_INVALID_CURSOR")) {
    return new CatalogSearchCursorError("invalid");
  }
  return null;
}

function parseRetrievalMode(value: unknown) {
  if (value === "exact-identity" || value === "lexical" || value === "rrf" || value === "latest") return value;
  throw new Error("case_catalog.search_retrieval_mode_invalid");
}

function parseRankingVersion(value: unknown) {
  if (typeof value === "string" && value.length >= 3 && value.length <= 200 && /^[a-z0-9][a-z0-9._:-]+$/u.test(value)) {
    return value;
  }
  throw new Error("case_catalog.search_ranking_version_invalid");
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
  if (error) {
    const cursorError = databaseCursorError(error);
    if (cursorError) throw cursorError;
    throw new Error(`case_catalog.search_failed:${error.code ?? "unknown"}`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("case_catalog.search_payload_invalid");

  const payload = data as CatalogSearchPayload;
  if (payload.schemaVersion !== 2) throw new Error("case_catalog.search_schema_version_invalid");
  const retrievalMode = parseRetrievalMode(payload.retrievalMode);
  const rankingVersion = parseRankingVersion(payload.rankingVersion);
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

  if (typeof payload.hasMore !== "boolean" || typeof payload.totalIsExact !== "boolean") {
    throw new Error("case_catalog.search_page_info_invalid");
  }
  const hasMore = payload.hasMore;
  const nextCursor = payload.nextCursor === null || payload.nextCursor === undefined
    ? null
    : typeof payload.nextCursor === "string" && payload.nextCursor
      ? payload.nextCursor
      : null;
  if (hasMore && !nextCursor) throw new Error("case_catalog.search_cursor_missing");
  if (!hasMore && nextCursor) throw new Error("case_catalog.search_cursor_unexpected");

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
    retrievalMode,
    rankingVersion,
  };
}
