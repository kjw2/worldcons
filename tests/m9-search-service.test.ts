import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createWorldconsSearchServiceApp } from "@/lib/cloudflare/services/worldcons-search-service";
import { getSupabaseAdmin, getSupabaseServiceRoleAdmin } from "@/lib/db/client";
import { setRuntimePlatform } from "@/lib/runtime/platform";
import type { D1RuntimeDatabase } from "@/lib/cloudflare/d1/runtime-binding";
function healthyD1(): D1RuntimeDatabase {
  return {
    prepare() {
      return {
        bind() { return this; },
        async all<T = Record<string, unknown>>() {
          return { success: true, results: [{ ready: 1 } as T] };
        },
      };
    },
  };
}

const workerEnv = {
  ENVIRONMENT: "test",
  PUBLIC_BASE_URL: "https://worldcons.cclib.workers.dev/api/cclrag2",
  WORLDCONS_CORE: healthyD1(),
  WORLDCONS_SEARCH: healthyD1(),
  WORLDCONS_SEARCH_VECTOR: { async query() { return { matches: [] }; } },
};

test("M9 named search service preserves the provider contract", async () => {
  const app = createWorldconsSearchServiceApp();
  const viaHono = await app.request(
    "https://service.internal/api/sources",
    { headers: { "x-request-id": "m9-contract" } },
    workerEnv,
  );

  assert.equal(viaHono.status, 200);
  assert.equal(viaHono.headers.get("x-provider-contract-version"), "2.0");
  assert.equal(viaHono.headers.get("x-request-id"), "m9-contract");
  const payload = await viaHono.json() as { items: unknown[]; service: string };
  assert.equal(payload.service, "worldcons");
  assert.ok(Array.isArray(payload.items));
});

test("M9 reusable search service has health and a D1-only readiness probe", async () => {
  const app = createWorldconsSearchServiceApp();
  const health = await app.request("https://service.internal/health", {}, workerEnv);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {
    schemaVersion: 1,
    service: "worldcons-search",
    status: "ready",
    transport: "cloudflare-service-binding",
  });

  const probe = await app.request("https://service.internal/internal/upstream-probe", {}, {
    ...workerEnv,
    GEMINI_API_KEY: "test-gemini-key",
  });
  assert.equal(probe.status, 200);
  const payload = await probe.json() as Record<string, unknown>;
  assert.equal(payload.status, "healthy");
  assert.deepEqual(payload.configured, {
    coreD1: true,
    searchD1: true,
    vectorize: true,
    geminiApiKey: true,
  });
  assert.deepEqual(payload.d1, { core: { ok: true }, search: { ok: true } });
  assert.equal(JSON.stringify(payload).includes("test-gemini-key"), false);

  const unavailable = await app.request("https://service.internal/internal/upstream-probe", {}, {});
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json() as { status: string }).status, "unhealthy");
});

test("M9 internal cclmetasearch validates its service-binding contract", async () => {
  const app = createWorldconsSearchServiceApp({
    cclMetasearchSearch: async (input) => {
      assert.deepEqual(input, {
        query: "표현의 자유",
        limit: 2,
        offset: 4,
        sort: "latest",
      });
      return { items: [], total: 9 };
    },
  });
  const response = await app.request(
    "https://service.internal/internal/cclmetasearch/search",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "표현의 자유", limit: 2, offset: 4, sort: "latest" }),
    },
    workerEnv,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { items: [], total: 9 });

  const invalid = await app.request(
    "https://service.internal/internal/cclmetasearch/search",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "", limit: 999, offset: 0, sort: "latest" }),
    },
    workerEnv,
  );
  assert.equal(invalid.status, 400);
});

test("Cloudflare runtime Supabase clients are unavailable even when secrets are present", () => {
  const originalUrl = process.env.SUPABASE_URL;
  const originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_URL = "https://blocked.example";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "must-not-be-used";
  setRuntimePlatform("cloudflare-worker");
  try {
    assert.equal(getSupabaseAdmin(), null);
    assert.equal(getSupabaseServiceRoleAdmin(), null);
  } finally {
    setRuntimePlatform(null);
    if (originalUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = originalUrl;
    if (originalKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey;
  }
});

test("M9 named entrypoint owns internal requests while default fetch stays vinext", async () => {
  const worker = fs.readFileSync(path.join(process.cwd(), "worker/index.ts"), "utf8");
  const config = fs.readFileSync(path.join(process.cwd(), "wrangler.jsonc"), "utf8");
  assert.match(worker, /export class WorldconsSearchService extends WorkerEntrypoint/u);
  assert.match(worker, /return searchServiceApp\.fetch\(request, env\)/u);
  assert.match(worker, /async searchCclMetasearch\(input: CclMetasearchSearchInput\)/u);
  assert.match(worker, /return searchCclMetasearchWithEnv\(validated/u);
  assert.match(worker, /return handler\.fetch\(request, env, ctx\)/u);
  assert.doesNotMatch(worker.slice(worker.indexOf("export default {"), worker.indexOf("const searchServiceApp")), /searchServiceApp|\/internal/u);
  assert.doesNotMatch(config, /"WORLDCONS_SEARCH_SERVICE"|"service":\s*"worldcons-search"/u);
  assert.match(config, /"index_name":\s*"worldcons-search"/u);
  assert.match(config, /"binding":\s*"WORLDCONS_SEARCH_VECTOR"/u);

  const app = createWorldconsSearchServiceApp();
  const internal = new Request("https://worker.example/internal/upstream-probe");
  assert.equal((await app.fetch(internal, workerEnv)).status, 200);
  const defaultHandler = worker.slice(worker.indexOf("export default {"), worker.indexOf("const searchServiceApp"));
  assert.doesNotMatch(defaultHandler, /searchServiceApp|\/internal/u);
  assert.match(defaultHandler, /handler\.fetch\(request, env, ctx\)/u);
});

test("M9 public cclrag2 adapter keeps rate limiting before direct D1 reads", () => {
  const route = fs.readFileSync(
    path.join(process.cwd(), "app/api/cclrag2/[...path]/route.ts"),
    "utf8",
  );
  const rateLimitIndex = route.indexOf('consumeRateLimit(request, "publicApi")');
  const directD1Index = route.indexOf('getRuntimeD1Binding("worldcons_core")');
  assert.ok(rateLimitIndex >= 0);
  assert.ok(directD1Index > rateLimitIndex);
  assert.match(route, /getRuntimeWorldconsSearchServiceEnv/u);
  assert.match(route, /handleWorldconsSearchRequest\(/u);
  assert.doesNotMatch(route, /forwardToRuntimeSearchService/u);
});

test("WorldconsOpsService initializes D1, Vectorize, and Gemini bindings for native embedding backfills", () => {
  const worker = fs.readFileSync(path.join(process.cwd(), "worker/index.ts"), "utf8");
  const config = fs.readFileSync(path.join(process.cwd(), "wrangler.jsonc"), "utf8");
  assert.match(worker, /export class WorldconsOpsService extends WorkerEntrypoint/u);
  assert.match(worker, /async runEmbeddingBackfill\(input: \{ limit\?: number; maxPasses\?: number; delayMs\?: number \}\)/u);
  assert.match(worker, /setRuntimeD1Bindings\(\{ worldcons_core: env\.WORLDCONS_CORE \}\)/u);
  assert.match(worker, /setRuntimeSearchVectorBinding\(env\.WORLDCONS_SEARCH_VECTOR\)/u);
  assert.match(worker, /apiKeys: \[env\.GEMINI_API_KEY, \.\.\.\(env\.GEMINI_API_KEYS/u);
  assert.match(worker, /model: env\.GEMINI_EMBEDDING_MODEL/u);
  assert.match(worker, /provider: env\.EMBEDDING_PROVIDER/u);
  assert.match(config, /"binding":\s*"WORLDCONS_SEARCH_VECTOR"/u);
  assert.match(config, /"GEMINI_EMBEDDING_MODEL":\s*"gemini-embedding-001"/u);
});

test("M9 main config contains the D1 and Gemini runtime settings without a self-binding", () => {
  const config = fs.readFileSync(path.join(process.cwd(), "wrangler.jsonc"), "utf8");
  assert.match(config, /"binding":\s*"WORLDCONS_CORE"/u);
  assert.match(config, /"binding":\s*"WORLDCONS_SEARCH"/u);
  assert.match(config, /"SEMANTIC_SEARCH_ENABLED":\s*"true"/u);
  assert.match(config, /"GEMINI_EMBEDDING_MODEL":\s*"gemini-embedding-001"/u);
  assert.match(config, /"ARTIFACT_BLOB_PROVIDER":\s*"r2"/u);
  assert.match(config, /"main":\s*"\.\/worker\/index\.ts"/u);
  assert.doesNotMatch(config, /"no_bundle"/u);
  assert.doesNotMatch(config, /"WORLDCONS_SEARCH_SERVICE"|"service":\s*"worldcons-search"/u);

  const builtWorkerPath = path.join(process.cwd(), "dist/server/index.js");
  if (fs.existsSync(builtWorkerPath)) {
    const builtWorker = fs.readFileSync(builtWorkerPath, "utf8");
    assert.match(builtWorker, /WorldconsSearchService/u);
    assert.match(builtWorker, /RateLimitBucketDurableObject/u);
    assert.match(builtWorker, /export\{[^}]*WorldconsSearchService/u);
    assert.doesNotMatch(builtWorker, /@supabase\/supabase-js/u);
  }
});
