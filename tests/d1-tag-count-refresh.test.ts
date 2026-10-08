import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { D1_REFRESH_TAG_COUNTS_SQL, refreshD1TagCountMetrics } from "@/lib/cloudflare/summary/d1-tag-count-refresh";
import type { D1RuntimeDatabase } from "@/lib/cloudflare/d1/runtime-binding";

function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE articles(id TEXT PRIMARY KEY,status TEXT,source_metadata TEXT,original_published_at TEXT);
    CREATE TABLE tags(id TEXT PRIMARY KEY,article_count INTEGER,latest_article_at TEXT,updated_at TEXT);
    CREATE TABLE article_tags(article_id TEXT,tag_id TEXT,PRIMARY KEY(article_id,tag_id));
    INSERT INTO tags VALUES ('a',0,NULL,'old'),('b',12,'yesterday','old'),('c',0,NULL,'old');
    INSERT INTO articles VALUES
      ('one','summarized','{"collection":{"publishable":true}}','2026-01-01'),
      ('two','summarized','{"collection":{"publishable":true}}','2026-02-01'),
      ('three','summarized','{"collection":{"publishable":false}}','2026-03-01'),
      ('four','cleaned','{"collection":{"publishable":true}}','2026-04-01'),
      ('five','summarized','not-json','2026-05-01');
    INSERT INTO article_tags VALUES
      ('one','a'),('two','a'),('two','b'),('three','a'),('four','a'),('five','c');
  `);
  const binding: D1RuntimeDatabase = {
    prepare(sql) {
      const stmt = sqlite.prepare(sql);
      let args: SQLInputValue[] = [];
      const chain = {
        bind(...values: unknown[]) { args = values as SQLInputValue[]; return chain; },
        async all<T>() { return { success: true, results: stmt.all(...args) as T[] }; },
        async run() { const result = stmt.run(...args); return { success: true, meta: { changes: Number(result.changes) } }; },
      };
      return chain;
    },
  };
  return { sqlite, binding };
}

test("single-pass tag count refresh matches publishable article counts, resets empty tags, and is idempotent", async () => {
  const { sqlite, binding } = fixture();
  try {
    assert.equal(await refreshD1TagCountMetrics(binding,"2026-10-08T00:00:00Z"),2);
    assert.deepEqual(sqlite.prepare("SELECT id,article_count,latest_article_at,updated_at FROM tags ORDER BY id").all().map(row=>({...row})), [
      {id:"a",article_count:2,latest_article_at:"2026-02-01",updated_at:"2026-10-08T00:00:00Z"},
      {id:"b",article_count:1,latest_article_at:"2026-02-01",updated_at:"2026-10-08T00:00:00Z"},
      {id:"c",article_count:0,latest_article_at:null,updated_at:"old"},
    ]);
    assert.equal(await refreshD1TagCountMetrics(binding,"2026-10-08T01:00:00Z"),0);
    sqlite.prepare("UPDATE articles SET status='cleaned' WHERE id='one'").run();
    assert.equal(await refreshD1TagCountMetrics(binding,"2026-10-08T02:00:00Z"),1);
    assert.equal(sqlite.prepare("SELECT article_count FROM tags WHERE id='a'").get()?.article_count,1);
  } finally { sqlite.close(); }
});

test("query plan materializes tag statistics once, without per-tag full article_tags scans", () => {
  const {sqlite} = fixture();
  try {
    const details = sqlite.prepare(`EXPLAIN QUERY PLAN ${D1_REFRESH_TAG_COUNTS_SQL}`).all("now")
      .map(row => String(row.detail));
    assert.ok(details.some(s=>s.includes("MATERIALIZE stats")));
    assert.ok(details.some(s=>s.includes("SEARCH at") && s.includes("article_id")));
    assert.ok(!details.some(s=>s.includes("CORRELATED SCALAR SUBQUERY")));
  } finally { sqlite.close(); }
});
