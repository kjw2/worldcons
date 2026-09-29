import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";
import { GET as unknownEndpointGet } from "../app/api/cclmetasearch/[...path]/route";
import {
  CCL_METASEARCH_TOKEN_HEADER,
  CclMetasearchRequestError,
  parseCclMetasearchSearchParams,
  type CclMetasearchSearchInput,
} from "../lib/cclmetasearch/contract";
import { createCclMetasearchSearchHandler } from "../lib/cclmetasearch/handler";
import { mapCclMetasearchRow } from "../lib/cclmetasearch/mapper";
import { searchCclMetasearchWithEnv } from "../lib/cclmetasearch/search";
import { emitDatabaseDdl } from "../lib/cloudflare/d1/ddl";
import { d1Schema } from "../lib/cloudflare/d1/schema";
import type { D1RuntimeDatabase, D1RuntimePreparedStatement } from "../lib/cloudflare/d1/runtime-binding";

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

test("production cclmetasearch backend no longer references Supabase", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "lib/cclmetasearch/search.ts"), "utf8");

  assert.doesNotMatch(source, /@supabase\/supabase-js/u);
  assert.doesNotMatch(source, /SUPABASE_URL/u);
  assert.doesNotMatch(source, /SUPABASE_SERVICE_ROLE_KEY/u);
});

test("search reads matching ids/rank/date from worldcons_search and hydrates from worldcons_core", async () => {
  const { core, search } = d1Fixture();
  const env = fixtureEnv(core, search);

  const page = await searchCclMetasearchWithEnv(searchInput({ query: "constitution" }), env);

  assert.equal(page.total, 2);
  assert.deepEqual(page.items.map((item) => item.id), [CONSTITUTION_ID, PRIVACY_ID]);
  const [first] = page.items;
  assert.equal(first.title, "헌법의 날");
  assert.equal(first.originalTitle, "Constitution Day");
  assert.equal(first.caseNumber, "2026-1000");
  assert.equal(first.originalLanguage, "en");
  assert.deepEqual(first.keywords, ["Constitution", "헌법"]);
  assert.deepEqual(first.topics, ["Constitution", "기본권"]);
  assert.ok(first.relevanceScore !== null && Number.isFinite(first.relevanceScore));
  assert.match(first.detailUrl, /^https:\/\/worldcons\.vercel\.app\/articles\//u);
});

test("latest sort orders the same match set by publication date", async () => {
  const { core, search } = d1Fixture();
  const env = fixtureEnv(core, search);

  const page = await searchCclMetasearchWithEnv(
    searchInput({ query: "constitution", sort: "latest" }),
    env,
  );

  assert.equal(page.total, 2);
  assert.deepEqual(page.items.map((item) => item.id), [PRIVACY_ID, CONSTITUTION_ID]);
});

test("exact total is returned even when the page is bounded or empty", async () => {
  const { core, search } = d1Fixture();
  const env = fixtureEnv(core, search);

  const bounded = await searchCclMetasearchWithEnv(searchInput({ query: "constitution", limit: 1 }), env);
  assert.equal(bounded.total, 2);
  assert.equal(bounded.items.length, 1);
  assert.deepEqual(bounded.items.map((item) => item.id), [CONSTITUTION_ID]);

  const pastTheEnd = await searchCclMetasearchWithEnv(
    searchInput({ query: "constitution", offset: 10 }),
    env,
  );
  assert.equal(pastTheEnd.total, 2);
  assert.deepEqual(pastTheEnd.items, []);

  const noMatch = await searchCclMetasearchWithEnv(searchInput({ query: "nonexistentterm" }), env);
  assert.equal(noMatch.total, 0);
  assert.deepEqual(noMatch.items, []);
});

test("search fails closed on malformed worldcons_search D1 responses", async () => {
  const { core } = d1Fixture();
  const baseEnv = {
    PUBLIC_SITE_BASE_URL: "https://worldcons.vercel.app",
    CORE_BINDING: localBinding(core),
  };

  const nonObjectResult: D1RuntimeDatabase = { prepare: () => stubPrepared({ success: true, results: null }) };
  await assert.rejects(
    () => searchCclMetasearchWithEnv(searchInput({ query: "constitution" }), { ...baseEnv, SEARCH_BINDING: nonObjectResult }),
  );

  const failedResult: D1RuntimeDatabase = { prepare: () => stubPrepared({ success: false, error: "boom" }) };
  await assert.rejects(
    () => searchCclMetasearchWithEnv(searchInput({ query: "constitution" }), { ...baseEnv, SEARCH_BINDING: failedResult }),
  );

  const nonObjectRow: D1RuntimeDatabase = { prepare: () => stubPrepared({ success: true, results: [null] }) };
  await assert.rejects(
    () => searchCclMetasearchWithEnv(searchInput({ query: "constitution" }), { ...baseEnv, SEARCH_BINDING: nonObjectRow }),
  );

  const badTotal: D1RuntimeDatabase = {
    prepare: () => stubPrepared({ success: true, results: [{ article_id: CONSTITUTION_ID, relevance_score: 1, original_published_at: null }] }),
  };
  await assert.rejects(
    () => searchCclMetasearchWithEnv(searchInput({ query: "constitution" }), { ...baseEnv, SEARCH_BINDING: badTotal }),
  );
});

test("search fails closed when a D1 binding is not configured", async () => {
  await assert.rejects(
    () =>
      searchCclMetasearchWithEnv(searchInput({ query: "constitution" }), {
        PUBLIC_SITE_BASE_URL: "https://worldcons.vercel.app",
      }),
    /not configured/u,
  );
});

// --- D1 fixture -----------------------------------------------------------------

const CONSTITUTION_ID = "11111111-1111-4111-8111-111111111111";
const PRIVACY_ID = "22222222-2222-4222-8222-222222222222";
const EXPRESSION_ID = "33333333-3333-4333-8333-333333333333";
const TAG_ID = "eeeeeeee-0000-0000-0000-000000000001";

interface FixtureRow {
  articleId: string;
  versionId: string;
  publicationId: string;
  slug: string;
  sourceKey: string;
  jurisdiction: string;
  institutionName: string;
  language: string;
  originalTitle: string;
  koreanTitle: string | null;
  publishedAt: string;
  summaryJson: string;
  sourceMetadata: string;
  searchTitle: string;
  caseNumbers: string;
  searchText: string;
  tagsText: string;
}

const FIXTURE_ROWS: FixtureRow[] = [
  {
    articleId: CONSTITUTION_ID,
    versionId: "aaaa1111-1111-4111-8111-111111111111",
    publicationId: "bbbb1111-1111-4111-8111-111111111111",
    slug: "constitution-day",
    sourceKey: "us-scotus",
    jurisdiction: "United States",
    institutionName: "Supreme Court of the United States",
    language: "en",
    originalTitle: "Constitution Day",
    koreanTitle: "헌법의 날",
    publishedAt: "2026-01-01T00:00:00.000Z",
    summaryJson: '{"summary":{"coreSummary":["첫 번째 요약","두 번째 요약"]},"tags":["헌법"],"categories":["기본권"]}',
    sourceMetadata: '{"caseNumber":"2026-1000"}',
    searchTitle: "constitution day",
    caseNumbers: "2026-1000",
    searchText: "constitution constitution constitution alpha",
    tagsText: "constitution",
  },
  {
    articleId: PRIVACY_ID,
    versionId: "aaaa2222-2222-4222-8222-222222222222",
    publicationId: "bbbb2222-2222-4222-8222-222222222222",
    slug: "privacy-ruling",
    sourceKey: "de-bverfg",
    jurisdiction: "Germany",
    institutionName: "Bundesverfassungsgericht",
    language: "de",
    originalTitle: "Privacy Ruling",
    koreanTitle: null,
    publishedAt: "2026-06-01T00:00:00.000Z",
    summaryJson: '{"summary":{"coreSummary":["독일 판결 요약"]}}',
    sourceMetadata: "{}",
    searchTitle: "privacy ruling",
    caseNumbers: "",
    searchText: "constitution beta gamma delta",
    tagsText: "",
  },
  {
    articleId: EXPRESSION_ID,
    versionId: "aaaa3333-3333-4333-8333-333333333333",
    publicationId: "bbbb3333-3333-4333-8333-333333333333",
    slug: "free-expression",
    sourceKey: "fr-conseil-constitutionnel",
    jurisdiction: "France",
    institutionName: "Conseil constitutionnel",
    language: "fr",
    originalTitle: "Free Expression",
    koreanTitle: "표현의 자유",
    publishedAt: "2026-09-01T00:00:00.000Z",
    summaryJson: '{"summary":{"coreSummary":["표현의 자유 요약"]}}',
    sourceMetadata: "{}",
    searchTitle: "free expression 표현의 자유",
    caseNumbers: "",
    searchText: "표현의 자유 freedom",
    tagsText: "",
  },
];

function d1Fixture(): { core: DatabaseSync; search: DatabaseSync } {
  const core = new DatabaseSync(":memory:");
  core.exec(emitDatabaseDdl("worldcons_core", d1Schema));
  const search = new DatabaseSync(":memory:");
  search.exec(emitDatabaseDdl("worldcons_search", d1Schema));

  core
    .prepare(
      "insert into tags (id, slug, name, normalized_name, type, article_count, created_at, updated_at) values (?, ?, ?, ?, ?, 0, ?, ?)",
    )
    .run(TAG_ID, "constitution", "Constitution", "constitution", "topic", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");

  const insertVersion = core.prepare(
    [
      "insert into article_content_versions_p3 (",
      "id, article_id, revision, content_hash, provenance_actor_type, slug, source_key, jurisdiction,",
      "institution_name, content_type, original_url, canonical_url, original_language, original_title,",
      "korean_title, original_published_at, discovered_at, fetched_at, summarized_at, summary_json,",
      "source_metadata, created_at",
      ") values (?, ?, '1', ?, 'import', ?, ?, ?, ?, 'decision', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ].join(" "),
  );
  const insertPublication = core.prepare(
    [
      "insert into article_publications_p3 (",
      "id, article_id, state, version_id, revision, decided_by_type, reason, created_at, updated_at",
      ") values (?, ?, 'published', ?, '1', 'system', 'test', ?, ?)",
    ].join(" "),
  );
  const insertArticleTag = core.prepare(
    "insert into article_tags (article_id, tag_id, confidence, created_at) values (?, ?, ?, ?)",
  );
  const insertDocument = search.prepare(
    [
      "insert into search_documents (",
      "article_id, jurisdiction, source_key, language, content_type, publication_state, review_state,",
      "original_published_at, display_title, case_numbers, search_text, tags_text, projection_version, checksum, updated_at",
      ") values (?, ?, ?, ?, 'decision', 'published', null, ?, ?, ?, ?, ?, 1, ?, ?)",
    ].join(" "),
  );
  const insertFts = search.prepare(
    "insert into search_fts (article_id, title, case_numbers, search_text, tags_text) values (?, ?, ?, ?, ?)",
  );

  for (const row of FIXTURE_ROWS) {
    const created = "2026-01-01T00:00:00.000Z";
    insertVersion.run(
      row.versionId,
      row.articleId,
      `${row.articleId}-hash`,
      row.slug,
      row.sourceKey,
      row.jurisdiction,
      row.institutionName,
      row.originalTitle.toLowerCase().replace(/\s+/gu, "-"),
      `https://example.test/${row.slug}`,
      row.language,
      row.originalTitle,
      row.koreanTitle,
      row.publishedAt,
      created,
      created,
      created,
      row.summaryJson,
      row.sourceMetadata,
      created,
    );
    insertPublication.run(row.publicationId, row.articleId, row.versionId, created, created);
    if (row.articleId === CONSTITUTION_ID) {
      insertArticleTag.run(row.articleId, TAG_ID, 0.9, created);
    }
    insertDocument.run(
      row.articleId,
      row.jurisdiction,
      row.sourceKey,
      row.language,
      row.publishedAt,
      row.koreanTitle ?? row.originalTitle,
      row.caseNumbers,
      row.searchText,
      row.tagsText,
      `${row.articleId}-checksum`,
      created,
    );
    insertFts.run(row.articleId, row.searchTitle, row.caseNumbers, row.searchText, row.tagsText);
  }

  return { core, search };
}

function searchInput(overrides: Partial<CclMetasearchSearchInput> = {}): CclMetasearchSearchInput {
  return { query: "constitution", limit: 10, offset: 0, sort: "relevance", ...overrides };
}

function fixtureEnv(core: DatabaseSync, search: DatabaseSync) {
  return {
    PUBLIC_SITE_BASE_URL: "https://worldcons.vercel.app",
    CORE_BINDING: localBinding(core),
    SEARCH_BINDING: localBinding(search),
  };
}

function localBinding(db: DatabaseSync): D1RuntimeDatabase {
  return {
    prepare(sql: string): D1RuntimePreparedStatement {
      const statement = db.prepare(sql);
      let bound: SQLInputValue[] = [];
      const chain: D1RuntimePreparedStatement = {
        bind(...values: unknown[]) {
          bound = values as SQLInputValue[];
          return chain;
        },
        async all<T = Record<string, unknown>>() {
          try {
            return { success: true, results: statement.all(...bound) as unknown as T[] };
          } catch (error) {
            return { success: false, error: error instanceof Error ? error.message : String(error) };
          }
        },
      };
      return chain;
    },
  };
}

function stubPrepared(result: {
  success?: boolean;
  results?: unknown;
  error?: string | null;
}): D1RuntimePreparedStatement {
  const chain: D1RuntimePreparedStatement = {
    bind() {
      return chain;
    },
    async all<T = Record<string, unknown>>() {
      return result as { success?: boolean; results?: T[]; error?: string | null };
    },
  };
  return chain;
}

// --- Existing shared helpers ----------------------------------------------------

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
