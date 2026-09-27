import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  M11_OPS_HEARTBEAT_CANARY_RUN_ID,
  OPS_HEARTBEAT_BOUNDARY_PATH,
  OPS_HEARTBEAT_BOUNDARY_SEARCH_PATH,
  parseOpsHeartbeatWriteRow,
  resolveOpsHeartbeatWriteAuthorityConfig,
  runOpsHeartbeatUpsertD1,
  shouldWriteOpsHeartbeatToD1,
  type OpsHeartbeatWriteRow,
} from "@/lib/cloudflare/ops-write/heartbeat";
import {
  OPS_HEARTBEAT_BOUNDARY_BASE_URL_ENV,
  OPS_HEARTBEAT_BOUNDARY_TOKEN_ENV,
  resolveOpsHeartbeatBoundaryConfig,
  writeOpsHeartbeatViaBoundary,
} from "@/lib/cloudflare/ops-write/boundary-client";
import type { D1RuntimePreparedStatement } from "@/lib/cloudflare/d1/runtime-binding";
import {
  handleOpsHeartbeatBoundary,
  opsWriteAuthorized,
  type WorldconsOpsWriteWorkerEnv,
} from "@/workers/ops-write/src/index";
import { createWorldconsSearchServiceApp } from "@/workers/search-service/src/index";
import { recordWorkflowHeartbeat } from "@/lib/ops/workflow-heartbeat";

const envWithToken = { OPS_WRITE_TOKEN: "boundary-secret" } satisfies WorldconsOpsWriteWorkerEnv;

function boundRequest(body: unknown, token = "boundary-secret") {
  return new Request(`https://worldcons-ops-write.internal${OPS_HEARTBEAT_BOUNDARY_PATH}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

function heartbeatRow(overrides: Partial<OpsHeartbeatWriteRow> = {}): OpsHeartbeatWriteRow {
  return {
    workflow_key: "watchdog",
    status: "success",
    run_id: M11_OPS_HEARTBEAT_CANARY_RUN_ID,
    detail: { phase: "m11.3" },
    observed_at: "2026-09-28T12:00:00.000Z",
    ...overrides,
  };
}

test("M11.3 ops heartbeat authority defaults to Supabase and supports bounded D1 modes", () => {
  assert.deepEqual(resolveOpsHeartbeatWriteAuthorityConfig({}), { authority: "supabase" });
  assert.deepEqual(resolveOpsHeartbeatWriteAuthorityConfig({
    WORLDCONS_OPS_HEARTBEAT_WRITE_AUTHORITY: "d1-canary",
  }), { authority: "d1-canary" });
  assert.deepEqual(resolveOpsHeartbeatWriteAuthorityConfig({
    WORLDCONS_OPS_HEARTBEAT_WRITE_AUTHORITY: "D1",
  }), { authority: "d1" });
  assert.deepEqual(resolveOpsHeartbeatWriteAuthorityConfig({
    WORLDCONS_OPS_HEARTBEAT_WRITE_AUTHORITY: "invalid",
  }), { authority: "supabase" });
});

test("M11.3 d1-canary only selects the explicit canary run id", () => {
  assert.equal(shouldWriteOpsHeartbeatToD1(
    { run_id: M11_OPS_HEARTBEAT_CANARY_RUN_ID, detail: {} },
    { authority: "d1-canary" },
  ), true);
  assert.equal(shouldWriteOpsHeartbeatToD1(
    { run_id: "github-123", detail: {} },
    { authority: "d1-canary" },
  ), false);
  assert.equal(shouldWriteOpsHeartbeatToD1(
    { run_id: null, detail: {} },
    { authority: "d1-canary" },
  ), false);
  assert.equal(shouldWriteOpsHeartbeatToD1(
    { run_id: "github-123", detail: {} },
    { authority: "d1" },
  ), true);
  assert.equal(shouldWriteOpsHeartbeatToD1(
    { run_id: M11_OPS_HEARTBEAT_CANARY_RUN_ID, detail: {} },
    { authority: "supabase" },
  ), false);
});

test("M11.3 boundary validation mirrors the Postgres heartbeat RPC gates", () => {
  assert.equal(parseOpsHeartbeatWriteRow(heartbeatRow()).ok, true);

  const invalidKey = parseOpsHeartbeatWriteRow({ ...heartbeatRow(), workflow_key: "Bad Key" });
  assert.deepEqual(invalidKey, { ok: false, error: "invalid_workflow_key" });

  const invalidStatus = parseOpsHeartbeatWriteRow({ ...heartbeatRow(), status: "done" });
  assert.deepEqual(invalidStatus, { ok: false, error: "invalid_status" });

  const invalidRunId = parseOpsHeartbeatWriteRow({ ...heartbeatRow(), run_id: "x".repeat(161) });
  assert.deepEqual(invalidRunId, { ok: false, error: "invalid_run_id" });

  const invalidDetail = parseOpsHeartbeatWriteRow({ ...heartbeatRow(), detail: ["not", "object"] });
  assert.deepEqual(invalidDetail, { ok: false, error: "invalid_detail" });

  const oversizedDetail = parseOpsHeartbeatWriteRow({
    ...heartbeatRow(),
    detail: { blob: "y".repeat(9000) },
  });
  assert.deepEqual(oversizedDetail, { ok: false, error: "detail_too_large" });

  const invalidObserved = parseOpsHeartbeatWriteRow({ ...heartbeatRow(), observed_at: "not-a-date" });
  assert.deepEqual(invalidObserved, { ok: false, error: "invalid_observed_at" });

  const blankRunId = parseOpsHeartbeatWriteRow({ ...heartbeatRow(), run_id: "   " });
  assert.equal(blankRunId.ok, true);
  if (blankRunId.ok) assert.equal(blankRunId.row.run_id, null);
});

test("M11.3 D1 heartbeat upsert is one parameterized statement with RPC-equivalent semantics", async () => {
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
  const binding = {
    prepare(query: string) {
      sql = query;
      return statement;
    },
  };
  const row = heartbeatRow({ status: "running", run_id: "github-999" });
  const result = await runOpsHeartbeatUpsertD1(binding, row);
  assert.match(sql, /^INSERT INTO ops_workflow_heartbeats/u);
  assert.match(sql, /ON CONFLICT \(workflow_key\) DO UPDATE SET/u);
  assert.match(sql, /excluded\.last_status = 'running'/u);
  assert.equal(values.length, 7);
  assert.equal(values[0], "watchdog");
  assert.equal(values[1], "2026-09-28T12:00:00.000Z");
  assert.equal(values[2], null);
  assert.equal(values[3], "running");
  assert.equal(values[4], "github-999");
  assert.equal(values[5], '{"phase":"m11.3"}');
  assert.equal(values[6], "2026-09-28T12:00:00.000Z");
  assert.deepEqual(result, { workflowKey: "watchdog", observedAt: "2026-09-28T12:00:00.000Z" });
});

test("M11.3 D1 heartbeat upsert fails closed on unexpected changes", async () => {
  const statement: D1RuntimePreparedStatement = {
    bind() {
      return statement;
    },
    async all() {
      return { success: true, results: [] };
    },
    async run() {
      return { success: true, meta: { changes: 0 } };
    },
  };
  await assert.rejects(
    () => runOpsHeartbeatUpsertD1({ prepare: () => statement }, heartbeatRow()),
    /ops_heartbeat_d1_authority\.unexpected_changes/u,
  );
});

test("M11.3 boundary rejects unauthenticated heartbeat writes", async () => {
  const unauthorized = await handleOpsHeartbeatBoundary(
    new Request(`https://worldcons-ops-write.internal${OPS_HEARTBEAT_BOUNDARY_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(heartbeatRow()),
    }),
    envWithToken,
  );
  assert.equal(unauthorized.status, 401);

  const wrong = await handleOpsHeartbeatBoundary(boundRequest(heartbeatRow(), "wrong"), envWithToken);
  assert.equal(wrong.status, 401);

  const noSecret = await handleOpsHeartbeatBoundary(boundRequest(heartbeatRow()), {} satisfies WorldconsOpsWriteWorkerEnv);
  assert.equal(noSecret.status, 401);

  assert.equal(await opsWriteAuthorized(boundRequest(heartbeatRow()), envWithToken), true);
});

test("M11.3 deployed ops-write config is externally reachable only via workers.dev with preview URLs disabled", () => {
  const config = fs.readFileSync(
    path.join(process.cwd(), "workers/ops-write/wrangler.jsonc"),
    "utf8",
  );
  assert.match(config, /"name": "worldcons-ops-write"/u);
  // Externally reachable through the workers.dev endpoint only.
  assert.match(config, /"workers_dev":\s*true/u);
  // No per-version preview URLs, so no unauthenticated version endpoint.
  assert.match(config, /"preview_urls":\s*false/u);
  // No custom routes/custom domain: workers.dev is the sole entry point.
  assert.doesNotMatch(config, /"routes"\s*:/u);
  assert.doesNotMatch(config, /"route"\s*:/u);
  // The bearer secret stays a required Wrangler secret, never a committed var.
  assert.match(config, /"secrets":\s*\{[^}]*"OPS_WRITE_TOKEN"/su);
  assert.doesNotMatch(config, /"vars"[\s\S]*?"OPS_WRITE_TOKEN"/u);
});

test("M11.3 worldcons-search stays internal-only and is not reachable over workers.dev", () => {
  const config = fs.readFileSync(
    path.join(process.cwd(), "workers/search-service/wrangler.jsonc"),
    "utf8",
  );
  assert.match(config, /"name": "worldcons-search"/u);
  assert.match(config, /"workers_dev":\s*false/u);
  assert.doesNotMatch(config, /"routes"\s*:/u);
  assert.doesNotMatch(config, /"route"\s*:/u);
});

test("M11.3 boundary health endpoint is bearer-protected and exposes no unauth surface", async () => {
  const health = "https://worldcons-ops-write.example.workers.dev/health";

  const unauth = await handleOpsHeartbeatBoundary(new Request(health), envWithToken);
  assert.equal(unauth.status, 401);

  const authorized = await handleOpsHeartbeatBoundary(
    new Request(health, { headers: { Authorization: "Bearer boundary-secret" } }),
    envWithToken,
  );
  assert.equal(authorized.status, 200);
  assert.deepEqual(await authorized.json(), {
    schemaVersion: 1,
    service: "worldcons-ops-write",
    status: "ready",
  });

  // Wrong method on the heartbeat path and unknown paths both 404 after auth.
  const getHeartbeat = await handleOpsHeartbeatBoundary(
    new Request(`https://worldcons-ops-write.example.workers.dev${OPS_HEARTBEAT_BOUNDARY_PATH}`, {
      headers: { Authorization: "Bearer boundary-secret" },
    }),
    envWithToken,
  );
  assert.equal(getHeartbeat.status, 404);

  const unknown = await handleOpsHeartbeatBoundary(
    new Request("https://worldcons-ops-write.example.workers.dev/internal/secret", {
      headers: { Authorization: "Bearer boundary-secret" },
    }),
    envWithToken,
  );
  assert.equal(unknown.status, 404);
});

test("M11.3 boundary routes d1 authority to D1 and never downgrades on failure", async () => {
  let d1Calls = 0;
  const d1Response = await handleOpsHeartbeatBoundary(
    boundRequest(heartbeatRow()),
    { ...envWithToken, WORLDCONS_OPS_HEARTBEAT_WRITE_AUTHORITY: "d1" },
    { writeToD1: async () => { d1Calls += 1; } },
  );
  assert.equal(d1Response.status, 200);
  assert.deepEqual(await d1Response.json(), {
    schemaVersion: 1,
    ok: true,
    authority: "d1",
    target: "d1",
  });
  assert.equal(d1Calls, 1);

  const canaryResponse = await handleOpsHeartbeatBoundary(
    boundRequest(heartbeatRow({ run_id: "github-1" })),
    { ...envWithToken, WORLDCONS_OPS_HEARTBEAT_WRITE_AUTHORITY: "d1-canary" },
    { writeToD1: async () => { d1Calls += 1; }, writeToSupabase: async () => {} },
  );
  assert.equal(canaryResponse.status, 200);
  assert.equal((await canaryResponse.json() as { target: string }).target, "supabase");
  assert.equal(d1Calls, 1);

  const failed = await handleOpsHeartbeatBoundary(
    boundRequest(heartbeatRow()),
    { ...envWithToken, WORLDCONS_OPS_HEARTBEAT_WRITE_AUTHORITY: "d1" },
    { writeToD1: async () => { throw new Error("d1 down"); }, writeToSupabase: async () => { d1Calls += 100; } },
  );
  assert.equal(failed.status, 503);
  assert.equal(d1Calls, 1);
});

test("M11.3 boundary relays Supabase authority through the private search bridge", async () => {
  let seenUrl = "";
  let seenBody: unknown = null;
  const response = await handleOpsHeartbeatBoundary(
    boundRequest(heartbeatRow()),
    {
      ...envWithToken,
      WORLDCONS_OPS_HEARTBEAT_WRITE_AUTHORITY: "supabase",
      WORLDCONS_SEARCH_SERVICE: {
        async fetch(request) {
          seenUrl = request.url;
          seenBody = await request.json();
          return new Response(null, { status: 204 });
        },
      },
    },
  );
  assert.equal(response.status, 200);
  assert.equal(seenUrl, `https://worldcons-search.internal${OPS_HEARTBEAT_BOUNDARY_SEARCH_PATH}`);
  assert.deepEqual(seenBody, heartbeatRow());

  const bridgeMissing = await handleOpsHeartbeatBoundary(
    boundRequest(heartbeatRow()),
    { ...envWithToken, WORLDCONS_OPS_HEARTBEAT_WRITE_AUTHORITY: "supabase" },
  );
  assert.equal(bridgeMissing.status, 503);
});

test("M11.3 Node boundary client is default-off and fails closed when explicitly enabled", async () => {
  assert.deepEqual(
    resolveOpsHeartbeatBoundaryConfig({}),
    { authority: "supabase", enabled: false, baseUrl: null, token: null },
  );
  assert.equal(
    await writeOpsHeartbeatViaBoundary(heartbeatInput(), { environment: {}, fetcher: async () => new Response() }),
    false,
  );

  const base = {
    WORLDCONS_OPS_HEARTBEAT_WRITE_AUTHORITY: "d1-canary",
    [OPS_HEARTBEAT_BOUNDARY_BASE_URL_ENV]: "https://ops.example/",
    [OPS_HEARTBEAT_BOUNDARY_TOKEN_ENV]: "boundary-secret",
  };
  const config = resolveOpsHeartbeatBoundaryConfig(base);
  assert.deepEqual(config, {
    authority: "d1-canary",
    enabled: true,
    baseUrl: "https://ops.example",
    token: "boundary-secret",
  });

  const seen: { url: string; authorization: string | null; body: unknown }[] = [];
  const delivered = await writeOpsHeartbeatViaBoundary(heartbeatInput(), {
    environment: base,
    fetcher: async (input, init) => {
      const request = new Request(input, init);
      seen.push({
        url: request.url,
        authorization: request.headers.get("authorization"),
        body: await request.json(),
      });
      return new Response(null, { status: 200 });
    },
  });
  assert.equal(delivered, true);
  assert.equal(seen[0].url, `https://ops.example${OPS_HEARTBEAT_BOUNDARY_PATH}`);
  assert.equal(seen[0].authorization, "Bearer boundary-secret");
  assert.deepEqual(seen[0].body, {
    workflow_key: "watchdog",
    status: "success",
    run_id: M11_OPS_HEARTBEAT_CANARY_RUN_ID,
    detail: { phase: "m11.3" },
    observed_at: "2026-09-28T12:00:00.000Z",
  });

  await assert.rejects(
    () => writeOpsHeartbeatViaBoundary(heartbeatInput(), {
      environment: { WORLDCONS_OPS_HEARTBEAT_WRITE_AUTHORITY: "d1" },
      fetcher: async () => new Response(),
    }),
    /ops_heartbeat_boundary\.not_configured/u,
  );

  await assert.rejects(
    () => writeOpsHeartbeatViaBoundary(heartbeatInput(), {
      environment: base,
      fetcher: async () => new Response(null, { status: 503 }),
    }),
    /ops_heartbeat_boundary_failed_503/u,
  );
});

test("M11.3 search-service Supabase bridge validates and writes one bounded heartbeat", async () => {
  let written: unknown = null;
  const app = createWorldconsSearchServiceApp({
    async opsHeartbeatWrite(row) {
      written = row;
    },
  });
  const ok = await app.request(
    `https://worldcons-search.internal${OPS_HEARTBEAT_BOUNDARY_SEARCH_PATH}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(heartbeatRow()),
    },
    {},
  );
  assert.equal(ok.status, 204);
  assert.deepEqual(written, heartbeatRow());

  const invalid = await app.request(
    `https://worldcons-search.internal${OPS_HEARTBEAT_BOUNDARY_SEARCH_PATH}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...heartbeatRow(), status: "nope" }),
    },
    {},
  );
  assert.equal(invalid.status, 400);
});

test("M11.3 search-service bridge calls the heartbeat RPC, not a direct table insert", async () => {
  const seen: Array<{ url: string; body: unknown }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    seen.push({ url: request.url, body: JSON.parse(String(init?.body ?? "{}")) });
    return Response.json(true);
  };
  const app = createWorldconsSearchServiceApp({ provider: { fetcher } });
  const response = await app.request(
    `https://worldcons-search.internal${OPS_HEARTBEAT_BOUNDARY_SEARCH_PATH}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(heartbeatRow()),
    },
    {
      SUPABASE_URL: "https://project.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
    },
  );
  assert.equal(response.status, 204);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "https://project.supabase.co/rest/v1/rpc/ops_workflow_heartbeat_v1");
  assert.deepEqual(seen[0].body, {
    p_workflow_key: "watchdog",
    p_status: "success",
    p_run_id: M11_OPS_HEARTBEAT_CANARY_RUN_ID,
    p_detail: { phase: "m11.3" },
    p_observed_at: "2026-09-28T12:00:00.000Z",
  });
});

test("M11.3 Node heartbeat writer uses the boundary and skips the Supabase RPC when enabled", async () => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  const seen: string[] = [];
  try {
    process.env.WORLDCONS_OPS_HEARTBEAT_WRITE_AUTHORITY = "d1";
    process.env[OPS_HEARTBEAT_BOUNDARY_BASE_URL_ENV] = "https://ops.example";
    process.env[OPS_HEARTBEAT_BOUNDARY_TOKEN_ENV] = "boundary-secret";
    globalThis.fetch = (async (input) => {
      seen.push(new URL(String(input)).pathname);
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    await recordWorkflowHeartbeat("watchdog", "success", { phase: "m11.3" });
    assert.deepEqual(seen, [OPS_HEARTBEAT_BOUNDARY_PATH]);

    // A failed boundary write must surface, not fall through to Supabase.
    globalThis.fetch = (async () => new Response(null, { status: 503 })) as typeof fetch;
    await assert.rejects(
      () => recordWorkflowHeartbeat("watchdog", "failed"),
      /ops_heartbeat_boundary_failed_503/u,
    );
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  }
});

function heartbeatInput() {
  const row = heartbeatRow();
  return {
    workflowKey: row.workflow_key,
    status: row.status,
    runId: row.run_id,
    detail: row.detail,
    observedAt: row.observed_at,
  };
}
