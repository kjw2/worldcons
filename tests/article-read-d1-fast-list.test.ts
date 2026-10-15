import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { createD1ArticleReadRepository } from "../lib/article-reads/d1-repository";
import { D1ShadowTruncatedError } from "../lib/reference-reads/d1-repository";
import type { D1RuntimeDatabase, D1RuntimePreparedStatement } from "../lib/cloudflare/d1/runtime-binding";
import { SqliteD1, publish, articleId } from "./helpers/e2e-core-fixture";

/**
 * Real-SQLite integration coverage for the bounded public `listArticles` fast
 * path: P3 eligibility (legacy / catalog-stale / anchored enrichment), textual
 * publishability, withdrawn/private/needs_review exclusion, ordering plus
 * hasMore, and a query-shape bound proving only a page-sized window is read.
 */

interface Captured {
  sql: string;
  params: unknown[];
}

function binding(sqlite: DatabaseSync, captured?: Captured[]): D1RuntimeDatabase {
  return {
    prepare(sql: string): D1RuntimePreparedStatement {
      const statement = sqlite.prepare(sql);
      let params: unknown[] = [];
      return {
        bind(...values: unknown[]) {
          params = values;
          return this;
        },
        async all<T>() {
          captured?.push({ sql, params });
          return { success: true, results: statement.all(...(params as SQLInputValue[])) as T[] };
        },
      };
    },
  };
}

const PUBLISHABLE = JSON.stringify({ collection: { publishable: true } });
const NOT_PUBLISHABLE = JSON.stringify({ collection: { publishable: false } });

function createCore() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../d1/worldcons_core/0001_init.sql", import.meta.url), "utf8"));
  return sqlite;
}

const NOW = "2026-01-01T00:00:00.000Z";

interface ArticleOverrides {
  jurisdiction?: string;
  publishedAt?: string | null;
  status?: string;
  stale?: number;
  metadata?: string;
  versionId?: string;
  p3State?: string;
  versionRole?: string | null;
  anchor?: string | null;
  sourceHash?: string | null;
  enrichmentHash?: string | null;
  catalogState?: string | null;
  contentHash?: string;
  revision?: string;
}

function insertVersion(sqlite: DatabaseSync, id: string, versionId: string, overrides: ArticleOverrides) {
  sqlite
    .prepare(
      `INSERT INTO article_content_versions_p3(id,article_id,revision,content_hash,provenance_actor_type,slug,
        source_key,jurisdiction,institution_name,content_type,original_url,canonical_url,original_language,created_at,
        version_role,source_anchor_version_id,enrichment_source_content_hash,source_content_hash,original_published_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      versionId,
      id,
      overrides.revision ?? "1",
      overrides.contentHash ?? `hash-${id}`,
      "human",
      id,
      "us-scotus",
      overrides.jurisdiction ?? "United States",
      "SCOTUS",
      "opinion",
      `https://example.test/${id}`,
      `https://example.test/${id}`,
      "en",
      NOW,
      overrides.versionRole === undefined ? null : overrides.versionRole,
      overrides.anchor ?? null,
      overrides.enrichmentHash ?? null,
      overrides.sourceHash ?? null,
      overrides.publishedAt === undefined ? "2026-01-01T00:00:00.000Z" : overrides.publishedAt,
    );
}

function insertArticle(sqlite: DatabaseSync, id: string, overrides: ArticleOverrides = {}) {
  const versionId = overrides.versionId ?? `pub-${id}`;
  sqlite
    .prepare(
      `INSERT INTO articles(id,source_key,jurisdiction,institution_name,content_type,original_url,canonical_url,
        original_language,original_title,korean_title,original_published_at,discovered_at,fetched_at,summarized_at,
        status,slug,summary_json,source_metadata,catalog_ai_stale_v4,content_hash,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      id,
      "us-scotus",
      overrides.jurisdiction ?? "United States",
      "SCOTUS",
      "opinion",
      `https://example.test/${id}`,
      `https://example.test/${id}`,
      "en",
      `Title ${id}`,
      `제목 ${id}`,
      overrides.publishedAt === undefined ? "2026-01-01T00:00:00.000Z" : overrides.publishedAt,
      "2026-01-02T00:00:00.000Z",
      "2026-01-02T00:00:00.000Z",
      "2026-01-03T00:00:00.000Z",
      overrides.status ?? "summarized",
      id,
      JSON.stringify({ summary: { coreSummary: ["요약"] }, koreanTitle: `요약 ${id}` }),
      overrides.metadata ?? PUBLISHABLE,
      overrides.stale ?? 0,
      overrides.contentHash ?? `hash-${id}`,
      NOW,
      "2026-01-03T00:00:00.000Z",
    );
  sqlite
    .prepare(
      `INSERT INTO article_publications_p3(id,article_id,state,version_id,revision,decided_by_type,reason,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?)`,
    )
    .run(`p-${id}`, id, overrides.p3State ?? "published", versionId, "1", "human", "test", NOW, NOW);
  insertVersion(sqlite, id, versionId, overrides);
  if (overrides.catalogState) {
    const anchor = overrides.anchor ?? `anchor-${id}`;
    sqlite
      .prepare(
        `INSERT INTO case_catalog_publications_v1(id,article_id,state,source_anchor_version_id,revision,
          source_policy_version,decided_by_type,reason,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(`cat-${id}`, id, overrides.catalogState, anchor, "1", "v1", "human", "test", NOW, NOW);
  }
}

test("fast list returns only eligible published P3 rows and preserves ordering + hasMore", async () => {
  const sqlite = createCore();
  try {
    insertArticle(sqlite, "a", { publishedAt: "2026-03-01T00:00:00.000Z" });
    insertArticle(sqlite, "b", { publishedAt: "2026-02-01T00:00:00.000Z" });
    insertArticle(sqlite, "c", { publishedAt: null });
    const repo = createD1ArticleReadRepository({ binding: binding(sqlite), fastList: true, maxRows: 10_000 });

    const page1 = await repo.listArticles({ page: 1, pageSize: 2, count: "none", includeViewCounts: false });
    assert.deepEqual(page1.items.map((item) => item.slug), ["a", "b"]);
    assert.equal(page1.pageInfo.hasMore, true);
    assert.equal(page1.pageInfo.totalIsExact, false);

    const page2 = await repo.listArticles({ page: 2, pageSize: 2, count: "none", includeViewCounts: false });
    assert.deepEqual(page2.items.map((item) => item.slug), ["c"]);
    assert.equal(page2.pageInfo.hasMore, false);
  } finally {
    sqlite.close();
  }
});

test("fast list enforces textual publishability, catalog-stale and withdrawn/private exclusion", async () => {
  const sqlite = createCore();
  try {
    insertArticle(sqlite, "ok");
    insertArticle(sqlite, "string-true", { metadata: JSON.stringify({ collection: { publishable: "true" } }) });
    insertArticle(sqlite, "numeric-one", { metadata: JSON.stringify({ collection: { publishable: 1 } }) });
    insertArticle(sqlite, "private", { metadata: NOT_PUBLISHABLE });
    insertArticle(sqlite, "needs-review", { status: "needs_review" });
    insertArticle(sqlite, "stale", { stale: 1 });
    insertArticle(sqlite, "withdrawn", { p3State: "withdrawn" });
    insertArticle(sqlite, "not-published", { p3State: "in_review" });
    const repo = createD1ArticleReadRepository({ binding: binding(sqlite), fastList: true, maxRows: 10_000 });

    const result = await repo.listArticles({ pageSize: 50, count: "none", includeViewCounts: false });
    assert.deepEqual(
      result.items.map((item) => item.slug).sort(),
      ["ok", "string-true"],
      "only textual JSON-true/native-true publishable published P3 rows are public",
    );
  } finally {
    sqlite.close();
  }
});

test("fast list mirrors the Catalog anchor anti-join for a corrected source", async () => {
  const sqlite = createCore();
  try {
    // Legacy publication with no catalog correction stays public.
    insertArticle(sqlite, "legacy");
    // Catalog correction exists but the published P3 is a stale legacy version.
    insertArticle(sqlite, "blocked", {
      versionRole: null,
      anchor: "official-v2",
      catalogState: "published",
    });
    // Catalog correction superseded by a matching anchored enrichment snapshot.
    insertArticle(sqlite, "enriched", {
      versionRole: "enrichment_full",
      anchor: "official-v3",
      enrichmentHash: "official-hash",
      versionId: "enrichment-v3",
      catalogState: "published",
    });
    insertVersion(sqlite, "enriched", "official-v3", {
      versionRole: "authoritative_source",
      sourceHash: "official-hash",
      revision: "2",
      contentHash: "anchor-hash-enriched",
    });
    // Catalog correction with a mismatched source hash stays blocked.
    insertArticle(sqlite, "wrong-hash", {
      versionRole: "enrichment_full",
      anchor: "official-v4",
      enrichmentHash: "obsolete-hash",
      versionId: "enrichment-v4",
      catalogState: "published",
    });
    insertVersion(sqlite, "wrong-hash", "official-v4", {
      versionRole: "authoritative_source",
      sourceHash: "official-hash",
      revision: "2",
      contentHash: "anchor-hash-wrong",
    });

    const repo = createD1ArticleReadRepository({ binding: binding(sqlite), fastList: true, maxRows: 10_000 });
    const result = await repo.listArticles({ pageSize: 50, count: "none", includeViewCounts: false });
    assert.deepEqual(result.items.map((item) => item.slug).sort(), ["enriched", "legacy"]);
  } finally {
    sqlite.close();
  }
});

test("fast list reads a bounded window, never the full corpus, and applies source/jurisdiction/range filters", async () => {
  const sqlite = createCore();
  try {
    for (let index = 0; index < 400; index += 1) {
      insertArticle(sqlite, `a-${String(index).padStart(3, "0")}`, {
        publishedAt: `2026-01-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
        jurisdiction: index % 2 === 0 ? "United States" : "Germany",
      });
    }
    const captured: Captured[] = [];
    const repo = createD1ArticleReadRepository({ binding: binding(sqlite, captured), fastList: true, maxRows: 10_000 });

    const result = await repo.listArticles({ page: 1, pageSize: 10, count: "none", includeViewCounts: false });
    assert.equal(result.items.length, 10);

    const articleReads = captured.filter((call) => call.sql.includes("from article_publications_p3 p"));
    assert.equal(articleReads.length, 1, "the eligible window is one authored query");
    const limit = Number(articleReads[0].params[articleReads[0].params.length - 1]);
    assert.ok(limit <= 10 + 60 + 1, `the fast query must bound rows well below the corpus, got limit=${limit}`);
    assert.match(articleReads[0].sql, /from article_publications_p3 p/);
    assert.doesNotMatch(articleReads[0].sql, /count\(\*\)/i);

    const filtered = await repo.listArticles({ jurisdiction: "Germany", pageSize: 5, count: "none", includeViewCounts: false });
    assert.ok(filtered.items.length > 0);
    assert.ok(filtered.items.every((item) => item.jurisdiction === "Germany"));
  } finally {
    sqlite.close();
  }
});

test("fast list falls back to the full composition for tags, q and ids", async () => {
  const sqlite = createCore();
  try {
    insertArticle(sqlite, "a");
    insertArticle(sqlite, "b");
    sqlite
      .prepare("INSERT INTO tags(id,slug,name,normalized_name,type,article_count,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
      .run("tag-1", "first-amendment", "First Amendment", "First Amendment", "article", 1, NOW, NOW);
    sqlite.prepare("INSERT INTO article_tags(article_id,tag_id,confidence,created_at) VALUES(?,?,?,?)").run("a", "tag-1", 0.9, NOW);
    const captured: Captured[] = [];
    const repo = createD1ArticleReadRepository({ binding: binding(sqlite, captured), fastList: true, maxRows: 10_000 });

    assert.deepEqual((await repo.listArticles({ tag: "first-amendment" })).items.map((i) => i.slug), ["a"]);
    assert.deepEqual((await repo.listArticles({ ids: ["b"] })).items.map((i) => i.slug), ["b"]);
    assert.deepEqual((await repo.listArticles({ tag: "missing" })).items, []);
    // q is not a D1 in-memory filter (search is a separate M7 surface); the
    // fallback must engage and never issue the fast eligible SQL.
    await repo.listArticles({ q: "Title a" });
    assert.equal(captured.filter((call) => call.sql.includes("from article_publications_p3 p")).length, 0,
      "the fast path must never run for q");
  } finally {
    sqlite.close();
  }
});

test("fast list never leaks a removed article after the approved P3 withdrawal", async (t) => {
  const core = new SqliteD1();
  t.after(() => core.close());
  await publish(core, "a");
  const repo = createD1ArticleReadRepository({ binding: core, fastList: true, maxRows: 10_000 });

  const before = await repo.listArticles({ count: "none", includeViewCounts: false });
  assert.deepEqual(before.items.map((item) => item.slug), ["m1-fixture"]);

  const pub = core.db.prepare("SELECT version_id FROM article_publications_p3 WHERE article_id=?").get(articleId) as { version_id: string };
  await publish(core, "withdraw", {
    captureLegacy: false,
    versionId: pub.version_id,
    targetState: "withdrawn",
  });

  const after = await repo.listArticles({ count: "none", includeViewCounts: false });
  assert.deepEqual(after.items.map((item) => item.slug), [], "a withdrawn publication must never appear publicly");
});

test("fast list serves approved immutable P3 content, never mutable core drafts", async (t) => {
  const core = new SqliteD1();
  t.after(() => core.close());
  await publish(core, "a");
  const repo = createD1ArticleReadRepository({ binding: core, fastList: true, maxRows: 10_000 });

  core.db.exec("UPDATE articles SET korean_title='미승인 초안', original_published_at='1999-01-01T00:00:00.000Z'");
  const result = await repo.listArticles({ count: "none", includeViewCounts: false });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].koreanTitle, "시험 판결", "the immutable P3 title must override the mutable draft");
  assert.notEqual(result.items[0].originalPublishedAt, "1999-01-01T00:00:00.000Z");
});

test("fast list drops a row withdrawn between the eligible window read and the overlay", async (t) => {
  const core = new SqliteD1();
  t.after(() => core.close());
  await publish(core, "a");
  let withdrawn = false;
  core.beforeStatement = (sql) => {
    if (!withdrawn && sql.includes("from article_publications_p3 p") && sql.includes("order by v.original_published_at")) {
      withdrawn = true;
      core.db.exec("UPDATE article_publications_p3 SET state='withdrawn'");
    }
  };
  const repo = createD1ArticleReadRepository({ binding: core, fastList: true, maxRows: 10_000 });
  const result = await repo.listArticles({ count: "none", includeViewCounts: false });
  assert.equal(withdrawn, true, "the race must have been triggered");
  assert.deepEqual(result.items, [], "the immutable overlay must never serve a row withdrawn before hydration");
});

test("fast list honors the eligible-row overflow bound", async () => {
  const sqlite = createCore();
  try {
    for (let index = 0; index < 5; index += 1) insertArticle(sqlite, `a-${index}`);
    const repo = createD1ArticleReadRepository({ binding: binding(sqlite), fastList: true, maxRows: 1 });
    // The legacy path fails closed when the matched corpus exceeds maxRows; the
    // fast path refuses and the fallback raises the typed truncation.
    await assert.rejects(
      () => repo.listArticles({ count: "none", includeViewCounts: false }),
      (error: unknown) => error instanceof D1ShadowTruncatedError,
    );
  } finally {
    sqlite.close();
  }
});
