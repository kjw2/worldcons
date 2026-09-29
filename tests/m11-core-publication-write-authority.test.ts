import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  resolveCoreWriteAuthorityConfig,
  resolveCoreWriteCanaryMarker,
  shouldUseD1CoreWrite,
  transitionArticleLifecycleInD1,
  transitionArticlePublicationInD1,
} from "@/lib/cloudflare/core-write/authority";
import type {
  D1RuntimeDatabase,
  D1RuntimePreparedStatement,
  D1RuntimeResult,
} from "@/lib/cloudflare/d1/runtime-binding";

class FakeStatement implements D1RuntimePreparedStatement {
  values: unknown[] = [];
  constructor(
    readonly sql: string,
    private readonly resolver: (sql: string, values: unknown[]) => Record<string, unknown>[],
  ) {}
  bind(...values: unknown[]) {
    this.values = values;
    return this;
  }
  async all<T = Record<string, unknown>>(): Promise<D1RuntimeResult<T>> {
    return { success: true, results: this.resolver(this.sql, this.values) as T[] };
  }
  async run(): Promise<D1RuntimeResult> {
    return { success: true, meta: { changes: 1 } };
  }
}

class FakeD1 implements D1RuntimeDatabase {
  readonly prepared: FakeStatement[] = [];
  readonly batches: FakeStatement[][] = [];
  constructor(private readonly resolver: (sql: string, values: unknown[]) => Record<string, unknown>[]) {}
  prepare(sql: string) {
    const statement = new FakeStatement(sql, this.resolver);
    this.prepared.push(statement);
    return statement;
  }
  async batch(statements: D1RuntimePreparedStatement[]): Promise<D1RuntimeResult[]> {
    const typed = statements as FakeStatement[];
    this.batches.push(typed);
    return typed.map(() => ({ success: true, meta: { changes: 1 } }));
  }
}

test("M13 core authority defaults to D1 and d1-canary remains explicit", () => {
  assert.equal(resolveCoreWriteAuthorityConfig({}).authority, "d1");
  assert.equal(resolveCoreWriteAuthorityConfig({ WORLDCONS_CORE_WRITE_AUTHORITY: "invalid" }).authority, "d1");
  assert.equal(resolveCoreWriteAuthorityConfig({ WORLDCONS_CORE_WRITE_AUTHORITY: "d1-canary" }).authority, "d1-canary");
  assert.equal(resolveCoreWriteAuthorityConfig({ WORLDCONS_CORE_WRITE_AUTHORITY: "d1" }).authority, "d1");
  assert.equal(shouldUseD1CoreWrite({ authority: "supabase" }, true), false);
  assert.equal(shouldUseD1CoreWrite({ authority: "d1-canary" }, false), false);
  assert.equal(shouldUseD1CoreWrite({ authority: "d1-canary" }, true), true);
  assert.equal(shouldUseD1CoreWrite({ authority: "d1" }, false), true);
});

test("M11-C canary marker is bounded to true/1 or exact GitHub run id", () => {
  assert.equal(resolveCoreWriteCanaryMarker({ WORLDCONS_CORE_WRITE_CANARY_MARKER: "true" }), true);
  assert.equal(resolveCoreWriteCanaryMarker({ WORLDCONS_CORE_WRITE_CANARY_MARKER: "1" }), true);
  assert.equal(resolveCoreWriteCanaryMarker({ WORLDCONS_CORE_WRITE_CANARY_MARKER: "42", GITHUB_RUN_ID: "42" }), true);
  assert.equal(resolveCoreWriteCanaryMarker({ WORLDCONS_CORE_WRITE_CANARY_MARKER: "42", GITHUB_RUN_ID: "43" }), false);
});

test("M11-C lifecycle transition is a D1 batch with optimistic revision and append-only event", async () => {
  const articleId = "11111111-1111-4111-a111-111111111111";
  const db = new FakeD1((sql) => {
    if (sql.includes("FROM article_lifecycle_events_p2")) return [];
    if (sql.includes("SELECT * FROM articles")) {
      return [{
        id: articleId,
        lifecycle_revision: "3",
        lifecycle_collection_state: "source_text_ready",
        lifecycle_processing_state: "complete",
        lifecycle_review_state: "unreviewed",
        lifecycle_attention_state: "clear",
        lifecycle_attention_code: null,
        lifecycle_attention_retryable: null,
        lifecycle_attention_severity: null,
        lifecycle_attention_source: null,
      }];
    }
    return [];
  });
  const result = await transitionArticleLifecycleInD1(db, {
    articleId,
    expectedRevision: 3,
    idempotencyKey: "m11c-lifecycle-canary",
    actorType: "summary_worker",
    source: "summary.resummary",
    reasonCode: "m11c.canary",
    processingState: "running",
  });
  assert.equal(result.ok, true);
  assert.equal(db.batches.length, 1);
  assert.equal(db.batches[0].length, 2);
  assert.match(db.batches[0][0].sql, /UPDATE articles SET/u);
  assert.match(db.batches[0][0].sql, /WHERE id=\? AND CAST\(lifecycle_revision AS INTEGER\)=\?/u);
  assert.match(db.batches[0][1].sql, /INSERT INTO article_lifecycle_events_p2/u);
  assert.match(db.batches[0][1].sql, /WHERE EXISTS/u);
  assert.equal(db.batches[0][0].values.at(-1), 3);
  assert.ok(db.batches[0].every((statement) => !statement.sql.includes(articleId)));
});

test("M11-C publication transition batches publication/history/audit/outbox/request atomically", async () => {
  const articleId = "22222222-2222-4222-a222-222222222222";
  const versionId = "33333333-3333-4333-a333-333333333333";
  const publicationId = "44444444-4444-4444-a444-444444444444";
  const db = new FakeD1((sql) => {
    if (sql.includes("FROM article_publication_requests_p3")) return [];
    if (sql.includes("SELECT * FROM articles")) {
      return [{
        id: articleId,
        lifecycle_collection_state: "source_text_ready",
        lifecycle_processing_state: "complete",
        lifecycle_review_state: "approved",
        lifecycle_attention_state: "clear",
        updated_at: "2026-09-28T00:00:00.000Z",
      }];
    }
    if (sql.includes("FROM article_version_heads_p3")) return [{ article_id: articleId, current_version_id: versionId, current_revision: "2" }];
    if (sql.includes("FROM article_content_versions_p3 WHERE id=")) {
      return [{
        id: versionId,
        article_id: articleId,
        revision: "2",
        slug: "m11c-canary",
        source_key: "m11c",
        jurisdiction: "test",
        institution_name: "M11C",
        original_url: "https://example.test/original",
        canonical_url: "https://example.test/canonical",
        original_language: "en",
        original_title: "M11C canary",
        korean_title: "M11C",
        summary_json: "{}",
        cleaned_text: "x".repeat(600),
        source_metadata: JSON.stringify({ collection: { publishable: true, sourceTextAvailable: true, sourceUrlVerified: true, robotsDisallowed: false, strategy: "api" } }),
      }];
    }
    if (sql.includes("FROM article_publications_p3")) {
      return [{ id: publicationId, article_id: articleId, state: "in_review", version_id: versionId, revision: "1" }];
    }
    if (sql.includes("FROM article_audit_ledger_p3")) return [{ ledger_revision: "5", entry_hash: "a".repeat(64) }];
    return [];
  });
  const result = await transitionArticlePublicationInD1(db, {
    articleId,
    expectedVersionRevision: 2,
    expectedPublicationRevision: 1,
    idempotencyKey: "m11c-publication-canary",
    targetState: "published",
    versionId,
    actorType: "human",
    actorId: "m11c-test",
    reason: "M11-C transactional D1 canary",
  });
  assert.equal(result.ok, true);
  assert.equal(db.batches.length, 1);
  const sql = db.batches[0].map((statement) => statement.sql).join("\n");
  assert.match(sql, /UPDATE article_publications_p3/u);
  assert.match(sql, /INSERT INTO article_publication_history_p3/u);
  assert.match(sql, /INSERT INTO article_audit_ledger_p3/u);
  assert.match(sql, /INSERT OR IGNORE INTO article_cache_outbox_p3/u);
  assert.match(sql, /INSERT INTO article_publication_requests_p3/u);
  assert.ok(db.batches[0].every((statement) => !statement.sql.includes(articleId)));
});

test("M13 root deployment persists the permanent d1 core write authority for worldcons_core", () => {
  const rootConfig = fs.readFileSync(path.join(process.cwd(), "wrangler.jsonc"), "utf8");
  assert.match(rootConfig, /"WORLDCONS_CORE_WRITE_AUTHORITY": "d1"/u);
  assert.match(rootConfig, /"binding": "WORLDCONS_CORE"/u);
  assert.match(rootConfig, /"database_name": "worldcons_core"/u);
  for (const file of [
    ".github/workflows/crawlee-worker.yml",
    ".github/workflows/summary-drain.yml",
    ".github/workflows/admin-command-worker-p1.yml",
    ".github/workflows/admin-job-worker.yml",
    ".github/workflows/embedding-backfill.yml",
  ]) {
    assert.match(
      fs.readFileSync(path.join(process.cwd(), file), "utf8"),
      /WORLDCONS_CORE_WRITE_AUTHORITY:/u,
      file,
    );
  }
});
