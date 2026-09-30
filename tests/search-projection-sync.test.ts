import assert from "node:assert/strict";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";
import { emitDatabaseDdl } from "../lib/cloudflare/d1/ddl";
import { d1Schema } from "../lib/cloudflare/d1/schema";
import {
  buildSearchProjection,
  planSearchProjectionIncrementalSync,
  verifySearchProjection,
} from "../lib/cloudflare/search-projection";
import {
  SEARCH_PROJECTION_SYNC_BATCH_SIZE,
  SEARCH_PROJECTION_SYNC_PAGE_SIZE,
  applySearchProjectionPlan,
  buildSearchProjectionInputFromEligibleRows,
  type SearchProjectionSyncDatabase,
} from "../workers/async-pipeline/src/search-projection-sync";

function localBinding(db: DatabaseSync): SearchProjectionSyncDatabase {
  return {
    prepare(sql: string) {
      const statement = db.prepare(sql);
      let bound: SQLInputValue[] = [];
      const chain = {
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
        async run() {
          try {
            statement.run(...bound);
            return { success: true };
          } catch (error) {
            return { success: false, error: error instanceof Error ? error.message : String(error) };
          }
        },
      };
      return chain;
    },
    async batch(statements) {
      db.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run!());
        if (results.some((result) => result.success === false || result.error)) throw new Error("batch failed");
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

test("eligible Core rows build and apply a verified 1:1 D1 search projection", async () => {
  const sourceRows = [
    {
      publication_id: "p1",
      article_id: "a1",
      publication_state: "published",
      publication_version_id: "v1",
      publication_revision: "1",
      publication_published_at: "2026-09-30T00:00:00.000Z",
      publication_withdrawn_at: null,
      publication_created_at: "2026-09-30T00:00:00.000Z",
      publication_updated_at: "2026-09-30T00:00:00.000Z",
      version_id: "v1",
      version_revision: "1",
      slug: "case-a1",
      source_key: "de-bverfg",
      jurisdiction: "Germany",
      institution_name: "BVerfG",
      content_type: "decision",
      original_language: "de",
      original_title: "Klimaschutz Beschluss",
      korean_title: "기후보호 결정",
      original_published_at: "2026-09-29T00:00:00.000Z",
      cleaned_text: "klimaschutz grundrechte",
      summary_json: JSON.stringify({ summary: { coreSummary: ["기후 기본권"] } }),
      source_metadata: JSON.stringify({ caseNumber: "1 BvR 2656/18" }),
      case_key: "1bvr265618",
      version_created_at: "2026-09-30T00:00:00.000Z",
      fetched_at: "2026-09-30T00:00:00.000Z",
      summarized_at: "2026-09-30T00:00:00.000Z",
      content_hash: "hash-a1",
      version_role: null,
      source_anchor_version_id: null,
      enrichment_source_content_hash: null,
      source_content_hash: null,
      review_state: "approved",
    },
  ];
  const tagRows = [
    { article_id: "a1", tag_id: "t1", confidence: 0.9, slug: "climate", name: "Climate", normalized_name: "climate", type: "topic" },
  ];
  const input = buildSearchProjectionInputFromEligibleRows(sourceRows, tagRows);
  const built = buildSearchProjection(input);
  assert.equal(built.documents.length, 1);
  assert.equal(built.ftsDocuments.length, 1);
  assert.match(built.documents[0].search_text ?? "", /klimaschutz/);
  assert.match(built.documents[0].tags_text ?? "", /climate/);

  const db = new DatabaseSync(":memory:");
  db.exec(emitDatabaseDdl("worldcons_search", d1Schema));
  const binding = localBinding(db);
  const plan = planSearchProjectionIncrementalSync([], built.documents, built.ftsDocuments);
  assert.equal(plan.changes.added, 1);
  assert.equal(SEARCH_PROJECTION_SYNC_PAGE_SIZE, 50);
  assert.ok(SEARCH_PROJECTION_SYNC_BATCH_SIZE <= 100);
  assert.equal(await applySearchProjectionPlan(binding, plan), 1);

  const documents = db.prepare("SELECT article_id,checksum,projection_version FROM search_documents ORDER BY article_id").all() as Array<{ article_id: string; checksum: string; projection_version: number }>;
  const fts = db.prepare("SELECT article_id FROM search_fts ORDER BY article_id").all() as Array<{ article_id: string }>;
  const verification = verifySearchProjection({ projected: built.documents, documents, ftsArticleIds: fts.map((row) => row.article_id) });
  assert.equal(verification.ok, true);
  assert.equal(verification.documentCount, 1);
  assert.equal(verification.ftsCount, 1);
});

test("sync batch size stays within the bounded D1 batch envelope", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(emitDatabaseDdl("worldcons_search", d1Schema));
  const binding = localBinding(db);
  await assert.rejects(
    () => applySearchProjectionPlan(binding, {
      scope: "worldcons_search",
      operation: "incremental",
      destructive: false,
      atomic: false,
      executionDeferred: true,
      noop: true,
      changes: { added: 0, changed: 0, removed: 0, unchanged: 0 },
      statements: [],
    }, 101),
    /search_projection\.invalid_batch_size/,
  );
});
