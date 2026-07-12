import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { AdminP1HandlerError } from "../lib/admin/command-control-plane/p1-handlers";
import {
  ADMIN_QUEUE_P1_COMMAND_TYPES,
  resolveAdminQueueP1Authority,
} from "../lib/admin/command-control-plane/p1-authority";
import { runAdminCommandWorkerP1 } from "../lib/admin/command-control-plane/p1-worker";
import {
  CandidateRetryError,
  executeExactCandidateRetry,
  isSafeOfficialCandidateUrl,
  type CandidateRetryDependencies,
} from "../lib/ingest/candidate-retry";
import type { AdminCommandLease, AdminCommandResult, ClaimedAdminCommandAttempt } from "../lib/admin/command-control-plane/types";

const enabledAuthority = resolveAdminQueueP1Authority({
  ADMIN_QUEUE_V3_WORKER_ENABLED: "true",
  ADMIN_QUEUE_V3_WORKER_COMMAND_TYPES: ADMIN_QUEUE_P1_COMMAND_TYPES.join(","),
  ADMIN_QUEUE_V3_WORKER_COHORTS: "daily,candidate-retry,manual",
});

assert(enabledAuthority.enabled);

function claim(overrides: Partial<ClaimedAdminCommandAttempt> = {}): ClaimedAdminCommandAttempt {
  return {
    commandId: "command-1",
    runId: "run-1",
    attemptId: "attempt-1",
    commandType: "p1.collect",
    payloadRef: { cohort: "daily" },
    attemptNumber: 1,
    fencingToken: "1",
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    abortRequestedAt: null,
    ...overrides,
  };
}

function successfulTransition(runStatus: "succeeded" | "failed" | "retry_wait" = "succeeded") {
  return {
    ok: true as const,
    data: { runId: "run-1", runStatus, attemptId: "attempt-1", attemptStatus: runStatus === "succeeded" ? "succeeded" : "failed" },
  };
}

function fakeService(input: {
  nextClaim?: ClaimedAdminCommandAttempt | null;
  heartbeat?: () => Promise<AdminCommandResult<AdminCommandLease>>;
  complete?: () => Promise<ReturnType<typeof successfulTransition> | { ok: false; error: ReturnType<typeof queueError> }>;
  fail?: (failure: { disposition: string; errorCode: string }) => Promise<ReturnType<typeof successfulTransition> | { ok: false; error: ReturnType<typeof queueError> }>;
  onClaim?: (value: { commandTypes?: string[]; cohorts?: string[] }) => void;
}) {
  let claimed = false;
  return {
    claim: async (value: { commandTypes?: string[]; cohorts?: string[] }) => {
      input.onClaim?.(value);
      if (claimed) return { ok: true as const, data: null };
      claimed = true;
      return { ok: true as const, data: input.nextClaim === undefined ? claim() : input.nextClaim };
    },
    heartbeat: async () => input.heartbeat ? input.heartbeat() : heartbeatSuccess(),
    complete: async () => input.complete ? input.complete() : successfulTransition(),
    fail: async (failure: { disposition: string; errorCode: string }) => input.fail ? input.fail(failure) : successfulTransition("failed"),
  };
}

function heartbeatSuccess() {
  return {
    ok: true as const,
    data: {
      attemptId: "attempt-1",
      runId: "run-1",
      fencingToken: "1",
      heartbeatAt: new Date().toISOString(),
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  };
}

function queueError(code: "aborted" | "lease_lost" | "stale_fence" | "internal") {
  return { code, message: code, retryable: code !== "aborted" && code !== "stale_fence" };
}

test("P1 authority is default-off and requires bounded command and cohort allowlists", async () => {
  let claimCount = 0;
  const disabled = await runAdminCommandWorkerP1({
    authority: resolveAdminQueueP1Authority({}),
    service: fakeService({ onClaim: () => { claimCount += 1; } }),
  });
  assert.equal(disabled.mode, "disabled");
  assert.equal(disabled.claimed, 0);
  assert.equal(claimCount, 0);

  const invalid = resolveAdminQueueP1Authority({
    ADMIN_QUEUE_V3_WORKER_ENABLED: "true",
    ADMIN_QUEUE_V3_WORKER_COMMAND_TYPES: "p1.collect,admin.unknown",
    ADMIN_QUEUE_V3_WORKER_COHORTS: "daily",
  });
  assert.deepEqual(invalid.enabled, false);
  assert.equal(invalid.reason, "invalid_allowlist");
});

test("claim sends the exact server-side command and cohort authority", async () => {
  let captured: { commandTypes?: string[]; cohorts?: string[] } | undefined;
  const authority = resolveAdminQueueP1Authority({
    ADMIN_QUEUE_V3_WORKER_ENABLED: "TRUE",
    ADMIN_QUEUE_V3_WORKER_COMMAND_TYPES: "p1.collect",
    ADMIN_QUEUE_V3_WORKER_COHORTS: "daily",
  });
  const result = await runAdminCommandWorkerP1({
    authority,
    service: fakeService({ nextClaim: null, onClaim: (value) => { captured = value; } }),
  });
  assert.equal(result.claimed, 0);
  assert.deepEqual(captured?.commandTypes, ["p1.collect"]);
  assert.deepEqual(captured?.cohorts, ["daily"]);
});

test("claimed work heartbeats and completes with its fencing token", async () => {
  let heartbeatCount = 0;
  let completed = false;
  const service = fakeService({
    heartbeat: async () => {
      heartbeatCount += 1;
      return heartbeatSuccess();
    },
    complete: async () => {
      completed = true;
      return successfulTransition();
    },
  });
  const result = await runAdminCommandWorkerP1({
    authority: enabledAuthority,
    service,
    maxCommands: 1,
    handlers: { "p1.collect": async (_payload, context) => { await context.checkpoint(); return { count: 1 }; } },
  });
  assert.equal(result.succeeded, 1);
  assert(heartbeatCount >= 3);
  assert.equal(completed, true);
});

test("abort observed between bounded handler steps stops execution without a stale failure commit", async () => {
  let heartbeatCount = 0;
  let failed = false;
  const result = await runAdminCommandWorkerP1({
    authority: enabledAuthority,
    maxCommands: 1,
    service: fakeService({
      heartbeat: async () => {
        heartbeatCount += 1;
        return heartbeatCount >= 2 ? { ok: false as const, error: queueError("aborted") } : heartbeatSuccess();
      },
      fail: async () => {
        failed = true;
        return successfulTransition("failed");
      },
    }),
    handlers: { "p1.collect": async (_payload, context) => { await context.checkpoint(); return {}; } },
  });
  assert.equal(result.attempts[0].status, "aborted");
  assert.equal(failed, false);
});

test("retryable and terminal handler failures use explicit classifications", async () => {
  const failures: Array<{ disposition: string; errorCode: string }> = [];
  for (const [code, disposition, expectedStatus] of [
    ["summary.rate_limited", "retryable", "retry_wait"],
    ["command.invalid_payload", "terminal", "failed"],
  ] as const) {
    const result = await runAdminCommandWorkerP1({
      authority: enabledAuthority,
      maxCommands: 1,
      service: fakeService({
        fail: async (failure) => {
          failures.push(failure);
          return successfulTransition(disposition === "retryable" ? "retry_wait" : "failed");
        },
      }),
      handlers: { "p1.collect": async () => { throw new AdminP1HandlerError(code, disposition); } },
    });
    assert.equal(result.attempts[0].status, expectedStatus);
  }
  assert.deepEqual(failures.map(({ disposition, errorCode }) => ({ disposition, errorCode })), [
    { disposition: "retryable", errorCode: "summary.rate_limited" },
    { disposition: "terminal", errorCode: "command.invalid_payload" },
  ]);
});

test("lost lease or stale completion fence cannot commit success", async () => {
  let failed = false;
  const result = await runAdminCommandWorkerP1({
    authority: enabledAuthority,
    maxCommands: 1,
    service: fakeService({
      complete: async () => ({ ok: false as const, error: queueError("stale_fence") }),
      fail: async () => {
        failed = true;
        return { ok: false as const, error: queueError("stale_fence") };
      },
    }),
    handlers: { "p1.collect": async () => ({ count: 1 }) },
  });
  assert.equal(result.attempts[0].status, "authority_lost");
  assert.equal(result.succeeded, 0);
  assert.equal(failed, false);
});

test("process stop requests safely yield the claimed attempt as retryable", async () => {
  let stopping = false;
  let failure: { disposition: string; errorCode: string } | undefined;
  const result = await runAdminCommandWorkerP1({
    authority: enabledAuthority,
    maxCommands: 1,
    stopRequested: () => stopping,
    service: fakeService({
      fail: async (value) => {
        failure = value;
        return successfulTransition("retry_wait");
      },
    }),
    handlers: {
      "p1.collect": async (_payload, context) => {
        stopping = true;
        await context.checkpoint();
        return {};
      },
    },
  });
  assert.equal(result.attempts[0].status, "retry_wait");
  assert.deepEqual(
    failure && { disposition: failure.disposition, errorCode: failure.errorCode },
    { disposition: "retryable", errorCode: "worker_stopping" },
  );
});

test("unsupported claimed command fails terminally and observably", async () => {
  let failure: { disposition: string; errorCode: string } | undefined;
  const result = await runAdminCommandWorkerP1({
    authority: enabledAuthority,
    maxCommands: 1,
    service: fakeService({
      nextClaim: claim({ commandType: "p1.unknown" }),
      fail: async (value) => {
        failure = value;
        return successfulTransition("failed");
      },
    }),
    handlers: {},
  });
  assert.equal(result.attempts[0].status, "failed");
  assert.deepEqual(
    failure && { disposition: failure.disposition, errorCode: failure.errorCode },
    { disposition: "terminal", errorCode: "unsupported_command" },
  );
});

test("candidate retry fetches the stored canonical URL exactly and never discovers broadly", async () => {
  const exactUrl = "https://www.bundesverfassungsgericht.de/SharedDocs/Entscheidungen/DE/2026/07/test.html?lang=de";
  const fetchedUrls: string[] = [];
  let discoverCalled = false;
  const finishes: string[] = [];
  const dependencies: CandidateRetryDependencies = {
    begin: async () => ({
      candidateId: "11111111-1111-4111-8111-111111111111",
      sourceKey: "de-bverfg",
      url: exactUrl,
      candidateType: "decision",
      status: "retrying",
      attemptCount: 3,
      shouldFetch: true,
    }),
    finish: async (value) => {
      finishes.push(value.status);
      return { candidateId: value.candidateId, status: value.status, attemptCount: value.attemptCount };
    },
    loadAdapter: async () => ({
      sourceKey: "de-bverfg",
      displayName: "test",
      jurisdiction: "DE",
      baseUrl: "https://www.bundesverfassungsgericht.de/",
      defaultLanguage: "de",
      discover: async () => { discoverCalled = true; throw new Error("must not discover"); },
      fetchItem: async (item) => {
        fetchedUrls.push(item.url);
        return { ...item, text: "x".repeat(2500) };
      },
      normalize: async (raw) => ({
        sourceKey: "de-bverfg",
        jurisdiction: "DE",
        institutionName: "BVerfG",
        contentType: "decision",
        originalUrl: raw.url,
        canonicalUrl: raw.canonicalUrl,
        originalLanguage: "de",
        cleanedText: raw.text,
      }),
    }),
    articleExists: async () => false,
    articleExistsByNormalizedContent: async () => false,
    insertNormalizedArticle: async () => ({ id: "article-1", status: "cleaned", collection: {} as never }),
  };
  const result = await executeExactCandidateRetry({ candidateId: "11111111-1111-4111-8111-111111111111", checkpoint: async () => undefined }, dependencies);
  assert.deepEqual(fetchedUrls, [exactUrl]);
  assert.equal(discoverCalled, false);
  assert.deepEqual(finishes, ["fetched"]);
  assert.equal(result.status, "fetched");
});

test("candidate retry validates official ownership and records failed/fetched transitions idempotently", async () => {
  assert.equal(isSafeOfficialCandidateUrl("de-bverfg", "https://www.bundesverfassungsgericht.de/"), false);
  assert.equal(isSafeOfficialCandidateUrl("de-bverfg", "https://attacker.example/SharedDocs/Entscheidungen/test.html"), false);
  const statuses: string[] = [];
  const base: CandidateRetryDependencies = {
    begin: async () => ({
      candidateId: "11111111-1111-4111-8111-111111111111",
      sourceKey: "de-bverfg",
      url: "https://www.bundesverfassungsgericht.de/",
      candidateType: "decision",
      status: "retrying",
      attemptCount: 1,
      shouldFetch: true,
    }),
    finish: async (value) => {
      statuses.push(value.status);
      return { candidateId: value.candidateId, status: value.status, attemptCount: value.attemptCount };
    },
    loadAdapter: async () => null,
    articleExists: async () => false,
    articleExistsByNormalizedContent: async () => false,
    insertNormalizedArticle: async () => null,
  };
  await assert.rejects(
    executeExactCandidateRetry({ candidateId: "11111111-1111-4111-8111-111111111111", checkpoint: async () => undefined }, base),
    (error: unknown) => error instanceof CandidateRetryError && error.code === "candidate.unsafe_official_url",
  );
  assert.deepEqual(statuses, ["failed"]);

  let fetchCalled = false;
  const idempotent = await executeExactCandidateRetry(
    { candidateId: "11111111-1111-4111-8111-111111111111", checkpoint: async () => undefined },
    {
      ...base,
      begin: async () => ({ ...(await base.begin("id")), status: "fetched", shouldFetch: false }),
      loadAdapter: async () => {
        fetchCalled = true;
        return null;
      },
    },
  );
  assert.equal(idempotent.idempotent, true);
  assert.equal(fetchCalled, false);
});

test("P1 migration and workflows enforce cohort claims, ordered daily execution, and legacy rollback", () => {
  const migration = fs.readFileSync(path.join(process.cwd(), "supabase/migrations/20260712130000_admin_command_worker_p1.sql"), "utf8");
  const daily = fs.readFileSync(path.join(process.cwd(), ".github/workflows/crawlee-worker.yml"), "utf8");
  const direct = fs.readFileSync(path.join(process.cwd(), ".github/workflows/admin-command-worker-p1.yml"), "utf8");
  const legacy = fs.readFileSync(path.join(process.cwd(), ".github/workflows/admin-job-worker.yml"), "utf8");

  assert.match(migration, /c\.payload_ref->>'cohort' = any\(p_cohorts\)/);
  assert.match(migration, /r\.status in \('queued', 'retry_wait'\)/);
  assert.doesNotMatch(migration, /r\.status\s*=\s*'shadowed'/);
  assert.match(daily, /cron: "0 21 \* \* \*"/);
  assert.match(daily, /group: admin-command-p1/);
  assert.match(direct, /group: admin-command-p1/);
  assert.match(daily, /ADMIN_QUEUE_V3_WORKER_ENABLED != 'true'/);
  assert.match(daily, /ADMIN_QUEUE_V3_WORKER_ENABLED == 'true'/);
  assert.match(daily, /LIMIT_INPUT >= 1 && LIMIT_INPUT <= 100/);
  assert.match(daily, /RANGE_DAYS_INPUT >= 1 && RANGE_DAYS_INPUT <= 730/);
  assert.match(daily, /SPAIN_INGEST_RANGE_DAYS: "180"/);
  assert.match(daily, /BVERFG_INGEST_RANGE_DAYS: "60"/);
  const workerScript = fs.readFileSync(path.join(process.cwd(), "scripts/admin-command-worker-p1.ts"), "utf8");
  assert.match(workerScript, /execution < 3/);
  assert.match(workerScript, /attemptTimeoutSeconds: 2400/);
  let previousIndex = -1;
  for (const command of ["p1.collect", "p1.summarize", "p1.refresh-derived", "p1.public-cache.revalidate"]) {
    const commandIndex = workerScript.indexOf(`[\"${command}\",`);
    assert(commandIndex > previousIndex, `${command} must follow the previous daily stage`);
    previousIndex = commandIndex;
  }
  assert.match(legacy, /cron: "\*\/15 \* \* \* \*"/);
  assert.match(legacy, /api\/admin\/cron\/jobs/);

  const architecture = fs.readFileSync(path.join(process.cwd(), "docs/admin-redesign-v2-v4-architecture.md"), "utf8");
  const runbook = fs.readFileSync(path.join(process.cwd(), "docs/admin-command-control-plane-p1.md"), "utf8");
  assert.match(architecture, /P1 Direct GitHub Workers/);
  assert.match(architecture, /Gate 2 remains closed/);
  assert.match(runbook, /ADMIN_QUEUE_V3_WORKER_ENABLED/);
  assert.match(runbook, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(runbook, /Authority Matrix/);
  assert.match(runbook, /75 seconds/);
  assert.match(runbook, /Gate 2 Evidence/);
  assert.match(runbook, /P2 work must not begin/);
});
