import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  M8_CRON_EXPRESSIONS,
  M8_ENABLED_KINDS_ANY,
  M8_INVALID_RETRY_DELAY_SECONDS,
  M8_TASK_KINDS,
  buildM8TaskMessage,
  dedupeM8WorkflowCreates,
  githubDispatchForM8Task,
  isM8KindEnabled,
  isM8TaskMessage,
  isM8WorkflowInstanceId,
  messagesForM8Cron,
  parseM8EnabledKinds,
  partitionM8QueueBatch,
  planM8QueueBatch,
  resolveM8RolloutGate,
  workflowInstanceId,
  type M8TaskKind,
} from "@/lib/cloudflare/async-pipeline/contracts";
import { buildCanaryReport, readCanaryPolicy } from "@/scripts/m8-async-canary";
import {
  cloudflareBrowserRunConfigured,
  cloudflareBrowserRunRequired,
  crawlWithCloudflareBrowserRun,
} from "@/lib/crawler/cloudflare-browser-run-client";
import {
  p1CommandIdentities,
  resolveP1InvocationIdentity,
} from "@/lib/admin/command-control-plane/invocation-identity";

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
  assert.equal(workflowInstanceId(message), "m8-crawler-daily-2026-09-26T00-00-00-000Z");
  assert.match(workflowInstanceId(message), /^[a-zA-Z0-9_][a-zA-Z0-9-_]*$/);
  assert.ok(workflowInstanceId(message).length <= 100);
  assert.deepEqual(githubDispatchForM8Task(message), {
    workflow: "crawlee-worker.yml",
    inputs: { m8_idempotency_key: "m8:crawler-daily:2026-09-26T00:00:00.000Z" },
  });
  assert.equal(workflowInstanceId(structuredClone(message)), workflowInstanceId(message));
  assert.equal(isM8TaskMessage({ ...message, idempotencyKey: "forged" }), false);
});

test("workflow instance ids are Cloudflare-valid and collision-safe for representative keys", () => {
  const samples: M8TaskKind[] = [...M8_TASK_KINDS];
  const keys = new Set<string>();
  for (const kind of samples) {
    for (const scheduledFor of [
      "2026-09-26T00:00:00.000Z",
      "2026-09-26T08:45:00.000Z",
      "2026-09-26T23:59:00.000Z",
    ]) {
      const message = buildM8TaskMessage(kind, Date.parse(scheduledFor));
      const id = workflowInstanceId(message);
      assert.ok(isM8WorkflowInstanceId(id), id);
      assert.ok(id.length <= 100, id);
      assert.equal(id, workflowInstanceId(structuredClone(message)));
      assert.equal(keys.has(id), false, `duplicate workflow id: ${id}`);
      keys.add(id);
    }
  }
  assert.equal(keys.size, samples.length * 3);
});

test("github input preserves the original colon-form idempotency key", () => {
  for (const kind of M8_TASK_KINDS) {
    const message = buildM8TaskMessage(kind, Date.parse("2026-09-26T08:45:00Z"));
    const dispatch = githubDispatchForM8Task(message);
    assert.equal(dispatch.inputs.m8_idempotency_key, message.idempotencyKey);
    assert.match(dispatch.inputs.m8_idempotency_key, /^m8:[a-z-]+:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/);
    assert.notEqual(dispatch.inputs.m8_idempotency_key, workflowInstanceId(message));
  }
});

test("M8_ENABLED_KINDS parser fails closed and honors exact kinds", () => {
  assert.deepEqual(parseM8EnabledKinds(undefined), {
    any: false,
    kinds: [],
    raw: "",
    valid: false,
    reason: "m8.enabled_kinds_empty",
  });
  assert.equal(parseM8EnabledKinds("").valid, false);
  assert.equal(parseM8EnabledKinds("   ").valid, false);
  assert.equal(parseM8EnabledKinds(",,").valid, false);
  assert.equal(parseM8EnabledKinds("admin-helth").valid, false);
  assert.match(parseM8EnabledKinds("admin-health,wat").reason ?? "", /m8\.enabled_kinds_unknown/);
  assert.equal(parseM8EnabledKinds(`${M8_ENABLED_KINDS_ANY},admin-health`).valid, false);

  const single = parseM8EnabledKinds(" admin-health ");
  assert.deepEqual(single.kinds, ["admin-health"]);
  assert.equal(single.any, false);
  assert.equal(single.valid, true);

  const multi = parseM8EnabledKinds("admin-health,watchdog,admin-health");
  assert.deepEqual(multi.kinds, ["admin-health", "watchdog"]);
  assert.equal(multi.valid, true);

  const any = parseM8EnabledKinds("*");
  assert.equal(any.any, true);
  assert.equal(any.valid, true);
  assert.deepEqual([...any.kinds], [...M8_TASK_KINDS]);

  assert.equal(parseM8EnabledKinds("admin-health").any, false);
});

test("scheduler gate: disabled => no dispatch, enabled => allowlist only", () => {
  const admin = buildM8TaskMessage("admin-health", Date.parse("2026-09-26T08:45:00Z"));
  const job = buildM8TaskMessage("admin-job-drain", Date.parse("2026-09-26T08:45:00Z"));

  const disabled = resolveM8RolloutGate(false, "admin-health");
  assert.equal(isM8KindEnabled(disabled, "admin-health"), false);
  assert.equal(isM8KindEnabled(disabled, "watchdog"), false);

  const canary = resolveM8RolloutGate(true, "admin-health");
  assert.equal(isM8KindEnabled(canary, "admin-health"), true);
  for (const kind of M8_TASK_KINDS) {
    if (kind === "admin-health") continue;
    assert.equal(isM8KindEnabled(canary, kind), false, `${kind} must stay blocked`);
  }

  const invalid = resolveM8RolloutGate(true, "bogus");
  assert.equal(invalid.policy.valid, false);
  for (const kind of M8_TASK_KINDS) assert.equal(isM8KindEnabled(invalid, kind), false);

  const open = resolveM8RolloutGate(true, "*");
  for (const kind of M8_TASK_KINDS) assert.equal(isM8KindEnabled(open, kind), true);

  assert.equal(admin.kind, "admin-health");
  assert.equal(job.kind, "admin-job-drain");
});

test("scheduled() gates per kind: only admin-health enqueues under the canary allowlist", () => {
  const scheduled = messagesForM8Cron("*/15 * * * *", Date.parse("2026-09-26T08:45:00Z"));
  const gate = resolveM8RolloutGate(true, "admin-health");
  assert.deepEqual(scheduled.filter((m) => isM8KindEnabled(gate, m.kind)), []);
  const health = messagesForM8Cron("17 20 * * *", Date.parse("2026-09-26T20:17:00Z"));
  assert.deepEqual(
    health.filter((m) => isM8KindEnabled(gate, m.kind)).map((m) => m.kind),
    ["admin-health"],
  );
  const openGate = resolveM8RolloutGate(true, "*");
  assert.deepEqual(
    scheduled.filter((m) => isM8KindEnabled(openGate, m.kind)).map((m) => m.kind),
    ["admin-job-drain", "watchdog"],
  );
});

test("queue partition acks blocked kinds, retries invalid, dispatches eligible", () => {
  const health = buildM8TaskMessage("admin-health", Date.parse("2026-09-26T08:45:00Z"));
  const job = buildM8TaskMessage("admin-job-drain", Date.parse("2026-09-26T08:45:00Z"));
  const forged = { ...health, idempotencyKey: "forged" };
  const batch = [
    { id: "a", body: health },
    { id: "b", body: job },
    { id: "c", body: forged },
  ];

  const disabled = partitionM8QueueBatch(resolveM8RolloutGate(false, "admin-health"), batch, (m) => m.body);
  assert.deepEqual(disabled.eligible, []);
  assert.deepEqual(disabled.blocked.map((m) => m.id), ["a", "b"]);
  assert.deepEqual(disabled.invalid.map((m) => m.id), ["c"]);

  const canary = partitionM8QueueBatch(resolveM8RolloutGate(true, "admin-health"), batch, (m) => m.body);
  assert.deepEqual(canary.eligible.map((m) => m.id), ["a"]);
  assert.deepEqual(canary.blocked.map((m) => m.id), ["b"]);
  assert.deepEqual(canary.invalid.map((m) => m.id), ["c"]);

  const invalidGate = partitionM8QueueBatch(resolveM8RolloutGate(true, "nope"), batch, (m) => m.body);
  assert.deepEqual(invalidGate.eligible, []);
  assert.deepEqual(invalidGate.blocked.map((m) => m.id), ["a", "b"]);
});

test("canary operator report stays off GitHub and refuses disabled kinds", () => {
  const policy = readCanaryPolicy({});
  const report = buildCanaryReport({
    kind: "admin-health",
    scheduledFor: Date.parse("2026-09-26T08:45:00Z"),
    policy,
  });
  assert.equal(report.workflowInstanceIdValid, true);
  assert.equal(report.githubDispatch.workflow, "admin-health-p5.yml");
  assert.equal(report.githubDispatch.inputs.m8_idempotency_key, report.message.idempotencyKey);
  assert.equal(report.enabledKindsRaw, "admin-health");
  assert.equal(report.enabledKindsValid, true);
  assert.equal(report.kindEnabled, false, "scheduler disabled at rest resolves to no dispatch");

  const enabledPolicy = { ...policy, schedulerEnabled: true };
  const enabledReport = buildCanaryReport({
    kind: "admin-health",
    scheduledFor: Date.parse("2026-09-26T08:45:00Z"),
    policy: enabledPolicy,
  });
  assert.equal(enabledReport.kindEnabled, true);
  const blockedReport = buildCanaryReport({
    kind: "watchdog",
    scheduledFor: Date.parse("2026-09-26T08:45:00Z"),
    policy: enabledPolicy,
  });
  assert.equal(blockedReport.kindEnabled, false);
});

test("Cloudflare config locks single-consumer retries and a DLQ", () => {
  const config = JSON.parse(fs.readFileSync(path.join(root, "workers/async-pipeline/wrangler.jsonc"), "utf8"));
  const consumer = config.queues.consumers[0];
  assert.equal(config.vars.M8_SCHEDULER_ENABLED, "false");
  assert.equal(config.vars.M8_ENABLED_KINDS, "admin-health");
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
  assert.match(script, /resolveP1InvocationIdentity/);
  assert.match(script, /p1CommandIdentities\(identity, commandType, payloadRef\.cohort\)/);
  assert.match(script, /idempotencyKey: identities\.idempotencyKey/);
  assert.match(script, /dedupeKey: identities\.dedupeKey/);
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

test("request-governor parity: Browser Run navigation acquires and releases a per-source permit", async () => {
  const environment = {
    CLOUDFLARE_BROWSER_RUN_URL: "https://worldcons-browser-run.example.workers.dev",
    CLOUDFLARE_BROWSER_RUN_TOKEN: "secret",
  };
  const acquired: string[] = [];
  const released: string[] = [];
  let dispatched = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    dispatched = true;
    released.push("during-dispatch");
    assert.deepEqual(acquired, ["https://www.supremecourt.gov/opinions/slipopinion/25"]);
    return Response.json({
      schemaVersion: 1,
      url: "https://www.supremecourt.gov/opinions/slipopinion/25",
      finalUrl: "https://www.supremecourt.gov/opinions/slipopinion/25",
      status: 200,
      headers: { "content-type": "text/html" },
      html: "<html></html>",
      fetchedAt: "2026-09-26T00:00:00.000Z",
    });
  };
  try {
    await crawlWithCloudflareBrowserRun({
      url: "https://www.supremecourt.gov/opinions/slipopinion/25",
      requestGovernor: {
        async acquire(url) {
          acquired.push(url);
          return { async release() { released.push("released"); } };
        },
      },
    }, environment);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(dispatched, true);
  assert.deepEqual(released, ["during-dispatch", "released"]);
});

test("governor propagation: fetchRawItem never drops the per-source request governor on browser escalation", () => {
  const source = fs.readFileSync(path.join(root, "lib/ingest/fetch.ts"), "utf8");
  assert.match(source, /requestGovernor: options\?\.requestGovernor/);
  // Both the primary fetch and the Playwright/Browser Run escalation must forward it.
  assert.equal((source.match(/requestGovernor: options\?\.requestGovernor/g) ?? []).length >= 2, true);
  const browserClient = fs.readFileSync(path.join(root, "lib/crawler/cloudflare-browser-run-client.ts"), "utf8");
  assert.match(browserClient, /withCrawlerRequestPermit\(request\.url, request/);
});

test("restart/recovery: replay after consumer restart yields the same Workflow id and one create per identity", () => {
  const health = buildM8TaskMessage("admin-health", Date.parse("2026-09-26T09:00:00Z"));
  const duplicate = structuredClone(health);
  const creates = dedupeM8WorkflowCreates([health, duplicate], (message) => message);
  assert.equal(creates.length, 1);
  assert.equal(creates[0].id, "m8-admin-health-2026-09-26T09-00-00-000Z");
  assert.equal(creates[0].id, workflowInstanceId(health));
  // A distinct minute is a distinct deterministic identity, not a collision.
  const nextMinute = buildM8TaskMessage("admin-health", Date.parse("2026-09-26T09:15:00Z"));
  const mixed = dedupeM8WorkflowCreates([health, duplicate, nextMinute], (message) => message);
  assert.equal(mixed.length, 2);
  assert.deepEqual(mixed.map((create) => create.id), [
    "m8-admin-health-2026-09-26T09-00-00-000Z",
    "m8-admin-health-2026-09-26T09-15-00-000Z",
  ]);
  // Invalid payloads never enter the create set.
  assert.deepEqual(dedupeM8WorkflowCreates([{ kind: "not-real" }], (message) => message), []);
});

test("restart/recovery: gate-closed valid messages ack without dispatch, malformed payloads stay bounded toward DLQ", () => {
  const health = buildM8TaskMessage("admin-health", Date.parse("2026-09-26T09:00:00Z"));
  const forged = { ...health, idempotencyKey: "forged" };
  const batch = [
    { id: "a", body: health, attempts: 1, acked: false, retried: [] as number[] },
    { id: "b", body: forged, attempts: 1, acked: false, retried: [] as number[] },
    { id: "c", body: { kind: "not-a-real-kind" }, attempts: 2, acked: false, retried: [] as number[] },
  ];
  const closed = planM8QueueBatch(resolveM8RolloutGate(false, "admin-health"), batch, (m) => m.body);
  assert.deepEqual(closed.eligible, []);
  assert.deepEqual(closed.creates, []);
  assert.deepEqual(closed.blocked.map((m) => m.id), ["a"]);
  assert.deepEqual(closed.invalid.map((m) => m.id), ["b", "c"]);

  const canary = planM8QueueBatch(resolveM8RolloutGate(true, "admin-health"), batch, (m) => m.body);
  assert.deepEqual(canary.eligible.map((m) => m.id), ["a"]);
  assert.deepEqual(canary.invalid.map((m) => m.id), ["b", "c"]);
  assert.equal(canary.creates.length, 1);
  assert.ok(isM8WorkflowInstanceId(canary.creates[0].id));
  // Bounded retry delay is a fixed constant so poison messages cannot hot-loop.
  assert.equal(M8_INVALID_RETRY_DELAY_SECONDS, 300);
  assert.match(
    fs.readFileSync(path.join(root, "workers/async-pipeline/src/index.ts"), "utf8"),
    /delaySeconds: M8_INVALID_RETRY_DELAY_SECONDS/,
  );
});

test("no-duplicate-publication: two identical M8 identities collapse to one publication command identity", () => {
  const m8 = "m8:crawler-daily:2026-09-26T00:00:00.000Z";
  const first = resolveP1InvocationIdentity({ M8_IDEMPOTENCY_KEY: m8, GITHUB_RUN_ID: "1", GITHUB_RUN_ATTEMPT: "1" });
  const replayDifferentRun = resolveP1InvocationIdentity({ M8_IDEMPOTENCY_KEY: m8, GITHUB_RUN_ID: "2", GITHUB_RUN_ATTEMPT: "7" });
  assert.equal(first, replayDifferentRun, "same M8 identity must resolve to the same executor identity");

  const a = p1CommandIdentities(first, "p1.public-cache.revalidate", { cohort: "daily" });
  const b = p1CommandIdentities(replayDifferentRun, "p1.public-cache.revalidate", { cohort: "daily" });
  assert.deepEqual(a, b);
  assert.notEqual(a.idempotencyKey, p1CommandIdentities(first, "p1.summarize", { cohort: "daily" }).idempotencyKey);

  // Without an M8 identity, a different run attempt still yields a distinct identity.
  const manualA = resolveP1InvocationIdentity({ GITHUB_RUN_ID: "1", GITHUB_RUN_ATTEMPT: "1" });
  const manualB = resolveP1InvocationIdentity({ GITHUB_RUN_ID: "1", GITHUB_RUN_ATTEMPT: "2" });
  assert.notEqual(manualA, manualB);
  assert.throws(() => p1CommandIdentities("", "p1.collect", { cohort: "daily" }), /identity_invalid/);
});
