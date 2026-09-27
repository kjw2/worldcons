import type { CclMetasearchSearchInput, CclMetasearchSearchPage } from "@/lib/cclmetasearch/contract";
import { mapCclMetasearchRow } from "@/lib/cclmetasearch/mapper";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getAppBaseUrl } from "@/lib/seo/metadata";

const DEFAULT_DATABASE_TIMEOUT_MS = 8_000;

export async function searchCclMetasearch(input: CclMetasearchSearchInput): Promise<CclMetasearchSearchPage> {
  return searchCclMetasearchWithEnv(input, {
    SUPABASE_URL: process.env.SUPABASE_URL ?? "",
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
    PUBLIC_SITE_BASE_URL: getAppBaseUrl(),
    CCL_METASEARCH_DB_TIMEOUT_MS: process.env.CCL_METASEARCH_DB_TIMEOUT_MS,
  });
}

export interface CclMetasearchSearchEnv {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  PUBLIC_SITE_BASE_URL: string;
  CCL_METASEARCH_DB_TIMEOUT_MS?: string;
}

export interface CclMetasearchSearchDependencies {
  createSupabaseClient?: (url: string, key: string) => SupabaseClient;
}

export async function searchCclMetasearchWithEnv(
  input: CclMetasearchSearchInput,
  env: CclMetasearchSearchEnv,
  dependencies: CclMetasearchSearchDependencies = {},
): Promise<CclMetasearchSearchPage> {
  const url = env.SUPABASE_URL.trim();
  const key = env.SUPABASE_SERVICE_ROLE_KEY.trim();
  if (!url || !key) {
    throw new Error("The WorldCons search database is not configured.");
  }
  const supabase = (dependencies.createSupabaseClient ?? defaultSupabaseClient)(url, key);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), databaseTimeoutMs(env.CCL_METASEARCH_DB_TIMEOUT_MS));

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

    const baseUrl = env.PUBLIC_SITE_BASE_URL.trim();
    if (!baseUrl) throw new Error("The WorldCons public base URL is not configured.");
    return {
      items: rawItems.map((item: unknown) => mapCclMetasearchRow(item, baseUrl)),
      total,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function defaultSupabaseClient(url: string, key: string) {
  return createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

function databaseTimeoutMs(value?: string) {
  const configured = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(configured)) return DEFAULT_DATABASE_TIMEOUT_MS;
  return Math.min(Math.max(configured, 1_000), 15_000);
}

function numericTotal(value: unknown) {
  const total = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isSafeInteger(total) && total >= 0 ? total : null;
}
