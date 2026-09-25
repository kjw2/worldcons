import assert from "node:assert/strict";
import test from "node:test";
import {
  D1_RUNTIME_BINDING_NAMES,
  type D1RuntimeDatabase,
  type D1RuntimePreparedStatement,
} from "../lib/cloudflare/d1/runtime-binding";
import { createD1ArticleReadRepository, D1ArticleShadowSkipError } from "../lib/article-reads/d1-repository";
import { articleRowToItem, type SupabaseArticleTagRow } from "../lib/article-reads/shared";
import { D1ShadowTruncatedError } from "../lib/reference-reads/d1-repository";
import type { SupabaseTagRow } from "../lib/reference-reads/shared";

/**
 * M6.3 D1 article-read adapter tests: shared-mapping parity, publishability,
 * bounded/truncated reads, tag hydration, sitemap precedence, view-count
 * ranking and related-id semantics. The fake D1 evaluates the guarded SQL the
 * runtime read runner emits (eq/neq/gte/in, order by, limit, offset).
 */

interface CapturedStatement {
  sql: string;
  params: unknown[];
  table: string;
}

const IDENT = "[a-z_][a-z0-9_]*";

function evaluate(sql: string, params: unknown[], tables: Record<string, Record<string, unknown>[]>) {
  const fromMatch = new RegExp(` from (${IDENT})`).exec(sql);
  const table = fromMatch?.[1] ?? "";
  let rows = (tables[table] ?? []).map((row) => ({ ...row }));
  let p = 0;

  const whereMatch = new RegExp(` where (.*?)(?= order by | limit | offset |$)`).exec(sql);
  if (whereMatch) {
    for (const predicate of whereMatch[1].split(" and ")) {
      const inMatch = new RegExp(`^(${IDENT}) in \\(([?](, \\?)*)\\)$`).exec(predicate);
      const cmpMatch = new RegExp(`^(${IDENT}) (=|>=|!=) \\?$`).exec(predicate);
      if (inMatch) {
        const values = params.slice(p, p + inMatch[2].split(",").length);
        p += values.length;
        const column = inMatch[1];
        rows = rows.filter((row) => values.includes(row[column]));
      } else if (cmpMatch) {
        const value = params[p];
        p += 1;
        const [, column, op] = cmpMatch;
        rows = rows.filter((row) => {
          if (op === "=") return row[column] === value;
          if (op === "!=") return row[column] !== value;
          return row[column] != null && String(row[column]) >= String(value);
        });
      } else {
        throw new Error(`fake D1 cannot evaluate predicate: ${predicate}`);
      }
    }
  }

  const orderMatch = new RegExp(` order by (.*?)(?= limit | offset |$)`).exec(sql);
  if (orderMatch) {
    const clauses = orderMatch[1].split(", ").map((clause) => {
      const [column, direction, nulls, placement] = clause.split(" ");
      return { column, direction: direction ?? "asc", nulls: nulls === "nulls" ? placement : undefined };
    });
    rows.sort((left, right) => {
      for (const clause of clauses) {
        const a = left[clause.column] ?? null;
        const b = right[clause.column] ?? null;
        if (a === null || b === null) {
          if (a === null && b === null) continue;
          const nullLast = clause.nulls !== "first";
          return a === null ? (nullLast ? 1 : -1) : nullLast ? -1 : 1;
        }
        if (a === b) continue;
        const cmp = a < b ? -1 : 1;
        return clause.direction === "desc" ? -cmp : cmp;
      }
      return 0;
    });
  }

  const limit = / limit \?/.test(sql) ? Number(params[p++]) : undefined;
  const offset = / offset \?/.test(sql) ? Number(params[p++]) : 0;
  if (offset) rows = rows.slice(offset);
  if (limit !== undefined) rows = rows.slice(0, limit);
  return { table, rows };
}

function createFakeD1(tables: Record<string, Record<string, unknown>[]>) {
  const calls: CapturedStatement[] = [];
  const database: D1RuntimeDatabase = {
    prepare(sql: string): D1RuntimePreparedStatement {
      let params: unknown[] = [];
      const statement: D1RuntimePreparedStatement = {
        bind(...values: unknown[]) {
          params = values;
          return statement;
        },
        async all<T = Record<string, unknown>>() {
          const evaluated = evaluate(sql, params, tables);
          calls.push({ sql, params, table: evaluated.table });
          return { success: true, results: evaluated.rows as unknown as T[] };
        },
      };
      return statement;
    },
  };
  return { database, calls };
}

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

const TAG_ROW: SupabaseTagRow = {
  id: "tag-1",
  slug: "first-amendment",
  name: "First Amendment",
  normalized_name: "First Amendment",
  type: "article",
  description: null,
  article_count: 1,
  latest_article_at: "2026-04-29T00:00:00.000Z",
};

function d1Article(overrides: Record<string, unknown> = {}) {
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
    raw_text: null,
    cleaned_text: "cleaned text",
    content_hash: "hash-1",
    summary_json: SUMMARY,
    source_metadata: { collection: { publishable: true } },
    error_metadata: null,
    raw_text_storage_ref: null,
    raw_text_blob_hash: null,
    raw_text_blob_size: null,
    raw_text_externalized_at: null,
    raw_text_blob_contract_version: null,
    catalog_ai_stale_v4: 0,
    ...overrides,
  };
}

test("D1 article adapter reads worldcons_core and maps a detail row through the shared mapper", async () => {
  const fake = createFakeD1({
    articles: [d1Article()],
    article_tags: [{ article_id: "article-1", tag_id: "tag-1", confidence: 0.9 }],
    tags: [TAG_ROW as unknown as Record<string, unknown>],
  });
  const repository = createD1ArticleReadRepository({ binding: fake.database });

  const expected = articleRowToItem(
    {
      ...d1Article(),
      one_line_summary: "핵심 요약",
      resolution_type: null,
      case_number: null,
      article_tags: [{ confidence: 0.9, tags: TAG_ROW } as SupabaseArticleTagRow],
    },
    { includeSummaryJson: true, includeDetailFields: true },
  );

  assert.deepEqual(await repository.getArticleBySelect("case-1", "detail"), expected);
  const articleCall = fake.calls.find((call) => call.table === "articles");
  assert.ok(articleCall);
  assert.match(articleCall.sql, /from articles where slug = \? and status = \? and catalog_ai_stale_v4 = \? order by id limit \?/);
  assert.deepEqual(articleCall.params, ["case-1", "summarized", 0, 1]);
  assert.ok(fake.calls.some((call) => call.table === "article_tags"));
  assert.ok(fake.calls.some((call) => call.table === "tags"));
});

test("D1 article adapter list projection drops summary_json/source_metadata and computes aliases", async () => {
  const fake = createFakeD1({ articles: [d1Article()], article_tags: [], tags: [] });
  const repository = createD1ArticleReadRepository({ binding: fake.database });

  const row = await repository.getArticleBySelect("case-1", "list");
  assert.equal(row?.summaryJson, null, "list projection must omit summary_json");
  assert.equal(row?.rawText, undefined, "list projection must omit detail fields");
  assert.deepEqual(row?.sourceMetadata, null, "list projection must carry only the minimal source metadata");
  assert.equal(row?.oneLineSummary, "핵심 요약", "the one_line_summary alias must be computed from summary_json");
});

test("D1 article adapter enforces legacy public publishability and includeUnpublished", async () => {
  const unpublished = d1Article({
    id: "article-2",
    slug: "case-2",
    status: "needs_review",
    source_metadata: { collection: { publishable: false } },
  });
  const fake = createFakeD1({ articles: [unpublished], article_tags: [], tags: [] });
  const repository = createD1ArticleReadRepository({ binding: fake.database });

  assert.equal(await repository.getArticleBySelect("case-2", "detail"), null);
  assert.equal(await repository.getArticleSourceTextBySlug("case-2"), null);
  const included = await repository.getArticleBySelect("case-2", "detail", { includeUnpublished: true });
  assert.equal(included?.slug, "case-2", "includeUnpublished must bypass the public-only filters");

  const stringTrue = d1Article({ slug: "case-3", source_metadata: { collection: { publishable: "true" } } });
  const strictFake = createFakeD1({ articles: [stringTrue], article_tags: [], tags: [] });
  const strictRepository = createD1ArticleReadRepository({ binding: strictFake.database });
  assert.equal(await strictRepository.getArticleBySelect("case-3", "detail"), null, "the strict post-filter must reject textual true");
});

test("D1 article adapter source-text snapshot maps the legacy fields", async () => {
  const fake = createFakeD1({
    articles: [
      d1Article({
        source_key: "us-scotus",
        original_url: "https://example.test/case-1",
        cleaned_text: "clean text",
        content_hash: "hash-1",
      }),
    ],
  });
  const repository = createD1ArticleReadRepository({ binding: fake.database });
  assert.deepEqual(await repository.getArticleSourceTextBySlug("case-1"), {
    slug: "case-1",
    sourceKey: "us-scotus",
    sourceMetadata: { collection: { publishable: true } },
    officialUrl: "https://example.test/case-1",
    cleanedText: "clean text",
    contentHash: "hash-1",
  });
  assert.equal(await repository.getArticleSourceTextBySlug("missing"), null);
});

test("D1 article adapter listArticles preserves ordering, paging, count and view counts", async () => {
  const first = d1Article({ id: "a", slug: "a", original_published_at: "2026-04-30T00:00:00.000Z" });
  const second = d1Article({ id: "b", slug: "b", original_published_at: "2026-04-29T00:00:00.000Z" });
  const third = d1Article({ id: "c", slug: "c", original_published_at: null });
  const fake = createFakeD1({
    articles: [third, second, first],
    article_tags: [],
    tags: [],
    article_view_counts: [{ article_slug: "a", view_count: 7 }],
  });
  const repository = createD1ArticleReadRepository({ binding: fake.database });

  const result = await repository.listArticles({ page: 1, pageSize: 2 });
  assert.deepEqual(result.items.map((item) => item.slug), ["a", "b"], "published desc, nulls last");
  assert.equal(result.items[0].viewCount, 7);
  assert.equal(result.items[1].viewCount, 0);
  assert.equal(result.pageInfo.hasMore, true);
  assert.equal(result.pageInfo.total, 3);
  assert.equal(result.pageInfo.totalIsExact, true);

  const lastPage = await repository.listArticles({ page: 2, pageSize: 2 });
  assert.deepEqual(lastPage.items.map((item) => item.slug), ["c"]);
  assert.equal(lastPage.pageInfo.hasMore, false);

  const noViews = await repository.listArticles({ pageSize: 5, includeViewCounts: false });
  assert.deepEqual(noViews.items.map((item) => item.viewCount), [0, 0, 0], "the shared mapper still defaults viewCount to zero");

  const none = await repository.listArticles({ page: 1, pageSize: 2, count: "none" });
  assert.equal(none.pageInfo.total, 3);
  assert.equal(none.pageInfo.totalIsExact, false);
});

test("D1 article adapter listArticles applies source/jurisdiction/type/language/range/tag filters", async () => {
  const first = d1Article({ id: "a", slug: "a", original_published_at: "2000-01-01T00:00:00.000Z" });
  const second = d1Article({
    id: "b",
    slug: "b",
    source_key: "de-bverfg",
    jurisdiction: "Germany",
    content_type: "decision",
    original_language: "de",
    original_published_at: "2099-01-01T00:00:00.000Z",
  });
  const fake = createFakeD1({
    articles: [first, second],
    article_tags: [{ article_id: "a", tag_id: "tag-1", confidence: 0.5 }],
    tags: [TAG_ROW as unknown as Record<string, unknown>],
  });
  const repository = createD1ArticleReadRepository({ binding: fake.database });

  assert.deepEqual((await repository.listArticles({ source: "de-bverfg" })).items.map((i) => i.slug), ["b"]);
  assert.deepEqual((await repository.listArticles({ jurisdiction: "Germany" })).items.map((i) => i.slug), ["b"]);
  assert.deepEqual((await repository.listArticles({ type: "decision" })).items.map((i) => i.slug), ["b"]);
  assert.deepEqual((await repository.listArticles({ language: "de" })).items.map((i) => i.slug), ["b"]);
  assert.deepEqual((await repository.listArticles({ ids: ["a"] })).items.map((i) => i.slug), ["a"]);
  assert.deepEqual((await repository.listArticles({ tag: "first-amendment" })).items.map((i) => i.slug), ["a"]);
  assert.deepEqual((await repository.listArticles({ tag: "missing-tag" })).items, []);
  assert.deepEqual((await repository.listArticles({ range: "month" })).items.map((i) => i.slug), ["b"]);
});

test("D1 article adapter is bounded: overflow and unsupported count are skips", async () => {
  const fake = createFakeD1({
    articles: [d1Article({ id: "a", slug: "a" }), d1Article({ id: "b", slug: "b" })],
    article_tags: [],
    tags: [],
  });
  const repository = createD1ArticleReadRepository({ binding: fake.database, maxRows: 1 });
  await assert.rejects(
    () => repository.listArticles({}),
    (error: unknown) => error instanceof D1ShadowTruncatedError && error.code === "d1_shadow.truncated",
  );
  await assert.rejects(
    () => repository.listArticles({ count: "estimated" }),
    (error: unknown) => error instanceof D1ArticleShadowSkipError && error.reason === "unsupported_count_mode",
  );
});

test("D1 article adapter sitemap preserves lastModified precedence and truncates overflow", async () => {
  const fake = createFakeD1({
    articles: [
      d1Article({ id: "a", slug: "a", summarized_at: null, fetched_at: null, discovered_at: "2026-01-01T00:00:00.000Z" }),
      d1Article({ id: "b", slug: "b", summarized_at: "2026-06-01T00:00:00.000Z", fetched_at: null, discovered_at: null }),
      d1Article({ slug: null }),
    ],
    article_tags: [],
    tags: [],
  });
  const repository = createD1ArticleReadRepository({ binding: fake.database });
  assert.deepEqual(await repository.listPublicSitemapArticles(), [
    { slug: "a", lastModified: "2026-01-01T00:00:00.000Z" },
    { slug: "b", lastModified: "2026-06-01T00:00:00.000Z" },
  ]);

  const bounded = createD1ArticleReadRepository({ binding: fake.database, maxRows: 1 });
  await assert.rejects(
    () => bounded.listPublicSitemapArticles(),
    (error: unknown) => error instanceof D1ShadowTruncatedError,
  );
});

test("D1 article adapter top-viewed ranks by view_count, honors filters and falls back", async () => {
  const fake = createFakeD1({
    articles: [d1Article({ id: "a", slug: "a" }), d1Article({ id: "b", slug: "b" })],
    article_tags: [],
    tags: [],
    article_view_counts: [
      { article_slug: "b", view_count: "9" },
      { article_slug: "a", view_count: 3 },
    ],
  });
  const repository = createD1ArticleReadRepository({ binding: fake.database });
  const ranked = await repository.listTopViewedArticles(5, {});
  assert.deepEqual(ranked.map((item) => item.slug), ["b", "a"]);
  assert.equal(ranked[0].viewCount, 9);
  assert.equal(ranked[1].viewCount, 3);

  const emptyViews = createFakeD1({
    articles: [d1Article({ id: "a", slug: "a" })],
    article_tags: [],
    tags: [],
    article_view_counts: [],
  });
  const fallback = await createD1ArticleReadRepository({ binding: emptyViews.database }).listTopViewedArticles(5, {});
  assert.deepEqual(fallback.map((item) => item.slug), ["a"], "an empty view table must fall back to the list path");
});

test("D1 article adapter related ids apply tag/exclude/limit and skip an ambiguous overflow", async () => {
  const fake = createFakeD1({
    article_tags: [
      { article_id: "b", tag_id: "tag-9", confidence: null },
      { article_id: "b", tag_id: "tag-9", confidence: null },
      { article_id: "a", tag_id: "tag-9", confidence: null },
      { article_id: "c", tag_id: "tag-9", confidence: null },
    ],
  });
  const repository = createD1ArticleReadRepository({ binding: fake.database });
  assert.deepEqual(await repository.listRelatedArticleIds("tag-9", { excludeArticleId: "a", limit: 12 }), ["b", "c"]);

  const call = fake.calls[0];
  assert.match(call.sql, /from article_tags where tag_id = \? and article_id != \? order by article_id, tag_id limit \?/);
  assert.deepEqual(call.params, ["tag-9", "a", 13]);

  await assert.rejects(
    () => repository.listRelatedArticleIds("tag-9", { excludeArticleId: "a", limit: 1 }),
    (error: unknown) => error instanceof D1ArticleShadowSkipError && error.reason === "ambiguous_limit",
  );
  await assert.rejects(
    () => repository.listRelatedArticleIds("tag-9", { limit: 0 }),
    (error: unknown) => error instanceof D1ArticleShadowSkipError && error.reason === "unbounded",
  );
});

test("runtime D1 binding names are unchanged by M6.3", () => {
  assert.deepEqual(Object.values(D1_RUNTIME_BINDING_NAMES).sort(), [
    "WORLDCONS_CORE",
    "WORLDCONS_INGEST",
    "WORLDCONS_OPS",
    "WORLDCONS_SEARCH",
  ]);
});
