import assert from "node:assert/strict";
import test from "node:test";
import { resolveAdminQueueP1Authority } from "../lib/admin/command-control-plane/p1-authority";
import { runAdminCommandWorkerP1 } from "../lib/admin/command-control-plane/p1-worker";
import type { AdminCommandLease, AdminCommandResult, ClaimedAdminCommandAttempt } from "../lib/admin/command-control-plane/types";
import { checkRobotsAllowed } from "../lib/crawler/robots";
import { discoverSitemapUrls } from "../lib/crawler/sitemap";
import { runCrawleeExecutionBoundary } from "../lib/crawlee/shared";

const authority = resolveAdminQueueP1Authority({
  ADMIN_QUEUE_V3_WORKER_ENABLED: "true",
  ADMIN_QUEUE_V3_WORKER_COMMAND_TYPES: "p1.collect",
  ADMIN_QUEUE_V3_WORKER_COHORTS: "daily",
});

assert(authority.enabled);

function claim(): ClaimedAdminCommandAttempt {
  return {
    commandId: "command-crawler",
    runId: "run-crawler",
    attemptId: "attempt-crawler",
    commandType: "p1.collect",
    payloadRef: { cohort: "daily" },
    attemptNumber: 1,
    fencingToken: "41",
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    abortRequestedAt: null,
  };
}

function heartbeat(): AdminCommandResult<AdminCommandLease> {
  return {
    ok: true,
    data: {
      attemptId: "attempt-crawler",
      runId: "run-crawler",
      fencingToken: "41",
      heartbeatAt: new Date().toISOString(),
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  };
}

function restoreEnvironment(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test("robots parsing checkpoints abort promptly and receive the caller signal", async () => {
  const originalFetch = globalThis.fetch;
  const originalRobots = process.env.CRAWLER_ROBOTS_ENABLED;
  const controller = new AbortController();
  const reason = new Error("robots parsing cancelled");
  let observedSignal: AbortSignal | null | undefined;
  let fetchCompleted = false;
  let checkpointsAfterFetch = 0;
  try {
    process.env.CRAWLER_ROBOTS_ENABLED = "true";
    globalThis.fetch = (async (_input, init) => {
      observedSignal = init?.signal;
      fetchCompleted = true;
      const lines = Array.from({ length: 100 }, (_, index) => `Disallow: /private-${index}`).join("\n");
      return new Response(`User-agent: *\n${lines}`, { status: 200, headers: { "content-type": "text/plain" } });
    }) as typeof fetch;

    const startedAt = Date.now();
    await assert.rejects(
      checkRobotsAllowed("https://robots-cancel.example/public", {
        signal: controller.signal,
        checkpoint: async () => {
          if (fetchCompleted && ++checkpointsAfterFetch === 4) controller.abort(reason);
        },
      }),
      reason,
    );
    assert(Date.now() - startedAt < 250);
    assert(observedSignal);
    assert.equal(observedSignal.aborted, true);
    assert.equal(observedSignal.reason, reason);
    assert(checkpointsAfterFetch >= 4);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnvironment("CRAWLER_ROBOTS_ENABLED", originalRobots);
  }
});

test("sitemap parsing cancellation stops before later candidates are fetched", async () => {
  const originalFetch = globalThis.fetch;
  const originalRobots = process.env.CRAWLER_ROBOTS_ENABLED;
  const controller = new AbortController();
  const reason = new Error("sitemap parsing cancelled");
  const fetchedUrls: string[] = [];
  let observedSignal: AbortSignal | null | undefined;
  let fetchCompleted = false;
  let checkpointsAfterFetch = 0;
  try {
    process.env.CRAWLER_ROBOTS_ENABLED = "false";
    globalThis.fetch = (async (input, init) => {
      fetchedUrls.push(String(input));
      observedSignal = init?.signal;
      fetchCompleted = true;
      const locs = Array.from({ length: 100 }, (_, index) => `<url><loc>https://sitemap-cancel.example/decision/${index}</loc></url>`).join("");
      return new Response(`<urlset>${locs}</urlset>`, { status: 200, headers: { "content-type": "application/xml" } });
    }) as typeof fetch;

    await assert.rejects(
      discoverSitemapUrls("https://sitemap-cancel.example", ["/decision/"], undefined, {
        signal: controller.signal,
        checkpoint: async () => {
          if (fetchCompleted && ++checkpointsAfterFetch === 5) controller.abort(reason);
        },
      }),
      reason,
    );
    assert(observedSignal);
    assert.equal(observedSignal.aborted, true);
    assert.equal(observedSignal.reason, reason);
    assert.deepEqual(fetchedUrls, ["https://sitemap-cancel.example/sitemap.xml"]);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnvironment("CRAWLER_ROBOTS_ENABLED", originalRobots);
  }
});

test("late start-request preparation cannot enter queue setup or complete after worker cancellation", async () => {
  let stopRequested = false;
  let heartbeatCount = 0;
  let completeCount = 0;
  let failCount = 0;
  let queueSetup = false;
  let enqueue = false;
  let crawlerRun = false;
  let resolvePreparationStarted: (() => void) | undefined;
  const preparationStarted = new Promise<void>((resolve) => { resolvePreparationStarted = resolve; });
  let claimed = false;

  const worker = runAdminCommandWorkerP1({
    authority,
    maxCommands: 1,
    heartbeatIntervalMs: 10,
    watchdogIntervalMs: 5,
    attemptTimeoutMs: 1_000,
    stopRequested: () => stopRequested,
    service: {
      claim: async () => {
        if (claimed) return { ok: true as const, data: null };
        claimed = true;
        return { ok: true as const, data: claim() };
      },
      heartbeat: async () => {
        heartbeatCount += 1;
        return heartbeat();
      },
      complete: async () => {
        completeCount += 1;
        return { ok: true as const, data: { runId: "run-crawler", runStatus: "succeeded", attemptId: "attempt-crawler", attemptStatus: "succeeded" } };
      },
      fail: async () => {
        failCount += 1;
        return { ok: true as const, data: { runId: "run-crawler", runStatus: "retry_wait", attemptId: "attempt-crawler", attemptStatus: "failed" } };
      },
    },
    handlers: {
      "p1.collect": async (_payload, context) => {
        resolvePreparationStarted?.();
        await new Promise((resolve) => setTimeout(resolve, 80));
        await runCrawleeExecutionBoundary(context, async () => { queueSetup = true; });
        await runCrawleeExecutionBoundary(context, async () => { enqueue = true; });
        await runCrawleeExecutionBoundary(context, async () => { crawlerRun = true; });
        return {};
      },
    },
  });

  await preparationStarted;
  stopRequested = true;
  const result = await worker;
  const heartbeatsAtReturn = heartbeatCount;
  const failuresAtReturn = failCount;
  await new Promise((resolve) => setTimeout(resolve, 120));

  assert.equal(result.attempts[0].status, "retry_wait");
  assert.equal(queueSetup, false);
  assert.equal(enqueue, false);
  assert.equal(crawlerRun, false);
  assert.equal(completeCount, 0);
  assert.equal(failuresAtReturn, 1);
  assert.equal(failCount, failuresAtReturn);
  assert.equal(heartbeatCount, heartbeatsAtReturn);
});

test("crawler helpers preserve no-signal behavior", async () => {
  const originalFetch = globalThis.fetch;
  const originalRobots = process.env.CRAWLER_ROBOTS_ENABLED;
  const originalMaxUrls = process.env.SITEMAP_MAX_URLS;
  try {
    process.env.CRAWLER_ROBOTS_ENABLED = "false";
    process.env.SITEMAP_MAX_URLS = "1";
    globalThis.fetch = (async () => new Response(
      "<urlset><url><loc>https://legacy-crawler.example/decision/1</loc></url></urlset>",
      { status: 200, headers: { "content-type": "application/xml" } },
    )) as typeof fetch;
    const urls = await discoverSitemapUrls("https://legacy-crawler.example", ["/decision/"]);
    assert.deepEqual(urls, ["https://legacy-crawler.example/decision/1"]);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnvironment("CRAWLER_ROBOTS_ENABLED", originalRobots);
    restoreEnvironment("SITEMAP_MAX_URLS", originalMaxUrls);
  }
});
