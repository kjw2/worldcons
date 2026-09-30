import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  OPS_HEARTBEAT_BOUNDARY_READ_PATH,
  OPS_HEARTBEAT_READ_AUTHORITY_ENV,
  OPS_HEARTBEAT_WORKFLOW_KEYS,
  parseOpsHeartbeatReadRecord,
  parseOpsHeartbeatReadRow,
  readOpsHeartbeatsFromD1,
  resolveEffectiveOpsHeartbeatReadAuthorityConfig,
  resolveOpsHeartbeatReadAuthorityConfig,
  setRuntimeOpsHeartbeatReadAuthorityConfig,
  shouldReadOpsHeartbeatFromD1,
} from "@/lib/cloudflare/ops-write/heartbeat";
import {
  OPS_HEARTBEAT_BOUNDARY_BASE_URL_ENV,
  OPS_HEARTBEAT_BOUNDARY_TOKEN_ENV,
  readOpsHeartbeatsViaBoundary,
  resolveOpsHeartbeatReadBoundaryConfig,
} from "@/lib/cloudflare/ops-write/boundary-client";
import type { D1RuntimePreparedStatement, D1RuntimeResult } from "@/lib/cloudflare/d1/runtime-binding";
import { clearRuntimeD1Bindings, setRuntimeD1Binding } from "@/lib/cloudflare/d1/runtime-binding";
import {
  handleOpsHeartbeatBoundary,
  type WorldconsOpsWriteWorkerEnv,
} from "@/workers/ops-write/src/index";
import { getWorkflowHeartbeats } from "@/lib/ops/workflow-heartbeat";

const envWithToken = { OPS_WRITE_TOKEN: "boundary-secret" } satisfies WorldconsOpsWriteWorkerEnv;

function readRequest(token = "boundary-secret") {
  return new Request(`https://worldcons-ops-write.internal${OPS_HEARTBEAT_BOUNDARY_READ_PATH}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
}

function readRow(overrides: Record<string, unknown> = {}) {
  return {
    workflow_key: "watchdog",
    last_started_at: "2026-09-28T12:00:00.000Z",
    last_completed_at: "2026-09-28T12:01:00.000Z",
    last_status: "success",
    run_id: "github-1",
    ...overrides,
  };
}

function d1Binding(rows: unknown[]) {
  const captured: { sql: string; values: unknown[] } = { sql: "", values: [] };
  const statement: D1RuntimePreparedStatement = {
    bind(...values) {
      captured.values = values;
      return statement;
    },
    async all<T = Record<string, unknown>>(): Promise<D1RuntimeResult<T>> {
      return { success: true, results: rows as T[] };
    },
  };
  return {
    captured,
    binding: {
      prepare(query: string) {
        captured.sql = query;
        return statement;
      },
    },
  };
}

test("M13 heartbeat read authority defaults to D1", () => {
  assert.deepEqual(resolveOpsHeartbeatReadAuthorityConfig({}), { authority: "d1" });
  assert.deepEqual(resolveOpsHeartbeatReadAuthorityConfig({ [OPS_HEARTBEAT_READ_AUTHORITY_ENV]: "D1" }), { authority: "d1" });
  assert.deepEqual(resolveOpsHeartbeatReadAuthorityConfig({ [OPS_HEARTBEAT_READ_AUTHORITY_ENV]: "d1-canary" }), { authority: "d1" });
  assert.deepEqual(resolveOpsHeartbeatReadAuthorityConfig({ [OPS_HEARTBEAT_READ_AUTHORITY_ENV]: "invalid" }), { authority: "d1" });
  assert.equal(shouldReadOpsHeartbeatFromD1({ authority: "supabase" }), false);
  assert.equal(shouldReadOpsHeartbeatFromD1({ authority: "d1" }), true);
});

test("M11.3R the runtime read-authority slot wins over the process environment", () => {
  try {
    assert.deepEqual(
      resolveEffectiveOpsHeartbeatReadAuthorityConfig({ [OPS_HEARTBEAT_READ_AUTHORITY_ENV]: "supabase" }),
      { authority: "d1" },
    );
    setRuntimeOpsHeartbeatReadAuthorityConfig({ authority: "supabase" });
    assert.deepEqual(
      resolveEffectiveOpsHeartbeatReadAuthorityConfig({ [OPS_HEARTBEAT_READ_AUTHORITY_ENV]: "d1" }),
      { authority: "supabase" },
    );
  } finally {
    setRuntimeOpsHeartbeatReadAuthorityConfig(null);
    assert.deepEqual(
      resolveEffectiveOpsHeartbeatReadAuthorityConfig({ [OPS_HEARTBEAT_READ_AUTHORITY_ENV]: "supabase" }),
      { authority: "d1" },
    );
  }
});

test("M11.3R heartbeat read row maps to the Supabase record shape and rejects bad rows", () => {
  assert.deepEqual(parseOpsHeartbeatReadRow(readRow()), {
    workflowKey: "watchdog",
    lastStartedAt: "2026-09-28T12:00:00.000Z",
    lastCompletedAt: "2026-09-28T12:01:00.000Z",
    lastStatus: "success",
    runId: "github-1",
  });
  assert.equal(parseOpsHeartbeatReadRow(readRow({ last_completed_at: null }))?.lastCompletedAt, null);
  assert.equal(parseOpsHeartbeatReadRow(readRow({ run_id: null }))?.runId, null);
  // Unknown key, missing start, invalid status are dropped, never coerced.
  assert.equal(parseOpsHeartbeatReadRow(readRow({ workflow_key: "not-a-key" })), null);
  assert.equal(parseOpsHeartbeatReadRow(readRow({ last_started_at: null })), null);
  assert.equal(parseOpsHeartbeatReadRow(readRow({ last_status: "done" })), null);
  // A named-record (boundary body) parser accepts the same shape.
  assert.deepEqual(parseOpsHeartbeatReadRecord({
    workflowKey: "summary",
    lastStartedAt: "2026-09-28T12:00:00.000Z",
    lastCompletedAt: null,
    lastStatus: "running",
    runId: null,
  }), {
    workflowKey: "summary",
    lastStartedAt: "2026-09-28T12:00:00.000Z",
    lastCompletedAt: null,
    lastStatus: "running",
    runId: null,
  });
  assert.equal(parseOpsHeartbeatReadRecord({ workflowKey: "nope" }), null);
});

test("M11.3R D1 read is one parameterized IN query over the authored keys with no detail column", async () => {
  const { binding, captured } = d1Binding([readRow(), readRow({ workflow_key: "summary", last_status: "running", last_completed_at: null, run_id: null })]);
  const records = await readOpsHeartbeatsFromD1(binding);
  assert.match(captured.sql, /^SELECT workflow_key, last_started_at, last_completed_at, last_status, run_id FROM ops_workflow_heartbeats/u);
  assert.match(captured.sql, /WHERE workflow_key IN \(\?, \?, \?, \?, \?\)/u);
  assert.doesNotMatch(captured.sql, /detail|updated_at/u);
  assert.equal(captured.sql.split("?").length - 1, OPS_HEARTBEAT_WORKFLOW_KEYS.length);
  assert.deepEqual(captured.values, [...OPS_HEARTBEAT_WORKFLOW_KEYS]);
  assert.equal(records.length, 2);
  assert.equal(records[0].workflowKey, "watchdog");
  assert.equal(records[1].workflowKey, "summary");
});

test("M11.3R D1 read fails closed on a failed envelope or non-object row", async () => {
  const failed: D1RuntimePreparedStatement = {
    bind() { return failed; },
    async all() { return { success: false, error: "boom" }; },
  };
  await assert.rejects(
    () => readOpsHeartbeatsFromD1({ prepare: () => failed }),
    /ops_heartbeat_d1_read\.query_failed/u,
  );

  const nonObject: D1RuntimePreparedStatement = {
    bind() { return nonObject; },
    async all<T = Record<string, unknown>>(): Promise<D1RuntimeResult<T>> {
      return { success: true, results: [null] as T[] };
    },
  };
  await assert.rejects(
    () => readOpsHeartbeatsFromD1({ prepare: () => nonObject }),
    /ops_heartbeat_d1_read\.invalid_response/u,
  );
});

test("M11.3R boundary read endpoint requires the bearer and exposes no unauth surface", async () => {
  const unauth = await handleOpsHeartbeatBoundary(
    new Request(`https://worldcons-ops-write.example.workers.dev${OPS_HEARTBEAT_BOUNDARY_READ_PATH}`),
    envWithToken,
  );
  assert.equal(unauth.status, 401);

  const wrong = await handleOpsHeartbeatBoundary(readRequest("wrong"), envWithToken);
  assert.equal(wrong.status, 401);
});

test("M13 boundary read defaults to D1 and fails closed without a readable binding", async () => {
  const ok = await handleOpsHeartbeatBoundary(
    readRequest(),
    { ...envWithToken, WORLDCONS_OPS_HEARTBEAT_READ_AUTHORITY: "d1" },
    {
      readFromD1: async () => [{
        workflowKey: "watchdog",
        lastStartedAt: "2026-09-28T12:00:00.000Z",
        lastCompletedAt: null,
        lastStatus: "running",
        runId: null,
      }],
    },
  );
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), {
    schemaVersion: 1,
    authority: "d1",
    heartbeats: [{
      workflowKey: "watchdog",
      lastStartedAt: "2026-09-28T12:00:00.000Z",
      lastCompletedAt: null,
      lastStatus: "running",
      runId: null,
    }],
  });

  // D1 is the resting authority; without a binding the boundary fails closed.
  const resting = await handleOpsHeartbeatBoundary(readRequest(), envWithToken);
  assert.equal(resting.status, 503);
  assert.deepEqual(await resting.json(), {
    schemaVersion: 1,
    error: { code: "SERVICE_UNAVAILABLE", retryable: true },
  });

  // A selected D1 read with a failing binding fails closed (503).
  const failed = await handleOpsHeartbeatBoundary(
    readRequest(),
    { ...envWithToken, WORLDCONS_OPS_HEARTBEAT_READ_AUTHORITY: "d1" },
    { readFromD1: async () => { throw new Error("d1 down"); } },
  );
  assert.equal(failed.status, 503);

  const missingBinding = await handleOpsHeartbeatBoundary(
    readRequest(),
    { ...envWithToken, WORLDCONS_OPS_HEARTBEAT_READ_AUTHORITY: "d1" },
  );
  assert.equal(missingBinding.status, 503);
});

test("M13 Node read client defaults to D1 and fails closed when the boundary is missing", async () => {
  assert.deepEqual(
    resolveOpsHeartbeatReadBoundaryConfig({}),
    {
      authority: "d1",
      enabled: true,
      baseUrl: null,
      token: null,
    },
  );
  await assert.rejects(
    () => readOpsHeartbeatsViaBoundary({ environment: {}, fetcher: async () => new Response() }),
    /ops_heartbeat_read_boundary\.not_configured/u,
  );

  const base = {
    [OPS_HEARTBEAT_READ_AUTHORITY_ENV]: "d1",
    [OPS_HEARTBEAT_BOUNDARY_BASE_URL_ENV]: "https://ops.example/",
    [OPS_HEARTBEAT_BOUNDARY_TOKEN_ENV]: "boundary-secret",
  };
  assert.deepEqual(resolveOpsHeartbeatReadBoundaryConfig(base), {
    authority: "d1",
    enabled: true,
    baseUrl: "https://ops.example",
    token: "boundary-secret",
  });

  const seen: { url: string; method: string; authorization: string | null }[] = [];
  const records = await readOpsHeartbeatsViaBoundary({
    environment: base,
    fetcher: async (input, init) => {
      const request = new Request(input, init);
      seen.push({
        url: request.url,
        method: request.method,
        authorization: request.headers.get("authorization"),
      });
      return Response.json({ schemaVersion: 1, authority: "d1", heartbeats: [{
        workflowKey: "watchdog",
        lastStartedAt: "2026-09-28T12:00:00.000Z",
        lastCompletedAt: "2026-09-28T12:01:00.000Z",
        lastStatus: "success",
        runId: "github-1",
      }] });
    },
  });
  assert.equal(seen[0].url, `https://ops.example${OPS_HEARTBEAT_BOUNDARY_READ_PATH}`);
  assert.equal(seen[0].method, "GET");
  assert.equal(seen[0].authorization, "Bearer boundary-secret");
  assert.equal(records?.length, 1);
  assert.equal(records?.[0].workflowKey, "watchdog");

  await assert.rejects(
    () => readOpsHeartbeatsViaBoundary({
      environment: { [OPS_HEARTBEAT_READ_AUTHORITY_ENV]: "d1" },
      fetcher: async () => new Response(),
    }),
    /ops_heartbeat_read_boundary\.not_configured/u,
  );

  await assert.rejects(
    () => readOpsHeartbeatsViaBoundary({
      environment: { [OPS_HEARTBEAT_READ_AUTHORITY_ENV]: "d1", [OPS_HEARTBEAT_BOUNDARY_BASE_URL_ENV]: "https://ops.example" },
      fetcher: async () => new Response(),
    }),
    /ops_heartbeat_read_boundary\.auth_unavailable/u,
  );

  await assert.rejects(
    () => readOpsHeartbeatsViaBoundary({
      environment: base,
      fetcher: async () => new Response(null, { status: 503 }),
    }),
    /ops_heartbeat_read_boundary_failed_503/u,
  );

  await assert.rejects(
    () => readOpsHeartbeatsViaBoundary({
      environment: base,
      fetcher: async () => Response.json({ not: "a read response" }),
    }),
    /ops_heartbeat_read_boundary\.invalid_response/u,
  );
});

test("M13 getWorkflowHeartbeats defaults to D1 and fails closed without a configured boundary", async () => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  try {
    clearRuntimeD1Bindings();
    // D1 is the resting authority; no boundary means an immediate configuration error.
    delete process.env.WORLDCONS_OPS_HEARTBEAT_READ_AUTHORITY;
    delete process.env.SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    await assert.rejects(() => getWorkflowHeartbeats(), /ops_heartbeat_read_boundary\.not_configured/u);

    // Selected d1 with no runtime binding sends one authenticated GET through
    // the boundary (the Node/GitHub path).
    const seen: string[] = [];
    process.env[OPS_HEARTBEAT_READ_AUTHORITY_ENV] = "d1";
    process.env[OPS_HEARTBEAT_BOUNDARY_BASE_URL_ENV] = "https://ops.example";
    process.env[OPS_HEARTBEAT_BOUNDARY_TOKEN_ENV] = "boundary-secret";
    globalThis.fetch = (async (input, init) => {
      const request = new Request(input, init);
      seen.push(new URL(request.url).pathname);
      assert.equal(request.headers.get("authorization"), "Bearer boundary-secret");
      return Response.json({ schemaVersion: 1, authority: "d1", heartbeats: [{
        workflowKey: "watchdog",
        lastStartedAt: "2026-09-28T12:00:00.000Z",
        lastCompletedAt: null,
        lastStatus: "running",
        runId: null,
      }] });
    }) as typeof fetch;
    const records = await getWorkflowHeartbeats();
    assert.deepEqual(seen, [OPS_HEARTBEAT_BOUNDARY_READ_PATH]);
    assert.equal(records?.[0].workflowKey, "watchdog");

    // A failed D1 read surfaces instead of falling back to Supabase.
    globalThis.fetch = (async () => new Response(null, { status: 503 })) as typeof fetch;
    await assert.rejects(() => getWorkflowHeartbeats(), /ops_heartbeat_read_boundary_failed_503/u);
  } finally {
    clearRuntimeD1Bindings();
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  }
});

test("M11.3R Cloudflare runtime reads the D1 binding directly and never calls the boundary", async () => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  try {
    process.env[OPS_HEARTBEAT_READ_AUTHORITY_ENV] = "d1";
    process.env[OPS_HEARTBEAT_BOUNDARY_BASE_URL_ENV] = "https://ops.example";
    process.env[OPS_HEARTBEAT_BOUNDARY_TOKEN_ENV] = "boundary-secret";

    // Register a runtime worldcons_ops binding and assert the read is direct.
    const { binding } = d1Binding([readRow({ workflow_key: "collection" })]);
    setRuntimeD1Binding("worldcons_ops", binding);
    let boundaryCalls = 0;
    globalThis.fetch = (async () => { boundaryCalls += 1; return new Response(null, { status: 503 }); }) as typeof fetch;
    const records = await getWorkflowHeartbeats();
    assert.equal(boundaryCalls, 0);
    assert.equal(records?.[0].workflowKey, "collection");
  } finally {
    clearRuntimeD1Bindings();
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  }
});

test("M13 root Worker persists the permanent d1 read authority", () => {
  const rootConfig = fs.readFileSync(path.join(process.cwd(), "wrangler.jsonc"), "utf8");
  assert.match(rootConfig, /"WORLDCONS_OPS_HEARTBEAT_READ_AUTHORITY":\s*"d1"/u);
});
