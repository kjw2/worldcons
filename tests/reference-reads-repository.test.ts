import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { listJurisdictionArticleCounts, listSources, listTags } from "../lib/db/queries";
import { mockSources, mockTags } from "../lib/db/mock-data";
import { referenceReads } from "../lib/reference-reads";
import { mockReferenceReads } from "../lib/reference-reads/mock-repository";
import { createSupabaseReferenceReadRepository } from "../lib/reference-reads/supabase-repository";

const SUPABASE_ENV_KEYS = ["SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"] as const;

async function withSupabaseEnv<T>(
  values: Partial<Record<(typeof SUPABASE_ENV_KEYS)[number], string>>,
  run: () => Promise<T> | T,
): Promise<T> {
  const original = new Map(SUPABASE_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of SUPABASE_ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
  try {
    return await run();
  } finally {
    for (const key of SUPABASE_ENV_KEYS) {
      const value = original.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

interface QueryInfo {
  table: string;
  select?: unknown[];
  orders: Array<[string, unknown?]>;
  eqs: Array<[string, unknown]>;
  gtes: Array<[string, unknown]>;
  filters: unknown[][];
  limits: number[];
  ranges: Array<[number, number]>;
}

interface TableResult {
  data?: unknown;
  error?: { message: string } | null;
  count?: number | null;
}

function createFakeSupabase(options: {
  tables?: Record<string, (info: QueryInfo) => TableResult>;
  rpc?: (name: string, args: unknown) => { data?: unknown; error?: { message: string } | null };
} = {}) {
  const tableCalls: QueryInfo[] = [];
  const rpcCalls: Array<{ name: string; args: unknown }> = [];

  const client = {
    from(table: string) {
      const info: QueryInfo = { table, orders: [], eqs: [], gtes: [], filters: [], limits: [], ranges: [] };
      const builder: Record<string, unknown> = {};
      const resolve = (): TableResult => {
        tableCalls.push(info);
        const handler = options.tables?.[info.table];
        return handler ? handler(info) : { data: [], error: null };
      };
      builder.select = (...args: unknown[]) => { info.select = args; return builder; };
      builder.order = (column: string, opts?: unknown) => { info.orders.push([column, opts]); return builder; };
      builder.eq = (column: string, value: unknown) => { info.eqs.push([column, value]); return builder; };
      builder.gte = (column: string, value: unknown) => { info.gtes.push([column, value]); return builder; };
      builder.filter = (...args: unknown[]) => { info.filters.push(args); return builder; };
      builder.limit = (value: number) => { info.limits.push(value); return builder; };
      builder.range = (from: number, to: number) => { info.ranges.push([from, to]); return builder; };
      builder.maybeSingle = () => Promise.resolve(resolve());
      builder.then = (onFulfilled: (value: TableResult) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve(resolve()).then(onFulfilled, onRejected);
      return builder;
    },
    rpc(name: string, args: unknown) {
      rpcCalls.push({ name, args });
      return Promise.resolve(options.rpc ? options.rpc(name, args) : { data: [], error: null });
    },
  };

  return { client: client as unknown as SupabaseClient, tableCalls, rpcCalls };
}

test("referenceReads selects the mock adapter and preserves mock fallback without Supabase config", async () => {
  await withSupabaseEnv({}, async () => {
    assert.equal(referenceReads(), mockReferenceReads, "absent config must select the mock adapter");
    assert.deepEqual(await referenceReads().listSources(), mockSources);
    assert.deepEqual(await listSources(), mockSources, "exported listSources must keep the mock fallback");
    assert.deepEqual(await listTags({ type: "procedure" }), [mockTags.find((tag) => tag.slug === "qpc")]);
    assert.deepEqual(await listJurisdictionArticleCounts([]), { Germany: 1, "United States": 1, France: 1 });
    assert.deepEqual(await listJurisdictionArticleCounts(["France", "Spain"]), { France: 1, Spain: 0 });
  });
});

test("referenceReads selects the Supabase adapter when Supabase config is present", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requests.push(String(input));
    return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  try {
    await withSupabaseEnv(
      { SUPABASE_URL: "https://reference-reads.test.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-role-key" },
      async () => {
        const repository = referenceReads();
        assert.notEqual(repository, mockReferenceReads, "configured Supabase must select the Supabase adapter");
        assert.deepEqual(await repository.listSources(), []);
        assert.deepEqual(await listSources(), [], "exported listSources must delegate to the selected adapter");
        assert.ok(requests.some((url) => url.includes("/rest/v1/sources")), "Supabase adapter must query the sources table");
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Supabase adapter maps source rows and orders by jurisdiction", async () => {
  const fake = createFakeSupabase({
    tables: {
      sources: () => ({
        data: [{
          id: "source-1",
          source_key: "de-bverfg",
          name: "Federal Constitutional Court of Germany",
          jurisdiction: "Germany",
          base_url: "https://www.bundesverfassungsgericht.de",
          language: "de",
          is_active: true,
        }],
        error: null,
      }),
    },
  });
  const repository = createSupabaseReferenceReadRepository({ client: () => fake.client, environment: {} });

  assert.deepEqual(await repository.listSources(), [{
    id: "source-1",
    sourceKey: "de-bverfg",
    name: "Federal Constitutional Court of Germany",
    jurisdiction: "Germany",
    baseUrl: "https://www.bundesverfassungsgericht.de",
    language: "de",
    isActive: true,
  }]);
  assert.deepEqual(fake.tableCalls.map((call) => call.table), ["sources"]);
  assert.deepEqual(fake.tableCalls[0].orders, [["jurisdiction", undefined]]);

  const failing = createFakeSupabase({ tables: { sources: () => ({ data: null, error: { message: "sources unavailable" } }) } });
  const failingRepository = createSupabaseReferenceReadRepository({ client: () => failing.client, environment: {} });
  await assert.rejects(() => failingRepository.listSources(), /sources unavailable/);
});

test("Supabase adapter selects the tag projection and applies list options", async () => {
  const legacyFake = createFakeSupabase({
    tables: {
      tags: () => ({
        data: [{
          id: "tag-1",
          slug: "qpc",
          name: "QPC",
          normalized_name: "QPC",
          type: "procedure",
          description: null,
          article_count: 3,
          latest_article_at: "2026-05-02T00:00:00.000Z",
        }],
        error: null,
      }),
    },
  });
  const legacyRepository = createSupabaseReferenceReadRepository({ client: () => legacyFake.client, environment: {} });

  assert.deepEqual(
    await legacyRepository.listTags({ type: "procedure", sort: "latest", limit: 5, minArticleCount: 2 }),
    [{
      id: "tag-1",
      slug: "qpc",
      name: "QPC",
      normalizedName: "QPC",
      type: "procedure",
      description: null,
      articleCount: 3,
      latestArticleAt: "2026-05-02T00:00:00.000Z",
      confidence: undefined,
    }],
  );
  assert.deepEqual(legacyFake.tableCalls.map((call) => call.table), ["tags"]);
  assert.deepEqual(legacyFake.tableCalls[0].eqs, [["type", "procedure"]]);
  assert.deepEqual(legacyFake.tableCalls[0].gtes, [["article_count", 2]]);
  assert.deepEqual(legacyFake.tableCalls[0].orders, [["latest_article_at", { ascending: false, nullsFirst: false }]]);
  assert.deepEqual(legacyFake.tableCalls[0].limits, [5]);

  const projectedFake = createFakeSupabase({ tables: { public_tag_projection_p3: () => ({ data: [], error: null }) } });
  const projectedRepository = createSupabaseReferenceReadRepository({
    client: () => projectedFake.client,
    environment: { ADMIN_PUBLICATION_V4_READ_ENABLED: "true" },
  });
  assert.deepEqual(await projectedRepository.listTags(), []);
  assert.deepEqual(projectedFake.tableCalls.map((call) => call.table), ["public_tag_projection_p3"]);
});

test("Supabase adapter selects the jurisdiction-count RPC and maps its rows", async () => {
  const fake = createFakeSupabase({
    rpc: () => ({ data: [{ jurisdiction: "France", article_count: "4" }, { jurisdiction: "  ", article_count: 9 }], error: null }),
  });
  const repository = createSupabaseReferenceReadRepository({ client: () => fake.client, environment: {} });

  assert.deepEqual(await repository.listJurisdictionArticleCounts(), { France: 4 });
  assert.deepEqual(await repository.listJurisdictionArticleCounts(["France", "Spain"]), { France: 4, Spain: 0 });
  assert.deepEqual(fake.rpcCalls, [
    { name: "public_jurisdiction_article_counts", args: { range_start: null } },
    { name: "public_jurisdiction_article_counts", args: { range_start: null } },
  ]);

  const projectedFake = createFakeSupabase({ rpc: () => ({ data: [], error: null }) });
  const projectedRepository = createSupabaseReferenceReadRepository({
    client: () => projectedFake.client,
    environment: { ADMIN_PUBLICATION_V4_READ_ENABLED: "true" },
  });
  await projectedRepository.listJurisdictionArticleCounts([], { range: "week" });
  assert.equal(projectedFake.rpcCalls[0].name, "public_jurisdiction_article_counts_p3");
  assert.equal(typeof (projectedFake.rpcCalls[0].args as { range_start?: unknown }).range_start, "string");
});

test("Supabase adapter keeps the jurisdiction-count RPC fallback semantics", async () => {
  const legacyFake = createFakeSupabase({
    rpc: () => ({ data: null, error: { message: "rpc unavailable" } }),
    tables: {
      sources: () => ({
        data: [{ id: "s", source_key: "fr", name: "FR", jurisdiction: "France", base_url: "u", language: "fr", is_active: true }],
        error: null,
      }),
      articles: (info) => ({
        count: info.eqs.some(([column, value]) => column === "jurisdiction" && value === "France") ? 7 : 0,
        error: null,
      }),
    },
  });
  const legacyRepository = createSupabaseReferenceReadRepository({ client: () => legacyFake.client, environment: {} });

  assert.deepEqual(await legacyRepository.listJurisdictionArticleCounts(), { France: 7 });
  assert.deepEqual(legacyFake.tableCalls.map((call) => call.table), ["sources", "articles"]);
  const articleCall = legacyFake.tableCalls[1];
  assert.deepEqual(articleCall.select?.[0], "id");
  assert.deepEqual(articleCall.select?.[1], { count: "exact", head: true });
  assert.ok(articleCall.eqs.some(([column, value]) => column === "status" && value === "summarized"));
  assert.ok(articleCall.eqs.some(([column, value]) => column === "jurisdiction" && value === "France"));
  assert.ok(articleCall.eqs.some(([column, value]) => column === "catalog_ai_stale_v4" && value === false));
  assert.ok(articleCall.filters.some((filter) => filter[0] === "source_metadata->collection->>publishable" && filter[1] === "eq" && filter[2] === "true"));

  const projectedFake = createFakeSupabase({
    rpc: () => ({ data: null, error: { message: "rpc unavailable" } }),
    tables: { public_article_projection_p3: () => ({ count: 3, error: null }) },
  });
  const projectedRepository = createSupabaseReferenceReadRepository({
    client: () => projectedFake.client,
    environment: { ADMIN_PUBLICATION_V4_READ_ENABLED: "true" },
  });

  assert.deepEqual(await projectedRepository.listJurisdictionArticleCounts(["France"]), { France: 3 });
  assert.deepEqual(projectedFake.tableCalls.map((call) => call.table), ["public_article_projection_p3"]);
  assert.ok(!projectedFake.tableCalls[0].eqs.some(([column]) => column === "catalog_ai_stale_v4"));
  assert.equal(projectedFake.tableCalls[0].filters.length, 0);
});

