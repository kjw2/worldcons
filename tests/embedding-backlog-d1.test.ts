import assert from "node:assert/strict";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";
import { setRuntimeD1Bindings, setRuntimeSearchVectorBinding, type D1RuntimeDatabase, type D1RuntimePreparedStatement } from "@/lib/cloudflare/d1/runtime-binding";
import { getEmbeddingReadiness, countMissingEmbeddings, runEmbeddingBacklog } from "@/lib/ingest/embedding-backlog";
import { persistArticleEmbedding } from "@/lib/ingest/embedding-store";
import type { EmbeddingArtifact } from "@/lib/ai/embeddings";
import type { VectorizeIndexBinding } from "@/lib/cloudflare/search-vector/types";

const summary = {
  koreanTitle: "판결",
  summary: { coreSummary: ["핵심"], background: "배경", implications: "의미" },
  tags: ["헌법"],
  entities: [{ type: "court", normalizedName: "Court" }],
};

const artifact: EmbeddingArtifact = {
  vector: Array.from({ length: 1536 }, (_value, index) => index === 0 ? 1 : 0),
  provider: "gemini",
  model: "gemini-embedding-001",
  dimensions: 1536,
  inputHash: "a".repeat(64),
  generatedAt: "2026-09-29T00:00:00.000Z",
};

function configure(database: D1RuntimeDatabase, vector: VectorizeIndexBinding | null = null) {
  setRuntimeD1Bindings({ worldcons_core: database });
  setRuntimeSearchVectorBinding(vector);
}

test("D1 candidate selection matches summarized/provenance/source/limit semantics", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE articles (
      id TEXT, source_key TEXT, status TEXT, summary_json TEXT, created_at TEXT,
      embedding_provider TEXT, embedding_model TEXT, embedding_dimensions INTEGER, embedding_input_hash TEXT
    );
    INSERT INTO articles VALUES
      ('eligible-old', 'scotus', 'summarized', '{"koreanTitle":"one"}', '2026-01-01', NULL, NULL, NULL, NULL),
      ('eligible-wrong', 'scotus', 'summarized', '{"koreanTitle":"two"}', '2026-01-02', 'openai', 'wrong', 3, 'hash'),
      ('complete', 'scotus', 'summarized', '{"koreanTitle":"three"}', '2026-01-03', 'gemini', 'gemini-embedding-001', 1536, 'hash'),
      ('other-source', 'bverfg', 'summarized', '{"koreanTitle":"four"}', '2026-01-04', NULL, NULL, NULL, NULL),
      ('not-summarized', 'scotus', 'fetched', '{"koreanTitle":"five"}', '2026-01-05', NULL, NULL, NULL, NULL);
  `);
  const binding: D1RuntimeDatabase = {
    prepare(sql) {
      const statement = database.prepare(sql);
      let values: SQLInputValue[] = [];
      const chain: D1RuntimePreparedStatement = {
        bind(...args) { values = args as SQLInputValue[]; return chain; },
        async all<T>() {
          return { success: true, results: statement.all(...values) as unknown as T[] };
        },
      };
      return chain;
    },
  };
  configure(binding);
  assert.equal(await countMissingEmbeddings("scotus"), 2);
  const selected = await runEmbeddingBacklog({ sourceKey: "scotus", limit: 1 });
  assert.equal(selected.status, "completed");
  assert.equal(selected.scanned, 1);
  assert.equal(selected.skipped, 1, "valid D1 JSON parses while unconfigured provider execution is a no-vector skip");
  database.close();
});

test("embedding candidate read uses D1 summarized provenance predicate and source filter", async () => {
  let capturedQuery = "";
  let capturedValues: unknown[] = [];
  const database: D1RuntimeDatabase = {
    prepare(query) {
      capturedQuery = query;
      let values: unknown[] = [];
      const statement: D1RuntimePreparedStatement = {
        bind(...args) { values = args; capturedValues = args; return statement; },
        async all<T>() {
          if (query.startsWith("SELECT id, source_key")) {
            return { success: true, results: [{ id: "article-1", source_key: "scotus", summary_json: "not-json" }] as T[] };
          }
          return { success: true, results: [{ count: 1 }] as T[] };
        },
      };
      return statement;
    },
  };
  configure(database);
  assert.equal(await countMissingEmbeddings("scotus"), 1);
  assert.match(capturedQuery, /status = 'summarized'/u);
  assert.match(capturedQuery, /embedding_provider IS NULL/u);
  assert.match(capturedQuery, /embedding_model != 'gemini-embedding-001'/u);
  assert.match(capturedQuery, /embedding_dimensions != 1536/u);
  assert.match(capturedQuery, /embedding_input_hash IS NULL/u);
  assert.deepEqual(capturedValues, ["scotus"]);

  const backlog = await runEmbeddingBacklog({ limit: 3, sourceKey: "scotus" });
  assert.equal(backlog.status, "completed");
  assert.equal(backlog.skipped, 1, "malformed stored summary JSON is safely skipped");
  assert.match(capturedQuery, /ORDER BY created_at ASC LIMIT \?/u);
  assert.deepEqual(capturedValues, ["scotus", 3]);
});

test("D1 embedding persistence updates provenance, artifact readiness, and published summary guard", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE articles (id TEXT PRIMARY KEY, status TEXT, summary_json TEXT, embedding_provider TEXT, embedding_model TEXT, embedding_dimensions INTEGER, embedding_input_hash TEXT, embedding_generated_at TEXT);
    CREATE TABLE article_content_versions_p3 (id TEXT PRIMARY KEY, article_id TEXT, content_hash TEXT, source_key TEXT, jurisdiction TEXT, content_type TEXT, original_language TEXT, original_published_at TEXT, summary_json TEXT);
    CREATE TABLE article_publications_p3 (id TEXT PRIMARY KEY, article_id TEXT, state TEXT, version_id TEXT);
    CREATE TABLE article_embedding_artifacts (article_version_id TEXT PRIMARY KEY, article_id TEXT, content_hash TEXT, provider TEXT, model TEXT, dimensions INTEGER, input_hash TEXT, generated_at TEXT, updated_at TEXT);
  `);
  const articleSummary = { koreanTitle: "판결", nested: { a: 1, b: 2 } };
  const versionSummary = { nested: { b: 2, a: 1 }, koreanTitle: "판결" };
  database.prepare("INSERT INTO articles VALUES (?, 'summarized', ?, NULL, NULL, NULL, NULL, NULL)").run("article-1", JSON.stringify(articleSummary));
  database.prepare("INSERT INTO article_content_versions_p3 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "version-1", "article-1", "b".repeat(64), "scotus", "United States", "opinion", "en", null, JSON.stringify(versionSummary),
  );
  database.prepare("INSERT INTO article_publications_p3 VALUES (?, ?, 'published', ?)").run("publication-1", "article-1", "version-1");
  const binding: D1RuntimeDatabase = {
    prepare(sql) {
      const statement = database.prepare(sql);
      let values: SQLInputValue[] = [];
      const chain: D1RuntimePreparedStatement = {
        bind(...args) { values = args as SQLInputValue[]; return chain; },
        async all<T>() { return { success: true, results: statement.all(...values) as unknown as T[] }; },
        async run() {
          const result = statement.run(...values);
          return { success: true, meta: { changes: Number(result.changes) } };
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
  const vector = {
    async query() { return { matches: [] }; },
    async upsert() { return {}; },
  } as unknown as VectorizeIndexBinding;
  configure(binding, vector);
  await persistArticleEmbedding("article-1", artifact);
  const storedArticle = database.prepare("SELECT embedding_provider, embedding_model, embedding_dimensions, embedding_input_hash FROM articles WHERE id = ?").get("article-1");
  assert.deepEqual({ ...storedArticle }, {
    embedding_provider: "gemini", embedding_model: "gemini-embedding-001", embedding_dimensions: 1536, embedding_input_hash: "a".repeat(64),
  });
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM article_embedding_artifacts WHERE article_version_id = ? AND content_hash = ?").get("version-1", "b".repeat(64))?.count, 1);
  const readiness = await getEmbeddingReadiness();
  assert.deepEqual(readiness, { missingArticleCount: 0, publishedVersionCount: 1, missingPublishedArtifactCount: 0 });
  database.close();
});

test("embedding readiness counts D1 article candidates and published provenance parity", async () => {
  let query = "";
  const database: D1RuntimeDatabase = {
    prepare(sql) {
      query = sql;
      const statement: D1RuntimePreparedStatement = {
        bind() { return statement; },
        async all<T>() {
          return { success: true, results: [{ missingArticleCount: 3, publishedVersionCount: 8, missingPublishedArtifactCount: 2 }] as T[] };
        },
      };
      return statement;
    },
  };
  configure(database);
  assert.deepEqual(await getEmbeddingReadiness(), {
    missingArticleCount: 3,
    publishedVersionCount: 8,
    missingPublishedArtifactCount: 2,
  });
  assert.match(query, /a\.status = 'summarized'/u);
  assert.match(query, /article_publications_p3 p WHERE p\.state = 'published'/u);
  assert.match(query, /NOT EXISTS/u);
  assert.match(query, /e\.article_version_id = v\.id AND e\.article_id = v\.article_id AND e\.content_hash = v\.content_hash/u);
  assert.match(query, /e\.provider = 'gemini' AND e\.model = \? AND e\.dimensions = \?/u);
});

test("embedding persistence upserts matching published vector metadata and provenance", async () => {
  const statements: string[] = [];
  let writtenValues: unknown[][] = [];
  const nowSummary = JSON.stringify(summary);
  const version = {
    id: "version-1",
    article_id: "article-1",
    content_hash: "b".repeat(64),
    source_key: "scotus",
    jurisdiction: "United States",
    content_type: "opinion",
    original_language: "en",
    original_published_at: "2026-09-01T00:00:00.000Z",
    summary_json: JSON.stringify({ ...summary, summary: { ...summary.summary } }),
  };
  const database: D1RuntimeDatabase = {
    prepare(query) {
      statements.push(query);
      let values: unknown[] = [];
      const statement: D1RuntimePreparedStatement = {
        bind(...args) { values = args; return statement; },
        async all<T>() {
          if (query.includes("FROM articles WHERE id")) return { success: true, results: [{ id: "article-1", summary_json: nowSummary }] as T[] };
          return { success: true, results: [version] as T[] };
        },
        async run() { writtenValues.push(values); return { success: true, meta: { changes: 1 } }; },
      };
      return statement;
    },
    async batch(batchStatements) {
      writtenValues = batchStatements.map((statement) => statement as unknown as { values: unknown[] }).map((statement) => statement.values);
      return batchStatements.map(() => ({ success: true, meta: { changes: 1 } }));
    },
  };
  let vectors: Array<{ id: string; values: number[]; metadata?: Record<string, unknown> }> = [];
  const vector = {
    async query() { return { matches: [] }; },
    async upsert(items: Array<{ id: string; values: number[]; metadata?: Record<string, unknown> }>) { vectors = items; return {}; },
  } as unknown as VectorizeIndexBinding;
  configure(database, vector);

  await persistArticleEmbedding("article-1", artifact);
  assert.equal(vectors.length, 1);
  assert.equal(vectors[0]?.id, "article-1");
  assert.deepEqual(vectors[0]?.values, artifact.vector);
  assert.deepEqual(vectors[0]?.metadata, {
    articleVersionId: "version-1",
    contentHash: "b".repeat(64),
    provider: "gemini",
    model: "gemini-embedding-001",
    dimensions: 1536,
    inputHash: "a".repeat(64),
    generatedAt: artifact.generatedAt,
    projectionVersion: 1,
    sourceKey: "scotus",
    jurisdiction: "United States",
    contentType: "opinion",
    language: "en",
    publishedEpoch: Date.parse("2026-09-01T00:00:00.000Z"),
  });
  assert.match(statements[0] ?? "", /SELECT id, summary_json FROM articles/u);
  assert.match(statements[1] ?? "", /article_publications_p3/u);
  assert.match(statements[2] ?? "", /UPDATE articles SET embedding_provider/u);
  assert.match(statements[3] ?? "", /INSERT INTO article_embedding_artifacts/u);
  assert.equal(JSON.stringify(writtenValues).includes(JSON.stringify(artifact.vector)), false, "D1 stores provenance only, never vector values");
});

test("embedding persistence does not match malformed or null-mismatched published summaries", async () => {
  for (const publishedSummary of ["not-json", null]) {
    let vectorUpserts = 0;
    const database: D1RuntimeDatabase = {
      prepare(query) {
        const statement: D1RuntimePreparedStatement = {
          bind() { return statement; },
          async all<T>() {
            if (query.includes("FROM articles WHERE id")) return { success: true, results: [{ id: "article-1", summary_json: JSON.stringify(summary) }] as T[] };
            return { success: true, results: [{
              id: "version-1", article_id: "article-1", content_hash: "b".repeat(64), source_key: "scotus",
              jurisdiction: "United States", content_type: "opinion", original_language: "en",
              original_published_at: null, summary_json: publishedSummary,
            }] as T[] };
          },
          async run() { return { success: true, meta: { changes: 1 } }; },
        };
        return statement;
      },
      async batch(statements) { return statements.map(() => ({ success: true, meta: { changes: 1 } })); },
    };
    const vector = { async query() { return { matches: [] }; }, async upsert() { vectorUpserts += 1; return {}; } } as unknown as VectorizeIndexBinding;
    configure(database, vector);
    await persistArticleEmbedding("article-1", artifact);
    assert.equal(vectorUpserts, 0);
  }
});

test("embedding persistence skips artifact/vector when published summary differs", async () => {
  let batchSize = 0;
  let vectorUpserts = 0;
  const database: D1RuntimeDatabase = {
    prepare(query) {
      const statement: D1RuntimePreparedStatement = {
        bind() { return statement; },
        async all<T>() {
          if (query.includes("FROM articles WHERE id")) return { success: true, results: [{ id: "article-1", summary_json: JSON.stringify(summary) }] as T[] };
          return { success: true, results: [{
            id: "version-1", article_id: "article-1", content_hash: "b".repeat(64), source_key: "scotus",
            jurisdiction: "United States", content_type: "opinion", original_language: "en",
            original_published_at: null, summary_json: JSON.stringify({ ...summary, koreanTitle: "old" }),
          }] as T[] };
        },
        async run() { return { success: true, meta: { changes: 1 } }; },
      };
      return statement;
    },
    async batch(statements) { batchSize = statements.length; return statements.map(() => ({ success: true, meta: { changes: 1 } })); },
  };
  const vector = { async query() { return { matches: [] }; }, async upsert() { vectorUpserts += 1; return {}; } } as unknown as VectorizeIndexBinding;
  configure(database, vector);
  await persistArticleEmbedding("article-1", artifact);
  assert.equal(batchSize, 0);
  assert.equal(vectorUpserts, 0);
});
