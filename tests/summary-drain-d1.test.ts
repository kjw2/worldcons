import assert from "node:assert/strict";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";
import { setRuntimeD1Bindings, type D1RuntimeDatabase, type D1RuntimePreparedStatement } from "@/lib/cloudflare/d1/runtime-binding";
import { runD1SummaryDrain } from "@/lib/cloudflare/summary/d1-summary-drain";
import { runD1PublicationDrain } from "@/lib/cloudflare/publication/d1-publication-drain";

const goodSummary = {
  koreanTitle: "결정 요약",
  originalTitle: "Decision",
  summary: {
    coreSummary: ["핵심 내용"],
    referencedProvisions: [],
    background: "배경",
    caseStructure: "구조",
    implications: "의미",
    practicalNotes: "참고",
  },
  entities: [{ name: "헌법재판소", normalizedName: "헌법재판소", type: "court" }],
  tags: ["표현의 자유"],
  categories: [],
  riskFlags: [],
  aiMetadata: { provider: "gemini", model: "gemini-test-model", generatedAt: "2026-09-29T00:00:00.000Z" },
};

function setup(options: { status?: string; metadata?: unknown; createdAt?: string; updatedAt?: string } = {}) {
  const core = new DatabaseSync(":memory:");
  const ingest = new DatabaseSync(":memory:");
  core.exec(`
    CREATE TABLE articles (
      id TEXT PRIMARY KEY, slug TEXT NOT NULL, source_key TEXT NOT NULL, jurisdiction TEXT NOT NULL,
      institution_name TEXT NOT NULL, content_type TEXT NOT NULL, original_url TEXT NOT NULL,
      canonical_url TEXT NOT NULL, original_language TEXT NOT NULL, original_title TEXT,
      korean_title TEXT, original_published_at TEXT, discovered_at TEXT NOT NULL, fetched_at TEXT,
      summarized_at TEXT, status TEXT NOT NULL, cleaned_text TEXT, summary_json TEXT,
      translation_status TEXT NOT NULL DEFAULT 'pending', translation_started_at TEXT, translated_at TEXT,
      translation_provider TEXT, translation_model TEXT, translation_attempt_count INTEGER NOT NULL DEFAULT 0,
      translation_error_code TEXT, translation_error_summary TEXT, translation_next_attempt_at TEXT,
      content_hash TEXT, source_metadata TEXT, error_metadata TEXT, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, error_class TEXT, error_context TEXT, review_state TEXT,
      lifecycle_collection_state TEXT, lifecycle_processing_state TEXT, lifecycle_review_state TEXT,
      lifecycle_attention_state TEXT, lifecycle_attention_code TEXT, lifecycle_attention_retryable INTEGER,
      lifecycle_attention_severity TEXT, lifecycle_attention_source TEXT, lifecycle_attention_raised_at TEXT,
      lifecycle_attention_cleared_at TEXT, lifecycle_revision TEXT NOT NULL DEFAULT '0', lifecycle_changed_at TEXT,
      lifecycle_collection_changed_at TEXT, lifecycle_processing_changed_at TEXT, lifecycle_review_changed_at TEXT,
      lifecycle_attention_changed_at TEXT, case_key TEXT, embedding_provider TEXT, embedding_model TEXT,
      embedding_dimensions INTEGER, embedding_input_hash TEXT, embedding_generated_at TEXT,
      raw_text_storage_ref TEXT, raw_text_blob_hash TEXT, raw_text_blob_size TEXT, raw_text_externalized_at TEXT,
      raw_text_blob_contract_version TEXT
    );
    CREATE TABLE tags (id TEXT PRIMARY KEY, slug TEXT UNIQUE, name TEXT, normalized_name TEXT, type TEXT, description TEXT, article_count INTEGER NOT NULL DEFAULT 0, latest_article_at TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE article_tags (article_id TEXT, tag_id TEXT, confidence REAL, created_at TEXT, PRIMARY KEY(article_id,tag_id));
    CREATE TABLE article_lifecycle_events_p2 (id TEXT PRIMARY KEY, article_id TEXT, idempotency_key TEXT, from_revision TEXT, to_revision TEXT, actor_type TEXT, actor_id TEXT, transition_source TEXT, reason_code TEXT, applied INTEGER, collection_state TEXT, processing_state TEXT, review_state TEXT, attention_state TEXT, attention_code TEXT, attention_retryable INTEGER, attention_severity TEXT, attention_source TEXT, occurred_at TEXT, UNIQUE(article_id,idempotency_key));
    CREATE TABLE article_version_heads_p3 (article_id TEXT PRIMARY KEY, current_version_id TEXT, current_revision TEXT, updated_at TEXT);
    CREATE TABLE article_content_versions_p3 (id TEXT PRIMARY KEY, article_id TEXT, revision TEXT, parent_version_id TEXT, content_hash TEXT, provenance_actor_type TEXT, provenance_actor_id TEXT, model_ref TEXT, prompt_ref TEXT, slug TEXT, source_key TEXT, jurisdiction TEXT, institution_name TEXT, content_type TEXT, original_url TEXT, canonical_url TEXT, original_language TEXT, original_title TEXT, korean_title TEXT, original_published_at TEXT, discovered_at TEXT, fetched_at TEXT, summarized_at TEXT, cleaned_text TEXT, summary_json TEXT, source_metadata TEXT, error_metadata TEXT, created_at TEXT, case_key TEXT, version_document_schema TEXT, version_role TEXT, raw_text_storage_ref TEXT, raw_text_blob_hash TEXT, raw_text_blob_size TEXT, raw_text_externalized_at TEXT, raw_text_blob_contract_version TEXT);
    CREATE TABLE article_publications_p3 (id TEXT PRIMARY KEY, article_id TEXT UNIQUE, state TEXT, version_id TEXT, revision TEXT, decided_by_type TEXT, decided_by_id TEXT, reason TEXT, published_at TEXT, withdrawn_at TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE article_publication_requests_p3 (id TEXT PRIMARY KEY, article_id TEXT, idempotency_key TEXT, publication_id TEXT, publication_revision TEXT, version_id TEXT, version_revision TEXT, state TEXT, version_created INTEGER, publication_applied INTEGER, created_at TEXT, UNIQUE(article_id,idempotency_key));
    CREATE TABLE article_publication_history_p3 (id TEXT PRIMARY KEY, publication_id TEXT, article_id TEXT, publication_revision TEXT, from_state TEXT, to_state TEXT, from_version_id TEXT, to_version_id TEXT, idempotency_key TEXT, actor_type TEXT, actor_id TEXT, reason TEXT, request_id TEXT, correlation_id TEXT, occurred_at TEXT, UNIQUE(article_id,idempotency_key));
    CREATE TABLE article_audit_ledger_p3 (id TEXT PRIMARY KEY, article_id TEXT, ledger_revision TEXT, event_type TEXT, article_version_id TEXT, publication_id TEXT, publication_revision TEXT, actor_type TEXT, actor_id TEXT, reason TEXT, request_id TEXT, correlation_id TEXT, safe_metadata TEXT, previous_entry_hash TEXT, entry_hash TEXT, occurred_at TEXT, UNIQUE(article_id,ledger_revision));
    CREATE TABLE article_cache_outbox_p3 (id TEXT PRIMARY KEY, event_key TEXT UNIQUE, event_type TEXT, article_id TEXT, publication_id TEXT, publication_revision TEXT, version_id TEXT, publication_state TEXT, article_slug TEXT, status TEXT, attempt_count INTEGER, max_attempts INTEGER, available_at TEXT, created_at TEXT, updated_at TEXT, UNIQUE(publication_id,publication_revision));
    CREATE TABLE legacy_version_freshness_classifications_v4 (version_id TEXT PRIMARY KEY, article_id TEXT, freshness TEXT, freshness_basis TEXT, source_anchor_version_id TEXT, source_content_hash TEXT, evidence TEXT, classified_at TEXT, classified_by TEXT);
    CREATE TABLE article_embedding_artifacts (article_version_id TEXT PRIMARY KEY, article_id TEXT, content_hash TEXT, provider TEXT, model TEXT, dimensions INTEGER, input_hash TEXT, generated_at TEXT, updated_at TEXT);
    CREATE TABLE glossary_terms (id TEXT PRIMARY KEY, slug TEXT, term TEXT, korean_term TEXT, definition TEXT, jurisdiction TEXT, related_tags TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE glossary_candidates (id TEXT PRIMARY KEY, tag_slug TEXT UNIQUE, tag_name TEXT, tag_type TEXT, article_count INTEGER, suggested_slug TEXT, source_languages TEXT, status TEXT, generated_at TEXT, reviewed_at TEXT, created_at TEXT, updated_at TEXT);
  `);
  const metadata = JSON.stringify(options.metadata ?? { collection: { publishable: true, sourceTextAvailable: true, sourceUrlVerified: true, strategy: "fetch" } });
  const insert = core.prepare(`INSERT INTO articles (id,slug,source_key,jurisdiction,institution_name,content_type,original_url,canonical_url,original_language,original_title,original_published_at,discovered_at,summarized_at,status,cleaned_text,source_metadata,created_at,updated_at,lifecycle_collection_state,lifecycle_processing_state,lifecycle_review_state,lifecycle_attention_state) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    insert.run("11111111-1111-4111-8111-111111111111", "article-1", "scotus", "United States", "Supreme Court", "opinion", "https://example.test/1", "https://example.test/1", "en", "Decision", "2026-09-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z", null, options.status ?? "cleaned", "x".repeat(600), metadata, options.createdAt ?? "2026-09-01T00:00:00.000Z", options.updatedAt ?? "2026-09-01T00:00:00.000Z", "source_text_ready", "ready", "unreviewed", "clear");
  const tag = core.prepare("INSERT INTO tags VALUES ('tag-1','existing','Existing','Existing','topic',NULL,1,NULL,'now','now')");
  tag.run();
  core.prepare("INSERT INTO article_tags VALUES ('11111111-1111-4111-8111-111111111111','tag-1',0.8,'now')").run();
  ingest.exec("CREATE TABLE ingestion_runs (id TEXT PRIMARY KEY, summarized_count INTEGER NOT NULL DEFAULT 0)");
  ingest.prepare("INSERT INTO ingestion_runs VALUES ('11111111-1111-4111-8111-111111111111',0)").run();
  ingest.exec("CREATE TABLE source_backfill_items (id TEXT PRIMARY KEY,article_id TEXT,status TEXT,verified_normalization_artifact_id TEXT,published_normalization_artifact_id TEXT,updated_at TEXT)");
  ingest.prepare("INSERT INTO source_backfill_items VALUES ('backfill-1','11111111-1111-4111-8111-111111111111','verified','artifact-1',NULL,'now')").run();
  const toBinding = (database: DatabaseSync): D1RuntimeDatabase => ({
    prepare(sql) {
      const statement = database.prepare(sql);
      let values: SQLInputValue[] = [];
      const chain: D1RuntimePreparedStatement = {
        bind(...args) { values = args as SQLInputValue[]; return chain; },
        async all<T>() { return { success: true, results: statement.all(...values) as unknown as T[] }; },
        async run() { const result = statement.run(...values); return { success: true, meta: { changes: Number(result.changes) } }; },
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
  });
  setRuntimeD1Bindings({ worldcons_core: toBinding(core), worldcons_ingest: toBinding(ingest) });
  return { core, ingest };
}

function close({ core, ingest }: { core: DatabaseSync; ingest: DatabaseSync }) {
  core.close();
  ingest.close();
}

test("D1 summary candidate selection enforces publishability, source, and round-robin ordering", async () => {
  const db = setup();
  db.core.prepare("INSERT INTO articles (id,slug,source_key,jurisdiction,institution_name,content_type,original_url,canonical_url,original_language,discovered_at,status,cleaned_text,source_metadata,created_at,updated_at) VALUES ('not-publishable','not-publishable','scotus','US','Court','opinion','u','u2','en','now','cleaned',?,'{}','2026-01-01','2026-01-01')").run("x".repeat(600));
  const selected = await runD1SummaryDrain({ limit: 1, maxPasses: 1, sourceKey: "scotus", apiKeys: [] });
  assert.equal(selected.candidateCount, 1, "only publishable rows are selected");
  assert.equal(selected.status, "unavailable");
  close(db);
});

test("D1 summary candidate selection accepts legacy backfill metadata nested under case.collection", async () => {
  const db = setup({
    metadata: {
      catalog: { sourceOnly: true },
      case: { collection: { publishable: true, sourceTextAvailable: true, sourceUrlVerified: true, strategy: "fetch" } },
    },
  });
  const selected = await runD1SummaryDrain({ limit: 1, maxPasses: 1, apiKeys: [] });
  assert.equal(selected.candidateCount, 1);
  assert.equal(selected.status, "unavailable");
  close(db);
});

test("D1 stale summary recovery persists failure triage and lifecycle attention", async () => {
  const db = setup({ status: "summarizing", updatedAt: "2000-01-01T00:00:00.000Z" });
  const result = await runD1SummaryDrain({ limit: 1, maxPasses: 1, apiKeys: [] });
  assert.equal(result.recoveredStale.recoveredCount, 1);
  const article = db.core.prepare("SELECT status,error_class,review_state FROM articles WHERE id='11111111-1111-4111-8111-111111111111'").get();
  assert.deepEqual({ ...article }, { status: "failed_summary", error_class: "job.stale_running", review_state: "needs_triage" });
  assert.equal(db.core.prepare("SELECT COUNT(*) count FROM article_lifecycle_events_p2 WHERE reason_code='legacy.summary.stale_recovered'").get()?.count, 1);
  close(db);
});

test("D1 translation/enrichment completion stays private until the separate publication drain runs", async () => {
  const db = setup({ metadata: { collection: { diagnosticsId: "11111111-1111-4111-8111-111111111111", publishable: true, sourceTextAvailable: true, sourceUrlVerified: true, strategy: "fetch" } } });
  try {
    let summaryCalls = 0;
    const result = await runD1SummaryDrain({
      limit: 1,
      maxPasses: 1,
      retryAttempts: 1,
      retryDelayMs: 1_000,
      apiKeys: ["test-key"],
      summarize: async () => {
        summaryCalls += 1;
        if (summaryCalls === 1) throw new Error("Gemini 429 quota; retry after 0 ms");
        return goodSummary as never;
      },
      createEmbedding: async () => null,
    });
    assert.equal(summaryCalls, 2);
    assert.equal(result.retryCount, 1);
    assert.equal(result.summarizedCount, 1);
    assert.equal(result.status, "completed");
    assert.deepEqual(
      { ...db.core.prepare("SELECT status,translation_status FROM articles WHERE id='11111111-1111-4111-8111-111111111111'").get() as Record<string, unknown> },
      { status: "summarized", translation_status: "translated" },
    );
    assert.equal(db.core.prepare("SELECT COUNT(*) count FROM article_tags WHERE article_id='11111111-1111-4111-8111-111111111111'").get()?.count, 2);
    assert.equal(db.core.prepare("SELECT COUNT(*) count FROM tags t JOIN article_tags at ON at.tag_id=t.id WHERE at.article_id='11111111-1111-4111-8111-111111111111' AND t.article_count=1").get()?.count, 2);
    assert.equal(db.core.prepare("SELECT article_count FROM tags WHERE slug='existing'").get()?.article_count, 0);
    assert.equal(db.core.prepare("SELECT COUNT(*) count FROM article_publications_p3 WHERE state='published'").get()?.count, 0, "translation completion alone must not publish");
    assert.equal(db.core.prepare("SELECT COUNT(*) count FROM article_cache_outbox_p3 WHERE status='pending'").get()?.count, 0, "translation completion must not emit a public outbox event");
    assert.equal(db.ingest.prepare("SELECT summarized_count FROM ingestion_runs WHERE id='11111111-1111-4111-8111-111111111111'").get()?.summarized_count, 1);
    assert.deepEqual(
      { ...db.ingest.prepare("SELECT status,published_normalization_artifact_id FROM source_backfill_items WHERE id='backfill-1'").get() as Record<string, unknown> },
      { status: "verified", published_normalization_artifact_id: null },
    );

    const publication = await runD1PublicationDrain({ limit: 10 });
    assert.equal(publication.publishedCount, 1);
    assert.equal(publication.failedCount, 0);
    assert.equal(db.core.prepare("SELECT COUNT(*) count FROM article_publications_p3 WHERE state='published'").get()?.count, 1);
    assert.equal(db.core.prepare("SELECT COUNT(*) count FROM article_cache_outbox_p3 WHERE status='pending'").get()?.count, 1);
    assert.equal(db.core.prepare("SELECT COUNT(*) count FROM legacy_version_freshness_classifications_v4 WHERE freshness='current'").get()?.count, 1);
    assert.deepEqual(
      { ...db.ingest.prepare("SELECT status,published_normalization_artifact_id FROM source_backfill_items WHERE id='backfill-1'").get() as Record<string, unknown> },
      { status: "published", published_normalization_artifact_id: "artifact-1" },
    );
  } finally {
    close(db);
  }
});

test("D1 summary failure persists status, structured triage, and lifecycle attention", async () => {
  const db = setup();
  try {
    const result = await runD1SummaryDrain({
      limit: 1,
      maxPasses: 1,
      apiKeys: ["test-key"],
      summarize: async () => { throw new Error("model returned invalid content"); },
    });
    assert.equal(result.failedCount, 1);
    assert.equal(result.status, "failed");
    const article = db.core.prepare("SELECT status,translation_status,error_class,review_state FROM articles WHERE id='11111111-1111-4111-8111-111111111111'").get();
    assert.deepEqual({ ...article }, { status: "failed_summary", translation_status: "failed", error_class: "summary.model_error", review_state: "needs_triage" });
    assert.equal(db.core.prepare("SELECT COUNT(*) count FROM article_lifecycle_events_p2 WHERE reason_code='legacy.summary.failed'").get()?.count, 1);
  } finally {
    close(db);
  }
});
