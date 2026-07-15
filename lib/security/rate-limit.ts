import { NextResponse } from "next/server";
import { getClientIp, hashRequestValue } from "@/lib/security/request-client";

type RateLimitProfileDefinition = {
  envPrefix: string;
  defaultMax: number;
  defaultWindowMs: number;
};

const RATE_LIMIT_PROFILES = {
  publicApi: {
    envPrefix: "RATE_LIMIT_PUBLIC_API",
    defaultMax: 120,
    defaultWindowMs: 60_000,
  },
  cclMetasearch: {
    envPrefix: "RATE_LIMIT_CCL_METASEARCH",
    defaultMax: 120,
    defaultWindowMs: 60_000,
  },
  analyticsEvent: {
    envPrefix: "RATE_LIMIT_ANALYTICS_EVENT",
    defaultMax: 240,
    defaultWindowMs: 60_000,
  },
  cspReport: {
    envPrefix: "RATE_LIMIT_CSP_REPORT",
    defaultMax: 120,
    defaultWindowMs: 60_000,
  },
  adminLogin: {
    envPrefix: "RATE_LIMIT_ADMIN_LOGIN",
    defaultMax: 10,
    defaultWindowMs: 10 * 60_000,
  },
} satisfies Record<string, RateLimitProfileDefinition>;

export type RateLimitProfile = keyof typeof RATE_LIMIT_PROFILES;

type RateLimitBucket = {
  count: number;
  resetAt: number;
};

export type RateLimitResult = {
  limited: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfterSeconds: number;
  headers: HeadersInit;
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
    if (bucket.resetAt <= now) {
      buckets.delete(key);
    }
  }

  if (buckets.size <= MAX_STORE_SIZE) return;

  const overflow = buckets.size - MAX_STORE_SIZE;
  let deleted = 0;
  for (const key of buckets.keys()) {
    buckets.delete(key);
    deleted += 1;
    if (deleted >= overflow) break;
  }
}

function requestIdentifier(request: Request) {
  const ip = getClientIp(request.headers);
  if (ip) {
    return `ip:${hashRequestValue(ip) ?? ip}`;
  }

  const fallback = [
    request.headers.get("user-agent")?.slice(0, 240) ?? "unknown-agent",
    request.headers.get("accept-language")?.slice(0, 120) ?? "unknown-language",
  ].join("|");

  return `fallback:${hashRequestValue(fallback) ?? "unknown"}`;
}

function resultHeaders({ limit, remaining, resetAt, retryAfterSeconds }: Omit<RateLimitResult, "limited" | "headers">) {
  const headers: Record<string, string> = {
    "X-RateLimit-Limit": String(limit),
    "X-RateLimit-Remaining": String(remaining),
    "X-RateLimit-Reset": String(Math.ceil(resetAt / 1000)),
  };

  if (retryAfterSeconds > 0) {
    headers["Retry-After"] = String(retryAfterSeconds);
  }

  return headers;
}

export function consumeRateLimit(request: Request, profileName: RateLimitProfile): RateLimitResult | null {
  if (!envBool("RATE_LIMIT_ENABLED", true)) return null;

  const profile = RATE_LIMIT_PROFILES[profileName];
  const limit = envInt(`${profile.envPrefix}_MAX`, profile.defaultMax);
  const windowMs = envInt(`${profile.envPrefix}_WINDOW_MS`, profile.defaultWindowMs);
  if (limit <= 0 || windowMs <= 0) return null;

  const now = Date.now();
  const resetAt = now + windowMs;
  const key = `${profileName}:${requestIdentifier(request)}`;
  const buckets = store();
  cleanupExpiredBuckets(buckets, now);

  const current = buckets.get(key);
  const bucket = current && current.resetAt > now ? current : { count: 0, resetAt };
  bucket.count += 1;
  buckets.set(key, bucket);

  const retryAfterSeconds = Math.max(0, Math.ceil((bucket.resetAt - now) / 1000));
  const result = {
    limited: bucket.count > limit,
    limit,
    remaining: Math.max(0, limit - bucket.count),
    resetAt: bucket.resetAt,
    retryAfterSeconds,
  };

  return {
    ...result,
    retryAfterSeconds: result.limited ? retryAfterSeconds : 0,
    headers: resultHeaders({
      limit: result.limit,
      remaining: result.remaining,
      resetAt: result.resetAt,
      retryAfterSeconds: result.limited ? retryAfterSeconds : 0,
    }),
  };
}

export function rateLimitExceededResponse(result: RateLimitResult, message = "Too many requests") {
  return NextResponse.json(
    {
      error: message,
      retryAfterSeconds: result.retryAfterSeconds,
    },
    {
      status: 429,
      headers: result.headers,
    },
  );
}
