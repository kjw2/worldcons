import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  ADMIN_EXTERNAL_WORKER_REQUIRED,
  inlineAdminExecutionAllowed,
  runAdminJobWorkerForRuntime,
  runScheduledIngestForRuntime,
} from "../lib/admin/admin-worker-execution";
import { setRuntimePlatform } from "../lib/runtime/platform";

test("Cloudflare Worker runtime blocks Node admin execution before executor imports", async () => {
  setRuntimePlatform("cloudflare-worker");
  try {
    assert.equal(inlineAdminExecutionAllowed({ NODE_ENV: "development", ADMIN_INGEST_INLINE_FALLBACK: "true" }), false);
    assert.deepEqual(await runAdminJobWorkerForRuntime({ workerId: "test-worker" }), {
      mode: "external_worker_required",
      workerId: "test-worker",
      processed: 0,
      claimed: 0,
      succeeded: 0,
      failed: 0,
      jobs: [],
      error: ADMIN_EXTERNAL_WORKER_REQUIRED,
    });
    assert.deepEqual(await runScheduledIngestForRuntime({ ingestLimit: 5, rangeDays: 14, summaryLimit: 20 }), {
      mode: "external_worker_required",
      complete: false,
      error: ADMIN_EXTERNAL_WORKER_REQUIRED,
    });
  } finally {
    setRuntimePlatform(null);
  }
});

test("Worker-facing admin routes keep Node executors behind runtime seams", () => {
  const root = process.cwd();
  const source = (file: string) => fs.readFileSync(path.join(root, file), "utf8");
  assert.doesNotMatch(source("app/api/admin/jobs/run/route.ts"), /from "@\/lib\/admin\/admin-job-runner"/);
  assert.doesNotMatch(source("app/api/admin/cron/jobs/route.ts"), /from "@\/lib\/admin\/admin-job-runner"/);
  assert.doesNotMatch(source("app/api/admin/cron/ingest/route.ts"), /import\("@\/lib\/ingest\/run"\)/);
  assert.doesNotMatch(source("app/api/admin/review/route.ts"), /import \{ runAdminReviewAction \} from/);
  assert.match(source("app/api/admin/ingest/route.ts"), /inlineAdminExecutionAllowed/);
  assert.match(source("app/api/admin/review/route.ts"), /retry-source-ingest[\s\S]*isCloudflareWorkerRuntime/);
  assert.match(source("worker/index.ts"), /setRuntimePlatform\("cloudflare-worker"\)/);
  assert.match(source("app/api/mcp/health/route.ts"), /isCloudflareWorkerRuntime/);
  assert.match(source("app/api/mcp/health/route.ts"), /cloudflare-workers/);
});

test("Worker-facing code stays free of Node filesystem state and Node-only ingest", () => {
  const root = process.cwd();
  const source = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

  const geminiRouter = source("lib/ai/gemini-router.ts");
  assert.doesNotMatch(geminiRouter, /from "node:(fs|os|path)"/);
  assert.match(geminiRouter, /readRuntimeJsonState/);
  assert.match(geminiRouter, /writeRuntimeJsonState/);

  const runtimeState = source("lib/runtime/persistent-state.ts");
  assert.match(runtimeState, /isCloudflareWorkerRuntime\(\)/);
  assert.match(runtimeState, /createMemoryRuntimeJsonStateStore/);

  const workerEntry = source("worker/index.ts");
  assert.match(workerEntry, /setRuntimePlatform\("cloudflare-worker"\)/);
  assert.match(workerEntry, /createMemoryRuntimeJsonStateStore/);

  const ingestRun = source("lib/ingest/run.ts");
  assert.match(ingestRun, /isCloudflareWorkerRuntime\(\)/);
  assert.match(ingestRun, /CRAWLEE_WORKER/);

  for (const route of ["app/api/search/route.ts", "app/api/articles/route.ts"]) {
    assert.doesNotMatch(source(route), /crawlee|playwright|jsdom|pdf-parse|got-scraping/);
  }
});

test("admin job drain returns external-worker-required in the Cloudflare runtime", async () => {
  const previousCronSecret = process.env.CRON_SECRET;
  const previousShadowWrite = process.env.ADMIN_QUEUE_V3_SHADOW_WRITE_ENABLED;
  process.env.CRON_SECRET = "synthetic-cloudflare-boundary-secret";
  process.env.ADMIN_QUEUE_V3_SHADOW_WRITE_ENABLED = "false";
  setRuntimePlatform("cloudflare-worker");
  try {
    const { POST } = await import("../app/api/admin/jobs/run/route");
    const response = await POST(new Request("https://example.test/api/admin/jobs/run", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cron-secret": "synthetic-cloudflare-boundary-secret",
      },
      body: JSON.stringify({ maxJobs: 1, leaseSeconds: 120 }),
    }));
    assert.equal(response.status, 503);
    const body = await response.json() as { mode?: string; error?: string };
    assert.equal(body.mode, "external_worker_required");
    assert.equal(body.error, ADMIN_EXTERNAL_WORKER_REQUIRED);
  } finally {
    setRuntimePlatform(null);
    if (previousCronSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previousCronSecret;
    if (previousShadowWrite === undefined) delete process.env.ADMIN_QUEUE_V3_SHADOW_WRITE_ENABLED;
    else process.env.ADMIN_QUEUE_V3_SHADOW_WRITE_ENABLED = previousShadowWrite;
  }
});
