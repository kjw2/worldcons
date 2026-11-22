import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { createD1ArticleReadRepository } from "../lib/article-reads/d1-repository";
import type { D1RuntimeDatabase, D1RuntimePreparedStatement } from "../lib/cloudflare/d1/runtime-binding";
import { createD1ReadCost, wrapD1BindingWithReadCost } from "../lib/cloudflare/d1/read-cost";

/**
 * Regression gate for the 2026-11-22 public `/list` cost spike.
 *
 * The measured incident scanned ~10k article rows per request with a per-row
 * `json_extract(source_metadata, '$.collection.publishable')`. These tests fail
 * if:
 *
 *  - the public candidate SQL goes back to parsing JSON per row;
 *  - a deep page falls back to materializing the bounded legacy corpus;
 *  - the query plan stops using an index;
 *  - D1 `meta.rows_read` accounting silently stops being exposed.
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
          const results = statement.all(...(params as SQLInputValue[])) as T[];
          return { success: true, results, meta: { rows_read: results.length } };
        },
      };
    },
  };
}

function createCore() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../d1/worldcons_core/0001_init.sql", import.meta.url), "utf8"));
  sqlite.exec(readFileSync(new URL("../d1/worldcons_core/0013_public_list_publishable.sql", import.meta.url), "utf8"));
  sqlite.exec(readFileSync(new URL("../d1/worldcons_core/0014_public_list_publishable_sync.sql", import.meta.url), "utf8"));
  return sqlite;
}

function seed(sqlite: DatabaseSync, count = 600) {
  const insertArticle = sqlite.prepare(`INSERT INTO articles(
    id,source_key,jurisdiction,institution_name,content_type,original_url,canonical_url,original_language,
    original_title,original_published_at,discovered_at,fetched_at,summarized_at,status,slug,source_metadata,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insertVersion = sqlite.prepare(`INSERT INTO article_content_versions_p3(
    id,article_id,revision,content_hash,provenance_actor_type,slug,source_key,jurisdiction,institution_name,
    content_type,original_url,canonical_url,original_language,original_published_at,created_at,
    version_role,source_anchor_version_id,enrichment_source_content_hash
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insertPublication = sqlite.prepare(`INSERT INTO article_publications_p3(
    id,article_id,state,version_id,revision,decided_by_type,reason,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?)`);
  for (let index = 0; index < count; index += 1) {
    const id = `00000000-0000-4000-a000-${String(index).padStart(12, "0")}`;
    const slug = `case-${index}`;
    const publishedAt = new Date(Date.UTC(2026, 0, 1, 0, 0, count - index)).toISOString();
    insertArticle.run(
      id,
      index % 2 === 0 ? "us-scotus" : "de-bverfg",
      index % 2 === 0 ? "United States" : "Germany",
      index % 2 === 0 ? "SCOTUS" : "BVerfG",
      "decision",
      `https://example.test/${slug}`,
      `https://example.test/${slug}`,
      "en",
      `Title ${index}`,
      publishedAt,
      publishedAt,
      publishedAt,
      publishedAt,
      "summarized",
      slug,
      JSON.stringify({ collection: { publishable: true } }),
      publishedAt,
      publishedAt,
    );
    insertVersion.run(
      `version-${index}`,
      id,
      "1",
      `hash-${index}`,
      "import",
      slug,
      index % 2 === 0 ? "us-scotus" : "de-bverfg",
      index % 2 === 0 ? "United States" : "Germany",
      index % 2 === 0 ? "SCOTUS" : "BVerfG",
      "decision",
      `https://example.test/${slug}`,
      `https://example.test/${slug}`,
      "en",
      publishedAt,
      publishedAt,
      "enrichment_full",
      null,
      null,
    );
    insertPublication.run(`publication-${index}`, id, "published", `version-${index}`, "1", "system", "fixture", publishedAt, publishedAt);
  }
}

test("public list candidate SQL uses the materialized predicate and a bounded window", async () => {
  const sqlite = createCore();
  seed(sqlite);
  const captured: Captured[] = [];
  const cost = createD1ReadCost();
  const repository = createD1ArticleReadRepository({
    binding: wrapD1BindingWithReadCost(binding(sqlite, captured), cost),
    fastList: true,
    maxRows: 10_000,
  });

  const firstPage = await repository.listArticles({ page: 1, pageSize: 10, count: "none" });
  assert.equal(firstPage.items.length, 10);
  assert.equal(firstPage.pageInfo.totalIsExact, false);
  assert.equal(cost.rowsReadAvailable, true);
  assert.ok(cost.rowsRead <= 2 * (10 + 60 + 60 + 1), `one page must stay below the window budget, read ${cost.rowsRead} rows`);

  const candidate = captured.find((entry) => entry.sql.includes("from article_publications_p3 p"));
  assert.ok(candidate, "the bounded public candidate SQL must be issued");
  assert.match(candidate.sql, /a\.collection_publishable = 1/);
  assert.doesNotMatch(candidate.sql, /json_extract|json_type/, "the public list path must not parse JSON per row");
  assert.match(candidate.sql, /limit \? offset \?/);

  const [windowSize, windowOffset] = candidate.params.slice(-2) as [number, number];
  assert.equal(windowOffset, 0, "the first page reads from the beginning");
  assert.ok(windowSize <= 10 + 60 + 60 + 1, `first page window must stay page-sized, got ${windowSize}`);

  const sqliteRows = sqlite.prepare(candidate.sql).all(...(candidate.params as SQLInputValue[]));
  assert.ok(sqliteRows.length <= windowSize, "the authored window must bound the rows materialized in JS");

  const plan = sqlite
    .prepare(`EXPLAIN QUERY PLAN ${candidate.sql}`)
    .all(...(candidate.params as SQLInputValue[]))
    .map((row) => String((row as { detail?: unknown }).detail ?? ""))
    .join("\n");
  assert.match(plan, /USING (COVERING )?INDEX/i, `the public list candidate read must use an index, plan was:\n${plan}`);
});

test("deep public list pages stay page-sized instead of loading the bounded corpus", async () => {
  const sqlite = createCore();
  seed(sqlite);
  const captured: Captured[] = [];
  const repository = createD1ArticleReadRepository({ binding: binding(sqlite, captured), fastList: true, maxRows: 10_000 });

  const result = await repository.listArticles({ page: 50, pageSize: 10, count: "none" });
  assert.equal(result.items.length, 10);

  const candidate = captured.find((entry) => entry.sql.includes("from article_publications_p3 p"));
  assert.ok(candidate);
  const [windowSize, windowOffset] = candidate.params.slice(-2) as [number, number];
  assert.equal(windowOffset, (50 - 1) * 10 - 60, "the SQL offset is the requested page minus the bounded lookbehind");
  assert.ok(windowSize <= 10 + 60 + 60 + 1, "deep pages must not request the whole corpus");
  const sqliteRows = sqlite.prepare(candidate.sql).all(...(candidate.params as SQLInputValue[]));
  assert.ok(sqliteRows.length <= windowSize);
});

test("legacy exact-count list reads push the materialized publishability predicate into SQL", async () => {
  const sqlite = createCore();
  seed(sqlite);
  const captured: Captured[] = [];
  const repository = createD1ArticleReadRepository({ binding: binding(sqlite, captured), maxRows: 10_000 });

  await repository.listArticles({ source: "us-scotus", pageSize: 10, count: "exact" });
  const read = captured.find((entry) => entry.sql.includes("from articles where") && entry.sql.includes("source_key = ?"));
  assert.ok(read, "the legacy exact read must be issued");
  assert.ok(read.params.includes(1), "collection_publishable = 1 must be a bound SQL predicate");
});

test("D1 read-cost probe accumulates result.meta.rows_read and flags missing metadata", async () => {
  const cost = createD1ReadCost();
  const fake = {
    prepare() {
      return {
        bind() {
          return this;
        },
        async all() {
          return { success: true, results: [], meta: { rows_read: 7 } };
        },
      };
    },
  } as unknown as D1RuntimeDatabase;
  const wrapped = wrapD1BindingWithReadCost(fake, cost);
  await wrapped.prepare("select 1").bind(1).all();
  await wrapped.prepare("select 2").bind(2).all();
  assert.equal(cost.rowsRead, 14);
  assert.equal(cost.queries, 2);
  assert.equal(cost.rowsReadAvailable, true);

  const missing = createD1ReadCost();
  const noMeta = {
    prepare() {
      return {
        bind() {
          return this;
        },
        async all() {
          return { success: true, results: [] };
        },
      };
    },
  } as unknown as D1RuntimeDatabase;
  await wrapD1BindingWithReadCost(noMeta, missing).prepare("select 1").bind().all();
  assert.equal(missing.rowsReadAvailable, false);
});
