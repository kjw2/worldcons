import type { D1RuntimeDatabase } from "@/lib/cloudflare/d1/runtime-binding";
import {
  assertRateLimitIdentity,
  assertRateLimitConsumeInput,
  type RateLimitConsumeOutcome,
} from "@/lib/cloudflare/rate-limit/bucket";

/**
 * M13 `worldcons_ops` D1 rate-limit fallback.
 *
 * Used only when the Durable Object hot path is unavailable or errors, and only
 * after the authority selector has selected `d1`. It runs a single atomic
 * `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` against the existing
 * `security_rate_limit_buckets_v1` schema, reproducing the Supabase RPC
 * semantics (expired window resets to 1 with a new reset_at, otherwise
 * increments; limited when count > limit). It never contacts Supabase.
 *
 * Timestamps are stored as ISO-8601 text (the D1 canonical form) while the
 * comparison uses the caller-supplied clock, so the result is deterministic in
 * tests without relying on SQLite's `now`.
 */

export interface RateLimitD1Outcome extends RateLimitConsumeOutcome {
  /** The bucket reset timestamp in absolute epoch milliseconds. */
  resetAtMs: number;
}

function boundedIso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Atomically consumes one token in D1. Throws on a missing/unsupported binding
 * or a malformed row so the caller falls back to the process-local limiter
 * rather than trusting an invalid response.
 */
export async function consumeRateLimitInD1(
  binding: D1RuntimeDatabase,
  profile: string,
  identifier: string,
  limit: number,
  windowMs: number,
  nowMs: number,
): Promise<RateLimitD1Outcome> {
  assertRateLimitIdentity(profile, identifier);
  assertRateLimitConsumeInput(limit, windowMs, nowMs);

  const nowIso = boundedIso(nowMs);
  const freshResetIso = boundedIso(nowMs + windowMs);

  const statement = binding.prepare([
    "INSERT INTO security_rate_limit_buckets_v1",
    "(profile, identifier_hash, request_count, reset_at, updated_at)",
    "VALUES (?, ?, 1, ?, ?)",
    "ON CONFLICT (profile, identifier_hash) DO UPDATE SET",
    "request_count = CASE WHEN security_rate_limit_buckets_v1.reset_at <= ? THEN 1",
    "ELSE security_rate_limit_buckets_v1.request_count + 1 END,",
    "reset_at = CASE WHEN security_rate_limit_buckets_v1.reset_at <= ? THEN ?",
    "ELSE security_rate_limit_buckets_v1.reset_at END,",
    "updated_at = ?",
    "RETURNING request_count, reset_at",
  ].join(" "));

  const bound = statement.bind(
    profile,
    identifier,
    freshResetIso,
    nowIso,
    nowIso,
    nowIso,
    freshResetIso,
    nowIso,
  );
  if (typeof bound.all !== "function") throw new Error("rate_limit_d1_backend.all_unavailable");
  const result = await bound.all<Record<string, unknown>>();
  if (!result || result.success === false || result.error) {
    throw new Error("rate_limit_d1_backend.query_failed");
  }
  const row = Array.isArray(result.results) ? result.results[0] : undefined;
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    throw new Error("rate_limit_d1_backend.invalid_response");
  }
  const record = row as Record<string, unknown>;
  const count = record.request_count;
  const resetAtRaw = record.reset_at;
  const resetAtMs = typeof resetAtRaw === "string" ? Date.parse(resetAtRaw) : Number(resetAtRaw);
  if (!Number.isSafeInteger(count) || !Number.isFinite(resetAtMs)) {
    throw new Error("rate_limit_d1_backend.invalid_response");
  }
  const normalizedCount = count as number;
  const limited = normalizedCount > limit;
  const remaining = Math.max(0, limit - normalizedCount);
  const retryAfterSeconds = limited ? Math.max(1, Math.ceil((resetAtMs - nowMs) / 1000)) : 0;
  return { count: normalizedCount, resetAt: resetAtMs, resetAtMs, limited, remaining, retryAfterSeconds };
}
