import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getArticleBySlug,
  getArticlePreviewBySlug,
  getArticleSourceTextBySlug,
} from "../lib/db/queries";
import { mockArticles } from "../lib/db/mock-data";
import { articleReads } from "../lib/article-reads";
import { mockArticleReads } from "../lib/article-reads/mock-repository";
import {
  ARTICLE_DETAIL_SELECT,
  ARTICLE_LIST_SELECT,
  ARTICLE_P3_DETAIL_SELECT,
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

const SUPABASE_ENV_KEYS = ["SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"] as const;

async function withSupabaseEnv<T>(
  values: Partial<Record<(typeof SUPABASE_ENV_KEYS)[number], string>>,
  run: () => Promise<T> | T,
): Promise<T> {
  const original = new Map(SUPABASE_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of SUPABASE_ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
  try {
    return await run();
  } finally {
    for (const key of SUPABASE_ENV_KEYS) {
      const value = original.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

interface QueryInfo {
  table: string;
  select?: unknown[];
  eqs: Array<[string, unknown]>;
  filters: unknown[][];
  orders: Array<[string, unknown?]>;
  maybeSingleCalls: number;
}

interface TableResult {
  data?: unknown;
  error?: { message: string } | null;
}

function createFakeSupabase(options: { tables?: Record<string, (info: QueryInfo) => TableResult> } = {}) {
  const tableCalls: QueryInfo[] = [];

  const client = {
    from(table: string) {
      const info: QueryInfo = { table, eqs: [], filters: [], orders: [], maybeSingleCalls: 0 };
      const builder: Record<string, unknown> = {};
      const resolve = (): TableResult => {
        tableCalls.push(info);
        const handler = options.tables?.[info.table];
        return handler ? handler(info) : { data: [], error: null };
      };
      builder.select = (...args: unknown[]) => { info.select = args; return builder; };
      builder.eq = (column: string, value: unknown) => { info.eqs.push([column, value]); return builder; };
      builder.filter = (...args: unknown[]) => { info.filters.push(args); return builder; };
      builder.order = (column: string, opts?: unknown) => { info.orders.push([column, opts]); return builder; };
      builder.maybeSingle = () => { info.maybeSingleCalls += 1; return Promise.resolve(resolve()); };
      builder.then = (onFulfilled: (value: TableResult) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve(resolve()).then(onFulfilled, onRejected);
      return builder;
    },
  };

  return { client: client as unknown as SupabaseClient, tableCalls };
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
