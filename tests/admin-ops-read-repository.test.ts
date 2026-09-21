import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getAdminDashboardData, listAdminArticles } from "../lib/db/admin-queries";
import {
  adminOpsReads,
  createSupabaseAdminOpsReadRepository,
  mockAdminOpsReads,
} from "../lib/admin/ops-read-repository";
import { setCompatibilityObservationWriterForTests } from "../lib/admin/p5/observations";
import { mockArticles, mockIngestionRuns, mockSources, mockTags } from "../lib/db/mock-data";

const ARTICLE_ROW_SELECT =
  "id, slug, source_key, jurisdiction, institution_name, original_url, original_title, korean_title, original_published_at, fetched_at, summarized_at, status, source_metadata, error_metadata, updated_at";
const ADMIN_ARTICLE_LIST_SELECT =
  "id, slug, source_key, jurisdiction, institution_name, original_url, original_title, korean_title, original_published_at, fetched_at, summarized_at, status, source_metadata, summary_json, updated_at";
const CANDIDATE_ROW_SELECT = "source_key, status, candidate_type, created_at, last_attempt_at";

const ENV_KEYS = [
  "SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "ADMIN_P5_COMPATIBILITY_OBSERVATION_ENABLED",
  "ADMIN_P5_COMPATIBILITY_OBSERVATION_SAMPLE_RATE",
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

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function countResponse(count: number | null) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (count !== null) headers["content-range"] = `0-0/${count}`;
  return new Response(null, { status: 200, headers });
}

async function withFetch<T>(
  handler: (url: string, init?: RequestInit) => Response,
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

interface TableCall {
  table: string;
  select: unknown[];
  ranges: Array<[number, number]>;
  orders: Array<[string, unknown?]>;
  eqs: Array<[string, unknown]>;
  filters: unknown[][];
  ors: unknown[];
  nots: unknown[][];
  iss: unknown[][];
  textSearches: Array<[string, string, unknown?]>;
}

interface TableResult {
  data?: unknown;
  error?: { message?: string } | null;
  count?: number | null;
}

function createFakeSupabase(options: {
  tables?: Record<string, (info: TableCall) => TableResult>;
  rpc?: (name: string) => { data?: unknown; error?: { message?: string } | null };
} = {}) {
  const tableCalls: TableCall[] = [];
  const rpcCalls: Array<{ name: string }> = [];

  const client = {
    from(table: string) {
      const info: TableCall = { table, select: [], ranges: [], orders: [], eqs: [], filters: [], ors: [], nots: [], iss: [], textSearches: [] };
      const builder: Record<string, unknown> = {};
      const resolve = (): TableResult => {
        tableCalls.push(info);
        const handler = options.tables?.[info.table];
        return handler ? handler(info) : { data: [], error: null };
      };
      builder.select = (...args: unknown[]) => { info.select = args; return builder; };
      builder.range = (from: number, to: number) => { info.ranges.push([from, to]); return builder; };
      builder.order = (column: string, opts?: unknown) => { info.orders.push([column, opts]); return builder; };
      builder.eq = (column: string, value: unknown) => { info.eqs.push([column, value]); return builder; };
      builder.filter = (...args: unknown[]) => { info.filters.push(args); return builder; };
      builder.or = (...args: unknown[]) => { info.ors.push(...args); return builder; };
      builder.not = (...args: unknown[]) => { info.nots.push(args); return builder; };
      builder.is = (...args: unknown[]) => { info.iss.push(args); return builder; };
      builder.textSearch = (column: string, query: string, opts?: unknown) => { info.textSearches.push([column, query, opts]); return builder; };
      builder.then = (onFulfilled: (value: TableResult) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve(resolve()).then(onFulfilled, onRejected);
      return builder;
    },
    rpc(name: string) {
      rpcCalls.push({ name });
      return Promise.resolve(options.rpc ? options.rpc(name) : { data: null, error: null });
    },
  };

  return { client: client as unknown as SupabaseClient, tableCalls, rpcCalls };
}

function dashboardFetch(options: {
  snapshot?: () => Response;
  sources?: unknown;
  runs?: unknown;
  articles?: unknown;
  candidates?: unknown;
  tagsCount?: number | null;
  candidatesCount?: number | null;
} = {}) {
  return (url: string, init?: RequestInit): Response => {
    if (url.includes("/rest/v1/rpc/rpc_admin_dashboard_snapshot")) {
      return options.snapshot ? options.snapshot() : jsonResponse(null);
    }
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "HEAD") {
      if (url.includes("/rest/v1/tags")) return countResponse(options.tagsCount ?? null);
      if (url.includes("/rest/v1/source_url_candidates")) return countResponse(options.candidatesCount ?? null);
      return countResponse(null);
    }
    if (url.includes("/rest/v1/sources")) return jsonResponse(options.sources ?? []);
    if (url.includes("/rest/v1/ingestion_runs")) return jsonResponse(options.runs ?? []);
    if (url.includes("/rest/v1/articles")) return jsonResponse(options.articles ?? []);
    if (url.includes("/rest/v1/source_url_candidates")) return jsonResponse(options.candidates ?? []);
    return jsonResponse([]);
  };
}

const LEGACY_ARTICLES = [
  { id: "a1", slug: "a1", source_key: "de-bverfg", status: "summarized", source_metadata: { collection: { publishable: true } }, original_published_at: "2026-04-01T00:00:00.000Z", updated_at: "2026-04-02T00:00:00.000Z" },
  { id: "a2", slug: "a2", source_key: "de-bverfg", status: "cleaned", updated_at: "2026-04-03T00:00:00.000Z" },
  { id: "a3", slug: "a3", source_key: "us-scotus", status: "failed_fetch", updated_at: "2026-04-04T00:00:00.000Z" },
  { id: "a4", slug: "a4", source_key: "us-scotus", status: "needs_review", updated_at: "2026-04-05T00:00:00.000Z" },
  { id: "a5", slug: "a5", source_key: "us-scotus", status: "summarized", source_metadata: { collection: { publishable: false } }, updated_at: "2026-04-06T00:00:00.000Z" },
];

const LEGACY_CANDIDATES = [
  { source_key: "de-bverfg", status: "pending", created_at: "2026-04-01T00:00:00.000Z" },
  { source_key: "de-bverfg", status: "failed", created_at: "2026-04-02T00:00:00.000Z" },
  { source_key: "fr-conseil-constitutionnel", status: "retrying", created_at: "2026-04-03T00:00:00.000Z" },
];

test("adminOpsReads selects the mock adapter without Supabase config", async () => {
  await withSupabaseEnv({}, async () => {
    assert.equal(adminOpsReads(), mockAdminOpsReads, "absent config must select the mock adapter");
    assert.equal(adminOpsReads().isConfigured(), false, "the mock adapter must report no config");
    assert.equal(await adminOpsReads().loadDashboardSnapshot(), null, "the snapshot must be unavailable without a database");

    const rows = await adminOpsReads().loadArticleRows();
    assert.equal(rows.length, mockArticles.length, "the mock article rows must mirror the mock catalog");
    assert.equal(rows[0]?.source_key, mockArticles[0].sourceKey);
    assert.equal(rows[0]?.status, mockArticles[0].status);

    assert.deepEqual(await adminOpsReads().loadCandidateRows(), [], "the mock candidate read must be empty");
    assert.equal(await adminOpsReads().countTableRows("tags", mockTags.length), mockTags.length);
    assert.equal(await adminOpsReads().countTableRows("source_url_candidates", 0), 0);
  });
});

test("adminOpsReads selects the Supabase adapter when Supabase config is present", async () => {
  await withSupabaseEnv(
    { SUPABASE_URL: "https://admin-ops.test.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-role-key" },
    () => {
      const repository = adminOpsReads();
      assert.notEqual(repository, mockAdminOpsReads, "configured Supabase must select the Supabase adapter");
      assert.equal(repository.isConfigured(), true, "the Supabase adapter must report config");
    },
  );
});

test("Supabase admin/ops adapter issues the dashboard snapshot RPC and fails closed on error", async () => {
  const ok = createFakeSupabase({ rpc: () => ({ data: { totals: { articles: 7 } }, error: null }) });
  const okRepository = createSupabaseAdminOpsReadRepository({ client: () => ok.client });
  assert.deepEqual(await okRepository.loadDashboardSnapshot(), { totals: { articles: 7 } });
  assert.deepEqual(ok.rpcCalls, [{ name: "rpc_admin_dashboard_snapshot" }]);

  const failing = createFakeSupabase({ rpc: () => ({ data: null, error: { message: "snapshot unavailable" } }) });
  assert.equal(
    await createSupabaseAdminOpsReadRepository({ client: () => failing.client }).loadDashboardSnapshot(),
    null,
    "an RPC error must resolve to null so the caller falls back",
  );

  const empty = createFakeSupabase({ rpc: () => ({ data: null, error: null }) });
  assert.equal(
    await createSupabaseAdminOpsReadRepository({ client: () => empty.client }).loadDashboardSnapshot(),
    null,
    "a null payload must resolve to null so the caller falls back",
  );
});

test("Supabase admin/ops adapter pages private article rows with the exact select and no artificial cap", async () => {
  const firstPage = Array.from({ length: 1000 }, (_, index) => ({
    id: `a${index}`,
    source_key: "de-bverfg",
    status: "summarized",
  }));
  const fake = createFakeSupabase({
    tables: {
      articles: (info) => (info.ranges[0]?.[0] === 0
        ? { data: firstPage, error: null }
        : { data: [{ id: "last", source_key: "de-bverfg", status: "cleaned" }], error: null }),
    },
  });
  const repository = createSupabaseAdminOpsReadRepository({ client: () => fake.client });

  const rows = await repository.loadArticleRows();
  assert.equal(rows.length, 1001, "paging must continue until a short page and keep every row");
  assert.deepEqual(fake.tableCalls.map((call) => call.table), ["articles", "articles"]);
  assert.deepEqual(fake.tableCalls[0].ranges, [[0, 999]], "the page size must stay 1000");
  assert.deepEqual(fake.tableCalls[1].ranges, [[1000, 1999]]);
  assert.equal(fake.tableCalls[0].select[0], ARTICLE_ROW_SELECT, "the article read must keep the exact select shape");

  const failing = createFakeSupabase({
    tables: { articles: () => ({ data: null, error: { message: "articles boom" } }) },
  });
  await assert.rejects(
    () => createSupabaseAdminOpsReadRepository({ client: () => failing.client }).loadArticleRows(),
    /articles boom/,
    "an article row read error must still throw",
  );
});

test("Supabase admin/ops adapter pages candidate rows and falls back to empty on error", async () => {
  const fake = createFakeSupabase({
    tables: {
      source_url_candidates: (info) => (info.ranges[0]?.[0] === 0
        ? { data: Array.from({ length: 1000 }, (_, index) => ({ source_key: "de-bverfg", status: `s${index}` })), error: null }
        : { data: [{ source_key: "de-bverfg", status: "pending" }], error: null }),
    },
  });
  const repository = createSupabaseAdminOpsReadRepository({ client: () => fake.client });

  const rows = await repository.loadCandidateRows();
  assert.equal(rows.length, 1001);
  assert.deepEqual(fake.tableCalls.map((call) => call.table), ["source_url_candidates", "source_url_candidates"]);
  assert.deepEqual(fake.tableCalls[0].ranges, [[0, 999]]);
  assert.deepEqual(fake.tableCalls[1].ranges, [[1000, 1999]]);
  assert.equal(fake.tableCalls[0].select[0], CANDIDATE_ROW_SELECT, "the candidate read must keep the exact select shape");

  const failing = createFakeSupabase({
    tables: { source_url_candidates: () => ({ data: null, error: { message: "candidates down" } }) },
  });
  assert.deepEqual(
    await createSupabaseAdminOpsReadRepository({ client: () => failing.client }).loadCandidateRows(),
    [],
    "a candidate read error must resolve to an empty list so the dashboard keeps its fallback",
  );
});

test("Supabase admin/ops adapter issues exact head counts and falls back on error", async () => {
  const fake = createFakeSupabase({
    tables: {
      tags: () => ({ count: 77, error: null }),
      source_url_candidates: () => ({ count: null, error: { message: "count down" } }),
    },
  });
  const repository = createSupabaseAdminOpsReadRepository({ client: () => fake.client });

  assert.equal(await repository.countTableRows("tags", mockTags.length), 77, "the exact head count must win");
  assert.equal(
    await repository.countTableRows("source_url_candidates", 0),
    0,
    "a count error must resolve to the supplied fallback",
  );
  assert.deepEqual(fake.tableCalls.map((call) => call.table), ["tags", "source_url_candidates"]);
  assert.deepEqual(fake.tableCalls[0].select, ["*", { count: "exact", head: true }]);
});

test("getAdminDashboardData uses the mock dashboard without Supabase config", async () => {
  await withSupabaseEnv({}, async () => {
    const dashboard = await getAdminDashboardData();
    assert.equal(dashboard.hasDatabase, false);
    assert.equal(dashboard.totals.sources, mockSources.length);
    assert.equal(dashboard.totals.articles, mockArticles.length);
    assert.equal(dashboard.totals.tags, mockTags.length);
    assert.equal(dashboard.totals.candidates, 0);
    assert.equal(dashboard.latestRuns.length, Math.min(12, mockIngestionRuns.length));
    assert.ok(dashboard.sourceSummaries.some((summary) => summary.sourceKey === mockSources[0].sourceKey));
    assert.ok(dashboard.statusCounts.every((entry) => typeof entry.count === "number"));
  });
});

test("getAdminDashboardData returns the mapped snapshot when the RPC succeeds", async () => {
  const snapshotPayload = {
    totals: { sources: 3, articles: 120, publicArticles: 100, pendingSummaries: 5, failedArticles: 2, attentionArticles: 4, tags: 77, candidates: 9 },
    statusCounts: [{ status: "summarized", count: 100 }, { status: "needs_review", count: 4 }],
    sourceSummaries: [{ sourceKey: "de-bverfg", name: "BVerfG", jurisdiction: "Germany", baseUrl: "https://example.test", language: "de", isActive: true, totalCount: 50, publicCount: 48, pendingSummaryCount: 1, failedCount: 1, attentionCount: 1 }],
    candidateSummaries: [{ sourceKey: "de-bverfg", pendingCount: 2, retryingCount: 0, fetchedCount: 5, failedCount: 1, ignoredCount: 0 }],
    attentionArticles: [{ id: "x1", slug: "x1", sourceKey: "de-bverfg", status: "needs_review" }],
  };

  await withFetch(dashboardFetch({ snapshot: () => jsonResponse(snapshotPayload) }), async () => {
    await withSupabaseEnv(
      { SUPABASE_URL: "https://admin-ops-snapshot.test.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-role-key" },
      async () => {
        const dashboard = await getAdminDashboardData();
        assert.equal(dashboard.hasDatabase, true);
        assert.equal(dashboard.totals.articles, 120);
        assert.equal(dashboard.totals.tags, 77);
        assert.equal(dashboard.totals.publicArticles, 100);
        assert.equal(dashboard.statusCounts.find((entry) => entry.status === "summarized")?.count, 100);
        assert.equal(dashboard.statusCounts.find((entry) => entry.status === "needs_review")?.count, 4);
        assert.equal(dashboard.sourceSummaries[0].sourceKey, "de-bverfg");
        assert.equal(dashboard.candidateSummaries[0].sourceKey, "de-bverfg");
        assert.equal(dashboard.attentionArticles.length, 1);
      },
    );
  });
});

test("getAdminDashboardData falls back to the legacy aggregation on snapshot error, null, or invalid payload", async () => {
  const cases: Array<() => Response> = [
    () => jsonResponse({ message: "snapshot failed", code: "XX000" }, 500),
    () => jsonResponse(null),
    () => jsonResponse("not-json"),
  ];

  for (const snapshot of cases) {
    await withFetch(
      dashboardFetch({
        snapshot,
        sources: mockSources,
        runs: mockIngestionRuns.slice(0, 1),
        articles: LEGACY_ARTICLES,
        candidates: LEGACY_CANDIDATES,
        tagsCount: 77,
        candidatesCount: 9,
      }),
      async () => {
        await withSupabaseEnv(
          { SUPABASE_URL: "https://admin-ops-legacy.test.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-role-key" },
          async () => {
            const dashboard = await getAdminDashboardData();
            assert.equal(dashboard.hasDatabase, true, "a configured database must report hasDatabase even on fallback");
            assert.equal(dashboard.totals.articles, LEGACY_ARTICLES.length);
            assert.equal(dashboard.totals.publicArticles, 1);
            assert.equal(dashboard.totals.pendingSummaries, 1);
            assert.equal(dashboard.totals.failedArticles, 1);
            assert.equal(dashboard.totals.attentionArticles, 2);
            assert.equal(dashboard.totals.tags, 77, "the exact head count must flow into the legacy totals");
            assert.equal(dashboard.totals.candidates, 9, "the exact candidate count must win over the row count");
            assert.equal(dashboard.statusCounts.find((entry) => entry.status === "summarized")?.count, 2);
            assert.equal(dashboard.statusCounts.find((entry) => entry.status === "needs_review")?.count, 1);

            const deSummary = dashboard.sourceSummaries.find((summary) => summary.sourceKey === "de-bverfg");
            assert.equal(deSummary?.totalCount, 2);
            assert.equal(deSummary?.publicCount, 1);
            assert.equal(deSummary?.pendingSummaryCount, 1);
            const usSummary = dashboard.sourceSummaries.find((summary) => summary.sourceKey === "us-scotus");
            assert.equal(usSummary?.totalCount, 3);
            assert.equal(usSummary?.failedCount, 1);
            assert.equal(usSummary?.attentionCount, 2);

            const candidateSummary = dashboard.candidateSummaries.find((summary) => summary.sourceKey === "de-bverfg");
            assert.equal(candidateSummary?.pendingCount, 1);
            assert.equal(candidateSummary?.failedCount, 1);
            assert.equal(dashboard.attentionArticles.length, 2, "the attention list must stay capped and ordered");
          },
        );
      },
    );
  }
});

test("getAdminDashboardData records the compatibility observation for new and fallback authority", async () => {
  const observations: Array<{ surface: string; authority: string; outcome: string }> = [];
  setCompatibilityObservationWriterForTests(async (observation) => {
    observations.push({ surface: observation.surface, authority: observation.authority, outcome: observation.outcome });
  });

  try {
    await withFetch(dashboardFetch({ snapshot: () => jsonResponse({ totals: { articles: 1 } }) }), async () => {
      await withSupabaseEnv(
        {
          SUPABASE_URL: "https://admin-ops-observation.test.supabase.co",
          SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
          ADMIN_P5_COMPATIBILITY_OBSERVATION_ENABLED: "true",
          ADMIN_P5_COMPATIBILITY_OBSERVATION_SAMPLE_RATE: "1",
        },
        async () => {
          await getAdminDashboardData();
        },
      );
    });
    assert.deepEqual(observations, [{ surface: "admin_dashboard", authority: "new", outcome: "succeeded" }]);

    await withFetch(dashboardFetch({ snapshot: () => jsonResponse({ message: "down" }, 500) }), async () => {
      await withSupabaseEnv(
        {
          SUPABASE_URL: "https://admin-ops-observation-fallback.test.supabase.co",
          SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
          ADMIN_P5_COMPATIBILITY_OBSERVATION_ENABLED: "true",
          ADMIN_P5_COMPATIBILITY_OBSERVATION_SAMPLE_RATE: "1",
        },
        async () => {
          await getAdminDashboardData();
        },
      );
    });
    assert.deepEqual(observations[1], { surface: "admin_dashboard", authority: "fallback", outcome: "fallback" });
  } finally {
    setCompatibilityObservationWriterForTests(null);
  }
});

test("listAdminArticles preserves mock filtering, sorting, pagination, bounds, and delegation without Supabase config", async () => {
  await withSupabaseEnv({}, async () => {
    assert.equal(adminOpsReads(), mockAdminOpsReads, "absent config must select the mock adapter");

    const expectedOrder = [...mockArticles]
      .sort((a, b) => (b.originalPublishedAt ?? b.fetchedAt ?? "").localeCompare(a.originalPublishedAt ?? a.fetchedAt ?? ""))
      .map((article) => article.slug);
    assert.equal(expectedOrder.length, 3, "the mock corpus must keep three articles");
    const [germanySlug, franceSlug, usSlug] = expectedOrder;

    const all = await listAdminArticles({});
    assert.deepEqual(all.items.map((item) => item.slug), expectedOrder, "the mock list must sort by published date desc");
    assert.equal(all.pageInfo.page, 1);
    assert.equal(all.pageInfo.pageSize, 25);
    assert.equal(all.pageInfo.total, 3);
    assert.equal(all.pageInfo.hasMore, false);
    assert.equal(all.pageInfo.totalIsExact, true);

    const repositoryPage = await mockAdminOpsReads.listAdminArticles({});
    assert.deepEqual(all.pageInfo, repositoryPage.pageInfo, "the exported list must delegate to the mock adapter page info");
    assert.deepEqual(all.items.map((item) => item.slug), repositoryPage.rows.map((row) => row.slug));

    assert.deepEqual((await listAdminArticles({ sourceKey: "us-scotus" })).items.map((item) => item.slug), [usSlug]);
    assert.deepEqual((await listAdminArticles({ jurisdiction: "France" })).items.map((item) => item.slug), [franceSlug]);
    assert.equal((await listAdminArticles({ status: "summarized" })).items.length, 3);
    assert.equal((await listAdminArticles({ status: "failed_fetch" })).items.length, 0);
    assert.equal((await listAdminArticles({ publishable: "yes" })).items.length, 3);
    assert.equal((await listAdminArticles({ publishable: "no" })).items.length, 0);
    assert.equal((await listAdminArticles({ hasSummary: "yes" })).items.length, 3);
    assert.equal((await listAdminArticles({ hasSummary: "no" })).items.length, 0);
    assert.deepEqual((await listAdminArticles({ q: "germany" })).items.map((item) => item.slug), [germanySlug]);

    const firstPage = await listAdminArticles({ page: 1, pageSize: 2 });
    assert.equal(firstPage.pageInfo.hasMore, true);
    assert.deepEqual(firstPage.items.map((item) => item.slug), expectedOrder.slice(0, 2));
    const secondPage = await listAdminArticles({ page: 2, pageSize: 2 });
    assert.equal(secondPage.pageInfo.page, 2);
    assert.equal(secondPage.pageInfo.hasMore, false);
    assert.deepEqual(secondPage.items.map((item) => item.slug), [usSlug]);

    const bounded = await listAdminArticles({ page: 0, pageSize: 10_000 });
    assert.equal(bounded.pageInfo.page, 1, "a non-positive page must fall back to 1");
    assert.equal(bounded.pageInfo.pageSize, 50, "a page size above 50 must clamp to 50");
    const fractional = await listAdminArticles({ page: 2.9, pageSize: 2.9 });
    assert.equal(fractional.pageInfo.page, 2, "a fractional page must floor");
    assert.equal(fractional.pageInfo.pageSize, 2, "a fractional page size must floor");
  });
});

test("Supabase admin/ops adapter preserves the admin list select, order, range, count, and pagination", async () => {
  const rows = [
    { id: "a", slug: "a", source_key: "de-bverfg", status: "summarized", summary_json: { coreSummary: ["x"] } },
    { id: "b", slug: "b", source_key: "us-scotus", status: "cleaned" },
    { id: "c", slug: "c", source_key: "fr-conseil-constitutionnel", status: "failed_fetch" },
  ];
  const fake = createFakeSupabase({ tables: { articles: () => ({ data: rows, error: null, count: 42 }) } });
  const repository = createSupabaseAdminOpsReadRepository({ client: () => fake.client });

  const firstPage = await repository.listAdminArticles({ page: 1, pageSize: 2 });
  assert.equal(fake.tableCalls[0].table, "articles");
  assert.equal(fake.tableCalls[0].select[0], ADMIN_ARTICLE_LIST_SELECT, "the list read must keep the exact select shape");
  assert.deepEqual(fake.tableCalls[0].select[1], { count: "exact" });
  assert.deepEqual(fake.tableCalls[0].orders, [
    ["original_published_at", { ascending: false, nullsFirst: false }],
    ["updated_at", { ascending: false, nullsFirst: false }],
    ["id", { ascending: true }],
  ]);
  assert.deepEqual(fake.tableCalls[0].ranges, [[0, 1]]);
  assert.equal(firstPage.rows.length, 3);
  assert.equal(firstPage.pageInfo.page, 1);
  assert.equal(firstPage.pageInfo.pageSize, 2);
  assert.equal(firstPage.pageInfo.total, 42, "the exact count must win");
  assert.equal(firstPage.pageInfo.hasMore, true);
  assert.equal(firstPage.pageInfo.totalIsExact, true);

  await repository.listAdminArticles({ page: 3, pageSize: 25 });
  assert.deepEqual(fake.tableCalls[1].ranges, [[50, 74]], "range pagination must follow the bounded page/pageSize");
});

test("Supabase admin/ops adapter applies every admin list filter and the existing full-text normalization", async () => {
  const fake = createFakeSupabase({ tables: { articles: () => ({ data: [], error: null, count: 0 }) } });
  const repository = createSupabaseAdminOpsReadRepository({ client: () => fake.client });

  await repository.listAdminArticles({
    q: "표현의 자유! (BVerfG)",
    status: "summarized",
    sourceKey: "de-bverfg",
    jurisdiction: "Germany",
    publishable: "yes",
    hasSummary: "yes",
  });

  const call = fake.tableCalls[0];
  assert.deepEqual(call.textSearches, [["search_vector", "표현의:* & 자유:* & bverfg:*", { config: "simple" }]]);
  assert.deepEqual(call.eqs, [["status", "summarized"], ["source_key", "de-bverfg"], ["jurisdiction", "Germany"]]);
  assert.deepEqual(call.filters, [["source_metadata->collection->>publishable", "eq", "true"]]);
  assert.deepEqual(call.nots, [["summary_json", "is", null]]);
  assert.deepEqual(call.ors, []);

  const noFake = createFakeSupabase({ tables: { articles: () => ({ data: [], error: null, count: 0 }) } });
  const noRepository = createSupabaseAdminOpsReadRepository({ client: () => noFake.client });
  await noRepository.listAdminArticles({ publishable: "no", hasSummary: "no" });
  const noCall = noFake.tableCalls[0];
  assert.deepEqual(noCall.ors, [
    "source_metadata->collection->>publishable.is.null,source_metadata->collection->>publishable.neq.true",
  ]);
  assert.deepEqual(noCall.iss, [["summary_json", null]]);
  assert.deepEqual(noCall.filters, []);
  assert.deepEqual(noCall.nots, []);
  assert.deepEqual(noCall.textSearches, [], "an empty query must not add a text search");
});

test("Supabase admin/ops adapter throws on list error and falls back to the range total when count is null", async () => {
  const failing = createFakeSupabase({ tables: { articles: () => ({ data: null, error: { message: "list boom" } }) } });
  await assert.rejects(
    () => createSupabaseAdminOpsReadRepository({ client: () => failing.client }).listAdminArticles({}),
    /list boom/,
    "a list read error must still throw",
  );

  const nullCount = createFakeSupabase({
    tables: {
      articles: () => ({
        data: [
          { id: "a", slug: "a", source_key: "de-bverfg", status: "summarized" },
          { id: "b", slug: "b", source_key: "de-bverfg", status: "cleaned" },
        ],
        error: null,
        count: null,
      }),
    },
  });
  const page = await createSupabaseAdminOpsReadRepository({ client: () => nullCount.client }).listAdminArticles({ page: 2, pageSize: 2 });
  assert.equal(page.pageInfo.total, 4, "a null count must fall back to range start + returned rows");
  assert.equal(page.pageInfo.hasMore, false);
});

test("exported listAdminArticles delegates to the configured Supabase adapter", async () => {
  await withFetch(
    (url) => {
      if (url.includes("/rest/v1/articles")) {
        return new Response(
          JSON.stringify([
            { id: "a", slug: "a", source_key: "de-bverfg", institution_name: "BVerfG", jurisdiction: "Germany", status: "summarized", summary_json: { coreSummary: ["x"] } },
          ]),
          { status: 200, headers: { "content-type": "application/json", "content-range": "0-0/1" } },
        );
      }
      return jsonResponse([]);
    },
    async () => {
      await withSupabaseEnv(
        { SUPABASE_URL: "https://admin-ops-list.test.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-role-key" },
        async () => {
          const result = await listAdminArticles({ page: 1, pageSize: 25 });
          assert.equal(result.items.length, 1);
          assert.equal(result.items[0].slug, "a");
          assert.equal(result.items[0].hasSummary, true);
          assert.equal(result.pageInfo.total, 1);
          assert.equal(result.pageInfo.hasMore, false);
        },
      );
    },
  );
});

test("listAdminArticles carries no direct Supabase coupling while bulk write coupling remains", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "lib/db/admin-queries.ts"), "utf8");
  const listStart = source.indexOf("export async function listAdminArticles");
  const bulkStart = source.indexOf("async function loadBulkAdminArticleRows");
  const bulkEnd = source.indexOf("function unresolvedBulkRefs");
  assert.ok(
    listStart >= 0 && bulkStart > listStart && bulkEnd > bulkStart,
    "expected the admin list and bulk functions to be present in order",
  );

  const listSource = source.slice(listStart, bulkStart);
  assert.ok(!listSource.includes("getSupabaseAdmin"), "listAdminArticles must not resolve the Supabase admin client");
  assert.ok(!listSource.includes(".from("), "listAdminArticles must not call a Supabase table builder");
  assert.ok(!listSource.includes(".rpc("), "listAdminArticles must not call a Supabase RPC");
  assert.ok(listSource.includes("adminOpsReads().listAdminArticles"), "listAdminArticles must delegate to the privileged repository");

  const bulkReadSource = source.slice(bulkStart, bulkEnd);
  assert.ok(bulkReadSource.includes("getSupabaseAdmin"), "bulk article reads must keep their direct Supabase access");
  assert.ok(bulkReadSource.includes('.from("articles")'), "bulk article reads must keep querying the articles table");

  const bulkWriteSource = source.slice(bulkEnd);
  assert.ok(bulkWriteSource.includes('.from("articles")'), "bulk article writes must keep querying the articles table");
});
