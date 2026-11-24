import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalizePublicListUrl,
  guardPublicListRequest,
  type PublicListGuardEnv,
  type PublicListGuardOptions,
  type RateLimitBinding,
} from "../lib/cloudflare/public-list-guard";
import type { EdgeCacheStorage } from "../lib/cloudflare/public-edge-cache-runtime";
import { createPublicRateLimitStore } from "../lib/cloudflare/public-rate-limit";

function memoryCache(): EdgeCacheStorage & { entries: Map<string, Response> } {
  const entries = new Map<string, Response>();
  return {
    entries,
    async match(key) {
      return entries.get(key);
    },
    async put(key, response) {
      entries.set(key, response);
    },
    async delete(key) {
      return entries.delete(key);
    },
  };
}

function fixedLimiter(limit: number): RateLimitBinding & { counts: Map<string, number> } {
  const counts = new Map<string, number>();
  return {
    counts,
    async limit({ key }) {
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return { success: next <= limit };
    },
  };
}

function request(url: string, headers: Record<string, string> = {}, method = "GET") {
  return new Request(url, { method, headers: { "cf-connecting-ip": "203.0.113.9", ...headers } });
}

function htmlResponse() {
  return new Response("<html>ok</html>", {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function guardOptions(
  url: string,
  env: PublicListGuardEnv,
  cache: EdgeCacheStorage,
  onOrigin: () => void,
  headers: Record<string, string> = {},
  extra: Pick<Partial<PublicListGuardOptions>, "globalBudget"> & { method?: string } = {},
) {
  return {
    request: request(url, headers, extra.method),
    env,
    cache,
    globalBudget: extra.globalBudget,
    fetchOrigin: async () => {
      onOrigin();
      return htmlResponse();
    },
  };
}

test("canonicalizes only semantically equivalent list queries", () => {
  assert.deepEqual(
    canonicalizePublicListUrl(new URL("https://x.test/list?pageSize=50&view=grid&page=2&utm_source=a&source=us-scotus")),
    { ok: true, url: "https://x.test/list?page=2&source=us-scotus", changed: true },
  );
  assert.equal(canonicalizePublicListUrl(new URL("https://x.test/list?range=latest&page=1&mode=semantic")).ok, true);
  assert.equal(
    (canonicalizePublicListUrl(new URL("https://x.test/list?range=latest&page=1&mode=semantic")) as { url: string }).url,
    "https://x.test/list",
  );
  assert.equal(
    (canonicalizePublicListUrl(new URL("https://x.test/list?language=EN&q=%20")) as { url: string }).url,
    "https://x.test/list?language=en",
  );
  const jurisdiction = canonicalizePublicListUrl(new URL("https://x.test/list?jurisdiction=United%20States"));
  assert.equal(jurisdiction.ok, true);
  assert.equal(new URL((jurisdiction as { url: string }).url).searchParams.get("jurisdiction"), "United States");
});

test("drops the Next.js RSC query cache-buster for plain HTML GETs", () => {
  assert.deepEqual(
    canonicalizePublicListUrl(new URL("https://x.test/list?_rsc=abc123&page=2")),
    { ok: true, url: "https://x.test/list?page=2", changed: true },
  );
});

test("rejects unknown, duplicate and malformed list queries before origin", () => {
  for (const [url, reason] of [
    ["https://x.test/list?cb=123", "unknown_parameter"],
    ["https://x.test/list?page=1&page=2", "duplicate_parameter"],
    ["https://x.test/list?source=../etc", "invalid_slug"],
    ["https://x.test/list?type=DECISION", "invalid_type"],
    ["https://x.test/list?page=10001", "invalid_page"],
    ["https://x.test/list?range=year", "invalid_range"],
    ["https://x.test/list?language=en%2F..", "invalid_language"],
  ] as const) {
    const result = canonicalizePublicListUrl(new URL(url));
    assert.equal(result.ok, false, url);
    assert.equal((result as { reason: string }).reason, reason, url);
  }
});

test("cache hit serves without origin/D1 work and shares the canonical key", async () => {
  const cache = memoryCache();
  const env: PublicListGuardEnv = {
    WORLDCONS_LIST_IP_LIMITER: fixedLimiter(100),
    WORLDCONS_LIST_MISS_LIMITER: fixedLimiter(30),
  };
  let originCalls = 0;

  const first = await guardPublicListRequest(guardOptions("https://x.test/list?pageSize=50&view=grid&page=2", env, cache, () => { originCalls += 1; }));
  assert.equal(first.status, "MISS");
  assert.equal(originCalls, 1);

  const second = await guardPublicListRequest(guardOptions("https://x.test/list?page=2&utm_source=newsletter", env, cache, () => { originCalls += 1; }));
  assert.equal(second.status, "HIT");
  assert.equal(second.response.headers.get("x-worldcons-edge-cache"), "HIT");
  assert.equal(originCalls, 1, "a canonical cache hit must not read D1");
});

test("31st cache miss in the same minute is 429 with Retry-After and no origin read", async () => {
  const cache = memoryCache();
  const env: PublicListGuardEnv = {
    WORLDCONS_LIST_IP_LIMITER: fixedLimiter(1_000),
    WORLDCONS_LIST_MISS_LIMITER: fixedLimiter(30),
  };
  let originCalls = 0;

  for (let page = 1; page <= 30; page += 1) {
    const result = await guardPublicListRequest(guardOptions(`https://x.test/list?page=${page}`, env, cache, () => { originCalls += 1; }));
    assert.equal(result.status, "MISS", `page ${page}`);
  }

  const limited = await guardPublicListRequest(guardOptions("https://x.test/list?page=31", env, cache, () => { originCalls += 1; }));
  assert.equal(limited.status, "REJECTED");
  assert.equal(limited.response.status, 429);
  assert.equal(limited.response.headers.get("retry-after"), "60");
  assert.equal(limited.response.headers.get("cache-control"), "no-store");
  assert.equal(limited.response.headers.get("x-worldcons-list-guard"), "miss_limit");
  assert.equal(originCalls, 30, "the limited request must not reach origin/D1");
});

test("the separate IP cap also covers cache hits", async () => {
  const cache = memoryCache();
  const env: PublicListGuardEnv = {
    WORLDCONS_LIST_IP_LIMITER: fixedLimiter(2),
    WORLDCONS_LIST_MISS_LIMITER: fixedLimiter(30),
  };
  let originCalls = 0;

  const first = await guardPublicListRequest(guardOptions("https://x.test/list?page=7", env, cache, () => { originCalls += 1; }));
  const second = await guardPublicListRequest(guardOptions("https://x.test/list?page=7", env, cache, () => { originCalls += 1; }));
  const third = await guardPublicListRequest(guardOptions("https://x.test/list?page=7", env, cache, () => { originCalls += 1; }));

  assert.equal(first.status, "MISS");
  assert.equal(second.status, "HIT");
  assert.equal(third.response.status, 429);
  assert.equal(third.response.headers.get("x-worldcons-list-guard"), "ip_limit");
  assert.equal(originCalls, 1);
});

test("missing or failing miss limiter fails closed before origin", async () => {
  const cache = memoryCache();
  let originCalls = 0;

  const missing = await guardPublicListRequest(guardOptions("https://x.test/list?page=9", {
    WORLDCONS_LIST_IP_LIMITER: fixedLimiter(100),
  }, cache, () => { originCalls += 1; }));
  assert.equal(missing.response.status, 503);
  assert.equal(missing.response.headers.get("retry-after"), "60");
  assert.equal(missing.response.headers.get("cache-control"), "no-store");
  assert.equal(missing.response.headers.get("x-worldcons-list-guard"), "miss_limiter_unavailable");

  const throwing: RateLimitBinding = {
    async limit() {
      throw new Error("binding unavailable");
    },
  };
  const failed = await guardPublicListRequest(guardOptions("https://x.test/list?page=10", {
    WORLDCONS_LIST_IP_LIMITER: fixedLimiter(100),
    WORLDCONS_LIST_MISS_LIMITER: throwing,
  }, cache, () => { originCalls += 1; }));
  assert.equal(failed.response.status, 503);
  assert.equal(failed.response.headers.get("x-worldcons-list-guard"), "miss_limiter_unavailable");
  assert.equal(originCalls, 0, "a limiter failure must not start an unbounded read");
});

test("a failing IP limiter still allows an already-cached hit", async () => {
  const cache = memoryCache();
  let originCalls = 0;
  const healthy: PublicListGuardEnv = {
    WORLDCONS_LIST_IP_LIMITER: fixedLimiter(100),
    WORLDCONS_LIST_MISS_LIMITER: fixedLimiter(30),
  };
  await guardPublicListRequest(guardOptions("https://x.test/list?page=11", healthy, cache, () => { originCalls += 1; }));

  const broken: RateLimitBinding = {
    async limit() {
      throw new Error("binding unavailable");
    },
  };
  const hit = await guardPublicListRequest(guardOptions("https://x.test/list?page=11", {
    WORLDCONS_LIST_IP_LIMITER: broken,
    WORLDCONS_LIST_MISS_LIMITER: broken,
  }, cache, () => { originCalls += 1; }));
  assert.equal(hit.status, "HIT");
  assert.equal(originCalls, 1);
});

test("invalid queries are rejected before the cache or origin", async () => {
  const cache = memoryCache();
  const env: PublicListGuardEnv = {
    WORLDCONS_LIST_IP_LIMITER: fixedLimiter(100),
    WORLDCONS_LIST_MISS_LIMITER: fixedLimiter(30),
  };
  let originCalls = 0;
  const result = await guardPublicListRequest(guardOptions("https://x.test/list?cb=123", env, cache, () => { originCalls += 1; }));
  assert.equal(result.response.status, 400);
  assert.equal(result.response.headers.get("cache-control"), "no-store");
  assert.equal(result.response.headers.get("x-worldcons-list-guard"), "unknown_parameter");
  assert.equal(originCalls, 0);
});

test("non-list requests still bypass the list guard", async () => {
  let originCalls = 0;
  const other = await guardPublicListRequest(guardOptions("https://x.test/search?q=test", {}, memoryCache(), () => { originCalls += 1; }));
  assert.equal(other.status, "BYPASS");
  assert.equal(originCalls, 1);
});

test("an arbitrary Authorization header never bypasses the limits or shared cache", async () => {
  const cache = memoryCache();
  let originCalls = 0;
  const shared = guardOptions("https://x.test/list?page=5", {
    WORLDCONS_LIST_IP_LIMITER: fixedLimiter(1_000),
    WORLDCONS_LIST_MISS_LIMITER: fixedLimiter(30),
  }, cache, () => { originCalls += 1; });
  assert.equal((await guardPublicListRequest(shared)).status, "MISS");

  const authorized = guardOptions("https://x.test/list?page=5", {
    WORLDCONS_LIST_IP_LIMITER: fixedLimiter(1_000),
    WORLDCONS_LIST_MISS_LIMITER: fixedLimiter(1),
  }, cache, () => { originCalls += 1; }, { authorization: "Bearer forged-admin" });
  const first = await guardPublicListRequest(authorized);
  assert.equal(first.status, "BYPASS", "authorized traffic must not share the public cache");
  assert.equal(originCalls, 2, "authorized traffic reaches origin only after the limits");

  const second = await guardPublicListRequest(authorized);
  assert.equal(second.response.status, 429);
  assert.equal(second.response.headers.get("x-worldcons-list-guard"), "miss_limit");
  assert.equal(originCalls, 2, "the second authorized request must be limited before origin");
});

test("cookie and RSC/prefetch requests are limited before origin, not rejected", async () => {
  const cache = memoryCache();
  let originCalls = 0;

  const cookieEnv: PublicListGuardEnv = {
    WORLDCONS_LIST_IP_LIMITER: fixedLimiter(1_000),
    WORLDCONS_LIST_MISS_LIMITER: fixedLimiter(1),
  };
  const cookie = guardOptions("https://x.test/list?page=6", cookieEnv, cache, () => { originCalls += 1; }, { cookie: "session=1" });
  assert.equal((await guardPublicListRequest(cookie)).status, "BYPASS");
  const cookieLimited = await guardPublicListRequest(cookie);
  assert.equal(cookieLimited.response.status, 429);
  assert.equal(cookieLimited.response.headers.get("x-worldcons-list-guard"), "miss_limit");

  const rscEnv: PublicListGuardEnv = {
    WORLDCONS_LIST_IP_LIMITER: fixedLimiter(1_000),
    WORLDCONS_LIST_MISS_LIMITER: fixedLimiter(1),
  };
  const rsc = guardOptions("https://x.test/list?_rsc=abc123&page=6", rscEnv, cache, () => { originCalls += 1; }, { rsc: "1" });
  const rscFirst = await guardPublicListRequest(rsc);
  assert.equal(rscFirst.response.status, 200, "the framework _rsc parameter must not be rejected");
  assert.equal(rscFirst.status, "BYPASS");
  assert.equal(originCalls, 2);
  const rscLimited = await guardPublicListRequest(rsc);
  assert.equal(rscLimited.response.status, 429);
  assert.equal(rscLimited.response.headers.get("x-worldcons-list-guard"), "miss_limit");
  assert.equal(originCalls, 2);
});

test("unsupported methods are 405 before origin while HEAD stays bounded", async () => {
  const cache = memoryCache();
  let originCalls = 0;
  const env: PublicListGuardEnv = {
    WORLDCONS_LIST_IP_LIMITER: fixedLimiter(1_000),
    WORLDCONS_LIST_MISS_LIMITER: fixedLimiter(30),
  };

  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
    const result = await guardPublicListRequest(guardOptions("https://x.test/list?page=1", env, cache, () => { originCalls += 1; }, {}, { method }));
    assert.equal(result.response.status, 405, method);
    assert.equal(result.response.headers.get("allow"), "GET, HEAD");
    assert.equal(result.response.headers.get("cache-control"), "no-store");
  }
  assert.equal(originCalls, 0, "unsupported methods must never reach origin/D1");

  const head = await guardPublicListRequest(guardOptions("https://x.test/list?page=1", env, cache, () => { originCalls += 1; }, {}, { method: "HEAD" }));
  assert.equal(head.status, "BYPASS");
  assert.equal(originCalls, 1);
});

test("the in-isolate global budget protects against distributed IPs, including cache hits", async () => {
  const cache = memoryCache();
  const env: PublicListGuardEnv = {
    WORLDCONS_LIST_IP_LIMITER: fixedLimiter(1_000),
    WORLDCONS_LIST_MISS_LIMITER: fixedLimiter(1_000),
  };
  let originCalls = 0;
  const globalBudget = {
    limit: 2,
    windowMs: 60_000,
    store: createPublicRateLimitStore(),
    now: () => 1_000_000,
  };

  const first = await guardPublicListRequest(guardOptions("https://x.test/list?page=8", env, cache, () => { originCalls += 1; }, { "cf-connecting-ip": "198.51.100.1" }, { globalBudget }));
  const second = await guardPublicListRequest(guardOptions("https://x.test/list?page=8", env, cache, () => { originCalls += 1; }, { "cf-connecting-ip": "198.51.100.2" }, { globalBudget }));
  const third = await guardPublicListRequest(guardOptions("https://x.test/list?page=9", env, cache, () => { originCalls += 1; }, { "cf-connecting-ip": "198.51.100.3" }, { globalBudget }));

  assert.equal(first.status, "MISS");
  assert.equal(second.status, "HIT", "a different IP can share the cache");
  assert.equal(third.response.status, 429);
  assert.equal(third.response.headers.get("x-worldcons-list-guard"), "global_limit");
  assert.equal(originCalls, 1, "the global budget must stop the distributed request before origin");
});
