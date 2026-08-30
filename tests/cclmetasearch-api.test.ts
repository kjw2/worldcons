import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { GET as unknownEndpointGet } from "../app/api/cclmetasearch/[...path]/route";
import {
  CCL_METASEARCH_TOKEN_HEADER,
  CclMetasearchRequestError,
  parseCclMetasearchSearchParams,
} from "../lib/cclmetasearch/contract";
import { createCclMetasearchSearchHandler } from "../lib/cclmetasearch/handler";
import { mapCclMetasearchRow } from "../lib/cclmetasearch/mapper";

const TOKEN = "test-cclmetasearch-token-value";
const migrationPath = path.join(
  process.cwd(),
  "supabase/migrations/20260715120000_cclmetasearch_search_api.sql",
);

test("search parameter contract accepts q or keyword and applies bounded defaults", () => {
  assert.deepEqual(parseCclMetasearchSearchParams(new URLSearchParams("q=표현의+자유")), {
    query: "표현의 자유",
    limit: 10,
    offset: 0,
    sort: "relevance",
  });
  assert.deepEqual(parseCclMetasearchSearchParams(new URLSearchParams("keyword=privacy&limit=20&offset=40&sort=latest")), {
    query: "privacy",
    limit: 20,
    offset: 40,
    sort: "latest",
  });
});

test("search parameter contract rejects ambiguity, unknown keys, and out-of-range pagination", () => {
  const invalidQueries = [
    "q=one&keyword=two",
    "q=test&limit=21",
    "q=test&offset=-1",
    "q=test&sort=oldest",
    "q=test&unexpected=true",
    "q=test&q=again",
    "q=%3C%3E",
  ];

  for (const query of invalidQueries) {
    assert.throws(
      () => parseCclMetasearchSearchParams(new URLSearchParams(query)),
      CclMetasearchRequestError,
      query,
    );
  }
});

test("result mapper emits normalized fields and source-specific case numbers", () => {
  const france = mapCclMetasearchRow(
    databaseRow({
      source_key: "fr-conseil-constitutionnel",
      jurisdiction: "France",
      institution_name: "Conseil constitutionnel",
      original_language: "fr",
      original_title: "Décision n° 2026-1213 QPC du 12 juin 2026",
      original_url: "https://www.conseil-constitutionnel.fr/decision/2026/20261213QPC.htm",
    }),
    "https://worldcons.vercel.app",
  );
  const spain = mapCclMetasearchRow(
    databaseRow({
      id: "22222222-2222-4222-8222-222222222222",
      slug: "spain-case",
      source_key: "es-tribunal-constitucional",
      jurisdiction: "Spain",
      institution_name: "Tribunal Constitucional",
      original_language: "es",
      original_title: "SENTENCIA 44/2026, de 25 de marzo",
    }),
    "https://worldcons.vercel.app",
  );
  const unitedStates = mapCclMetasearchRow(
    databaseRow({
      id: "33333333-3333-4333-8333-333333333333",
      slug: "us-case",
      source_key: "us-scotus",
      jurisdiction: "United States",
      institution_name: "Supreme Court of the United States",
      original_language: "en",
      original_title: "Example v. United States",
      original_url: "https://www.supremecourt.gov/opinions/25pdf/24-621_h315.pdf",
    }),
    "https://worldcons.vercel.app",
  );
  const germany = mapCclMetasearchRow(
    databaseRow({
      id: "44444444-4444-4444-8444-444444444444",
      slug: "germany-case",
      source_key: "de-bverfg",
      jurisdiction: "Germany",
      institution_name: "Bundesverfassungsgericht",
      original_language: "de",
      source_metadata: { caseNumber: "2 BvE 3/26" },
    }),
    "https://worldcons.vercel.app",
  );

  assert.equal(france.caseNumber, "2026-1213 QPC");
  assert.equal(france.countryCode, "FR");
  assert.equal(france.countryName, "프랑스");
  assert.equal(france.courtName, "프랑스 헌법위원회");
  assert.equal(france.summary, "첫 번째 요약 두 번째 요약");
  assert.equal(france.snippet, "첫 번째 요약");
  assert.deepEqual(france.keywords, ["표현의 자유", "언론"]);
  assert.deepEqual(france.topics, ["표현의 자유", "기본권"]);
  assert.match(france.detailUrl, /^https:\/\/worldcons\.vercel\.app\/articles\//u);
  assert.equal(spain.caseNumber, "44/2026");
  assert.equal(unitedStates.caseNumber, "24-621");
  assert.equal(germany.caseNumber, "2 BvE 3/26");
});

test("handler enforces shared-token authentication", async () => {
  const handler = testHandler();

  const missing = await handler(searchRequest());
  assert.equal(missing.status, 401);
  assert.equal((await missing.json()).error.code, "AUTH_REQUIRED");

  const wrong = await handler(searchRequest("wrong-token"));
  assert.equal(wrong.status, 403);
  assert.equal((await wrong.json()).error.code, "FORBIDDEN");

  const unavailable = await createCclMetasearchSearchHandler({
    getExpectedToken: () => null,
    search: async () => ({ items: [], total: 0 }),
    consumeRateLimit: () => null,
  })(searchRequest(TOKEN));
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.headers.get("retry-after"), "30");
});

test("handler returns a bounded page and exact pagination metadata", async () => {
  const item = mapCclMetasearchRow(databaseRow(), "https://worldcons.vercel.app");
  const handler = createCclMetasearchSearchHandler({
    getExpectedToken: () => TOKEN,
    search: async (input) => {
      assert.equal(input.limit, 1);
      assert.equal(input.offset, 2);
      assert.equal(input.sort, "latest");
      return { items: [item], total: 4 };
    },
    consumeRateLimit: () => null,
  });
  const response = await handler(searchRequest(TOKEN, "q=헌법&limit=1&offset=2&sort=latest"));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.items.length, 1);
  assert.deepEqual(payload.meta, { limit: 1, offset: 2, total: 4, hasMore: true });
  assert.equal(response.headers.get("cache-control"), "private, max-age=60, stale-while-revalidate=300");
  assert.equal(response.headers.get("vary"), "X-CCL-Metasearch-Token");
});

test("handler treats a valid empty page as 200 and malformed input as 400", async () => {
  const handler = createCclMetasearchSearchHandler({
    getExpectedToken: () => TOKEN,
    search: async () => ({ items: [], total: 3 }),
    consumeRateLimit: () => null,
  });
  const empty = await handler(searchRequest(TOKEN, "keyword=헌법&offset=10"));
  assert.equal(empty.status, 200);
  assert.deepEqual((await empty.json()).meta, { limit: 10, offset: 10, total: 3, hasMore: false });

  const invalid = await handler(searchRequest(TOKEN, "q=헌법&limit=99"));
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, "INVALID_REQUEST");
});

test("handler emits normalized 429 and 503 errors", async () => {
  const limited = await createCclMetasearchSearchHandler({
    getExpectedToken: () => TOKEN,
    search: async () => ({ items: [], total: 0 }),
    consumeRateLimit: () => ({
      limited: true,
      limit: 1,
      remaining: 0,
      resetAt: Date.now() + 12_000,
      retryAfterSeconds: 12,
      backend: "local" as const,
      headers: { "X-RateLimit-Limit": "1", "Retry-After": "12" },
    }),
  })(searchRequest(TOKEN));
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "12");
  assert.equal((await limited.json()).error.code, "RATE_LIMITED");

  const unavailable = await createCclMetasearchSearchHandler({
    getExpectedToken: () => TOKEN,
    search: async () => {
      throw new Error("database unavailable");
    },
    consumeRateLimit: () => null,
  })(searchRequest(TOKEN));
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).error.code, "SERVICE_UNAVAILABLE");
});

test("unknown integration paths use the documented JSON 404 contract", async () => {
  const response = await unknownEndpointGet();
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, "NOT_FOUND");
});

test("migration searches only the public projection and applies database pagination", () => {
  const sql = fs.readFileSync(migrationPath, "utf8");

  assert.match(sql, /from public_article_projection_p3 article[\s\S]*search_vector @@ v_query/iu);
  assert.match(sql, /limit p_limit\s+offset p_offset/iu);
  assert.match(sql, /select count\(\*\)::bigint[\s\S]*into v_total/iu);
  assert.match(sql, /p_limit < 1 or p_limit > 20/iu);
  assert.match(sql, /revoke all on function cclmetasearch_search_v1[\s\S]*from public/iu);
  assert.match(sql, /grant execute on function cclmetasearch_search_v1[\s\S]*to service_role/iu);
  assert.doesNotMatch(sql, /\bfrom\s+articles\b/iu);
});

function testHandler() {
  return createCclMetasearchSearchHandler({
    getExpectedToken: () => TOKEN,
    search: async () => ({ items: [], total: 0 }),
    consumeRateLimit: () => null,
  });
}

function searchRequest(token?: string, query = "q=헌법") {
  const headers = new Headers();
  if (token) headers.set(CCL_METASEARCH_TOKEN_HEADER, token);
  return new Request(`https://worldcons.vercel.app/api/cclmetasearch/search?${query}`, { headers });
}

function databaseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    slug: "sample-case",
    source_key: "fr-conseil-constitutionnel",
    jurisdiction: "France",
    institution_name: "Conseil constitutionnel",
    original_url: "https://example.org/original",
    canonical_url: "https://example.org/original",
    original_language: "fr",
    original_title: "Décision n° 2026-1213 QPC du 12 juin 2026",
    korean_title: "언론의 자유에 관한 결정",
    original_published_at: "2026-06-12T00:00:00Z",
    discovered_at: "2026-06-13T00:00:00Z",
    fetched_at: "2026-06-13T01:00:00Z",
    summarized_at: "2026-06-13T02:00:00Z",
    summary_json: {
      summary: { coreSummary: ["첫 번째 요약", "두 번째 요약"] },
      tags: ["언론"],
      categories: ["기본권"],
    },
    source_metadata: {},
    article_tags: [
      {
        confidence: 0.9,
        tags: { name: "표현의 자유", type: "right" },
      },
    ],
    relevance_score: 0.25,
    ...overrides,
  };
}
