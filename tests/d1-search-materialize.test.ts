import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  assertD1SnapshotShape,
  buildD1RestoreStatements,
  createD1RestClient,
  planD1Materialization,
  executeD1Statements,
} from "../lib/cloudflare/search-materialize/d1";
import { buildNarrowSearchSource } from "../lib/cloudflare/search-materialize/source";
import { buildSearchMaterializationProjection } from "../lib/cloudflare/search-materialize/build";
import { runSearchMaterialization } from "../lib/cloudflare/search-materialize/materialize";
import {
  assessMetadataIndexes,
  createVectorizeRestClient,
  planVectorizeMaterialization,
  preflightVectorize,
  type VectorizeRestClient,
} from "../lib/cloudflare/search-materialize/vectorize";
import { parseWranglerSearchDatabaseId, resolveSearchD1Target } from "../lib/cloudflare/search-materialize/cloudflare";
import {
  SEARCH_MATERIALIZE_D1_DATABASE,
  SEARCH_MATERIALIZE_VECTOR_INDEX,
  type D1BatchStatement,
  type VectorizeIndexConfig,
  type VectorizeMetadataIndexState,
} from "../lib/cloudflare/search-materialize/types";
import { SearchMaterializeError } from "../lib/cloudflare/search-materialize/errors";

/**
 * M7.5 remote search materialization operator tests. Every network boundary is
 * mocked: the Supabase linked runner, the D1 REST query/batch surface and the
 * Vectorize client/HTTP surface. No remote resource is touched.
 */

const rootDir = process.cwd();
const CONTENT_HASH_A = "a".repeat(64);
const CONTENT_HASH_B = "b".repeat(64);
const INPUT_HASH_A = "c".repeat(64);
const INPUT_HASH_B = "d".repeat(64);
const SEARCH_TEXT_SENTINEL = "SENTINEL_SEARCH_TEXT_XYZ";
const TAG_NAME_SENTINEL = "SENTINEL_TAG_NAME_XYZ";

function embedding(seed: number): number[] {
  return Array.from({ length: 1536 }, (_, index) => (index === 0 ? 0.5 + seed * 0.01 : 0.001 * ((index % 7) + 1)));
}

interface SourceData {
  publications: Record<string, unknown>[];
  versions: Record<string, unknown>[];
  articles: Record<string, unknown>[];
  tags: Record<string, unknown>[];
  articleTags: Record<string, unknown>[];
  artifacts: Record<string, unknown>[];
}

function baseSource(options: { secondArtifact?: boolean } = {}): SourceData {
  const artifacts: Record<string, unknown>[] = [
    {
      article_version_id: "v1",
      article_id: "a1",
      content_hash: CONTENT_HASH_A,
      provider: "gemini",
      model: "gemini-embedding-001",
      dimensions: 1536,
      input_hash: INPUT_HASH_A,
      generated_at: "2024-01-03T00:00:00.000Z",
      embedding: embedding(1),
    },
  ];
  if (options.secondArtifact) {
    artifacts.push({
      article_version_id: "v2",
      article_id: "a2",
      content_hash: CONTENT_HASH_B,
      provider: "gemini",
      model: "gemini-embedding-001",
      dimensions: 1536,
      input_hash: INPUT_HASH_B,
      generated_at: "2024-01-03T00:00:00.000Z",
      embedding: embedding(2),
    });
  }
  return {
    publications: [
      { id: "p1", article_id: "a1", state: "published", version_id: "v1", created_at: "2024-01-02T00:00:00.000Z", updated_at: "2024-01-02T00:00:00.000Z", published_at: "2024-01-02T00:00:00.000Z" },
      { id: "p2", article_id: "a2", state: "published", version_id: "v2", created_at: "2024-01-02T00:00:00.000Z", updated_at: "2024-01-02T00:00:00.000Z", published_at: "2024-01-02T00:00:00.000Z" },
      { id: "p3", article_id: "a3", state: "draft", version_id: "v3", created_at: "2024-01-02T00:00:00.000Z", updated_at: "2024-01-02T00:00:00.000Z", published_at: null },
    ],
    versions: [
      { id: "v1", article_id: "a1", source_key: "de-bverfg", jurisdiction: "DE", institution_name: "BVerfG", content_type: "decision", original_language: "de", original_title: "Grundrechte", korean_title: "기본권", original_published_at: "2024-01-02T00:00:00.000Z", cleaned_text: SEARCH_TEXT_SENTINEL, summary_json: { a: 1 }, source_metadata: { caseNumber: "1 BvR 1/24" }, case_key: "1 BvR 1/24", created_at: "2024-01-02T00:00:00.000Z", fetched_at: "2024-01-02T01:00:00.000Z", summarized_at: "2024-01-02T02:00:00.000Z", content_hash: CONTENT_HASH_A },
      { id: "v2", article_id: "a2", source_key: "fr-conseil", jurisdiction: "FR", institution_name: "Conseil", content_type: "decision", original_language: "fr", original_title: "Décision", korean_title: null, original_published_at: "2024-01-02T00:00:00.000Z", cleaned_text: "second body", summary_json: null, source_metadata: {}, case_key: "2024-1", created_at: "2024-01-02T00:00:00.000Z", fetched_at: null, summarized_at: null, content_hash: CONTENT_HASH_B },
      { id: "v3", article_id: "a3", source_key: "us-scotus", jurisdiction: "US", institution_name: null, content_type: "decision", original_language: "en", original_title: "Draft", korean_title: null, original_published_at: null, cleaned_text: "draft body", summary_json: null, source_metadata: {}, case_key: null, created_at: "2024-01-02T00:00:00.000Z", fetched_at: null, summarized_at: null, content_hash: "e".repeat(64) },
    ],
    articles: [
      { id: "a1", review_state: "approved" },
      { id: "a2", review_state: "approved" },
      { id: "a3", review_state: "draft" },
    ],
    tags: [
      { id: "t1", slug: "human-rights", name: TAG_NAME_SENTINEL, normalized_name: "human rights", type: "topic" },
      { id: "t2", slug: "constitutional", name: "Constitutional", normalized_name: "constitutional", type: "topic" },
    ],
    articleTags: [
      { article_id: "a1", tag_id: "t1" },
      { article_id: "a2", tag_id: "t2" },
    ],
    artifacts,
  };
}

interface FakeSupabase {
  runner: (sql: string) => Promise<string>;
  sqlCalls: string[];
}

function createFakeSupabase(
  data: SourceData,
  options: { failRelation?: string; failAtOffset?: number; mutateAfterCalls?: number } = {},
): FakeSupabase {
  const store: Record<string, Record<string, unknown>[]> = {
    article_publications_p3: data.publications,
    article_content_versions_p3: data.versions,
    articles: data.articles,
    tags: data.tags,
    article_tags: data.articleTags,
    article_embedding_artifacts: data.artifacts,
  };
  const sqlCalls: string[] = [];
  let callIndex = 0;
  const runner = async (sql: string): Promise<string> => {
    sqlCalls.push(sql);
    callIndex += 1;
    const relation = / from "([^"]+)"/.exec(sql)?.[1] ?? "";
    const offset = Number(/ offset (\d+)/.exec(sql)?.[1] ?? 0);
    if (options.failRelation === relation && (options.failAtOffset === undefined || options.failAtOffset === offset)) {
      throw new Error("linked run failed");
    }
    if (options.mutateAfterCalls !== undefined && callIndex === options.mutateAfterCalls) {
      const first = store.article_publications_p3[0];
      if (first) first.updated_at = "2025-01-01T00:00:00.000Z";
    }
    const selectPart = /^select (.+?) from/.exec(sql)?.[1] ?? "";
    const columns = [...selectPart.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
    const limit = Number(/ limit (\d+)/.exec(sql)?.[1] ?? 0);
    const rows = store[relation] ?? [];
    return JSON.stringify(
      rows.slice(offset, offset + limit).map((row) => {
        const picked: Record<string, unknown> = {};
        for (const column of columns) picked[column] = row[column] ?? null;
        return picked;
      }),
    );
  };
  return { runner, sqlCalls };
}

// ---------------------------------------------------------------------------
// A. Narrow Supabase loader
// ---------------------------------------------------------------------------

test("narrow source reads authored columns, bounded pages and deterministic order", async () => {
  const fake = createFakeSupabase(baseSource());
  const snapshot = await buildNarrowSearchSource({ runner: fake.runner });

  assert.equal(snapshot.counts.publications, 3);
  assert.equal(snapshot.counts.versions, 3);
  assert.equal(snapshot.counts.articles, 3);
  assert.equal(snapshot.counts.tags, 2);
  assert.equal(snapshot.counts.articleTags, 2);
  assert.equal(snapshot.counts.artifacts, 1);

  const versionSql = fake.sqlCalls.find((sql) => sql.includes("article_content_versions_p3"))!;
  assert.ok(versionSql.includes("content_hash"), "content_hash must be read");
  assert.ok(!versionSql.includes("raw_text"), "raw_text must never be read");
  assert.ok(!versionSql.includes("search_vector"), "search_vector must never be read");
  assert.ok(!versionSql.includes("embedding"), "version embedding must never be read");
  assert.ok(versionSql.includes('order by "id"'), "deterministic pk order");

  const artifactSql = fake.sqlCalls.find((sql) => sql.includes("article_embedding_artifacts"))!;
  assert.ok(artifactSql.includes("embedding"), "only the artifact relation reads embedding");

  // small relations use <=200 pages; versions/artifacts use <=25.
  const publicationsSql = fake.sqlCalls.find((sql) => sql.includes("article_publications_p3"))!;
  assert.ok(publicationsSql.includes("limit 25"), "small relations read bounded pages");
  assert.ok(fake.sqlCalls.every((sql) => / limit \d+/.test(sql)), "every page must be bounded");
});

test("narrow source fails closed with relation+offset only on a page failure", async () => {
  const fake = createFakeSupabase(baseSource(), { failRelation: "article_publications_p3", failAtOffset: 0 });
  await assert.rejects(
    () => buildNarrowSearchSource({ runner: fake.runner }),
    (error: unknown) => {
      assert.ok(error instanceof SearchMaterializeError);
      assert.equal(error.code, "source_page_failed");
      assert.ok(error.message.includes("article_publications_p3 offset 0"));
      assert.ok(!error.message.includes("select"));
      return true;
    },
  );
});

test("narrow source detects a source mutation between passes", async () => {
  const fake = createFakeSupabase(baseSource(), { mutateAfterCalls: 2 });
  await assert.rejects(
    () => buildNarrowSearchSource({ runner: fake.runner }),
    (error: unknown) => {
      assert.ok(error instanceof SearchMaterializeError);
      assert.equal(error.code, "source_mutation_detected");
      assert.ok(!error.message.includes("2025"));
      return true;
    },
  );
});

test("source-change detection fingerprints every projected field, including tag name", async () => {
  const data = baseSource();
  let tagsCalls = 0;
  const runner = async (sql: string): Promise<string> => {
    const relation = / from "([^"]+)"/.exec(sql)?.[1] ?? "";
    const selectPart = /^select (.+?) from/.exec(sql)?.[1] ?? "";
    const columns = [...selectPart.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
    const limit = Number(/ limit (\d+)/.exec(sql)?.[1] ?? 0);
    const offset = Number(/ offset (\d+)/.exec(sql)?.[1] ?? 0);
    const store: Record<string, Record<string, unknown>[]> = {
      article_publications_p3: data.publications,
      article_content_versions_p3: data.versions,
      articles: data.articles,
      tags: data.tags,
      article_tags: data.articleTags,
      article_embedding_artifacts: data.artifacts,
    };
    if (relation === "tags") {
      tagsCalls += 1;
      // `name` is consumed by the tag projection. Changing only `name` between
      // the two passes must still be caught: a compact identity set that omitted
      // it would silently project a stale tag.
      if (tagsCalls === 2) data.tags[0].name = "MUTATED_TAG_NAME";
    }
    return JSON.stringify(
      (store[relation] ?? []).slice(offset, offset + limit).map((row) => {
        const picked: Record<string, unknown> = {};
        for (const column of columns) picked[column] = row[column] ?? null;
        return picked;
      }),
    );
  };
  await assert.rejects(
    () => buildNarrowSearchSource({ runner }),
    (error: unknown) => {
      assert.ok(error instanceof SearchMaterializeError);
      assert.equal(error.code, "source_mutation_detected");
      return true;
    },
  );
});

test("narrow source enforces the safe per-relation max", async () => {
  const fake = createFakeSupabase(baseSource());
  await assert.rejects(
    () =>
      buildNarrowSearchSource({
        runner: fake.runner,
        pageSize: { publications: 1 },
        maxRows: { publications: 1 },
      }),
    (error: unknown) => {
      assert.ok(error instanceof SearchMaterializeError);
      assert.equal(error.code, "source_safe_max_exceeded");
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// B. Desired build
// ---------------------------------------------------------------------------

test("desired projection reuses M7.1/M7.4 and reports safe counts only", async () => {
  const fake = createFakeSupabase(baseSource());
  const snapshot = await buildNarrowSearchSource({ runner: fake.runner });
  const projection = buildSearchMaterializationProjection(snapshot);

  assert.equal(projection.search.documents.length, 2, "only published sources");
  assert.equal(projection.search.ftsDocuments.length, 2);
  assert.equal(projection.vector.records.length, 1, "one matching artifact, one missing");
  assert.equal(projection.vector.manifest.missingCount, 1);
  assert.equal(projection.vector.manifest.staleCount, 0);
  assert.equal(projection.desired.vector.recordCount, 1);
  assert.ok(projection.desired.search.hash.length > 0);

  const serialized = JSON.stringify(projection.desired);
  assert.ok(!serialized.includes(SEARCH_TEXT_SENTINEL));
  assert.ok(!serialized.includes("embedding"));
  assert.ok(!serialized.includes("values"));
});

// ---------------------------------------------------------------------------
// C. Cloudflare preflight
// ---------------------------------------------------------------------------

test("wrangler config parsing and exact D1 target resolution", async () => {
  const config = readFileSync(path.join(rootDir, "wrangler.jsonc"), "utf8");
  assert.equal(parseWranglerSearchDatabaseId(config), "1d74ebba-918b-4f8c-9c5c-9013479df809");
  assert.equal(parseWranglerSearchDatabaseId("{}"), null);

  const target = await resolveSearchD1Target({
    runner: async () =>
      JSON.stringify([{ name: SEARCH_MATERIALIZE_D1_DATABASE, uuid: "1d74ebba-918b-4f8c-9c5c-9013479df809" }]),
    expectedUuid: "1d74ebba-918b-4f8c-9c5c-9013479df809",
  });
  assert.equal(target.name, SEARCH_MATERIALIZE_D1_DATABASE);

  await assert.rejects(
    () =>
      resolveSearchD1Target({
        runner: async () =>
          JSON.stringify([{ name: SEARCH_MATERIALIZE_D1_DATABASE, uuid: "1d74ebba-918b-4f8c-9c5c-9013479df809" }]),
        expectedUuid: "00000000-0000-0000-0000-000000000000",
      }),
    /cloudflare_preflight_failed/,
  );

  await assert.rejects(
    () => resolveSearchD1Target({ runner: async () => JSON.stringify([]) }),
    /cloudflare_preflight_failed/,
  );
});

test("vectorize preflight refuses a config mismatch and reports absence", async () => {
  const absent = await preflightVectorize(createFakeVectorize({ index: null }).client);
  assert.equal(absent.index, null);

  const wrong = createFakeVectorize({
    index: { name: SEARCH_MATERIALIZE_VECTOR_INDEX, dimensions: 768, metric: "cosine" },
  }).client;
  await assert.rejects(() => preflightVectorize(wrong), /vector_index_mismatch/);

  const wrongMetric = createFakeVectorize({
    index: { name: SEARCH_MATERIALIZE_VECTOR_INDEX, dimensions: 1536, metric: "euclidean" },
  }).client;
  await assert.rejects(() => preflightVectorize(wrongMetric), /vector_index_mismatch/);
});

test("a vectorize preflight failure is never reported as ok", async () => {
  const fake = createFakeVectorize({
    index: { name: SEARCH_MATERIALIZE_VECTOR_INDEX, dimensions: 768, metric: "cosine" },
  });
  const result = await runSearchMaterialization({
    source: { runner: createFakeSupabase(baseSource()).runner },
    gates: { applyD1: false, confirmSearchDb: null, applyVector: false, provisionVectorIndex: false, confirmVectorIndex: null },
    d1: { query: createFakeD1().query },
    vectorize: { client: fake.client },
  });
  assert.equal(result.report.vector.state, "failed");
  assert.equal(result.report.ok, false);
  assert.ok(result.report.errors.some((error) => error.includes("vector_index_mismatch")));
});

// ---------------------------------------------------------------------------
// D. D1 remote materialization
// ---------------------------------------------------------------------------

interface FakeD1 {
  query: (statement: D1BatchStatement) => Promise<Record<string, unknown>[]>;
  batch: (statements: readonly D1BatchStatement[]) => Promise<void>;
  documents: Record<string, unknown>[];
  fts: Record<string, unknown>[];
  batchCalls: D1BatchStatement[][];
  failAfterBatch: number | null;
}

function createFakeD1(
  documents: Record<string, unknown>[] = [],
  fts: Record<string, unknown>[] = [],
  options: { failAfterBatch?: number } = {},
): FakeD1 {
  const fake: FakeD1 = {
    documents: documents.map((row) => ({ ...row })),
    fts: fts.map((row) => ({ ...row })),
    batchCalls: [],
    failAfterBatch: options.failAfterBatch ?? null,
    query: async (statement) => {
      const params = statement.params as number[];
      const limit = Number(params[0] ?? 0);
      const offset = Number(params[1] ?? 0);
      if (statement.sql.includes("search_documents")) {
        const rows = statement.sql.includes("article_id, checksum, projection_version")
          ? fake.documents.map((row) => ({
              article_id: row.article_id,
              checksum: row.checksum,
              projection_version: row.projection_version,
            }))
          : fake.documents.map((row) => ({ ...row }));
        return rows.slice(offset, offset + limit);
      }
      const rows = statement.sql.includes("title")
        ? fake.fts.map((row) => ({ ...row }))
        : fake.fts.map((row) => ({ article_id: row.article_id }));
      return rows.slice(offset, offset + limit);
    },
    batch: async (statements) => {
      fake.batchCalls.push([...statements]);
      if (fake.failAfterBatch !== null && fake.batchCalls.length > fake.failAfterBatch) {
        throw new Error("d1 rest http status 500");
      }
      for (const statement of statements) applyStatement(fake, statement);
    },
  };
  return fake;
}

function applyStatement(fake: FakeD1, statement: D1BatchStatement): void {
  const insert = /^INSERT INTO (search_documents|search_fts) \(([^)]+)\) VALUES \((.+)\);?$/.exec(statement.sql);
  if (insert) {
    const columns = insert[2].split(", ");
    const row: Record<string, unknown> = {};
    columns.forEach((column, index) => {
      row[column] = statement.params[index];
    });
    (insert[1] === "search_documents" ? fake.documents : fake.fts).push(row);
    return;
  }
  const deleteOne = /^DELETE FROM (search_documents|search_fts) WHERE article_id = \?;?$/.exec(statement.sql);
  if (deleteOne) {
    const id = statement.params[0];
    if (deleteOne[1] === "search_documents") fake.documents = fake.documents.filter((row) => row.article_id !== id);
    else fake.fts = fake.fts.filter((row) => row.article_id !== id);
    return;
  }
  const deleteAll = /^DELETE FROM (search_documents|search_fts);$/.exec(statement.sql);
  if (deleteAll) {
    if (deleteAll[1] === "search_documents") fake.documents = [];
    else fake.fts = [];
    return;
  }
  throw new Error(`unexpected statement ${statement.sql}`);
}

/**
 * A persisted pre-apply snapshot is mandatory for a D1 apply. Tests record the
 * write so the fail-closed requirement can be asserted.
 */
function snapshotDeps(path = "artifacts/cloudflare-m7/test-snapshot.json") {
  const written: number[] = [];
  return {
    written,
    deps: {
      snapshotPath: path,
      writeSnapshot: (snapshot: { documents: unknown[]; fts: unknown[] }) => {
        written.push(snapshot.documents.length + snapshot.fts.length);
      },
    },
  };
}

async function projectionFor(data: SourceData = baseSource()) {
  const fake = createFakeSupabase(data);
  const snapshot = await buildNarrowSearchSource({ runner: fake.runner });
  return buildSearchMaterializationProjection(snapshot);
}

test("d1 plan from an empty remote is additions only", async () => {
  const projection = await projectionFor();
  const current = { documents: [], documentCount: 0, ftsArticleIds: [], ftsCount: 0 };
  const { report } = planD1Materialization(projection.search.documents, projection.search.ftsDocuments, current);
  assert.equal(report.changes.added, 2);
  assert.equal(report.changes.changed, 0);
  assert.equal(report.changes.removed, 0);
  assert.equal(report.statementCount, 4, "two docs + two fts inserts");
  assert.equal(report.batchCount, 1);
  assert.equal(report.destructive, false);
});

test("d1 plan is a no-op when the remote already matches", async () => {
  const projection = await projectionFor();
  const current = {
    documents: projection.search.documents.map((doc) => ({
      article_id: doc.article_id,
      checksum: doc.checksum,
      projection_version: doc.projection_version,
    })),
    documentCount: 2,
    ftsArticleIds: projection.search.ftsDocuments.map((fts) => fts.article_id),
    ftsCount: 2,
  };
  const { report } = planD1Materialization(projection.search.documents, projection.search.ftsDocuments, current);
  assert.equal(report.statementCount, 0);
  assert.equal(report.destructive, false);
});

test("d1 plan fails closed on duplicates and identity mismatch", async () => {
  const projection = await projectionFor();
  const duplicated = {
    documents: [
      { article_id: "a1", checksum: "x", projection_version: 1 },
      { article_id: "a1", checksum: "x", projection_version: 1 },
    ],
    documentCount: 2,
    ftsArticleIds: ["a1"],
    ftsCount: 1,
  };
  assert.throws(
    () => planD1Materialization(projection.search.documents, projection.search.ftsDocuments, duplicated),
    /d1_current_duplicate/,
  );

  const missingFts = {
    documents: [{ article_id: "a1", checksum: "x", projection_version: 1 }],
    documentCount: 1,
    ftsArticleIds: [],
    ftsCount: 0,
  };
  assert.throws(
    () => planD1Materialization(projection.search.documents, projection.search.ftsDocuments, missingFts),
    /d1_current_identity_mismatch/,
  );

  const extraFts = {
    documents: [] as { article_id: string; checksum: string; projection_version: number }[],
    documentCount: 0,
    ftsArticleIds: ["zzz"],
    ftsCount: 1,
  };
  assert.throws(
    () => planD1Materialization(projection.search.documents, projection.search.ftsDocuments, extraFts),
    /d1_current_identity_mismatch/,
  );
});

test("d1 apply writes bounded batches, verifies exactly and reruns as a no-op", async () => {
  const fake = createFakeD1();
  const snapshot = snapshotDeps();
  const run = async (d1: FakeD1) =>
    runSearchMaterialization({
      source: { runner: createFakeSupabase(baseSource()).runner },
      gates: { applyD1: true, confirmSearchDb: SEARCH_MATERIALIZE_D1_DATABASE, applyVector: false, provisionVectorIndex: false, confirmVectorIndex: null },
      d1: { query: d1.query, batch: d1.batch, batchSize: 3, ...snapshot.deps },
    });

  const first = await run(fake);
  assert.equal(
    first.report.d1.applied,
    true,
    JSON.stringify({ state: first.report.d1.state, errors: first.report.d1.errors, plan: first.report.d1.plan }),
  );
  assert.equal(first.report.d1.verified, true);
  assert.equal(fake.batchCalls.length, 2, "4 statements at batch size 3");
  assert.equal(fake.documents.length, 2);
  assert.equal(fake.fts.length, 2);

  const second = await run(fake);
  assert.equal(second.report.d1.state, "noop");
  assert.equal(second.report.d1.plan?.statementCount, 0);
  assert.equal(fake.batchCalls.length, 2, "a rerun writes nothing");
});

test("d1 mid-run failure stops and marks rollback_required without false success", async () => {
  const fake = createFakeD1([], [], { failAfterBatch: 1 });
  const result = await runSearchMaterialization({
    source: { runner: createFakeSupabase(baseSource()).runner },
    gates: { applyD1: true, confirmSearchDb: SEARCH_MATERIALIZE_D1_DATABASE, applyVector: false, provisionVectorIndex: false, confirmVectorIndex: null },
    d1: { query: fake.query, batch: fake.batch, batchSize: 2, ...snapshotDeps().deps },
  });
  assert.equal(result.report.d1.state, "rollback_required");
  assert.equal(result.report.d1.rollbackRequired, true);
  assert.equal(result.report.d1.applied, false);
  assert.equal(result.report.ok, false);
});

test("d1 apply fails closed without a persisted pre-apply snapshot", async () => {
  const fake = createFakeD1();
  const result = await runSearchMaterialization({
    source: { runner: createFakeSupabase(baseSource()).runner },
    gates: { applyD1: true, confirmSearchDb: SEARCH_MATERIALIZE_D1_DATABASE, applyVector: false, provisionVectorIndex: false, confirmVectorIndex: null },
    d1: { query: fake.query, batch: fake.batch },
  });
  assert.equal(result.report.d1.applied, false);
  assert.equal(result.report.d1.state, "failed");
  assert.equal(fake.batchCalls.length, 0, "no batch may be written without a snapshot");
  assert.ok(result.report.errors.some((error) => error.includes("snapshot writer")));
});

test("a pre-apply snapshot failure is a failed apply, not rollback_required", async () => {
  const fake = createFakeD1();
  const result = await runSearchMaterialization({
    source: { runner: createFakeSupabase(baseSource()).runner },
    gates: { applyD1: true, confirmSearchDb: SEARCH_MATERIALIZE_D1_DATABASE, applyVector: false, provisionVectorIndex: false, confirmVectorIndex: null },
    d1: {
      query: fake.query,
      batch: fake.batch,
      snapshotPath: "artifacts/cloudflare-m7/test-snapshot.json",
      writeSnapshot: () => {
        throw new Error("snapshot write failed");
      },
    },
  });
  assert.equal(result.report.d1.state, "failed");
  assert.equal(result.report.d1.rollbackRequired, false);
  assert.equal(fake.batchCalls.length, 0, "no batch may be written after a snapshot failure");
});

test("explicit d1 restore rebuilds both tables from a snapshot", async () => {
  const projection = await projectionFor();
  const snapshotRows = projection.search.documents.map((doc) => ({
    ...doc,
  }));
  const ftsRows = projection.search.ftsDocuments.map((fts) => ({ ...fts }));
  const fake = createFakeD1(
    snapshotRows.map((row) => ({ ...row })) as Record<string, unknown>[],
    ftsRows.map((row) => ({ ...row })) as Record<string, unknown>[],
  );
  const restore = buildD1RestoreStatements({
    version: 1,
    stage: "search-materialize-d1-snapshot",
    database: SEARCH_MATERIALIZE_D1_DATABASE,
    documents: snapshotRows.map((row) => ({ ...row })) as never,
    fts: ftsRows.map((row) => ({ ...row })) as never,
  });
  assert.equal(restore.length, 6, "clear both tables then insert 2 + 2");
  await executeD1Statements(fake.batch, restore, 3);
  assert.equal(fake.documents.length, 2);
  assert.equal(fake.fts.length, 2);

  assert.throws(
    () => assertD1SnapshotShape({ database: "other", documents: [], fts: [] }),
    (error: unknown) => {
      assert.ok(error instanceof SearchMaterializeError);
      assert.equal(error.code, "d1_snapshot_invalid");
      return true;
    },
  );
});

test("d1 statement scope refuses anything outside the two search tables", async () => {
  const fake = createFakeD1();
  await assert.rejects(
    () => executeD1Statements(fake.batch, [{ sql: "DELETE FROM articles;", params: [] }]),
    /d1_statement_out_of_scope/,
  );
});

test("d1 rest client sends the transactional batch body shape", async () => {
  const bodies: unknown[] = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ success: true, result: [{ success: true, results: [], meta: {} }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  const client = createD1RestClient({
    accountId: "0".repeat(32),
    apiToken: "token",
    databaseId: "1d74ebba-918b-4f8c-9c5c-9013479df809",
    fetch: fetchImpl,
  });
  await client.batch([{ sql: "DELETE FROM search_fts;", params: [] }]);
  assert.deepEqual(bodies[0], { batch: [{ sql: "DELETE FROM search_fts;", params: [] }] });
});

test("d1 rest client sends the single-query body shape and flattens rows", async () => {
  const bodies: unknown[] = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(
      JSON.stringify({
        success: true,
        result: [
          {
            success: true,
            results: [{ article_id: "a1", checksum: "checksum", projection_version: 1 }],
            meta: {},
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  const client = createD1RestClient({
    accountId: "0".repeat(32),
    apiToken: "token",
    databaseId: "1d74ebba-918b-4f8c-9c5c-9013479df809",
    fetch: fetchImpl,
  });
  const sql = "SELECT article_id, checksum, projection_version FROM search_documents ORDER BY article_id LIMIT ? OFFSET ?";
  const rows = await client.query({ sql, params: [500, 0] });
  assert.deepEqual(bodies[0], { sql, params: [500, 0] });
  assert.deepEqual(rows, [{ article_id: "a1", checksum: "checksum", projection_version: 1 }]);
});

// ---------------------------------------------------------------------------
// E. Vectorize
// ---------------------------------------------------------------------------

interface FakeVectorizeState {
  index: VectorizeIndexConfig | null;
  metadata: VectorizeMetadataIndexState[];
  ids: string[];
}

interface FakeVectorize {
  client: VectorizeRestClient;
  state: FakeVectorizeState;
  upserted: string[][];
  deleted: string[][];
  createdMetadata: string[];
  createdIndex: boolean;
}

function createFakeVectorize(
  initial: Partial<FakeVectorizeState>,
  options: { upsertThrows?: boolean; neverProcessed?: boolean; vectorCount?: number } = {},
): FakeVectorize {
  const state: FakeVectorizeState = {
    index: initial.index ?? null,
    metadata: initial.metadata ? [...initial.metadata] : [],
    ids: initial.ids ? [...initial.ids] : [],
  };
  // Every mutation id the fake has accepted; polling reports it processed only
  // once the info call observes the exact submitted mutation id.
  const mutations = new Set<string>();
  const fake: FakeVectorize = {
    state,
    upserted: [],
    deleted: [],
    createdMetadata: [],
    createdIndex: false,
    client: {
      listIndexes: async () => (state.index === null ? [] : [state.index]),
      createIndex: async (name) => {
        fake.createdIndex = true;
        state.index = { name, dimensions: 1536, metric: "cosine" };
      },
      listMetadataIndexes: async () => state.metadata.map((entry) => ({ ...entry })),
      createMetadataIndex: async (_name, definition) => {
        fake.createdMetadata.push(definition.propertyName);
        state.metadata.push({ propertyName: definition.propertyName, type: definition.type });
        const mutationId = `mm${fake.createdMetadata.length}`;
        mutations.add(mutationId);
        return mutationId;
      },
      listVectorIds: async () => {
        const ids = [...state.ids].sort();
        return { ids, vectorCount: options.vectorCount ?? ids.length };
      },
      upsert: async (_name, records) => {
        if (options.upsertThrows) throw new Error("vectorize request failed");
        fake.upserted.push(records.map((record) => record.id));
        for (const record of records) if (!state.ids.includes(record.id)) state.ids.push(record.id);
        const mutationId = `m${fake.upserted.length}`;
        mutations.add(mutationId);
        return mutationId;
      },
      deleteByIds: async (_name, ids) => {
        fake.deleted.push([...ids]);
        state.ids = state.ids.filter((id) => !ids.includes(id));
        const mutationId = `d${fake.deleted.length}`;
        mutations.add(mutationId);
        return mutationId;
      },
      mutationProcessed: async (_name, mutationId) => ({
        processed: options.neverProcessed !== true && mutations.has(mutationId),
        vectorCount: state.ids.length,
      }),
    },
  };
  return fake;
}

test("vectorize plan upserts desired and deletes remote-only ids", () => {
  const records = [{ id: "a1" }, { id: "a2" }] as unknown as Parameters<typeof planVectorizeMaterialization>[0];
  const plan = planVectorizeMaterialization(records, {
    index: { name: SEARCH_MATERIALIZE_VECTOR_INDEX, dimensions: 1536, metric: "cosine" },
    metadataIndexes: [],
    vectorIds: ["a1", "zzz"],
    vectorCount: 2,
  });
  assert.equal(plan.plan.upsertCount, 2);
  assert.equal(plan.plan.deleteCount, 1);
  assert.deepEqual(plan.deletes, ["zzz"]);
});

test("vectorize dry-run beside an absent index reports needs_provision with no mutation", async () => {
  const fake = createFakeVectorize({ index: null });
  const projection = await projectionFor(baseSource({ secondArtifact: true }));
  const result = await runSearchMaterialization({
    source: { runner: createFakeSupabase(baseSource({ secondArtifact: true })).runner },
    gates: { applyD1: false, confirmSearchDb: null, applyVector: false, provisionVectorIndex: false, confirmVectorIndex: null },
    d1: { query: createFakeD1().query },
    vectorize: { client: fake.client },
  });
  assert.equal(result.report.vector.state, "needs_provision");
  assert.equal(result.projection.vector.records.length, projection.vector.records.length);
  assert.equal(fake.createdIndex, false);
  assert.equal(fake.upserted.length, 0);
});

test("vectorize apply refuses when artifacts are missing or stale", async () => {
  const fake = createFakeVectorize({ index: { name: SEARCH_MATERIALIZE_VECTOR_INDEX, dimensions: 1536, metric: "cosine" } });
  const result = await runSearchMaterialization({
    source: { runner: createFakeSupabase(baseSource()).runner },
    gates: { applyD1: false, confirmSearchDb: null, applyVector: true, provisionVectorIndex: false, confirmVectorIndex: SEARCH_MATERIALIZE_VECTOR_INDEX },
    d1: { query: createFakeD1().query },
    vectorize: { client: fake.client },
  });
  assert.equal(result.report.vector.state, "refused");
  assert.ok(result.report.vector.errors.some((error) => error.includes("vector_completeness_refused")));
  assert.equal(fake.upserted.length, 0);
});

test("vectorize apply provisions, upserts and verifies exact ids", async () => {
  const fake = createFakeVectorize({ index: null });
  const result = await runSearchMaterialization({
    source: { runner: createFakeSupabase(baseSource({ secondArtifact: true })).runner },
    gates: { applyD1: false, confirmSearchDb: null, applyVector: true, provisionVectorIndex: true, confirmVectorIndex: SEARCH_MATERIALIZE_VECTOR_INDEX },
    d1: { query: createFakeD1().query },
    vectorize: { client: fake.client },
  });
  assert.equal(result.report.vector.state, "applied", result.report.vector.errors.join("; "));
  assert.equal(result.report.vector.verified, true);
  assert.equal(fake.createdIndex, true);
  assert.deepEqual(fake.createdMetadata.sort(), ["contentType", "jurisdiction", "language", "publishedEpoch", "sourceKey"]);
  const ids = fake.upserted.flat().sort();
  assert.deepEqual(ids, result.projection.vector.records.map((record) => record.id).sort());
  assert.equal(result.report.vector.verification?.ok, true);
});

test("vectorize apply without provision beside an absent index refuses", async () => {
  const fake = createFakeVectorize({ index: null });
  const result = await runSearchMaterialization({
    source: { runner: createFakeSupabase(baseSource({ secondArtifact: true })).runner },
    gates: { applyD1: false, confirmSearchDb: null, applyVector: true, provisionVectorIndex: false, confirmVectorIndex: SEARCH_MATERIALIZE_VECTOR_INDEX },
    d1: { query: createFakeD1().query },
    vectorize: { client: fake.client },
  });
  assert.equal(result.report.vector.state, "refused");
  assert.equal(fake.createdIndex, false);
});

test("vectorize metadata index assessment detects missing and wrong types", () => {
  const expected = [
    { propertyName: "sourceKey", type: "string" },
    { propertyName: "jurisdiction", type: "string" },
    { propertyName: "contentType", type: "string" },
    { propertyName: "language", type: "string" },
  ];
  const assessment = assessMetadataIndexes([
    { propertyName: "sourceKey", type: "string" },
    { propertyName: "jurisdiction", type: "number" },
  ]);
  assert.deepEqual(assessment.missing, ["contentType", "language", "publishedEpoch"]);
  assert.deepEqual(assessment.wrongType, [{ propertyName: "jurisdiction", expected: "string", actual: "number" }]);
  assert.deepEqual(assessment.present, ["sourceKey"]);
  assert.equal(expected.length, 4);
});

test("vectorize mutation polling succeeds and times out deterministically", async () => {
  const records = await projectionFor(baseSource({ secondArtifact: true })).then((projection) => projection.vector.records);
  const okFake = createFakeVectorize({ index: { name: SEARCH_MATERIALIZE_VECTOR_INDEX, dimensions: 1536, metric: "cosine" } });
  const ok = await runSearchMaterialization({
    source: { runner: createFakeSupabase(baseSource({ secondArtifact: true })).runner },
    gates: { applyD1: false, confirmSearchDb: null, applyVector: true, provisionVectorIndex: false, confirmVectorIndex: SEARCH_MATERIALIZE_VECTOR_INDEX },
    d1: { query: createFakeD1().query },
    vectorize: { client: okFake.client, mutationTimeoutMs: 10_000 },
  });
  assert.equal(ok.report.vector.verified, true);

  let clock = 0;
  const slow = createFakeVectorize({ index: { name: SEARCH_MATERIALIZE_VECTOR_INDEX, dimensions: 1536, metric: "cosine" } }, { neverProcessed: true });
  const timedOut = await runSearchMaterialization({
    source: { runner: createFakeSupabase(baseSource({ secondArtifact: true })).runner },
    gates: { applyD1: false, confirmSearchDb: null, applyVector: true, provisionVectorIndex: false, confirmVectorIndex: SEARCH_MATERIALIZE_VECTOR_INDEX },
    d1: { query: createFakeD1().query },
    vectorize: {
      client: slow.client,
      mutationTimeoutMs: 5_000,
      sleep: async () => {},
      now: () => {
        clock += 1_000;
        return clock;
      },
    },
  });
  assert.equal(timedOut.report.vector.state, "failed");
  assert.ok(timedOut.report.vector.errors.some((error) => error.includes("vector_mutation_timeout")));
  assert.equal(records.length, 2);
});

function vectorizeJson(result: unknown, status = 200): Response {
  return new Response(JSON.stringify({ success: true, result }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("vectorize rest client uses the documented v2 request/response shapes", async () => {
  const calls: { method: string; url: string; init?: RequestInit; body: string | null }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({
      method: init?.method ?? "GET",
      url,
      init,
      body: typeof init?.body === "string" ? init.body : null,
    });
    const parsed = new URL(url);
    const path = parsed.pathname;
    if (path.endsWith("/metadata_index/list")) {
      return vectorizeJson({ metadataIndexes: [{ propertyName: "sourceKey", indexType: "string" }] });
    }
    if (path.endsWith("/list")) {
      if (parsed.searchParams.get("cursor") === "cursor-2") {
        return vectorizeJson({ count: 1, isTruncated: false, totalCount: 2, vectors: [{ id: "a2" }], nextCursor: null });
      }
      return vectorizeJson({ count: 1, isTruncated: true, totalCount: 2, vectors: [{ id: "a1" }], nextCursor: "cursor-2" });
    }
    if (path.endsWith("/metadata_index/create")) {
      return vectorizeJson({ mutationId: "meta-1" });
    }
    if (path.endsWith("/info")) {
      return vectorizeJson({
        dimensions: 1536,
        processedUpToDatetime: "2024-07-22T18:25:44Z",
        processedUpToMutation: "mut-1",
        vectorCount: 2,
      });
    }
    if (path.endsWith("/upsert")) return vectorizeJson({ mutationId: "mut-1" });
    if (path.endsWith("/delete_by_ids")) return vectorizeJson({ mutationId: "del-1" });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;

  const client = createVectorizeRestClient({ accountId: "0".repeat(32), apiToken: "secret-token", fetch: fetchImpl });

  const listed = await client.listVectorIds(SEARCH_MATERIALIZE_VECTOR_INDEX);
  assert.deepEqual(listed.ids, ["a1", "a2"]);
  assert.equal(listed.vectorCount, 2, "totalCount is the index total, not the per-page count");
  assert.ok(!JSON.stringify(listed).includes("values"));
  const listCalls = calls.filter((call) => new URL(call.url).pathname.endsWith("/list"));
  assert.equal(listCalls.length, 2);
  assert.ok(listCalls.every((call) => call.method === "GET"), "list vectors is a GET with query params");
  assert.equal(new URL(listCalls[0].url).searchParams.get("count"), "1000");
  assert.equal(new URL(listCalls[1].url).searchParams.get("cursor"), "cursor-2");

  const metadata = await client.listMetadataIndexes(SEARCH_MATERIALIZE_VECTOR_INDEX);
  assert.deepEqual(metadata, [{ propertyName: "sourceKey", type: "string" }]);
  const metadataListCall = calls.find((call) => new URL(call.url).pathname.endsWith("/metadata_index/list"))!;
  assert.equal(metadataListCall.method, "GET");

  const created = await client.createMetadataIndex(SEARCH_MATERIALIZE_VECTOR_INDEX, {
    propertyName: "sourceKey",
    type: "string",
  });
  assert.equal(created, "meta-1");
  const metadataCreateCall = calls.find((call) => new URL(call.url).pathname.endsWith("/metadata_index/create"))!;
  assert.equal(metadataCreateCall.method, "POST");
  assert.deepEqual(JSON.parse(metadataCreateCall.body!), { propertyName: "sourceKey", indexType: "string" });

  const processed = await client.mutationProcessed(SEARCH_MATERIALIZE_VECTOR_INDEX, "mut-1");
  assert.equal(processed.processed, true);
  assert.equal(processed.vectorCount, 2);
  const pending = await client.mutationProcessed(SEARCH_MATERIALIZE_VECTOR_INDEX, "mut-2");
  assert.equal(pending.processed, false, "a different mutation id must not count as processed");
  const infoCall = calls.find((call) => new URL(call.url).pathname.endsWith("/info"))!;
  assert.equal(infoCall.method, "GET");

  const record = {
    id: "a1",
    values: [0.1, 0.2],
    metadata: { sourceKey: "de-bverfg", projectionVersion: 1 },
    fingerprint: "fp",
  };
  const mutationId = await client.upsert(SEARCH_MATERIALIZE_VECTOR_INDEX, [record as never]);
  assert.equal(mutationId, "mut-1");
  const upsertCall = calls.find((call) => new URL(call.url).pathname.endsWith("/upsert"))!;
  assert.equal(upsertCall.method, "POST");
  assert.equal((upsertCall.init?.headers as Record<string, string>)["Content-Type"], "application/x-ndjson");
  assert.ok(String(upsertCall.body).includes('"id":"a1"'));

  const deleted = await client.deleteByIds(SEARCH_MATERIALIZE_VECTOR_INDEX, ["a9"]);
  assert.equal(deleted, "del-1");
  const deleteCall = calls.find((call) => new URL(call.url).pathname.endsWith("/delete_by_ids"))!;
  assert.equal(deleteCall.method, "POST");
  assert.deepEqual(JSON.parse(deleteCall.body!), { ids: ["a9"] });
});

test("vectorize rest client fails closed on malformed list/metadata responses", async () => {
  const clientFor = (result: unknown) =>
    createVectorizeRestClient({
      accountId: "0".repeat(32),
      apiToken: "secret-token",
      fetch: (async () => vectorizeJson(result)) as unknown as typeof fetch,
    });

  await assert.rejects(
    () => clientFor({ totalCount: 1 }).listVectorIds(SEARCH_MATERIALIZE_VECTOR_INDEX),
    /vector_response_invalid/,
  );
  await assert.rejects(
    () =>
      clientFor({ metadataIndexes: [{ propertyName: "sourceKey" }] }).listMetadataIndexes(
        SEARCH_MATERIALIZE_VECTOR_INDEX,
      ),
    /vector_response_invalid/,
  );
});

// ---------------------------------------------------------------------------
// F/G. Gates and safe report
// ---------------------------------------------------------------------------

test("apply gates refuse a bare or unconfirmed apply", async () => {
  const fake = createFakeD1();
  const result = await runSearchMaterialization({
    source: { runner: createFakeSupabase(baseSource()).runner },
    gates: { applyD1: true, confirmSearchDb: null, applyVector: false, provisionVectorIndex: false, confirmVectorIndex: null },
    d1: { query: fake.query, batch: fake.batch },
  });
  assert.equal(result.report.d1.applied, false);
  assert.equal(fake.batchCalls.length, 0);
  assert.ok(result.report.errors.some((error) => error.includes("d1_confirmation_required")));

  const cli = readFileSync(path.join(rootDir, "scripts/d1-search-materialize.ts"), "utf8");
  assert.ok(cli.includes('arg === "--apply"'), "the CLI must refuse a bare --apply");
  assert.ok(cli.includes("--confirm-search-db="));
  assert.ok(cli.includes("--confirm-vector-index="));
  assert.ok(cli.includes('arg.startsWith("--deploy")'), "the CLI must explicitly refuse a deploy flag");
});

test("the safe report contains counts and hashes only and never row text or embeddings", async () => {
  const fake = createFakeVectorize({ index: null });
  const { report } = await runSearchMaterialization({
    source: { runner: createFakeSupabase(baseSource({ secondArtifact: true })).runner },
    gates: { applyD1: false, confirmSearchDb: null, applyVector: false, provisionVectorIndex: false, confirmVectorIndex: null },
    d1: { query: createFakeD1().query },
    vectorize: { client: fake.client },
  });
  const serialized = JSON.stringify(report);
  assert.ok(!serialized.includes(SEARCH_TEXT_SENTINEL));
  assert.ok(!serialized.includes(TAG_NAME_SENTINEL));
  assert.ok(!serialized.includes("embedding"));
  assert.ok(!serialized.includes('"values"'));
  assert.ok(!serialized.includes("secret-token"));
  assert.ok(serialized.includes("fingerprint"));
  assert.deepEqual(report.blockedBy, ["search_m7"]);
});

test("dry-run performs no D1 mutation and no vectorize upsert", async () => {
  const d1 = createFakeD1();
  const vectorize = createFakeVectorize({ index: { name: SEARCH_MATERIALIZE_VECTOR_INDEX, dimensions: 1536, metric: "cosine" }, ids: ["zzz"] });
  const result = await runSearchMaterialization({
    source: { runner: createFakeSupabase(baseSource({ secondArtifact: true })).runner },
    gates: { applyD1: false, confirmSearchDb: null, applyVector: false, provisionVectorIndex: false, confirmVectorIndex: null },
    d1: { query: d1.query, batch: d1.batch },
    vectorize: { client: vectorize.client },
  });
  assert.equal(result.report.dryRun, true);
  assert.equal(d1.batchCalls.length, 0);
  assert.equal(vectorize.upserted.length, 0);
  assert.equal(vectorize.deleted.length, 0);
  assert.equal(result.report.ok, true, result.report.errors.join("; "));
});

test("D1 apply proceeds even when the vector projection is incomplete", async () => {
  const d1 = createFakeD1();
  const vectorize = createFakeVectorize({ index: { name: SEARCH_MATERIALIZE_VECTOR_INDEX, dimensions: 1536, metric: "cosine" } });
  const result = await runSearchMaterialization({
    source: { runner: createFakeSupabase(baseSource()).runner },
    gates: { applyD1: true, confirmSearchDb: SEARCH_MATERIALIZE_D1_DATABASE, applyVector: true, provisionVectorIndex: false, confirmVectorIndex: SEARCH_MATERIALIZE_VECTOR_INDEX },
    d1: { query: d1.query, batch: d1.batch, ...snapshotDeps().deps },
    vectorize: { client: vectorize.client },
  });
  assert.equal(result.report.d1.applied, true);
  assert.equal(result.report.vector.state, "refused");
  assert.equal(result.report.ok, false);
});

// ---------------------------------------------------------------------------
// H. Boundaries
// ---------------------------------------------------------------------------

test("SearchRepository remains Supabase-authoritative and the Worker bindings/config are untouched", () => {
  const repository = readFileSync(path.join(rootDir, "lib/search/repository/index.ts"), "utf8");
  assert.ok(repository.includes("createSupabaseSearchRepository"));
  assert.ok(!repository.includes("search-materialize"));

  const wrangler = readFileSync(path.join(rootDir, "wrangler.jsonc"), "utf8");
  assert.ok(wrangler.includes("1d74ebba-918b-4f8c-9c5c-9013479df809"));
  assert.ok(!wrangler.includes("vectorize"), "no vectorize binding may be added");
  assert.ok(!wrangler.includes("worldcons-search"), "no vectorize index binding may be added");

  const worker = readFileSync(path.join(rootDir, "worker/index.ts"), "utf8");
  assert.ok(!worker.includes("search-materialize"));
});

test("the materialize source never issues an unbounded or wildcard projection", () => {
  const source = readFileSync(path.join(rootDir, "lib/cloudflare/search-materialize/source.ts"), "utf8");
  const code = source
    .split("\n")
    .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//"))
    .join("\n");
  assert.ok(!/select\s+\*/i.test(code), "no wildcard projection may exist in code");
  assert.ok(code.includes("buildPostgresSelectSql"));
  assert.ok(code.includes("parseSupabaseLinkedRows"));
});
