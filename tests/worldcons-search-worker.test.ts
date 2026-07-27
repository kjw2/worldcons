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

const env = {
  ENVIRONMENT: "test",
  PUBLIC_BASE_URL: "https://worldcons-search-api.example.workers.dev",
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
} satisfies SearchWorkerEnv;

test("Worker search accepts the cclrag2 contract and returns the Neubauer case first", async () => {
  const calls: Array<{ url: string; body: Record<string, unknown>; authorization: string | null }> = [];
  const response = await handleWorldconsSearchRequest(
    new Request(
      "https://worldcons-search-api.example.workers.dev/api/search?q=1%20BvR%202656%2F18%20climate&mode=hybrid&pageSize=10&count=none&jurisdiction=Germany&source=de-bverfg",
    ),
    env,
    {
      fetcher: async (input, init) => {
        calls.push({
          url: String(input),
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
          authorization: new Headers(init?.headers).get("authorization"),
        });
        return Response.json({
          items: [neubauerRow()],
        });
      },
    },
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.transport, "cloudflare-worker");
  assert.equal(payload.items[0].caseNumber, "1 BvR 2656/18");
  assert.equal(payload.items[0].sourceType, "foreign_constitutional");
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
  assert.equal(calls[0].body.p_source, "de-bverfg");
  assert.equal(calls[0].body.p_jurisdiction, "Germany");
  assert.equal(calls[0].authorization, "Bearer test-service-role-key");
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

test("Worker source and article endpoints read Supabase RPCs directly", async () => {
  const fetcher: typeof fetch = async (input) => {
    const pathname = new URL(String(input)).pathname;
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
    if (pathname.endsWith("/worldcons_provider_article_v1")) {
      return Response.json({
        ...neubauerRow(),
        cleaned_text: "공식 원문 스냅샷",
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
    new Request("https://worldcons-search-api.example.workers.dev/api/articles/germany-neubauer/source-text"),
    env,
    { fetcher },
  );

  assert.equal(sources.status, 200);
  assert.equal((await sources.json()).items[0].sourceType, "foreign_constitutional");
  assert.equal(detail.status, 200);
  assert.equal((await detail.json()).cleanedText, "공식 원문 스냅샷");
  assert.equal(sourceText.status, 200);
  assert.equal((await sourceText.json()).cleanedText, "공식 원문 스냅샷");
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
    relevance_score: 1000,
  };
}
