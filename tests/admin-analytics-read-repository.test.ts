import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getAdminAuditLogData, getAnalyticsDashboardData } from "../lib/db/analytics";
import {
  adminAnalyticsReads,
  createSupabaseAdminAnalyticsReadRepository,
  failClosedAdminAnalyticsReads,
} from "../lib/admin/analytics-read-repository";
import { setCompatibilityObservationWriterForTests } from "../lib/admin/p5/observations";

const ADMIN_AUDIT_SELECT = "id, occurred_at, event_type, path, article_slug, source_key, metadata";
const SITE_EVENT_BASE_SELECT =
  "occurred_at, event_type, path, article_slug, article_title, tag_slug, tag_name, source_key, jurisdiction, institution_name, search_query, search_mode, result_count, referrer_host, user_agent_family, device_type, metadata";
const SITE_EVENT_ACCESS_INFO_SELECT = `${SITE_EVENT_BASE_SELECT}, client_ip_hash, accept_language, client_country, is_bot`;
const INGESTION_RUN_SELECT =
  "source_key, status, discovered_count, fetched_count, summarized_count, failed_count, started_at";
const ARTICLE_SUMMARY_SELECT = "status, source_key, summary_json, error_metadata, source_metadata, summarized_at, updated_at";

const CONFIGURED_ENV = {
  SUPABASE_URL: "https://admin-analytics.test.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
} as const;

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

interface AnalyticsCall {
  table: string;
  select: unknown[];
  ins: Array<[string, unknown]>;
  gtes: Array<[string, unknown]>;
  orders: Array<[string, unknown?]>;
  limits: number[];
  ranges: Array<[number, number]>;
}

interface TableResult {
  data?: unknown;
  error?: { message?: string } | null;
  count?: number | null;
}

function createFakeSupabase(options: {
  tables?: Record<string, (info: AnalyticsCall) => TableResult>;
  rpc?: (name: string) => { data?: unknown; error?: { message?: string } | null };
} = {}) {
  const tableCalls: AnalyticsCall[] = [];
  const rpcCalls: string[] = [];

  const client = {
    from(table: string) {
      const info: AnalyticsCall = { table, select: [], ins: [], gtes: [], orders: [], limits: [], ranges: [] };
      const builder: Record<string, unknown> = {};
      const resolve = (): TableResult => {
        tableCalls.push(info);
        const handler = options.tables?.[info.table];
        return handler ? handler(info) : { data: [], error: null };
      };
      builder.select = (...args: unknown[]) => { info.select = args; return builder; };
      builder.in = (column: string, values: unknown) => { info.ins.push([column, values]); return builder; };
      builder.gte = (column: string, value: unknown) => { info.gtes.push([column, value]); return builder; };
      builder.order = (column: string, opts?: unknown) => { info.orders.push([column, opts]); return builder; };
      builder.limit = (value: number) => { info.limits.push(value); return builder; };
      builder.range = (from: number, to: number) => { info.ranges.push([from, to]); return builder; };
      builder.then = (onFulfilled: (value: TableResult) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve(resolve()).then(onFulfilled, onRejected);
      return builder;
    },
    rpc(name: string) {
      rpcCalls.push(name);
      return Promise.resolve(options.rpc ? options.rpc(name) : { data: null, error: null });
    },
  };

  return { client: client as unknown as SupabaseClient, tableCalls, rpcCalls };
}

function auditFetch(rows: unknown[], count?: number) {
  return (url: string): Response => {
    if (url.includes("/rest/v1/site_events")) {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (count !== undefined) headers["content-range"] = `0-0/${count}`;
      return new Response(JSON.stringify(rows), { status: 200, headers });
    }
    return jsonResponse([]);
  };
}

function analyticsFetch(options: {
  snapshot?: () => Response;
  events?: unknown;
  runs?: unknown;
  articles?: unknown;
} = {}) {
  return (url: string): Response => {
    if (url.includes("/rest/v1/rpc/rpc_admin_analytics_health_snapshot")) {
      return options.snapshot ? options.snapshot() : jsonResponse(null);
    }
    if (url.includes("/rest/v1/site_events")) return jsonResponse(options.events ?? []);
    if (url.includes("/rest/v1/ingestion_runs")) return jsonResponse(options.runs ?? []);
    if (url.includes("/rest/v1/articles")) return jsonResponse(options.articles ?? []);
    return jsonResponse([]);
  };
}

test("adminAnalyticsReads selects the fail-closed adapter without Supabase config", async () => {
  await withSupabaseEnv({}, async () => {
    assert.equal(adminAnalyticsReads(), failClosedAdminAnalyticsReads, "absent config must select the fail-closed adapter");
    assert.equal(adminAnalyticsReads().isConfigured(), false, "the fail-closed adapter must report no config");
    assert.deepEqual(await adminAnalyticsReads().loadAdminAuditActionOptionRows(["admin_action"]), []);
    assert.deepEqual(
      await adminAnalyticsReads().loadAdminAuditEntryRows({ eventTypes: ["admin_action"], filtered: false, from: 0, to: 24 }),
      { status: "ok", rows: [], count: 0 },
    );
    assert.deepEqual(await adminAnalyticsReads().loadSiteEvents("2026-01-01T00:00:00.000Z"), { rows: [], schemaReady: false });
    assert.deepEqual(await adminAnalyticsReads().loadIngestionRunRows("2026-01-01T00:00:00.000Z"), []);
    assert.deepEqual(await adminAnalyticsReads().loadArticleSummaryRows(), []);
    assert.equal(await adminAnalyticsReads().loadAnalyticsHealthSnapshot(30), null);
  });
});

test("adminAnalyticsReads selects the Supabase adapter when Supabase config is present", async () => {
  await withSupabaseEnv(CONFIGURED_ENV, () => {
    const repository = adminAnalyticsReads();
    assert.notEqual(repository, failClosedAdminAnalyticsReads, "configured Supabase must select the Supabase adapter");
    assert.equal(repository.isConfigured(), true, "the Supabase adapter must report config");
  });
});

test("Supabase admin analytics adapter issues the audit action-option query and fails closed", async () => {
  const rows = [{ id: "e1", occurred_at: "2026-09-01T00:00:00.000Z", event_type: "admin_action", metadata: { action: "publish" } }];
  const fake = createFakeSupabase({ tables: { site_events: () => ({ data: rows, error: null }) } });
  const repository = createSupabaseAdminAnalyticsReadRepository({ client: () => fake.client });

  assert.deepEqual(await repository.loadAdminAuditActionOptionRows(["admin_action", "admin_review_action"]), rows);
  assert.equal(fake.tableCalls[0].table, "site_events");
  assert.equal(fake.tableCalls[0].select[0], ADMIN_AUDIT_SELECT, "the action-option read must keep the exact select shape");
  assert.deepEqual(fake.tableCalls[0].ins, [["event_type", ["admin_action", "admin_review_action"]]]);
  assert.deepEqual(fake.tableCalls[0].orders, [["occurred_at", { ascending: false }]]);
  assert.deepEqual(fake.tableCalls[0].limits, [1000]);

  const failing = createFakeSupabase({ tables: { site_events: () => ({ data: null, error: { message: "audit down" } }) } });
  assert.deepEqual(
    await createSupabaseAdminAnalyticsReadRepository({ client: () => failing.client }).loadAdminAuditActionOptionRows(["admin_action"]),
    [],
    "an action-option read error must resolve to an empty list",
  );
});

test("Supabase admin analytics adapter preserves the audit entry limit branch and exact-count range branch", async () => {
  const rows = [{ id: "e1", occurred_at: "2026-09-01T00:00:00.000Z", event_type: "admin_action", metadata: { action: "publish" } }];

  const filtered = createFakeSupabase({ tables: { site_events: () => ({ data: rows, error: null }) } });
  const filteredResult = await createSupabaseAdminAnalyticsReadRepository({ client: () => filtered.client }).loadAdminAuditEntryRows({
    eventTypes: ["admin_action", "admin_review_action"],
    filtered: true,
    from: 25,
    to: 49,
  });
  assert.equal(filtered.tableCalls[0].select[0], ADMIN_AUDIT_SELECT);
  assert.deepEqual(filtered.tableCalls[0].select[1], { count: "exact" });
  assert.deepEqual(filtered.tableCalls[0].ins, [["event_type", ["admin_action", "admin_review_action"]]]);
  assert.deepEqual(filtered.tableCalls[0].orders, [["occurred_at", { ascending: false }]]);
  assert.deepEqual(filtered.tableCalls[0].limits, [1000], "the filtered branch must take limit 1000");
  assert.deepEqual(filtered.tableCalls[0].ranges, [], "the filtered branch must not range-paginate");
  assert.deepEqual(filteredResult, { status: "ok", rows, count: null });

  const ranged = createFakeSupabase({ tables: { site_events: () => ({ data: rows, error: null, count: 42 }) } });
  const rangedResult = await createSupabaseAdminAnalyticsReadRepository({ client: () => ranged.client }).loadAdminAuditEntryRows({
    eventTypes: ["admin_action"],
    filtered: false,
    from: 25,
    to: 49,
  });
  assert.deepEqual(ranged.tableCalls[0].ranges, [[25, 49]], "the unfiltered branch must range-paginate");
  assert.deepEqual(ranged.tableCalls[0].limits, [], "the unfiltered branch must not apply the 1000 limit");
  assert.deepEqual(rangedResult, { status: "ok", rows, count: 42 });

  const nullCount = createFakeSupabase({ tables: { site_events: () => ({ data: rows, error: null, count: null }) } });
  const nullCountResult = await createSupabaseAdminAnalyticsReadRepository({ client: () => nullCount.client }).loadAdminAuditEntryRows({
    eventTypes: ["admin_action"],
    filtered: false,
    from: 0,
    to: 24,
  });
  assert.ok(nullCountResult.status === "ok" && nullCountResult.count === null, "a null count must stay null for the caller to fall back");

  const failing = createFakeSupabase({ tables: { site_events: () => ({ data: null, error: { message: "audit down" } }) } });
  const failingRepository = createSupabaseAdminAnalyticsReadRepository({ client: () => failing.client });
  assert.deepEqual(
    await failingRepository.loadAdminAuditEntryRows({ eventTypes: ["admin_action"], filtered: true, from: 0, to: 24 }),
    { status: "error" },
  );
  assert.deepEqual(
    await failingRepository.loadAdminAuditEntryRows({ eventTypes: ["admin_action"], filtered: false, from: 0, to: 24 }),
    { status: "error" },
  );
});

test("Supabase admin analytics adapter reads access-info site_events and falls back to the legacy select", async () => {
  const since = "2026-08-01T00:00:00.000Z";
  const rows = [{ occurred_at: "2026-09-01T00:00:00.000Z", event_type: "page_view" }];

  const success = createFakeSupabase({ tables: { site_events: () => ({ data: rows, error: null }) } });
  assert.deepEqual(
    await createSupabaseAdminAnalyticsReadRepository({ client: () => success.client }).loadSiteEvents(since),
    { rows, schemaReady: true },
  );
  assert.equal(success.tableCalls.length, 1);
  assert.equal(success.tableCalls[0].select[0], SITE_EVENT_ACCESS_INFO_SELECT, "the access-info select must be tried first");
  assert.deepEqual(success.tableCalls[0].gtes, [["occurred_at", since]]);
  assert.deepEqual(success.tableCalls[0].orders, [["occurred_at", { ascending: false }]]);
  assert.deepEqual(success.tableCalls[0].limits, [10_000]);

  const fallback = createFakeSupabase({
    tables: {
      site_events: (info) => (info.select[0] === SITE_EVENT_ACCESS_INFO_SELECT
        ? { data: null, error: { message: "column client_ip_hash does not exist" } }
        : { data: rows, error: null }),
    },
  });
  assert.deepEqual(
    await createSupabaseAdminAnalyticsReadRepository({ client: () => fallback.client }).loadSiteEvents(since),
    { rows, schemaReady: true },
  );
  assert.equal(fallback.tableCalls.length, 2, "a schema error must trigger exactly one legacy fallback read");
  assert.equal(fallback.tableCalls[1].select[0], SITE_EVENT_BASE_SELECT, "the fallback must use the legacy base select");
  assert.deepEqual(fallback.tableCalls[1].gtes, [["occurred_at", since]]);
  assert.deepEqual(fallback.tableCalls[1].limits, [10_000]);

  const doubleFailure = createFakeSupabase({ tables: { site_events: () => ({ data: null, error: { message: "site_events missing" } }) } });
  assert.deepEqual(
    await createSupabaseAdminAnalyticsReadRepository({ client: () => doubleFailure.client }).loadSiteEvents(since),
    { rows: [], schemaReady: false },
    "both reads failing must resolve to an empty rows/schemaReady:false result",
  );
  assert.equal(doubleFailure.tableCalls.length, 2);
});

test("Supabase admin analytics adapter preserves the ingestion run read and its error fallback", async () => {
  const since = "2026-08-01T00:00:00.000Z";
  const rows = [{ source_key: "de-bverfg", status: "completed", discovered_count: 5 }];
  const fake = createFakeSupabase({ tables: { ingestion_runs: () => ({ data: rows, error: null }) } });
  assert.deepEqual(
    await createSupabaseAdminAnalyticsReadRepository({ client: () => fake.client }).loadIngestionRunRows(since),
    rows,
  );
  assert.equal(fake.tableCalls[0].table, "ingestion_runs");
  assert.equal(fake.tableCalls[0].select[0], INGESTION_RUN_SELECT, "the ingestion read must keep the exact select shape");
  assert.deepEqual(fake.tableCalls[0].gtes, [["started_at", since]]);
  assert.deepEqual(fake.tableCalls[0].orders, [["started_at", { ascending: false }]]);
  assert.deepEqual(fake.tableCalls[0].limits, [1000]);

  const failing = createFakeSupabase({ tables: { ingestion_runs: () => ({ data: null, error: { message: "runs down" } }) } });
  assert.deepEqual(
    await createSupabaseAdminAnalyticsReadRepository({ client: () => failing.client }).loadIngestionRunRows(since),
    [],
  );
});

test("Supabase admin analytics adapter pages article rows and keeps partial rows on a later page error", async () => {
  const firstPage = Array.from({ length: 1000 }, (_, index) => ({
    status: "summarized",
    source_key: "de-bverfg",
    updated_at: `2026-01-01T00:00:${String(index % 60).padStart(2, "0")}.000Z`,
  }));

  const ok = createFakeSupabase({
    tables: {
      articles: (info) => (info.ranges[0]?.[0] === 0
        ? { data: firstPage, error: null }
        : { data: [{ status: "cleaned" }], error: null }),
    },
  });
  const rows = await createSupabaseAdminAnalyticsReadRepository({ client: () => ok.client }).loadArticleSummaryRows();
  assert.equal(rows.length, 1001, "paging must continue until a short page with no artificial cap");
  assert.equal(ok.tableCalls[0].select[0], ARTICLE_SUMMARY_SELECT, "the article read must keep the exact select shape");
  assert.deepEqual(ok.tableCalls.map((call) => call.ranges), [[[0, 999]], [[1000, 1999]]]);

  const partial = createFakeSupabase({
    tables: {
      articles: (info) => (info.ranges[0]?.[0] === 0
        ? { data: firstPage, error: null }
        : { data: null, error: { message: "second page boom" } }),
    },
  });
  const partialRows = await createSupabaseAdminAnalyticsReadRepository({ client: () => partial.client }).loadArticleSummaryRows();
  assert.equal(partialRows.length, 1000, "partial rows must survive a later page error");
  assert.equal(partial.tableCalls.length, 2);
});

test("Supabase admin analytics adapter returns the raw health snapshot payload and null on error", async () => {
  const payload = { collectionHealth: [{ sourceKey: "de-bverfg", runs: 3 }], modelHealth: [] };
  const ok = createFakeSupabase({ rpc: () => ({ data: payload, error: null }) });
  assert.deepEqual(
    await createSupabaseAdminAnalyticsReadRepository({ client: () => ok.client }).loadAnalyticsHealthSnapshot(30),
    payload,
  );
  assert.deepEqual(ok.rpcCalls, ["rpc_admin_analytics_health_snapshot"]);

  const failing = createFakeSupabase({ rpc: () => ({ data: null, error: { message: "snapshot down" } }) });
  assert.equal(
    await createSupabaseAdminAnalyticsReadRepository({ client: () => failing.client }).loadAnalyticsHealthSnapshot(30),
    null,
    "an RPC error must resolve to null so the caller falls back",
  );

  const empty = createFakeSupabase({ rpc: () => ({ data: null, error: null }) });
  assert.equal(
    await createSupabaseAdminAnalyticsReadRepository({ client: () => empty.client }).loadAnalyticsHealthSnapshot(30),
    null,
    "a null payload must resolve to null so the caller falls back",
  );
});

test("getAdminAuditLogData returns the empty no-config audit page", async () => {
  await withSupabaseEnv({}, async () => {
    const data = await getAdminAuditLogData({ eventType: "admin_action", action: "publish", q: "x", page: 2, pageSize: 10 });
    assert.equal(data.hasDatabase, false);
    assert.equal(data.schemaReady, true, "the no-config audit page must report schemaReady:true");
    assert.deepEqual(data.entries, []);
    assert.deepEqual(data.actionOptions, []);
    assert.deepEqual(data.filters, { eventType: "admin_action", action: "publish", q: "x", page: 2, pageSize: 10 });
    assert.deepEqual(data.pageInfo, { page: 2, pageSize: 10, total: 0, hasMore: false });
  });
});

test("getAdminAuditLogData delegates to the audit repository when configured", async () => {
  const events = [
    { id: "e1", occurred_at: "2026-09-01T00:00:00.000Z", event_type: "admin_action", path: "/api/admin/x", metadata: { action: "publish", sourceKey: "de-bverfg" } },
  ];

  await withFetch(auditFetch(events, 1), async () => {
    await withSupabaseEnv(CONFIGURED_ENV, async () => {
      const filtered = await getAdminAuditLogData({ action: "publish" });
      assert.equal(filtered.hasDatabase, true);
      assert.equal(filtered.schemaReady, true);
      assert.equal(filtered.entries.length, 1);
      assert.equal(filtered.entries[0].action, "publish");
      assert.equal(filtered.entries[0].sourceKey, "de-bverfg");
      assert.deepEqual(filtered.actionOptions, ["publish"]);
      assert.equal(filtered.pageInfo.total, 1);

      const ranged = await getAdminAuditLogData({ page: 1, pageSize: 25 });
      assert.equal(ranged.entries.length, 1, "the unfiltered branch must map the ranged rows");
      assert.equal(ranged.pageInfo.total, 1, "the exact count must flow into the page info");
      assert.equal(ranged.pageInfo.hasMore, false);
    });
  });
});

test("getAdminAuditLogData reports schemaReady false when the configured audit read errors", async () => {
  await withFetch(
    (url) => (url.includes("/rest/v1/site_events") ? jsonResponse({ message: "audit down" }, 500) : jsonResponse([])),
    async () => {
      await withSupabaseEnv(CONFIGURED_ENV, async () => {
        const data = await getAdminAuditLogData({ action: "publish" });
        assert.equal(data.hasDatabase, true, "a configured database must report hasDatabase even on read error");
        assert.equal(data.schemaReady, false);
        assert.deepEqual(data.entries, []);
        assert.deepEqual(data.pageInfo, { page: 1, pageSize: 25, total: 0, hasMore: false });
      });
    },
  );
});

test("getAnalyticsDashboardData returns the empty no-config dashboard", async () => {
  await withSupabaseEnv({}, async () => {
    const dashboard = await getAnalyticsDashboardData();
    assert.equal(dashboard.hasDatabase, false);
    assert.equal(dashboard.schemaReady, false);
    assert.equal(dashboard.totals.totalEvents, 0);
    assert.deepEqual(dashboard.accessLogs, []);
    assert.deepEqual(dashboard.collectionHealth, []);
    assert.deepEqual(dashboard.modelHealth, []);
    assert.equal(dashboard.recommendations.length, 1, "the no-schema recommendation must still be emitted");
  });
});

test("getAnalyticsDashboardData maps the configured dashboard through the repository", async () => {
  const events = [
    { occurred_at: "2026-09-01T00:00:00.000Z", event_type: "page_view", path: "/" },
    { occurred_at: "2026-09-01T01:00:00.000Z", event_type: "search", search_query: "표현", result_count: 0 },
  ];

  await withFetch(
    analyticsFetch({
      events,
      snapshot: () => jsonResponse({ collectionHealth: [{ sourceKey: "de-bverfg", runs: 2, discovered: 10, fetched: 5, fetchRate: 50 }], modelHealth: [] }),
    }),
    async () => {
      await withSupabaseEnv(CONFIGURED_ENV, async () => {
        const dashboard = await getAnalyticsDashboardData({ days: 7 });
        assert.equal(dashboard.hasDatabase, true);
        assert.equal(dashboard.schemaReady, true);
        assert.equal(dashboard.days, 7);
        assert.equal(dashboard.totals.totalEvents, 2);
        assert.equal(dashboard.totals.pageViews, 1);
        assert.equal(dashboard.totals.searches, 1);
        assert.equal(dashboard.totals.zeroResultSearches, 1);
        assert.equal(dashboard.collectionHealth[0].sourceKey, "de-bverfg");
        assert.equal(dashboard.collectionHealth[0].fetchRate, 50);
      });
    },
  );
});

test("getAnalyticsDashboardData falls back to the legacy health reads when the snapshot fails", async () => {
  const runs = [
    { source_key: "de-bverfg", status: "completed", discovered_count: 10, fetched_count: 5, summarized_count: 5, failed_count: 1, started_at: "2026-09-01T00:00:00.000Z" },
  ];
  const articles = [
    { status: "summarized", summary_json: { aiMetadata: { provider: "anthropic", model: "claude-x" } } },
    { status: "failed_summary", error_metadata: { requestedModel: "gemini-x" } },
  ];

  await withFetch(
    analyticsFetch({ snapshot: () => jsonResponse({ message: "down" }, 500), events: [], runs, articles }),
    async () => {
      await withSupabaseEnv(CONFIGURED_ENV, async () => {
        const dashboard = await getAnalyticsDashboardData();
        assert.equal(dashboard.hasDatabase, true);
        const source = dashboard.collectionHealth.find((row) => row.sourceKey === "de-bverfg");
        assert.equal(source?.runs, 1);
        assert.equal(source?.fetchRate, 50);
        assert.ok(dashboard.modelHealth.some((row) => row.model === "claude-x" && row.successes === 1));
        assert.ok(dashboard.modelHealth.some((row) => row.model === "gemini-x" && row.failures === 1));
      });
    },
  );
});

test("getAnalyticsDashboardData records the analytics compatibility observation for new and fallback authority", async () => {
  const observations: Array<{ surface: string; authority: string; outcome: string }> = [];
  setCompatibilityObservationWriterForTests(async (observation) => {
    observations.push({ surface: observation.surface, authority: observation.authority, outcome: observation.outcome });
  });

  try {
    await withFetch(analyticsFetch({ snapshot: () => jsonResponse({ collectionHealth: [], modelHealth: [] }) }), async () => {
      await withSupabaseEnv(
        {
          ...CONFIGURED_ENV,
          ADMIN_P5_COMPATIBILITY_OBSERVATION_ENABLED: "true",
          ADMIN_P5_COMPATIBILITY_OBSERVATION_SAMPLE_RATE: "1",
        },
        async () => {
          await getAnalyticsDashboardData();
        },
      );
    });
    assert.deepEqual(observations, [{ surface: "admin_analytics", authority: "new", outcome: "succeeded" }]);

    await withFetch(analyticsFetch({ snapshot: () => jsonResponse({ message: "down" }, 500) }), async () => {
      await withSupabaseEnv(
        {
          ...CONFIGURED_ENV,
          ADMIN_P5_COMPATIBILITY_OBSERVATION_ENABLED: "true",
          ADMIN_P5_COMPATIBILITY_OBSERVATION_SAMPLE_RATE: "1",
        },
        async () => {
          await getAnalyticsDashboardData();
        },
      );
    });
    assert.deepEqual(observations[1], { surface: "admin_analytics", authority: "fallback", outcome: "fallback" });
  } finally {
    setCompatibilityObservationWriterForTests(null);
  }
});

test("lib/db/analytics.ts keeps no direct Supabase coupling", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "lib/db/analytics.ts"), "utf8");
  assert.doesNotMatch(source, /getSupabaseAdmin/, "lib/db/analytics.ts must not call getSupabaseAdmin");
  assert.doesNotMatch(source, /(?<!Array)\.from\(/, "lib/db/analytics.ts must not build Supabase table queries");
  assert.doesNotMatch(source, /\.rpc\(/, "lib/db/analytics.ts must not call Supabase RPCs");
  assert.match(source, /adminAnalyticsReads\(\)/, "lib/db/analytics.ts must delegate to the privileged analytics read repository");
});

test("the admin analytics read contract exposes no Supabase/Postgres types", () => {
  const types = fs.readFileSync(path.join(process.cwd(), "lib/admin/analytics-read-repository/types.ts"), "utf8");
  assert.ok(!types.includes("@supabase"), "the contract must not import Supabase types");
  assert.ok(!types.includes("SupabaseClient"), "the contract must not reference the Supabase client type");
});
