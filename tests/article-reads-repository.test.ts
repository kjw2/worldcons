import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getArticleBySlug,
  getArticlePreviewBySlug,
  getArticleSourceTextBySlug,
  listArticles,
} from "../lib/db/queries";
import { mockArticles } from "../lib/db/mock-data";
import { articleReads } from "../lib/article-reads";
import { mockArticleReads } from "../lib/article-reads/mock-repository";
import {
  ARTICLE_DETAIL_SELECT,
  ARTICLE_LIST_SELECT,
  ARTICLE_LIST_WITH_TAG_FILTER_SELECT,
  ARTICLE_P3_DETAIL_SELECT,
  ARTICLE_P3_LIST_SELECT,
  ARTICLE_V4_DETAIL_SELECT,
  ARTICLE_V4_LIST_SELECT,
} from "../lib/article-reads/shared";
import { createSupabaseArticleReadRepository } from "../lib/article-reads/supabase-repository";
import { ArtifactBlobStore, type ArtifactBlobTransport } from "../lib/storage/blob";
import {
  ARTICLE_RAW_BLOB_CONTRACT_VERSION,
  articleRawBlobStorageRef,
  encodeArticleRawText,
} from "../lib/article-raw/codec";

const ENV_KEYS = [
  "SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "ADMIN_PUBLICATION_V4_READ_ENABLED",
  "CASE_CATALOG_PUBLIC_ENABLED",
] as const;

async function withSupabaseEnv<T>(
  values: Partial<Record<(typeof ENV_KEYS)[number], string>>,
  run: () => Promise<T> | T,
): Promise<T> {
  const original = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
  try {
    return await run();
  } finally {
    for (const key of ENV_KEYS) {
      const value = original.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

interface QueryInfo {
  table: string;
  select?: unknown[];
  selectOptions?: unknown;
  eqs: Array<[string, unknown]>;
  filters: unknown[][];
  orders: Array<[string, unknown?]>;
  ins: Array<[string, unknown]>;
  contains: unknown[][];
  gtes: Array<[string, unknown]>;
  textSearches: Array<[string, string, unknown?]>;
  limits: unknown[];
  ranges: Array<[number, number]>;
  maybeSingleCalls: number;
}

interface TableResult {
  data?: unknown;
  error?: { message: string } | null;
  count?: number | null;
}

function createFakeSupabase(options: { tables?: Record<string, (info: QueryInfo) => TableResult> } = {}) {
  const tableCalls: QueryInfo[] = [];

  const client = {
    from(table: string) {
      const info: QueryInfo = {
        table,
        eqs: [],
        filters: [],
        orders: [],
        ins: [],
        contains: [],
        gtes: [],
        textSearches: [],
        limits: [],
        ranges: [],
        maybeSingleCalls: 0,
      };
      const builder: Record<string, unknown> = {};
      const resolve = (): TableResult => {
        tableCalls.push(info);
        const handler = options.tables?.[info.table];
        return handler ? handler(info) : { data: [], error: null };
      };
      builder.select = (...args: unknown[]) => { info.select = args; info.selectOptions = args[1]; return builder; };
      builder.eq = (column: string, value: unknown) => { info.eqs.push([column, value]); return builder; };
      builder.filter = (...args: unknown[]) => { info.filters.push(args); return builder; };
      builder.order = (column: string, opts?: unknown) => { info.orders.push([column, opts]); return builder; };
      builder.in = (column: string, values: unknown) => { info.ins.push([column, values]); return builder; };
      builder.contains = (column: string, value: unknown) => { info.contains.push([column, value]); return builder; };
      builder.gte = (column: string, value: unknown) => { info.gtes.push([column, value]); return builder; };
      builder.textSearch = (column: string, query: string, opts?: unknown) => { info.textSearches.push([column, query, opts]); return builder; };
      builder.limit = (count: unknown) => { info.limits.push(count); return builder; };
      builder.range = (from: number, to: number) => { info.ranges.push([from, to]); return builder; };
      builder.maybeSingle = () => { info.maybeSingleCalls += 1; return Promise.resolve(resolve()); };
      builder.then = (onFulfilled: (value: TableResult) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve(resolve()).then(onFulfilled, onRejected);
      return builder;
    },
  };

  return { client: client as unknown as SupabaseClient, tableCalls };
}

const MOCK_SUMMARIZED = mockArticles.filter((article) => article.status === "summarized");

function listRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "article-1",
    slug: "case-1",
    source_key: "us-scotus",
    jurisdiction: "United States",
    institution_name: "SCOTUS",
    content_type: "opinion",
    original_url: "https://example.test/case-1",
    canonical_url: "https://example.test/case-1",
    original_language: "en",
    original_title: "Original Title",
    korean_title: "한국어 제목",
    original_published_at: "2026-04-29T00:00:00.000Z",
    status: "summarized",
    one_line_summary: null,
    article_tags: [],
    ...overrides,
  };
}

const TAG_ROW = {
  id: "tag-1",
  slug: "first-amendment",
  name: "First Amendment",
  normalized_name: "First Amendment",
  type: "article",
  description: null,
  article_count: 1,
  latest_article_at: "2026-04-29T00:00:00.000Z",
};

const SUMMARY = {
  koreanTitle: "요약 제목",
  originalTitle: "Original Title",
  summary: {
    coreSummary: ["핵심 요약"],
    referencedProvisions: [],
    background: "배경",
    caseStructure: "구조",
    implications: "시사점",
    practicalNotes: "참고",
  },
  entities: [],
  tags: [],
  categories: ["decision"],
  riskFlags: [],
};

function detailRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "article-1",
    slug: "case-1",
    source_key: "us-scotus",
    jurisdiction: "United States",
    institution_name: "SCOTUS",
    content_type: "opinion",
    original_url: "https://example.test/case-1",
    canonical_url: "https://example.test/case-1",
    original_language: "en",
    original_title: "Original Title",
    korean_title: "한국어 제목",
    original_published_at: "2026-04-29T00:00:00.000Z",
    discovered_at: "2026-05-08T00:00:00.000Z",
    fetched_at: "2026-05-08T00:10:00.000Z",
    summarized_at: "2026-05-08T00:20:00.000Z",
    status: "summarized",
    raw_text: "inline raw text",
    cleaned_text: "cleaned text",
    content_hash: "hash-1",
    summary_json: SUMMARY,
    one_line_summary: null,
    source_metadata: { collection: { publishable: true } },
    resolution_type: "opinion",
    case_number: "24-781",
    error_metadata: { kind: "none" },
    article_tags: [{ confidence: 0.9, tags: TAG_ROW }],
    enrichment_status: "full",
    enrichment_freshness: "current",
    summary_status: "available",
    raw_text_storage_ref: null,
    raw_text_blob_hash: null,
    raw_text_blob_size: null,
    raw_text_externalized_at: null,
    raw_text_blob_contract_version: null,
    ...overrides,
  };
}

test("articleReads selects the mock adapter and preserves mock fallback without Supabase config", async () => {
  await withSupabaseEnv({}, async () => {
    assert.equal(articleReads(), mockArticleReads, "absent config must select the mock adapter");

    const summarized = mockArticles.find((article) => article.status === "summarized");
    assert.ok(summarized, "mock corpus must keep a summarized article");

    assert.deepEqual(await articleReads().getArticleBySelect(summarized.slug, "detail"), summarized);
    assert.deepEqual(await articleReads().getArticleBySelect(summarized.slug, "list"), summarized, "mock detail fetch ignores the select kind");
    assert.deepEqual(await getArticleBySlug(summarized.slug), summarized, "exported getArticleBySlug must keep the mock fallback");
    assert.deepEqual(await getArticlePreviewBySlug(summarized.slug), summarized, "exported getArticlePreviewBySlug must keep the mock fallback");
    assert.equal(await getArticleBySlug("missing-article"), null);
    assert.equal(await getArticlePreviewBySlug("missing-article"), null);

    const expectedSourceText = {
      slug: summarized.slug,
      sourceKey: summarized.sourceKey,
      sourceMetadata: summarized.sourceMetadata ?? null,
      officialUrl: summarized.originalUrl,
      cleanedText: summarized.cleanedText ?? null,
      contentHash: summarized.contentHash ?? null,
    };
    assert.deepEqual(await articleReads().getArticleSourceTextBySlug(summarized.slug), expectedSourceText);
    assert.deepEqual(await getArticleSourceTextBySlug(summarized.slug), expectedSourceText);
    assert.equal(await articleReads().getArticleSourceTextBySlug("missing-article"), null);
  });
});

test("Supabase adapter maps the detail row and applies the legacy published filter", async () => {
  const fake = createFakeSupabase({ tables: { articles: () => ({ data: detailRow(), error: null }) } });
  const repository = createSupabaseArticleReadRepository({ client: () => fake.client, environment: {} });

  assert.deepEqual(await repository.getArticleBySelect("case-1", "detail"), {
    id: "article-1",
    slug: "case-1",
    sourceKey: "us-scotus",
    jurisdiction: "United States",
    institutionName: "SCOTUS",
    contentType: "opinion",
    originalUrl: "https://example.test/case-1",
    canonicalUrl: "https://example.test/case-1",
    originalLanguage: "en",
    originalTitle: "Original Title",
    koreanTitle: "한국어 제목",
    originalPublishedAt: "2026-04-29T00:00:00.000Z",
    discoveredAt: "2026-05-08T00:00:00.000Z",
    fetchedAt: "2026-05-08T00:10:00.000Z",
    summarizedAt: "2026-05-08T00:20:00.000Z",
    status: "summarized",
    caseNumber: "24-781",
    summaryJson: SUMMARY,
    tags: [{
      id: "tag-1",
      slug: "first-amendment",
      name: "First Amendment",
      normalizedName: "First Amendment",
      type: "article",
      description: null,
      articleCount: 1,
      latestArticleAt: "2026-04-29T00:00:00.000Z",
      confidence: 0.9,
    }],
    sourceMetadata: { collection: { publishable: true } },
    oneLineSummary: "핵심 요약",
    viewCount: 0,
    enrichmentStatus: "full",
    enrichmentFreshness: "current",
    summaryStatus: "available",
    summaryAvailable: true,
    rawText: "inline raw text",
    cleanedText: "cleaned text",
    contentHash: "hash-1",
    errorMetadata: { kind: "none" },
    rawTextBlob: null,
  });

  assert.deepEqual(fake.tableCalls.map((call) => call.table), ["articles"]);
  const call = fake.tableCalls[0];
  assert.equal(call.select?.[0], ARTICLE_DETAIL_SELECT);
  assert.deepEqual(call.eqs, [["slug", "case-1"], ["status", "summarized"], ["catalog_ai_stale_v4", false]]);
  assert.deepEqual(call.filters, [["source_metadata->collection->>publishable", "eq", "true"]]);
  assert.equal(call.maybeSingleCalls, 1);
});

test("Supabase adapter switches the projection and detail-v4 relation/select by flag", async () => {
  const projected = createFakeSupabase({ tables: { public_article_projection_p3: () => ({ data: detailRow(), error: null }) } });
  const projectedRepository = createSupabaseArticleReadRepository({
    client: () => projected.client,
    environment: { ADMIN_PUBLICATION_V4_READ_ENABLED: "true" },
  });
  const projectedArticle = await projectedRepository.getArticleBySelect("case-1", "detail");
  assert.equal(projectedArticle?.slug, "case-1");
  assert.deepEqual(projected.tableCalls.map((call) => call.table), ["public_article_projection_p3"]);
  assert.equal(projected.tableCalls[0].select?.[0], ARTICLE_P3_DETAIL_SELECT);
  assert.equal(projected.tableCalls[0].filters.length, 0, "projection reads must not apply the legacy published filter");
  assert.ok(!projected.tableCalls[0].eqs.some(([column]) => column === "catalog_ai_stale_v4"));

  const v4 = createFakeSupabase({ tables: { public_article_detail_v4: () => ({ data: detailRow({ summary_available: undefined }), error: null }) } });
  const v4Repository = createSupabaseArticleReadRepository({
    client: () => v4.client,
    environment: { ADMIN_PUBLICATION_V4_READ_ENABLED: "true", CASE_CATALOG_PUBLIC_ENABLED: "true" },
  });
  const v4Article = await v4Repository.getArticleBySelect("case-1", "detail");
  assert.equal(v4Article?.summaryAvailable, true, "missing summary_available must fall back to the summary presence");
  assert.deepEqual(v4.tableCalls.map((call) => call.table), ["public_article_detail_v4"]);
  assert.equal(v4.tableCalls[0].select?.[0], ARTICLE_V4_DETAIL_SELECT);
  assert.equal(v4.tableCalls[0].filters.length, 0);

  const listFake = createFakeSupabase({ tables: { articles: () => ({ data: detailRow(), error: null }) } });
  const listRepository = createSupabaseArticleReadRepository({ client: () => listFake.client, environment: {} });
  const listArticle = await listRepository.getArticleBySelect("case-1", "list");
  assert.equal(listFake.tableCalls[0].select?.[0], ARTICLE_LIST_SELECT);
  assert.equal(listArticle?.summaryJson, null, "the list projection must omit summary_json");
  assert.equal(listArticle?.rawText, undefined, "the list projection must omit detail fields");
  assert.equal(listArticle?.rawTextBlob, undefined);

  const v4ListFake = createFakeSupabase({ tables: { public_article_detail_v4: () => ({ data: detailRow(), error: null }) } });
  const v4ListRepository = createSupabaseArticleReadRepository({
    client: () => v4ListFake.client,
    environment: { ADMIN_PUBLICATION_V4_READ_ENABLED: "true", CASE_CATALOG_PUBLIC_ENABLED: "true" },
  });
  await v4ListRepository.getArticleBySelect("case-1", "list");
  assert.equal(v4ListFake.tableCalls[0].select?.[0], ARTICLE_V4_LIST_SELECT);

  const pageFake = createFakeSupabase({ tables: { articles: () => ({ data: detailRow(), error: null }) } });
  const pageRepository = createSupabaseArticleReadRepository({ client: () => pageFake.client, environment: {} });
  const pageArticle = await pageRepository.getArticleBySelect("case-1", "page");
  assert.equal(pageArticle?.summaryJson, SUMMARY, "the page projection must include summary_json");
  assert.equal(pageArticle?.rawText, undefined, "the page projection must omit detail-only fields");
});

test("Supabase adapter keeps the publishability boundary for public reads", async () => {
  const unpublished = detailRow({ status: "needs_review", source_metadata: { collection: { publishable: false } } });
  const fake = createFakeSupabase({ tables: { articles: () => ({ data: unpublished, error: null }) } });
  const repository = createSupabaseArticleReadRepository({ client: () => fake.client, environment: {} });

  assert.equal(await repository.getArticleBySelect("case-1", "detail"), null, "non-publishable rows must stay private");

  const included = await repository.getArticleBySelect("case-1", "detail", { includeUnpublished: true });
  assert.equal(included?.slug, "case-1");
  assert.ok(!fake.tableCalls[1].eqs.some(([column]) => column === "status"), "includeUnpublished must skip the published filter");
  assert.equal(fake.tableCalls[1].filters.length, 0);

  const listRow = detailRow({ status: "needs_review", source_metadata: undefined });
  const listFake = createFakeSupabase({ tables: { articles: () => ({ data: listRow, error: null }) } });
  const listRepository = createSupabaseArticleReadRepository({ client: () => listFake.client, environment: {} });
  const listItem = await listRepository.getArticleBySelect("case-1", "list");
  assert.equal(listItem?.slug, "case-1", "a row without source_metadata must skip the publishability post-filter");

  const missing = createFakeSupabase({ tables: { articles: () => ({ data: null, error: null }) } });
  const missingRepository = createSupabaseArticleReadRepository({ client: () => missing.client, environment: {} });
  assert.equal(await missingRepository.getArticleBySelect("case-1", "detail"), null);

  const failing = createFakeSupabase({ tables: { articles: () => ({ data: null, error: { message: "detail unavailable" } }) } });
  const failingRepository = createSupabaseArticleReadRepository({ client: () => failing.client, environment: {} });
  await assert.rejects(() => failingRepository.getArticleBySelect("case-1", "detail"), /detail unavailable/);
});

test("Supabase adapter maps the source-text snapshot and filters publishability", async () => {
  const row = {
    slug: "case-1",
    status: "summarized",
    source_key: "us-scotus",
    source_metadata: { collection: { publishable: true } },
    original_url: "https://example.test/case-1",
    cleaned_text: "clean text",
    content_hash: "hash-1",
  };
  const fake = createFakeSupabase({ tables: { articles: () => ({ data: row, error: null }) } });
  const repository = createSupabaseArticleReadRepository({ client: () => fake.client, environment: {} });

  assert.deepEqual(await repository.getArticleSourceTextBySlug("case-1"), {
    slug: "case-1",
    sourceKey: "us-scotus",
    sourceMetadata: { collection: { publishable: true } },
    officialUrl: "https://example.test/case-1",
    cleanedText: "clean text",
    contentHash: "hash-1",
  });
  const call = fake.tableCalls[0];
  assert.equal(call.select?.[0], "slug,status,source_key,source_metadata,original_url,cleaned_text,content_hash");
  assert.deepEqual(call.eqs, [["slug", "case-1"], ["status", "summarized"], ["catalog_ai_stale_v4", false]]);
  assert.deepEqual(call.filters, [["source_metadata->collection->>publishable", "eq", "true"]]);

  const projectedFake = createFakeSupabase({ tables: { public_article_projection_p3: () => ({ data: row, error: null }) } });
  const projectedRepository = createSupabaseArticleReadRepository({
    client: () => projectedFake.client,
    environment: { ADMIN_PUBLICATION_V4_READ_ENABLED: "true" },
  });
  assert.equal((await projectedRepository.getArticleSourceTextBySlug("case-1"))?.cleanedText, "clean text");
  assert.equal(projectedFake.tableCalls[0].table, "public_article_projection_p3");
  assert.equal(projectedFake.tableCalls[0].filters.length, 0);

  const missing = createFakeSupabase({ tables: { articles: () => ({ data: null, error: null }) } });
  assert.equal(
    await createSupabaseArticleReadRepository({ client: () => missing.client, environment: {} }).getArticleSourceTextBySlug("case-1"),
    null,
  );

  const unpublishedRow = { ...row, status: "needs_review", source_metadata: { collection: { publishable: false } } };
  const unpublishedFake = createFakeSupabase({ tables: { articles: () => ({ data: unpublishedRow, error: null }) } });
  const unpublishedRepository = createSupabaseArticleReadRepository({ client: () => unpublishedFake.client, environment: {} });
  assert.equal(await unpublishedRepository.getArticleSourceTextBySlug("case-1"), null);
  assert.equal(
    (await unpublishedRepository.getArticleSourceTextBySlug("case-1", { includeUnpublished: true }))?.slug,
    "case-1",
  );

  const failing = createFakeSupabase({ tables: { articles: () => ({ data: null, error: { message: "source unavailable" } }) } });
  const failingRepository = createSupabaseArticleReadRepository({ client: () => failing.client, environment: {} });
  await assert.rejects(() => failingRepository.getArticleSourceTextBySlug("case-1"), /source unavailable/);
});

test("exported detail reads delegate to the configured adapter", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requests.push(String(input));
    return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  try {
    await withSupabaseEnv(
      { SUPABASE_URL: "https://article-reads.test.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-role-key" },
      async () => {
        assert.notEqual(articleReads(), mockArticleReads, "configured Supabase must select the Supabase adapter");
        assert.equal(await getArticleBySlug("case-1"), null);
        assert.equal(await getArticlePreviewBySlug("case-1"), null);
        assert.equal(await getArticleSourceTextBySlug("case-1"), null);
        assert.ok(
          requests.some((url) => url.includes("/rest/v1/articles")),
          "delegated detail reads must query the article relation",
        );
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("mock adapter preserves list ordering, filters, pagination, and view counts without Supabase config", async () => {
  await withSupabaseEnv({}, async () => {
    assert.equal(articleReads(), mockArticleReads, "absent config must select the mock adapter");

    const expectedOrder = [...MOCK_SUMMARIZED]
      .sort((a, b) => (b.originalPublishedAt || "").localeCompare(a.originalPublishedAt || ""))
      .map((article) => article.slug);
    assert.equal(expectedOrder.length, 3, "the mock corpus must keep three summarized articles");

    const all = await listArticles({});
    assert.deepEqual(all.items.map((item) => item.slug), expectedOrder, "mock list reads must sort by published date");
    assert.equal(all.pageInfo.page, 1);
    assert.equal(all.pageInfo.pageSize, 20);
    assert.equal(all.pageInfo.total, expectedOrder.length);
    assert.equal(all.pageInfo.hasMore, false);
    assert.equal(all.pageInfo.totalIsExact, true);
    assert.ok(all.items.every((item) => item.viewCount === 0), "mock list reads must default view counts to zero");

    assert.deepEqual(
      await listArticles({}),
      await mockArticleReads.listArticles({}),
      "the exported listArticles must delegate to the mock adapter",
    );

    const usArticle = MOCK_SUMMARIZED.find((article) => article.sourceKey === "us-scotus");
    const franceArticle = MOCK_SUMMARIZED.find((article) => article.sourceKey === "fr-conseil-constitutionnel");
    const germanyArticle = MOCK_SUMMARIZED.find((article) => article.jurisdiction === "Germany");
    assert.ok(usArticle && franceArticle && germanyArticle);

    assert.deepEqual((await listArticles({ tag: "first-amendment" })).items.map((item) => item.slug), [usArticle.slug]);
    assert.deepEqual((await listArticles({ source: "fr-conseil-constitutionnel" })).items.map((item) => item.slug), [franceArticle.slug]);
    assert.deepEqual((await listArticles({ jurisdiction: "Germany" })).items.map((item) => item.slug), [germanyArticle.slug]);
    assert.deepEqual((await listArticles({ q: "First Amendment" })).items.map((item) => item.slug), [usArticle.slug]);

    const firstPage = await listArticles({ page: 1, pageSize: 2 });
    assert.equal(firstPage.pageInfo.hasMore, true);
    assert.deepEqual(firstPage.items.map((item) => item.slug), expectedOrder.slice(0, 2));

    const secondPage = await listArticles({ page: 2, pageSize: 2 });
    assert.equal(secondPage.pageInfo.page, 2);
    assert.equal(secondPage.pageInfo.pageSize, 2);
    assert.equal(secondPage.pageInfo.hasMore, false);
    assert.deepEqual(secondPage.items.map((item) => item.slug), [expectedOrder[2]]);

    const withoutViews = await listArticles({ includeViewCounts: false });
    assert.equal(withoutViews.items[0].viewCount, undefined, "includeViewCounts false must skip the mock view-count default");

    assert.deepEqual(await listArticles({ ids: [] }), {
      items: [],
      pageInfo: { page: 1, pageSize: 20, total: 0, hasMore: false, totalIsExact: true },
    });
  });
});

test("Supabase adapter preserves list select, filters, ordering, count, and pagination", async () => {
  const fake = createFakeSupabase({
    tables: {
      articles: () => ({
        data: [listRow({ id: "a", slug: "a" }), listRow({ id: "b", slug: "b" }), listRow({ id: "c", slug: "c" })],
        error: null,
        count: 42,
      }),
      article_view_counts: () => ({ data: [{ article_slug: "a", view_count: 7 }], error: null }),
    },
  });
  const repository = createSupabaseArticleReadRepository({ client: () => fake.client, environment: {} });

  const firstPage = await repository.listArticles({ page: 1, pageSize: 2 });
  assert.deepEqual(firstPage.items.map((item) => item.id), ["a", "b"]);
  assert.equal(firstPage.items[0].viewCount, 7);
  assert.equal(firstPage.items[1].viewCount, 0);
  assert.equal(firstPage.pageInfo.hasMore, true);
  assert.equal(firstPage.pageInfo.total, 42);
  assert.equal(firstPage.pageInfo.totalIsExact, true);
  assert.equal(firstPage.items[0].summaryJson, null, "the list projection must not carry summary_json");

  const call = fake.tableCalls[0];
  assert.equal(call.select?.[0], ARTICLE_LIST_SELECT);
  assert.deepEqual(call.selectOptions, { count: "exact" });
  assert.deepEqual(call.eqs, [["status", "summarized"], ["catalog_ai_stale_v4", false]]);
  assert.deepEqual(call.filters, [["source_metadata->collection->>publishable", "eq", "true"]]);
  assert.deepEqual(call.orders, [
    ["original_published_at", { ascending: false, nullsFirst: false }],
    ["id", { ascending: true }],
  ]);
  assert.deepEqual(call.ranges, [[0, 2]]);
  assert.equal(fake.tableCalls[1].table, "article_view_counts");
  assert.deepEqual(fake.tableCalls[1].ins, [["article_slug", ["a", "b"]]]);

  const rangedFake = createFakeSupabase({
    tables: {
      articles: () => ({ data: [listRow({ id: "c", slug: "c" })], error: null }),
      article_view_counts: () => ({ data: [], error: null }),
    },
  });
  const rangedRepository = createSupabaseArticleReadRepository({ client: () => rangedFake.client, environment: {} });
  const ranged = await rangedRepository.listArticles({
    page: 2,
    pageSize: 2,
    count: "none",
    ids: ["c"],
    source: "de-bverfg",
    jurisdiction: "Germany",
    type: "decision",
    language: "de",
    range: "month",
  });
  assert.equal(ranged.pageInfo.page, 2);
  assert.equal(ranged.pageInfo.hasMore, false);
  assert.equal(ranged.pageInfo.totalIsExact, false);
  assert.equal(ranged.pageInfo.total, 3);
  assert.equal(ranged.items[0].viewCount, 0);

  const rangedCall = rangedFake.tableCalls[0];
  assert.equal(rangedCall.selectOptions, undefined, "count none must omit the count option");
  assert.deepEqual(rangedCall.ins, [["id", ["c"]]]);
  assert.deepEqual(rangedCall.eqs, [
    ["status", "summarized"],
    ["catalog_ai_stale_v4", false],
    ["source_key", "de-bverfg"],
    ["jurisdiction", "Germany"],
    ["content_type", "decision"],
    ["original_language", "de"],
  ]);
  assert.deepEqual(rangedCall.ranges, [[2, 4]]);
  assert.equal(rangedCall.gtes.length, 1);
  assert.equal(rangedCall.gtes[0][0], "original_published_at");
});

test("Supabase adapter preserves legacy and projected tag filtering", async () => {
  const legacyFake = createFakeSupabase({
    tables: {
      tags: () => ({ data: [{ id: "tag-1" }], error: null }),
      articles: () => ({ data: [listRow({ id: "a", slug: "a" })], error: null, count: 1 }),
      article_view_counts: () => ({ data: [], error: null }),
    },
  });
  const legacyRepository = createSupabaseArticleReadRepository({ client: () => legacyFake.client, environment: {} });
  const legacy = await legacyRepository.listArticles({ tag: "first-amendment" });
  assert.deepEqual(legacy.items.map((item) => item.slug), ["a"]);

  const tagsCalls = legacyFake.tableCalls.filter((call) => call.table === "tags");
  assert.equal(tagsCalls.length, 2, "the legacy tag filter must resolve ids by slug and by name");
  assert.deepEqual(tagsCalls.map((call) => call.eqs), [
    [["slug", "first-amendment"]],
    [["name", "first-amendment"]],
  ]);
  const legacyArticleCall = legacyFake.tableCalls.find((call) => call.table === "articles");
  assert.ok(legacyArticleCall);
  assert.equal(legacyArticleCall.select?.[0], ARTICLE_LIST_WITH_TAG_FILTER_SELECT);
  assert.deepEqual(legacyArticleCall.ins, [["article_tag_filter.tag_id", ["tag-1"]]]);

  const projectedFake = createFakeSupabase({
    tables: {
      public_article_projection_p3: () => ({ data: [listRow({ id: "a", slug: "a" })], error: null, count: 1 }),
      article_view_counts: () => ({ data: [], error: null }),
    },
  });
  const projectedRepository = createSupabaseArticleReadRepository({
    client: () => projectedFake.client,
    environment: { ADMIN_PUBLICATION_V4_READ_ENABLED: "true" },
  });
  const projected = await projectedRepository.listArticles({ tag: "first-amendment" });
  assert.deepEqual(projected.items.map((item) => item.slug), ["a"]);
  assert.equal(
    projectedFake.tableCalls.some((call) => call.table === "tags"),
    false,
    "the projected tag filter must not resolve tag ids",
  );
  const projectedCall = projectedFake.tableCalls.find((call) => call.table === "public_article_projection_p3");
  assert.ok(projectedCall);
  assert.equal(projectedCall.select?.[0], ARTICLE_P3_LIST_SELECT);
  assert.deepEqual(projectedCall.contains, [["article_tags", JSON.stringify([{ tags: { slug: "first-amendment" } }])]]);
  assert.equal(projectedCall.filters.length, 0, "projected reads must not apply the legacy published filter");
});

test("Supabase adapter returns an empty page when a tag filter resolves to no ids", async () => {
  const fake = createFakeSupabase({ tables: { tags: () => ({ data: [], error: null }) } });
  const repository = createSupabaseArticleReadRepository({ client: () => fake.client, environment: {} });

  assert.deepEqual(await repository.listArticles({ tag: "missing-tag" }), {
    items: [],
    pageInfo: { page: 1, pageSize: 20, total: 0, hasMore: false, totalIsExact: true },
  });
  assert.deepEqual(fake.tableCalls.map((call) => call.table), ["tags", "tags"]);
});

test("Supabase adapter preserves the full-text fallback and its error semantics", async () => {
  await withSupabaseEnv({}, async () => {
    const fake = createFakeSupabase({
      tables: {
        articles: (info) => info.select?.[0] === "id"
          ? { data: [{ id: "a1" }, { id: "a2" }], error: null }
          : { data: [listRow({ id: "a1", slug: "a1" }), listRow({ id: "a2", slug: "a2" })], error: null, count: 2 },
        article_view_counts: () => ({ data: [{ article_slug: "a1", view_count: 5 }], error: null }),
      },
    });
    const repository = createSupabaseArticleReadRepository({ client: () => fake.client, environment: {} });

    const result = await repository.listArticles({ q: "표현 자유", pageSize: 2 });
    assert.deepEqual(result.items.map((item) => item.slug), ["a1", "a2"]);
    assert.equal(result.items[0].viewCount, 5);
    assert.equal(result.items[1].viewCount, 0);
    assert.deepEqual(result.pageInfo, { page: 1, pageSize: 2, total: 2, hasMore: false, totalIsExact: true });

    const candidateCall = fake.tableCalls.find((call) => call.select?.[0] === "id");
    assert.ok(candidateCall);
    assert.deepEqual(candidateCall.textSearches, [["search_vector", "표현:* & 자유:*", { config: "simple" }]]);
    assert.deepEqual(candidateCall.limits, [200]);
    assert.deepEqual(candidateCall.eqs, [["status", "summarized"], ["catalog_ai_stale_v4", false]]);
    assert.deepEqual(candidateCall.orders, [
      ["original_published_at", { ascending: false, nullsFirst: false }],
      ["id", { ascending: true }],
    ]);

    const noTerms = await repository.listArticles({ q: "!!!" });
    assert.deepEqual(noTerms, { items: [], pageInfo: { page: 1, pageSize: 20, total: 0, hasMore: false, totalIsExact: true } });

    const failing = createFakeSupabase({
      tables: {
        articles: (info) => info.select?.[0] === "id"
          ? { data: null, error: { message: "search unavailable" } }
          : { data: [], error: null },
      },
    });
    const failingRepository = createSupabaseArticleReadRepository({ client: () => failing.client, environment: {} });
    assert.deepEqual(await failingRepository.listArticles({ q: "표현 자유" }), {
      items: [],
      pageInfo: { page: 1, pageSize: 20, total: 0 },
    });
  });
});

test("exported listArticles uses the ranked full-text path and preserves ranked ordering", async () => {
  const originalFetch = globalThis.fetch;
  const rankedRows = [listRow({ id: "a", slug: "a" }), listRow({ id: "b", slug: "b" })];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (url.includes("/rest/v1/rpc/worldcons_ranked_search_page_v1")) {
      return json({ entries: [{ id: "b" }, { id: "a" }], retrievalMode: "fulltext", total: 2, hasMore: false, totalIsExact: true });
    }
    if (url.includes("/rest/v1/public_article_projection_p3")) return json(rankedRows);
    if (url.includes("/rest/v1/article_view_counts")) return json([]);
    return json([]);
  }) as typeof fetch;

  try {
    await withSupabaseEnv(
      {
        SUPABASE_URL: "https://ranked.test.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
        ADMIN_PUBLICATION_V4_READ_ENABLED: "true",
      },
      async () => {
        const result = await listArticles({ q: "표현 자유", page: 1, pageSize: 10 });
        assert.deepEqual(result.items.map((item) => item.id), ["b", "a"], "ranked ids must define the item order");
        assert.deepEqual(result.pageInfo, { page: 1, pageSize: 10, total: 2, hasMore: false, totalIsExact: true });
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function blobTransport(bytes: Buffer): ArtifactBlobTransport {
  return {
    async put(pathname) {
      return { pathname };
    },
    async get() {
      return {
        statusCode: 200,
        stream: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(bytes));
            controller.close();
          },
        }),
        size: bytes.byteLength,
      };
    },
    async head(pathname) {
      return { pathname, size: bytes.byteLength };
    },
  };
}

test("raw-text hydration stays at the query boundary and only runs for detail reads", async () => {
  const encoded = encodeArticleRawText("hydrated blob text");
  const storageRef = articleRawBlobStorageRef("us-scotus", encoded.sha256);
  const transport = blobTransport(encoded.bytes);
  const blobRow = detailRow({
    slug: "case-blob",
    raw_text: null,
    raw_text_storage_ref: storageRef,
    raw_text_blob_hash: encoded.sha256,
    raw_text_blob_size: encoded.size,
    raw_text_externalized_at: "2026-09-19T00:00:00.000Z",
    raw_text_blob_contract_version: ARTICLE_RAW_BLOB_CONTRACT_VERSION,
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    assert.ok(String(input).includes("/rest/v1/articles"));
    return new Response(JSON.stringify([blobRow]), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  try {
    await withSupabaseEnv(
      { SUPABASE_URL: "https://article-reads.test.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-role-key" },
      async () => {
        const blobStore = new ArtifactBlobStore(transport);
        const hydrated = await getArticleBySlug("case-blob", {
          blobStore,
          environment: { ARTICLE_RAW_BLOB_READ_ENABLED: "true" },
        });
        assert.equal(hydrated?.rawText, "hydrated blob text", "the detail read must hydrate the externalized raw text");

        const pageRead = await getArticleBySlug("case-blob", {
          includeSourceText: false,
          blobStore,
          environment: { ARTICLE_RAW_BLOB_READ_ENABLED: "true" },
        });
        assert.equal(pageRead?.rawText, undefined, "the page read must not hydrate raw text");
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
