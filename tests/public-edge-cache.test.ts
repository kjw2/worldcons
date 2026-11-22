import assert from "node:assert/strict";
import test from "node:test";
import {
  PUBLIC_EDGE_CACHE_CONTROL,
  PUBLIC_EDGE_CACHE_STATUS_HEADER,
  edgeCacheKeyUrl,
  isEdgeCacheableRequest,
  isEdgeCacheableResponse,
  normalizedEdgeCacheSearch,
} from "../lib/cloudflare/public-edge-cache";
import { serveWithEdgeCache, type EdgeCacheStorage } from "../lib/cloudflare/public-edge-cache-runtime";
import { consumeFixedWindow, publicRateLimitKey } from "../lib/cloudflare/public-rate-limit";

function request(url: string, headers: Record<string, string> = {}, method = "GET") {
  return {
    method,
    url,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  };
}

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

test("edge cache keys drop view-only parameters and sort the rest", () => {
  assert.equal(normalizedEdgeCacheSearch("?b=2&pageSize=50&a=1&view=grid&sort=old"), "a=1&b=2");
  assert.equal(normalizedEdgeCacheSearch("?page=3&source=us-scotus&pageSize=10"), "page=3&source=us-scotus");
  assert.equal(edgeCacheKeyUrl("https://worldcons.cclib.workers.dev/list?pageSize=50&page=2&view=grid"), "https://worldcons.cclib.workers.dev/list?page=2");
});

test("edge cache eligibility fails closed for personalized, admin, RSC and non-HTML requests", () => {
  assert.equal(isEdgeCacheableRequest(request("https://x.test/")), true);
  assert.equal(isEdgeCacheableRequest(request("https://x.test/list?page=2")), true);
  for (const url of ["https://x.test/search", "https://x.test/admin", "https://x.test/list?page=2", "https://x.test/api/articles"]) {
    const expected = url.startsWith("https://x.test/list");
    assert.equal(isEdgeCacheableRequest(request(url)), expected, url);
  }
  assert.equal(isEdgeCacheableRequest(request("https://x.test/list", { cookie: "session=1" })), false);
  assert.equal(isEdgeCacheableRequest(request("https://x.test/list", { authorization: "Bearer x" })), false);
  assert.equal(isEdgeCacheableRequest(request("https://x.test/list", { "next-router-prefetch": "1" })), false);
  assert.equal(isEdgeCacheableRequest(request("https://x.test/list", { accept: "application/json" })), false);
  assert.equal(isEdgeCacheableRequest(request("https://x.test/list", {}, "POST")), false);
});

test("a successful HTML page is cached and served as a HIT; non-HTML is not stored", async () => {
  const cache = memoryCache();
  let renders = 0;
  const origin = async () => {
    renders += 1;
    return new Response("<html>ok</html>", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  };
  const options = {
    request: request("https://x.test/list?pageSize=10&page=1&view=grid"),
    cache,
    fetchOrigin: origin,
  };

  const first = await serveWithEdgeCache(options);
  assert.equal(first.status, "MISS");
  assert.equal(first.response.headers.get(PUBLIC_EDGE_CACHE_STATUS_HEADER), "MISS");
  assert.equal(first.response.headers.get("cache-control"), PUBLIC_EDGE_CACHE_CONTROL);
  assert.equal(renders, 1);

  const second = await serveWithEdgeCache({ ...options, request: request("https://x.test/list?view=grid&page=1") });
  assert.equal(second.status, "HIT");
  assert.equal(second.response.headers.get(PUBLIC_EDGE_CACHE_STATUS_HEADER), "HIT");
  assert.equal(renders, 1, "a normalized key must hit the same cached entry");

  assert.equal(isEdgeCacheableResponse({ status: 200, headers: { get: () => "application/json" } }), false);
  assert.equal(isEdgeCacheableResponse({ status: 200, headers: { get: (name) => (name === "set-cookie" ? "a=1" : "text/html") } }), false);
});

test("fixed-window rate limit allows the budget then rejects with a retry hint", () => {
  const key = publicRateLimitKey("/list", "203.0.113.9");
  assert.equal(key, "/list:203.0.113.9");
  let state;
  for (let index = 0; index < 60; index += 1) {
    const decision = consumeFixedWindow(state, 60, 60_000, 1_000);
    assert.equal(decision.allowed, true);
    state = decision.state;
  }
  const rejected = consumeFixedWindow(state, 60, 60_000, 1_000);
  assert.equal(rejected.allowed, false);
  assert.ok(rejected.retryAfterSeconds >= 1);
  const reset = consumeFixedWindow(rejected.state, 60, 60_000, 120_000);
  assert.equal(reset.allowed, true);
});
