import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  M8_CRON_EXPRESSIONS,
  githubDispatchForM8Task,
  isM8TaskMessage,
  messagesForM8Cron,
  workflowInstanceId,
} from "@/lib/cloudflare/async-pipeline/contracts";
import {
  cloudflareBrowserRunConfigured,
  cloudflareBrowserRunRequired,
  crawlWithCloudflareBrowserRun,
} from "@/lib/crawler/cloudflare-browser-run-client";

const root = process.cwd();
const scheduledWorkflows = [
  "admin-health-p5.yml",
  "admin-job-worker.yml",
  "admin-watchdog.yml",
  "crawlee-worker.yml",
  "embedding-backfill.yml",
  "summary-drain.yml",
];

test("M8 cron inventory maps every retired schedule to stable messages", () => {
  assert.deepEqual(M8_CRON_EXPRESSIONS, [
    "*/15 * * * *",
    "0 0 * * *",
    "30 1 * * *",
    "30 3,9,15,21 * * *",
    "17 20 * * *",
  ]);
  const scheduledAt = Date.parse("2026-09-26T12:34:56.789Z");
  const frequent = messagesForM8Cron("*/15 * * * *", scheduledAt);
  assert.deepEqual(frequent.map((message) => message.kind), ["admin-job-drain", "watchdog"]);
  assert.equal(frequent[0].scheduledFor, "2026-09-26T12:34:00.000Z");
  assert.ok(frequent.every(isM8TaskMessage));
  assert.deepEqual(messagesForM8Cron("unknown", scheduledAt), []);
});

test("queue replay yields the same Workflow and executor identities", () => {
  const [message] = messagesForM8Cron("0 0 * * *", Date.parse("2026-09-26T00:00:00Z"));
  assert.equal(workflowInstanceId(message), "m8:crawler-daily:2026-09-26T00:00:00.000Z");
  assert.deepEqual(githubDispatchForM8Task(message), {
    workflow: "crawlee-worker.yml",
    inputs: { m8_idempotency_key: workflowInstanceId(message) },
  });
  assert.equal(workflowInstanceId(structuredClone(message)), workflowInstanceId(message));
  assert.equal(isM8TaskMessage({ ...message, idempotencyKey: "forged" }), false);
});

test("Cloudflare config locks single-consumer retries and a DLQ", () => {
  const config = JSON.parse(fs.readFileSync(path.join(root, "workers/async-pipeline/wrangler.jsonc"), "utf8"));
  const consumer = config.queues.consumers[0];
  assert.equal(config.vars.M8_SCHEDULER_ENABLED, "false");
  assert.deepEqual(config.triggers.crons, M8_CRON_EXPRESSIONS);
  assert.equal(consumer.max_concurrency, 1);
  assert.equal(consumer.max_retries, 3);
  assert.equal(consumer.retry_delay, 60);
  assert.equal(consumer.dead_letter_queue, "worldcons-async-dlq-v1");
  assert.deepEqual(config.secrets.required, ["GITHUB_ACTIONS_TOKEN"]);
});

test("legacy schedulers are retired while manual compatibility executors remain", () => {
  for (const workflow of scheduledWorkflows) {
    const source = fs.readFileSync(path.join(root, ".github/workflows", workflow), "utf8");
    assert.doesNotMatch(source, /^\s*schedule:\s*$/m, workflow);
    assert.match(source, /^\s*workflow_dispatch:\s*$/m, workflow);
    assert.match(source, /m8_idempotency_key:/, workflow);
  }
  const vercel = JSON.parse(fs.readFileSync(path.join(root, "vercel.json"), "utf8"));
  assert.equal("crons" in vercel, false);
});

test("P1 publication pipeline inherits the stable M8 identity", () => {
  const script = fs.readFileSync(path.join(root, "scripts/admin-command-worker-p1.ts"), "utf8");
  assert.match(script, /process\.env\.M8_IDEMPOTENCY_KEY/);
  assert.match(script, /idempotencyKey: `p1:\$\{identity\}:\$\{commandType\}`/);
  assert.match(script, /dedupeKey: `p1:\$\{String\(payloadRef\.cohort\)\}:\$\{commandType\}`/);
});

test("Browser Run client keeps HTTPS, auth, and result mapping bounded", async () => {
  const environment = {
    CLOUDFLARE_BROWSER_RUN_URL: "https://worldcons-browser-run.example.workers.dev/ignored",
    CLOUDFLARE_BROWSER_RUN_TOKEN: "secret",
    CLOUDFLARE_BROWSER_RUN_REQUIRED: "true",
  };
  assert.equal(cloudflareBrowserRunConfigured(environment), true);
  assert.equal(cloudflareBrowserRunRequired(environment), true);

  const originalFetch = globalThis.fetch;
  let captured: { url: string; authorization: string | null; body: unknown } | undefined;
  globalThis.fetch = async (input, init) => {
    captured = {
      url: String(input),
      authorization: new Headers(init?.headers).get("authorization"),
      body: JSON.parse(String(init?.body)),
    };
    return Response.json({
      schemaVersion: 1,
      url: "https://www.supremecourt.gov/opinions/slipopinion/25",
      finalUrl: "https://www.supremecourt.gov/opinions/slipopinion/25",
      status: 200,
      headers: { "content-type": "text/html" },
      contentType: "text/html",
      html: "<html><title>Opinions</title></html>",
      fetchedAt: "2026-09-26T00:00:00.000Z",
      diagnostics: { selectorMatched: true },
    });
  };
  try {
    const result = await crawlWithCloudflareBrowserRun({
      url: "https://www.supremecourt.gov/opinions/slipopinion/25",
      waitForSelector: "main",
    }, environment);
    assert.equal(result.strategy, "playwright");
    assert.equal(result.status, 200);
    assert.equal(captured?.url, "https://worldcons-browser-run.example.workers.dev/v1/navigate");
    assert.equal(captured?.authorization, "Bearer secret");
    assert.equal((captured?.body as { waitForSelector: string }).waitForSelector, "main");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Browser Run endpoint refuses plaintext transport", async () => {
  await assert.rejects(
    crawlWithCloudflareBrowserRun({ url: "https://www.supremecourt.gov" }, {
      CLOUDFLARE_BROWSER_RUN_URL: "http://localhost:8787",
      CLOUDFLARE_BROWSER_RUN_TOKEN: "secret",
    }),
    /HTTPS URL/,
  );
});
