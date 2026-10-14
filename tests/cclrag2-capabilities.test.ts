import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { z } from "zod";
import {
  getWorldconsProviderCapabilities,
  type WorldconsProviderCapabilities,
} from "../lib/integrations/cclrag2/capabilities";
import {
  handleWorldconsSearchRequest,
  type Cclrag2ProviderEnv,
  type ProviderDependencies,
} from "../lib/integrations/cclrag2/provider-handler";
import { createWorldconsSearchServiceApp } from "../lib/cloudflare/services/worldcons-search-service";

const env = { ENVIRONMENT: "test", PUBLIC_BASE_URL: "https://fixture.example/api/cclrag2" } satisfies Cclrag2ProviderEnv;
const forbiddenDependencies: ProviderDependencies = {
  fetcher: async () => { throw new Error("Capabilities must not make network requests"); },
  coreBinding: { prepare() { throw new Error("Capabilities must not query Core"); } },
  searchBinding: { prepare() { throw new Error("Capabilities must not query Search"); } },
  vectorBinding: { async query() { throw new Error("Capabilities must not query Vectorize"); } },
};

// Consumer-level shape assertions catch missing discovery metadata independently of the factory.
const endpointSchema = z.object({ method: z.literal("GET"), path: z.string().startsWith("/"), maxResponseBytes: z.number().int().positive() }).strict();
const manifestSchema = z.object({
  schemaVersion: z.literal(1), contractVersion: z.literal("2.0"),
  providerId: z.literal("worldcons"), service: z.literal("worldcons"),
  sourceType: z.literal("foreign_constitutional"), authorityLevel: z.literal("persuasive"),
  discoveryKind: z.literal("contract"), authentication: z.literal("none"), publicationScope: z.literal("published_only"),
  apiBasePath: z.literal("/api/cclrag2"),
  endpoints: z.object({ capabilities: endpointSchema, search: endpointSchema, sources: endpointSchema, detail: endpointSchema, sourceText: endpointSchema }).strict(),
  search: z.object({
    parameters: z.array(z.string()), modes: z.array(z.enum(["fulltext", "semantic", "hybrid"])),
    defaultMode: z.literal("hybrid"), countModes: z.array(z.enum(["exact", "planned", "estimated", "none"])),
    defaultCount: z.literal("none"), ranges: z.array(z.enum(["latest", "today", "week", "month"])), defaultRange: z.literal("latest"),
    pagination: z.literal("page"), limits: z.record(z.number().int().nonnegative()),
    exactCaseReference: z.literal(true), semanticRequiresConfiguration: z.literal(true), fallbackMode: z.literal("fulltext"),
    degradationReasons: z.array(z.string()), modeEvidence: z.array(z.string()), totalIsExactField: z.literal("totalIsExact"),
  }).strict(),
  detail: z.object({ parameters: z.array(z.string()), defaultTextLimit: z.number().int().positive(), maxTextLimit: z.number().int().positive() }).strict(),
  sourceText: z.object({
    parameters: z.array(z.string()), pagination: z.literal("offset"), offsetUnit: z.literal("unicode_code_point"),
    minOffset: z.literal(0), maxOffset: z.number().int().positive(), defaultOffset: z.literal(0),
    minLimit: z.literal(1), maxLimit: z.number().int().positive(), defaultLimit: z.number().int().positive(),
    maxTextBytes: z.number().int().positive(), continuationField: z.literal("textPage.nextOffset"),
    checksumAlgorithm: z.literal("sha256"), checksumScope: z.literal("complete_source_snapshot"),
  }).strict(),
  evidence: z.object({ fields: z.array(z.string()), optionalFields: z.array(z.string()), maxSearchExcerptChars: z.number().int().positive(), maxDetailExcerptChars: z.number().int().positive() }).strict(),
  sources: z.array(z.object({ sourceKey: z.string(), jurisdictionCode: z.enum(["DE", "ES", "FR", "US"]), jurisdictionName: z.string(), originalLanguage: z.enum(["de", "es", "fr", "en"]), officialHostSuffixes: z.array(z.string()) }).strict()).length(4),
}).strict();

test("provider-owned discovery is a versioned JSON-safe contract without health claims", () => {
  const manifest: WorldconsProviderCapabilities = getWorldconsProviderCapabilities();
  const serialized = JSON.stringify(manifest);
  manifestSchema.parse(JSON.parse(serialized));
  assert.deepEqual(manifest.search.modes, ["fulltext", "semantic", "hybrid"]);
  assert.deepEqual(manifest.sources.map(source => source.jurisdictionCode), ["DE", "ES", "FR", "US"]);
  assert.doesNotMatch(serialized, /GEMINI_API_KEY|SUPABASE|database_id|healthy|ready|latency|cost|production/iu);
  assert.ok(Buffer.byteLength(serialized) < manifest.endpoints.capabilities.maxResponseBytes);
  assert.equal(manifest.search.limits.maxPageSize, 20);
  assert.equal(manifest.search.limits.maxQueryChars, 200);
  assert.equal(manifest.sourceText.maxLimit, 350_000);
});

test("callers cannot alter subsequent provider capabilities", () => {
  const original = getWorldconsProviderCapabilities();
  const changed = getWorldconsProviderCapabilities();
  changed.search.modes.pop();
  changed.endpoints.search.path = "/changed";
  changed.sources[0].officialHostSuffixes.push("attacker.example");
  Reflect.set(changed.search.limits, "maxPageSize", 100);
  assert.deepEqual(getWorldconsProviderCapabilities(), original);
});

test("capabilities returns correlated bounded JSON without touching any dependency", async () => {
  for (const path of ["/api/capabilities", "/api/capabilities/"]) {
    const response = await handleWorldconsSearchRequest(new Request(`https://fixture.example${path}`, {
      headers: { "X-Request-Id": "t1-contract" },
    }), { ...env, GEMINI_API_KEY: "never-expose-this-secret", SEMANTIC_SEARCH_ENABLED: "true" }, forbiddenDependencies);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("x-provider-contract-version"), "2.0");
    assert.equal(response.headers.get("x-request-id"), "t1-contract");
    assert.match(response.headers.get("content-type") ?? "", /application\/json/u);
    const text = await response.text();
    assert.equal(Number(response.headers.get("content-length")), Buffer.byteLength(text));
    assert.doesNotMatch(text, /never-expose-this-secret/u);
    assert.deepEqual(JSON.parse(text), { ...getWorldconsProviderCapabilities(), requestId: "t1-contract" });
  }
});

test("discovery validates parameters and methods with the existing error envelope", async () => {
  for (const query of ["?q=test", "?refresh=true", "?q=a&q=b"]) {
    const response = await handleWorldconsSearchRequest(new Request(`https://fixture.example/api/capabilities${query}`), env, forbiddenDependencies);
    assert.equal(response.status, 400);
    const payload = await response.json();
    assert.equal(payload.contractVersion, "2.0");
    assert.equal(payload.error.code, "INVALID_REQUEST");
    assert.equal(payload.error.retryable, false);
  }
  const response = await handleWorldconsSearchRequest(new Request("https://fixture.example/api/capabilities", { method: "POST" }), env, forbiddenDependencies);
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET");
  assert.equal((await response.json()).error.code, "METHOD_NOT_ALLOWED");
  const unknown = await handleWorldconsSearchRequest(new Request("https://fixture.example/api/capabilities/unknown"), env, forbiddenDependencies);
  assert.equal(unknown.status, 404);
});

test("advertised search boundaries and enums agree with provider validation", async () => {
  const { search, sourceText, detail } = getWorldconsProviderCapabilities();
  const invalidQueries = [
    `q=${"x".repeat(search.limits.maxQueryChars + 1)}`,
    `page=${search.limits.maxPage + 1}`, `pageSize=${search.limits.maxPageSize + 1}`,
    `source=${"x".repeat(search.limits.maxFilterChars + 1)}`, "mode=unsupported", "count=unsupported", "range=unsupported",
  ];
  for (const query of invalidQueries) {
    const response = await handleWorldconsSearchRequest(new Request(`https://fixture.example/api/search?${query}`), env);
    assert.equal(response.status, 400, query);
  }
  for (const [parameter, values] of [["mode", search.modes], ["count", search.countModes], ["range", search.ranges]] as const) {
    for (const value of values) {
      const response = await handleWorldconsSearchRequest(new Request(`https://fixture.example/api/search?${parameter}=${value}`), env);
      assert.equal(response.status, 503, "valid contract values reach the unconfigured data boundary");
    }
  }
  // Malformed paging is rejected before a supplied binding can execute a read.
  for (const path of [
    `/api/articles/fixture?textLimit=${detail.maxTextLimit + 1}`,
    `/api/articles/fixture/source-text?offset=${sourceText.maxOffset + 1}`,
    `/api/articles/fixture/source-text?limit=${sourceText.maxLimit + 1}`,
  ]) {
    const response = await handleWorldconsSearchRequest(new Request(`https://fixture.example${path}`), env, forbiddenDependencies);
    assert.equal(response.status, 400, path);
  }
});

test("local service discovery and public route aliases use the same provider source", async () => {
  const app = createWorldconsSearchServiceApp({ provider: forbiddenDependencies });
  const response = await app.fetch(new Request("https://fixture.example/api/capabilities", { headers: { "X-Request-Id": "t1-service" } }), {});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ...getWorldconsProviderCapabilities(), requestId: "t1-service" });
  for (const routePath of ["app/api/capabilities/route.ts", "app/api/cclrag2/[...path]/route.ts"]) {
    const route = fs.readFileSync(routePath, "utf8");
    const rateLimitIndex = route.indexOf("consumeRateLimit(request");
    assert.ok(rateLimitIndex >= 0);
    assert.ok(rateLimitIndex < route.indexOf("return handleWorldconsSearchRequest("));
    assert.match(route, /handleWorldconsSearchRequest/u);
  }
});
