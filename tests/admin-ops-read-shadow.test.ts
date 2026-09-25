import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  type D1RuntimeDatabase,
  type D1RuntimePreparedStatement,
} from "../lib/cloudflare/d1/runtime-binding";
import {
  D1_SHADOW_ADMIN_OPS_READ_SURFACE,
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
import { adminOpsReadShadowCoveredMethods, withAdminOpsReadShadow } from "../lib/admin/ops-read-repository/shadow";
import { createD1AdminOpsReadRepository } from "../lib/admin/ops-read-repository/d1-read-repository";
import {
  adminOpsReads,
  createSupabaseAdminOpsReadRepository,
  mockAdminOpsReads,
} from "../lib/admin/ops-read-repository";
import type {
  AdminOpsArticleListPage,
  AdminOpsArticleListRow,
  AdminOpsArticleRow,
  AdminOpsCandidateRow,
  AdminOpsReadRepository,
} from "../lib/admin/ops-read-repository/types";

/**
 * M6.4 privileged admin/ops read shadow tests: exact database routing, bounded
 * reads, truncation-as-skip, RPC/search zero-D1 skips, comparison contracts,
 * authoritative identity, default-off, compare-disabled, scheduler rejection,
 * timeout/backpressure and row-content-free events. Every test injects its
 * config, bindings, scheduler, sampler and sink.
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

const ARTICLE_ROWS: AdminOpsArticleRow[] = [
  {
    id: "a1",
    slug: "a1",
    source_key: "de-bverfg",
    jurisdiction: "Germany",
    institution_name: "BVerfG",
    original_url: "https://example.test/a1",
    original_title: "Title A1",
    korean_title: "제목 A1",
    original_published_at: "2026-04-01T00:00:00.000Z",
    fetched_at: "2026-04-01T01:00:00.000Z",
    summarized_at: "2026-04-01T02:00:00.000Z",
    status: "summarized",
    source_metadata: { collection: { publishable: true } },
    error_metadata: null,
    updated_at: "2026-04-02T00:00:00.000Z",
  },
  {
    id: "a2",
    slug: "a2",
    source_key: "us-scotus",
    jurisdiction: "United States",
    institution_name: "SCOTUS",
    original_url: "https://example.test/a2",
    original_title: "Title A2",
    korean_title: null,
    original_published_at: "2026-04-03T00:00:00.000Z",
    fetched_at: null,
    summarized_at: null,
    status: "needs_review",
    source_metadata: { collection: { publishable: false } },
    error_metadata: { class: "x" },
    updated_at: "2026-04-04T00:00:00.000Z",
  },
];

const CANDIDATE_ROWS: AdminOpsCandidateRow[] = [
  { source_key: "de-bverfg", status: "pending", candidate_type: "listing", created_at: "2026-04-01T00:00:00.000Z", last_attempt_at: null },
  { source_key: "fr-conseil", status: "failed", candidate_type: "sitemap", created_at: "2026-04-02T00:00:00.000Z", last_attempt_at: "2026-04-03T00:00:00.000Z" },
];

function d1ArticleRow(row: AdminOpsArticleRow, summaryJson: unknown = null) {
  return { ...row, summary_json: summaryJson } as Record<string, unknown>;
}

function baseConfig(overrides: Partial<D1ShadowConfig> = {}): D1ShadowConfig {
  return {
    readEnabled: true,
    compareEnabled: true,
    surfaces: new Set([D1_SHADOW_ADMIN_OPS_READ_SURFACE]),
    timeoutMs: D1_SHADOW_DEFAULT_TIMEOUT_MS,
    maxRows: D1_SHADOW_DEFAULT_MAX_ROWS,
    maxInFlight: D1_SHADOW_DEFAULT_MAX_IN_FLIGHT,
    sampleRate: 1,
    ...overrides,
  };
}

function createAuthoritative(overrides: Partial<AdminOpsReadRepository> = {}): AdminOpsReadRepository {
  return {
    isConfigured: () => true,
    async loadDashboardSnapshot() {
      return { totals: { articles: 2 } };
    },
    async loadArticleRows() {
      return ARTICLE_ROWS;
    },
    async loadCandidateRows() {
      return CANDIDATE_ROWS;
    },
    async countTableRows(_table, fallback) {
      return fallback;
    },
    async listAdminArticles(): Promise<AdminOpsArticleListPage> {
      return { rows: [], pageInfo: { page: 1, pageSize: 25, total: 0, hasMore: false, totalIsExact: true } };
    },
    ...overrides,
  };
}

test("the admin ops shadow covers exactly the five ops methods", () => {
  assert.deepEqual([...adminOpsReadShadowCoveredMethods()].sort(), [
    "countTableRows",
    "listAdminArticles",
    "loadArticleRows",
    "loadCandidateRows",
    "loadDashboardSnapshot",
  ]);
});

test("admin_ops_read is opt-in in the config default (surfaces stay reference-only)", () => {
  const off = resolveD1ShadowConfig({});
  assert.equal(off.readEnabled, false);
  assert.equal(off.surfaces.has(D1_SHADOW_ADMIN_OPS_READ_SURFACE), false);
  assert.equal(off.sampleRate, D1_SHADOW_DEFAULT_SAMPLE_RATE);
});

test("isConfigured is authoritative and synchronous with zero D1 calls or events", () => {
  resetShadowInFlight();
  const d1 = createFakeD1({ articles: ARTICLE_ROWS.map((row) => d1ArticleRow(row)) });
  const collector = createCollectorScheduler();
  const { events, sink } = captureEvents();
  const repository = withAdminOpsReadShadow(createAuthoritative(), {
    config: baseConfig(),
    binding: d1.database,
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
  const d1 = createFakeD1({ articles: ARTICLE_ROWS.map((row) => d1ArticleRow(row)) });
  const collector = createCollectorScheduler();
  const { events, sink } = captureEvents();
  const repository = withAdminOpsReadShadow(createAuthoritative(), {
    config: baseConfig({ readEnabled: false, compareEnabled: false }),
    binding: d1.database,
    scheduler: collector.scheduler,
    sink,
  });

  const rows = await repository.loadArticleRows();
  assert.equal(rows, ARTICLE_ROWS, "the exact authoritative array must be returned unchanged");
  assert.equal(d1.calls.length, 0);
  assert.equal(collector.count(), 0);
  assert.equal(events.length, 0);
});

test("loadDashboardSnapshot RPC emits rpc_deferred and makes zero D1 calls", async () => {
  resetShadowInFlight();
  const d1 = createFakeD1({ articles: [] });
  const collector = createCollectorScheduler();
  const { events, sink } = captureEvents();
  const payload = { totals: { articles: 2 } };
  const repository = withAdminOpsReadShadow(createAuthoritative({ loadDashboardSnapshot: async () => payload }), {
    config: baseConfig(),
    binding: d1.database,
    ingestBinding: d1.database,
    scheduler: collector.scheduler,
    sink,
  });

  const result = await repository.loadDashboardSnapshot();
  assert.equal(result, payload, "the exact authoritative RPC result must be returned");
  assert.equal(events[0].reason, "rpc_deferred");
  assert.equal(events[0].outcome, "skipped");
  assert.equal(events[0].method, "loadDashboardSnapshot");
  assert.equal(events[0].db, "worldcons_core");
  assert.equal(d1.calls.length, 0);
  assert.equal(collector.count(), 0);
});

test("compare-off runs the D1 read but never compares", async () => {
  resetShadowInFlight();
  const d1 = createFakeD1({ articles: ARTICLE_ROWS.map((row) => d1ArticleRow(row)) });
  const collector = createCollectorScheduler();
  const { events, sink } = captureEvents();
  const repository = withAdminOpsReadShadow(createAuthoritative(), {
    config: baseConfig({ compareEnabled: false }),
    binding: d1.database,
    scheduler: collector.scheduler,
    sink,
  });

  await repository.loadArticleRows();
  await collector.flush();
  assert.equal(events[0].outcome, "disabled");
  assert.equal(events[0].reason, "compare_disabled");
  assert.equal(events[0].compared, false);
  assert.equal(events[0].readOutcome, "success");
  assert.equal(d1.calls.length, 1);
});

test("loadArticleRows compares unordered by id and emits row-content-free evidence", async () => {
  resetShadowInFlight();
  const d1 = createFakeD1({ articles: [...ARTICLE_ROWS].reverse().map((row) => d1ArticleRow(row)) });
  const collector = createCollectorScheduler();
  const { events, sink } = captureEvents();
  const repository = withAdminOpsReadShadow(createAuthoritative(), {
    config: baseConfig(),
    binding: d1.database,
    scheduler: collector.scheduler,
    sink,
  });

  await repository.loadArticleRows();
  await collector.flush();
  assert.equal(events[0].outcome, "matched", `diffPath=${events[0].diffPath ?? "null"}`);
  assert.equal(events[0].compared, true);
  assert.equal(events[0].primaryCount, 2);
  assert.equal(events[0].shadowCount, 2);
  assert.equal(events[0].db, "worldcons_core");
  assert.equal(d1.calls[0].table, "articles");
  const serialized = JSON.stringify(events[0]);
  assert.equal(serialized.includes("BVerfG"), false, "no row content may be logged");
  assert.equal(serialized.includes("example.test"), false, "no URL may be logged");
});

test("loadCandidateRows routes to worldcons_ingest and compares unordered", async () => {
  resetShadowInFlight();
  const core = createFakeD1({ articles: [] });
  const ingest = createFakeD1({ source_url_candidates: [...CANDIDATE_ROWS].reverse() as unknown as Record<string, unknown>[] });
  const collector = createCollectorScheduler();
  const { events, sink } = captureEvents();
  const repository = withAdminOpsReadShadow(createAuthoritative(), {
    config: baseConfig(),
    binding: core.database,
    ingestBinding: ingest.database,
    scheduler: collector.scheduler,
    sink,
  });

  await repository.loadCandidateRows();
  await collector.flush();
  assert.equal(events[0].outcome, "matched", `diffPath=${events[0].diffPath ?? "null"}`);
  assert.equal(events[0].db, "worldcons_ingest");
  assert.equal(core.calls.length, 0, "candidates must never read worldcons_core");
  assert.equal(ingest.calls.length, 1);
  assert.equal(ingest.calls[0].table, "source_url_candidates");
});

test("candidates skip when the ingest binding is missing even though core exists", async () => {
  resetShadowInFlight();
  const core = createFakeD1({ articles: [] });
  const collector = createCollectorScheduler();
  const { events, sink } = captureEvents();
  const repository = withAdminOpsReadShadow(createAuthoritative(), {
    config: baseConfig(),
    binding: core.database,
    ingestBinding: null,
    scheduler: collector.scheduler,
    sink,
  });

  await repository.loadCandidateRows();
  assert.equal(events[0].reason, "no_binding");
  assert.equal(events[0].db, "worldcons_ingest");
  assert.equal(core.calls.length, 0);
  assert.equal(collector.count(), 0);
});

test("countTableRows routes tags to core and candidates to ingest and compares the number", async () => {
  resetShadowInFlight();
  const core = createFakeD1({ tags: [{ id: "t1" }, { id: "t2" }] });
  const ingest = createFakeD1({ source_url_candidates: [{ id: "c1" }] });
  const collector = createCollectorScheduler();
  const { events, sink } = captureEvents();
  const authoritative = createAuthoritative({
    countTableRows: async (table) => (table === "tags" ? 2 : 1),
  });
  const repository = withAdminOpsReadShadow(authoritative, {
    config: baseConfig(),
    binding: core.database,
    ingestBinding: ingest.database,
    scheduler: collector.scheduler,
    sink,
  });

  assert.equal(await repository.countTableRows("tags", 99), 2);
  assert.equal(await repository.countTableRows("source_url_candidates", 0), 1);
  await collector.flush();
  assert.deepEqual(
    events.map((event) => `${event.db}:${event.outcome}`).sort(),
    ["worldcons_core:matched", "worldcons_ingest:matched"],
  );
  assert.equal(core.calls[0].table, "tags");
  assert.equal(ingest.calls[0].table, "source_url_candidates");
});

test("countTableRows overflow is a shadow_truncated skip, never an approximate count", async () => {
  resetShadowInFlight();
  const core = createFakeD1({ tags: [{ id: "t1" }, { id: "t2" }] });
  const collector = createCollectorScheduler();
  const { events, sink } = captureEvents();
  const repository = withAdminOpsReadShadow(createAuthoritative(), {
    config: baseConfig({ maxRows: 1 }),
    binding: core.database,
    scheduler: collector.scheduler,
    sink,
  });

  await repository.countTableRows("tags", 77);
  await collector.flush();
  assert.equal(events[0].outcome, "skipped");
  assert.equal(events[0].reason, "shadow_truncated");
  assert.equal(events[0].compared, false);
});

test("listAdminArticles q is M7 and makes zero D1 calls", async () => {
  resetShadowInFlight();
  const d1 = createFakeD1({ articles: [] });
  const collector = createCollectorScheduler();
  const { events, sink } = captureEvents();
  const repository = withAdminOpsReadShadow(createAuthoritative(), {
    config: baseConfig(),
    binding: d1.database,
    scheduler: collector.scheduler,
    sink,
  });

  await repository.listAdminArticles({ q: "표현 자유" });
  assert.equal(events[0].reason, "search_deferred_m7");
  assert.equal(events[0].outcome, "skipped");
  assert.equal(d1.calls.length, 0);
  assert.equal(collector.count(), 0);
});

test("listAdminArticles reproduces filters, ordering, paging and exact totals", async () => {
  resetShadowInFlight();
  const rows: AdminOpsArticleRow[] = [
    { ...ARTICLE_ROWS[0], id: "a1", original_published_at: "2026-04-01T00:00:00.000Z", updated_at: "2026-04-02T00:00:00.000Z" },
    { ...ARTICLE_ROWS[0], id: "a2", original_published_at: "2026-04-03T00:00:00.000Z", updated_at: "2026-04-01T00:00:00.000Z" },
    { ...ARTICLE_ROWS[1], id: "a3", original_published_at: null, updated_at: "2026-04-05T00:00:00.000Z" },
  ];
  const d1 = createFakeD1({ articles: rows.map((row, index) => d1ArticleRow(row, index === 0 ? { x: 1 } : null)) });
  const collector = createCollectorScheduler();
  const { events, sink } = captureEvents();

  // A realistic authoritative page: the admin list select has no `error_metadata`
  // and pages by `original_published_at desc nulls last, updated_at desc, id asc`.
  const authoritativeRows: AdminOpsArticleListRow[] = [
    { ...ARTICLE_ROWS[0], id: "a2", original_published_at: "2026-04-03T00:00:00.000Z", updated_at: "2026-04-01T00:00:00.000Z", summary_json: null },
    { ...ARTICLE_ROWS[0], id: "a1", original_published_at: "2026-04-01T00:00:00.000Z", updated_at: "2026-04-02T00:00:00.000Z", summary_json: { x: 1 } },
    { ...ARTICLE_ROWS[1], id: "a3", original_published_at: null, updated_at: "2026-04-05T00:00:00.000Z", summary_json: null },
  ].map((row) => ({
    id: row.id,
    slug: row.slug,
    source_key: row.source_key,
    jurisdiction: row.jurisdiction,
    institution_name: row.institution_name,
    original_url: row.original_url,
    original_title: row.original_title,
    korean_title: row.korean_title,
    original_published_at: row.original_published_at,
    fetched_at: row.fetched_at,
    summarized_at: row.summarized_at,
    status: row.status,
    source_metadata: row.source_metadata,
    summary_json: row.summary_json,
    updated_at: row.updated_at,
  }));
  const expected: AdminOpsArticleListPage = {
    rows: authoritativeRows,
    pageInfo: { page: 1, pageSize: 25, total: 3, hasMore: false, totalIsExact: true },
  };
  const repository = withAdminOpsReadShadow(
    createAuthoritative({ listAdminArticles: async () => expected }),
    { config: baseConfig(), binding: d1.database, scheduler: collector.scheduler, sink },
  );

  const result = await repository.listAdminArticles({});
  assert.equal(result, expected, "the exact authoritative object must be returned");
  await collector.flush();
  assert.equal(events[0].outcome, "matched", `diffPath=${events[0].diffPath ?? "null"}`);
  assert.equal(events[0].compared, true);
  assert.equal(d1.calls[0].table, "articles");
});

test("listAdminArticles overflow skips rather than comparing a partial page", async () => {
  resetShadowInFlight();
  const d1 = createFakeD1({ articles: ARTICLE_ROWS.map((row) => d1ArticleRow(row)) });
  const collector = createCollectorScheduler();
  const { events, sink } = captureEvents();
  const repository = withAdminOpsReadShadow(createAuthoritative(), {
    config: baseConfig({ maxRows: 1 }),
    binding: d1.database,
    scheduler: collector.scheduler,
    sink,
  });

  await repository.listAdminArticles({});
  await collector.flush();
  assert.equal(events[0].reason, "shadow_truncated");
  assert.equal(events[0].compared, false);
});

test("loadArticleRows overflow is skip, not a partial comparison", async () => {
  resetShadowInFlight();
  const d1 = createFakeD1({ articles: ARTICLE_ROWS.map((row) => d1ArticleRow(row)) });
  const collector = createCollectorScheduler();
  const { events, sink } = captureEvents();
  const repository = withAdminOpsReadShadow(createAuthoritative(), {
    config: baseConfig({ maxRows: 1 }),
    binding: d1.database,
    scheduler: collector.scheduler,
    sink,
  });
  await repository.loadArticleRows();
  await collector.flush();
  assert.equal(events[0].outcome, "skipped");
  assert.equal(events[0].reason, "shadow_truncated");
  assert.equal(events[0].readOutcome, "success");
});

test("missing binding, missing scheduler, disallowed surface, sampling and rejection all skip", async () => {
  resetShadowInFlight();
  const d1 = createFakeD1({ articles: [] });
  const collector = createCollectorScheduler();

  const noBinding = captureEvents();
  const bindingRepository = withAdminOpsReadShadow(createAuthoritative(), {
    config: baseConfig(),
    binding: null,
    scheduler: collector.scheduler,
    sink: noBinding.sink,
  });
  await bindingRepository.loadArticleRows();
  assert.equal(noBinding.events[0].reason, "no_binding");
  assert.equal(d1.calls.length, 0);

  const noScheduler = captureEvents();
  const schedulerRepository = withAdminOpsReadShadow(createAuthoritative(), {
    config: baseConfig(),
    binding: d1.database,
    scheduler: null,
    sink: noScheduler.sink,
  });
  await schedulerRepository.loadArticleRows();
  assert.equal(noScheduler.events[0].reason, "no_scheduler");
  assert.equal(d1.calls.length, 0);

  const wrongSurface = captureEvents();
  const surfaceRepository = withAdminOpsReadShadow(createAuthoritative(), {
    config: baseConfig({ surfaces: new Set(["reference"]) }),
    binding: d1.database,
    scheduler: collector.scheduler,
    sink: wrongSurface.sink,
  });
  await surfaceRepository.loadArticleRows();
  assert.equal(wrongSurface.events[0].reason, "surface_not_allowed");

  const sampledOut = captureEvents();
  const sampleRepository = withAdminOpsReadShadow(createAuthoritative(), {
    config: baseConfig({ sampleRate: 0.1 }),
    binding: d1.database,
    scheduler: collector.scheduler,
    sink: sampledOut.sink,
    random: () => 0.9,
  });
  await sampleRepository.loadArticleRows();
  assert.equal(sampledOut.events[0].reason, "sampled_out");

  const rejected = captureEvents();
  const rejecting = createCollectorScheduler(false);
  const rejectRepository = withAdminOpsReadShadow(createAuthoritative(), {
    config: baseConfig(),
    binding: d1.database,
    scheduler: rejecting.scheduler,
    sink: rejected.sink,
  });
  await rejectRepository.loadArticleRows();
  assert.equal(rejected.events[0].reason, "scheduler_rejected");
  assert.equal(rejected.events[0].outcome, "skipped");
  await rejecting.flush();
  assert.equal(d1.calls.length, 0);
});

test("D1 errors and timeouts are swallowed into events and preserve the primary", async () => {
  resetShadowInFlight();
  const failing = createFakeD1({ articles: [] }, 0, true);
  const collector = createCollectorScheduler();
  const { events, sink } = captureEvents();
  const repository = withAdminOpsReadShadow(createAuthoritative(), {
    config: baseConfig(),
    binding: failing.database,
    scheduler: collector.scheduler,
    sink,
  });
  assert.equal(await repository.loadArticleRows(), ARTICLE_ROWS);
  await collector.flush();
  assert.equal(events[0].outcome, "error");
  assert.equal(events[0].errorCode, "d1_runtime_read.query_failed");

  resetShadowInFlight();
  const slow = createFakeD1({ articles: [] }, 40);
  const timeoutCollector = createCollectorScheduler();
  const timeoutEvents = captureEvents();
  const timeoutRepository = withAdminOpsReadShadow(createAuthoritative(), {
    config: baseConfig({ timeoutMs: 1 }),
    binding: slow.database,
    scheduler: timeoutCollector.scheduler,
    sink: timeoutEvents.sink,
  });
  assert.equal(await timeoutRepository.loadArticleRows(), ARTICLE_ROWS);
  await timeoutCollector.flush();
  assert.equal(timeoutEvents.events[0].outcome, "timeout");
  assert.equal(timeoutEvents.events[0].readOutcome, "timeout");
});

test("per-isolate max in-flight applies backpressure to a second read", async () => {
  resetShadowInFlight();
  const d1 = createFakeD1({ articles: ARTICLE_ROWS.map((row) => d1ArticleRow(row)) }, 20);
  const collector = createCollectorScheduler();
  const { events, sink } = captureEvents();
  const repository = withAdminOpsReadShadow(createAuthoritative(), {
    config: baseConfig({ maxInFlight: 1 }),
    binding: d1.database,
    scheduler: collector.scheduler,
    sink,
  });
  await repository.loadArticleRows();
  await repository.loadArticleRows();
  await collector.flush();
  assert.ok(events.map((event) => event.reason).includes("backpressure"));
  assert.equal(d1.calls.length, 1, "the backpressured read must not touch D1");
});

test("the D1 adapter routes countTableRows by exact table binding and reads only PK columns", async () => {
  const core = createFakeD1({ tags: [{ id: "t1" }] });
  const ingest = createFakeD1({ source_url_candidates: [{ id: "c1" }, { id: "c2" }] });
  const repository = createD1AdminOpsReadRepository({ binding: core.database, ingestBinding: ingest.database, maxRows: 100 });
  assert.equal(await repository.countTableRows("tags"), 1);
  assert.equal(await repository.countTableRows("source_url_candidates"), 2);
  assert.match(core.calls[0].sql, /select id from tags/);
  assert.match(ingest.calls[0].sql, /select id from source_url_candidates/);
});

test("the D1 adapter listAdminArticles applies publishable/hasSummary/status filters and orders nulls last", async () => {
  const rows = [
    { ...ARTICLE_ROWS[0], id: "a1", status: "summarized", original_published_at: "2026-04-01T00:00:00.000Z", summary_json: null },
    { ...ARTICLE_ROWS[0], id: "a2", status: "cleaned", original_published_at: "2026-04-03T00:00:00.000Z", summary_json: { x: 1 } },
    { ...ARTICLE_ROWS[1], id: "a3", status: "needs_review", original_published_at: null, source_metadata: null, summary_json: null },
  ];
  const d1 = createFakeD1({ articles: rows as unknown as Record<string, unknown>[] });
  const repository = createD1AdminOpsReadRepository({ binding: d1.database, maxRows: 100 });

  const publishableYes = await repository.listAdminArticles({ publishable: "yes" });
  assert.deepEqual(publishableYes.rows.map((row) => row.id), ["a2", "a1"]);

  const publishableNo = await repository.listAdminArticles({ publishable: "no" });
  assert.deepEqual(publishableNo.rows.map((row) => row.id), ["a3"]);

  const hasSummaryYes = await repository.listAdminArticles({ hasSummary: "yes" });
  assert.deepEqual(hasSummaryYes.rows.map((row) => row.id), ["a2"]);

  const ordered = await repository.listAdminArticles({});
  assert.deepEqual(ordered.rows.map((row) => row.id), ["a2", "a1", "a3"], "published desc, nulls last");
  assert.equal(ordered.pageInfo.total, 3);
  assert.equal(ordered.pageInfo.totalIsExact, true);
});

test("selection point returns the mock adapter unwrapped without Supabase config", async () => {
  const keys = ["SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"] as const;
  const original = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  try {
    assert.equal(adminOpsReads(), mockAdminOpsReads);
    assert.equal(adminOpsReads().isConfigured(), false);
    assert.deepEqual(await adminOpsReads().loadCandidateRows(), []);
  } finally {
    for (const key of keys) {
      const value = original.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("selection point wraps the Supabase adapter (not the mock) when configured", () => {
  const keys = ["SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"] as const;
  const original = new Map(keys.map((key) => [key, process.env[key]]));
  process.env.SUPABASE_URL = "https://admin-ops-m64.test.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
  try {
    const repository = adminOpsReads();
    assert.notEqual(repository, mockAdminOpsReads);
    assert.equal(repository.isConfigured(), true);
    const supabaseRepository = createSupabaseAdminOpsReadRepository({ client: () => ({}) as SupabaseClient });
    assert.equal(typeof supabaseRepository.loadArticleRows, "function");
  } finally {
    for (const key of keys) {
      const value = original.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("the admin ops D1 adapter imports no Node builtin and performs no D1 write", () => {
  const files = [
    "lib/admin/ops-read-repository/d1-read-repository.ts",
    "lib/admin/ops-read-repository/shadow.ts",
  ];
  for (const file of files) {
    const source = fs.readFileSync(path.join(process.cwd(), file), "utf8");
    assert.doesNotMatch(source, /from\s+["']node:/, `${file} must not import a node: builtin`);
    assert.doesNotMatch(source, /cloudflare\/d1\/remote/, `${file} must not import the remote operator`);
    assert.doesNotMatch(source, /\binsert\s+into\b|\bupdate\s+\w+\s+set\b|\bdelete\s+from\b|\bon\s+conflict\b/i, `${file} must not write`);
    assert.doesNotMatch(source, /\.run\(|\.batch\(/, `${file} must not use a D1 write method`);
  }
});
