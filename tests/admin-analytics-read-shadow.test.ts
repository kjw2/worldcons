import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  type D1RuntimeDatabase,
  type D1RuntimePreparedStatement,
} from "../lib/cloudflare/d1/runtime-binding";
import {
  D1_SHADOW_ADMIN_ANALYTICS_READ_SURFACE,
  D1_SHADOW_DEFAULT_MAX_IN_FLIGHT,
  D1_SHADOW_DEFAULT_MAX_ROWS,
  D1_SHADOW_DEFAULT_SAMPLE_RATE,
  D1_SHADOW_DEFAULT_TIMEOUT_MS,
  resolveD1ShadowConfig,
  type D1ShadowConfig,
} from "../lib/cloudflare/d1/shadow/config";
import { resetShadowInFlight } from "../lib/cloudflare/d1/shadow/inflight";
import type { D1ShadowEvent } from "../lib/cloudflare/d1/shadow/events";
import type { RuntimeBackgroundScheduler } from "../lib/runtime/background";
import {
  adminAnalyticsReadShadowCoveredMethods,
  withAdminAnalyticsReadShadow,
} from "../lib/admin/analytics-read-repository/shadow";
import { createD1AdminAnalyticsReadRepository } from "../lib/admin/analytics-read-repository/d1-read-repository";
import {
  adminAnalyticsReads,
  failClosedAdminAnalyticsReads,
} from "../lib/admin/analytics-read-repository";
import type {
  AdminAnalyticsReadRepository,
  AdminAnalyticsSiteEventRow,
  AdminAuditEntryRowsResult,
} from "../lib/admin/analytics-read-repository/types";

/**
 * M6.4 privileged admin analytics/audit read shadow tests: exact database
 * routing, bounded reads, truncation-as-skip, RPC zero-D1 skips, exact count and
 * range semantics, comparison contracts, authoritative identity, default-off,
 * compare-disabled, scheduler rejection, timeout/backpressure and
 * row-content-free events (including no IP/UA/content leakage). Every test
 * injects its config, bindings, scheduler, sampler and sink.
 */

const IDENT = "[a-z_][a-z0-9_]*";

interface CapturedStatement {
  sql: string;
  params: unknown[];
  table: string;
}

function evaluate(sql: string, params: unknown[], tables: Record<string, Record<string, unknown>[]>) {
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
  const orderMatch = new RegExp(` order by (.*?)(?= limit | offset |$)`).exec(sql);
  if (orderMatch) {
    const clauses = orderMatch[1].split(", ").map((entry) => {
      const [column, direction] = entry.split(" ");
      return { column, desc: direction === "desc" };
    });
    rows.sort((left, right) => {
      for (const clause of clauses) {
        const a = left[clause.column];
        const b = right[clause.column];
        if (a === b) continue;
        if (a == null) return 1;
        if (b == null) return -1;
        if (a < b) return clause.desc ? 1 : -1;
        return clause.desc ? -1 : 1;
      }
      return 0;
    });
  }
  const offset = / offset \?/.test(sql) ? Number(params[p++]) : 0;
  const limit = / limit \?/.test(sql) ? Number(params[p++]) : undefined;
  if (offset) rows = rows.slice(offset);
  if (limit !== undefined) rows = rows.slice(0, limit);
  return { table, rows };
}

function createFakeD1(tables: Record<string, Record<string, unknown>[]>, delayMs = 0, failing = false) {
  const calls: CapturedStatement[] = [];
  const database: D1RuntimeDatabase = {
    prepare(sql: string): D1RuntimePreparedStatement {
      let params: unknown[] = [];
      const statement: D1RuntimePreparedStatement = {
        bind(...values: unknown[]) {
          params = values;
          return statement;
        },
        async all<T = Record<string, unknown>>() {
          if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
          if (failing) throw Object.assign(new Error("d1 unavailable"), { code: "d1_runtime_read.query_failed" });
          const evaluated = evaluate(sql, params, tables);
          calls.push({ sql, params, table: evaluated.table });
          return { success: true, results: evaluated.rows as unknown as T[] };
        },
      };
      return statement;
    },
  };
  return { database, calls };
}

function createCollectorScheduler(accept = true) {
  const tasks: Promise<unknown>[] = [];
  const scheduler: RuntimeBackgroundScheduler = {
    schedule(task: Promise<unknown>) {
      if (!accept) return false;
      tasks.push(task);
      return true;
    },
  };
  return {
    scheduler,
    async flush() {
      await Promise.allSettled(tasks);
    },
    count: () => tasks.length,
  };
}

function captureEvents() {
  const events: D1ShadowEvent[] = [];
  return { events, sink: (event: D1ShadowEvent) => events.push(event) };
}

const EVENT_ROWS: AdminAnalyticsSiteEventRow[] = [
  { id: "e1", occurred_at: "2026-09-02T00:00:00.000Z", event_type: "admin_action", path: "/api/admin/x", article_slug: "a1", source_key: "de-bverfg", metadata: { action: "publish" } },
  { id: "e2", occurred_at: "2026-09-01T00:00:00.000Z", event_type: "admin_review_action", path: "/api/admin/y", article_slug: null, source_key: null, metadata: { action: "review" } },
];

const INGESTION_ROWS = [
  { source_key: "de-bverfg", status: "completed", discovered_count: 5, fetched_count: 4, summarized_count: 3, failed_count: 1, started_at: "2026-09-01T00:00:00.000Z" },
  { source_key: "us-scotus", status: "failed", discovered_count: 2, fetched_count: 1, summarized_count: 0, failed_count: 1, started_at: "2026-09-02T00:00:00.000Z" },
];

const ARTICLE_ROWS = [
  { status: "summarized", source_key: "de-bverfg", summary_json: { aiMetadata: { model: "claude" } }, error_metadata: null, source_metadata: null, summarized_at: "2026-09-01T00:00:00.000Z", updated_at: "2026-09-01T00:00:00.000Z" },
  { status: "failed_summary", source_key: "us-scotus", summary_json: null, error_metadata: { requestedModel: "gemini" }, source_metadata: null, summarized_at: null, updated_at: "2026-09-02T00:00:00.000Z" },
];

const SINCE = "2026-08-01T00:00:00.000Z";

/** The access-info select has no `id` column, so these rows omit it. */
const SITE_EVENT_ACCESS_ROWS: AdminAnalyticsSiteEventRow[] = EVENT_ROWS.map((row) => {
  return {
    occurred_at: row.occurred_at,
    event_type: row.event_type,
    path: row.path ?? null,
    article_slug: row.article_slug ?? null,
    article_title: row.article_title ?? null,
    tag_slug: row.tag_slug ?? null,
    tag_name: row.tag_name ?? null,
    source_key: row.source_key ?? null,
    jurisdiction: row.jurisdiction ?? null,
    institution_name: row.institution_name ?? null,
    search_query: row.search_query ?? null,
    search_mode: row.search_mode ?? null,
    result_count: row.result_count ?? null,
    referrer_host: row.referrer_host ?? null,
    user_agent_family: row.user_agent_family ?? null,
    device_type: row.device_type ?? null,
    metadata: row.metadata ?? null,
    client_ip_hash: row.client_ip_hash ?? null,
    accept_language: row.accept_language ?? null,
    client_country: row.client_country ?? null,
    is_bot: row.is_bot ?? null,
  };
});

function baseConfig(overrides: Partial<D1ShadowConfig> = {}): D1ShadowConfig {
  return {
    readEnabled: true,
    compareEnabled: true,
    surfaces: new Set([D1_SHADOW_ADMIN_ANALYTICS_READ_SURFACE]),
    timeoutMs: D1_SHADOW_DEFAULT_TIMEOUT_MS,
    maxRows: D1_SHADOW_DEFAULT_MAX_ROWS,
    maxInFlight: D1_SHADOW_DEFAULT_MAX_IN_FLIGHT,
    sampleRate: 1,
    ...overrides,
  };
}

function createAuthoritative(overrides: Partial<AdminAnalyticsReadRepository> = {}): AdminAnalyticsReadRepository {
  return {
    isConfigured: () => true,
    async loadAdminAuditActionOptionRows() {
      return EVENT_ROWS;
    },
    async loadAdminAuditEntryRows(): Promise<AdminAuditEntryRowsResult> {
      return { status: "ok", rows: EVENT_ROWS, count: null };
    },
    async loadSiteEvents() {
      return { rows: SITE_EVENT_ACCESS_ROWS, schemaReady: true };
    },
    async loadIngestionRunRows() {
      return INGESTION_ROWS;
    },
    async loadArticleSummaryRows() {
      return ARTICLE_ROWS;
    },
    async loadAnalyticsHealthSnapshot() {
      return { collectionHealth: [], modelHealth: [] };
    },
    ...overrides,
  };
}

test("the admin analytics shadow covers exactly the six analytics methods", () => {
  assert.deepEqual([...adminAnalyticsReadShadowCoveredMethods()].sort(), [
    "loadAdminAuditActionOptionRows",
    "loadAdminAuditEntryRows",
    "loadAnalyticsHealthSnapshot",
    "loadArticleSummaryRows",
    "loadIngestionRunRows",
    "loadSiteEvents",
  ]);
});

test("admin_analytics_read is opt-in in the config default", () => {
  const off = resolveD1ShadowConfig({});
  assert.equal(off.readEnabled, false);
  assert.equal(off.surfaces.has(D1_SHADOW_ADMIN_ANALYTICS_READ_SURFACE), false);
  assert.equal(off.sampleRate, D1_SHADOW_DEFAULT_SAMPLE_RATE);
});

test("isConfigured is authoritative and synchronous with zero D1 calls or events", () => {
  resetShadowInFlight();
  const d1 = createFakeD1({ site_events: EVENT_ROWS as unknown as Record<string, unknown>[] });
  const collector = createCollectorScheduler();
  const { events, sink } = captureEvents();
  const repository = withAdminAnalyticsReadShadow(createAuthoritative(), {
    config: baseConfig(),
    opsBinding: d1.database,
    scheduler: collector.scheduler,
    sink,
  });
  assert.equal(repository.isConfigured(), true);
  assert.equal(d1.calls.length, 0);
  assert.equal(collector.count(), 0);
  assert.equal(events.length, 0);
});

test("all flags off does zero shadow work and returns authoritative identity", async () => {
  resetShadowInFlight();
  const d1 = createFakeD1({ site_events: EVENT_ROWS as unknown as Record<string, unknown>[] });
  const collector = createCollectorScheduler();
  const { events, sink } = captureEvents();
  const repository = withAdminAnalyticsReadShadow(createAuthoritative(), {
    config: baseConfig({ readEnabled: false, compareEnabled: false }),
    opsBinding: d1.database,
    scheduler: collector.scheduler,
    sink,
  });
  const rows = await repository.loadAdminAuditActionOptionRows(["admin_action"]);
  assert.equal(rows, EVENT_ROWS, "the exact authoritative array must be returned unchanged");
  assert.equal(d1.calls.length, 0);
  assert.equal(collector.count(), 0);
  assert.equal(events.length, 0);
});

test("loadAnalyticsHealthSnapshot RPC emits rpc_deferred and makes zero D1 calls", async () => {
  resetShadowInFlight();
  const d1 = createFakeD1({ site_events: [] });
  const collector = createCollectorScheduler();
  const { events, sink } = captureEvents();
  const payload = { collectionHealth: [{ sourceKey: "de-bverfg" }], modelHealth: [] };
  const repository = withAdminAnalyticsReadShadow(createAuthoritative({ loadAnalyticsHealthSnapshot: async () => payload }), {
    config: baseConfig(),
    opsBinding: d1.database,
    binding: d1.database,
    ingestBinding: d1.database,
    scheduler: collector.scheduler,
    sink,
  });
  const result = await repository.loadAnalyticsHealthSnapshot(30);
  assert.equal(result, payload);
  assert.equal(events[0].reason, "rpc_deferred");
  assert.equal(events[0].outcome, "skipped");
  assert.equal(events[0].method, "loadAnalyticsHealthSnapshot");
  assert.equal(d1.calls.length, 0);
  assert.equal(collector.count(), 0);
});

test("compare-off runs the D1 read but never compares", async () => {
  resetShadowInFlight();
  const d1 = createFakeD1({ site_events: EVENT_ROWS as unknown as Record<string, unknown>[] });
  const collector = createCollectorScheduler();
  const { events, sink } = captureEvents();
  const repository = withAdminAnalyticsReadShadow(createAuthoritative(), {
    config: baseConfig({ compareEnabled: false }),
    opsBinding: d1.database,
    scheduler: collector.scheduler,
    sink,
  });
  await repository.loadAdminAuditActionOptionRows(["admin_action", "admin_review_action"]);
  await collector.flush();
  assert.equal(events[0].outcome, "disabled");
  assert.equal(events[0].reason, "compare_disabled");
  assert.equal(events[0].readOutcome, "success");
  assert.equal(d1.calls.length, 1);
});

test("loadAdminAuditActionOptionRows routes to worldcons_ops, filters event_type and matches", async () => {
  resetShadowInFlight();
  const ops = createFakeD1({ site_events: EVENT_ROWS as unknown as Record<string, unknown>[] });
  const collector = createCollectorScheduler();
  const { events, sink } = captureEvents();
  const repository = withAdminAnalyticsReadShadow(createAuthoritative(), {
    config: baseConfig(),
    opsBinding: ops.database,
    scheduler: collector.scheduler,
    sink,
  });
  await repository.loadAdminAuditActionOptionRows(["admin_action", "admin_review_action"]);
  await collector.flush();
  assert.equal(events[0].outcome, "matched", `diffPath=${events[0].diffPath ?? "null"}`);
  assert.equal(events[0].db, "worldcons_ops");
  assert.equal(ops.calls[0].table, "site_events");
  assert.match(ops.calls[0].sql, /order by occurred_at desc/);
  const serialized = JSON.stringify(events[0]);
  assert.equal(serialized.includes("/api/admin"), false, "no path may be logged");
  assert.equal(serialized.includes("publish"), false, "no metadata content may be logged");
});

test("invalid/empty eventTypes skips before any D1 call", async () => {
  resetShadowInFlight();
  const ops = createFakeD1({ site_events: [] });
  const collector = createCollectorScheduler();
  const { events, sink } = captureEvents();
  const repository = withAdminAnalyticsReadShadow(createAuthoritative(), {
    config: baseConfig(),
    opsBinding: ops.database,
    scheduler: collector.scheduler,
    sink,
  });
  await repository.loadAdminAuditActionOptionRows([]);
  await collector.flush();
  assert.equal(events[0].outcome, "skipped");
  assert.equal(events[0].reason, "invalid_event_types");
  assert.equal(ops.calls.length, 0);
});

test("loadAdminAuditEntryRows filtered branch matches with a null count", async () => {
  resetShadowInFlight();
  const ops = createFakeD1({ site_events: EVENT_ROWS as unknown as Record<string, unknown>[] });
  const collector = createCollectorScheduler();
  const { events, sink } = captureEvents();
  const repository = withAdminAnalyticsReadShadow(createAuthoritative(), {
    config: baseConfig(),
    opsBinding: ops.database,
    scheduler: collector.scheduler,
    sink,
  });
  const result = await repository.loadAdminAuditEntryRows({ eventTypes: ["admin_action", "admin_review_action"], filtered: true, from: 0, to: 24 });
  assert.deepEqual(result, { status: "ok", rows: EVENT_ROWS, count: null });
  await collector.flush();
  assert.equal(events[0].outcome, "matched", `diffPath=${events[0].diffPath ?? "null"}`);
  assert.equal(ops.calls[0].table, "site_events");
});

test("loadAdminAuditEntryRows unfiltered branch compares exact rows and count", async () => {
  resetShadowInFlight();
  const ops = createFakeD1({ site_events: EVENT_ROWS as unknown as Record<string, unknown>[] });
  const collector = createCollectorScheduler();
  const { events, sink } = captureEvents();
  const authoritative = createAuthoritative({
    loadAdminAuditEntryRows: async () => ({ status: "ok", rows: [EVENT_ROWS[0]], count: 2 }),
  });
  const repository = withAdminAnalyticsReadShadow(authoritative, {
    config: baseConfig(),
    opsBinding: ops.database,
    scheduler: collector.scheduler,
    sink,
  });
  const result = await repository.loadAdminAuditEntryRows({ eventTypes: ["admin_action", "admin_review_action"], filtered: false, from: 0, to: 0 });
  assert.deepEqual(result, { status: "ok", rows: [EVENT_ROWS[0]], count: 2 });
  await collector.flush();
  assert.equal(events[0].outcome, "matched", `diffPath=${events[0].diffPath ?? "null"}`);
});

test("loadSiteEvents routes to worldcons_ops and compares the schemaReady result", async () => {
  resetShadowInFlight();
  const ops = createFakeD1({ site_events: SITE_EVENT_ACCESS_ROWS as unknown as Record<string, unknown>[] });
  const collector = createCollectorScheduler();
  const { events, sink } = captureEvents();
  const repository = withAdminAnalyticsReadShadow(createAuthoritative(), {
    config: baseConfig({ maxRows: 10_000 }),
    opsBinding: ops.database,
    scheduler: collector.scheduler,
    sink,
  });
  const result = await repository.loadSiteEvents(SINCE);
  assert.deepEqual(result, { rows: SITE_EVENT_ACCESS_ROWS, schemaReady: true });
  await collector.flush();
  assert.equal(events[0].outcome, "matched", `diffPath=${events[0].diffPath ?? "null"}`);
  assert.equal(events[0].db, "worldcons_ops");
  assert.match(ops.calls[0].sql, /from site_events/);
  assert.match(ops.calls[0].sql, /occurred_at >= \?/);
  assert.match(ops.calls[0].sql, /client_ip_hash/);
});

test("loadSiteEvents with the default maxRows below the 10k boundary skips, never partial", async () => {
  resetShadowInFlight();
  const ops = createFakeD1({ site_events: SITE_EVENT_ACCESS_ROWS as unknown as Record<string, unknown>[] });
  const collector = createCollectorScheduler();
  const { events, sink } = captureEvents();
  const repository = withAdminAnalyticsReadShadow(createAuthoritative(), {
    config: baseConfig(),
    opsBinding: ops.database,
    scheduler: collector.scheduler,
    sink,
  });
  await repository.loadSiteEvents(SINCE);
  await collector.flush();
  assert.equal(events[0].outcome, "skipped");
  assert.equal(events[0].reason, "limit_exceeds_max_rows");
  assert.equal(events[0].compared, false);
  assert.equal(ops.calls.length, 0);
});

test("loadIngestionRunRows routes to worldcons_ingest", async () => {
  resetShadowInFlight();
  const ops = createFakeD1({ site_events: [] });
  const ingest = createFakeD1({ ingestion_runs: INGESTION_ROWS });
  const collector = createCollectorScheduler();
  const { events, sink } = captureEvents();
  const repository = withAdminAnalyticsReadShadow(createAuthoritative(), {
    config: baseConfig(),
    opsBinding: ops.database,
    ingestBinding: ingest.database,
    scheduler: collector.scheduler,
    sink,
  });
  await repository.loadIngestionRunRows(SINCE);
  await collector.flush();
  assert.equal(events[0].outcome, "matched", `diffPath=${events[0].diffPath ?? "null"}`);
  assert.equal(events[0].db, "worldcons_ingest");
  assert.equal(ops.calls.length, 0, "ingestion runs must never read worldcons_ops");
  assert.equal(ingest.calls[0].table, "ingestion_runs");
  assert.match(ingest.calls[0].sql, /started_at >= \?/);
});

test("loadArticleSummaryRows routes to worldcons_core and matches unordered", async () => {
  resetShadowInFlight();
  const core = createFakeD1({ articles: ARTICLE_ROWS });
  const ingest = createFakeD1({ ingestion_runs: [] });
  const collector = createCollectorScheduler();
  const { events, sink } = captureEvents();
  const repository = withAdminAnalyticsReadShadow(createAuthoritative(), {
    config: baseConfig(),
    binding: core.database,
    ingestBinding: ingest.database,
    scheduler: collector.scheduler,
    sink,
  });
  await repository.loadArticleSummaryRows();
  await collector.flush();
  assert.equal(events[0].outcome, "matched", `diffPath=${events[0].diffPath ?? "null"}`);
  assert.equal(events[0].db, "worldcons_core");
  assert.equal(core.calls[0].table, "articles");
});

test("missing binding, missing scheduler, disallowed surface, sampling and rejection all skip", async () => {
  resetShadowInFlight();
  const ops = createFakeD1({ site_events: [] });
  const collector = createCollectorScheduler();

  const noBinding = captureEvents();
  const bindingRepository = withAdminAnalyticsReadShadow(createAuthoritative(), {
    config: baseConfig(),
    opsBinding: null,
    scheduler: collector.scheduler,
    sink: noBinding.sink,
  });
  await bindingRepository.loadAdminAuditActionOptionRows(["admin_action"]);
  assert.equal(noBinding.events[0].reason, "no_binding");
  assert.equal(noBinding.events[0].db, "worldcons_ops");
  assert.equal(ops.calls.length, 0);

  const noScheduler = captureEvents();
  const schedulerRepository = withAdminAnalyticsReadShadow(createAuthoritative(), {
    config: baseConfig(),
    opsBinding: ops.database,
    scheduler: null,
    sink: noScheduler.sink,
  });
  await schedulerRepository.loadAdminAuditActionOptionRows(["admin_action"]);
  assert.equal(noScheduler.events[0].reason, "no_scheduler");
  assert.equal(ops.calls.length, 0);

  const wrongSurface = captureEvents();
  const surfaceRepository = withAdminAnalyticsReadShadow(createAuthoritative(), {
    config: baseConfig({ surfaces: new Set(["reference"]) }),
    opsBinding: ops.database,
    scheduler: collector.scheduler,
    sink: wrongSurface.sink,
  });
  await surfaceRepository.loadAdminAuditActionOptionRows(["admin_action"]);
  assert.equal(wrongSurface.events[0].reason, "surface_not_allowed");

  const sampledOut = captureEvents();
  const sampleRepository = withAdminAnalyticsReadShadow(createAuthoritative(), {
    config: baseConfig({ sampleRate: 0.1 }),
    opsBinding: ops.database,
    scheduler: collector.scheduler,
    sink: sampledOut.sink,
    random: () => 0.9,
  });
  await sampleRepository.loadAdminAuditActionOptionRows(["admin_action"]);
  assert.equal(sampledOut.events[0].reason, "sampled_out");

  const rejected = captureEvents();
  const rejecting = createCollectorScheduler(false);
  const rejectRepository = withAdminAnalyticsReadShadow(createAuthoritative(), {
    config: baseConfig(),
    opsBinding: ops.database,
    scheduler: rejecting.scheduler,
    sink: rejected.sink,
  });
  await rejectRepository.loadAdminAuditActionOptionRows(["admin_action"]);
  assert.equal(rejected.events[0].reason, "scheduler_rejected");
  assert.equal(ops.calls.length, 0);
});

test("D1 errors and timeouts are swallowed into events and preserve the primary", async () => {
  resetShadowInFlight();
  const failing = createFakeD1({ site_events: [] }, 0, true);
  const collector = createCollectorScheduler();
  const { events, sink } = captureEvents();
  const repository = withAdminAnalyticsReadShadow(createAuthoritative(), {
    config: baseConfig(),
    opsBinding: failing.database,
    scheduler: collector.scheduler,
    sink,
  });
  assert.equal(await repository.loadAdminAuditActionOptionRows(["admin_action"]), EVENT_ROWS);
  await collector.flush();
  assert.equal(events[0].outcome, "error");
  assert.equal(events[0].errorCode, "d1_runtime_read.query_failed");

  resetShadowInFlight();
  const slow = createFakeD1({ site_events: [] }, 40);
  const timeoutCollector = createCollectorScheduler();
  const timeoutEvents = captureEvents();
  const timeoutRepository = withAdminAnalyticsReadShadow(createAuthoritative(), {
    config: baseConfig({ timeoutMs: 1 }),
    opsBinding: slow.database,
    scheduler: timeoutCollector.scheduler,
    sink: timeoutEvents.sink,
  });
  assert.equal(await timeoutRepository.loadAdminAuditActionOptionRows(["admin_action"]), EVENT_ROWS);
  await timeoutCollector.flush();
  assert.equal(timeoutEvents.events[0].outcome, "timeout");
  assert.equal(timeoutEvents.events[0].readOutcome, "timeout");
});

test("per-isolate max in-flight applies backpressure to a second read", async () => {
  resetShadowInFlight();
  const ops = createFakeD1({ site_events: EVENT_ROWS as unknown as Record<string, unknown>[] }, 20);
  const collector = createCollectorScheduler();
  const { events, sink } = captureEvents();
  const repository = withAdminAnalyticsReadShadow(createAuthoritative(), {
    config: baseConfig({ maxInFlight: 1 }),
    opsBinding: ops.database,
    scheduler: collector.scheduler,
    sink,
  });
  await repository.loadAdminAuditActionOptionRows(["admin_action"]);
  await repository.loadAdminAuditActionOptionRows(["admin_action"]);
  await collector.flush();
  assert.ok(events.map((event) => event.reason).includes("backpressure"));
  assert.equal(ops.calls.length, 1, "the backpressured read must not touch D1");
});

test("audit action-option overflow and insufficient maxRows skip rather than approximate", async () => {
  resetShadowInFlight();
  const many = Array.from({ length: 5 }, (_, index) => ({ ...EVENT_ROWS[0], id: `e${index}` }));
  const ops = createFakeD1({ site_events: many as unknown as Record<string, unknown>[] });
  const collector = createCollectorScheduler();

  const insufficient = captureEvents();
  const insufficientRepository = withAdminAnalyticsReadShadow(createAuthoritative(), {
    config: baseConfig({ maxRows: 10 }),
    opsBinding: ops.database,
    scheduler: collector.scheduler,
    sink: insufficient.sink,
  });
  await insufficientRepository.loadAdminAuditActionOptionRows(["admin_action"]);
  await collector.flush();
  assert.equal(insufficient.events[0].reason, "limit_exceeds_max_rows");
  assert.equal(ops.calls.length, 0);

  const tiny = createFakeD1({ site_events: [] });
  const tinyEvents = captureEvents();
  const tinyRepository = withAdminAnalyticsReadShadow(createAuthoritative(), {
    config: baseConfig({ maxRows: 2 }),
    opsBinding: tiny.database,
    scheduler: collector.scheduler,
    sink: tinyEvents.sink,
  });
  await tinyRepository.loadAdminAuditActionOptionRows(["admin_action"]);
  await collector.flush();
  assert.equal(tinyEvents.events[0].reason, "limit_exceeds_max_rows");
  assert.equal(tiny.calls.length, 0);
});

test("article summary overflow skips (never emulates Supabase partial-row-on-error)", async () => {
  resetShadowInFlight();
  const core = createFakeD1({ articles: ARTICLE_ROWS });
  const collector = createCollectorScheduler();
  const { events, sink } = captureEvents();
  const repository = withAdminAnalyticsReadShadow(createAuthoritative(), {
    config: baseConfig({ maxRows: 1 }),
    binding: core.database,
    scheduler: collector.scheduler,
    sink,
  });
  await repository.loadArticleSummaryRows();
  await collector.flush();
  assert.equal(events[0].reason, "shadow_truncated");
  assert.equal(events[0].compared, false);
});

test("the D1 adapter loadSiteEvents uses the access-info columns and reports schemaReady true", async () => {
  const ops = createFakeD1({ site_events: SITE_EVENT_ACCESS_ROWS as unknown as Record<string, unknown>[] });
  const repository = createD1AdminAnalyticsReadRepository({ opsBinding: ops.database, maxRows: 10_000 });
  const result = await repository.loadSiteEvents(SINCE);
  assert.equal(result.schemaReady, true);
  assert.equal(result.rows.length, 2);
  assert.match(ops.calls[0].sql, /client_ip_hash/);
  assert.match(ops.calls[0].sql, /accept_language/);
  assert.match(ops.calls[0].sql, /client_country/);
  assert.match(ops.calls[0].sql, /is_bot/);
  assert.match(ops.calls[0].sql, /limit \?/);
  assert.equal(ops.calls[0].params[ops.calls[0].params.length - 1], 10_001);
});

test("the D1 adapter loadAdminAuditEntryRows returns the exact range slice and count", async () => {
  const ops = createFakeD1({ site_events: EVENT_ROWS as unknown as Record<string, unknown>[] });
  const repository = createD1AdminAnalyticsReadRepository({ opsBinding: ops.database, maxRows: 100 });
  const result = await repository.loadAdminAuditEntryRows({ eventTypes: ["admin_action", "admin_review_action"], filtered: false, from: 0, to: 0 });
  assert.ok(result.status === "ok");
  assert.deepEqual(result.rows.map((row) => row.id), ["e1"]);
  assert.equal(result.count, 2);
});

test("selection point returns the fail-closed adapter unwrapped without Supabase config", async () => {
  const keys = ["SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"] as const;
  const original = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  try {
    assert.equal(adminAnalyticsReads(), failClosedAdminAnalyticsReads);
    assert.equal(adminAnalyticsReads().isConfigured(), false);
    assert.deepEqual(await adminAnalyticsReads().loadSiteEvents(SINCE), { rows: [], schemaReady: false });
  } finally {
    for (const key of keys) {
      const value = original.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("selection point wraps the Supabase adapter (not the fail-closed one) when configured", () => {
  const keys = ["SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"] as const;
  const original = new Map(keys.map((key) => [key, process.env[key]]));
  process.env.SUPABASE_URL = "https://admin-analytics-m64.test.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
  try {
    const repository = adminAnalyticsReads();
    assert.notEqual(repository, failClosedAdminAnalyticsReads);
    assert.equal(repository.isConfigured(), true);
  } finally {
    for (const key of keys) {
      const value = original.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("the admin analytics D1 adapter imports no Node builtin and performs no D1 write", () => {
  const files = [
    "lib/admin/analytics-read-repository/d1-read-repository.ts",
    "lib/admin/analytics-read-repository/shadow.ts",
  ];
  for (const file of files) {
    const source = fs.readFileSync(path.join(process.cwd(), file), "utf8");
    assert.doesNotMatch(source, /from\s+["']node:/, `${file} must not import a node: builtin`);
    assert.doesNotMatch(source, /cloudflare\/d1\/remote/, `${file} must not import the remote operator`);
    assert.doesNotMatch(source, /\binsert\s+into\b|\bupdate\s+\w+\s+set\b|\bdelete\s+from\b|\bon\s+conflict\b/i, `${file} must not write`);
    assert.doesNotMatch(source, /\.run\(|\.batch\(/, `${file} must not use a D1 write method`);
  }
});
