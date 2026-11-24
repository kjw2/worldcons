import { ARTICLE_CONTENT_TYPES } from "@/lib/db/types";
import {
  PUBLIC_EDGE_CACHE_CONTROL,
  PUBLIC_EDGE_CACHE_STATUS_HEADER,
  edgeCacheKeyUrl,
  isEdgeCacheableRequest,
  isEdgeCacheableResponse,
} from "@/lib/cloudflare/public-edge-cache";
import type { EdgeCacheStorage } from "@/lib/cloudflare/public-edge-cache-runtime";
import {
  consumeFixedWindow,
  createPublicRateLimitStore,
  pruneExpiredRateLimitEntries,
  publicRateLimitKey,
  type PublicRateLimitStore,
} from "@/lib/cloudflare/public-rate-limit";

export interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface PublicListGuardGlobalBudgetOptions {
  limit?: number;
  windowMs?: number;
  store?: PublicRateLimitStore;
  now?: () => number;
}

export interface PublicListGuardEnv {
  WORLDCONS_LIST_MISS_LIMITER?: RateLimitBinding;
  WORLDCONS_LIST_IP_LIMITER?: RateLimitBinding;
  WORLDCONS_PUBLIC_RATE_LIMIT_DISABLED?: string;
}

export type PublicListGuardStatus = "HIT" | "MISS" | "BYPASS" | "REJECTED";

export interface PublicListGuardResult {
  response: Response;
  status: PublicListGuardStatus;
  key: string | null;
  reason?: string;
}

export type PublicListQueryResult =
  | { ok: true; url: string; changed: boolean }
  | { ok: false; reason: string };

const LIST_PATH = "/list";
const RETRY_AFTER_SECONDS = 60;
const MAX_QUERY_LENGTH = 512;
const MAX_QUERY_PARAMS = 24;
const MAX_Q_LENGTH = 200;

/** In-isolate aggregate fallback, shared by every client behind this isolate. */
const LIST_GLOBAL_LIMIT = 1_200;
const LIST_GLOBAL_WINDOW_MS = 60_000;
const listGlobalStore = createPublicRateLimitStore();
const LIST_METHODS = "GET, HEAD";
const RSC_HEADERS = ["rsc", "next-router-prefetch", "next-router-state-tree", "x-middleware-prefetch"];

const ALLOWED_KEYS = new Set([
  "q",
  "range",
  "source",
  "jurisdiction",
  "type",
  "tag",
  "language",
  "page",
]);

// `_rsc` is a Next.js framework cache-buster. RSC requests skip the shared
// cache below, but a plain HTML GET may still carry it.
const DROPPED_KEYS = new Set(["pageSize", "view", "sort", "mode", "_rsc"]);

const TRACKING_KEYS = new Set([
  "gclid",
  "fbclid",
  "msclkid",
  "yclid",
  "mc_cid",
  "mc_eid",
  "_ga",
  "_gl",
  "ref",
]);

const SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u;
const JURISDICTION_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}\s.,'()&/+-]{0,79}$/u;
const LANGUAGE_PATTERN = /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/u;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/u;
const CONTENT_TYPES = new Set<string>(ARTICLE_CONTENT_TYPES);

function isTrackingKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return normalized.startsWith("utm_") || TRACKING_KEYS.has(normalized);
}

function canonicalQuery(entries: Array<[string, string]>): string {
  entries.sort(([leftKey, leftValue], [rightKey, rightValue]) => {
    if (leftKey !== rightKey) return leftKey < rightKey ? -1 : 1;
    return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
  });
  return new URLSearchParams(entries).toString();
}

/**
 * Accepts only the query keys the public list reader consumes. Equivalent
 * spellings (empty values, `range=latest`, `page=1`, view-only keys) collapse
 * to one canonical URL; unknown or malformed keys are rejected before any D1
 * read. Common campaign parameters are stripped rather than rejected so normal
 * inbound links keep working.
 */
export function canonicalizePublicListUrl(input: URL): PublicListQueryResult {
  if (input.pathname !== LIST_PATH) return { ok: false, reason: "not_list" };
  if (input.search.length > MAX_QUERY_LENGTH) return { ok: false, reason: "query_too_long" };

  const sourceEntries = Array.from(input.searchParams);
  if (sourceEntries.length > MAX_QUERY_PARAMS) return { ok: false, reason: "too_many_params" };

  const seen = new Set<string>();
  const normalized = new Map<string, string>();

  for (const [key, rawValue] of sourceEntries) {
    if (DROPPED_KEYS.has(key) || isTrackingKey(key)) continue;
    if (!ALLOWED_KEYS.has(key)) return { ok: false, reason: "unknown_parameter" };
    if (seen.has(key)) return { ok: false, reason: "duplicate_parameter" };
    seen.add(key);

    const value = rawValue.trim();
    if (!value) continue;

    if (key === "q") {
      if (value.length > MAX_Q_LENGTH || CONTROL_PATTERN.test(value)) return { ok: false, reason: "invalid_q" };
      normalized.set(key, value);
      continue;
    }

    if (key === "range") {
      if (value === "latest") continue;
      if (value !== "today" && value !== "week" && value !== "month") return { ok: false, reason: "invalid_range" };
      normalized.set(key, value);
      continue;
    }

    if (key === "type") {
      if (!CONTENT_TYPES.has(value)) return { ok: false, reason: "invalid_type" };
      normalized.set(key, value);
      continue;
    }

    if (key === "source" || key === "tag") {
      if (!SLUG_PATTERN.test(value)) return { ok: false, reason: "invalid_slug" };
      normalized.set(key, value);
      continue;
    }

    if (key === "jurisdiction") {
      if (!JURISDICTION_PATTERN.test(value)) return { ok: false, reason: "invalid_jurisdiction" };
      normalized.set(key, value);
      continue;
    }

    if (key === "language") {
      if (!LANGUAGE_PATTERN.test(value)) return { ok: false, reason: "invalid_language" };
      normalized.set(key, value.toLowerCase());
      continue;
    }

    if (key === "page") {
      if (!/^[0-9]{1,5}$/u.test(value)) return { ok: false, reason: "invalid_page" };
      const page = Number(value);
      if (!Number.isSafeInteger(page) || page < 1 || page > 10_000) return { ok: false, reason: "invalid_page" };
      if (page > 1) normalized.set(key, String(page));
      continue;
    }

    return { ok: false, reason: "unknown_parameter" };
  }

  const canonical = new URL(input.toString());
  canonical.search = canonicalQuery(Array.from(normalized.entries()));
  return { ok: true, url: canonical.toString(), changed: canonical.toString() !== input.toString() };
}

function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip")?.trim() || "unknown";
}

function guardLog(event: string, details: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...details }));
}

function rejectedResponse(
  status: 400 | 429 | 503,
  reason: string,
  retryAfterSeconds = RETRY_AFTER_SECONDS,
): Response {
  return new Response(status === 429 ? "Too Many Requests" : status === 503 ? "Service Unavailable" : "Bad Request", {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
      "retry-after": String(retryAfterSeconds),
      "x-worldcons-list-guard": reason,
    },
  });
}

function methodNotAllowedResponse(): Response {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: {
      allow: LIST_METHODS,
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
      "x-worldcons-list-guard": "method_not_allowed",
    },
  });
}

/**
 * The aggregate budget survives distributed source IPs: official limiters are
 * per key, so this in-isolate fixed window is the only shared ceiling. It is
 * consumed for cache hits as well, before any list handling.
 */
function consumeGlobalBudget(options: PublicListGuardOptions) {
  const config = options.globalBudget ?? {};
  const now = config.now ? config.now() : Date.now();
  const store = config.store ?? listGlobalStore;
  const key = publicRateLimitKey(LIST_PATH, "global");
  pruneExpiredRateLimitEntries(store, now);
  const decision = consumeFixedWindow(
    store.get(key),
    config.limit ?? LIST_GLOBAL_LIMIT,
    config.windowMs ?? LIST_GLOBAL_WINDOW_MS,
    now,
  );
  store.set(key, decision.state);
  return decision;
}

type LimiterOutcome = "allow" | "limit" | "unavailable";

async function consume(
  binding: RateLimitBinding | undefined,
  key: string,
): Promise<LimiterOutcome> {
  if (!binding || typeof binding.limit !== "function") return "unavailable";
  try {
    const outcome = await binding.limit({ key });
    if (!outcome || typeof outcome.success !== "boolean") return "unavailable";
    return outcome.success ? "allow" : "limit";
  } catch {
    return "unavailable";
  }
}

function cachedResponse(cached: Response): Response {
  const headers = new Headers(cached.headers);
  headers.set(PUBLIC_EDGE_CACHE_STATUS_HEADER, "HIT");
  return new Response(cached.body, { status: cached.status, statusText: cached.statusText, headers });
}

function markedResponse(response: Response, status: "MISS" | "BYPASS"): Response {
  const headers = new Headers(response.headers);
  headers.set(PUBLIC_EDGE_CACHE_STATUS_HEADER, status);
  if (status === "MISS") headers.set("cache-control", PUBLIC_EDGE_CACHE_CONTROL);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function storedResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", PUBLIC_EDGE_CACHE_CONTROL);
  headers.set(PUBLIC_EDGE_CACHE_STATUS_HEADER, "MISS");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export interface PublicListGuardOptions {
  request: Request;
  env: PublicListGuardEnv;
  cache: EdgeCacheStorage | null;
  fetchOrigin: (request: Request) => Promise<Response>;
  waitUntil?: (promise: Promise<unknown>) => void;
  /** Test/operations override for the in-isolate aggregate fallback. */
  globalBudget?: PublicListGuardGlobalBudgetOptions;
}

/**
 * Worker-level guard for `/list`. Every origin read is bounded, regardless of
 * client-controlled headers or method:
 *
 * - unsupported methods are rejected with 405;
 * - an in-isolate global budget (1,200/min) protects against distributed IPs;
 * - ordinary GETs canonicalize the query and may use the shared edge cache;
 * - authorization/cookie/RSC/prefetch requests skip the shared cache only and
 *   still consume the per-IP all-request (120/min) and origin-miss (30/min)
 *   limits before origin;
 * - a limiter failure fails closed for origin reads, and a cache lookup failure
 *   still consumes both limits, so a broken cache cannot cause unbounded D1.
 */
export async function guardPublicListRequest(options: PublicListGuardOptions): Promise<PublicListGuardResult> {
  const { request, env, cache, fetchOrigin } = options;
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return { response: await fetchOrigin(request), status: "BYPASS", key: null };
  }

  if (url.pathname !== LIST_PATH) {
    return { response: await fetchOrigin(request), status: "BYPASS", key: null };
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    guardLog("public_list_method_rejected", { method: request.method });
    return { response: methodNotAllowedResponse(), status: "REJECTED", key: null, reason: "method_not_allowed" };
  }

  const limiterDisabled = env.WORLDCONS_PUBLIC_RATE_LIMIT_DISABLED === "true";

  if (!limiterDisabled) {
    const global = consumeGlobalBudget(options);
    if (!global.allowed) {
      guardLog("public_list_rate_limited", { scope: "global" });
      return {
        response: rejectedResponse(429, "global_limit", global.retryAfterSeconds),
        status: "REJECTED",
        key: null,
        reason: "global_limit",
      };
    }
  }

  const headers = request.headers;
  const personalized =
    headers.get("authorization") !== null ||
    headers.get("cookie") !== null ||
    headers.get("range") !== null ||
    RSC_HEADERS.some((header) => headers.get(header) !== null);
  const cacheable = !personalized && Boolean(cache && isEdgeCacheableRequest(request));
  let canonicalRequest = request;
  let key: string | null = null;

  if (cacheable) {
    const canonical = canonicalizePublicListUrl(url);
    if (!canonical.ok) {
      guardLog("public_list_query_rejected", { reason: canonical.reason });
      return { response: rejectedResponse(400, canonical.reason), status: "REJECTED", key: null, reason: canonical.reason };
    }

    canonicalRequest = canonical.url === request.url ? request : new Request(canonical.url, request);
    key = edgeCacheKeyUrl(canonical.url);

    try {
      const cached = await cache!.match(key);
      if (cached) {
        if (!limiterDisabled) {
          const ipOutcome = await consume(env.WORLDCONS_LIST_IP_LIMITER, `list-ip:${clientIp(request)}`);
          if (ipOutcome === "limit") {
            guardLog("public_list_rate_limited", { scope: "ip", cache: "HIT" });
            return { response: rejectedResponse(429, "ip_limit"), status: "REJECTED", key, reason: "ip_limit" };
          }
          if (ipOutcome === "unavailable") {
            guardLog("public_list_rate_limiter_unavailable", { scope: "ip", cache: "HIT" });
          }
        }
        return { response: cachedResponse(cached), status: "HIT", key };
      }
    } catch {
      // A cache lookup failure degrades to a normal, fully rate-limited origin render.
    }
  }

  if (!limiterDisabled) {
    const ip = clientIp(request);
    const surface = cacheable ? "MISS" : "BYPASS";
    const ipOutcome = await consume(env.WORLDCONS_LIST_IP_LIMITER, `list-ip:${ip}`);
    if (ipOutcome === "limit") {
      guardLog("public_list_rate_limited", { scope: "ip", cache: surface });
      return { response: rejectedResponse(429, "ip_limit"), status: "REJECTED", key, reason: "ip_limit" };
    }
    if (ipOutcome === "unavailable") {
      guardLog("public_list_rate_limiter_unavailable", { scope: "ip", cache: surface });
      return { response: rejectedResponse(503, "ip_limiter_unavailable"), status: "REJECTED", key, reason: "ip_limiter_unavailable" };
    }

    const missOutcome = await consume(env.WORLDCONS_LIST_MISS_LIMITER, `list-miss:${ip}`);
    if (missOutcome === "limit") {
      guardLog("public_list_rate_limited", { scope: "miss", cache: surface });
      return { response: rejectedResponse(429, "miss_limit"), status: "REJECTED", key, reason: "miss_limit" };
    }
    if (missOutcome === "unavailable") {
      guardLog("public_list_rate_limiter_unavailable", { scope: "miss", cache: surface });
      return { response: rejectedResponse(503, "miss_limiter_unavailable"), status: "REJECTED", key, reason: "miss_limiter_unavailable" };
    }
  }

  const response = await fetchOrigin(canonicalRequest);
  if (!cacheable || !cache || !key || !isEdgeCacheableResponse(response)) {
    return { response: markedResponse(response, "BYPASS"), status: "BYPASS", key };
  }

  const put = cache.put(key, storedResponse(response.clone())).catch(() => undefined);
  if (options.waitUntil) options.waitUntil(put);
  else await put;
  return { response: markedResponse(response, "MISS"), status: "MISS", key };
}
