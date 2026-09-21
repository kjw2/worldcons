import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getAdminDashboardData } from "../lib/db/admin-queries";
import {
  adminOpsReads,
  createSupabaseAdminOpsReadRepository,
  mockAdminOpsReads,
} from "../lib/admin/ops-read-repository";
import { setCompatibilityObservationWriterForTests } from "../lib/admin/p5/observations";
import { mockArticles, mockIngestionRuns, mockSources, mockTags } from "../lib/db/mock-data";

const ARTICLE_ROW_SELECT =
  "id, slug, source_key, jurisdiction, institution_name, original_url, original_title, korean_title, original_published_at, fetched_at, summarized_at, status, source_metadata, error_metadata, updated_at";
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
      const info: TableCall = { table, select: [], ranges: [] };
      const builder: Record<string, unknown> = {};
      const resolve = (): TableResult => {
        tableCalls.push(info);
        const handler = options.tables?.[info.table];
        return handler ? handler(info) : { data: [], error: null };
      };
      builder.select = (...args: unknown[]) => { info.select = args; return builder; };
      builder.range = (from: number, to: number) => { info.ranges.push([from, to]); return builder; };
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
