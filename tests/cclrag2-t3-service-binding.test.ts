import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  createWorldconsT3ProviderFetchRequest,
  dispatchWorldconsT3SearchV1,
  getWorldconsT3AdapterStatus,
  parseSearchV1Arg,
  searchV1,
  WORLDCONS_T3_ADAPTER_ID,
  WORLDCONS_T3_CONTRACT_VERSION,
  WORLDCONS_T3_INTERNAL_ORIGIN,
  WORLDCONS_T3_RPC_METHOD,
  WORLDCONS_T3_SCOPE,
  type WorldconsT3BindingEnv,
} from "../lib/integrations/cclrag2/t3-service-binding";
import type { ProviderDependencies } from "../lib/integrations/cclrag2/provider-handler";

const root = process.cwd();
const workerPath = path.join(root, "worker/index.ts");
const wranglerPath = path.join(root, "wrangler.jsonc");
const publicRoutePath = path.join(root, "app/api/cclrag2/[...path]/route.ts");
const capabilitiesRoutePath = path.join(root, "app/api/capabilities/route.ts");
const providerHandlerPath = path.join(root, "lib/integrations/cclrag2/provider-handler.ts");
const t3ModulePath = path.join(root, "lib/integrations/cclrag2/t3-service-binding.ts");

const unsignedEnv: WorldconsT3BindingEnv = {
  ENVIRONMENT: "test",
  PUBLIC_BASE_URL: "https://worldcons.cclib.workers.dev/api/cclrag2",
};

const signedEnabledEnv: WorldconsT3BindingEnv = {
  ...unsignedEnv,
  WORLDCONS_CCLRAG2_T3_BINDING_ENABLED: "true",
  WORLDCONS_CCLRAG2_T1_CONTRACT_STATUS: "signed",
  WORLDCONS_CCLRAG2_S2S_TOKEN: "t3-s2s-token-fixture",
  WORLDCONS_PORTAL_TOKEN: "worldlaw-portal-token-fixture",
};

const authorizedArg = {
  operation: "search" as const,
  scope: WORLDCONS_T3_SCOPE,
  query: "1 BvR 2656/18 climate",
  limit: 10,
  contractVersion: WORLDCONS_T3_CONTRACT_VERSION,
  authorization: "Bearer t3-s2s-token-fixture",
};

const forbiddenDependencies: ProviderDependencies = {
  fetcher: async () => { throw new Error("T3 must not perform caller-supplied network fetches"); },
  coreBinding: { prepare() { throw new Error("T3 capabilities must not query Core"); } },
  searchBinding: { prepare() { throw new Error("T3 capabilities must not query Search"); } },
  vectorBinding: { async query() { throw new Error("T3 capabilities must not query Vectorize"); } },
};

function errorPayload(response: Response) {
  return response.json() as Promise<{
    contractVersion: string;
    schemaVersion: number;
    service: string;
    error: { code: string; message: string; retryable: boolean };
  }>;
}

test("T3 adapter is disabled by default until T1 is signed and the S2S token exists", () => {
  const status = getWorldconsT3AdapterStatus(unsignedEnv);
  assert.equal(status.bindingEnabled, false);
  assert.equal(status.t1ContractSigned, false);
  assert.equal(status.s2sTokenConfigured, false);
  assert.equal(status.sameAccountBindingSufficient, false);
  assert.equal(status.anonymousRpcAllowed, false);
  assert.equal(status.arbitraryUrlsAllowed, false);
  assert.equal(status.rawD1R2Shared, false);
  assert.equal(status.catalogOnlyWorldlawPrimaryEvidence, false);
  assert.equal(status.liveCloudflareBindingProvisioned, false);
  assert.equal(status.publicHttpsAuthentication, "none");
  assert.equal(status.authentication, "bearer_s2s");
  assert.equal(status.rpcMethod, WORLDCONS_T3_RPC_METHOD);
});

test("same-account flags without a signed T1 contract keep RPC inert", async () => {
  const response = await searchV1(authorizedArg, {
    ...unsignedEnv,
    WORLDCONS_CCLRAG2_T3_BINDING_ENABLED: "true",
    WORLDCONS_CCLRAG2_S2S_TOKEN: "t3-s2s-token-fixture",
  });
  assert.equal(response.status, 503);
  const payload = await errorPayload(response);
  assert.equal(payload.contractVersion, "2.0");
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.service, "worldcons");
  assert.equal(payload.error.code, "BINDING_DISABLED");
  assert.equal(payload.error.retryable, false);
  assert.equal(response.headers.get("x-provider-contract-version"), "2.0");
});

test("signed T1 without a verified bearer does not escalate through RPC", async () => {
  const missing = await searchV1({
    operation: "search",
    scope: WORLDCONS_T3_SCOPE,
    query: "climate",
    limit: 5,
    contractVersion: "2.0",
  }, signedEnabledEnv);
  assert.equal(missing.status, 401);
  assert.equal((await errorPayload(missing)).error.code, "AUTH_REQUIRED");

  const wrong = await searchV1({ ...authorizedArg, authorization: "Bearer other-token" }, signedEnabledEnv);
  assert.equal(wrong.status, 403);
  assert.equal((await errorPayload(wrong)).error.code, "FORBIDDEN");

  const portal = await searchV1({
    ...authorizedArg,
    authorization: "Bearer worldlaw-portal-token-fixture",
  }, signedEnabledEnv);
  assert.equal(portal.status, 403);
  assert.match((await errorPayload(portal)).error.message, /catalog portal token/u);
});

test("enabled searchV1 capabilities stay metadata-only and do not touch D1/R2/network", async () => {
  const response = await dispatchWorldconsT3SearchV1({
    arg: {
      operation: "capabilities",
      scope: WORLDCONS_T3_SCOPE,
      query: "",
      limit: 1,
      contractVersion: "2.0",
      authorization: "Bearer t3-s2s-token-fixture",
    },
    env: signedEnabledEnv,
    dependencies: forbiddenDependencies,
  });
  assert.equal(response.status, 200);
  const payload = await response.json() as {
    contractVersion: string;
    providerId: string;
    authentication: string;
    requestId: string;
    t3: {
      authentication: string;
      defaultBindingEnabled: boolean;
      rpcMethod: string;
      evidence: { catalogOnlyWorldlawPrimaryEvidence: boolean };
    };
  };
  assert.equal(payload.contractVersion, "2.0");
  assert.equal(payload.providerId, "worldcons");
  assert.equal(payload.authentication, "none");
  assert.equal(payload.t3.authentication, "bearer_s2s");
  assert.equal(payload.t3.defaultBindingEnabled, false);
  assert.equal(payload.t3.evidence.catalogOnlyWorldlawPrimaryEvidence, false);
  assert.equal(payload.t3.rpcMethod, "searchV1");
  assert.ok(payload.requestId);
  assert.doesNotMatch(JSON.stringify(payload), /WORLDCONS_CORE|WORLDCONS_RAW|t3-s2s-token-fixture|worldlaw-portal-token/u);
});

test("enabled searchV1 search uses the existing handler contract and bounded page size", async () => {
  const response = await searchV1(authorizedArg, signedEnabledEnv, {
    fetcher: async () => { throw new Error("T3 search must not fetch arbitrary URLs"); },
  });
  assert.equal(response.status, 503);
  const payload = await errorPayload(response);
  assert.equal(payload.contractVersion, "2.0");
  assert.equal(payload.error.code, "SERVICE_UNAVAILABLE");
  assert.equal(payload.error.retryable, true);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
});

test("searchV1 rejects worldlaw/catalog scopes, extra fields, oversized limits, and URLs", () => {
  assert.throws(() => parseSearchV1Arg({ ...authorizedArg, scope: "worldlaw" }), /published_foreign_constitutional/u);
  assert.throws(() => parseSearchV1Arg({ ...authorizedArg, scope: "catalog" }), /worldlaw/u);
  assert.throws(() => parseSearchV1Arg({ ...authorizedArg, operation: "d1" }), /operation/u);
  assert.throws(() => parseSearchV1Arg({ ...authorizedArg, url: "https://evil.example" }), /additional fields/u);
  assert.throws(() => parseSearchV1Arg({ ...authorizedArg, limit: 21 }), /between 1 and 20/u);
  assert.throws(() => parseSearchV1Arg({ ...authorizedArg, query: "https://evil.example/search" }), /Arbitrary URLs/u);
  assert.throws(() => parseSearchV1Arg({ ...authorizedArg, authorization: "https://evil.example" }), /Arbitrary URLs/u);
  assert.throws(() => parseSearchV1Arg({ ...authorizedArg, query: "x".repeat(201) }), /200 characters/u);
});

test("T3 fetch adapter only mints the fixed internal search path", () => {
  const request = createWorldconsT3ProviderFetchRequest({
    operation: "search",
    scope: WORLDCONS_T3_SCOPE,
    query: "1 BvR 2656/18 climate",
    limit: 10,
    contractVersion: "2.0",
  }, "t3-fetch");
  const url = new URL(request.url);
  assert.equal(url.origin, WORLDCONS_T3_INTERNAL_ORIGIN);
  assert.equal(url.pathname, "/api/search");
  assert.equal(url.searchParams.get("q"), "1 BvR 2656/18 climate");
  assert.equal(url.searchParams.get("pageSize"), "10");
  assert.equal(url.searchParams.get("mode"), "hybrid");
  assert.equal(request.method, "GET");
  assert.equal(request.headers.get("x-request-id"), "t3-fetch");
});

test("cancelled T3 calls return the existing retryable error envelope", async () => {
  const signal = AbortSignal.abort();
  const response = await searchV1(authorizedArg, signedEnabledEnv, undefined, { signal });
  assert.equal(response.status, 503);
  const payload = await errorPayload(response);
  assert.equal(payload.error.code, "SERVICE_UNAVAILABLE");
  assert.equal(payload.error.retryable, true);
});

test("public HTTPS routes and wrangler stay unchanged for unverified binding claims", () => {
  const publicRoute = fs.readFileSync(publicRoutePath, "utf8");
  const capabilitiesRoute = fs.readFileSync(capabilitiesRoutePath, "utf8");
  const wrangler = fs.readFileSync(wranglerPath, "utf8");
  const worker = fs.readFileSync(workerPath, "utf8");
  const handler = fs.readFileSync(providerHandlerPath, "utf8");
  const t3 = fs.readFileSync(t3ModulePath, "utf8");

  assert.match(publicRoute, /consumeRateLimit\(request, "publicApi"\)/u);
  assert.match(publicRoute, /handleWorldconsSearchRequest/u);
  assert.doesNotMatch(publicRoute, /searchV1|WORLDCONS_CCLRAG2_S2S_TOKEN|t3-service-binding/u);
  assert.match(capabilitiesRoute, /handleWorldconsSearchRequest/u);
  assert.doesNotMatch(capabilitiesRoute, /searchV1/u);

  assert.doesNotMatch(wrangler, /WORLDCONS_CCLRAG2_T3_BINDING_ENABLED/u);
  assert.doesNotMatch(wrangler, /WORLDCONS_CCLRAG2_T1_CONTRACT_STATUS/u);
  assert.doesNotMatch(wrangler, /WORLDCONS_CCLRAG2_S2S_TOKEN/u);
  assert.doesNotMatch(wrangler, /"services"\s*:/u);
  assert.doesNotMatch(wrangler, /cclrag2-t3|WORLDCONS_SEARCH_SERVICE/u);

  assert.match(handler, /export async function handleWorldconsSearchRequest/u);
  assert.match(t3, /liveCloudflareBindingProvisioned: false/u);
  assert.match(t3, /sameAccountBindingSufficient: false/u);
  assert.match(worker, /export class WorldconsSearchService extends WorkerEntrypoint/u);
  assert.match(worker, /async searchV1\(/u);
  assert.match(worker, /dispatchWorldconsT3SearchV1/u);
  assert.doesNotMatch(worker.slice(worker.indexOf("export default {"), worker.indexOf("const searchServiceApp")), /searchV1/u);
  assert.equal(WORLDCONS_T3_ADAPTER_ID, "worldcons-t3-search-v1");
});
