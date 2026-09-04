import type { CaseBackfillPhase } from "@/lib/backfill/types";

export const DEFAULT_CASE_BACKFILL_BATCH_LIMIT = 50;
export const BVERFG_FETCH_BATCH_LIMIT = 2;

/**
 * BVerfG fetches are deliberately slower than the other phases: the approved
 * source policy permits one request every 30 seconds and a docket can require
 * two official URL candidates. Keep one P1 pass bounded while still allowing
 * an operator to provide a deliberate, audited CLI override.
 */
export function defaultCaseBackfillBatchLimit(sourceKey: string, phase: CaseBackfillPhase) {
  return sourceKey === "de-bverfg" && phase === "fetch"
    ? BVERFG_FETCH_BATCH_LIMIT
    : DEFAULT_CASE_BACKFILL_BATCH_LIMIT;
}
