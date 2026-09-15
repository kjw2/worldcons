import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  decideBverfgFetchDrain,
  drainOpenRunsFromRepository,
  type BverfgFetchDrainDecisionInput,
} from "@/lib/backfill/bverfg-fetch-drain";

const now = Date.parse("2026-09-15T00:00:00.000Z");

function input(overrides: Partial<BverfgFetchDrainDecisionInput> = {}): BverfgFetchDrainDecisionInput {
  return {
    dueBacklog: 0,
    retryWait: 0,
    claimed: 0,
    failed: 0,
    residualClaimCount: 0,
    openRuns: [],
    nowMs: now,
    ...overrides,
  };
}

test("a cleared snapshot is complete only when no work, claims, or open passes remain", () => {
  assert.deepEqual(decideBverfgFetchDrain(input()), { kind: "complete" });
});

test("any remaining fetch work keeps the drain from reporting completion", () => {
  assert.equal(decideBverfgFetchDrain(input({ dueBacklog: 1 })).kind, "run_pass");
  assert.equal(decideBverfgFetchDrain(input({ retryWait: 1 })).kind, "wait");
  assert.equal(decideBverfgFetchDrain(input({ claimed: 1 })).kind, "wait");
  assert.equal(decideBverfgFetchDrain(input({ residualClaimCount: 1 })).kind, "wait");
  assert.equal(
    decideBverfgFetchDrain(input({ openRuns: [{ passNumber: 28, status: "queued", live: false }] })).kind,
    "run_pass",
  );
  assert.notEqual(decideBverfgFetchDrain(input({ failed: 1 })).kind, "complete");
});

test("a live attempt is observed instead of being submitted over", () => {
  const decision = decideBverfgFetchDrain(input({
    dueBacklog: 55,
    claimed: 1,
    residualClaimCount: 1,
    openRuns: [{ passNumber: 118, status: "running", live: true }],
  }));
  assert.deepEqual(decision, { kind: "wait", reason: "live_attempt" });
});

test("orphan queued and stale running passes are reused rather than duplicated", () => {
  const queued = decideBverfgFetchDrain(input({
    dueBacklog: 55,
    openRuns: [
      { passNumber: 28, status: "queued", live: false },
      { passNumber: 118, status: "running", live: false },
    ],
  }));
  assert.deepEqual(queued, { kind: "run_pass", reusePassNumber: 28 });

  const stale = decideBverfgFetchDrain(input({
    dueBacklog: 0,
    residualClaimCount: 1,
    openRuns: [{ passNumber: 118, status: "running", live: false }],
  }));
  assert.deepEqual(stale, { kind: "run_pass", reusePassNumber: 118 });
});

test("a new pass is requested only when no existing pass can be reused", () => {
  assert.deepEqual(decideBverfgFetchDrain(input({ dueBacklog: 12 })), {
    kind: "run_pass",
    reusePassNumber: null,
  });
});

test("retry wait and stranded claims are surfaced with distinct reasons", () => {
  assert.deepEqual(decideBverfgFetchDrain(input({ retryWait: 3 })), { kind: "wait", reason: "retry_wait" });
  assert.deepEqual(
    decideBverfgFetchDrain(input({ residualClaimCount: 1 })),
    { kind: "wait", reason: "active_claim" },
  );
});

test("repository run state maps live attempts and drops non-blocking statuses", () => {
  const mapped = drainOpenRunsFromRepository([
    {
      runId: "run-queued",
      passNumber: 28,
      status: "queued",
      p1AttemptId: null,
      p1FencingToken: null,
      commandRunId: null,
      attemptStatus: null,
      attemptLeaseExpiresAt: null,
    },
    {
      runId: "run-live",
      passNumber: 118,
      status: "running",
      p1AttemptId: "attempt-1",
      p1FencingToken: "124",
      commandRunId: "command-1",
      attemptStatus: "running",
      attemptLeaseExpiresAt: "2026-09-15T01:00:00.000Z",
    },
    {
      runId: "run-expired",
      passNumber: 200,
      status: "running",
      p1AttemptId: "attempt-2",
      p1FencingToken: "125",
      commandRunId: "command-2",
      attemptStatus: "running",
      attemptLeaseExpiresAt: "2026-09-14T00:00:00.000Z",
    },
    {
      runId: "run-deferred",
      passNumber: 6,
      status: "deferred",
      p1AttemptId: null,
      p1FencingToken: null,
      commandRunId: null,
      attemptStatus: null,
      attemptLeaseExpiresAt: null,
    },
  ], now);
  assert.deepEqual(mapped, [
    { passNumber: 28, status: "queued", live: false },
    { passNumber: 118, status: "running", live: true },
    { passNumber: 200, status: "running", live: false },
  ]);
});

test("the bounded drain wires completion to claims, residuals, and open passes", () => {
  const script = fs.readFileSync(path.join(process.cwd(), "scripts/drain-bverfg-fetch.ts"), "utf8");
  assert.match(script, /if \(!flag\("execute"\)\) return 0/);
  assert.match(script, /"--source=germany"/);
  assert.match(script, /`--batch-limit=\$\{input\.batchLimit\}`/);
  assert.match(script, /postgresCaseBackfillRepository\.countBacklog/);
  assert.match(script, /postgresCaseBackfillRepository\.countResidualClaims/);
  assert.match(script, /postgresCaseBackfillRepository\.listNonTerminalRuns/);
  assert.match(script, /decideBverfgFetchDrain/);
  assert.match(script, /maxConsecutiveFailures/);
  assert.match(script, /residualClaims: 0/);
  assert.match(script, /openRuns: 0/);
  assert.match(script, /publicCatalogWrites: 0/);
  assert.match(script, /geminiCalls: 0/);
  assert.doesNotMatch(script, /CASE_CATALOG_WRITE_ENABLED\s*=\s*["']true/);
});

test("the corpus CLI reuses queued or running passes instead of allocating orphans", () => {
  const script = fs.readFileSync(path.join(process.cwd(), "scripts/backfill-corpus.ts"), "utf8");
  assert.match(script, /resolvePassNumber/);
  assert.match(script, /listNonTerminalRuns/);
  assert.match(script, /case_backfill_pass_reused/);
});
