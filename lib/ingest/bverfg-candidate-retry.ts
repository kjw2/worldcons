/**
 * Pure BVerfG candidate retry/backoff semantics.
 *
 * This module is intentionally dependency-free so it can be shared by both the
 * Node ingestion path (`lib/ingest/run.ts`) and the Cloudflare native crawler
 * (`workers/async-pipeline/src/native-crawler.ts`) without pulling the Supabase
 * runtime into the Worker bundle. It is the single source of truth for how long
 * an unresolved official BVerfG URL candidate stays deferred before a bounded
 * recheck.
 */

export interface BverfgTrackedCandidate {
  url: string;
  status: string;
  attemptCount: number;
  lastAttemptAt?: string | null;
  lastErrorCode?: string | null;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const BVERFG_RETRY_SCHEDULE_GRACE_MS = 6 * HOUR_MS;

export function bverfgRetryErrorClass(errorCode?: string | null) {
  const code = errorCode ?? "";
  if (code === "BVERFG_OFFICIAL_VARIANTS_404") return "variants-404" as const;
  if (code === "BVERFG_OFFICIAL_DETAIL_404") return "single-404" as const;
  if (code === "BVERFG_OFFICIAL_DETAIL_403" || /403|blocked/i.test(code)) return "blocked" as const;
  if (code === "CRAWLEE_DETAIL_EMPTY") return "empty" as const;
  if (code === "BVERFG_OFFICIAL_DETAIL_UNVERIFIED" || code === "BVERFG_SITE_BLOCK_CIRCUIT_OPEN") return "blocked" as const;
  return "none" as const;
}

export function bverfgCandidateRetryDelayMs(attemptCount: number, errorCode?: string | null) {
  const kind = bverfgRetryErrorClass(errorCode);
  if (kind === "none" || kind === "single-404") return 0;
  if (kind === "variants-404") {
    if (attemptCount >= 10) return 3 * DAY_MS;
    if (attemptCount >= 6) return 2 * DAY_MS;
    if (attemptCount >= 3) return DAY_MS;
    return 12 * HOUR_MS;
  }
  if (kind === "empty") {
    if (attemptCount >= 6) return DAY_MS;
    if (attemptCount >= 3) return 12 * HOUR_MS;
    return 3 * HOUR_MS;
  }
  if (attemptCount >= 6) return 3 * DAY_MS;
  if (attemptCount >= 3) return DAY_MS;
  return 6 * HOUR_MS;
}

export function shouldRetryBverfgCandidates(records: BverfgTrackedCandidate[], now = new Date()) {
  const retrying = records.filter((record) => record.status === "retrying");
  if (retrying.length === 0) return true;
  return retrying.some((record) => {
    const delay = bverfgCandidateRetryDelayMs(record.attemptCount, record.lastErrorCode);
    if (delay === 0 || !record.lastAttemptAt) return true;
    const lastAttempt = Date.parse(record.lastAttemptAt);
    const grace = bverfgRetryErrorClass(record.lastErrorCode) === "variants-404" ? BVERFG_RETRY_SCHEDULE_GRACE_MS : 0;
    const effectiveDelay = Math.max(0, delay - grace);
    return !Number.isFinite(lastAttempt) || now.getTime() - lastAttempt >= effectiveDelay;
  });
}
