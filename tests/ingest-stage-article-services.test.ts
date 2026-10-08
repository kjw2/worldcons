import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { emitDatabaseDdl } from "@/lib/cloudflare/d1/ddl";
import { d1Schema } from "@/lib/cloudflare/d1/schema";
import { setRuntimeD1Bindings, type D1RuntimeDatabase, type D1RuntimePreparedStatement } from "@/lib/cloudflare/d1/runtime-binding";
import { runD1PublishArticle } from "@/lib/cloudflare/publication/d1-publication-drain";
import { syncSearchProjectionForArticle } from "@/lib/cloudflare/search-projection/d1-sync";

const ARTICLE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const NOW = "2026-10-08T00:00:00.000Z";

function binding(database: DatabaseSync): D1RuntimeDatabase {
  return {
    prepare(sql: string): D1RuntimePreparedStatement {
      const statement = database.prepare(sql);
      let values: SQLInputValue[] = [];
      const chain: D1RuntimePreparedStatement = {
        bind(...args: unknown[]) { values = args as SQLInputValue[]; return chain; },
        async all<T = Record<string, unknown>>() {
          try { return { success: true, results: statement.all(...values) as unknown as T[] }; }
          catch (error) { return { success: false, results: [], error: error instanceof Error ? error.message : String(error) }; }
        },
        async run() {
          try { const result = statement.run(...values); return { success: true, meta: { changes: Number(result.changes) } }; }
          catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
        },
      };
      return chain;
    },
    async batch(statements) {
      database.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run?.() ?? { success: false });
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

function publishableMetadata() {
  return JSON.stringify({
    collection: { publishable: true, sourceTextAvailable: true, sourceUrlVerified: true, strategy: "fetch" },
  });
}

function insertArticle(core: DatabaseSync, id: string, fields: { status: string; summaryJson: string | null; translation: string; metadata: string; title?: string }) {
  core.prepare(`INSERT INTO articles
    (id,slug,source_key,jurisdiction,institution_name,content_type,original_url,canonical_url,original_language,original_title,korean_title,original_published_at,discovered_at,fetched_at,summarized_at,status,cleaned_text,summary_json,content_hash,source_metadata,created_at,updated_at,translation_status,lifecycle_collection_state,lifecycle_processing_state,lifecycle_review_state,lifecycle_attention_state,lifecycle_revision)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, `slug-${id}`, "fr-conseil-constitutionnel", "France", "Conseil constitutionnel", "decision",
    `https://example.test/${id}`, `https://example.test/${id}`, "fr", "Décision", fields.title ?? "결정 요약",
    "2026-09-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z", NOW, fields.status === "summarized" ? NOW : null, fields.status,
    "x".repeat(600), fields.summaryJson, `content-${id}`, fields.metadata, NOW, NOW, fields.translation,
    "source_text_ready", fields.status === "summarized" ? "complete" : "ready", "unreviewed", "clear", "0",
  );
}

function setup() {
  const core = new DatabaseSync(":memory:");
  const search = new DatabaseSync(":memory:");
  core.exec(emitDatabaseDdl("worldcons_core", d1Schema));
  search.exec(emitDatabaseDdl("worldcons_search", d1Schema));
  const coreDb = binding(core);
  const searchDb = binding(search);
  setRuntimeD1Bindings({ worldcons_core: coreDb, worldcons_search: searchDb });
  return { core, search, coreDb, searchDb };
}

test("runD1PublishArticle publishes exactly the named article and leaves other pending rows untouched", async () => {
  const { core, search } = setup();
  try {
    insertArticle(core, ARTICLE_ID, { status: "summarized", summaryJson: JSON.stringify({ koreanTitle: "요약", aiMetadata: { provider: "gemini", model: "fake" } }), translation: "translated", metadata: publishableMetadata() });
    insertArticle(core, OTHER_ID, { status: "summarized", summaryJson: JSON.stringify({ aiMetadata: { provider: "gemini" } }), translation: "translated", metadata: publishableMetadata() });

    const result = await runD1PublishArticle({ articleId: ARTICLE_ID });
    assert.equal(result.published, true);
    assert.equal(result.state, "published");
    assert.ok(result.versionId, "a version id is confirmed");
    assert.equal(result.idempotent, false);

    const target = core.prepare("SELECT state,version_id,revision FROM article_publications_p3 WHERE article_id=?").get(ARTICLE_ID) as { state: string; version_id: string };
    assert.equal(target.state, "published");
    assert.equal(target.version_id, result.versionId);
    assert.equal(core.prepare("SELECT COUNT(*) n FROM article_publications_p3 WHERE article_id=?").get(OTHER_ID)?.n, 0, "the other article is never swept up");
    // The version snapshot captured the exact article state.
    const version = core.prepare("SELECT cleaned_text,summary_json,version_role FROM article_content_versions_p3 WHERE id=?").get(result.versionId) as { cleaned_text: string; version_role: string | null };
    assert.equal(version.cleaned_text.length, 600);
    assert.equal(version.version_role, null);
    // Immutable freshness was reconciled for the published version.
    assert.equal(core.prepare("SELECT COUNT(*) n FROM legacy_version_freshness_classifications_v4 WHERE version_id=? AND freshness='current'").get(result.versionId)?.n, 1);

    // Idempotent replay: the same article reports published without a second version.
    const replay = await runD1PublishArticle({ articleId: ARTICLE_ID });
    assert.equal(replay.published, true);
    assert.equal(replay.idempotent, true);
    assert.equal(core.prepare("SELECT COUNT(*) n FROM article_content_versions_p3 WHERE article_id=?").get(ARTICLE_ID)?.n, 1);
    void search;
  } finally {
    core.close(); search.close();
  }
});

test("runD1PublishArticle fail-closes an ineligible row (source_only provenance) without publishing", async () => {
  const { core, search } = setup();
  try {
    insertArticle(core, ARTICLE_ID, {
      status: "summarized",
      summaryJson: JSON.stringify({ aiMetadata: { provider: "gemini" } }),
      translation: "translated",
      metadata: JSON.stringify({ collection: { publishable: false, sourceTextAvailable: false, sourceUrlVerified: false, strategy: "fetch" } }),
    });
    const result = await runD1PublishArticle({ articleId: ARTICLE_ID });
    assert.equal(result.published, false);
    assert.equal(result.skippedReason, "ineligible");
    assert.equal(core.prepare("SELECT COUNT(*) n FROM article_publications_p3").get()?.n, 0);
    void search;
  } finally {
    core.close(); search.close();
  }
});

test("syncSearchProjectionForArticle projects exactly one published article and enforces per-article integrity", async () => {
  const { core, search, coreDb, searchDb } = setup();
  try {
    insertArticle(core, ARTICLE_ID, { status: "summarized", summaryJson: JSON.stringify({ koreanTitle: "요약", aiMetadata: { provider: "gemini" } }), translation: "translated", metadata: publishableMetadata() });
    insertArticle(core, OTHER_ID, { status: "summarized", summaryJson: JSON.stringify({ aiMetadata: { provider: "gemini" } }), translation: "translated", metadata: publishableMetadata() });
    const published = await runD1PublishArticle({ articleId: ARTICLE_ID });
    assert.equal(published.published, true);

    // Before projection the article is published but not yet searchable.
    assert.equal(search.prepare("SELECT COUNT(*) n FROM search_documents").get()?.n, 0);

    const result = await syncSearchProjectionForArticle({ WORLDCONS_CORE: coreDb, WORLDCONS_SEARCH: searchDb }, ARTICLE_ID);
    assert.equal(result.desiredEligible, true);
    assert.equal(result.documentCount, 1);
    assert.equal(result.ftsCount, 1);
    assert.equal(result.changes.added, 1);
    assert.equal(search.prepare("SELECT COUNT(*) n FROM search_documents").get()?.n, 1);
    assert.equal(search.prepare("SELECT COUNT(*) n FROM search_fts").get()?.n, 1);
    assert.equal(search.prepare("SELECT article_id FROM search_documents").get()?.article_id, ARTICLE_ID, "only the named article is projected");
    assert.equal(search.prepare("SELECT article_id FROM search_documents WHERE article_id=?").get(OTHER_ID), undefined);

    // Re-running is a no-op (unchanged), not a duplicate.
    const replay = await syncSearchProjectionForArticle({ WORLDCONS_CORE: coreDb, WORLDCONS_SEARCH: searchDb }, ARTICLE_ID);
    assert.equal(replay.changes.unchanged, 1);
    assert.equal(search.prepare("SELECT COUNT(*) n FROM search_fts").get()?.n, 1);

    // Withdrawing the publication removes the article's search identity when re-projected.
    core.prepare("UPDATE article_publications_p3 SET state='withdrawn' WHERE article_id=?").run(ARTICLE_ID);
    const removed = await syncSearchProjectionForArticle({ WORLDCONS_CORE: coreDb, WORLDCONS_SEARCH: searchDb }, ARTICLE_ID);
    assert.equal(removed.desiredEligible, false);
    assert.equal(removed.documentCount, 0);
    assert.equal(removed.ftsCount, 0);
    assert.equal(removed.changes.removed, 1);
  } finally {
    core.close(); search.close();
  }
});
