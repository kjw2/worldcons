import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  handleWorldconsSearchRequest,
  type SearchWorkerEnv,
} from "../workers/search-api/src/handler";

const migrationPath = path.join(
  process.cwd(),
  "supabase/migrations/20260727120000_worldcons_cloudflare_search_api.sql",
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
const NEUBAUER_CHECKSUM = "527b41e3310651a4ba4d1a9a0c1e358e0cf6c292241fe019a8c71f1fc18058ba";
const NEUBAUER_EXCERPT =
  "공식 독일 연방헌법재판소 결정문 발췌로서 기후보호법의 감축부담이 미래세대의 자유행사에 미치는 영향과 국가의 헌법상 보호의무를 설명한다. 재판소는 세대 간 자유 보장의 균형을 중심으로 심사하였다.";

const env = {
  ENVIRONMENT: "test",
  PUBLIC_BASE_URL: "https://worldcons-search-api.example.workers.dev",
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
} satisfies SearchWorkerEnv;

const embeddingEnv = {
  ...env,
  OPENAI_API_KEY: "test-openai-key",
  OPENAI_EMBEDDING_MODEL: "text-embedding-3-small",
} satisfies SearchWorkerEnv;

test("Worker search accepts the cclrag2 contract and returns the Neubauer case first", async () => {
  const calls: Array<{
    url: string;
    body: Record<string, unknown>;
    authorization: string | null;
    requestId: string | null;
  }> = [];
  const response = await handleWorldconsSearchRequest(
    new Request(
      "https://worldcons-search-api.example.workers.dev/api/search?q=1%20BvR%202656%2F18%20climate&mode=hybrid&pageSize=10&count=none&jurisdiction=Germany&source=de-bverfg",
      { headers: { "x-request-id": "cclrag2-neubauer-test" } },
    ),
    env,
    {
      fetcher: async (input, init) => {
        calls.push({
          url: String(input),
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
          authorization: new Headers(init?.headers).get("authorization"),
          requestId: new Headers(init?.headers).get("x-request-id"),
        });
        return Response.json({
          items: [neubauerRow()],
        });
      },
    },
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-provider-contract-version"), "2.0");
  assert.equal(response.headers.get("x-request-id"), "cclrag2-neubauer-test");
  assert.equal(payload.contractVersion, "2.0");
  assert.equal(payload.requestId, "cclrag2-neubauer-test");
  assert.equal(payload.transport, "cloudflare-worker");
  assert.equal(payload.requestedMode, "hybrid");
  assert.equal(payload.effectiveMode, "hybrid");
  assert.equal(payload.mode, "hybrid");
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
  assert.equal(payload.items[0].sectionAnchors[0].kind, "passage");
  assert.equal(
    payload.items[0].detailApiUrl,
    "https://worldcons-search-api.example.workers.dev/api/articles/germany-neubauer",
  );
  assert.equal(payload.items[0].summaryJson.summary.background, "기후위기와 미래세대의 자유가 문제 되었다.");
  assert.deepEqual(payload.meta, {
    limit: 10,
    offset: 0,
    total: 1,
    hasMore: false,
    totalIsExact: false,
  });
  assert.equal(calls[0].body.p_query, "1 BvR 2656/18 climate");
  assert.equal(calls[0].body.p_mode, "hybrid");
  assert.equal(calls[0].body.p_query_embedding, null);
  assert.equal(calls[0].body.p_source, "de-bverfg");
  assert.equal(calls[0].body.p_jurisdiction, "Germany");
  assert.equal(calls[0].body.p_count, "none");
  assert.equal(calls[0].authorization, "Bearer test-service-role-key");
  assert.equal(calls[0].requestId, "cclrag2-neubauer-test");
  assert.match(calls[0].url, /worldcons_provider_search_v4$/u);
  assert.ok(Number(response.headers.get("content-length")) < 1_500_000);
  assert.doesNotMatch(JSON.stringify(payload), /vercel\.app/iu);
});

test("Worker preserves the Korean comparison query and returns Neubauer first", async () => {
  let rpcBody: Record<string, unknown> | undefined;
  const response = await handleWorldconsSearchRequest(
    new Request(
      "https://worldcons-search-api.example.workers.dev/api/search?q=%ED%95%9C%EA%B5%AD%20%ED%97%8C%EC%9E%AC%20%EA%B8%B0%ED%9B%84%EA%B2%B0%EC%A0%95%EA%B3%BC%20%EB%8F%85%EC%9D%BC%20%EC%97%B0%EB%B0%A9%ED%97%8C%EB%B2%95%EC%9E%AC%ED%8C%90%EC%86%8C%20Neubauer%20%EA%B8%B0%ED%9B%84%EA%B2%B0%EC%A0%95%EC%9D%84%20%EB%B9%84%EA%B5%90&mode=hybrid&pageSize=5&count=none",
    ),
    env,
    {
      fetcher: async (_input, init) => {
        rpcBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({ items: [neubauerRow()] });
      },
    },
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.items[0].caseNumber, "1 BvR 2656/18");
  assert.match(String(rpcBody?.p_query), /Neubauer/u);
});

test("Worker fulltext mode bypasses embeddings and executes V4 lexical retrieval", async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const response = await handleWorldconsSearchRequest(
    new Request("https://worldcons-search-api.example.workers.dev/api/search?q=freedom&mode=fulltext&pageSize=5"),
    embeddingEnv,
    {
      fetcher: async (input, init) => {
        calls.push({
          url: String(input),
          body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {},
        });
        return Response.json({ items: [neubauerRow()], retrievalMode: "fulltext" });
      },
    },
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /worldcons_provider_search_v4$/u);
  assert.equal(calls[0].body.p_mode, "fulltext");
  assert.equal(calls[0].body.p_query_embedding, null);
  assert.equal(payload.requestedMode, "fulltext");
  assert.equal(payload.effectiveMode, "fulltext");
  assert.equal(payload.degraded, false);
  assert.equal(payload.databaseRetrievalMode, "fulltext");
});

test("Worker reports an explicit fulltext fallback when semantic capability is not configured", async () => {
  const rpcBodies: Array<Record<string, unknown>> = [];
  const response = await handleWorldconsSearchRequest(
    new Request("https://worldcons-search-api.example.workers.dev/api/search?q=climate%20freedom&mode=hybrid&pageSize=5"),
    env,
    {
      fetcher: async (_input, init) => {
        rpcBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Response.json({ items: [neubauerRow()], retrievalMode: "fulltext" });
      },
    },
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(rpcBodies.length, 1);
  assert.equal(rpcBodies[0].p_mode, "fulltext");
  assert.equal(rpcBodies[0].p_query_embedding, null);
  assert.equal(payload.requestedMode, "hybrid");
  assert.equal(payload.effectiveMode, "fulltext");
  assert.equal(payload.degraded, true);
  assert.equal(payload.degradationReason, "embedding_not_configured");
});

test("Worker semantic mode creates an embedding and passes it to V4 vector retrieval", async () => {
  const rpcCalls: Array<Record<string, unknown>> = [];
  let embeddingCalls = 0;
  const response = await handleWorldconsSearchRequest(
    new Request("https://worldcons-search-api.example.workers.dev/api/search?q=intergenerational%20climate%20freedom&mode=semantic&pageSize=5"),
    embeddingEnv,
    {
      fetcher: async (input, init) => {
        const url = String(input);
        if (url === "https://api.openai.com/v1/embeddings") {
          embeddingCalls += 1;
          const requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
          assert.equal(requestBody.model, "text-embedding-3-small");
          assert.equal(requestBody.dimensions, 1536);
          assert.match(String(requestBody.input), /climate/u);
          assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-openai-key");
          return embeddingResponse();
        }
        rpcCalls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Response.json({ items: [neubauerRow()], retrievalMode: "semantic" });
      },
    },
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(embeddingCalls, 1);
  assert.equal(rpcCalls.length, 1);
  assert.equal(rpcCalls[0].p_mode, "semantic");
  assert.equal(Array.isArray(rpcCalls[0].p_query_embedding), true);
  assert.equal((rpcCalls[0].p_query_embedding as unknown[]).length, 1536);
  assert.equal(payload.requestedMode, "semantic");
  assert.equal(payload.effectiveMode, "semantic");
  assert.equal(payload.mode, "semantic");
  assert.equal(payload.degraded, false);
  assert.equal(payload.databaseRetrievalMode, "semantic");
});

test("Worker hybrid mode uses embeddings when available and degrades explicitly when embedding fails", async () => {
  const hybridRpcBodies: Array<Record<string, unknown>> = [];
  const hybrid = await handleWorldconsSearchRequest(
    new Request("https://worldcons-search-api.example.workers.dev/api/search?q=climate%20freedom&mode=hybrid&pageSize=5"),
    embeddingEnv,
    {
      fetcher: async (input, init) => {
        if (String(input) === "https://api.openai.com/v1/embeddings") return embeddingResponse();
        hybridRpcBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Response.json({ items: [neubauerRow()], retrievalMode: "hybrid" });
      },
    },
  );
  const hybridPayload = await hybrid.json();

  assert.equal(hybrid.status, 200);
  assert.equal(hybridRpcBodies[0].p_mode, "hybrid");
  assert.equal((hybridRpcBodies[0].p_query_embedding as unknown[]).length, 1536);
  assert.equal(hybridPayload.requestedMode, "hybrid");
  assert.equal(hybridPayload.effectiveMode, "hybrid");
  assert.equal(hybridPayload.degraded, false);

  const degradedRpcBodies: Array<Record<string, unknown>> = [];
  const degraded = await handleWorldconsSearchRequest(
    new Request("https://worldcons-search-api.example.workers.dev/api/search?q=climate%20freedom&mode=hybrid&pageSize=5"),
    embeddingEnv,
    {
      fetcher: async (input, init) => {
        if (String(input) === "https://api.openai.com/v1/embeddings") {
          return Response.json({ error: "embedding unavailable" }, { status: 503 });
        }
        degradedRpcBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Response.json({ items: [neubauerRow()], retrievalMode: "fulltext" });
      },
    },
  );
  const degradedPayload = await degraded.json();

  assert.equal(degraded.status, 200);
  assert.equal(degradedRpcBodies[0].p_mode, "fulltext");
  assert.equal(degradedRpcBodies[0].p_query_embedding, null);
  assert.equal(degradedPayload.requestedMode, "hybrid");
  assert.equal(degradedPayload.effectiveMode, "fulltext");
  assert.equal(degradedPayload.mode, "fulltext");
  assert.equal(degradedPayload.degraded, true);
  assert.equal(degradedPayload.degradationReason, "embedding_unavailable");
});

test("Worker exact-case preflight covers France, Spain, and the US without embedding calls", async () => {
  const cases = [
    ["2026-912%20QPC", "fr-conseil-constitutionnel"],
    ["53%2F2025", "es-tribunal-constitucional"],
    ["No.%2024-109", "us-scotus"],
  ] as const;

  for (const [query, sourceKey] of cases) {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const response = await handleWorldconsSearchRequest(
      new Request(`https://worldcons-search-api.example.workers.dev/api/search?q=${query}&mode=hybrid&source=${sourceKey}`),
      env,
      {
        fetcher: async (input, init) => {
          calls.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
          return Response.json({ items: [], retrievalMode: "exact-case", total: 0, hasMore: false, totalIsExact: false });
        },
      },
    );
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /worldcons_provider_search_v4$/u);
    assert.equal(calls[0].body.p_query_embedding, null);
    assert.equal(calls[0].body.p_mode, "hybrid");
    assert.equal(payload.degraded, false);
    assert.equal(payload.databaseRetrievalMode, "exact-case");
  }
});

test("Worker preserves exact total semantics returned by the DB-native page contract", async () => {
  const response = await handleWorldconsSearchRequest(
    new Request("https://worldcons-search-api.example.workers.dev/api/search?q=freedom&mode=fulltext&page=2&pageSize=10&count=exact"),
    env,
    {
      fetcher: async () => Response.json({
        items: [neubauerRow()],
        retrievalMode: "fulltext",
        total: 37,
        hasMore: true,
        totalIsExact: true,
      }),
    },
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(payload.meta, {
    limit: 10,
    offset: 10,
    total: 37,
    hasMore: true,
    totalIsExact: true,
  });
  assert.deepEqual(payload.pageInfo, {
    page: 2,
    pageSize: 10,
    total: 37,
    hasMore: true,
    totalIsExact: true,
  });
});

test("Worker source and article endpoints expose bounded Contract V2 evidence", async () => {
  const calls: Array<{ pathname: string; body: Record<string, unknown> }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const pathname = new URL(String(input)).pathname;
    calls.push({
      pathname,
      body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {},
    });
    if (pathname.endsWith("/worldcons_provider_sources_v1")) {
      return Response.json([
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
    if (pathname.endsWith("/worldcons_provider_article_v2")) {
      return Response.json({
        ...neubauerRow(),
        cleaned_text: "공식 원문 스냅샷",
        cleaned_text_offset: 0,
        cleaned_text_limit: 350000,
        cleaned_text_total_chars: 9,
        cleaned_text_has_more: false,
      });
    }
    if (pathname.endsWith("/worldcons_provider_source_text_v2")) {
      return Response.json({
        id: neubauerRow().id,
        slug: neubauerRow().slug,
        cleaned_text: "공식 원문 스냅샷 일부",
        cleaned_text_offset: 10,
        cleaned_text_limit: 20,
        cleaned_text_total_chars: 100,
        cleaned_text_has_more: true,
        content_hash: NEUBAUER_CHECKSUM,
      });
    }
    return Response.json({}, { status: 404 });
  };

  const sources = await handleWorldconsSearchRequest(
    new Request("https://worldcons-search-api.example.workers.dev/api/sources"),
    env,
    { fetcher },
  );
  const detail = await handleWorldconsSearchRequest(
    new Request("https://worldcons-search-api.example.workers.dev/api/articles/germany-neubauer"),
    env,
    { fetcher },
  );
  const sourceText = await handleWorldconsSearchRequest(
    new Request(
      "https://worldcons-search-api.example.workers.dev/api/articles/germany-neubauer/source-text?offset=10&limit=20",
    ),
    env,
    { fetcher },
  );

  assert.equal(sources.status, 200);
  const sourcesPayload = await sources.json();
  assert.equal(sourcesPayload.contractVersion, "2.0");
  assert.equal(sourcesPayload.items[0].sourceType, "foreign_constitutional");
  assert.equal(sourcesPayload.items[0].countryCode, "DE");
  assert.equal(sourcesPayload.items[0].officialUri, "https://www.bundesverfassungsgericht.de/");
  assert.equal(detail.status, 200);
  const detailPayload = await detail.json();
  assert.equal(detailPayload.contractVersion, "2.0");
  assert.equal(detailPayload.cleanedText, "공식 원문 스냅샷");
  assert.equal(detailPayload.excerptKind, "document_section");
  assert.equal(detailPayload.bodyChecksum, NEUBAUER_CHECKSUM);
  assert.equal(detailPayload.textPage.hasMore, false);
  assert.ok(Number(detail.headers.get("content-length")) < 1_900_000);
  assert.equal(sourceText.status, 200);
  const sourceTextPayload = await sourceText.json();
  assert.equal(sourceTextPayload.cleanedText, "공식 원문 스냅샷 일부");
  assert.equal(sourceTextPayload.bodyChecksum, NEUBAUER_CHECKSUM);
  assert.deepEqual(sourceTextPayload.textPage, {
    offset: 10,
    limit: 20,
    returnedChars: 12,
    totalChars: 100,
    hasMore: true,
    nextOffset: 22,
  });
  const sourceTextCall = calls.find((call) => call.pathname.endsWith("/worldcons_provider_source_text_v2"));
  assert.deepEqual(sourceTextCall?.body, {
    p_slug: "germany-neubauer",
    p_offset: 10,
    p_limit: 20,
  });
});

test("Worker rejects invalid input and normalizes dependency failures", async () => {
  const invalid = await handleWorldconsSearchRequest(
    new Request("https://worldcons-search-api.example.workers.dev/api/search?q=test&pageSize=21"),
    env,
  );
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, "INVALID_REQUEST");

  const rateLimited = await handleWorldconsSearchRequest(
    new Request("https://worldcons-search-api.example.workers.dev/api/search?q=test"),
    env,
    {
      fetcher: async () => Response.json({ error: "rate limited" }, {
        status: 429,
        headers: { "retry-after": "17" },
      }),
    },
  );
  assert.equal(rateLimited.status, 429);
  assert.equal(rateLimited.headers.get("retry-after"), "17");

  const unavailable = await handleWorldconsSearchRequest(
    new Request("https://worldcons-search-api.example.workers.dev/api/search?q=test"),
    env,
    {
      fetcher: async () => Response.json({ error: "upstream unavailable" }, { status: 500 }),
    },
  );
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).error.code, "SERVICE_UNAVAILABLE");

  const invalidTextPage = await handleWorldconsSearchRequest(
    new Request(
      "https://worldcons-search-api.example.workers.dev/api/articles/germany-neubauer/source-text?limit=350001",
    ),
    env,
  );
  assert.equal(invalidTextPage.status, 400);
  assert.equal((await invalidTextPage.json()).contractVersion, "2.0");
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

test("Worker truncates a large article body without dropping the preserved text API contract", async () => {
  const oversizedText = "가".repeat(600_000);
  const response = await handleWorldconsSearchRequest(
    new Request("https://worldcons-search-api.example.workers.dev/api/articles/germany-neubauer"),
    env,
    {
      fetcher: async () => Response.json({
        ...neubauerRow(),
        cleaned_text: oversizedText,
        cleaned_text_offset: 0,
        cleaned_text_limit: 350000,
        cleaned_text_total_chars: oversizedText.length,
        cleaned_text_has_more: true,
      }),
    },
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

function embeddingResponse() {
  return Response.json({
    data: [{ embedding: Array.from({ length: 1536 }, (_, index) => index === 0 ? 1 : 0) }],
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
