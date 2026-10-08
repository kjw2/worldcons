import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  clearRuntimeD1Bindings,
  setRuntimeD1Bindings,
  type D1RuntimeDatabase,
  type D1RuntimePreparedStatement,
} from "../lib/cloudflare/d1/runtime-binding";
import { catalogCaseSearch } from "../lib/search/case-catalog";
import { exactCaseSearch } from "../lib/search/exact-case";
import { rankedSearchPage } from "../lib/search/ranked-page";
import { searchRepository } from "../lib/search/repository";
import { failClosedSearchRepository } from "../lib/search/repository/fail-closed-repository";
import { createSupabaseSearchRepository } from "../lib/search/repository/supabase-repository";

const ENV_KEYS = [
  "SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "ADMIN_PUBLICATION_V4_READ_ENABLED",
  "CASE_CATALOG_PUBLIC_ENABLED",
  "CASE_CATALOG_SEARCH_ENABLED",
] as const;

async function withSupabaseEnv<T>(
  values: Partial<Record<(typeof ENV_KEYS)[number], string>>,
  run: () => Promise<T> | T,
): Promise<T> {
  const original = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
  try {
    return await run();
  } finally {
    for (const key of ENV_KEYS) {
      const value = original.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

interface QueryInfo {
  table: string;
  select?: unknown[];
  eqs: Array<[string, unknown]>;
  filters: unknown[][];
  ilikes: Array<[string, string]>;
  nots: unknown[][];
  gtes: Array<[string, unknown]>;
  limits: unknown[];
}

interface SupabaseErrorEvidence {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
}

interface TableResult {
  data?: unknown;
  error?: SupabaseErrorEvidence | null;
}

function createFakeSupabase(options: {
  tables?: Record<string, (info: QueryInfo) => TableResult>;
  rpc?: (name: string, args: unknown) => { data?: unknown; error?: SupabaseErrorEvidence | null };
} = {}) {
  const tableCalls: QueryInfo[] = [];
  const rpcCalls: Array<{ name: string; args: unknown }> = [];

  const client = {
    from(table: string) {
      const info: QueryInfo = { table, eqs: [], filters: [], ilikes: [], nots: [], gtes: [], limits: [] };
      const builder: Record<string, unknown> = {};
      const resolve = (): TableResult => {
        tableCalls.push(info);
        const handler = options.tables?.[info.table];
        return handler ? handler(info) : { data: [], error: null };
      };
      builder.select = (...args: unknown[]) => { info.select = args; return builder; };
      builder.eq = (column: string, value: unknown) => { info.eqs.push([column, value]); return builder; };
      builder.filter = (...args: unknown[]) => { info.filters.push(args); return builder; };
      builder.ilike = (column: string, pattern: string) => { info.ilikes.push([column, pattern]); return builder; };
      builder.not = (...args: unknown[]) => { info.nots.push(args); return builder; };
      builder.gte = (column: string, value: unknown) => { info.gtes.push([column, value]); return builder; };
      builder.limit = (value: unknown) => { info.limits.push(value); return builder; };
      builder.then = (onFulfilled: (value: TableResult) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve(resolve()).then(onFulfilled, onRejected);
      return builder;
    },
    rpc(name: string, args: unknown) {
      rpcCalls.push({ name, args });
      return Promise.resolve(options.rpc ? options.rpc(name, args) : { data: null, error: null });
    },
  };

  return { client: client as unknown as SupabaseClient, tableCalls, rpcCalls };
}

const DEF_BVERFG = { sourceKey: "de-bverfg", caseNumber: "1 BvR 2656/18", caseKey: "1bvr265618" };

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

/**
 * A minimal D1 search binding for the exported search wrappers. The pubic
 * authority is `worldcons_search`; this fake returns an authored ranked page for
 * any `search_fts`/`search_documents` read and resolves exact-case lookups from
 * `search_documents`. It intentionally does not re-implement FTS5 ranking.
 */
function createFakeD1Search(options: {
  pageRows?: Array<{ article_id: string; score?: number }>;
  count?: number;
  exactIds?: string[];
} = {}) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  // The D1 ranked reader executes `search_fts`/`search_documents` SQL and
  // assembles the RPC payload; the fake returns the authored `article_id` rows.
  const pageRows = options.pageRows ?? [{ article_id: "a" }];
  const database: D1RuntimeDatabase = {
    prepare(sql: string): D1RuntimePreparedStatement {
      let params: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) {
          params = values;
          return statement;
        },
        async all<T = Record<string, unknown>>() {
          calls.push({ sql, params });
          const normalized = sql.toLowerCase();
          if (normalized.includes("count(*)")) return { success: true, results: [{ total: options.count ?? pageRows.length } as unknown as T] };
          // The exact-case lookup is a `search_documents` read guarded by the
          // `instr(char(10) || case_numbers ...)` line-token predicate.
          if (normalized.includes("from search_documents") && normalized.includes("instr(char(10)")) {
            return {
              success: true,
              results: (options.exactIds ?? []).map((id) => ({ article_id: id }) as unknown as T),
            };
          }
          return { success: true, results: pageRows as unknown as T[] };
        },
      };
      return statement;
    },
  };
  return { database, calls };
}

async function withD1Search<T>(search: D1RuntimeDatabase, run: () => Promise<T> | T): Promise<T> {
  setRuntimeD1Bindings({ worldcons_search: search, worldcons_core: search });
  try {
    return await run();
  } finally {
    clearRuntimeD1Bindings();
  }
}

const IDENT = "[a-z_][a-z0-9_]*";

function evaluateRead(sql: string, params: unknown[], tables: Record<string, Record<string, unknown>[]>) {
  const fromMatch = new RegExp(` from (${IDENT})`).exec(sql);
  const table = fromMatch?.[1] ?? "";
  let rows = (tables[table] ?? []).map((row) => ({ ...row }));
  let p = 0;
  const whereMatch = new RegExp(` where (.*?)(?= order by | limit | offset |$)`).exec(sql);
  if (whereMatch) {
    for (const predicate of whereMatch[1].split(" and ")) {
      const inMatch = new RegExp(`^(${IDENT}) in \\(([?](, \\?)*)\\)$`).exec(predicate);
      const cmpMatch = new RegExp(`^(${IDENT}) (=|>=|!=) \\?$`).exec(predicate);
      if (inMatch) {
        const values = params.slice(p, p + inMatch[2].split(",").length);
        p += values.length;
        rows = rows.filter((row) => values.includes(row[inMatch[1]]));
      } else if (cmpMatch) {
        const value = params[p];
        p += 1;
        rows = rows.filter((row) => {
          if (cmpMatch[2] === "=") return row[cmpMatch[1]] === value;
          if (cmpMatch[2] === "!=") return row[cmpMatch[1]] !== value;
          return row[cmpMatch[1]] != null && String(row[cmpMatch[1]]) >= String(value);
        });
      }
    }
  }
  const limit = / limit \?/.test(sql) ? Number(params[p++]) : undefined;
  if (limit !== undefined) rows = rows.slice(0, limit);
  return { table, rows };
}

/**
 * A D1 authority fake for the exported `exactCaseSearch` path: it resolves the
 * per-reference `search_documents` exact-case probes by source key, serves the
 * materialization reads from a supplied article corpus, and synthesizes the
 * published P3 gate row for each article.
 */
function createFakeD1ExactCase(options: {
  exactIdsBySource?: Record<string, string[]>;
  articles?: Record<string, unknown>[];
} = {}) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const articles: Record<string, unknown>[] = (options.articles ?? []).map((row) => ({
    source_metadata: { collection: { publishable: true } },
    catalog_ai_stale_v4: 0,
    ...row,
  }));
  const tables: Record<string, Record<string, unknown>[]> = {
    articles,
    article_publications_p3: articles.map((row) => ({
      article_id: row.id,
      version_id: `version-${row.id}`,
      state: "published",
    })),
    article_tags: [],
    tags: [],
    article_view_counts: [],
  };
  const database: D1RuntimeDatabase = {
    prepare(sql: string): D1RuntimePreparedStatement {
      let params: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) {
          params = values;
          return statement;
        },
        async all<T = Record<string, unknown>>() {
          calls.push({ sql, params });
          const normalized = sql.toLowerCase();
          if (normalized.includes("from search_documents")) {
            const sourceKey = typeof params[0] === "string" ? params[0] : "";
            return {
              success: true,
              results: (options.exactIdsBySource?.[sourceKey] ?? []).map((id) => ({ article_id: id }) as unknown as T),
            };
          }
          const { rows } = evaluateRead(sql, params, tables);
          return { success: true, results: rows as unknown as T[] };
        },
      };
      return statement;
    },
  };
  return { database, calls };
}


async function withFetch<T>(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
  run: () => Promise<T>,
): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init)) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function listRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    slug: id,
    source_key: "de-bverfg",
    jurisdiction: "Germany",
    institution_name: "BVerfG",
    content_type: "order",
    original_url: `https://example.test/${id}`,
    canonical_url: `https://example.test/${id}`,
    original_language: "de",
    original_title: "Original Title",
    korean_title: "한국어 제목",
    original_published_at: "2026-04-29T00:00:00.000Z",
    status: "summarized",
    one_line_summary: null,
    article_tags: [],
    ...overrides,
  };
}

test("searchRepository selects the fail-closed adapter without Supabase config", async () => {
  await withSupabaseEnv({}, async () => {
    assert.equal(searchRepository(), failClosedSearchRepository, "absent config must select the fail-closed adapter");
    assert.equal(searchRepository().isConfigured(), false, "the fail-closed adapter must report no config");
    assert.equal(await searchRepository().rankedSearchPageRpc({ ...request(), mode: "fulltext" }), null);
    assert.deepEqual(await searchRepository().findExactCaseArticleIds({ references: [DEF_BVERFG] }), []);
    assert.deepEqual(await searchRepository().catalogCaseSearchRpc(catalogRequest()), { status: "unavailable" });
    assert.equal(await searchRepository().fullTextRankedIdsRpc(fullTextRequest()), null);
    assert.equal(await searchRepository().vectorMatchRpc(vectorRequest()), null);
    assert.equal(await searchRepository().findSemanticEmbeddingRows(embeddingRequest()), null);
    assert.deepEqual(
      await exactCaseSearch({ q: "1 BvR 2656/18" }),
      { items: [], pageInfo: { page: 1, pageSize: 20, total: 0, hasMore: false, totalIsExact: true } },
      "the exported exact-case search must stay empty without config",
    );
  });

  await withSupabaseEnv({ ADMIN_PUBLICATION_V4_READ_ENABLED: "true" }, async () => {
    assert.equal(
      await rankedSearchPage({ q: "표현 자유" }, "fulltext", null),
      null,
      "the ranked page must fail closed without a database even when projection reads are enabled",
    );
  });
});

test("searchRepository ignores legacy Supabase config and selects the D1 adapter only with bindings", async () => {
  await withFetch(
    (url) => (url.includes("/rest/v1/rpc/worldcons_ranked_search_page_v1") ? jsonResponse({ entries: [] }) : jsonResponse([])),
    async () => {
      await withSupabaseEnv(
        { SUPABASE_URL: "https://search.test.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-role-key", ADMIN_PUBLICATION_V4_READ_ENABLED: "true" },
        async () => {
          const repository = searchRepository();
          assert.equal(repository, failClosedSearchRepository, "legacy Supabase config must not select a search adapter");
          assert.equal(repository.isConfigured(), false, "without D1 bindings the repository stays unconfigured");
        },
      );
    },
  );

  const d1 = createFakeD1Search({ pageRows: [{ article_id: "a" }] });
  await withD1Search(d1.database, async () => {
    const repository = searchRepository();
    assert.notEqual(repository, failClosedSearchRepository, "with D1 bindings the D1 search adapter is selected");
    assert.equal(repository.isConfigured(), true);
    const payload = await repository.rankedSearchPageRpc(request()) as { entries: Array<{ id: string }> };
    assert.deepEqual(payload.entries.map((entry) => entry.id), ["a"]);
  });
});

function request() {
  return {
    query: "",
    mode: "fulltext" as const,
    embedding: null,
    limit: 20,
    offset: 0,
    source: null,
    jurisdiction: null,
    contentType: null,
    language: null,
    tag: null,
    range: "latest",
    count: "none",
  };
}

function catalogRequest() {
  return {
    query: "",
    limit: 20,
    cursor: null,
    source: null,
    jurisdiction: null,
    contentType: null,
    language: null,
    tag: null,
    range: "latest",
  };
}

function fullTextRequest() {
  return {
    query: "표현 자유",
    limit: 20,
    source: null,
    jurisdiction: null,
    contentType: null,
    language: null,
    range: "latest",
  };
}

function vectorRequest() {
  return {
    embedding: [0.1, 0.2],
    matchCount: 20,
    source: null,
    jurisdiction: null,
    contentType: null,
    language: null,
  };
}

function embeddingRequest() {
  return {
    matchCount: 20,
    source: null,
    jurisdiction: null,
    contentType: null,
    language: null,
    range: "latest" as const,
  };
}

test("Supabase search adapter issues the ranked page RPC with the exact arguments", async () => {
  const fake = createFakeSupabase({ rpc: () => ({ data: { entries: [{ id: "a" }] }, error: null }) });
  const repository = createSupabaseSearchRepository({ client: () => fake.client, environment: {} });

  const payload = await repository.rankedSearchPageRpc({
    query: "표현 자유",
    mode: "semantic",
    embedding: [0.1, 0.2],
    limit: 25,
    offset: 50,
    source: "de-bverfg",
    jurisdiction: "Germany",
    contentType: "order",
    language: "de",
    tag: "qpc",
    range: "week",
    count: "exact",
  });

  assert.deepEqual(payload, { entries: [{ id: "a" }] });
  assert.deepEqual(fake.rpcCalls, [{
    name: "worldcons_ranked_search_page_v1",
    args: {
      p_query: "표현 자유",
      p_mode: "semantic",
      p_query_embedding: [0.1, 0.2],
      p_limit: 25,
      p_offset: 50,
      p_source: "de-bverfg",
      p_jurisdiction: "Germany",
      p_content_type: "order",
      p_language: "de",
      p_tag: "qpc",
      p_range: "week",
      p_count: "exact",
    },
  }]);

  const failing = createFakeSupabase({ rpc: () => ({ data: null, error: { message: "rpc unavailable" } }) });
  const failingRepository = createSupabaseSearchRepository({ client: () => failing.client, environment: {} });
  assert.equal(await failingRepository.rankedSearchPageRpc(request()), null, "an RPC error must resolve to null");
});

test("rankedSearchPage gates on projection, unpublished reads, and the 10k offset guard", async () => {
  await withSupabaseEnv({}, async () => {
    assert.equal(await rankedSearchPage({ q: "표현 자유" }, "fulltext", null), null, "projection-disabled reads must not reach the search authority");
  });

  await withSupabaseEnv({ ADMIN_PUBLICATION_V4_READ_ENABLED: "true" }, async () => {
    assert.equal(await rankedSearchPage({ q: "표현 자유", includeUnpublished: true }, "fulltext", null), null, "unpublished reads must not use the ranked page");
  });

  const d1 = createFakeD1Search({ pageRows: [{ article_id: "a", score: 1 }] });
  await withD1Search(d1.database, async () => {
    await withSupabaseEnv(
      { ADMIN_PUBLICATION_V4_READ_ENABLED: "true" },
      async () => {
        const before = d1.calls.length;
        assert.equal(await rankedSearchPage({ q: "표현 자유", page: 502, pageSize: 20 }, "fulltext", null), null, "offset over 10k must be rejected before the query");
        assert.equal(d1.calls.length, before, "the offset guard must short-circuit before the database call");
        assert.notEqual(await rankedSearchPage({ q: "표현 자유", page: 501, pageSize: 20 }, "fulltext", null), null, "offset exactly 10k must still query");
        assert.ok(d1.calls.length > before);
      },
    );
  });
});

test("rankedSearchPage parses the D1 ranked payload and applies the page-info lower bound", async () => {
  const d1 = createFakeD1Search({
    pageRows: [{ article_id: "a", score: 1 }, { article_id: "b", score: 2 }, { article_id: "c", score: 3 }],
  });
  await withD1Search(d1.database, async () => {
    await withSupabaseEnv(
      { ADMIN_PUBLICATION_V4_READ_ENABLED: "true" },
      async () => {
        const page = await rankedSearchPage({ q: "표현 자유", page: 1, pageSize: 2 }, "fulltext", null);
        assert.deepEqual(page?.ids, ["a", "b"], "the +1 window must be trimmed to the requested page size");
        assert.equal(page?.retrievalMode, "fulltext");
        assert.deepEqual(page?.pageInfo, { page: 1, pageSize: 2, total: 3, hasMore: true, totalIsExact: false }, "total must be bounded below by offset + ids + hasMore");
      },
    );
  });
});

test("rankedSearchPage returns null when the search binding is absent", async () => {
  await withSupabaseEnv(
    { ADMIN_PUBLICATION_V4_READ_ENABLED: "true" },
    async () => {
      assert.equal(await rankedSearchPage({ q: "표현 자유" }, "fulltext", null), null, "no D1 search binding must fail closed");
    },
  );
});

test("Supabase search adapter preserves the indexed exact-case lookup, order, dedupe, and filters", async () => {
  const fake = createFakeSupabase({
    tables: {
      articles: (info) => (info.eqs.some(([column]) => column === "case_key")
        ? { data: [{ id: "a" }, { id: "b" }, { id: "a" }], error: null }
        : { data: [], error: null }),
    },
  });
  const repository = createSupabaseSearchRepository({ client: () => fake.client, environment: {} });

  const ids = await repository.findExactCaseArticleIds({
    references: [DEF_BVERFG],
    jurisdiction: "Germany",
    type: "order",
    language: "de",
  });

  assert.deepEqual(ids, ["a", "b"], "indexed ids must keep order and drop duplicates");
  assert.deepEqual(fake.tableCalls.map((call) => call.table), ["articles"]);
  const call = fake.tableCalls[0];
  assert.deepEqual(call.select, ["id"]);
  assert.deepEqual(call.eqs, [
    ["source_key", "de-bverfg"],
    ["status", "summarized"],
    ["jurisdiction", "Germany"],
    ["content_type", "order"],
    ["original_language", "de"],
    ["case_key", "1bvr265618"],
  ]);
  assert.deepEqual(call.filters, [["source_metadata->collection->>publishable", "eq", "true"]]);
  assert.deepEqual(call.limits, [100]);
  assert.deepEqual(call.ilikes, [], "a successful indexed lookup must not run the rollout fallback");
});

test("Supabase search adapter selects the projection relation and drops the legacy filter", async () => {
  const fake = createFakeSupabase({
    tables: { public_article_projection_p3: () => ({ data: [{ id: "p1" }], error: null }) },
  });
  const repository = createSupabaseSearchRepository({
    client: () => fake.client,
    environment: { ADMIN_PUBLICATION_V4_READ_ENABLED: "true" },
  });

  assert.deepEqual(await repository.findExactCaseArticleIds({ references: [DEF_BVERFG] }), ["p1"]);
  assert.deepEqual(fake.tableCalls.map((call) => call.table), ["public_article_projection_p3"]);
  assert.deepEqual(fake.tableCalls[0].eqs, [["source_key", "de-bverfg"], ["case_key", "1bvr265618"]]);
  assert.equal(fake.tableCalls[0].filters.length, 0, "projected reads must not apply the legacy published filter");
});

test("Supabase search adapter falls back to metadata and original_url when the indexed query errors", async () => {
  const fake = createFakeSupabase({
    tables: {
      articles: (info) => {
        if (info.eqs.some(([column]) => column === "case_key")) {
          return { data: null, error: { message: "column case_key does not exist" } };
        }
        if (info.ilikes.some(([column]) => column === "source_metadata->>caseNumber")) return { data: [{ id: "meta-1" }], error: null };
        if (info.ilikes.some(([column]) => column === "original_url")) return { data: [{ id: "url-1" }], error: null };
        return { data: [], error: null };
      },
    },
  });
  const repository = createSupabaseSearchRepository({ client: () => fake.client, environment: {} });

  const ids = await repository.findExactCaseArticleIds({ references: [DEF_BVERFG] });

  assert.deepEqual(ids, ["meta-1", "url-1"], "the fallback must run metadata then url and keep order/dedupe");
  const metadataCall = fake.tableCalls.find((call) => call.ilikes.some(([column]) => column === "source_metadata->>caseNumber"));
  assert.deepEqual(metadataCall?.ilikes, [["source_metadata->>caseNumber", "%1 BvR 2656/18%"]]);
  const urlCall = fake.tableCalls.find((call) => call.ilikes.some(([column]) => column === "original_url"));
  assert.deepEqual(urlCall?.ilikes, [["original_url", "%1bvr265618%"]], "de-bverfg must search original_url by caseKey");
});

test("Supabase search adapter builds the url fallback token per source and skips it for others", async () => {
  const build = () => createFakeSupabase({
    tables: {
      articles: (info) => {
        if (info.eqs.some(([column]) => column === "case_key")) return { data: null, error: { message: "missing" } };
        if (info.ilikes.some(([column]) => column === "source_metadata->>caseNumber")) return { data: [], error: null };
        if (info.ilikes.some(([column]) => column === "original_url")) return { data: [{ id: "url" }], error: null };
        return { data: [], error: null };
      },
    },
  });

  const usFake = build();
  const usRepository = createSupabaseSearchRepository({ client: () => usFake.client, environment: {} });
  assert.deepEqual(
    await usRepository.findExactCaseArticleIds({ references: [{ sourceKey: "us-scotus", caseNumber: "24-109", caseKey: "24109" }] }),
    ["url"],
  );
  const usUrlCall = usFake.tableCalls.find((call) => call.ilikes.some(([column]) => column === "original_url"));
  assert.deepEqual(usUrlCall?.ilikes, [["original_url", "%24-109%"]], "us-scotus must search original_url by caseNumber");

  const frFake = build();
  const frRepository = createSupabaseSearchRepository({ client: () => frFake.client, environment: {} });
  assert.deepEqual(
    await frRepository.findExactCaseArticleIds({ references: [{ sourceKey: "fr-conseil-constitutionnel", caseNumber: "2024-1115 QPC", caseKey: "20241115qpc" }] }),
    [],
  );
  assert.equal(
    frFake.tableCalls.some((call) => call.ilikes.some(([column]) => column === "original_url")),
    false,
    "sources other than de-bverfg/us-scotus must not run the original_url fallback",
  );
});

test("exported exactCaseSearch materializes indexed ids in reference order and slices the page", async () => {
  const d1 = createFakeD1ExactCase({
    exactIdsBySource: { "de-bverfg": ["a", "b"] },
    articles: [listRow("a"), listRow("b", { original_published_at: "2026-04-28T00:00:00.000Z" })],
  });
  await withD1Search(d1.database, async () => {
    const result = await exactCaseSearch({ q: "1 BvR 2656/18", source: "de-bverfg", page: 1, pageSize: 1 });
    assert.deepEqual(result.items.map((item) => item.id), ["a"], "the page slice must follow the reference id order");
    assert.deepEqual(result.pageInfo, { page: 1, pageSize: 1, total: 2, hasMore: true, totalIsExact: true });
  });
});

test("exported exactCaseSearch keeps reference order and dedupe across sources", async () => {
  const d1 = createFakeD1ExactCase({
    exactIdsBySource: {
      "de-bverfg": ["shared"],
      "fr-conseil-constitutionnel": ["shared", "fr"],
    },
    articles: [listRow("shared"), listRow("fr")],
  });
  await withD1Search(d1.database, async () => {
    const result = await exactCaseSearch({ q: "1 BvR 2656/18 2024-1115 QPC" });
    assert.deepEqual(result.items.map((item) => item.id), ["shared", "fr"], "ids must follow reference order with cross-reference dedupe");
    assert.equal(result.pageInfo.total, 2);
  });
});

test("exported exactCaseSearch returns an empty page without a query or a case reference", async () => {
  await withSupabaseEnv({}, async () => {
    assert.deepEqual(await exactCaseSearch({}), {
      items: [],
      pageInfo: { page: 1, pageSize: 20, total: 0, hasMore: false, totalIsExact: true },
    });
    assert.deepEqual(await exactCaseSearch({ q: "표현 자유" }), {
      items: [],
      pageInfo: { page: 1, pageSize: 20, total: 0, hasMore: false, totalIsExact: true },
    });
  });
});

test("Supabase search adapter issues the catalog RPC with exact arguments and error evidence", async () => {
  const ok = createFakeSupabase({ rpc: () => ({ data: { schemaVersion: 2 }, error: null }) });
  const repository = createSupabaseSearchRepository({ client: () => ok.client, environment: {} });

  assert.deepEqual(
    await repository.catalogCaseSearchRpc({
      query: "표현 자유",
      limit: 20,
      cursor: "abc",
      source: "de-bverfg",
      jurisdiction: "Germany",
      contentType: "order",
      language: "de",
      tag: "qpc",
      range: "week",
    }),
    { status: "ok", data: { schemaVersion: 2 } },
  );
  assert.deepEqual(ok.rpcCalls, [{
    name: "worldcons_case_search_page_v2",
    args: {
      p_query: "표현 자유",
      p_limit: 20,
      p_cursor: "abc",
      p_source: "de-bverfg",
      p_jurisdiction: "Germany",
      p_content_type: "order",
      p_language: "de",
      p_tag: "qpc",
      p_range: "week",
    },
  }]);

  const failing = createFakeSupabase({
    rpc: () => ({ data: null, error: { code: "22023", message: "cursor", details: "d", hint: "h" } }),
  });
  const failingRepository = createSupabaseSearchRepository({ client: () => failing.client, environment: {} });
  assert.deepEqual(
    await failingRepository.catalogCaseSearchRpc(catalogRequest()),
    { status: "error", error: { code: "22023", message: "cursor", details: "d", hint: "h" } },
    "the adapter must surface raw error evidence so the caller keeps its cursor parsing",
  );
});

test("catalogCaseSearch public wrapper stays disabled after the Cloudflare cutover", async () => {
  await withSupabaseEnv(
    { CASE_CATALOG_SEARCH_ENABLED: "true", CASE_CATALOG_PUBLIC_ENABLED: "true", ADMIN_PUBLICATION_V4_READ_ENABLED: "true" },
    async () => {
      await assert.rejects(
        () => catalogCaseSearch({ q: "표현", pageSize: 20 }),
        /case_catalog\.search_disabled/,
        "the public catalog wrapper is hard-disabled; the D1-native path is covered by tests/d1-case-catalog-visibility.test.ts",
      );
    },
  );

  const d1 = createFakeD1Search({ pageRows: [] });
  await withD1Search(d1.database, async () => {
    await assert.rejects(
      () => catalogCaseSearch({ q: "표현", pageSize: 20, cursor: "opaque" }),
      /case_catalog\.search_disabled/,
      "D1 bindings alone may not re-enable the public catalog wrapper",
    );
  });
});

test("Supabase search adapter issues the full-text ranked-ids RPC with exact arguments", async () => {
  const fake = createFakeSupabase({ rpc: () => ({ data: [{ article_id: "a", relevance_score: 1 }], error: null }) });
  const repository = createSupabaseSearchRepository({ client: () => fake.client, environment: {} });

  assert.deepEqual(
    await repository.fullTextRankedIdsRpc({
      query: "표현 자유",
      limit: 25,
      source: "de-bverfg",
      jurisdiction: "Germany",
      contentType: "order",
      language: "de",
      range: "week",
    }),
    [{ article_id: "a", relevance_score: 1 }],
  );
  assert.deepEqual(fake.rpcCalls, [{
    name: "public_fulltext_ranked_ids_v1",
    args: {
      p_query: "표현 자유",
      p_limit: 25,
      p_source: "de-bverfg",
      p_jurisdiction: "Germany",
      p_content_type: "order",
      p_language: "de",
      p_range: "week",
    },
  }]);

  const failing = createFakeSupabase({ rpc: () => ({ data: null, error: { message: "down" } }) });
  assert.equal(
    await createSupabaseSearchRepository({ client: () => failing.client, environment: {} }).fullTextRankedIdsRpc(fullTextRequest()),
    null,
    "an RPC error must resolve to null so the caller falls back to listArticles",
  );
  const nonArray = createFakeSupabase({ rpc: () => ({ data: { not: "array" }, error: null }) });
  assert.equal(
    await createSupabaseSearchRepository({ client: () => nonArray.client, environment: {} }).fullTextRankedIdsRpc(fullTextRequest()),
    null,
    "a non-array payload must resolve to null",
  );
});

test("Supabase search adapter selects and calls the semantic vector-match RPC", async () => {
  const projection = createFakeSupabase({ rpc: () => ({ data: [{ article_id: "a", similarity: 0.9 }], error: null }) });
  const projectionRepository = createSupabaseSearchRepository({
    client: () => projection.client,
    environment: { ADMIN_PUBLICATION_V4_READ_ENABLED: "true" },
  });

  assert.deepEqual(
    await projectionRepository.vectorMatchRpc({
      embedding: [0.1, 0.2],
      matchCount: 60,
      source: "de-bverfg",
      jurisdiction: "Germany",
      contentType: "order",
      language: "de",
    }),
    [{ article_id: "a", similarity: 0.9 }],
  );
  assert.deepEqual(projection.rpcCalls, [{
    name: "match_public_article_versions_p3",
    args: {
      query_embedding: [0.1, 0.2],
      match_count: 60,
      source_filter: "de-bverfg",
      jurisdiction_filter: "Germany",
      content_type_filter: "order",
      language_filter: "de",
    },
  }]);

  const legacy = createFakeSupabase({ rpc: () => ({ data: [], error: null }) });
  await createSupabaseSearchRepository({ client: () => legacy.client, environment: {} }).vectorMatchRpc(vectorRequest());
  assert.equal(legacy.rpcCalls[0].name, "match_articles", "legacy reads must keep the match_articles RPC");

  const failing = createFakeSupabase({ rpc: () => ({ data: null, error: { message: "down" } }) });
  assert.equal(
    await createSupabaseSearchRepository({ client: () => failing.client, environment: {} }).vectorMatchRpc(vectorRequest()),
    null,
    "a vector RPC error must resolve to null so the caller runs the local fallback",
  );
});

test("Supabase search adapter reads public embedding rows with relation, filters, range, and limit", async () => {
  const legacy = createFakeSupabase({
    tables: { articles: () => ({ data: [{ id: "a", embedding: "[0.1,0.2]" }], error: null }) },
  });
  const legacyRepository = createSupabaseSearchRepository({ client: () => legacy.client, environment: {} });

  assert.deepEqual(
    await legacyRepository.findSemanticEmbeddingRows({
      matchCount: 30,
      source: "de-bverfg",
      jurisdiction: "Germany",
      contentType: "order",
      language: "de",
      range: "latest",
    }),
    [{ id: "a", embedding: "[0.1,0.2]" }],
  );
  const call = legacy.tableCalls[0];
  assert.equal(call.table, "articles");
  assert.deepEqual(call.select, ["id, embedding"]);
  assert.deepEqual(call.nots, [["embedding", "is", null]]);
  assert.deepEqual(call.eqs, [
    ["status", "summarized"],
    ["source_key", "de-bverfg"],
    ["jurisdiction", "Germany"],
    ["content_type", "order"],
    ["original_language", "de"],
  ]);
  assert.deepEqual(call.filters, [["source_metadata->collection->>publishable", "eq", "true"]]);
  assert.deepEqual(call.limits, [100], "the read limit must be at least 100");
  assert.deepEqual(call.gtes, [], "the latest range must not add a date floor");

  const projected = createFakeSupabase({
    tables: { public_article_projection_p3: () => ({ data: [], error: null }) },
  });
  await createSupabaseSearchRepository({
    client: () => projected.client,
    environment: { ADMIN_PUBLICATION_V4_READ_ENABLED: "true" },
  }).findSemanticEmbeddingRows({
    matchCount: 200,
    source: null,
    jurisdiction: null,
    contentType: null,
    language: null,
    range: "month",
  });
  const projectedCall = projected.tableCalls[0];
  assert.equal(projectedCall.table, "public_article_projection_p3");
  assert.equal(projectedCall.filters.length, 0, "projected reads must not apply the legacy publishable filter");
  assert.deepEqual(projectedCall.limits, [200], "an explicit matchCount above 100 must survive");
  assert.equal(projectedCall.gtes.length, 1);
  assert.equal(projectedCall.gtes[0][0], "original_published_at");
  assert.match(String(projectedCall.gtes[0][1]), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, "the range floor must be an ISO timestamp");

  const failing = createFakeSupabase({
    tables: { articles: () => ({ data: null, error: { message: "down" } }) },
  });
  assert.equal(
    await createSupabaseSearchRepository({ client: () => failing.client, environment: {} }).findSemanticEmbeddingRows(embeddingRequest()),
    null,
    "an embedding read error must resolve to null so the caller falls back to listArticles",
  );
});

test("case-catalog and vector keep zero direct Supabase coupling", () => {
  for (const relative of ["lib/search/case-catalog.ts", "lib/search/vector.ts"]) {
    const source = fs.readFileSync(path.join(process.cwd(), relative), "utf8");
    assert.doesNotMatch(source, /getSupabaseAdmin/, `${relative} must not resolve the admin client directly`);
    assert.doesNotMatch(
      source.replace(/Array\.from\(/g, ""),
      /\.from\(/,
      `${relative} must not build Supabase table queries directly`,
    );
    assert.doesNotMatch(source, /\.rpc\(/, `${relative} must not call Supabase RPCs directly`);
  }
});
