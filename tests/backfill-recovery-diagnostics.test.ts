import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  evaluateBackfillRecoveryState,
  readOnlyBackfillRecoveryQueries,
  type BackfillItemClaimState,
  type BackfillRecoverySnapshot,
  type BackfillRunState,
} from "@/lib/backfill/recovery-diagnostics";

const now = "2026-09-15T00:00:00.000Z";
const future = "2026-09-15T01:00:00.000Z";
const past = "2026-09-14T00:00:00.000Z";

const snapshot: BackfillRecoverySnapshot = {
  snapshotId: "d6c7b404-2252-4369-a719-8e17d2dfaba2",
  sourceKey: "de-bverfg",
  status: "closed",
  scopeFrom: "2024-01-01",
  scopeTo: "2024-12-31",
  documentType: "DECISION",
  parserVersion: "bverfg-official-normalize-v2",
  sourcePolicyVersion: "bverfg-unattended-canary-v1",
  discoveredCount: 287,
  manifestHash: "7".repeat(64),
};

const observedItemCount = 287;

function itemClaim(overrides: Partial<BackfillItemClaimState> = {}): BackfillItemClaimState {
  return {
    itemId: "item-1",
    status: "fetching",
    claimedPhase: "fetch",
    claimedAttemptId: "attempt-1",
    claimedFencingToken: "10",
    itemLeaseExpiresAt: future,
    attemptStatus: "running",
    attemptRunId: "command-run-1",
    attemptFencingToken: "10",
    attemptLeaseExpiresAt: future,
    commandRunStatus: "running",
    ...overrides,
  };
}

function run(overrides: Partial<BackfillRunState> = {}): BackfillRunState {
  return {
    runId: "backfill-run-1",
    phase: "fetch",
    passNumber: 117,
    status: "running",
    claimedCount: 2,
    succeededCount: 1,
    terminalFailedCount: 0,
    p1AttemptId: "attempt-1",
    p1FencingToken: "10",
    commandRunId: "command-run-1",
    attemptStatus: "running",
    attemptRunId: "command-run-1",
    attemptFencingToken: "10",
    attemptLeaseExpiresAt: future,
    commandRunStatus: "running",
    commandRunCurrentAttemptId: "attempt-1",
    startedAt: now,
    ...overrides,
  };
}

test("healthy snapshot has no mismatch codes", () => {
  const result = evaluateBackfillRecoveryState({
    snapshot,
    itemClaims: [itemClaim()],
    runs: [run()],
    observedItemCount,
    now,
  });
  assert.deepEqual(result.mismatches, []);
  assert.equal(result.summary.activeItemClaimCount, 1);
  assert.equal(result.summary.expiredItemClaimCount, 0);
  assert.equal(result.summary.runningRunCount, 1);
  assert.equal(result.summary.observedItemCount, 287);
});

test("expired item claim and dead attempt are detected", () => {
  const result = evaluateBackfillRecoveryState({
    snapshot,
    itemClaims: [itemClaim({
      itemLeaseExpiresAt: past,
      attemptStatus: "lease_expired",
      attemptLeaseExpiresAt: past,
      commandRunStatus: "failed",
    })],
    runs: [run({ status: "running", attemptStatus: "lease_expired", attemptLeaseExpiresAt: past, commandRunStatus: "failed" })],
    observedItemCount,
    now,
  });
  for (const code of [
    "item_claim_lease_expired",
    "item_claim_attempt_lease_expired",
    "item_claim_attempt_not_running",
    "item_claim_command_run_not_running",
    "backfill_run_running_without_live_attempt",
    "backfill_run_command_run_not_running",
  ]) {
    assert.ok(result.mismatches.includes(code), `expected ${code}`);
  }
  assert.equal(result.summary.expiredItemClaimCount, 1);
  assert.equal(result.summary.activeItemClaimCount, 0);
});

test("item lease must not outlive the P1 attempt lease", () => {
  const result = evaluateBackfillRecoveryState({
    snapshot,
    itemClaims: [itemClaim({ itemLeaseExpiresAt: "2026-09-15T02:00:00.000Z", attemptLeaseExpiresAt: future })],
    runs: [run()],
    observedItemCount,
    now,
  });
  assert.ok(result.mismatches.includes("item_lease_exceeds_attempt_lease"));
});

test("missing attempt and non-closed snapshot are detected", () => {
  const result = evaluateBackfillRecoveryState({
    snapshot: { ...snapshot, status: "open", manifestHash: null },
    itemClaims: [itemClaim({
      claimedAttemptId: "missing-attempt",
      attemptStatus: null,
      attemptFencingToken: null,
      attemptLeaseExpiresAt: null,
      commandRunStatus: null,
    })],
    runs: [],
    observedItemCount,
    now,
  });
  assert.ok(result.mismatches.includes("snapshot_not_closed"));
  assert.ok(result.mismatches.includes("item_claim_attempt_missing"));
});

test("terminal run with a live attempt is detected", () => {
  const result = evaluateBackfillRecoveryState({
    snapshot,
    itemClaims: [],
    runs: [run({ status: "succeeded" })],
    observedItemCount,
    now,
  });
  assert.ok(result.mismatches.includes("backfill_run_terminal_with_live_attempt"));
});

test("snapshot discovered count and manifest hash are validated against real values", () => {
  const mismatch = evaluateBackfillRecoveryState({
    snapshot,
    itemClaims: [],
    runs: [],
    observedItemCount: 286,
    now,
  });
  assert.ok(mismatch.mismatches.includes("snapshot_discovered_count_mismatch"), "count mismatch must be detected");
  assert.equal(mismatch.summary.discoveredCount, 287);
  assert.equal(mismatch.summary.observedItemCount, 286);

  const invalidHash = evaluateBackfillRecoveryState({
    snapshot: { ...snapshot, manifestHash: "not-a-sha256" },
    itemClaims: [],
    runs: [],
    observedItemCount,
    now,
  });
  assert.ok(invalidHash.mismatches.includes("snapshot_manifest_hash_invalid"), "invalid manifest hash must be detected");

  const missingHash = evaluateBackfillRecoveryState({
    snapshot: { ...snapshot, manifestHash: null },
    itemClaims: [],
    runs: [],
    observedItemCount,
    now,
  });
  assert.ok(missingHash.mismatches.includes("snapshot_manifest_hash_missing"), "missing manifest hash must be detected");

  const superseded = evaluateBackfillRecoveryState({
    snapshot: { ...snapshot, status: "superseded" },
    itemClaims: [],
    runs: [],
    observedItemCount,
    now,
  });
  assert.ok(superseded.mismatches.includes("snapshot_superseded"), "superseded snapshots must be surfaced");
});

test("stale fencing tokens and cross-run attempts are detected", () => {
  const result = evaluateBackfillRecoveryState({
    snapshot,
    itemClaims: [itemClaim({ claimedFencingToken: "9", attemptFencingToken: "10" })],
    runs: [run({ p1FencingToken: "9", attemptRunId: "different-command-run" })],
    observedItemCount,
    now,
  });
  assert.ok(result.mismatches.includes("item_claim_fencing_token_mismatch"));
  assert.ok(result.mismatches.includes("backfill_run_fencing_token_mismatch"));
  assert.ok(result.mismatches.includes("backfill_run_attempt_run_mismatch"));
});

test("stale queued passes and queued runs that still carry an attempt are detected", () => {
  const staleQueued = evaluateBackfillRecoveryState({
    snapshot,
    itemClaims: [],
    runs: [run({
      status: "queued",
      p1AttemptId: null,
      p1FencingToken: null,
      commandRunId: null,
      attemptStatus: null,
      attemptRunId: null,
      attemptFencingToken: null,
      attemptLeaseExpiresAt: null,
      commandRunStatus: null,
      commandRunCurrentAttemptId: null,
      startedAt: past,
    })],
    observedItemCount,
    now,
    staleQueuedRunMs: 60_000,
  });
  assert.ok(staleQueued.mismatches.includes("backfill_run_queued_stale"), "old queued passes must be surfaced");
  assert.equal(staleQueued.summary.queuedRunCount, 1);

  const queuedWithAttempt = evaluateBackfillRecoveryState({
    snapshot,
    itemClaims: [],
    runs: [run({ status: "queued" })],
    observedItemCount,
    now,
    staleQueuedRunMs: 60_000,
  });
  assert.ok(queuedWithAttempt.mismatches.includes("backfill_run_queued_with_attempt"), "queued runs must not carry an attempt");
});

test("read-only diagnose script never calls mutating client methods and reads canonical snapshot fields", () => {
  const script = fs.readFileSync(path.join(process.cwd(), "scripts/backfill-recovery-diagnose.ts"), "utf8");
  for (const forbidden of [".insert(", ".update(", ".delete(", ".upsert(", ".rpc(", ".storage"]) {
    assert.ok(!script.includes(forbidden), `read-only script must not use ${forbidden}`);
  }
  assert.ok(script.includes("readOnly: true"), "script must declare readOnly: true");
  assert.ok(script.includes("discovered_count"), "script must read discovered_count from the snapshot row");
  assert.ok(script.includes("manifest_hash"), "script must read manifest_hash from the snapshot row");
  assert.ok(script.includes("count: \"exact\""), "script must read the exact item count instead of inferring it from claims");
  assert.ok(script.includes("observedItemCount"), "script must pass the observed item count to the evaluator");
  assert.ok(
    !script.includes("discoveredCount: itemClaims.length"),
    "script must never fill discoveredCount from the claimed item rows",
  );
  assert.ok(
    !script.includes("manifestHash: null"),
    "script must never hard-code a null manifest hash",
  );
  const queries = readOnlyBackfillRecoveryQueries();
  assert.ok(queries.length > 0, "query spec must expose the diagnostic reads");
  assert.ok(queries.every((query) => /:select /.test(query) || /:select$/.test(query)), "query spec must be select-only");
  assert.ok(queries.some((query) => query.includes("discovered_count") && query.includes("manifest_hash")));
});
