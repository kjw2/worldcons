import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  ADMIN_OPS_EVENTS_BOUNDARY_LATEST_PATH,
  ADMIN_OPS_EVENTS_BOUNDARY_LIST_PATH,
  ADMIN_OPS_EVENTS_BOUNDARY_PATH,
  ADMIN_OPS_EVENTS_BOUNDARY_PRUNE_PATH,
  ADMIN_OPS_EVENTS_CANARY_DETAIL_KEY,
  ADMIN_OPS_EVENTS_CANARY_MARKER_ENV,
  ADMIN_OPS_EVENTS_MAX_LIST_LIMIT,
  ADMIN_OPS_EVENTS_READ_AUTHORITY_ENV,
  ADMIN_OPS_EVENTS_WRITE_AUTHORITY_ENV,
  insertAdminOpsEventToD1,
  listAdminOpsEventsFromD1,
  parseAdminOpsEventReadRow,
  parseAdminOpsEventWriteRow,
  pruneAdminOpsEventsInD1,
  readLatestAdminOpsEventFromD1,
  resolveAdminOpsEventsCanaryMarker,
  resolveAdminOpsEventsReadAuthorityConfig,
  resolveAdminOpsEventsWriteAuthorityConfig,
  resolveEffectiveAdminOpsEventsReadAuthorityConfig,
  setRuntimeAdminOpsEventsReadAuthorityConfig,
  setRuntimeAdminOpsEventsWriteAuthorityConfig,
  shouldReadAdminOpsEventsFromD1,
  shouldWriteAdminOpsEventToD1,
  type AdminOpsEventWriteRow,
} from "@/lib/cloudflare/ops-write/admin-ops-events";
import {
  listAdminOpsEventsViaBoundary,
  pruneAdminOpsEventsViaBoundary,
  readLatestAdminOpsEventViaBoundary,
  resolveAdminOpsEventsBoundaryConfig,
  resolveAdminOpsEventsReadBoundaryConfig,
  writeAdminOpsEventViaBoundary,
} from "@/lib/cloudflare/ops-write/admin-ops-events-client";
import {
  OPS_HEARTBEAT_BOUNDARY_BASE_URL_ENV,
  OPS_HEARTBEAT_BOUNDARY_TOKEN_ENV,
} from "@/lib/cloudflare/ops-write/boundary-client";
import {
  clearRuntimeD1Bindings,
  setRuntimeD1Binding,
  type D1RuntimePreparedStatement,
  type D1RuntimeResult,
} from "@/lib/cloudflare/d1/runtime-binding";
import {
  handleOpsHeartbeatBoundary,
  type WorldconsOpsWriteWorkerEnv,
} from "@/workers/ops-write/src/index";
import {
  listAdminOpsEvents,
  OPS_EVENT_RETENTION_DAYS,
  recordAdminOpsEvent,
  recordWatchdogEvents,
  type WatchdogEvaluation,
} from "@/lib/ops/watchdog";

const envWithToken = { OPS_WRITE_TOKEN: "boundary-secret" } satisfies WorldconsOpsWriteWorkerEnv;

function eventRow(overrides: Partial<AdminOpsEventWriteRow> = {}): AdminOpsEventWriteRow {
  return {
    event_type: "watchdog_ok",
    severity: "info",
    source_key: null,
    summary: "수집 운영이 정상입니다.",
    detail: { signature: "ok", generatedAt: "2026-09-28T12:00:00.000Z" },
    created_at: "2026-09-28T12:00:00.000Z",
    ...overrides,
  };
}

function boundRequest(body: unknown, token = "boundary-secret") {
  return new Request(`https://worldcons-ops-write.internal${ADMIN_OPS_EVENTS_BOUNDARY_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

function authHeaders() {
  return { Authorization: "Bearer boundary-secret" };
}

function evaluation(overrides: Partial<WatchdogEvaluation> = {}): WatchdogEvaluation {
  return {
    ok: true,
    generatedAt: "2026-09-28T12:00:00.000Z",
    paused: false,
    controlAvailable: true,
    violations: [],
    sources: [],
    lastCompletedRunAt: null,
    pendingCandidateCount: 0,
    oldestOpenCandidateAt: null,
    freshnessWarningSeconds: 1,
    freshnessCriticalSeconds: 2,
    ...overrides,
  };
}

interface FakeD1State {
  rows: Array<Record<string, unknown>>;
  inserts: unknown[][];
  deletes: unknown[][];
  sqlLog: string[];
}

/**
 * A minimal in-memory D1 double that understands exactly the three
 * parameterized statements the admin_ops_events contract issues. It records the
 * SQL text and bound values and models insert/list/latest/prune semantics.
 */
function fakeD1(state: FakeD1State) {
  return {
    prepare(query: string) {
      state.sqlLog.push(query);
      let bound: unknown[] = [];
      const statement: D1RuntimePreparedStatement = {
        bind(...values: unknown[]) {
          bound = values;
          return statement;
        },
        async all<T = Record<string, unknown>>(): Promise<D1RuntimeResult<T>> {
          const sorted = [...state.rows].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
          if (/LIMIT \?/u.test(query)) {
            const limit = Number(bound[0]);
            return { success: true, results: sorted.slice(0, limit) as T[] };
          }
          return { success: true, results: sorted.slice(0, 1) as T[] };
        },
        async run() {
          if (/^INSERT INTO admin_ops_events/u.test(query)) {
            state.inserts.push(bound);
            state.rows.push({
              id: bound[0],
              event_type: bound[1],
              severity: bound[2],
              source_key: bound[3],
              summary: bound[4],
              detail: JSON.parse(String(bound[5])),
              created_at: bound[6],
            });
          } else if (/^DELETE FROM admin_ops_events/u.test(query)) {
            state.deletes.push(bound);
            state.rows = state.rows.filter((row) => String(row.created_at) >= String(bound[0]));
          }
          return { success: true, meta: { changes: 1 } };
        },
      };
      return statement;
    },
  };
}

test("M13 admin ops events write authority defaults to D1 and supports bounded canary mode", () => {
  assert.deepEqual(resolveAdminOpsEventsWriteAuthorityConfig({}), { authority: "d1" });
  assert.deepEqual(resolveAdminOpsEventsWriteAuthorityConfig({
    [ADMIN_OPS_EVENTS_WRITE_AUTHORITY_ENV]: "d1-canary",
  }), { authority: "d1-canary" });
  assert.deepEqual(resolveAdminOpsEventsWriteAuthorityConfig({
    [ADMIN_OPS_EVENTS_WRITE_AUTHORITY_ENV]: "D1",
  }), { authority: "d1" });
  assert.deepEqual(resolveAdminOpsEventsWriteAuthorityConfig({
    [ADMIN_OPS_EVENTS_WRITE_AUTHORITY_ENV]: "invalid",
  }), { authority: "d1" });
});

test("M13 admin ops events read authority defaults to D1", () => {
  assert.deepEqual(resolveAdminOpsEventsReadAuthorityConfig({}), { authority: "d1" });
  assert.deepEqual(resolveAdminOpsEventsReadAuthorityConfig({
    [ADMIN_OPS_EVENTS_READ_AUTHORITY_ENV]: "D1",
  }), { authority: "d1" });
  assert.deepEqual(resolveAdminOpsEventsReadAuthorityConfig({
    [ADMIN_OPS_EVENTS_READ_AUTHORITY_ENV]: "d1-canary",
  }), { authority: "d1" });
  assert.deepEqual(resolveAdminOpsEventsReadAuthorityConfig({
    [ADMIN_OPS_EVENTS_READ_AUTHORITY_ENV]: "invalid",
  }), { authority: "d1" });
  assert.equal(shouldReadAdminOpsEventsFromD1({ authority: "supabase" }), false);
  assert.equal(shouldReadAdminOpsEventsFromD1({ authority: "d1" }), true);
});

test("M11.4 canary marker resolver accepts only a bounded true/1", () => {
  assert.equal(resolveAdminOpsEventsCanaryMarker({}), false);
  assert.equal(resolveAdminOpsEventsCanaryMarker({ [ADMIN_OPS_EVENTS_CANARY_MARKER_ENV]: "" }), false);
  assert.equal(resolveAdminOpsEventsCanaryMarker({ [ADMIN_OPS_EVENTS_CANARY_MARKER_ENV]: "true" }), true);
  assert.equal(resolveAdminOpsEventsCanaryMarker({ [ADMIN_OPS_EVENTS_CANARY_MARKER_ENV]: "TRUE" }), true);
  assert.equal(resolveAdminOpsEventsCanaryMarker({ [ADMIN_OPS_EVENTS_CANARY_MARKER_ENV]: "1" }), true);
  assert.equal(resolveAdminOpsEventsCanaryMarker({ [ADMIN_OPS_EVENTS_CANARY_MARKER_ENV]: "yes" }), false);
});

test("M11.4 d1-canary boundary selector only accepts the exact detail marker", () => {
  const config = { authority: "d1-canary" as const };
  assert.equal(shouldWriteAdminOpsEventToD1({ detail: { [ADMIN_OPS_EVENTS_CANARY_DETAIL_KEY]: true } }, config), true);
  assert.equal(shouldWriteAdminOpsEventToD1({ detail: { [ADMIN_OPS_EVENTS_CANARY_DETAIL_KEY]: "true" } }, config), false);
  assert.equal(shouldWriteAdminOpsEventToD1({ detail: { signature: "ok" } }, config), false);
  assert.equal(shouldWriteAdminOpsEventToD1({ detail: {} }, { authority: "d1" }), true);
  assert.equal(shouldWriteAdminOpsEventToD1({ detail: { [ADMIN_OPS_EVENTS_CANARY_DETAIL_KEY]: true } }, { authority: "supabase" }), false);
});

test("M11.4 runtime authority slot wins over the process environment", () => {
  clearRuntimeD1Bindings();
  try {
    setRuntimeAdminOpsEventsWriteAuthorityConfig({ authority: "d1" });
    assert.equal(resolveAdminOpsEventsBoundaryConfig({}).authority, "d1");
    setRuntimeAdminOpsEventsReadAuthorityConfig({ authority: "supabase" });
    assert.deepEqual(
      resolveEffectiveAdminOpsEventsReadAuthorityConfig({ [ADMIN_OPS_EVENTS_READ_AUTHORITY_ENV]: "d1" }),
      { authority: "supabase" },
    );
  } finally {
    setRuntimeAdminOpsEventsWriteAuthorityConfig(null);
    setRuntimeAdminOpsEventsReadAuthorityConfig(null);
    assert.deepEqual(resolveAdminOpsEventsBoundaryConfig({}), {
      authority: "d1",
      enabled: true,
      baseUrl: null,
    });
  }
});

test("M11.4 boundary validation mirrors the Postgres admin_ops_events schema", () => {
  assert.equal(parseAdminOpsEventWriteRow(eventRow()).ok, true);

  assert.deepEqual(parseAdminOpsEventWriteRow({ ...eventRow(), event_type: "not_an_event" }), {
    ok: false,
    error: "invalid_event_type",
  });
  assert.deepEqual(parseAdminOpsEventWriteRow({ ...eventRow(), severity: "fatal" }), {
    ok: false,
    error: "invalid_severity",
  });
  assert.deepEqual(parseAdminOpsEventWriteRow({ ...eventRow(), summary: "" }), {
    ok: false,
    error: "invalid_summary",
  });
  assert.deepEqual(parseAdminOpsEventWriteRow({ ...eventRow(), source_key: 42 }), {
    ok: false,
    error: "invalid_source_key",
  });
  assert.deepEqual(parseAdminOpsEventWriteRow({ ...eventRow(), detail: ["not", "object"] }), {
    ok: false,
    error: "invalid_detail",
  });
  assert.deepEqual(parseAdminOpsEventWriteRow({ ...eventRow(), created_at: "not-a-date" }), {
    ok: false,
    error: "invalid_created_at",
  });

  const oversized = parseAdminOpsEventWriteRow({ ...eventRow(), detail: { blob: "y".repeat(70_000) } });
  assert.deepEqual(oversized, { ok: false, error: "detail_too_large" });
});

test("M11.4 D1 insert is one parameterized statement and fails closed", async () => {
  let sql = "";
  let values: unknown[] = [];
  const statement: D1RuntimePreparedStatement = {
    bind(...bound) {
      values = bound;
      return statement;
    },
    async all() {
      return { success: true, results: [] };
    },
    async run() {
      return { success: true, meta: { changes: 1 } };
    },
  };
  const record = await insertAdminOpsEventToD1(
    { prepare(query) { sql = query; return statement; } },
    eventRow(),
    "5c0f12d2-4f9a-4b40-9d75-3b7a24a3d6e2",
  );
  assert.match(sql, /^INSERT INTO admin_ops_events/u);
  assert.equal(sql.split("?").length - 1, 7);
  assert.equal(values[0], "5c0f12d2-4f9a-4b40-9d75-3b7a24a3d6e2");
  assert.equal(values[1], "watchdog_ok");
  assert.equal(values[2], "info");
  assert.equal(values[3], null);
  assert.equal(values[5], '{"signature":"ok","generatedAt":"2026-09-28T12:00:00.000Z"}');
  assert.equal(record.id, "5c0f12d2-4f9a-4b40-9d75-3b7a24a3d6e2");
  assert.deepEqual(record.detail, { signature: "ok", generatedAt: "2026-09-28T12:00:00.000Z" });

  const zeroChanges: D1RuntimePreparedStatement = {
    bind() { return zeroChanges; },
    async all() { return { success: true, results: [] }; },
    async run() { return { success: true, meta: { changes: 0 } }; },
  };
  await assert.rejects(
    () => insertAdminOpsEventToD1({ prepare: () => zeroChanges }, eventRow(), "id"),
    /admin_ops_events_d1_authority\.unexpected_changes/u,
  );
});

test("M11.4 D1 dedupe read is one bounded row and list is one parameterized bounded query", async () => {
  const latest = await readLatestAdminOpsEventFromD1({
    prepare() {
      const statement: D1RuntimePreparedStatement = {
        bind() { return statement; },
        async all<T = Record<string, unknown>>(): Promise<D1RuntimeResult<T>> {
          return { success: true, results: [{
            id: "e1",
            event_type: "watchdog_violation",
            severity: "critical",
            source_key: "de-bverfg",
            summary: "위반",
            detail: { signature: "a|b" },
            created_at: "2026-09-28T12:00:00.000Z",
          }] as T[] };
        },
      };
      return statement;
    },
  });
  assert.equal(latest?.id, "e1");
  assert.deepEqual(latest?.detail, { signature: "a|b" });

  let listSql = "";
  let listValues: unknown[] = [];
  const listStatement: D1RuntimePreparedStatement = {
    bind(...bound) { listValues = bound; return listStatement; },
    async all<T = Record<string, unknown>>(): Promise<D1RuntimeResult<T>> {
      return { success: true, results: [{
        id: "e1",
        event_type: "watchdog_ok",
        severity: "info",
        source_key: null,
        summary: "정상",
        detail: {},
        created_at: "2026-09-28T12:00:00.000Z",
      }] as T[] };
    },
  };
  const records = await listAdminOpsEventsFromD1({
    prepare(query) { listSql = query; return listStatement; },
  }, 20);
  assert.match(listSql, /^SELECT id, event_type, severity, source_key, summary, detail, created_at FROM admin_ops_events ORDER BY created_at DESC LIMIT \?$/u);
  assert.deepEqual(listValues, [20]);
  assert.equal(records.length, 1);

  await assert.rejects(
    () => listAdminOpsEventsFromD1({ prepare: () => listStatement }, ADMIN_OPS_EVENTS_MAX_LIST_LIMIT + 1),
    /admin_ops_events_d1_read\.invalid_limit/u,
  );
});

test("M11.4 D1 prune is one parameterized cutoff delete and fails closed", async () => {
  let sql = "";
  let values: unknown[] = [];
  const statement: D1RuntimePreparedStatement = {
    bind(...bound) { values = bound; return statement; },
    async all() { return { success: true, results: [] }; },
    async run() { return { success: true, meta: { changes: 3 } }; },
  };
  const deleted = await pruneAdminOpsEventsInD1(
    { prepare(query) { sql = query; return statement; } },
    "2026-08-29T00:00:00.000Z",
  );
  assert.match(sql, /^DELETE FROM admin_ops_events WHERE created_at < \?$/u);
  assert.deepEqual(values, ["2026-08-29T00:00:00.000Z"]);
  assert.equal(deleted, 3);

  await assert.rejects(
    () => pruneAdminOpsEventsInD1({ prepare: () => statement }, "bad"),
    /admin_ops_events_d1_authority\.invalid_cutoff/u,
  );
});

test("M11.4 read row parsing rejects unrepresentable rows and drops nothing silently", () => {
  assert.deepEqual(parseAdminOpsEventReadRow({
    id: "e1",
    event_type: "watchdog_ok",
    severity: "info",
    source_key: null,
    summary: "정상",
    detail: '{"signature":"ok"}',
    created_at: "2026-09-28T12:00:00.000Z",
  }), {
    id: "e1",
    event_type: "watchdog_ok",
    severity: "info",
    source_key: null,
    summary: "정상",
    detail: { signature: "ok" },
    created_at: "2026-09-28T12:00:00.000Z",
  });
  assert.equal(parseAdminOpsEventReadRow({ id: "e1", event_type: "nope", severity: "info", summary: "x", created_at: "y" }), null);
  assert.equal(parseAdminOpsEventReadRow({ id: "e1", event_type: "watchdog_ok", severity: "fatal", summary: "x", created_at: "y" }), null);
  assert.equal(parseAdminOpsEventReadRow({ id: "", event_type: "watchdog_ok", severity: "info", summary: "x", created_at: "y" }), null);
  // Malformed JSON detail degrades to {} rather than throwing or echoing.
  assert.deepEqual(parseAdminOpsEventReadRow({
    id: "e1", event_type: "watchdog_ok", severity: "info", summary: "x", detail: "{not json", created_at: "y",
  })?.detail, {});
});

test("M11.4 boundary rejects unauthenticated admin ops events and never downgrades D1 failures", async () => {
  const unauthorized = await handleOpsHeartbeatBoundary(boundRequest(eventRow(), "wrong"), envWithToken);
  assert.equal(unauthorized.status, 401);

  const d1Response = await handleOpsHeartbeatBoundary(
    boundRequest(eventRow()),
    { ...envWithToken, [ADMIN_OPS_EVENTS_WRITE_AUTHORITY_ENV]: "d1", WORLDCONS_OPS: fakeD1({ rows: [], inserts: [], deletes: [], sqlLog: [] }) as never },
    { insertAdminOpsEventToD1: async () => eventRow() as never },
  );
  assert.equal(d1Response.status, 200);
  assert.deepEqual(await d1Response.json(), {
    schemaVersion: 1,
    ok: true,
    authority: "d1",
    target: "d1",
  });

  const canaryMarked = await handleOpsHeartbeatBoundary(
    boundRequest(eventRow({ detail: { [ADMIN_OPS_EVENTS_CANARY_DETAIL_KEY]: true } })),
    {
      ...envWithToken,
      [ADMIN_OPS_EVENTS_WRITE_AUTHORITY_ENV]: "d1-canary",
      WORLDCONS_OPS: fakeD1({ rows: [], inserts: [], deletes: [], sqlLog: [] }) as never,
    },
    { insertAdminOpsEventToD1: async () => eventRow() as never },
  );
  assert.equal(canaryMarked.status, 200);
  assert.equal((await canaryMarked.json() as { target: string }).target, "d1");

  const canaryUnmarked = await handleOpsHeartbeatBoundary(
    boundRequest(eventRow()),
    {
      ...envWithToken,
      [ADMIN_OPS_EVENTS_WRITE_AUTHORITY_ENV]: "d1-canary",
      WORLDCONS_OPS: fakeD1({ rows: [], inserts: [], deletes: [], sqlLog: [] }) as never,
    },
  );
  assert.equal(canaryUnmarked.status, 409);
  assert.deepEqual(await canaryUnmarked.json(), {
    schemaVersion: 1,
    error: { code: "AUTHORITY_NOT_SELECTED", retryable: false },
  });

  const failed = await handleOpsHeartbeatBoundary(
    boundRequest(eventRow()),
    {
      ...envWithToken,
      [ADMIN_OPS_EVENTS_WRITE_AUTHORITY_ENV]: "d1",
      WORLDCONS_OPS: fakeD1({ rows: [], inserts: [], deletes: [], sqlLog: [] }) as never,
    },
    { insertAdminOpsEventToD1: async () => { throw new Error("d1 down"); } },
  );
  assert.equal(failed.status, 503);
});

test("M11.4 boundary list read is fail-closed and independent from the write authority", async () => {
  const resting = await handleOpsHeartbeatBoundary(
    new Request(`https://worldcons-ops-write.example.workers.dev${ADMIN_OPS_EVENTS_BOUNDARY_LIST_PATH}`, { headers: authHeaders() }),
    envWithToken,
  );
  assert.equal(resting.status, 503);
  assert.deepEqual(await resting.json(), {
    schemaVersion: 1,
    error: { code: "SERVICE_UNAVAILABLE", retryable: true },
  });

  const ok = await handleOpsHeartbeatBoundary(
    new Request(`https://worldcons-ops-write.example.workers.dev${ADMIN_OPS_EVENTS_BOUNDARY_LIST_PATH}?limit=5`, { headers: authHeaders() }),
    { ...envWithToken, [ADMIN_OPS_EVENTS_READ_AUTHORITY_ENV]: "d1" },
    { listAdminOpsEventsFromD1: async () => [{ ...eventRow(), id: "e1" } as never] },
  );
  assert.equal(ok.status, 200);
  assert.equal((await ok.json() as { events: unknown[] }).events.length, 1);

  const invalidLimit = await handleOpsHeartbeatBoundary(
    new Request(`https://worldcons-ops-write.example.workers.dev${ADMIN_OPS_EVENTS_BOUNDARY_LIST_PATH}?limit=1000`, { headers: authHeaders() }),
    { ...envWithToken, [ADMIN_OPS_EVENTS_READ_AUTHORITY_ENV]: "d1" },
  );
  assert.equal(invalidLimit.status, 400);
});

test("M11.4 boundary dedupe read and prune fail closed when the D1 authority binding is missing", async () => {
  const latest = await handleOpsHeartbeatBoundary(
    new Request(`https://worldcons-ops-write.example.workers.dev${ADMIN_OPS_EVENTS_BOUNDARY_LATEST_PATH}`, { headers: authHeaders() }),
    { ...envWithToken, [ADMIN_OPS_EVENTS_WRITE_AUTHORITY_ENV]: "d1" },
  );
  assert.equal(latest.status, 503);

  const prune = await handleOpsHeartbeatBoundary(
    new Request(`https://worldcons-ops-write.example.workers.dev${ADMIN_OPS_EVENTS_BOUNDARY_PRUNE_PATH}`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ cutoff: "2026-08-29T00:00:00.000Z" }),
    }),
    { ...envWithToken, [ADMIN_OPS_EVENTS_WRITE_AUTHORITY_ENV]: "d1" },
  );
  assert.equal(prune.status, 503);
});

test("M13 admin ops Node client defaults to D1 and fails closed without a boundary", async () => {
  assert.deepEqual(resolveAdminOpsEventsBoundaryConfig({}), {
    authority: "d1",
    enabled: true,
    baseUrl: null,
  });
  await assert.rejects(
    () => writeAdminOpsEventViaBoundary(eventRow(), { environment: {}, fetcher: async () => new Response() }),
    /admin_ops_events_boundary\.not_configured/u,
  );
  await assert.rejects(
    () => readLatestAdminOpsEventViaBoundary({ environment: {}, fetcher: async () => new Response() }),
    /admin_ops_events_boundary\.not_configured/u,
  );
  await assert.rejects(
    () => pruneAdminOpsEventsViaBoundary("2026-08-29T00:00:00.000Z", { environment: {}, fetcher: async () => new Response() }),
    /admin_ops_events_boundary\.not_configured/u,
  );

  const base = {
    [ADMIN_OPS_EVENTS_WRITE_AUTHORITY_ENV]: "d1",
    [OPS_HEARTBEAT_BOUNDARY_BASE_URL_ENV]: "https://ops.example/",
    [OPS_HEARTBEAT_BOUNDARY_TOKEN_ENV]: "boundary-secret",
  };
  const seen: { url: string; method: string; authorization: string | null }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    seen.push({ url: request.url, method: request.method, authorization: request.headers.get("authorization") });
    return new Response(null, { status: 200 });
  };
  assert.equal(await writeAdminOpsEventViaBoundary(eventRow(), { environment: base, fetcher }), true);
  await readLatestAdminOpsEventViaBoundary({ environment: base, fetcher: async (input, init) => {
    const request = new Request(input, init);
    seen.push({ url: request.url, method: request.method, authorization: request.headers.get("authorization") });
    return Response.json({ schemaVersion: 1, event: null });
  } });
  assert.equal(await pruneAdminOpsEventsViaBoundary("2026-08-29T00:00:00.000Z", { environment: base, fetcher }), true);
  assert.equal(seen[0].url, `https://ops.example${ADMIN_OPS_EVENTS_BOUNDARY_PATH}`);
  assert.equal(seen[0].authorization, "Bearer boundary-secret");
  assert.equal(seen[1].url, `https://ops.example${ADMIN_OPS_EVENTS_BOUNDARY_LATEST_PATH}`);
  assert.equal(seen[1].method, "GET");
  assert.equal(seen[2].url, `https://ops.example${ADMIN_OPS_EVENTS_BOUNDARY_PRUNE_PATH}`);

  await assert.rejects(
    () => writeAdminOpsEventViaBoundary(eventRow(), {
      environment: { [ADMIN_OPS_EVENTS_WRITE_AUTHORITY_ENV]: "d1" },
      fetcher: async () => new Response(),
    }),
    /admin_ops_events_boundary\.not_configured/u,
  );
  await assert.rejects(
    () => writeAdminOpsEventViaBoundary(eventRow(), {
      environment: base,
      fetcher: async () => new Response(null, { status: 503 }),
    }),
    /admin_ops_events_boundary_failed_503/u,
  );
});

test("M13 Node list client defaults to D1 and fails closed when the boundary is not configured", async () => {
  assert.deepEqual(resolveAdminOpsEventsReadBoundaryConfig({}), {
    authority: "d1",
    enabled: true,
    baseUrl: null,
  });
  await assert.rejects(
    () => listAdminOpsEventsViaBoundary(20, { environment: {}, fetcher: async () => new Response() }),
    /admin_ops_events_read_boundary\.not_configured/u,
  );

  const base = {
    [ADMIN_OPS_EVENTS_READ_AUTHORITY_ENV]: "d1",
    [OPS_HEARTBEAT_BOUNDARY_BASE_URL_ENV]: "https://ops.example",
    [OPS_HEARTBEAT_BOUNDARY_TOKEN_ENV]: "boundary-secret",
  };
  const records = await listAdminOpsEventsViaBoundary(20, {
    environment: base,
    fetcher: async () => Response.json({ schemaVersion: 1, authority: "d1", events: [{
      id: "e1",
      event_type: "watchdog_ok",
      severity: "info",
      source_key: null,
      summary: "정상",
      detail: {},
      created_at: "2026-09-28T12:00:00.000Z",
    }] }),
  });
  assert.equal(records?.length, 1);

  await assert.rejects(
    () => listAdminOpsEventsViaBoundary(20, {
      environment: { [ADMIN_OPS_EVENTS_READ_AUTHORITY_ENV]: "d1" },
      fetcher: async () => new Response(),
    }),
    /admin_ops_events_read_boundary\.not_configured/u,
  );
  await assert.rejects(
    () => listAdminOpsEventsViaBoundary(20, {
      environment: base,
      fetcher: async () => new Response(null, { status: 503 }),
    }),
    /admin_ops_events_list_boundary_failed_503/u,
  );
});

test("M11.4 watchdog writer routes to runtime D1 insert/dedupe/prune and fails closed without a binding", async (t) => {
  const originalEnv = { ...process.env };
  clearRuntimeD1Bindings();
  // `recordAdminOpsEvent` stamps `created_at` from the wall clock (`new Date()`)
  // while the dedupe read and the admin list projection order strictly by
  // `created_at`. Without a frozen clock the first and third writes can land in
  // the same millisecond, so the descending list order (and the latest-row read)
  // became nondeterministic. Freeze Date so each snapshot gets a distinct,
  // deterministic timestamp; only `Date` is mocked, so real timers are untouched.
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-28T12:00:00.000Z") });
  try {
    process.env[ADMIN_OPS_EVENTS_WRITE_AUTHORITY_ENV] = "d1";
    process.env[ADMIN_OPS_EVENTS_READ_AUTHORITY_ENV] = "d1";

    // No runtime binding and no boundary configured: the selected D1 authority
    // fails closed (Node uses the boundary; here it is unconfigured).
    await assert.rejects(
      () => recordAdminOpsEvent({ eventType: "watchdog_ok", severity: "info", summary: "정상" }),
      /admin_ops_events_boundary\.not_configured|binding_unavailable/u,
    );

    const state: FakeD1State = { rows: [], inserts: [], deletes: [], sqlLog: [] };
    setRuntimeD1Binding("worldcons_ops", fakeD1(state));

    // First evaluation is stored.
    await recordWatchdogEvents(evaluation(), new Date("2026-09-28T12:00:00.000Z"));
    assert.equal(state.inserts.length, 1);
    assert.equal(state.rows.length, 1);

    // The same signature is deduplicated (no second insert) but prune still runs.
    const deletesBefore = state.deletes.length;
    await recordWatchdogEvents(evaluation(), new Date("2026-09-28T12:00:00.000Z"));
    assert.equal(state.inserts.length, 1);
    assert.equal(state.deletes.length, deletesBefore + 1);

    // A changed signature writes a new event, strictly later than the first so
    // the descending `created_at` projection is unambiguous.
    t.mock.timers.setTime(Date.parse("2026-09-28T12:05:00.000Z"));
    await recordWatchdogEvents(evaluation({
      ok: false,
      violations: [{ key: "missed-window", severity: "critical", summary: "위반" }],
    }), new Date("2026-09-28T12:05:00.000Z"));
    assert.equal(state.inserts.length, 2);
    assert.equal(state.inserts[1][1], "watchdog_violation");

    // The prune cutoff honors the 30-day retention constant.
    const cutoff = String(state.deletes.at(-1)?.[0]);
    assert.equal(cutoff, new Date(Date.parse("2026-09-28T12:05:00.000Z") - OPS_EVENT_RETENTION_DAYS * 86_400_000).toISOString());

    // The read projection is served from the same D1 authority.
    const listed = await listAdminOpsEvents(20);
    assert.equal(listed.length, 2);
    assert.equal(listed[0].event_type, "watchdog_violation");
  } finally {
    clearRuntimeD1Bindings();
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
  }
});

test("M11.4 watchdog source uses the authority seam and keeps the resting Supabase path", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "lib/ops/watchdog.ts"), "utf8");
  assert.match(source, /resolveEffectiveAdminOpsEventsReadAuthorityConfig/u);
  assert.match(source, /shouldReadAdminOpsEventsFromD1/u);
  assert.match(source, /shouldWriteAdminOpsEventsToD1/u);
  assert.match(source, /resolveAdminOpsEventsCanaryMarker/u);
  // The resting path still uses the existing Supabase table client.
  assert.match(source, /\.from\("admin_ops_events"\)\.insert/u);
  assert.match(source, /\.from\("admin_ops_events"\)\.delete\(\)\.lt\("created_at", cutoff\)/u);
});

function adminWatchdogWorkflowSource() {
  return fs.readFileSync(path.join(process.cwd(), ".github/workflows/admin-watchdog.yml"), "utf8");
}

test("M13 admin-watchdog injects both admin ops events authority vars with an explicit d1 fallback", () => {
  const source = adminWatchdogWorkflowSource();

  const writeAuthority = "WORLDCONS_ADMIN_OPS_EVENTS_WRITE_AUTHORITY: ${{ vars.WORLDCONS_ADMIN_OPS_EVENTS_WRITE_AUTHORITY || 'd1' }}";
  assert.equal(
    source.split(writeAuthority).length - 1,
    1,
    "admin-watchdog.yml must wire the admin ops events write authority default exactly once",
  );
  const readAuthority = "WORLDCONS_ADMIN_OPS_EVENTS_READ_AUTHORITY: ${{ vars.WORLDCONS_ADMIN_OPS_EVENTS_READ_AUTHORITY || 'd1' }}";
  assert.equal(
    source.split(readAuthority).length - 1,
    1,
    "admin-watchdog.yml must wire the admin ops events read authority default exactly once",
  );

  // Neither authority may be inlined as a literal value.
  for (const line of source.split(/\r?\n/u)) {
    if (/^\s*#/u.test(line)) continue;
    if (line.includes("WORLDCONS_ADMIN_OPS_EVENTS_WRITE_AUTHORITY:")) {
      assert.ok(
        line.includes(writeAuthority.slice("WORLDCONS_ADMIN_OPS_EVENTS_WRITE_AUTHORITY: ".length)),
        `admin-watchdog.yml must never inline an admin ops events write authority value: ${line.trim()}`,
      );
    }
    if (line.includes("WORLDCONS_ADMIN_OPS_EVENTS_READ_AUTHORITY:")) {
      assert.ok(
        line.includes(readAuthority.slice("WORLDCONS_ADMIN_OPS_EVENTS_READ_AUTHORITY: ".length)),
        `admin-watchdog.yml must never inline an admin ops events read authority value: ${line.trim()}`,
      );
    }
  }
});

test("M11.4 admin-watchdog sets the canary marker only for a dispatched boolean and never from a repo var", () => {
  const source = adminWatchdogWorkflowSource();

  // A workflow_dispatch-only boolean defaulting to false.
  assert.match(source, /^\s*admin_ops_events_canary:\s*$/mu);
  assert.match(
    source,
    /admin_ops_events_canary:[\s\S]{0,240}?type:\s*boolean[\s\S]{0,120}?default:\s*false/u,
    "the admin_ops_events canary input must be a boolean defaulting to false",
  );

  // The marker is true only for a dispatched run with the input set, and empty
  // otherwise, so scheduled and ordinary manual runs stay unmarked.
  const marker = "WORLDCONS_ADMIN_OPS_EVENTS_CANARY_MARKER: ${{ github.event_name == 'workflow_dispatch' && inputs.admin_ops_events_canary == true && 'true' || '' }}";
  assert.equal(
    source.split(marker).length - 1,
    1,
    "admin-watchdog.yml must set the admin ops events canary marker exactly once, gated on the dispatched input",
  );

  // There must be no persistent repo var fallback for the marker. Only
  // executable lines count; a comment naming the forbidden fallback is allowed.
  const executable = source.split(/\r?\n/u).filter((line) => !/^\s*#/u.test(line)).join("\n");
  assert.doesNotMatch(
    executable,
    /vars\.WORLDCONS_ADMIN_OPS_EVENTS_CANARY_MARKER/u,
    "admin-watchdog.yml must not fall back to a shared admin ops events canary-marker repo var",
  );
});

test("M11.4 admin-watchdog keeps the heartbeat canary/read-parity inputs and OIDC unchanged with no shared secret", () => {
  const source = adminWatchdogWorkflowSource();

  // The M11.3 heartbeat canary input and pin are untouched.
  assert.match(source, /^\s*ops_heartbeat_canary:\s*$/mu);
  assert.equal(
    source.split("WORLDCONS_OPS_HEARTBEAT_CANARY_MARKER: ${{ github.event_name == 'workflow_dispatch' && inputs.ops_heartbeat_canary == true && github.run_id || '' }}").length - 1,
    1,
    "admin-watchdog.yml must keep the M11.3 heartbeat canary pin exactly once",
  );
  assert.match(source, /^\s*read_parity_only:\s*$/mu);

  // The existing OIDC trust remains and the shared token is never referenced.
  assert.match(source, /id-token:\s*write/u);
  for (const line of source.split(/\r?\n/u)) {
    if (/^\s*#/u.test(line)) continue;
    assert.doesNotMatch(
      line,
      /WORLDCONS_OPS_WRITE_TOKEN/u,
      `admin-watchdog.yml must not reference the shared WORLDCONS_OPS_WRITE_TOKEN secret: ${line.trim()}`,
    );
  }
});

test("M13 root config persists the permanent d1 admin ops events authority without touching env examples", () => {
  const rootConfig = fs.readFileSync(path.join(process.cwd(), "wrangler.jsonc"), "utf8");
  assert.match(rootConfig, /"WORLDCONS_ADMIN_OPS_EVENTS_WRITE_AUTHORITY":\s*"d1"/u);
  assert.match(rootConfig, /"WORLDCONS_ADMIN_OPS_EVENTS_READ_AUTHORITY":\s*"d1"/u);

  // `.env.example` keeps the safe/neutral rollback default; it is not the
  // deployed production resting config.
  const envExample = fs.readFileSync(path.join(process.cwd(), ".env.example"), "utf8");
  assert.match(envExample, /^WORLDCONS_ADMIN_OPS_EVENTS_WRITE_AUTHORITY=supabase$/mu);
  assert.match(envExample, /^WORLDCONS_ADMIN_OPS_EVENTS_READ_AUTHORITY=supabase$/mu);
});
