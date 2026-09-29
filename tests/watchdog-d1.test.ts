import assert from "node:assert/strict";
import test from "node:test";
import { recordWatchdogEventsToD1, type WatchdogEvaluation } from "@/lib/ops/watchdog";
import { clearRuntimeD1Bindings, setRuntimeD1Binding, type D1RuntimePreparedStatement, type D1RuntimeResult } from "@/lib/cloudflare/d1/runtime-binding";

function evaluation(): WatchdogEvaluation {
  return {
    ok: false,
    generatedAt: "2026-09-29T12:00:00.000Z",
    paused: false,
    controlAvailable: true,
    violations: [{ key: "source-silent:de-bverfg", severity: "critical", sourceKey: "de-bverfg", summary: "missing run" }],
    sources: [],
    lastCompletedRunAt: null,
    pendingCandidateCount: 0,
    oldestOpenCandidateAt: null,
    freshnessWarningSeconds: 129600,
    freshnessCriticalSeconds: 259200,
  };
}

test("native watchdog records and deduplicates events using D1 only", async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const binding = {
    prepare(sql: string) {
      const call = { sql, values: [] as unknown[] };
      calls.push(call);
      const statement: D1RuntimePreparedStatement = {
        bind(...values) { call.values = values; return statement; },
        async all<T = Record<string, unknown>>(): Promise<D1RuntimeResult<T>> {
          return { success: true, results: [] };
        },
        async run() { return { success: true, meta: { changes: 1 } }; },
      };
      return statement;
    },
  };
  setRuntimeD1Binding("worldcons_ops", binding);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("unexpected_network_call"); };
  try {
    await recordWatchdogEventsToD1(evaluation(), new Date("2026-09-29T12:00:00.000Z"));
    assert.equal(calls.length, 3);
    assert.match(calls[0].sql, /SELECT detail FROM admin_ops_events/u);
    assert.match(calls[1].sql, /INSERT INTO admin_ops_events/u);
    assert.match(calls[2].sql, /DELETE FROM admin_ops_events/u);
    assert.equal(calls.some((call) => call.sql.includes("github") || call.sql.includes("supabase")), false);
  } finally {
    globalThis.fetch = originalFetch;
    clearRuntimeD1Bindings();
  }
});

test("native watchdog dedupe prunes without appending another event", async () => {
  const calls: string[] = [];
  const signature = "source-silent:de-bverfg";
  const binding = {
    prepare(sql: string) {
      calls.push(sql);
      const statement: D1RuntimePreparedStatement = {
        bind() { return statement; },
        async all<T = Record<string, unknown>>(): Promise<D1RuntimeResult<T>> {
          return { success: true, results: [{ detail: JSON.stringify({ signature }) }] as T[] };
        },
        async run() { return { success: true, meta: { changes: 0 } }; },
      };
      return statement;
    },
  };
  setRuntimeD1Binding("worldcons_ops", binding);
  try {
    await recordWatchdogEventsToD1(evaluation(), new Date("2026-09-29T12:00:00.000Z"));
    assert.equal(calls.length, 2);
    assert.doesNotMatch(calls.join(" "), /INSERT/u);
  } finally {
    clearRuntimeD1Bindings();
  }
});
