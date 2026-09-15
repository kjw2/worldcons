export interface BackfillRecoverySnapshot {
  snapshotId: string;
  sourceKey: string;
  status: string;
  scopeFrom: string | null;
  scopeTo: string | null;
  documentType: string;
  parserVersion: string;
  sourcePolicyVersion: string;
  discoveredCount: number | null;
  manifestHash: string | null;
}

export interface BackfillItemClaimState {
  itemId: string;
  status: string;
  claimedPhase: string | null;
  claimedAttemptId: string | null;
  claimedFencingToken: string | null;
  itemLeaseExpiresAt: string | null;
  attemptStatus: string | null;
  attemptRunId: string | null;
  attemptFencingToken: string | null;
  attemptLeaseExpiresAt: string | null;
  commandRunStatus: string | null;
}

export interface BackfillRunState {
  runId: string;
  phase: string;
  passNumber: number;
  status: string;
  claimedCount: number;
  succeededCount: number;
  terminalFailedCount: number;
  p1AttemptId: string | null;
  p1FencingToken: string | null;
  commandRunId: string | null;
  attemptStatus: string | null;
  attemptRunId: string | null;
  attemptFencingToken: string | null;
  attemptLeaseExpiresAt: string | null;
  commandRunStatus: string | null;
  commandRunCurrentAttemptId: string | null;
  startedAt: string | null;
}

export interface BackfillRecoveryStateInput {
  snapshot: BackfillRecoverySnapshot;
  itemClaims: BackfillItemClaimState[];
  runs: BackfillRunState[];
  observedItemCount: number | null;
  now: string;
  staleQueuedRunMs?: number;
}

export interface BackfillRecoveryStateResult {
  snapshot: BackfillRecoverySnapshot;
  summary: {
    observedItemCount: number | null;
    discoveredCount: number | null;
    itemClaimCount: number;
    activeItemClaimCount: number;
    expiredItemClaimCount: number;
    runCount: number;
    runningRunCount: number;
    queuedRunCount: number;
  };
  mismatches: string[];
  claimFindings: Array<{ itemId: string; codes: string[] }>;
  runFindings: Array<{ runId: string; codes: string[] }>;
}

const CLAIM_PHASES = ["fetch", "normalize", "verify", "publish"] as const;
const MANIFEST_HASH_PATTERN = /^[0-9a-f]{64}$/;
const DEFAULT_STALE_QUEUED_RUN_MS = 6 * 60 * 60 * 1000;

function isPast(value: string | null, nowMs: number) {
  if (!value) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed <= nowMs;
}

function hasValue(value: string | null) {
  return typeof value === "string" && value.length > 0;
}

function claimFindingsFor(itemClaim: BackfillItemClaimState, nowMs: number) {
  const codes: string[] = [];
  if (!itemClaim.claimedAttemptId) {
    codes.push("item_claim_attempt_missing");
    return codes;
  }
  if (!itemClaim.attemptStatus) {
    codes.push("item_claim_attempt_missing");
  } else if (itemClaim.attemptStatus !== "running") {
    codes.push("item_claim_attempt_not_running");
  }
  if (itemClaim.claimedPhase && !(CLAIM_PHASES as readonly string[]).includes(itemClaim.claimedPhase)) {
    codes.push("item_claim_phase_invalid");
  }
  if (isPast(itemClaim.itemLeaseExpiresAt, nowMs)) {
    codes.push("item_claim_lease_expired");
  }
  if (isPast(itemClaim.attemptLeaseExpiresAt, nowMs)) {
    codes.push("item_claim_attempt_lease_expired");
  }
  if (
    itemClaim.itemLeaseExpiresAt
    && itemClaim.attemptLeaseExpiresAt
    && Date.parse(itemClaim.itemLeaseExpiresAt) > Date.parse(itemClaim.attemptLeaseExpiresAt)
  ) {
    codes.push("item_lease_exceeds_attempt_lease");
  }
  if (
    hasValue(itemClaim.claimedFencingToken)
    && hasValue(itemClaim.attemptFencingToken)
    && itemClaim.claimedFencingToken !== itemClaim.attemptFencingToken
  ) {
    codes.push("item_claim_fencing_token_mismatch");
  }
  if (itemClaim.commandRunStatus && itemClaim.commandRunStatus !== "running") {
    codes.push("item_claim_command_run_not_running");
  }
  return codes;
}

function runFindingsFor(run: BackfillRunState, nowMs: number, staleQueuedRunMs: number) {
  const codes: string[] = [];
  const attemptLive = run.attemptStatus === "running" && !isPast(run.attemptLeaseExpiresAt, nowMs);
  if (run.status !== "queued" && run.p1AttemptId && !run.attemptStatus) {
    codes.push("backfill_run_attempt_missing");
  }
  if (run.status === "queued" && run.p1AttemptId) {
    codes.push("backfill_run_queued_with_attempt");
  }
  if (run.status === "queued" && !run.p1AttemptId && isPast(run.startedAt, nowMs - staleQueuedRunMs)) {
    codes.push("backfill_run_queued_stale");
  }
  if (run.status === "running") {
    if (!attemptLive) codes.push("backfill_run_running_without_live_attempt");
    if (run.commandRunStatus && run.commandRunStatus !== "running") {
      codes.push("backfill_run_command_run_not_running");
    }
    if (run.p1AttemptId && run.commandRunCurrentAttemptId && run.commandRunCurrentAttemptId !== run.p1AttemptId) {
      codes.push("backfill_run_attempt_not_current");
    }
    if (run.attemptRunId && run.commandRunId && run.attemptRunId !== run.commandRunId) {
      codes.push("backfill_run_attempt_run_mismatch");
    }
  }
  if (
    hasValue(run.p1FencingToken)
    && hasValue(run.attemptFencingToken)
    && run.p1FencingToken !== run.attemptFencingToken
  ) {
    codes.push("backfill_run_fencing_token_mismatch");
  }
  if (["succeeded", "degraded", "failed", "aborted"].includes(run.status) && attemptLive) {
    codes.push("backfill_run_terminal_with_live_attempt");
  }
  return codes;
}

function snapshotMismatches(snapshot: BackfillRecoverySnapshot, observedItemCount: number | null) {
  const codes: string[] = [];
  if (snapshot.status === "superseded") codes.push("snapshot_superseded");
  else if (snapshot.status === "failed") codes.push("snapshot_failed");
  else if (snapshot.status !== "closed") codes.push("snapshot_not_closed");
  if (["closed", "superseded"].includes(snapshot.status)) {
    if (!hasValue(snapshot.manifestHash)) codes.push("snapshot_manifest_hash_missing");
    else if (!MANIFEST_HASH_PATTERN.test(snapshot.manifestHash ?? "")) codes.push("snapshot_manifest_hash_invalid");
  }
  if (
    observedItemCount !== null
    && snapshot.discoveredCount !== null
    && observedItemCount !== snapshot.discoveredCount
  ) {
    codes.push("snapshot_discovered_count_mismatch");
  }
  return codes;
}

export function evaluateBackfillRecoveryState(
  input: BackfillRecoveryStateInput,
): BackfillRecoveryStateResult {
  const nowMs = Date.parse(input.now);
  if (!Number.isFinite(nowMs)) throw new Error("backfill_recovery.invalid_now");
  const staleQueuedRunMs = input.staleQueuedRunMs ?? DEFAULT_STALE_QUEUED_RUN_MS;
  const claimFindings = input.itemClaims
    .map((itemClaim) => ({ itemId: itemClaim.itemId, codes: claimFindingsFor(itemClaim, nowMs) }))
    .filter((finding) => finding.codes.length > 0);
  const runFindings = input.runs
    .map((run) => ({ runId: run.runId, codes: runFindingsFor(run, nowMs, staleQueuedRunMs) }))
    .filter((finding) => finding.codes.length > 0);
  const mismatches = new Set<string>(snapshotMismatches(input.snapshot, input.observedItemCount));
  for (const finding of claimFindings) for (const code of finding.codes) mismatches.add(code);
  for (const finding of runFindings) for (const code of finding.codes) mismatches.add(code);
  const expiredItemClaimCount = input.itemClaims.filter((claim) => isPast(claim.itemLeaseExpiresAt, nowMs)).length;
  return {
    snapshot: input.snapshot,
    summary: {
      observedItemCount: input.observedItemCount,
      discoveredCount: input.snapshot.discoveredCount,
      itemClaimCount: input.itemClaims.length,
      activeItemClaimCount: input.itemClaims.length - expiredItemClaimCount,
      expiredItemClaimCount,
      runCount: input.runs.length,
      runningRunCount: input.runs.filter((run) => run.status === "running").length,
      queuedRunCount: input.runs.filter((run) => run.status === "queued").length,
    },
    mismatches: [...mismatches].sort(),
    claimFindings,
    runFindings,
  };
}

export function readOnlyBackfillRecoveryQueries(): string[] {
  return [
    "source_inventory_snapshots:select id,source_key,scope_from,scope_to,document_type,parser_version,source_policy_version,status,discovered_count,manifest_hash",
    "source_backfill_items:select id,status,claimed_phase,claimed_attempt_id,claimed_fencing_token,lease_expires_at (claimed only)",
    "source_backfill_items:select id (exact count for snapshot)",
    "admin_command_attempts:select id,run_id,status,lease_expires_at,fencing_token",
    "admin_command_runs:select id,status,current_attempt_id",
    "source_backfill_runs:select id,phase,pass_number,status,claimed_count,succeeded_count,terminal_failed_count,p1_attempt_id,p1_fencing_token,command_run_id,started_at",
  ];
}
