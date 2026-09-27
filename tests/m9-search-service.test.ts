import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  clearRuntimeSearchServiceBinding,
  forwardToRuntimeSearchService,
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
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
} satisfies Cclrag2ProviderEnv;

const workerEnv = providerEnv satisfies WorldconsSearchWorkerEnv;

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
  const app = createWorldconsSearchServiceApp({ fetcher });
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

test("M9 runtime Service Binding is default-off and fails closed when explicitly enabled without a binding", async () => {
  clearRuntimeSearchServiceBinding();
  const request = new Request("https://service.internal/api/sources");
  assert.equal(await forwardToRuntimeSearchService(request), null);

  setRuntimeSearchServiceBinding(undefined, true);
  await assert.rejects(
    () => forwardToRuntimeSearchService(request),
    /worldcons_search_service_binding_unavailable/u,
  );

  let seenPath = "";
  setRuntimeSearchServiceBinding({
    async fetch(boundRequest) {
      seenPath = new URL(boundRequest.url).pathname;
      return Response.json({ ok: true });
    },
  }, true);
  const response = await forwardToRuntimeSearchService(request);
  assert.equal(response?.status, 200);
  assert.equal(seenPath, "/api/sources");
  clearRuntimeSearchServiceBinding();
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

test("M9 frontend binding is wired but remains disabled by default", () => {
  const config = fs.readFileSync(path.join(process.cwd(), "wrangler.jsonc"), "utf8");
  assert.match(config, /"WORLDCONS_SEARCH_SERVICE_ENABLED": "false"/u);
  assert.match(
    config,
    /"binding": "WORLDCONS_SEARCH_SERVICE"[\s\S]*"service": "worldcons-search"/u,
  );
});
