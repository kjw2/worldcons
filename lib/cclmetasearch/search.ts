import type { CclMetasearchSearchInput, CclMetasearchSearchPage } from "@/lib/cclmetasearch/contract";
import { mapCclMetasearchRow } from "@/lib/cclmetasearch/mapper";
import { getSupabaseServiceRoleAdmin } from "@/lib/db/client";
import { getAppBaseUrl } from "@/lib/seo/metadata";

const DEFAULT_DATABASE_TIMEOUT_MS = 8_000;

export async function searchCclMetasearch(input: CclMetasearchSearchInput): Promise<CclMetasearchSearchPage> {
  const supabase = getSupabaseServiceRoleAdmin();
  if (!supabase) {
    throw new Error("The WorldCons search database is not configured.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), databaseTimeoutMs());

  try {
    const { data, error } = await supabase
      .rpc("cclmetasearch_search_v1", {
        p_query: input.query,
        p_limit: input.limit,
        p_offset: input.offset,
        p_sort: input.sort,
      })
      .abortSignal(controller.signal);

    if (error) {
      throw new Error(`WorldCons search RPC failed (${error.code || "unknown"}).`);
    }

    const row = Array.isArray(data) ? data[0] : data;
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error("WorldCons search RPC returned no result row.");
    }

    const rawItems = Array.isArray(row.items) ? row.items : null;
    const total = numericTotal(row.total);
    if (!rawItems || total === null) {
      throw new Error("WorldCons search RPC returned a malformed result.");
    }

    const baseUrl = getAppBaseUrl();
    return {
      items: rawItems.map((item: unknown) => mapCclMetasearchRow(item, baseUrl)),
      total,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function databaseTimeoutMs() {
  const configured = Number.parseInt(process.env.CCL_METASEARCH_DB_TIMEOUT_MS ?? "", 10);
  if (!Number.isFinite(configured)) return DEFAULT_DATABASE_TIMEOUT_MS;
  return Math.min(Math.max(configured, 1_000), 15_000);
}

function numericTotal(value: unknown) {
  const total = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isSafeInteger(total) && total >= 0 ? total : null;
}
