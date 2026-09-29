import { RATE_LIMIT_DO_CONSUME_PATH } from "@/lib/cloudflare/rate-limit/durable-object";
import type { RateLimitConsumeOutcome } from "@/lib/cloudflare/rate-limit/bucket";

/**
 * M13 runtime-neutral Durable Object binding seam.
 *
 * The Worker entry owns the `env` bindings. This module stores the rate-limit
 * Durable Object namespace on an isolate-scoped `globalThis` slot so the
 * distributed backend can reach it without importing the Worker entry or any
 * `node:*`/`next/*` module.
 *
 * The structural namespace/stub surface is defined here so the base repository
 * (which does not include the generated Worker types) compiles without
 * `@cloudflare/workers-types`.
 */

export interface DurableObjectIdLike {
  toString(): string;
}

export interface DurableObjectStubLike {
  fetch(request: Request): Promise<Response>;
}

export interface DurableObjectNamespaceLike {
  idFromName(name: string): DurableObjectIdLike;
  get(id: DurableObjectIdLike): DurableObjectStubLike;
}

export interface RateLimitConsumeInput {
  profile: string;
  identifier: string;
  limit: number;
  windowMs: number;
  nowMs?: number;
}

interface WorldconsRateLimitRuntimeGlobal {
  __worldconsRateLimitDurableObjectV1?: DurableObjectNamespaceLike;
  __worldconsRateLimitClockV1?: () => number;
}

function runtimeGlobal(): typeof globalThis & WorldconsRateLimitRuntimeGlobal {
  return globalThis as typeof globalThis & WorldconsRateLimitRuntimeGlobal;
}

/**
 * Registers the rate-limit Durable Object namespace. A `null`/`undefined` value
 * clears the slot, so re-registering on every request is authoritative.
 */
export function setRuntimeRateLimitDurableObjectBinding(
  binding: DurableObjectNamespaceLike | null | undefined,
): void {
  const target = runtimeGlobal();
  if (binding) target.__worldconsRateLimitDurableObjectV1 = binding;
  else delete target.__worldconsRateLimitDurableObjectV1;
}

export function getRuntimeRateLimitDurableObjectBinding(): DurableObjectNamespaceLike | null {
  return runtimeGlobal().__worldconsRateLimitDurableObjectV1 ?? null;
}

/** Test seam for a deterministic clock. A `null` value restores `Date.now`. */
export function setRuntimeRateLimitClock(clock: (() => number) | null): void {
  const target = runtimeGlobal();
  if (clock) target.__worldconsRateLimitClockV1 = clock;
  else delete target.__worldconsRateLimitClockV1;
}

export function runtimeRateLimitNow(): number {
  return runtimeGlobal().__worldconsRateLimitClockV1?.() ?? Date.now();
}

/** Derives the stable Durable Object name for one profile+identifier bucket. */
export function rateLimitBucketObjectName(profile: string, identifier: string): string {
  return `${profile}:${identifier}`;
}

function parseOutcome(value: unknown): RateLimitConsumeOutcome | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.limited !== "boolean"
    || !Number.isSafeInteger(record.count)
    || !Number.isSafeInteger(record.remaining)
    || typeof record.resetAt !== "number"
    || !Number.isFinite(record.resetAt)
    || !Number.isSafeInteger(record.retryAfterSeconds)
  ) {
    return null;
  }
  return {
    count: record.count as number,
    resetAt: record.resetAt,
    limited: record.limited,
    remaining: record.remaining as number,
    retryAfterSeconds: record.retryAfterSeconds as number,
  };
}

/**
 * Consumes one token through the Durable Object. Returns `null` when the binding
 * is unavailable or the object errors, so the caller can fall back to D1. A
 * malformed object response is treated as an error (`null`), never trusted.
 */
export async function consumeRateLimitViaDurableObject(
  binding: DurableObjectNamespaceLike | null,
  input: RateLimitConsumeInput,
): Promise<RateLimitConsumeOutcome | null> {
  if (!binding) return null;
  try {
    const id = binding.idFromName(rateLimitBucketObjectName(input.profile, input.identifier));
    const stub = binding.get(id);
    const response = await stub.fetch(new Request(`https://rate-limit.internal${RATE_LIMIT_DO_CONSUME_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }));
    if (!response.ok) return null;
    return parseOutcome(await response.json().catch(() => null));
  } catch {
    return null;
  }
}
