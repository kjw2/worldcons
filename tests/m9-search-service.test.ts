import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  clearRuntimeSearchServiceBinding,
  forwardToRuntimeSearchService,
  searchCclMetasearchViaRuntimeService,
  setRuntimeSearchServiceBinding,
} from "@/lib/cloudflare/services/search-service-binding";
import {
  handleWorldconsSearchRequest,
  type Cclrag2ProviderEnv,
} from "@/lib/integrations/cclrag2/provider-handler";
import {
  createWorldconsSearchServiceApp,
  type WorldconsSearchWorkerEnv,
} from "@/workers/search-service/src/index";

const providerEnv = {
  ENVIRONMENT: "test",
  PUBLIC_BASE_URL: "https://worldcons.vercel.app/api/cclrag2",
} satisfies Cclrag2ProviderEnv;

const workerEnv = {
  ...providerEnv,
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
} satisfies WorldconsSearchWorkerEnv;

function sourceFetcher(): typeof fetch {
  return async () => Response.json([
    {
      sourceKey: "de-bverfg",
      name: "Bundesverfassungsgericht",
      jurisdiction: "Germany",
      baseUrl: "https://www.bundesverfassungsgericht.de",
      language: "de",
      isActive: true,
    },
  ]);
}

test("M9 worldcons-search Hono service preserves the existing provider contract", async () => {
  const fetcher = sourceFetcher();
  const direct = await handleWorldconsSearchRequest(
    new Request("https://provider.example/api/sources", {
      headers: { "x-request-id": "m9-contract" },
    }),
    providerEnv,
    { fetcher },
  );
  const app = createWorldconsSearchServiceApp({ provider: { fetcher } });
  const viaHono = await app.request(
    "https://service.internal/api/sources",
    { headers: { "x-request-id": "m9-contract" } },
    workerEnv,
  );

  assert.equal(viaHono.status, direct.status);
  assert.equal(
    viaHono.headers.get("x-provider-contract-version"),
    direct.headers.get("x-provider-contract-version"),
  );
  assert.equal(viaHono.headers.get("x-request-id"), "m9-contract");
  assert.deepEqual(await viaHono.json(), await direct.json());
});

test("M9 search service is internal-only and has a bounded health surface", async () => {
  const config = fs.readFileSync(
    path.join(process.cwd(), "workers/search-service/wrangler.jsonc"),
    "utf8",
  );
  assert.match(config, /"name": "worldcons-search"/u);
  assert.match(config, /"workers_dev": false/u);
  assert.doesNotMatch(config, /"routes"\s*:/u);

  const app = createWorldconsSearchServiceApp();
  const response = await app.request("https://service.internal/health", {}, workerEnv);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    schemaVersion: 1,
    service: "worldcons-search",
    status: "ready",
    transport: "cloudflare-service-binding",
  });
});

test("M9 internal upstream probe never exposes secrets and verifies REST plus RPC reachability", async () => {
  const seen: Array<{ url: string; authorization: string | null; apiKey: string | null }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    seen.push({
      url: request.url,
      authorization: request.headers.get("authorization"),
      apiKey: request.headers.get("apikey"),
    });
    return Response.json({ ok: true });
  };
  const app = createWorldconsSearchServiceApp({ provider: { fetcher } });
  const env = {
    ...workerEnv,
    GEMINI_API_KEY: "test-gemini-key",
  } satisfies WorldconsSearchWorkerEnv;
  const response = await app.request("https://service.internal/internal/upstream-probe", {}, env);
  assert.equal(response.status, 200);
  const payload = await response.json() as Record<string, unknown>;
  assert.equal(payload.status, "healthy");
  assert.equal(payload.supabaseHost, "project.supabase.co");
  assert.deepEqual(payload.configured, {
    supabaseUrl: true,
    serviceRoleKey: true,
    geminiApiKey: true,
  });
  assert.equal(JSON.stringify(payload).includes("test-service-role-key"), false);
  assert.equal(JSON.stringify(payload).includes("test-gemini-key"), false);
  assert.equal(seen.length, 2);
  assert.match(seen[0].url, /\/rest\/v1\/$/u);
  assert.match(seen[1].url, /\/rest\/v1\/rpc\/worldcons_provider_sources_v1$/u);
  for (const request of seen) {
    assert.equal(request.authorization, "Bearer test-service-role-key");
    assert.equal(request.apiKey, "test-service-role-key");
  }
});

test("M9 runtime Service Binding is default-off and fails closed when explicitly enabled without a binding", async () => {
  clearRuntimeSearchServiceBinding();
  const request = new Request("https://service.internal/api/sources");
  assert.equal(await forwardToRuntimeSearchService(request), null);

  setRuntimeSearchServiceBinding(undefined, true, true);
  await assert.rejects(
    () => forwardToRuntimeSearchService(request),
    /worldcons_search_service_binding_unavailable/u,
  );

  let seenPath = "";
  let boundResponse: Response | null = null;
  setRuntimeSearchServiceBinding({
    async fetch(boundRequest) {
      seenPath = new URL(boundRequest.url).pathname;
      boundResponse = Response.json({ ok: true }, {
        status: 201,
        headers: { "X-Bound-Response": "yes" },
      });
      return boundResponse;
    },
  }, true);
  const response = await forwardToRuntimeSearchService(request);
  assert.equal(response?.status, 201);
  assert.equal(seenPath, "/api/sources");
  assert.equal(response?.headers.get("x-bound-response"), "yes");
  assert.deepEqual(await response?.json(), { ok: true });
  assert.notEqual(response, boundResponse);
  clearRuntimeSearchServiceBinding();
});

test("M9 cclmetasearch data-plane extraction is default-off and uses a validated internal binding when enabled", async () => {
  clearRuntimeSearchServiceBinding();
  const input = { query: "헌법", limit: 10, offset: 0, sort: "relevance" as const };
  assert.equal(await searchCclMetasearchViaRuntimeService(input), null);

  let requestBody: unknown;
  setRuntimeSearchServiceBinding({
    async fetch(request) {
      assert.equal(new URL(request.url).pathname, "/internal/cclmetasearch/search");
      assert.equal(request.method, "POST");
      requestBody = await request.json();
      return Response.json({ items: [], total: 0 });
    },
  }, false, true);
  const page = await searchCclMetasearchViaRuntimeService(input);
  assert.deepEqual(requestBody, input);
  assert.deepEqual(page, { items: [], total: 0 });
  clearRuntimeSearchServiceBinding();
});

test("M9 Hono service executes validated cclmetasearch input without moving public auth or rate limiting", async () => {
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
      body: JSON.stringify({
        query: "표현의 자유",
        limit: 2,
        offset: 4,
        sort: "latest",
      }),
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

test("M9 public cclrag2 adapter keeps rate limiting before the optional Service Binding", () => {
  const route = fs.readFileSync(
    path.join(process.cwd(), "app/api/cclrag2/[...path]/route.ts"),
    "utf8",
  );
  const rateLimitIndex = route.indexOf('consumeRateLimit(request, "publicApi")');
  const bindingIndex = route.indexOf("forwardToRuntimeSearchService(providerRequest)");
  const fallbackIndex = route.indexOf("handleWorldconsSearchRequest(providerRequest, providerEnv())");
  assert.ok(rateLimitIndex >= 0);
  assert.ok(bindingIndex > rateLimitIndex);
  assert.ok(fallbackIndex > bindingIndex);
  assert.match(route, /providerServiceUnavailableResponse\(providerRequest\)/u);
});

test("M9 frontend binding is wired and M12 production cutover enables the proven path", () => {
  const config = fs.readFileSync(path.join(process.cwd(), "wrangler.jsonc"), "utf8");
  assert.match(config, /"WORLDCONS_SEARCH_SERVICE_ENABLED": "true"/u);
  assert.match(config, /"WORLDCONS_CCLMETASEARCH_SERVICE_ENABLED": "true"/u);
  assert.match(
    config,
    /"binding": "WORLDCONS_SEARCH_SERVICE"[\s\S]*"service": "worldcons-search"/u,
  );
});
