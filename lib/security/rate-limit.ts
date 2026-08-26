import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/db/client";
import { getClientIp, hashRequestValue } from "@/lib/security/request-client";

type RateLimitProfileDefinition = {
  envPrefix: string;
  defaultMax: number;
  defaultWindowMs: number;
};

const RATE_LIMIT_PROFILES = {
  publicApi: { envPrefix: "RATE_LIMIT_PUBLIC_API", defaultMax: 120, defaultWindowMs: 60_000 },
  cclMetasearch: { envPrefix: "RATE_LIMIT_CCL_METASEARCH", defaultMax: 120, defaultWindowMs: 60_000 },
  analyticsEvent: { envPrefix: "RATE_LIMIT_ANALYTICS_EVENT", defaultMax: 240, defaultWindowMs: 60_000 },
  cspReport: { envPrefix: "RATE_LIMIT_CSP_REPORT", defaultMax: 120, defaultWindowMs: 60_000 },
  adminLogin: { envPrefix: "RATE_LIMIT_ADMIN_LOGIN", defaultMax: 10, defaultWindowMs: 10 * 60_000 },
} satisfies Record<string, RateLimitProfileDefinition>;

export type RateLimitProfile = keyof typeof RATE_LIMIT_PROFILES;
export type RateLimitBackend = "distributed" | "local";

type RateLimitBucket = { count: number; resetAt: number };

export type RateLimitResult = {
  limited: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfterSeconds: number;
  backend: RateLimitBackend;
  headers: HeadersInit;
};

type DistributedRateLimitPayload = {
  limited?: unknown;
  limit?: unknown;
  remaining?: unknown;
  resetAt?: unknown;
  retryAfterSeconds?: unknown;
};

const STORE_KEY = "__worldconsRateLimitStore";
const MAX_STORE_SIZE = 10_000;

declare global {
  var __worldconsRateLimitStore: Map<string, RateLimitBucket> | undefined;
}

function store() {
  globalThis[STORE_KEY] ??= new Map<string, RateLimitBucket>();
  return globalThis[STORE_KEY];
}

function envBool(name: string, defaultValue: boolean) {
  const value = process.env[name]?.trim().toLowerCase();
  if (value === "true" || value === "1" || value === "yes") return true;
  if (value === "false" || value === "0" || value === "no") return false;
  return defaultValue;
}

function envInt(name: string, defaultValue: number) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value >= 0 ? value : defaultValue;
}

function cleanupExpiredBuckets(buckets: Map<string, RateLimitBucket>, now: number) {
  if (buckets.size <= MAX_STORE_SIZE) return;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
  if (buckets.size <= MAX_STORE_SIZE) return;
  let overflow = buckets.size - MAX_STORE_SIZE;
  for (const key of buckets.keys()) {
    buckets.delete(key);
    overflow -= 1;
    if (overflow <= 0) break;
  }
}

function requestIdentifier(request: Request) {
  const ip = getClientIp(request.headers);
  if (ip) return `ip:${hashRequestValue(ip) ?? ip}`;
  const fallback = [
    request.headers.get("user-agent")?.slice(0, 240) ?? "unknown-agent",
    request.headers.get("accept-language")?.slice(0, 120) ?? "unknown-language",
  ].join("|");
  return `fallback:${hashRequestValue(fallback) ?? "unknown"}`;
}

function resultHeaders(input: Omit<RateLimitResult, "limited" | "headers">) {
  const headers: Record<string, string> = {
    "X-RateLimit-Limit": String(input.limit),
    "X-RateLimit-Remaining": String(input.remaining),
    "X-RateLimit-Reset": String(Math.ceil(input.resetAt / 1000)),
    "X-RateLimit-Backend": input.backend,
  };
  if (input.retryAfterSeconds > 0) headers["Retry-After"] = String(input.retryAfterSeconds);
  return headers;
}

function buildResult(
  backend: RateLimitBackend,
  limited: boolean,
  limit: number,
  remaining: number,
  resetAt: number,
  retryAfterSeconds: number,
): RateLimitResult {
  const normalizedRetry = limited ? Math.max(1, retryAfterSeconds) : 0;
  const result = { limited, limit, remaining: Math.max(0, remaining), resetAt, retryAfterSeconds: normalizedRetry, backend };
  return { ...result, headers: resultHeaders(result) };
}

function consumeLocal(profileName: RateLimitProfile, identifier: string, limit: number, windowMs: number) {
  const now = Date.now();
  const resetAt = now + windowMs;
  const key = `${profileName}:${identifier}`;
  const buckets = store();
  cleanupExpiredBuckets(buckets, now);
  const current = buckets.get(key);
  const bucket = current && current.resetAt > now ? current : { count: 0, resetAt };
  bucket.count += 1;
  buckets.set(key, bucket);
  const limited = bucket.count > limit;
  const retryAfterSeconds = Math.max(0, Math.ceil((bucket.resetAt - now) / 1000));
  return buildResult("local", limited, limit, limit - bucket.count, bucket.resetAt, retryAfterSeconds);
}

function finiteInteger(value: unknown) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

async function consumeDistributed(
  profileName: RateLimitProfile,
  identifier: string,
  limit: number,
  windowMs: number,
): Promise<RateLimitResult | null> {
  if (!envBool("RATE_LIMIT_DISTRIBUTED_ENABLED", true)) return null;
  const supabase = getSupabaseAdmin();
  if (!supabase) return null;

  try {
    const { data, error } = await supabase.rpc("worldcons_consume_rate_limit_v1", {
      p_profile: profileName,
      p_identifier_hash: identifier,
      p_limit: limit,
      p_window_ms: windowMs,
    });
    if (error || !data || typeof data !== "object" || Array.isArray(data)) return null;
    const payload = data as DistributedRateLimitPayload;
    const returnedLimit = finiteInteger(payload.limit);
    const remaining = finiteInteger(payload.remaining);
    const resetAt = finiteInteger(payload.resetAt);
    const retryAfterSeconds = finiteInteger(payload.retryAfterSeconds);
    if (typeof payload.limited !== "boolean" || returnedLimit !== limit || remaining === null || resetAt === null || retryAfterSeconds === null) {
      return null;
    }
    return buildResult("distributed", payload.limited, limit, remaining, resetAt, retryAfterSeconds);
  } catch {
    return null;
  }
}

export async function consumeRateLimit(request: Request, profileName: RateLimitProfile): Promise<RateLimitResult | null> {
  if (!envBool("RATE_LIMIT_ENABLED", true)) return null;
  const profile = RATE_LIMIT_PROFILES[profileName];
  const limit = envInt(`${profile.envPrefix}_MAX`, profile.defaultMax);
  const windowMs = envInt(`${profile.envPrefix}_WINDOW_MS`, profile.defaultWindowMs);
  if (limit <= 0 || windowMs <= 0) return null;

  const identifier = requestIdentifier(request);
  const distributed = await consumeDistributed(profileName, identifier, limit, windowMs);
  if (distributed) return distributed;
  return consumeLocal(profileName, identifier, limit, windowMs);
}

export function rateLimitExceededResponse(result: RateLimitResult, message = "Too many requests") {
  return NextResponse.json(
    { error: message, retryAfterSeconds: result.retryAfterSeconds },
    { status: 429, headers: result.headers },
  );
}
