import assert from "node:assert/strict";
import test from "node:test";
import { claimAdminJob, createAdminJob, markAdminJobSucceeded } from "@/lib/db/admin-jobs";
import { clearRuntimeD1Bindings, setRuntimeD1Binding, type D1RuntimePreparedStatement, type D1RuntimeResult } from "@/lib/cloudflare/d1/runtime-binding";

function bindingFor(responses: Array<Record<string, unknown>[]>) {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const binding = {
    prepare(sql: string) {
      const captured = { sql, values: [] as unknown[] };
      statements.push(captured);
      const statement: D1RuntimePreparedStatement = {
        bind(...values) { captured.values = values; return statement; },
        async all<T = Record<string, unknown>>(): Promise<D1RuntimeResult<T>> {
          return { success: true, results: (responses.shift() ?? []) as T[] };
        },
        async run() { return { success: true, meta: { changes: 1 } }; },
      };
      return statement;
    },
  };
  return { binding, statements };
}

function jobRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    job_type: "summarize",
    status: "queued",
    priority: 5,
    source_key: "de-bverfg",
    article_id: null,
    article_slug: null,
    idempotency_key: "admin-job:test",
    requested_by: null,
    requested_at: "2026-09-29T12:00:00.000Z",
    started_at: null,
    finished_at: null,
    lease_until: null,
    worker_id: null,
    progress_current: 0,
    progress_total: null,
    result_summary: "{}",
    error_class: null,
    error_message: null,
    cancel_requested_at: null,
    cancelled_at: null,
    cancel_reason: null,
    parent_job_id: null,
    options: "{\"action\":\"summarize\"}",
    created_at: "2026-09-29T12:00:00.000Z",
    updated_at: "2026-09-29T12:00:00.000Z",
    ...overrides,
  };
}

test("admin job D1 creation binds idempotency payload and returns JSON mappings", async () => {
  const { binding, statements } = bindingFor([[jobRow()]]);
  setRuntimeD1Binding("worldcons_ops", binding);
  try {
    const result = await createAdminJob({ jobType: "summarize", sourceKey: "de-bverfg", idempotencyKey: "admin-job:test", options: { action: "summarize" } });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.data.created, true);
    assert.deepEqual(result.data.job.options, { action: "summarize" });
    assert.match(statements[0].sql, /ON CONFLICT \(idempotency_key\) DO NOTHING RETURNING/u);
    assert.ok(statements[0].values.includes("admin-job:test"));
  } finally {
    clearRuntimeD1Bindings();
  }
});

test("admin job D1 creation resolves duplicate idempotency keys to the existing row", async () => {
  const { binding, statements } = bindingFor([[], [jobRow({ status: "running" })]]);
  setRuntimeD1Binding("worldcons_ops", binding);
  try {
    const result = await createAdminJob({ jobType: "summarize", idempotencyKey: "admin-job:test" });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.data.created, false);
    assert.equal(result.data.job.status, "running");
    assert.equal(statements.length, 2);
    assert.match(statements[1].sql, /WHERE idempotency_key = \?/u);
  } finally {
    clearRuntimeD1Bindings();
  }
});

test("admin job D1 claim atomically prioritizes expired leases and binds job types", async () => {
  const { binding, statements } = bindingFor([[jobRow({ status: "running", worker_id: "worker-a", lease_until: "2026-09-29T12:02:00.000Z" })]]);
  setRuntimeD1Binding("worldcons_ops", binding);
  try {
    const result = await claimAdminJob({ workerId: "worker-a", jobTypes: ["summarize", "retry-summary"], leaseSeconds: 90 });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.data?.status, "running");
    assert.equal(result.data?.workerId, "worker-a");
    assert.match(statements[0].sql, /UPDATE admin_jobs SET status = CASE WHEN status = 'cancel_requested'/u);
  assert.match(statements[0].sql, /status = 'cancel_requested'/u);
  assert.match(statements[0].sql, /CASE WHEN status = 'cancel_requested' THEN 'cancel_requested' ELSE 'running' END/u);
  assert.match(statements[0].sql, /lease_until < \?/u);
  assert.match(statements[0].sql, /ORDER BY CASE WHEN status = 'cancel_requested' THEN 0 WHEN status = 'running' THEN 1 ELSE 2 END/u);
  assert.deepEqual(statements[0].values.slice(-2), ["summarize", "retry-summary"]);
  } finally {
    clearRuntimeD1Bindings();
  }
});

test("admin job success transition cannot overwrite a cancellation request", async () => {
  const { binding, statements } = bindingFor([[]]);
  setRuntimeD1Binding("worldcons_ops", binding);
  try {
    const result = await markAdminJobSucceeded({ jobId: "11111111-1111-4111-8111-111111111111", resultSummary: { ok: true } });
    assert.equal(result.ok, false);
    assert.match(statements[0].sql, /status = 'running' AND cancel_requested_at IS NULL/u);
  } finally {
    clearRuntimeD1Bindings();
  }
});
