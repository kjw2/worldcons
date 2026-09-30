import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  handleWorldconsSearchRequest,
  type Cclrag2ProviderEnv,
  type ProviderDependencies,
} from "../lib/integrations/cclrag2/provider-handler";
import type { D1RuntimeDatabase, D1RuntimePreparedStatement } from "../lib/cloudflare/d1/runtime-binding";
import type { VectorizeIndexBinding, VectorizeQueryOptions, VectorizeQueryResult } from "../lib/cloudflare/search-vector/types";

const migrationPath = path.join(
  process.cwd(),
  "supabase/migrations/20260727120000_worldcons_provider_search_v1.sql",
);
const v2MigrationPath = path.join(
  process.cwd(),
  "supabase/migrations/20260728100000_worldcons_provider_contract_v2.sql",
);
const v3SearchMigrationPath = path.join(
  process.cwd(),
  "supabase/migrations/20260826300000_worldcons_provider_search_v3.sql",
);
const v4SearchMigrationPath = path.join(
  process.cwd(),
  "supabase/migrations/20260826400000_case_keys_and_ranked_pagination.sql",
);
const providerResilienceMigrationPath = path.join(
  process.cwd(),
  "supabase/migrations/20260904100000_cclrag2_provider_search_resilience.sql",
);
const providerRoutePath = path.join(
  process.cwd(),
  "app/api/cclrag2/[...path]/route.ts",
);
const NEUBAUER_CHECKSUM = "527b41e3310651a4ba4d1a9a0c1e358e0cf6c292241fe019a8c71f1fc18058ba";
const NEUBAUER_EXCERPT =
  "공식 독일 연방헌법재판소 결정문 발췌로서 기후보호법의 감축부담이 미래세대의 자유행사에 미치는 영향과 국가의 헌법상 보호의무를 설명한다. 재판소는 세대 간 자유 보장의 균형을 중심으로 심사하였다.";

const env = {
  ENVIRONMENT: "test",
  PUBLIC_BASE_URL: "https://worldcons.vercel.app/api/cclrag2",
} satisfies Cclrag2ProviderEnv;

const embeddingEnv = {
  ...env,
  EMBEDDING_PROVIDER: "gemini",
  SEMANTIC_SEARCH_ENABLED: "true",
  GEMINI_API_KEY: "test-gemini-key",
  GEMINI_EMBEDDING_MODEL: "gemini-embedding-001",
} satisfies Cclrag2ProviderEnv;

test("Cloudflare provider route preserves the provider contract and applies public rate limiting", () => {
  const route = fs.readFileSync(providerRoutePath, "utf8");

  assert.match(route, /https:\/\/worldcons\.cclib\.workers\.dev\/api\/cclrag2/u);
  assert.match(route, /consumeRateLimit\(request, "publicApi"\)/u);
  assert.match(route, /providerRateLimitExceededResponse/u);
  assert.match(route, /replace\(\/\^\\\/api\\\/cclrag2/u);
  assert.match(route, /handleWorldconsSearchRequest/u);
  assert.doesNotMatch(route, /VERCEL_|vercel\.app/iu);
});

test("Cloudflare provider accepts the cclrag2 contract and returns the Neubauer case first", async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const response = await handleWorldconsSearchRequest(
    new Request("https://provider.example/api/search?q=1%20BvR%202656%2F18%20climate&mode=hybrid&pageSize=10&count=none&jurisdiction=Germany&source=de-bverfg", {
      headers: { "x-request-id": "cclrag2-neubauer-test" },
    }),
    env,
    searchDependencies(calls),
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-provider-contract-version"), "2.0");
  assert.equal(response.headers.get("x-request-id"), "cclrag2-neubauer-test");
  assert.equal(payload.contractVersion, "2.0");
  assert.equal(payload.requestId, "cclrag2-neubauer-test");
  assert.equal(payload.transport, "cloudflare-worker");
  assert.equal(payload.requestedMode, "hybrid");
  assert.equal(payload.effectiveMode, "hybrid", "the requested retrieval mode is retained for exact-case orchestration");
  assert.equal(payload.mode, "hybrid");
  assert.equal(payload.databaseRetrievalMode, "exact-case");
  assert.equal(payload.degraded, false);
  assert.equal(payload.items[0].caseNumber, "1 BvR 2656/18");
  assert.equal(payload.items[0].sourceType, "foreign_constitutional");
  assert.equal(payload.items[0].authorityLevel, "persuasive");
  assert.equal(payload.items[0].jurisdictionCode, "DE");
  assert.equal(payload.items[0].countryName, "독일");
  assert.equal(payload.items[0].courtName, "Bundesverfassungsgericht");
  assert.equal(payload.items[0].decisionDate, "2021-03-24");
  assert.equal(payload.items[0].bodyExcerpt, NEUBAUER_EXCERPT);
  assert.equal(payload.items[0].excerptKind, "passage");
  assert.ok(payload.items[0].snippet.length >= 80);
  assert.equal(payload.items[0].bodyChecksum, NEUBAUER_CHECKSUM);
  assert.deepEqual(payload.items[0].legalIdentity, {
    documentId: "552950ac-de82-41f5-ae88-411efc5ae9b2",
    caseNumber: "1 BvR 2656/18",
    court: "Bundesverfassungsgericht",
    jurisdiction: "DE",
  });
  assert.deepEqual(payload.items[0].temporalValidity, {
    decisionDate: "2021-03-24",
    publishedAt: "2021-03-24",
  });
  assert.match(payload.items[0].officialUri, /^https:\/\/www\.bundesverfassungsgericht\.de\//u);
  assert.equal(payload.items[0].detailApiUrl, "https://worldcons.vercel.app/api/cclrag2/articles/germany-neubauer");
  assert.equal(payload.items[0].summaryJson.summary.background, "기후위기와 미래세대의 자유가 문제 되었다.");
  assert.deepEqual(payload.meta, { limit: 10, offset: 0, total: 1, hasMore: false, totalIsExact: false });
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /search_documents/u);
  assert.deepEqual(calls[0].params.slice(0, 2), ["de-bverfg", "1bvr265618"]);
  assert.ok(Number(response.headers.get("content-length")) < 1_500_000);
  assert.doesNotMatch(JSON.stringify(payload), /workers\.dev/iu);
});

test("Vercel provider preserves the Korean comparison query and source inference", async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const query = "한국 헌재 기후결정과 독일 연방헌법재판소 Neubauer 기후결정을 비교";
  const url = new URL("https://provider.example/api/search");
  url.searchParams.set("q", query);
  url.searchParams.set("mode", "fulltext");
  const response = await handleWorldconsSearchRequest(new Request(url), env, searchDependencies(calls));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.query, query);
  assert.equal(payload.items[0].caseNumber, "1 BvR 2656/18");
  assert.ok(calls[0].params.includes("de-bverfg"));
});

test("Vercel provider fulltext mode bypasses embeddings and uses D1 lexical retrieval", async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const dependencies = searchDependencies(calls);
  dependencies.vectorBinding = null;
  const response = await handleWorldconsSearchRequest(
    new Request("https://provider.example/api/search?q=freedom&mode=fulltext&pageSize=5"),
    embeddingEnv,
    dependencies,
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /search_fts match \?/u);
  assert.equal(payload.requestedMode, "fulltext");
  assert.equal(payload.effectiveMode, "fulltext");
  assert.equal(payload.degraded, false);
  assert.equal(payload.databaseRetrievalMode, "fulltext");
});

test("Vercel provider reports an explicit fulltext fallback when semantic capability is not configured", async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const response = await handleWorldconsSearchRequest(
    new Request("https://provider.example/api/search?q=climate%20freedom&mode=hybrid&pageSize=5"),
    env,
    searchDependencies(calls),
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /search_fts match \?/u);
  assert.equal(payload.requestedMode, "hybrid");
  assert.equal(payload.effectiveMode, "fulltext");
  assert.equal(payload.degraded, true);
  assert.equal(payload.degradationReason, "embedding_not_configured");
});

test("Vercel provider narrows a generic comparison to German constitutional authority", async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const query = "미국 판례와 독일 헌법재판 결정을 비교해 주세요. 각각의 판례 근거를 구분해서 제시해 주세요.";
  const url = new URL("https://provider.example/api/search");
  url.searchParams.set("q", query);
  url.searchParams.set("mode", "fulltext");
  const response = await handleWorldconsSearchRequest(new Request(url), env, searchDependencies(calls));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.query, query);
  assert.equal(payload.effectiveMode, "fulltext");
  assert.ok(calls[0].params.includes("de-bverfg"));
  assert.ok(!calls[0].params.some((value) => typeof value === "string" && value.includes("미국")));
});

test("Vercel provider translates a jurisdiction code into the source-owned search boundary", async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  await handleWorldconsSearchRequest(
    new Request("https://provider.example/api/search?q=독일&mode=fulltext&jurisdiction=DE"),
    env,
    searchDependencies(calls),
  );
  assert.ok(calls[0].params.includes("de-bverfg"));
});

test("Vercel provider infers a source boundary from a short Korean jurisdiction name", async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  await handleWorldconsSearchRequest(
    new Request("https://provider.example/api/search?q=독일&mode=fulltext"),
    env,
    searchDependencies(calls),
  );
  assert.ok(calls[0].params.includes("de-bverfg"));
});

test("Vercel provider semantic mode creates an embedding and queries Vectorize", async () => {
  const vectorCalls: Array<{ vector: readonly number[]; options: { topK: number } }> = [];
  let embeddingCalls = 0;
  const response = await handleWorldconsSearchRequest(
    new Request("https://provider.example/api/search?q=intergenerational%20climate%20freedom&mode=semantic&pageSize=5"),
    embeddingEnv,
    searchDependencies([], vectorCalls, async (input) => {
      if (String(input) !== "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent") return new Response(null, { status: 500 });
      embeddingCalls += 1;
      return embeddingResponse();
    }),
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(embeddingCalls, 1);
  assert.equal(vectorCalls.length, 1);
  assert.equal(vectorCalls[0].vector.length, 1536);
  assert.equal(vectorCalls[0].options.topK, 6);
  assert.equal(payload.requestedMode, "semantic");
  assert.equal(payload.effectiveMode, "semantic");
  assert.equal(payload.mode, "semantic");
  assert.equal(payload.degraded, false);
  assert.equal(payload.databaseRetrievalMode, "semantic");
});

test("Vercel provider hybrid mode uses embeddings and explicitly degrades when embedding fails", async () => {
  const vectorCalls: Array<{ vector: readonly number[]; options: { topK: number } }> = [];
  const hybrid = await handleWorldconsSearchRequest(
    new Request("https://provider.example/api/search?q=climate%20freedom&mode=hybrid&pageSize=5"),
    embeddingEnv,
    searchDependencies([], vectorCalls, async (input) => String(input).includes("generativelanguage.googleapis.com") ? embeddingResponse() : new Response(null, { status: 500 })),
  );
  const hybridPayload = await hybrid.json();
  assert.equal(hybrid.status, 200);
  assert.equal(vectorCalls.length, 1);
  assert.equal(vectorCalls[0].options.topK, 100);
  assert.equal(hybridPayload.requestedMode, "hybrid");
  assert.equal(hybridPayload.effectiveMode, "hybrid");
  assert.equal(hybridPayload.degraded, false);

  const degraded = await handleWorldconsSearchRequest(
    new Request("https://provider.example/api/search?q=climate%20freedom&mode=hybrid&pageSize=5"),
    embeddingEnv,
    searchDependencies([], [], async (input) => String(input).includes("generativelanguage.googleapis.com")
      ? Response.json({ error: "embedding unavailable" }, { status: 503 })
      : new Response(null, { status: 500 })),
  );
  const degradedPayload = await degraded.json();
  assert.equal(degraded.status, 200);
  assert.equal(degradedPayload.requestedMode, "hybrid");
  assert.equal(degradedPayload.effectiveMode, "fulltext");
  assert.equal(degradedPayload.mode, "fulltext");
  assert.equal(degradedPayload.degraded, true);
  assert.equal(degradedPayload.degradationReason, "embedding_unavailable");
});

test("Vercel provider exact-case preflight supports France, Spain, and the US without embeddings", async () => {
  const cases = [
    ["2026-912 QPC", "fr-conseil-constitutionnel"],
    ["53/2025", "es-tribunal-constitucional"],
    ["No. 24-109", "us-scotus"],
  ] as const;
  for (const [query, sourceKey] of cases) {
    const vectorCalls: Array<{ vector: readonly number[]; options: VectorizeQueryOptions }> = [];
    const url = new URL("https://provider.example/api/search");
    url.searchParams.set("q", query);
    url.searchParams.set("mode", "hybrid");
    url.searchParams.set("source", sourceKey);
    const dependencies = searchDependencies([], vectorCalls);
    dependencies.vectorBinding = null;
    const response = await handleWorldconsSearchRequest(new Request(url), embeddingEnv, dependencies);
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(vectorCalls.length, 0);
    assert.equal(payload.degraded, false);
    assert.equal(payload.databaseRetrievalMode, "exact-case");
  }
});

test("Vercel provider preserves exact total semantics from ranked D1 pages", async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const response = await handleWorldconsSearchRequest(
    new Request("https://provider.example/api/search?q=freedom&mode=fulltext&page=2&pageSize=1&count=exact"),
    env,
    searchDependencies(calls, [], undefined, { total: 37, hasMore: true }),
  );
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(payload.meta, { limit: 1, offset: 1, total: 37, hasMore: true, totalIsExact: true });
  assert.deepEqual(payload.pageInfo, { page: 2, pageSize: 1, total: 37, hasMore: true, totalIsExact: true });
});

test("Vercel provider source and article endpoints read bounded Contract V2 evidence from D1", async () => {
  const calls: string[] = [];
  const d1 = createProviderFakeD1(calls);
  const dependencies = { coreBinding: d1 };
  const sources = await handleWorldconsSearchRequest(
    new Request("https://provider.example/api/sources"),
    env,
    dependencies,
  );
  const detail = await handleWorldconsSearchRequest(
    new Request("https://provider.example/api/articles/germany-neubauer?textLimit=16000"),
    env,
    dependencies,
  );
  const sourceText = await handleWorldconsSearchRequest(
    new Request("https://provider.example/api/articles/germany-neubauer/source-text?offset=0&limit=5"),
    env,
    dependencies,
  );

  assert.equal(sources.status, 200);
  assert.equal(sources.headers.get("cache-control"), "public, s-maxage=300, stale-while-revalidate=900");
  const sourcesPayload = await sources.json();
  assert.equal(sourcesPayload.contractVersion, "2.0");
  assert.equal(sourcesPayload.items[0].sourceType, "foreign_constitutional");
  assert.equal(sourcesPayload.items[0].countryCode, "DE");
  assert.equal(sourcesPayload.items[0].officialUri, "https://www.bundesverfassungsgericht.de/");
  assert.equal(sourcesPayload.items.length, 1, "inactive sources are excluded");
  assert.equal(detail.status, 200);
  assert.equal(detail.headers.get("cache-control"), "public, s-maxage=300, stale-while-revalidate=900");
  const detailPayload = await detail.json();
  assert.equal(detailPayload.contractVersion, "2.0");
  assert.equal(detailPayload.cleanedText, "공식 원문 스냅샷");
  assert.equal(detailPayload.excerptKind, "document_section");
  assert.equal(detailPayload.bodyChecksum, NEUBAUER_CHECKSUM);
  assert.deepEqual(detailPayload.textPage, {
    offset: 0,
    limit: 16000,
    returnedChars: 9,
    totalChars: 9,
    hasMore: false,
    nextOffset: null,
  });
  assert.ok(Number(detail.headers.get("content-length")) < 1_900_000);
  assert.equal(sourceText.status, 200);
  assert.equal(sourceText.headers.get("cache-control"), "public, s-maxage=300, stale-while-revalidate=900");
  const sourceTextPayload = await sourceText.json();
  assert.equal(sourceTextPayload.cleanedText, "공식 원문");
  assert.equal(sourceTextPayload.bodyChecksum, NEUBAUER_CHECKSUM);
  assert.deepEqual(sourceTextPayload.textPage, {
    offset: 0,
    limit: 5,
    returnedChars: 5,
    totalChars: 9,
    hasMore: true,
    nextOffset: 5,
  });
  assert.ok(calls.some((sql) => /from sources/u.test(sql)));
  assert.ok(calls.some((sql) => /from articles where slug = \? and status = \? and catalog_ai_stale_v4 = \?/u.test(sql)));
  assert.equal(calls.length, 5, "one sources read plus detail and source-text article/tag reads");

  const missing = await handleWorldconsSearchRequest(
    new Request("https://provider.example/api/articles/not-found"),
    env,
    { coreBinding: createProviderFakeD1([], { includeArticle: false }) },
  );
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, "NOT_FOUND");

  const noSnapshot = await handleWorldconsSearchRequest(
    new Request("https://provider.example/api/articles/germany-neubauer/source-text"),
    env,
    { coreBinding: createProviderFakeD1([], { cleanedText: null }) },
  );
  assert.equal(noSnapshot.status, 404);
  assert.equal((await noSnapshot.json()).error.message, "Source snapshot not found.");
});

test("Vercel provider rejects invalid input and normalizes dependency failures", async () => {
  const invalid = await handleWorldconsSearchRequest(
    new Request("https://provider.example/api/search?q=test&pageSize=21"),
    env,
  );
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, "INVALID_REQUEST");

  const unavailable = await handleWorldconsSearchRequest(
    new Request("https://provider.example/api/search?q=test"),
    env,
  );
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).error.code, "SERVICE_UNAVAILABLE");

  const searchUnavailable = await handleWorldconsSearchRequest(
    new Request("https://provider.example/api/search?q=test&mode=fulltext"),
    env,
    { coreBinding: createProviderFakeD1() },
  );
  assert.equal(searchUnavailable.status, 503);
  assert.equal((await searchUnavailable.json()).error.code, "SERVICE_UNAVAILABLE");

  const invalidTextPage = await handleWorldconsSearchRequest(
    new Request(
      "https://provider.example/api/articles/germany-neubauer/source-text?limit=350001",
    ),
    env,
  );
  assert.equal(invalidTextPage.status, 400);
  assert.equal((await invalidTextPage.json()).contractVersion, "2.0");

  const invalidDetailTextLimit = await handleWorldconsSearchRequest(
    new Request(
      "https://provider.example/api/articles/germany-neubauer?textLimit=350001",
    ),
    env,
  );
  assert.equal(invalidDetailTextLimit.status, 400);
  assert.equal((await invalidDetailTextLimit.json()).error.code, "INVALID_REQUEST");
});

test("migration is projection-only, page-bounded, and service-role restricted", () => {
  const sql = fs.readFileSync(migrationPath, "utf8");

  assert.match(sql, /from public_article_projection_p3 article/iu);
  assert.match(sql, /neubauer\|klimabeschluss/iu);
  assert.match(sql, /1 BvR 2656\/18/iu);
  assert.match(sql, /limit p_limit \+ 1\s+offset p_offset/iu);
  assert.match(sql, /security definer/iu);
  assert.match(sql, /grant execute on function worldcons_provider_search_v1[\s\S]*to service_role/iu);
  assert.match(sql, /revoke all on function worldcons_provider_search_v1[\s\S]*from anon/iu);
  assert.doesNotMatch(sql, /\bfrom\s+articles\b/iu);
});

test("Contract V2 migration bounds evidence and preserves paginated source text", () => {
  const sql = fs.readFileSync(v2MigrationPath, "utf8");

  assert.match(sql, /create or replace function worldcons_provider_search_v2/iu);
  assert.match(sql, /from public_article_projection_p3 article/iu);
  assert.match(sql, /limit p_limit \+ 1\s+offset p_offset/iu);
  assert.match(sql, /'body_excerpt', left\(page\.cleaned_text, 6000\)/iu);
  assert.match(sql, /p_text_limit integer default 350000/iu);
  assert.match(sql, /substring\(article\.cleaned_text from p_offset \+ 1 for p_limit\)/iu);
  assert.match(sql, /grant execute on function worldcons_provider_search_v2[\s\S]*to service_role/iu);
  assert.match(sql, /revoke all on function worldcons_provider_source_text_v2[\s\S]*from anon/iu);
  assert.doesNotMatch(sql, /\bfrom\s+articles\b/iu);
});

test("Search V3 migration makes retrieval mode real and keeps published projection boundaries", () => {
  const sql = fs.readFileSync(v3SearchMigrationPath, "utf8");

  assert.match(sql, /create or replace function worldcons_provider_search_v3/iu);
  assert.match(sql, /p_mode text default 'hybrid'/iu);
  assert.match(sql, /p_query_embedding extensions\.vector\(1536\)/iu);
  assert.match(sql, /v_mode not in \('fulltext', 'semantic', 'hybrid'\)/iu);
  assert.match(sql, /v_mode in \('semantic', 'hybrid'\)[\s\S]*WORLDCONS_PROVIDER_EMBEDDING_REQUIRED/iu);
  assert.match(sql, /ts_rank_cd\(\(filtered\.article\)\.search_vector, v_tsquery, 32\)/iu);
  assert.match(sql, /embedding OPERATOR\(extensions\.<=>\) p_query_embedding/iu);
  assert.match(sql, /1\.0 \/ \(60 \+ candidates\.lexical_rank\)/iu);
  assert.match(sql, /1\.0 \/ \(60 \+ candidates\.semantic_rank\)/iu);
  assert.match(sql, /from public_article_projection_p3 article/iu);
  assert.match(sql, /grant execute on function worldcons_provider_search_v3[\s\S]*to service_role/iu);
  assert.match(sql, /revoke all on function worldcons_provider_search_v3[\s\S]*from anon/iu);
  assert.doesNotMatch(sql, /\bfrom\s+articles\b/iu);
});

test("Search V4 migration adds indexed four-country case keys and DB-native deep pagination", () => {
  const sql = fs.readFileSync(v4SearchMigrationPath, "utf8");

  assert.match(sql, /create or replace function worldcons_case_key_v1/iu);
  assert.match(sql, /fr-conseil-constitutionnel/iu);
  assert.match(sql, /es-tribunal-constitucional/iu);
  assert.match(sql, /us-scotus/iu);
  assert.match(sql, /add column if not exists case_key text generated always as/iu);
  assert.match(sql, /on article_content_versions_p3 \(source_key, case_key\)/iu);
  assert.match(sql, /create or replace function worldcons_ranked_search_page_v1/iu);
  assert.match(sql, /p_offset is null or p_offset not between 0 and 10000/iu);
  assert.match(sql, /p_source is not null and p_source <> v_exact_source/iu);
  assert.match(sql, /limit p_limit \+ 1 offset p_offset/iu);
  assert.match(sql, /v_candidate_limit integer := least\(greatest\(\(coalesce\(p_offset, 0\) \+ coalesce\(p_limit, 20\) \+ 1\) \* 3, 100\), 30063\)/iu);
  assert.match(sql, /create or replace function worldcons_provider_search_v4/iu);
  assert.match(sql, /'totalIsExact', coalesce\(\(v_page ->> 'totalIsExact'\)::boolean, false\)/iu);
  assert.match(sql, /grant execute on function worldcons_provider_search_v4[\s\S]*to service_role/iu);
});

test("provider resilience migration materializes only bounded scalar search fields", () => {
  const sql = fs.readFileSync(providerResilienceMigrationPath, "utf8");

  assert.match(sql, /create or replace function worldcons_provider_search_v4/iu);
  assert.match(sql, /join article_publications_p3 publication/iu);
  assert.match(sql, /join article_content_versions_p3 version/iu);
  assert.match(sql, /'body_excerpt', left\(version\.cleaned_text, 4000\)/iu);
  assert.doesNotMatch(sql, /provider_search_v3_item\(/iu);
  assert.doesNotMatch(sql, /select\s+article\.\*/iu);
  assert.match(sql, /grant execute on function worldcons_provider_search_v4[\s\S]*to service_role/iu);
});

test("Vercel provider truncates a large article body without dropping the preserved text API contract", async () => {
  const oversizedText = "가".repeat(600_000);
  const response = await handleWorldconsSearchRequest(
    new Request("https://provider.example/api/articles/germany-neubauer"),
    env,
    { coreBinding: createProviderFakeD1([], { cleanedText: oversizedText }) },
  );
  const raw = await response.clone().text();
  const payload = JSON.parse(raw);

  assert.equal(response.status, 200);
  assert.ok(Buffer.byteLength(payload.cleanedText, "utf8") <= 1_200_000);
  assert.equal(payload.textPage.hasMore, true);
  assert.ok(payload.textPage.nextOffset > 0);
  assert.ok(Buffer.byteLength(raw, "utf8") < 1_900_000);
  assert.match(payload.sourceTextUrl, /\/source-text$/u);
});

function searchDependencies(
  calls: Array<{ sql: string; params: unknown[] }> = [],
  vectorCalls: Array<{ vector: readonly number[]; options: VectorizeQueryOptions }> = [],
  fetcher?: typeof fetch,
  pageOptions: { total?: number; hasMore?: boolean } = {},
): ProviderDependencies & { pageOptions: { total?: number; hasMore?: boolean } } {
  const searchBinding: D1RuntimeDatabase = {
    prepare(sql: string): D1RuntimePreparedStatement {
      let params: unknown[] = [];
      const statement: D1RuntimePreparedStatement = {
        bind(...values: unknown[]) {
          params = values;
          return statement;
        },
        async all<T = Record<string, unknown>>() {
          calls.push({ sql, params });
          let results: Record<string, unknown>[];
          if (/count\(\*\) as total/iu.test(sql)) {
            results = [{ total: pageOptions.total ?? 1 }];
          } else if (/from search_fts[\s\S]*match \?/iu.test(sql) && /as score/iu.test(sql)) {
            results = [
              { article_id: neubauerRow().id, score: 1 },
              ...(pageOptions.hasMore ? [
                { article_id: "552950ac-de82-41f5-ae88-411efc5ae9b3", score: 0.5 },
                { article_id: "552950ac-de82-41f5-ae88-411efc5ae9b4", score: 0.25 },
              ] : []),
            ];
          } else if (/from search_fts[\s\S]*match \?/iu.test(sql)) {
            results = [{ article_id: neubauerRow().id, relevance_score: 1 }];
          } else if (/join search_fts on search_fts\.article_id/iu.test(sql)) {
            results = [{ article_id: neubauerRow().id, original_published_at: "2021-03-24T00:00:00Z", title: "Beschluss" }];
          } else {
            results = [{ article_id: neubauerRow().id }];
          }
          if (/offset \?/iu.test(sql) && /as score/iu.test(sql)) {
            results = results.slice(Number(params[params.length - 1] ?? 0));
          }
          if (/limit \?/iu.test(sql)) {
            const limit = Number(params[params.length - 2] ?? params[params.length - 1]);
            if (Number.isFinite(limit)) results = results.slice(0, limit);
          }
          return { success: true, results: results as unknown as T[] };
        },
      };
      return statement;
    },
  };
  const vectorBinding: VectorizeIndexBinding = {
    async query(vector, options): Promise<VectorizeQueryResult> {
      vectorCalls.push({ vector, options });
      return { matches: [{ id: neubauerRow().id, score: 0.9, metadata: { publishedEpoch: Date.parse("2021-03-24T00:00:00Z") } }] };
    },
  };
  return {
    coreBinding: createProviderFakeD1([], { cleanedText: NEUBAUER_EXCERPT }),
    searchBinding,
    vectorBinding,
    ...(fetcher ? { fetcher } : {}),
    pageOptions,
  };
}

function createProviderFakeD1(
  calls: string[] = [],
  options: { includeArticle?: boolean; cleanedText?: string | null } = {},
): D1RuntimeDatabase {
  const article = {
    ...neubauerRow(),
    id: neubauerRow().id,
    slug: neubauerRow().slug,
    source_key: "de-bverfg",
    jurisdiction: "Germany",
    institution_name: "Bundesverfassungsgericht",
    content_type: "decision",
    original_url: neubauerRow().original_url,
    canonical_url: neubauerRow().canonical_url,
    original_language: "de",
    original_title: "Beschluss vom 24. März 2021",
    korean_title: "독일 연방헌법재판소 기후보호법 헌법소원 결정",
    original_published_at: "2021-03-24T00:00:00Z",
    discovered_at: "2021-03-24T00:00:00Z",
    fetched_at: "2021-03-24T00:00:00Z",
    summarized_at: "2026-07-27T00:00:00Z",
    status: "summarized",
    cleaned_text: options.cleanedText === undefined ? "공식 원문 스냅샷" : options.cleanedText,
    content_hash: NEUBAUER_CHECKSUM,
    summary_json: neubauerRow().summary_json,
    source_metadata: { collection: { publishable: true }, caseNumber: "1 BvR 2656/18" },
    catalog_ai_stale_v4: 0,
  };
  const tables: Record<string, Record<string, unknown>[]> = {
    sources: [
      {
        id: "source-de",
        source_key: "de-bverfg",
        name: "Bundesverfassungsgericht",
        jurisdiction: "Germany",
        base_url: "https://www.bundesverfassungsgericht.de",
        language: "de",
        is_active: 1,
      },
      {
        id: "source-inactive",
        source_key: "de-old-court",
        name: "Inactive court",
        jurisdiction: "Germany",
        base_url: "https://www.bundesverfassungsgericht.de",
        language: "de",
        is_active: 0,
      },
    ],
    articles: options.includeArticle === false ? [] : [article],
    article_tags: [],
    tags: [],
  };

  return {
    prepare(sql: string): D1RuntimePreparedStatement {
      let params: unknown[] = [];
      const statement: D1RuntimePreparedStatement = {
        bind(...values: unknown[]) {
          params = values;
          return statement;
        },
        async all<T = Record<string, unknown>>() {
          calls.push(sql);
          const tableName = / from ([a-z_]+)/u.exec(sql)?.[1] ?? "";
          const tableRows = (tables[tableName] ?? []).map((row) => ({ ...row }));
          const where = / where (.*?)(?= order by | limit |$)/u.exec(sql)?.[1];
          let paramIndex = 0;
          let rows = tableRows;
          if (where) {
            for (const predicate of where.split(" and ")) {
              const inMatch = /^([a-z_]+) in \((?:\?,? ?)+\)$/u.exec(predicate);
              const equality = /^([a-z_][a-z0-9_]*) = \?$/u.exec(predicate);
              if (inMatch) {
                const column = inMatch[1];
                const valueCount = (predicate.match(/\?/gu) ?? []).length;
                const values = params.slice(paramIndex, paramIndex + valueCount);
                paramIndex += valueCount;
                rows = rows.filter((row) => values.includes(row[column]));
              } else if (equality) {
                const column = equality[1];
                const value = params[paramIndex++];
                rows = rows.filter((row) => row[column] === value);
              } else {
                throw new Error(`Fake D1 cannot evaluate ${predicate}`);
              }
            }
          }
          const order = / order by ([a-z_]+)(?: (asc|desc))?/u.exec(sql);
          if (order) {
            const [, column, direction] = order;
            rows.sort((left, right) => {
              const a = left[column] ?? "";
              const b = right[column] ?? "";
              return (a < b ? -1 : a > b ? 1 : 0) * (direction === "desc" ? -1 : 1);
            });
          }
          const limit = / limit \?/u.test(sql) ? Number(params[paramIndex++]) : rows.length;
          rows = rows.slice(0, limit);
          const select = /select (.*?) from /u.exec(sql)?.[1];
          if (select && select !== "*") {
            const columns = select.split(", ");
            rows = rows.map((row) => Object.fromEntries(columns.map((column) => [column, row[column] ?? null])));
          }
          return { success: true, results: rows as unknown as T[] };
        },
      };
      return statement;
    },
  };
}

function embeddingResponse() {
  return Response.json({
    embedding: { values: Array.from({ length: 1536 }, (_, index) => index === 0 ? 2 : 0) },
  });
}

function neubauerRow() {
  return {
    id: "552950ac-de82-41f5-ae88-411efc5ae9b2",
    slug: "germany-neubauer",
    source_key: "de-bverfg",
    jurisdiction: "Germany",
    institution_name: "Bundesverfassungsgericht",
    content_type: "decision",
    original_url:
      "https://www.bundesverfassungsgericht.de/SharedDocs/Entscheidungen/DE/2021/03/rs20210324_1bvr265618.html",
    canonical_url:
      "https://www.bundesverfassungsgericht.de/SharedDocs/Entscheidungen/DE/2021/03/rs20210324_1bvr265618.html",
    original_language: "de",
    original_title: "Beschluss vom 24. März 2021",
    korean_title: "독일 연방헌법재판소 기후보호법 헌법소원 결정",
    original_published_at: "2021-03-24T00:00:00Z",
    summarized_at: "2026-07-27T00:00:00Z",
    summary_json: {
      summary: {
        background: "기후위기와 미래세대의 자유가 문제 되었다.",
        coreSummary: ["기후보호 의무의 세대 간 배분을 심사했다."],
      },
      tags: ["기후보호", "미래세대"],
    },
    source_metadata: {
      caseNumber: "1 BvR 2656/18",
    },
    article_tags: [],
    case_number: "1 BvR 2656/18",
    body_excerpt: NEUBAUER_EXCERPT,
    content_hash: NEUBAUER_CHECKSUM,
    relevance_score: 1000,
  };
}
