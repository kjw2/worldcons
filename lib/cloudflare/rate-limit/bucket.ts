/**
 * M13 distributed rate-limit bucket algorithm.
 *
 * Pure, runtime-neutral and storage-neutral. It reproduces the exact semantics
 * of the existing `worldcons_consume_rate_limit_v1` Postgres function so the
 * Durable Object, the D1 fallback and the Supabase path all agree:
 *
 * - a bucket is keyed by `profile` + `identifier_hash` (the caller supplies the
 *   already-hashed identifier);
 * - a missing/expired bucket (reset_at <= now) starts a new window at count 1
 *   with `resetAt = now + windowMs`;
 * - otherwise the live bucket increments;
 * - `limited` is `count > limit`;
 * - `remaining` is `max(0, limit - count)`;
 * - `retryAfterSeconds` is `ceil((resetAt - now) / 1000)` when limited, else 0.
 *
 * Validation is fail-closed: an out-of-range limit, window or non-finite clock
 * throws rather than consuming a malformed bucket.
 */

export const RATE_LIMIT_MAX_LIMIT = 100000;
export const RATE_LIMIT_MAX_WINDOW_MS = 86_400_000;
export const RATE_LIMIT_MIN_WINDOW_MS = 1_000;

export interface RateLimitBucketState {
  count: number;
  resetAt: number;
}

export interface RateLimitConsumeOutcome {
  count: number;
  resetAt: number;
  limited: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

const RATE_LIMIT_PROFILE_PATTERN = /^[^\s].{0,79}$/u;
const RATE_LIMIT_IDENTIFIER_PATTERN = /^[A-Za-z0-9:_-]{8,200}$/u;

function assertFiniteInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`rate_limit_backend.invalid_${name}`);
  }
}

/** Fail-closed validation of the bucket profile/identifier key components. */
export function assertRateLimitIdentity(profile: string, identifier: string): void {
  if (typeof profile !== "string" || !RATE_LIMIT_PROFILE_PATTERN.test(profile.trim())) {
    throw new Error("rate_limit_backend.invalid_profile");
  }
  if (typeof identifier !== "string" || !RATE_LIMIT_IDENTIFIER_PATTERN.test(identifier)) {
    throw new Error("rate_limit_backend.invalid_identifier");
  }
}

/** Validates the limit/window/clock inputs, throwing on any out-of-range value. */
export function assertRateLimitConsumeInput(limit: number, windowMs: number, nowMs: number): void {
  assertFiniteInteger(nowMs, "clock");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > RATE_LIMIT_MAX_LIMIT) {
    throw new Error("rate_limit_backend.invalid_limit");
  }
  if (!Number.isSafeInteger(windowMs) || windowMs < RATE_LIMIT_MIN_WINDOW_MS || windowMs > RATE_LIMIT_MAX_WINDOW_MS) {
    throw new Error("rate_limit_backend.invalid_window");
  }
}

/**
 * Consumes one token from a bucket, returning the next bucket state and the
 * external result fields. `current` is the persisted bucket (or null when none
 * exists / it cannot be represented).
 */
export function consumeRateLimitBucket(
  current: RateLimitBucketState | null,
  limit: number,
  windowMs: number,
  nowMs: number,
): RateLimitConsumeOutcome {
  assertRateLimitConsumeInput(limit, windowMs, nowMs);
  const live = current && Number.isSafeInteger(current.count) && Number.isFinite(current.resetAt) && current.resetAt > nowMs;
  const count = live ? current!.count + 1 : 1;
  const resetAt = live ? current!.resetAt : nowMs + windowMs;
  const limited = count > limit;
  const remaining = Math.max(0, limit - count);
  const retryAfterSeconds = limited ? Math.max(1, Math.ceil((resetAt - nowMs) / 1000)) : 0;
  return { count, resetAt, limited, remaining, retryAfterSeconds };
}
