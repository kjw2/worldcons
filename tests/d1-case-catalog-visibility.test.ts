import assert from "node:assert/strict";
import test from "node:test";
import {
  clearRuntimeD1Bindings,
  setRuntimeD1Bindings,
  type D1RuntimeDatabase,
  type D1RuntimePreparedStatement,
} from "../lib/cloudflare/d1/runtime-binding";
import { runD1CaseCatalogSearch } from "../lib/cloudflare/search-catalog/case-catalog-search";
import { createD1ArticleReadRepository } from "../lib/article-reads/d1-repository";
import { catalogCaseSearch } from "../lib/search/case-catalog";
import { fullTextSearch } from "../lib/search/vector";
import type { CatalogCaseSearchRpcRequest } from "../lib/search/repository/types";

/**
 * Focused regression coverage for the source-only Case Catalog D1 visibility
 * slice:
 *
 * - D1 article reads expose published `case_catalog_publications_v1` rows that
 *   are not summarized only when the P3 V4 read and public Catalog flags are on;
 * - the derived V4 state never fakes `summarized` or an AI summary;
 * - `SearchRepository.catalogCaseSearchRpc` serves the `schemaVersion=2`
 *   payload with exact-identity/lexical/latest modes, filters, and an
 *   invalid/mismatch/expired keyset cursor.
 *
 * The fake D1 evaluates the guarded SQL `runD1RuntimeRead` emits (eq/neq/gte/in,
 * order by, limit, offset).
 */

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
        rows = rows.filter((row) => values.includes(row[inMatch[1]]));
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
  const calls: Array<{ sql: string; params: unknown[]; table: string }> = [];
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

function baseArticle(overrides: Record<string, unknown>) {
  return {
    id: "case-a",
    slug: "us-a",
    source_key: "us-scotus",
    jurisdiction: "United States",
    institution_name: "Supreme Court",
    content_type: "opinion",
    original_url: "https://example.test/a",
    canonical_url: "https://example.test/a",
    original_language: "en",
    original_title: "Freedom of Speech Case",
    korean_title: null,
    original_published_at: "2026-04-29T00:00:00.000Z",
    discovered_at: "2026-04-30T00:00:00.000Z",
    fetched_at: "2026-04-30T00:10:00.000Z",
    summarized_at: null,
    status: "cleaned",
    raw_text: null,
    cleaned_text: "alpha beta gamma delta",
    content_hash: "hash-a",
    summary_json: null,
    source_metadata: { catalog: { sourceOnly: true }, case: {} },
    error_metadata: null,
    catalog_ai_stale_v4: 0,
    raw_text_storage_ref: null,
    raw_text_blob_hash: null,
    raw_text_blob_size: null,
    raw_text_externalized_at: null,
    raw_text_blob_contract_version: null,
    ...overrides,
  };
}

function anchorVersion(overrides: Record<string, unknown>) {
  return {
    id: "ver-a",
    article_id: "case-a",
    slug: "us-a",
    source_key: "us-scotus",
    jurisdiction: "United States",
    institution_name: "Supreme Court",
    content_type: "opinion",
    original_language: "en",
    original_title: "Freedom of Speech Case",
    korean_title: null,
    cleaned_text: "alpha beta gamma delta",
    case_key: "23123",
    original_published_at: "2026-04-29T00:00:00.000Z",
    version_role: "authoritative_source",
    source_anchor_version_id: "ver-a",
    case_metadata_snapshot: { sourceMetadata: { court: "SCOTUS" } },
    ...overrides,
  };
}

function catalogTables(overrides: Record<string, Record<string, unknown>[]> = {}) {
  const tables: Record<string, Record<string, unknown>[]> = {
    articles: [
      baseArticle({}),
      baseArticle({
        id: "case-b",
        slug: "us-b",
        content_type: "order",
        original_title: "Equal Protection Matter",
        cleaned_text: "delta epsilon",
        original_published_at: "2026-03-01T00:00:00.000Z",
        status: "metadata_only",
        source_metadata: { catalog: { sourceOnly: true }, case: {} },
      }),
    ],
    case_catalog_publications_v1: [
      { id: "pub-a", article_id: "case-a", state: "published", source_anchor_version_id: "ver-a", revision: 1 },
      { id: "pub-b", article_id: "case-b", state: "published", source_anchor_version_id: "ver-b", revision: 1 },
    ],
    case_metadata_v1: [
      {
        article_id: "case-a",
        authority_status: "verified",
        constitutional_relevance_status: "verified",
        enrichment_status: "source_only",
        enrichment_freshness: null,
        text_access_policy: "full",
      },
      {
        article_id: "case-b",
        authority_status: "verified",
        constitutional_relevance_status: "verified",
        enrichment_status: "source_only",
        enrichment_freshness: null,
        text_access_policy: "metadata_only",
      },
    ],
    article_content_versions_p3: [
      anchorVersion({}),
      anchorVersion({
        id: "ver-b",
        article_id: "case-b",
        content_type: "order",
        original_title: "Equal Protection Matter",
        cleaned_text: "delta epsilon",
        case_key: "22100",
        original_published_at: "2026-03-01T00:00:00.000Z",
        source_anchor_version_id: "ver-b",
        case_metadata_snapshot: { sourceMetadata: { court: "SCOTUS" } },
      }),
    ],
    case_identifiers_v1: [
      { article_id: "case-a", identifier_type: "docket", normalized_value: "23123" },
      { article_id: "case-b", identifier_type: "source_record_id", normalized_value: "abc123" },
    ],
    tags: [{ id: "tag-1", slug: "speech", name: "Speech" }],
    article_tags: [{ article_id: "case-a", tag_id: "tag-1" }],
    article_publications_p3: [],
    article_view_counts: [],
  };
  const merged = { ...tables, ...overrides };
  if (!("article_publications_p3" in overrides)) {
    merged.article_publications_p3 = (merged.articles ?? [])
      .filter((row) => row.status === "summarized" && (row.source_metadata as { collection?: { publishable?: unknown } } | undefined)?.collection?.publishable === true)
      .map((row, index) => ({ id: `p3-${index + 1}`, article_id: row.id, state: "published", version_id: `legacy-${index + 1}`, revision: "1" }));
  }
  return merged;
}

function catalogRequest(overrides: Partial<CatalogCaseSearchRpcRequest> = {}): CatalogCaseSearchRpcRequest {
  return {
    query: "",
    limit: 20,
    cursor: null,
    source: null,
    jurisdiction: null,
    contentType: null,
    language: null,
    tag: null,
    range: "latest",
    ...overrides,
  };
}

const FLAGS_ON = {
  ADMIN_PUBLICATION_V4_READ_ENABLED: "true",
  CASE_CATALOG_PUBLIC_ENABLED: "true",
};

async function withEnv<T>(values: Record<string, string | undefined>, run: () => Promise<T> | T): Promise<T> {
  const keys = [
    "ADMIN_PUBLICATION_V4_READ_ENABLED",
    "CASE_CATALOG_PUBLIC_ENABLED",
    "CASE_CATALOG_SEARCH_ENABLED",
    "CASE_CATALOG_PLUGIN_ENABLED",
    "CASE_CATALOG_SEMANTIC_ENABLED",
  ];
  const original = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
  try {
    return await run();
  } finally {
    for (const key of keys) {
      const value = original.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("D1 article list never exposes source-only Catalog rows, even when legacy flags are on", async () => {
  const fake = createFakeD1(catalogTables());

  const off = createD1ArticleReadRepository({ binding: fake.database, environment: {} });
  const offResult = await off.listArticles({});
  assert.deepEqual(offResult.items, [], "flags off must preserve the legacy summarized-only behavior");

  const on = createD1ArticleReadRepository({ binding: fake.database, environment: FLAGS_ON });
  const onResult = await on.listArticles({ includeViewCounts: false });
  assert.deepEqual(onResult.items, []);
  assert.equal(onResult.pageInfo.total, 0);
  assert.equal(onResult.pageInfo.hasMore, false);
});

test("D1 article detail and source-text reads keep source-only Catalog rows private", async () => {
  const fake = createFakeD1(catalogTables());
  const repository = createD1ArticleReadRepository({ binding: fake.database, environment: FLAGS_ON });

  assert.equal(await repository.getArticleBySelect("us-a", "detail"), null);
  assert.equal(await repository.getArticleSourceTextBySlug("us-a"), null);

  const off = createD1ArticleReadRepository({ binding: fake.database, environment: {} });
  assert.equal(await off.getArticleBySelect("us-a", "detail"), null);
  assert.equal(await off.getArticleSourceTextBySlug("us-a"), null);
});

test("D1 article reads never expose source-only Catalog text regardless of Catalog text policy", async () => {
  const fake = createFakeD1(catalogTables());
  const repository = createD1ArticleReadRepository({ binding: fake.database, environment: FLAGS_ON });

  const metadataOnly = await repository.getArticleBySelect("us-b", "detail");
  assert.equal(metadataOnly, null);

  const longText = "x".repeat(2500);
  const excerpt = createFakeD1(catalogTables({
    articles: [
      baseArticle({ cleaned_text: longText }),
      baseArticle({ id: "case-b", slug: "us-b", status: "metadata_only" }),
    ],
    case_metadata_v1: [
      {
        article_id: "case-a",
        authority_status: "verified",
        constitutional_relevance_status: "verified",
        enrichment_status: "source_only",
        enrichment_freshness: null,
        text_access_policy: "excerpt",
      },
      {
        article_id: "case-b",
        authority_status: "verified",
        constitutional_relevance_status: "verified",
        enrichment_status: "source_only",
        enrichment_freshness: null,
        text_access_policy: "metadata_only",
      },
    ],
  }));
  const excerptRepository = createD1ArticleReadRepository({ binding: excerpt.database, environment: FLAGS_ON });
  const excerpted = await excerptRepository.getArticleBySelect("us-a", "detail");
  assert.equal(excerpted, null);

  const reprocessing = createFakeD1(catalogTables({
    articles: [
      baseArticle({ catalog_ai_stale_v4: 1 }),
      baseArticle({ id: "case-b", slug: "us-b", status: "metadata_only" }),
    ],
  }));
  const reprocessingRepository = createD1ArticleReadRepository({ binding: reprocessing.database, environment: FLAGS_ON });
  const stale = await reprocessingRepository.getArticleBySelect("us-a", "detail");
  assert.equal(stale, null);
});

test("D1 listArticles merges summarized legacy rows without letting Catalog replace them", async () => {
  const fake = createFakeD1(catalogTables({
    articles: [
      baseArticle({
        id: "legacy-1",
        slug: "legacy-1",
        status: "summarized",
        original_published_at: "2026-05-02T00:00:00.000Z",
        summarized_at: "2026-05-02T00:00:00.000Z",
        source_metadata: { collection: { publishable: true } },
      }),
      baseArticle({}),
      baseArticle({
        id: "case-c",
        slug: "us-c",
        status: "summarized",
        original_published_at: "2026-05-01T00:00:00.000Z",
        summarized_at: "2026-05-01T00:00:00.000Z",
        source_metadata: { collection: { publishable: true } },
      }),
    ],
    case_catalog_publications_v1: [
      { id: "pub-a", article_id: "case-a", state: "published", source_anchor_version_id: "ver-a", revision: 1 },
      { id: "pub-c", article_id: "case-c", state: "published", source_anchor_version_id: "ver-c", revision: 1 },
    ],
    article_content_versions_p3: [
      anchorVersion({}),
      anchorVersion({
        id: "ver-c",
        article_id: "case-c",
        case_key: "99999",
        original_published_at: "2026-05-01T00:00:00.000Z",
        source_anchor_version_id: "ver-c",
      }),
    ],
  }));
  const repository = createD1ArticleReadRepository({ binding: fake.database, environment: FLAGS_ON });
  const result = await repository.listArticles({ includeViewCounts: false });

  assert.deepEqual(
    result.items.map((item) => item.slug),
    ["legacy-1", "us-c"],
    "only P3-published summarized rows are public",
  );
  const legacyFirst = result.items.find((item) => item.slug === "legacy-1");
  assert.equal(legacyFirst?.status, "summarized");
  assert.equal(legacyFirst?.enrichmentStatus, undefined);
  const alsoPublished = result.items.find((item) => item.slug === "us-c");
  assert.equal(alsoPublished?.status, "summarized", "a summarized row wins over its Catalog publication");
  assert.equal(alsoPublished?.enrichmentStatus, undefined);
  assert.equal(result.items.some((item) => item.slug === "us-a"), false);
});

test("D1 listArticles never materializes source-only Catalog rows through public filters", async () => {
  const fake = createFakeD1(catalogTables());
  const repository = createD1ArticleReadRepository({ binding: fake.database, environment: FLAGS_ON });

  assert.deepEqual((await repository.listArticles({ source: "us-scotus", includeViewCounts: false })).items, []);
  assert.deepEqual((await repository.listArticles({ type: "order", includeViewCounts: false })).items, []);
  assert.deepEqual((await repository.listArticles({ language: "en", includeViewCounts: false })).items, []);
  assert.deepEqual((await repository.listArticles({ source: "de-bverfg", includeViewCounts: false })).items, []);
  assert.deepEqual((await repository.listArticles({ tag: "speech", includeViewCounts: false })).items, []);
});

test("D1 catalog search returns the schemaVersion=2 latest/lexical/exact payload shape", async () => {
  const fake = createFakeD1(catalogTables());

  const latest = await runD1CaseCatalogSearch({ binding: fake.database, request: catalogRequest() });
  assert.equal(latest.status, "ok");
  if (latest.status !== "ok") return;
  const payload = latest.data as Record<string, unknown>;
  assert.equal(payload.schemaVersion, 2);
  assert.equal(payload.rankingVersion, "gate3-exact-lexical-v1");
  assert.equal(payload.retrievalMode, "latest");
  assert.deepEqual((payload.entries as Array<{ id: string }>).map((entry) => entry.id), ["case-a", "case-b"]);
  assert.equal(payload.hasMore, false);
  assert.equal(payload.totalIsExact, true);
  assert.equal(payload.total, 2);

  const lexical = await runD1CaseCatalogSearch({
    binding: fake.database,
    request: catalogRequest({ query: "Freedom of Speech" }),
  });
  assert.equal(lexical.status, "ok");
  if (lexical.status !== "ok") return;
  const lexicalPayload = lexical.data as Record<string, unknown>;
  assert.equal(lexicalPayload.retrievalMode, "lexical");
  assert.deepEqual((lexicalPayload.entries as Array<{ id: string }>).map((entry) => entry.id), ["case-a"]);

  const exactNumber = await runD1CaseCatalogSearch({
    binding: fake.database,
    request: catalogRequest({ query: "23-123" }),
  });
  assert.equal(exactNumber.status, "ok");
  if (exactNumber.status !== "ok") return;
  assert.equal((exactNumber.data as Record<string, unknown>).retrievalMode, "exact-identity");
  assert.deepEqual((exactNumber.data as { entries: Array<{ id: string }> }).entries.map((entry) => entry.id), ["case-a"]);

  const exactIdentifier = await runD1CaseCatalogSearch({
    binding: fake.database,
    request: catalogRequest({ query: "abc123" }),
  });
  assert.equal(exactIdentifier.status, "ok");
  if (exactIdentifier.status !== "ok") return;
  assert.equal((exactIdentifier.data as Record<string, unknown>).retrievalMode, "exact-identity");
  assert.deepEqual((exactIdentifier.data as { entries: Array<{ id: string }> }).entries.map((entry) => entry.id), ["case-b"]);
});

test("D1 catalog exact BVerfG search recovers the docket from authoritative metadata when legacy case_key is null", async () => {
  const docket = "2 BvR 1216/21";
  const sourceMetadata = {
    caseNumber: docket,
    sourceInventory: { docket, docketKey: "2bvr121621" },
  };
  const fake = createFakeD1(catalogTables({
    articles: [baseArticle({
      id: "case-de",
      slug: "de-bverfg-dejure-2022-12-29-2bvr121621",
      source_key: "de-bverfg",
      jurisdiction: "Germany",
      institution_name: "Federal Constitutional Court of Germany",
      content_type: "decision",
      original_language: "de",
      original_title: "Beschluss vom 29. Dezember 2022",
      original_published_at: "2022-12-29T00:00:00.000Z",
      status: "metadata_only",
      cleaned_text: null,
      source_metadata: { catalog: { sourceOnly: true }, case: sourceMetadata },
    })],
    case_catalog_publications_v1: [
      { id: "pub-de", article_id: "case-de", state: "published", source_anchor_version_id: "ver-de", revision: 1 },
    ],
    case_metadata_v1: [
      {
        article_id: "case-de",
        authority_status: "verified",
        constitutional_relevance_status: "verified",
        enrichment_status: "source_only",
        enrichment_freshness: null,
        text_access_policy: "metadata_only",
      },
    ],
    article_content_versions_p3: [anchorVersion({
      id: "ver-de",
      article_id: "case-de",
      slug: "de-bverfg-dejure-2022-12-29-2bvr121621",
      source_key: "de-bverfg",
      jurisdiction: "Germany",
      institution_name: "Federal Constitutional Court of Germany",
      content_type: "decision",
      original_language: "de",
      original_title: "Beschluss vom 29. Dezember 2022",
      cleaned_text: null,
      case_key: null,
      original_published_at: "2022-12-29T00:00:00.000Z",
      source_anchor_version_id: "ver-de",
      case_metadata_snapshot: { sourceMetadata },
      source_metadata: sourceMetadata,
    })],
    case_identifiers_v1: [
      { article_id: "case-de", identifier_type: "source_record_id", normalized_value: "dejure202212292bvr121621" },
    ],
    tags: [],
    article_tags: [],
    article_publications_p3: [],
    article_view_counts: [],
  }));

  const exact = await runD1CaseCatalogSearch({
    binding: fake.database,
    request: catalogRequest({ query: docket, source: "de-bverfg" }),
  });
  assert.equal(exact.status, "ok");
  if (exact.status !== "ok") return;
  assert.equal((exact.data as Record<string, unknown>).retrievalMode, "exact-identity");
  assert.deepEqual((exact.data as { entries: Array<{ id: string }> }).entries.map((entry) => entry.id), ["case-de"]);
});

test("D1 catalog search applies filters and a stable keyset cursor across pages", async () => {
  const fake = createFakeD1(catalogTables());

  const filtered = await runD1CaseCatalogSearch({
    binding: fake.database,
    request: catalogRequest({ jurisdiction: "United States", tag: "speech" }),
  });
  assert.equal(filtered.status, "ok");
  if (filtered.status !== "ok") return;
  assert.deepEqual((filtered.data as { entries: Array<{ id: string }> }).entries.map((entry) => entry.id), ["case-a"]);

  const week = await runD1CaseCatalogSearch({
    binding: fake.database,
    request: catalogRequest({ range: "week" }),
    now: new Date("2026-05-01T00:00:00.000Z"),
  });
  assert.equal(week.status, "ok");
  if (week.status !== "ok") return;
  assert.deepEqual((week.data as { entries: Array<{ id: string }> }).entries.map((entry) => entry.id), ["case-a"]);

  const firstPage = await runD1CaseCatalogSearch({
    binding: fake.database,
    request: catalogRequest({ limit: 1 }),
  });
  assert.equal(firstPage.status, "ok");
  if (firstPage.status !== "ok") return;
  const firstPayload = firstPage.data as { entries: Array<{ id: string }>; nextCursor: string | null; hasMore: boolean };
  assert.deepEqual(firstPayload.entries.map((entry) => entry.id), ["case-a"]);
  assert.equal(firstPayload.hasMore, true);
  assert.ok(firstPayload.nextCursor);

  const secondPage = await runD1CaseCatalogSearch({
    binding: fake.database,
    request: catalogRequest({ limit: 1, cursor: firstPayload.nextCursor }),
  });
  assert.equal(secondPage.status, "ok");
  if (secondPage.status !== "ok") return;
  const secondPayload = secondPage.data as { entries: Array<{ id: string }>; nextCursor: string | null; hasMore: boolean; total: number };
  assert.deepEqual(secondPayload.entries.map((entry) => entry.id), ["case-b"]);
  assert.equal(secondPayload.hasMore, false);
  assert.equal(secondPayload.nextCursor, null);
  assert.equal(secondPayload.total, 2);
});

test("D1 catalog search surfaces invalid, mismatch, and expired cursor evidence", async () => {
  const fake = createFakeD1(catalogTables());

  const invalid = await runD1CaseCatalogSearch({
    binding: fake.database,
    request: catalogRequest({ cursor: "not a cursor!" }),
  });
  assert.deepEqual(invalid, { status: "error", error: { code: "22023", message: "WORLDCONS_CASE_SEARCH_INVALID_CURSOR" } });

  const firstPage = await runD1CaseCatalogSearch({ binding: fake.database, request: catalogRequest({ limit: 1 }) });
  assert.equal(firstPage.status, "ok");
  if (firstPage.status !== "ok") return;
  const cursor = (firstPage.data as { nextCursor: string | null }).nextCursor;
  assert.ok(cursor);

  const mismatch = await runD1CaseCatalogSearch({
    binding: fake.database,
    request: catalogRequest({ limit: 1, cursor, jurisdiction: "Germany" }),
  });
  assert.deepEqual(mismatch, { status: "error", error: { code: "22023", message: "WORLDCONS_CASE_SEARCH_CURSOR_MISMATCH" } });

  const expiredCursor = btoa(JSON.stringify({
    rankingVersion: "gate3-exact-lexical-v0",
    fingerprint: "deadbeef",
    mode: "latest",
    score: 0,
    sortDate: "2026-04-29T00:00:00.000Z",
    articleId: "case-a",
    position: 1,
  })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const expired = await runD1CaseCatalogSearch({
    binding: fake.database,
    request: catalogRequest({ limit: 1, cursor: expiredCursor }),
  });
  assert.deepEqual(expired, { status: "error", error: { code: "22023", message: "WORLDCONS_CASE_SEARCH_CURSOR_RANKING_VERSION_EXPIRED" } });
});

test("catalogCaseSearch public wrapper stays disabled for source-only Catalog data", async () => {
  const fake = createFakeD1(catalogTables());
  clearRuntimeD1Bindings();
  setRuntimeD1Bindings({ worldcons_core: fake.database, worldcons_search: fake.database });
  try {
    await withEnv({ ...FLAGS_ON, CASE_CATALOG_SEARCH_ENABLED: "true" }, async () => {
      await assert.rejects(() => catalogCaseSearch({ q: "", pageSize: 20, includeViewCounts: false }), /case_catalog\.search_disabled/);
    });
  } finally {
    clearRuntimeD1Bindings();
  }
});

test("fullTextSearch does not route through the retired source-only Catalog public search", async () => {
  const fake = createFakeD1(catalogTables());
  clearRuntimeD1Bindings();
  setRuntimeD1Bindings({ worldcons_core: fake.database, worldcons_search: fake.database });
  try {
    await withEnv({ ...FLAGS_ON, CASE_CATALOG_SEARCH_ENABLED: "true" }, async () => {
      const result = await fullTextSearch({ q: "23-123", pageSize: 20, includeViewCounts: false });
      assert.deepEqual(result.items, []);
    });
  } finally {
    clearRuntimeD1Bindings();
  }
});

test("D1 catalog search derives the exact BVerfG case key from authoritative metadata when version.case_key is null", async () => {
  const exactCatalog = (caseMetadataSnapshot: unknown, articleCase: unknown) => createFakeD1(catalogTables({
    articles: [
      baseArticle({
        id: "de-1", slug: "de-1", source_key: "de-bverfg", jurisdiction: "Germany",
        institution_name: "Federal Constitutional Court of Germany", content_type: "decision",
        original_title: "Beschluss der 2. Kammer", original_language: "de",
        cleaned_text: "Text ohne Docket",
        source_metadata: articleCase === undefined
          ? { catalog: { sourceOnly: true } }
          : { catalog: { sourceOnly: true }, case: articleCase },
      }),
    ],
    case_catalog_publications_v1: [
      { id: "pub-de", article_id: "de-1", state: "published", source_anchor_version_id: "ver-de", revision: 1 },
    ],
    case_metadata_v1: [
      {
        article_id: "de-1",
        authority_status: "verified",
        constitutional_relevance_status: "verified",
        enrichment_status: "source_only",
        enrichment_freshness: null,
        text_access_policy: "full",
      },
    ],
    article_content_versions_p3: [
      anchorVersion({
        id: "ver-de", article_id: "de-1", slug: "de-1", source_key: "de-bverfg", jurisdiction: "Germany",
        institution_name: "Federal Constitutional Court of Germany", content_type: "decision",
        original_language: "de", original_title: "Beschluss der 2. Kammer", cleaned_text: "Text ohne Docket",
        case_key: null, source_anchor_version_id: "ver-de", case_metadata_snapshot: caseMetadataSnapshot,
      }),
    ],
    case_identifiers_v1: [
      { article_id: "de-1", identifier_type: "source_record_id", normalized_value: "record-1" },
    ],
    tags: [],
    article_tags: [],
  }));

  // Authoritative sealed snapshot stored as D1 canonical JSON text.
  const snapshotFake = exactCatalog(
    JSON.stringify({ sourceMetadata: { sourceInventory: { docket: "2 BvR 1216/21" } } }),
    undefined,
  );
  const snapshotResult = await runD1CaseCatalogSearch({
    binding: snapshotFake.database,
    request: catalogRequest({ query: "2 BvR 1216/21" }),
  });
  assert.equal(snapshotResult.status, "ok");
  if (snapshotResult.status !== "ok") return;
  assert.equal((snapshotResult.data as Record<string, unknown>).retrievalMode, "exact-identity");
  assert.deepEqual(
    (snapshotResult.data as { entries: Array<{ id: string }> }).entries.map((entry) => entry.id),
    ["de-1"],
  );

  // Article source_metadata.case fallback when the version snapshot is absent.
  const articleFake = exactCatalog(null, { sourceInventory: { docket: "2 BvR 1216/21" } });
  const articleResult = await runD1CaseCatalogSearch({
    binding: articleFake.database,
    request: catalogRequest({ query: "2 BvR 1216/21" }),
  });
  assert.equal(articleResult.status, "ok");
  if (articleResult.status !== "ok") return;
  assert.equal((articleResult.data as Record<string, unknown>).retrievalMode, "exact-identity");
  assert.deepEqual(
    (articleResult.data as { entries: Array<{ id: string }> }).entries.map((entry) => entry.id),
    ["de-1"],
  );
});

test("source-only catalog visibility stays off without either flag", async () => {
  const fake = createFakeD1(catalogTables());
  const onlyPublic = createD1ArticleReadRepository({
    binding: fake.database,
    environment: { CASE_CATALOG_PUBLIC_ENABLED: "true" },
  });
  assert.deepEqual((await onlyPublic.listArticles({ includeViewCounts: false })).items, [], "the P3 V4 read flag is required");

  const onlyP3 = createD1ArticleReadRepository({
    binding: fake.database,
    environment: { ADMIN_PUBLICATION_V4_READ_ENABLED: "true" },
  });
  assert.deepEqual((await onlyP3.listArticles({ includeViewCounts: false })).items, [], "the public Catalog flag is required");
});

