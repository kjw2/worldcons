import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  applyIngestionRunMutationToD1,
  parseIngestionRunMutation,
  resolveIngestRunCanaryMarker,
  resolveIngestRunWriteAuthorityConfig,
  shouldWriteIngestionRunToD1,
} from "@/lib/cloudflare/ingest-write/ingestion-runs";
import { writeIngestionRunViaBoundary } from "@/lib/cloudflare/ingest-write/boundary-client";

function d1Capture(changes = 1) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  return {
    calls,
    binding: {
      prepare(sql: string) {
        return {
          values: [] as unknown[],
          bind(...values: unknown[]) {
            this.values = values;
            return this;
          },
          async all() {
            return { success: true, results: [] };
          },
          async run() {
            calls.push({ sql, values: this.values });
            return { success: true, meta: { changes } };
          },
        };
      },
    },
  };
}

test("M11-B ingestion_runs authority defaults to Supabase and selects only bounded D1 modes", () => {
  assert.equal(resolveIngestRunWriteAuthorityConfig({}).authority, "supabase");
  assert.equal(resolveIngestRunWriteAuthorityConfig({ WORLDCONS_INGEST_RUN_WRITE_AUTHORITY: "bogus" }).authority, "supabase");
  const canary = { canary: true };
  const ordinary = { canary: false };
  assert.equal(shouldWriteIngestionRunToD1(canary, { authority: "d1-canary" }), true);
  assert.equal(shouldWriteIngestionRunToD1(ordinary, { authority: "d1-canary" }), false);
  assert.equal(shouldWriteIngestionRunToD1(ordinary, { authority: "d1" }), true);
});

test("M11-B canary marker is bounded to true/1 or the exact GitHub run id", () => {
  assert.equal(resolveIngestRunCanaryMarker({ WORLDCONS_INGEST_RUN_CANARY_MARKER: "true" }), true);
  assert.equal(resolveIngestRunCanaryMarker({ WORLDCONS_INGEST_RUN_CANARY_MARKER: "1" }), true);
  assert.equal(resolveIngestRunCanaryMarker({ WORLDCONS_INGEST_RUN_CANARY_MARKER: "42", GITHUB_RUN_ID: "42" }), true);
  assert.equal(resolveIngestRunCanaryMarker({ WORLDCONS_INGEST_RUN_CANARY_MARKER: "42", GITHUB_RUN_ID: "43" }), false);
  assert.equal(resolveIngestRunCanaryMarker({}), false);
});

test("M11-B parser rejects malformed mutations", () => {
  assert.deepEqual(parseIngestionRunMutation({ action: "start", id: "bad" }), { ok: false, error: "id" });
  assert.deepEqual(parseIngestionRunMutation({ action: "summary", id: crypto.randomUUID(), summarizedCount: -1 }), { ok: false, error: "summarized_count" });
});

test("M11-B D1 mutation uses bound statements for start, finish, summary and stale recovery", async () => {
  const capture = d1Capture();
  const id = crypto.randomUUID();
  await applyIngestionRunMutationToD1(capture.binding, {
    action: "start", id, sourceKey: "de-bverfg", startedAt: "2026-09-28T00:00:00.000Z", canary: true,
  });
  await applyIngestionRunMutationToD1(capture.binding, {
    action: "finish", id, status: "completed", finishedAt: "2026-09-28T00:01:00.000Z",
    discoveredCount: 1, fetchedCount: 1, summarizedCount: 0, failedCount: 0,
    errorMessage: null, metadata: { ok: true }, canary: true,
  });
  await applyIngestionRunMutationToD1(capture.binding, {
    action: "summary", id, summarizedCount: 1, canary: true,
  });
  await applyIngestionRunMutationToD1(capture.binding, {
    action: "recover-stale", sourceKey: "de-bverfg", cutoff: "2026-09-27T00:00:00.000Z",
    finishedAt: "2026-09-28T00:02:00.000Z", errorMessage: "stale", canary: true,
  });
  assert.equal(capture.calls.length, 4);
  assert.ok(capture.calls.every((call) => call.sql.includes("?")));
  assert.ok(capture.calls.every((call) => !call.sql.includes(id)));
});

test("M11-B Node client keeps resting Supabase local and fails closed once D1 is selected", async () => {
  const id = crypto.randomUUID();
  let calls = 0;
  const input = { action: "start" as const, id, sourceKey: "de-bverfg", startedAt: "2026-09-28T00:00:00.000Z" };
  assert.equal(await writeIngestionRunViaBoundary(input, {
    environment: { WORLDCONS_INGEST_RUN_WRITE_AUTHORITY: "supabase" },
    fetcher: async () => { calls += 1; return new Response(); },
  }), null);
  assert.equal(calls, 0);
  await assert.rejects(
    writeIngestionRunViaBoundary(input, {
      environment: { WORLDCONS_INGEST_RUN_WRITE_AUTHORITY: "d1" },
    }),
    /not_configured/,
  );
});

test("M11-B deployment and GitHub writers carry the ingest authority seam", () => {
  const config = fs.readFileSync(path.join(process.cwd(), "workers/ops-write/wrangler.jsonc"), "utf8");
  assert.match(config, /"WORLDCONS_INGEST_RUN_WRITE_AUTHORITY": "d1"/u);
  assert.match(config, /"binding": "WORLDCONS_INGEST"/u);
  assert.match(config, /"database_name": "worldcons_ingest"/u);

  for (const file of [
    ".github/workflows/crawlee-worker.yml",
    ".github/workflows/summary-drain.yml",
    ".github/workflows/admin-command-worker-p1.yml",
    ".github/workflows/admin-job-worker.yml",
  ]) {
    const source = fs.readFileSync(path.join(process.cwd(), file), "utf8");
    assert.match(source, /WORLDCONS_INGEST_RUN_WRITE_AUTHORITY:/u, file);
    assert.match(source, /WORLDCONS_OPS_WRITE_BASE_URL:/u, file);
  }
});
