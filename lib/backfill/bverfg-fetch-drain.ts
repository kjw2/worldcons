import type { CaseBackfillOpenRun } from "@/lib/backfill/repository";

export type BverfgFetchDrainWaitReason = "live_attempt" | "retry_wait" | "active_claim";

export interface BverfgFetchDrainOpenRun {
  passNumber: number;
  status: "queued" | "running";
  live: boolean;
}

export interface BverfgFetchDrainDecisionInput {
  dueBacklog: number;
  retryWait: number;
  claimed: number;
  failed: number;
  residualClaimCount: number;
  openRuns: BverfgFetchDrainOpenRun[];
  nowMs: number;
}

export type BverfgFetchDrainDecision =
  | { kind: "complete" }
  | { kind: "wait"; reason: BverfgFetchDrainWaitReason }
  | { kind: "run_pass"; reusePassNumber: number | null };

const NON_BLOCKING_RUN_STATUSES = new Set(["deferred"]);

export function drainOpenRunsFromRepository(
  runs: CaseBackfillOpenRun[],
  nowMs: number,
): BverfgFetchDrainOpenRun[] {
  return runs
    .filter((run) => !NON_BLOCKING_RUN_STATUSES.has(run.status))
    .filter((run): run is CaseBackfillOpenRun & { status: "queued" | "running" } => (
      run.status === "queued" || run.status === "running"
    ))
    .map((run) => {
      const leaseMs = run.attemptLeaseExpiresAt ? Date.parse(run.attemptLeaseExpiresAt) : Number.NaN;
      const live = run.status === "running"
        && run.attemptStatus === "running"
        && Number.isFinite(leaseMs)
        && leaseMs > nowMs;
      return { passNumber: run.passNumber, status: run.status, live };
    });
}

export function decideBverfgFetchDrain(input: BverfgFetchDrainDecisionInput): BverfgFetchDrainDecision {
  const reusable = input.openRuns.find((run) => run.status === "queued")
    ?? input.openRuns.find((run) => run.status === "running");
  const allClear = input.failed === 0
    && input.dueBacklog === 0
    && input.retryWait === 0
    && input.claimed === 0
    && input.residualClaimCount === 0
    && input.openRuns.length === 0;
  if (allClear) return { kind: "complete" };
  if (input.openRuns.some((run) => run.status === "running" && run.live)) {
    return { kind: "wait", reason: "live_attempt" };
  }
  if (input.dueBacklog > 0 || reusable) {
    return { kind: "run_pass", reusePassNumber: reusable?.passNumber ?? null };
  }
  return { kind: "wait", reason: input.retryWait > 0 ? "retry_wait" : "active_claim" };
}
