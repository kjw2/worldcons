import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { catalogCaseSearch, isCatalogSearchCursorError } from "../lib/search/case-catalog";
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

test("searchRepository selects the Supabase adapter when Supabase config is present", async () => {
  await withFetch(
    (url) => (url.includes("/rest/v1/rpc/worldcons_ranked_search_page_v1") ? jsonResponse({ entries: [] }) : jsonResponse([])),
    async () => {
      await withSupabaseEnv(
        { SUPABASE_URL: "https://search.test.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-role-key", ADMIN_PUBLICATION_V4_READ_ENABLED: "true" },
        async () => {
          const repository = searchRepository();
          assert.notEqual(repository, failClosedSearchRepository, "configured Supabase must select the Supabase adapter");
          assert.equal(repository.isConfigured(), true, "the Supabase adapter must report config");
          assert.deepEqual(await repository.rankedSearchPageRpc(request()), { entries: [] });
        },
      );
    },
  );
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
    assert.equal(await rankedSearchPage({ q: "표현 자유" }, "fulltext", null), null, "projection-disabled reads must not reach the RPC");
  });

  await withSupabaseEnv({ ADMIN_PUBLICATION_V4_READ_ENABLED: "true" }, async () => {
    assert.equal(await rankedSearchPage({ q: "표현 자유", includeUnpublished: true }, "fulltext", null), null, "unpublished reads must not use the ranked page");
  });

  let rpcRequests = 0;
  await withFetch((url) => {
    if (url.includes("/rest/v1/rpc/worldcons_ranked_search_page_v1")) {
      rpcRequests += 1;
      return jsonResponse({ entries: [], retrievalMode: "fulltext", total: 0, hasMore: false, totalIsExact: true });
    }
    return jsonResponse([]);
  }, async () => {
    await withSupabaseEnv(
      { SUPABASE_URL: "https://ranked-guard.test.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-role-key", ADMIN_PUBLICATION_V4_READ_ENABLED: "true" },
      async () => {
        assert.equal(await rankedSearchPage({ q: "표현 자유", page: 502, pageSize: 20 }, "fulltext", null), null, "offset over 10k must be rejected before the RPC");
        assert.equal(rpcRequests, 0, "the offset guard must short-circuit before the database call");
        assert.notEqual(await rankedSearchPage({ q: "표현 자유", page: 501, pageSize: 20 }, "fulltext", null), null, "offset exactly 10k must still query");
        assert.equal(rpcRequests, 1);
      },
    );
  });
});

test("rankedSearchPage parses the RPC payload and applies the page-info lower bound", async () => {
  await withFetch(
    () => jsonResponse({
      entries: [{ id: "a" }, { id: "b" }, { id: "" }, { nope: true }],
      retrievalMode: "hybrid",
      total: 1,
      hasMore: true,
      totalIsExact: false,
    }),
    async () => {
      await withSupabaseEnv(
        { SUPABASE_URL: "https://ranked-parse.test.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-role-key", ADMIN_PUBLICATION_V4_READ_ENABLED: "true" },
        async () => {
          const page = await rankedSearchPage({ q: "표현 자유", page: 1, pageSize: 2 }, "hybrid", null);
          assert.deepEqual(page?.ids, ["a", "b"], "only non-empty string ids must survive");
          assert.equal(page?.retrievalMode, "hybrid");
          assert.deepEqual(page?.pageInfo, { page: 1, pageSize: 2, total: 3, hasMore: true, totalIsExact: false }, "total must be bounded below by offset + ids + hasMore");
        },
      );
    },
  );
});

test("rankedSearchPage falls back to the requested mode and returns null on invalid payloads", async () => {
  let body: unknown = { entries: [{ id: "a" }] };
  await withFetch(() => jsonResponse(body), async () => {
    await withSupabaseEnv(
      { SUPABASE_URL: "https://ranked-invalid.test.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-role-key", ADMIN_PUBLICATION_V4_READ_ENABLED: "true" },
      async () => {
        const page = await rankedSearchPage({ q: "표현 자유" }, "fulltext", null);
        assert.equal(page?.retrievalMode, "fulltext", "a missing retrievalMode must fall back to the requested mode");

        body = [1, 2, 3];
        assert.equal(await rankedSearchPage({ q: "표현 자유" }, "fulltext", null), null, "an array payload must be rejected");
        body = "nope";
        assert.equal(await rankedSearchPage({ q: "표현 자유" }, "fulltext", null), null, "a non-object payload must be rejected");
        body = null;
        assert.equal(await rankedSearchPage({ q: "표현 자유" }, "fulltext", null), null, "an empty payload must be rejected");
      },
    );
  });
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
  await withFetch((url) => {
    if (url.includes("/rest/v1/article_view_counts")) return jsonResponse([]);
    if (url.includes("case_key")) return jsonResponse([{ id: "a" }, { id: "b" }]);
    if (url.includes("/rest/v1/articles")) return jsonResponse([listRow("b"), listRow("a")]);
    return jsonResponse([]);
  }, async () => {
    await withSupabaseEnv(
      { SUPABASE_URL: "https://exact-case.test.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-role-key" },
      async () => {
        const result = await exactCaseSearch({ q: "1 BvR 2656/18", source: "de-bverfg", page: 1, pageSize: 1 });
        assert.deepEqual(result.items.map((item) => item.id), ["a"], "the page slice must follow the reference id order");
        assert.deepEqual(result.pageInfo, { page: 1, pageSize: 1, total: 2, hasMore: true, totalIsExact: true });
      },
    );
  });
});

test("exported exactCaseSearch keeps reference order and dedupe across sources", async () => {
  await withFetch((url) => {
    if (url.includes("/rest/v1/article_view_counts")) return jsonResponse([]);
    if (url.includes("source_key=eq.de-bverfg")) return jsonResponse([{ id: "shared" }]);
    if (url.includes("source_key=eq.fr-conseil-constitutionnel")) return jsonResponse([{ id: "shared" }, { id: "fr" }]);
    if (url.includes("/rest/v1/articles")) return jsonResponse([listRow("fr"), listRow("shared")]);
    return jsonResponse([]);
  }, async () => {
    await withSupabaseEnv(
      { SUPABASE_URL: "https://exact-case-order.test.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-role-key" },
      async () => {
        const result = await exactCaseSearch({ q: "1 BvR 2656/18 2024-1115 QPC" });
        assert.deepEqual(result.items.map((item) => item.id), ["shared", "fr"], "ids must follow reference order with cross-reference dedupe");
        assert.equal(result.pageInfo.total, 2);
      },
    );
  });
});

test("exported exactCaseSearch uses the projected relation when projection reads are enabled", async () => {
  const urls: string[] = [];
  await withFetch((url) => {
    urls.push(url);
    if (url.includes("/rest/v1/article_view_counts")) return jsonResponse([]);
    if (url.includes("case_key")) return jsonResponse([{ id: "p1" }]);
    if (url.includes("/rest/v1/public_article_projection_p3")) return jsonResponse([listRow("p1")]);
    return jsonResponse([]);
  }, async () => {
    await withSupabaseEnv(
      {
        SUPABASE_URL: "https://exact-case-projection.test.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
        ADMIN_PUBLICATION_V4_READ_ENABLED: "true",
      },
      async () => {
        const result = await exactCaseSearch({ q: "1 BvR 2656/18", source: "de-bverfg" });
        assert.deepEqual(result.items.map((item) => item.id), ["p1"]);
      },
    );
  });
  assert.ok(
    urls.some((url) => url.includes("/rest/v1/public_article_projection_p3") && url.includes("case_key")),
    "the exact-case lookup must use the projection relation when enabled",
  );
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

test("catalogCaseSearch keeps the unavailable contract and passes cursor evidence through", async () => {
  await withSupabaseEnv(
    { CASE_CATALOG_SEARCH_ENABLED: "true", CASE_CATALOG_PUBLIC_ENABLED: "true", ADMIN_PUBLICATION_V4_READ_ENABLED: "true" },
    async () => {
      await assert.rejects(
        () => catalogCaseSearch({ q: "표현", pageSize: 20 }),
        /case_catalog\.search_database_unavailable/,
        "no config must keep the exact unavailable error",
      );
    },
  );

  const catalogEnv = {
    CASE_CATALOG_SEARCH_ENABLED: "true",
    CASE_CATALOG_PUBLIC_ENABLED: "true",
    ADMIN_PUBLICATION_V4_READ_ENABLED: "true",
    SUPABASE_URL: "https://catalog-error.test.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  };

  const cursorCases: Array<[string, "expired" | "mismatch" | "invalid"]> = [
    ["WORLDCONS_CASE_SEARCH_CURSOR_RANKING_VERSION_EXPIRED", "expired"],
    ["WORLDCONS_CASE_SEARCH_CURSOR_MISMATCH", "mismatch"],
    ["WORLDCONS_CASE_SEARCH_CURSOR_MODE_CHANGED", "mismatch"],
    ["WORLDCONS_CASE_SEARCH_INVALID_CURSOR", "invalid"],
  ];

  for (const [evidence, reason] of cursorCases) {
    await withFetch(
      (url) => url.includes("/rest/v1/rpc/worldcons_case_search_page_v2")
        ? new Response(
            JSON.stringify({ code: "22023", message: evidence, details: "detail", hint: "hint" }),
            { status: 400, headers: { "content-type": "application/json" } },
          )
        : jsonResponse([]),
      async () => {
        await withSupabaseEnv(catalogEnv, async () => {
          await assert.rejects(
            () => catalogCaseSearch({ q: "표현", pageSize: 20, cursor: "opaque" }),
            (error: unknown) => isCatalogSearchCursorError(error) && error.reason === reason,
            `cursor evidence ${evidence} must map to ${reason}`,
          );
        });
      },
    );
  }

  await withFetch(
    () => new Response(
      JSON.stringify({ code: "XX000", message: "boom", details: null, hint: null }),
      { status: 500, headers: { "content-type": "application/json" } },
    ),
    async () => {
      await withSupabaseEnv(catalogEnv, async () => {
        await assert.rejects(
          () => catalogCaseSearch({ q: "표현", pageSize: 20 }),
          /case_catalog\.search_failed:XX000/,
          "a non-cursor database error must keep the search_failed contract",
        );
      });
    },
  );
});

test("catalogCaseSearch materializes the RPC page and preserves retrieval metadata and cursors", async () => {
  const urls: string[] = [];
  await withFetch((url) => {
    urls.push(url);
    if (url.includes("/rest/v1/rpc/worldcons_case_search_page_v2")) {
      return jsonResponse({
        schemaVersion: 2,
        entries: [{ id: "a" }, { id: "b" }],
        retrievalMode: "lexical",
        rankingVersion: "gate4-multilingual-rrf-v1:abc",
        nextCursor: "next-cursor",
        total: 5,
        hasMore: true,
        totalIsExact: false,
      });
    }
    if (url.includes("article_view_counts")) return jsonResponse([]);
    if (
      url.includes("/rest/v1/articles")
      || url.includes("public_article_projection_p3")
      || url.includes("public_article_detail_v4")
    ) {
      return jsonResponse([listRow("a"), listRow("b")]);
    }
    return jsonResponse([]);
  }, async () => {
    await withSupabaseEnv(
      {
        CASE_CATALOG_SEARCH_ENABLED: "true",
        CASE_CATALOG_PUBLIC_ENABLED: "true",
        ADMIN_PUBLICATION_V4_READ_ENABLED: "true",
        SUPABASE_URL: "https://catalog-ok.test.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
      },
      async () => {
        const result = await catalogCaseSearch({ q: "표현 자유" });
        assert.deepEqual(result.items.map((item) => item.id), ["a", "b"], urls.join(" | "));
        assert.equal(result.retrievalMode, "lexical");
        assert.equal(result.rankingVersion, "gate4-multilingual-rrf-v1:abc");
        assert.deepEqual(result.pageInfo, {
          page: 1,
          pageSize: 20,
          total: 5,
          hasMore: true,
          totalIsExact: false,
          nextCursor: "next-cursor",
        });
      },
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
