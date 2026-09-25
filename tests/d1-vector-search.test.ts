import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";
import { normalizeEmbeddingVector } from "../lib/ai/embedding-vector";
import { emitDatabaseDdl } from "../lib/cloudflare/d1/ddl";
import { d1Schema } from "../lib/cloudflare/d1/schema";
import type { D1RuntimeDatabase, D1RuntimePreparedStatement } from "../lib/cloudflare/d1/runtime-binding";
import {
  buildSearchProjection,
  planSearchProjectionFullRebuild,
  type SearchPublicationP3Row,
  type SearchVersionP3Row,
} from "../lib/cloudflare/search-projection";
import {
  SearchVectorError,
  VECTOR_METADATA_INDEX_FIELDS,
  VECTORIZE_MAX_METADATA_INDEXES,
  buildVectorMetadataFilter,
  buildVectorProjection,
  hybridCandidateLimit,
  planVectorFullProjection,
  planVectorIncrementalSync,
  runVectorRankedSearchPage,
  vectorMetadataIndexManifest,
  vectorMutationPlanSummary,
  type ArticleEmbeddingArtifactRow,
  type SearchVectorErrorCode,
  type VectorizeIndexBinding,
  type VectorizeProjectionRecord,
  type VectorizeQueryOptions,
  type VectorizeQueryResult,
} from "../lib/cloudflare/search-vector";
import {
  resolveRankedSearchInput,
  type RankedSearchPageInput,
  type RankedSearchPagePayload,
} from "../lib/cloudflare/search-ranked";

/**
 * M7.4 local, code-only Vectorize semantic + hybrid foundation tests.
 *
 * The corpus is synthetic, the D1 executor is local `node:sqlite` and Vectorize
 * is a deterministic in-memory fake. Expected results are hand-authored against
 * the documented local D1/Vectorize semantics; this is NOT production parity
 * evidence and no GO-SEARCH/GO-D1-READ is claimed.
 */

const rootDir = process.cwd();
const NOW = "2026-09-25T12:00:00.000Z";
const CREATED = "2026-01-01T00:00:00.000Z";

function articleId(index: number): string {
  return `aaaaaaaa-0000-0000-0000-${String(index).padStart(12, "0")}`;
}
function versionId(index: number): string {
  return `bbbbbbbb-0000-0000-0000-${String(index).padStart(12, "0")}`;
}
function publicationId(index: number): string {
  return `cccccccc-0000-0000-0000-${String(index).padStart(12, "0")}`;
}
function hex64(seed: number): string {
  return seed.toString(16).padStart(64, "0").slice(-64);
}

/** Deterministic unit vector from a seed; never a committed literal. */
function seedVector(seed: number): number[] {
  let state = (Math.imul(seed, 0x9e3779b1) + 0x7f4a7c15) >>> 0;
  const raw: number[] = [];
  for (let index = 0; index < 1536; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    raw.push(state / 4294967296 - 0.5);
  }
  return normalizeEmbeddingVector(raw, 1536);
}

interface Row {
  index: number;
  title: string;
  sourceKey: string;
  jurisdiction: string;
  contentType: string;
  language: string;
  publishedAt: string | null;
  cleanedText: string;
  contentHash: string;
  inputHash: string;
  embedding: number[];
}

function row(index: number, spec: Partial<Row> & Pick<Row, "title" | "sourceKey" | "jurisdiction" | "contentType" | "language" | "publishedAt" | "cleanedText">): Row {
  return {
    index,
    contentHash: hex64(1000 + index),
    inputHash: hex64(2000 + index),
    embedding: seedVector(index),
    ...spec,
  };
}

const CORPUS: Row[] = [
  row(1, { title: "Klimaschutz Beschluss", sourceKey: "de-bverfg", jurisdiction: "Germany", contentType: "decision", language: "de", publishedAt: "2026-08-01T08:00:00.000Z", cleanedText: "constitution klimaschutz grundrechte" }),
  row(2, { title: "Wahlrecht Beschluss", sourceKey: "de-bverfg", jurisdiction: "Germany", contentType: "decision", language: "de", publishedAt: "2026-08-15T08:00:00.000Z", cleanedText: "constitution wahlrecht" }),
  row(3, { title: "Décision 2026-1194 QPC", sourceKey: "fr-conseil-constitutionnel", jurisdiction: "France", contentType: "decision", language: "fr", publishedAt: "2026-09-15T08:00:00.000Z", cleanedText: "constitution constitutionnel décision" }),
  row(4, { title: "Recurso de amparo 123/2025", sourceKey: "es-tribunal-constitucional", jurisdiction: "Spain", contentType: "order", language: "es", publishedAt: "2026-06-01T08:00:00.000Z", cleanedText: "constitution amparo recurso" }),
  row(5, { title: "Loper Bright", sourceKey: "us-scotus", jurisdiction: "United States", contentType: "opinion", language: "en", publishedAt: "2026-04-29T08:00:00.000Z", cleanedText: "constitution chevron deference" }),
  row(6, { title: "Sub Docket Decision", sourceKey: "us-scotus", jurisdiction: "United States", contentType: "opinion", language: "en", publishedAt: "2026-05-01T08:00:00.000Z", cleanedText: "constitution sub doctrine" }),
  row(7, { title: "Null Date Decision", sourceKey: "us-scotus", jurisdiction: "United States", contentType: "decision", language: "en", publishedAt: null, cleanedText: "constitution nulldate" }),
  row(8, { title: "Tagged Due Process", sourceKey: "us-scotus", jurisdiction: "United States", contentType: "opinion", language: "en", publishedAt: "2026-09-20T08:00:00.000Z", cleanedText: "constitution due process" }),
  row(9, { title: "Tagged Doctrine Only", sourceKey: "us-scotus", jurisdiction: "United States", contentType: "opinion", language: "en", publishedAt: "2026-09-19T08:00:00.000Z", cleanedText: "constitution doctrine" }),
  row(10, { title: "Today Decision", sourceKey: "us-scotus", jurisdiction: "United States", contentType: "opinion", language: "en", publishedAt: "2026-09-25T06:00:00.000Z", cleanedText: "constitution today" }),
];

function publications(rows: readonly Row[]): SearchPublicationP3Row[] {
  return rows.map((entry) => ({
    id: publicationId(entry.index),
    article_id: articleId(entry.index),
    state: "published",
    version_id: versionId(entry.index),
    revision: "1",
    created_at: CREATED,
    updated_at: CREATED,
  }));
}

function versions(rows: readonly Row[]): SearchVersionP3Row[] {
  return rows.map((entry) => ({
    id: versionId(entry.index),
    article_id: articleId(entry.index),
    source_key: entry.sourceKey,
    jurisdiction: entry.jurisdiction,
    content_type: entry.contentType,
    original_language: entry.language,
    original_title: entry.title,
    korean_title: null,
    original_published_at: entry.publishedAt,
    cleaned_text: entry.cleanedText,
    summary_json: null,
    source_metadata: null,
    case_key: null,
    created_at: CREATED,
    content_hash: entry.contentHash,
  }));
}

function artifact(entry: Row, overrides: Partial<ArticleEmbeddingArtifactRow> = {}): ArticleEmbeddingArtifactRow {
  return {
    article_version_id: versionId(entry.index),
    article_id: articleId(entry.index),
    content_hash: entry.contentHash,
    provider: "gemini",
    model: "gemini-embedding-001",
    dimensions: 1536,
    input_hash: entry.inputHash,
    embedding: entry.embedding,
    generated_at: CREATED,
    updated_at: CREATED,
    ...overrides,
  };
}

function artifacts(rows: readonly Row[]): ArticleEmbeddingArtifactRow[] {
  return rows.map((entry) => artifact(entry));
}

function localBinding(db: DatabaseSync, captured?: { sql: string; params: unknown[] }[]): D1RuntimeDatabase {
  return {
    prepare(sql: string): D1RuntimePreparedStatement {
      const statement = db.prepare(sql);
      let bound: SQLInputValue[] = [];
      const chain: D1RuntimePreparedStatement = {
        bind(...values: unknown[]) {
          bound = values as SQLInputValue[];
          if (captured) captured.push({ sql, params: values });
          return chain;
        },
        async all<T = Record<string, unknown>>() {
          try {
            return { success: true, results: statement.all(...bound) as unknown as T[] };
          } catch (error) {
            return { success: false, error: error instanceof Error ? error.message : String(error) };
          }
        },
      };
      return chain;
    },
  };
}

function databaseFor(rows: readonly Row[]): DatabaseSync {
  const built = buildSearchProjection({ publications: publications(rows), versions: versions(rows) });
  const db = new DatabaseSync(":memory:");
  db.exec(emitDatabaseDdl("worldcons_search", d1Schema));
  for (const statement of planSearchProjectionFullRebuild(built.documents, built.ftsDocuments).statements) {
    db.prepare(statement.sql).run(...(statement.params as SQLInputValue[]));
  }
  return db;
}

function dot(left: readonly number[], right: readonly number[]): number {
  let sum = 0;
  for (let index = 0; index < left.length; index += 1) sum += left[index] * right[index];
  return sum;
}

function matchesFilter(metadata: Record<string, unknown>, filter: Record<string, unknown> | null | undefined): boolean {
  if (!filter) return true;
  for (const [key, condition] of Object.entries(filter)) {
    const value = metadata[key];
    if (condition !== null && typeof condition === "object") {
      const ops = condition as Record<string, unknown>;
      if ("$eq" in ops && value !== ops.$eq) return false;
      if ("$ne" in ops && value === ops.$ne) return false;
      if ("$gt" in ops && !(typeof value === "number" && value > (ops.$gt as number))) return false;
      if ("$gte" in ops && !(typeof value === "number" && value >= (ops.$gte as number))) return false;
      if ("$lt" in ops && !(typeof value === "number" && value < (ops.$lt as number))) return false;
      if ("$lte" in ops && !(typeof value === "number" && value <= (ops.$lte as number))) return false;
      if ("$in" in ops && !(Array.isArray(ops.$in) && (ops.$in as unknown[]).includes(value))) return false;
      if ("$nin" in ops && Array.isArray(ops.$nin) && (ops.$nin as unknown[]).includes(value)) return false;
      continue;
    }
    if (value !== condition) return false;
  }
  return true;
}

function createFakeVectorize(records: readonly VectorizeProjectionRecord[]): VectorizeIndexBinding {
  return {
    async query(vector: readonly number[], options: VectorizeQueryOptions): Promise<VectorizeQueryResult> {
      const scored = records
        .filter((record) => matchesFilter(record.metadata as unknown as Record<string, unknown>, options.filter ?? null))
        .map((record) => ({ id: record.id, score: dot(vector, record.values), metadata: record.metadata as unknown as Record<string, unknown> }));
      scored.sort((left, right) => (right.score !== left.score ? right.score - left.score : left.id < right.id ? -1 : 1));
      return { matches: scored.slice(0, options.topK), count: scored.length };
    },
  };
}

function createSpyVectorize(
  records: readonly VectorizeProjectionRecord[],
  calls: { options: VectorizeQueryOptions }[],
): VectorizeIndexBinding {
  const base = createFakeVectorize(records);
  return {
    async query(vector: readonly number[], options: VectorizeQueryOptions): Promise<VectorizeQueryResult> {
      calls.push({ options });
      return base.query(vector, options);
    },
  };
}

function vectorProjection(rows: readonly Row[], overrides?: (entry: Row) => Partial<ArticleEmbeddingArtifactRow>) {
  return buildVectorProjection({
    publications: publications(rows),
    versions: versions(rows),
    artifacts: rows.map((entry) => artifact(entry, overrides ? overrides(entry) : {})),
  });
}

function makeInput(overrides: Partial<RankedSearchPageInput> = {}): RankedSearchPageInput {
  return { query: "", limit: 50, referenceNow: NOW, ...overrides };
}

async function runVector(
  db: DatabaseSync,
  vector: VectorizeIndexBinding | null,
  overrides: Partial<RankedSearchPageInput> = {},
): Promise<RankedSearchPagePayload> {
  return runVectorRankedSearchPage({ d1: localBinding(db), vector, input: makeInput(overrides) });
}

function ids(page: RankedSearchPagePayload): string[] {
  return page.entries.map((entry) => entry.id);
}

async function assertVectorRejects(action: () => Promise<unknown>, code: SearchVectorErrorCode): Promise<void> {
  await assert.rejects(
    action,
    (error: unknown) => error instanceof SearchVectorError && error.code === code,
    `expected SearchVectorError(${code})`,
  );
}

function assertVectorThrows(action: () => unknown, code: SearchVectorErrorCode): void {
  assert.throws(
    action,
    (error: unknown) => error instanceof SearchVectorError && error.code === code,
    `expected SearchVectorError(${code})`,
  );
}

// ---------------------------------------------------------------------------
// A. Projection + provenance
// ---------------------------------------------------------------------------

test("projection builds a record for the current published artifact with full provenance", () => {
  const built = vectorProjection(CORPUS);
  assert.equal(built.records.length, CORPUS.length);
  assert.equal(built.manifest.recordCount, CORPUS.length);
  assert.equal(built.manifest.missingCount, 0);
  assert.equal(built.manifest.staleCount, 0);

  const record = built.records.find((entry) => entry.id === articleId(1));
  assert.ok(record);
  assert.equal(record.id, articleId(1), "the Vectorize id must be the article UUID");
  assert.ok(Buffer.byteLength(record.id, "utf8") <= 64);
  assert.equal(record.values.length, 1536);
  assert.ok(record.values.every((value) => Number.isFinite(value)));
  assert.ok(Math.abs(Math.hypot(...record.values) - 1) < 1e-9);
  assert.equal(record.metadata.articleVersionId, versionId(1));
  assert.equal(record.metadata.contentHash, hex64(1001));
  assert.equal(record.metadata.provider, "gemini");
  assert.equal(record.metadata.model, "gemini-embedding-001");
  assert.equal(record.metadata.dimensions, 1536);
  assert.equal(record.metadata.inputHash, hex64(2001));
  assert.equal(record.metadata.generatedAt, CREATED);
  assert.equal(record.metadata.projectionVersion, 1);
  assert.equal(record.metadata.sourceKey, "de-bverfg");
  assert.equal(record.metadata.jurisdiction, "Germany");
  assert.equal(record.metadata.contentType, "decision");
  assert.equal(record.metadata.language, "de");
  assert.equal(record.metadata.publishedEpoch, Date.parse("2026-08-01T08:00:00.000Z"));
});

test("null/blank optional metadata is omitted rather than encoded as a fake string", () => {
  const blank = row(90, { title: "Blank Meta", sourceKey: "  ", jurisdiction: "", contentType: "decision", language: "en", publishedAt: "not-a-date", cleanedText: "constitution blank" });
  const built = vectorProjection([blank]);
  assert.equal(built.records.length, 1);
  const metadata = built.records[0].metadata as unknown as Record<string, unknown>;
  assert.ok(!("sourceKey" in metadata));
  assert.ok(!("jurisdiction" in metadata));
  assert.ok(!("publishedEpoch" in metadata));
  assert.equal(metadata.contentType, "decision");
});

test("a missing artifact is omitted and reported, never fabricated", () => {
  const built = buildVectorProjection({
    publications: publications(CORPUS),
    versions: versions(CORPUS),
    artifacts: artifacts(CORPUS.slice(0, CORPUS.length - 1)),
  });
  assert.equal(built.records.length, CORPUS.length - 1);
  assert.equal(built.manifest.missingCount, 1);
  assert.equal(built.manifest.staleCount, 0);
  const omission = built.omissions.find((entry) => entry.articleId === articleId(10));
  assert.ok(omission);
  assert.equal(omission.reason, "missing_artifact");
  assert.ok(!built.records.some((entry) => entry.id === articleId(10)));
});

test("stale provenance (provider/model/dimensions/inputHash/contentHash/article) is rejected, not upserted", () => {
  const stales = [
    { field: "provider", override: { provider: "openai" } },
    { field: "model", override: { model: "text-embedding-3" } },
    { field: "dimensions", override: { dimensions: 768 } },
    { field: "inputHash", override: { input_hash: "not-hex" } },
    { field: "contentHash", override: { content_hash: hex64(9999) } },
    { field: "article", override: { article_id: articleId(999) } },
  ] as const;

  for (const stale of stales) {
    const built = vectorProjection([CORPUS[0]], () => stale.override as Partial<ArticleEmbeddingArtifactRow>);
    assert.equal(built.records.length, 0, `${stale.field} must be omitted`);
    assert.equal(built.manifest.recordCount, 0);
    assert.equal(built.manifest.staleCount, 1);
    assert.equal(built.omissions[0]?.reason, "stale_artifact");
  }
});

test("a structurally malformed matching artifact fails closed", () => {
  const malformed: Partial<ArticleEmbeddingArtifactRow>[] = [
    { embedding: [0.1, 0.2] },
    { embedding: new Array(1536).fill(0) },
    { embedding: [1, Number.NaN, ...new Array(1534).fill(0.1)] },
    { embedding: "not-a-vector" },
    { generated_at: "not-a-date" },
    { provider: undefined },
    { dimensions: "1536" },
  ];
  for (const override of malformed) {
    assertVectorThrows(() => vectorProjection([CORPUS[0]], () => override), "invalid_artifact");
  }
});

test("duplicate artifacts for the same version fail closed", () => {
  const duplicated = [...artifacts([CORPUS[0]]), artifact(CORPUS[0])];
  assertVectorThrows(
    () => buildVectorProjection({ publications: publications([CORPUS[0]]), versions: versions([CORPUS[0]]), artifacts: duplicated }),
    "duplicate_artifact",
  );
});

test("mutation plan detects add/change/remove/no-op and never emits vector values", () => {
  const current = vectorProjection([CORPUS[0], CORPUS[1]]).records;
  const next = vectorProjection([CORPUS[0], CORPUS[2]]).records;

  const plan = planVectorIncrementalSync(current, next);
  assert.equal(plan.operation, "incremental");
  assert.equal(plan.changes.added, 1, "article 3 is added");
  assert.equal(plan.changes.removed, 1, "article 2 is removed");
  assert.equal(plan.changes.changed, 0);
  assert.equal(plan.changes.unchanged, 1);
  assert.deepEqual(plan.deletes, [articleId(2)]);
  assert.deepEqual(plan.upserts.map((entry) => entry.id), [articleId(3)]);
  assert.ok(plan.destructive, "a removal is destructive");
  assert.equal(plan.atomic, false);
  assert.equal(plan.executionDeferred, true);

  const summary = vectorMutationPlanSummary(plan);
  assert.equal(summary.upsertCount, 1);
  assert.equal(summary.deleteCount, 1);
  const serialized = JSON.stringify(summary);
  assert.ok(!serialized.includes('"values"'), "a plan summary must never carry vector values");
  assert.ok(!serialized.includes(String(current[0].values[0])), "no vector component may leak into a summary");
  for (const entry of summary.upserts) {
    assert.ok(!("values" in entry));
    assert.equal(entry.articleVersionId, versionId(3));
  }

  const noop = planVectorIncrementalSync(current, current);
  assert.equal(noop.noop, true);
  assert.equal(noop.changes.added + noop.changes.changed + noop.changes.removed, 0);
  assert.equal(noop.upserts.length, 0);

  const vectorChange: VectorizeProjectionRecord[] = next.map((entry) =>
    entry.id === articleId(3) ? { ...entry, values: seedVector(777), fingerprint: entry.fingerprint } : entry,
  );
  const changedPlan = planVectorIncrementalSync(next, vectorChange);
  assert.equal(changedPlan.changes.changed, 1, "a vector-only change must still upsert");
});

test("mutation plans and full projection fail closed on duplicate Vectorize ids", () => {
  const records = vectorProjection([CORPUS[0]]).records;
  const duplicated = [...records, { ...records[0] }];
  assertVectorThrows(() => planVectorFullProjection(duplicated), "duplicate_vector_id");
  assertVectorThrows(() => planVectorIncrementalSync([], duplicated), "duplicate_vector_id");
  assertVectorThrows(() => planVectorIncrementalSync(duplicated, []), "duplicate_vector_id");
});

test("the metadata index manifest is exactly the five authored scalar fields", () => {
  const manifest = vectorMetadataIndexManifest();
  assert.deepEqual(
    manifest.map((entry) => entry.propertyName),
    ["sourceKey", "jurisdiction", "contentType", "language", "publishedEpoch"],
  );
  assert.deepEqual([...VECTOR_METADATA_INDEX_FIELDS], ["sourceKey", "jurisdiction", "contentType", "language", "publishedEpoch"]);
  assert.ok(manifest.length <= VECTORIZE_MAX_METADATA_INDEXES);
  assert.equal(manifest.find((entry) => entry.propertyName === "publishedEpoch")?.type, "number");
  assert.ok(!manifest.some((entry) => /tag/i.test(entry.propertyName)), "tag is intentionally excluded from the manifest");
});

test("the Vectorize metadata filter is null when unconstrained and exact when constrained", () => {
  const unconstrained = buildVectorMetadataFilter(resolveRankedSearchInput({ query: "constitution", referenceNow: NOW }));
  assert.equal(unconstrained, null, "an unconstrained filter must be omitted, never sent as {}");

  const constrained = buildVectorMetadataFilter(
    resolveRankedSearchInput({ query: "constitution", range: "month", source: "us-scotus", referenceNow: NOW }),
  );
  assert.deepEqual(constrained, {
    sourceKey: "us-scotus",
    publishedEpoch: { $gte: Date.parse("2026-08-26T00:00:00.000Z") },
  });
});

test("the hybrid candidate-limit formula matches the RPC floor, page and ceiling", () => {
  const at = (offset: number, limit: number) =>
    hybridCandidateLimit(resolveRankedSearchInput({ query: "constitution", offset, limit, referenceNow: NOW }));
  assert.equal(at(0, 20), 100, "(0+20+1)*3 = 63 must floor to 100");
  assert.equal(at(0, 40), 123, "(0+40+1)*3 = 123");
  assert.equal(at(10000, 100), 30063, "(10000+100+1)*3 must cap at 30063");
});

// ---------------------------------------------------------------------------
// B/C. Semantic + hybrid query behavior
// ---------------------------------------------------------------------------

test("exact-case and empty-query latest work without a Vectorize binding even when mode is semantic/hybrid", async () => {
  const db = databaseFor(CORPUS);
  const exact = await runVector(db, null, { query: "1 BvR 2656/18", mode: "semantic" });
  assert.equal(exact.retrievalMode, "exact-case");

  const latest = await runVector(db, null, { query: "", mode: "hybrid", limit: 100 });
  assert.equal(latest.retrievalMode, "latest");
  assert.equal(latest.entries.length, CORPUS.length);
});

test("a non-exact semantic/hybrid request without an embedding fails closed like the RPC", async () => {
  const db = databaseFor(CORPUS);
  await assertVectorRejects(() => runVector(db, createFakeVectorize(vectorProjection(CORPUS).records), { query: "constitution", mode: "semantic" }), "embedding_required");
  await assertVectorRejects(() => runVector(db, createFakeVectorize(vectorProjection(CORPUS).records), { query: "constitution", mode: "hybrid" }), "embedding_required");
});

test("a non-exact semantic/hybrid request without a Vectorize binding fails closed without a lexical fallback", async () => {
  const db = databaseFor(CORPUS);
  const embedding = seedVector(1);
  await assertVectorRejects(() => runVector(db, null, { query: "constitution", mode: "semantic", embedding }), "vectorize_unavailable");
  await assertVectorRejects(() => runVector(db, null, { query: "constitution", mode: "hybrid", embedding }), "vectorize_unavailable");
});

test("query embeddings with wrong width, non-finite values or zero norm fail closed", async () => {
  const db = databaseFor(CORPUS);
  const vector = createFakeVectorize(vectorProjection(CORPUS).records);
  await assertVectorRejects(() => runVector(db, vector, { query: "constitution", mode: "semantic", embedding: new Array(1535).fill(0.1) }), "invalid_embedding");
  await assertVectorRejects(
    () => runVector(db, vector, { query: "constitution", mode: "semantic", embedding: [1, Number.NaN, ...new Array(1534).fill(0.1)] }),
    "invalid_embedding",
  );
  await assertVectorRejects(() => runVector(db, vector, { query: "constitution", mode: "semantic", embedding: new Array(1536).fill(0) }), "invalid_embedding");
  await assertVectorRejects(() => runVector(db, vector, { query: "constitution", mode: "semantic", embedding: "nope" }), "invalid_embedding");
  assert.throws(() => normalizeEmbeddingVector(new Array(1535).fill(0), 1536));
});

test("semantic scalar prefilters match source/jurisdiction/contentType/language", async () => {
  const db = databaseFor(CORPUS);
  const vector = createFakeVectorize(vectorProjection(CORPUS).records);
  const embedding = seedVector(1);
  const semantic = (overrides: Partial<RankedSearchPageInput>) => runVector(db, vector, { query: "constitution", mode: "semantic", limit: 99, embedding, ...overrides });

  assert.deepEqual(new Set(ids(await semantic({ source: "de-bverfg" }))), new Set([articleId(1), articleId(2)]));
  assert.deepEqual(ids(await semantic({ jurisdiction: "France" })), [articleId(3)]);
  assert.deepEqual(ids(await semantic({ contentType: "order" })), [articleId(4)]);
  assert.deepEqual(ids(await semantic({ language: "fr" })), [articleId(3)]);
  assert.deepEqual(
    new Set(ids(await semantic({ source: "us-scotus" }))),
    new Set([articleId(5), articleId(6), articleId(7), articleId(8), articleId(9), articleId(10)]),
  );
});

test("semantic UTC range thresholds reproduce today/week/month/latest", async () => {
  const db = databaseFor(CORPUS);
  const vector = createFakeVectorize(vectorProjection(CORPUS).records);
  const embedding = seedVector(1);
  const semantic = (range: string) => runVector(db, vector, { query: "constitution", mode: "semantic", limit: 99, embedding, range });

  assert.deepEqual(new Set(ids(await semantic("latest"))), new Set(CORPUS.map((entry) => articleId(entry.index))));
  assert.deepEqual(new Set(ids(await semantic("week"))), new Set([articleId(8), articleId(9), articleId(10)]));
  assert.deepEqual(new Set(ids(await semantic("month"))), new Set([articleId(3), articleId(8), articleId(9), articleId(10)]));
  assert.deepEqual(ids(await semantic("today")), [articleId(10)]);
});

test("semantic ordering is score desc, publishedEpoch desc nulls last, id asc", async () => {
  const equalA = row(31, { title: "Same A", sourceKey: "us-scotus", jurisdiction: "United States", contentType: "opinion", language: "en", publishedAt: "2026-09-20T00:00:00.000Z", cleanedText: "constitution same" });
  const equalB = row(32, { title: "Same B", sourceKey: "us-scotus", jurisdiction: "United States", contentType: "opinion", language: "en", publishedAt: "2026-09-20T00:00:00.000Z", cleanedText: "constitution same" });
  const older = row(33, { title: "Older", sourceKey: "us-scotus", jurisdiction: "United States", contentType: "opinion", language: "en", publishedAt: "2026-09-19T00:00:00.000Z", cleanedText: "constitution same" });
  const nullDate = row(34, { title: "Null", sourceKey: "us-scotus", jurisdiction: "United States", contentType: "opinion", language: "en", publishedAt: null, cleanedText: "constitution same" });
  const shared = seedVector(4242);
  const rows = [equalA, equalB, older, nullDate].map((entry) => ({ ...entry, embedding: shared }));
  const db = databaseFor(rows);
  const vector = createFakeVectorize(vectorProjection(rows).records);
  const page = await runVector(db, vector, { query: "constitution", mode: "semantic", limit: 99, embedding: shared });
  assert.deepEqual(
    ids(page),
    [articleId(31), articleId(32), articleId(33), articleId(34)],
    "equal scores tie-break by date desc then id asc; a null date sorts last",
  );
});

test("p_tag on semantic/hybrid fails closed with the stable deferred code and is not post-filtered", async () => {
  const db = databaseFor(CORPUS);
  const vector = createFakeVectorize(vectorProjection(CORPUS).records);
  const embedding = seedVector(1);
  await assertVectorRejects(() => runVector(db, vector, { query: "constitution", mode: "semantic", tag: "due-process", embedding }), "tag_filter_deferred");
  await assertVectorRejects(() => runVector(db, vector, { query: "constitution", mode: "hybrid", tag: "due-process", embedding }), "tag_filter_deferred");
});

test("semantic pagination trims the +1 window, reports hasMore and uses the lower-bound total", async () => {
  const db = databaseFor(CORPUS);
  const vector = createFakeVectorize(vectorProjection(CORPUS).records);
  const embedding = seedVector(1);
  const page = await runVector(db, vector, { query: "constitution", mode: "semantic", limit: 2, offset: 1, count: "none", embedding });
  assert.equal(page.entries.length, 2);
  assert.equal(page.hasMore, true);
  assert.equal(page.totalIsExact, false);
  assert.equal(page.total, 1 + 2 + 1);
  assert.ok(page.entries.every((entry) => entry.semanticSimilarity === entry.score));
});

test("semantic exact count is deferred; planned/estimated/none use the lower bound", async () => {
  const db = databaseFor(CORPUS);
  const vector = createFakeVectorize(vectorProjection(CORPUS).records);
  const embedding = seedVector(1);
  await assertVectorRejects(() => runVector(db, vector, { query: "constitution", mode: "semantic", count: "exact", embedding }), "vector_exact_count_deferred");
  for (const count of ["planned", "estimated", "none"]) {
    const page = await runVector(db, vector, { query: "constitution", mode: "semantic", limit: 3, count, embedding });
    assert.equal(page.totalIsExact, false);
    assert.equal(page.total, 0 + 3 + 1);
  }
});

test("the semantic window ceiling fails closed above the Vectorize topK maximum", async () => {
  const db = databaseFor(CORPUS);
  const calls: { options: VectorizeQueryOptions }[] = [];
  const vector = createSpyVectorize(vectorProjection(CORPUS).records, calls);
  const embedding = seedVector(1);
  await assertVectorRejects(
    () => runVector(db, vector, { query: "constitution", mode: "semantic", limit: 100, offset: 1, embedding }),
    "vector_window_exceeded",
  );
  await assertVectorRejects(
    () => runVector(db, vector, { query: "constitution", mode: "semantic", limit: 100, offset: 0, embedding }),
    "vector_window_exceeded",
  );
  assert.equal(calls.length, 0, "no Vectorize query may be sent once the window is rejected");
  const boundary = await runVector(db, vector, { query: "constitution", mode: "semantic", limit: 99, offset: 0, embedding });
  assert.equal(boundary.retrievalMode, "semantic", "topK = offset + limit + 1 must be exactly 100 at the boundary");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.topK, 100, "the boundary topK must be exactly the documented maximum");
});

test("semantic Vectorize queries bind exact topK and omit an empty metadata filter", async () => {
  const db = databaseFor(CORPUS);
  const calls: { options: VectorizeQueryOptions }[] = [];
  const vector = createSpyVectorize(vectorProjection(CORPUS).records, calls);
  const embedding = seedVector(1);

  await runVector(db, vector, { query: "constitution", mode: "semantic", limit: 5, offset: 2, range: "latest", embedding });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.topK, 2 + 5 + 1, "semantic topK must be offset + limit + 1");
  assert.equal(calls[0].options.returnValues, false);
  assert.equal(calls[0].options.returnMetadata, "indexed");
  assert.equal(
    calls[0].options.filter ?? null,
    null,
    "an unconstrained latest request must NOT send an empty filter (Vectorize rejects a non-empty-object violation)",
  );

  calls.length = 0;
  await runVector(db, vector, { query: "constitution", mode: "semantic", limit: 5, offset: 3, range: "week", language: "en", embedding });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.topK, 3 + 5 + 1);
  const filter = calls[0].options.filter as Record<string, unknown>;
  assert.ok(filter, "a constrained request must send a filter");
  assert.equal(filter.language, "en");
  assert.deepEqual(filter.publishedEpoch, { $gte: Date.parse("2026-09-18T00:00:00.000Z") });
  assert.deepEqual(Object.keys(filter).sort(), ["language", "publishedEpoch"], "only authored indexed fields may appear");
  assert.ok(JSON.stringify(filter).length < 2048, "the compact filter must stay under the 2048-byte Vectorize ceiling");
});

test("hybrid Vectorize queries bind the exact candidate limit and the lexical list matches it", async () => {
  const db = databaseFor(CORPUS);
  const calls: { options: VectorizeQueryOptions }[] = [];
  const vector = createSpyVectorize(vectorProjection(CORPUS).records, calls);
  const captured: { sql: string; params: unknown[] }[] = [];
  await runVectorRankedSearchPage({
    d1: localBinding(db, captured),
    vector,
    input: makeInput({ query: "constitution", mode: "hybrid", limit: 20, embedding: seedVector(1) }),
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.topK, 100, "hybrid semantic list topK = min(max((offset+limit+1)*3, 100), 30063) = 100");
  assert.equal(
    calls[0].options.filter ?? null,
    null,
    "a default latest hybrid request must NOT send an empty Vectorize filter",
  );
  const fts = captured.find((statement) => /\bsearch_fts\b/.test(statement.sql) && statement.sql.includes("match ?"));
  assert.ok(fts, "the lexical FTS statement must be executed");
  assert.equal(fts.params[fts.params.length - 1], 100, "the lexical candidate limit must be bound as 100");
});

test("malformed Vectorize responses fail closed", async () => {
  const db = databaseFor(CORPUS);
  const embedding = seedVector(1);
  const responders: VectorizeQueryResult[] = [
    { matches: null } as unknown as VectorizeQueryResult,
    { matches: {} } as unknown as VectorizeQueryResult,
    { matches: [{ id: "", score: 1 }] },
    { matches: [{ id: "x", score: "high" }] } as unknown as VectorizeQueryResult,
    { matches: [{ id: "x", score: Number.POSITIVE_INFINITY }] },
    { matches: [{ id: "x", score: 1 }, { id: "x", score: 2 }] },
    { matches: [null] } as unknown as VectorizeQueryResult,
    { matches: [{ id: "x", score: 1, metadata: [] }] } as unknown as VectorizeQueryResult,
    { matches: [{ id: "x", score: 1, metadata: { publishedEpoch: "x" } }] as unknown as VectorizeQueryResult["matches"] },
  ];
  for (const payload of responders) {
    const broken = { query: async () => payload } as unknown as VectorizeIndexBinding;
    await assertVectorRejects(() => runVector(db, broken, { query: "constitution", mode: "semantic", embedding }), "invalid_response");
  }
});

test("hybrid RRF rewards lexical + semantic agreement with the exact RPC score", async () => {
  const agree = row(41, { title: "Alpha Beta", sourceKey: "us-scotus", jurisdiction: "United States", contentType: "opinion", language: "en", publishedAt: "2026-09-10T00:00:00.000Z", cleanedText: "alpha beta" });
  const lexicalOnly = row(42, { title: "Gamma Delta", sourceKey: "us-scotus", jurisdiction: "United States", contentType: "opinion", language: "en", publishedAt: "2026-09-10T00:00:00.000Z", cleanedText: "alpha beta" });
  const semanticOnly = row(43, { title: "Epsilon Zeta", sourceKey: "us-scotus", jurisdiction: "United States", contentType: "opinion", language: "en", publishedAt: "2026-09-10T00:00:00.000Z", cleanedText: "epsilon zeta" });
  const query = seedVector(777);
  const rows = [
    { ...agree, embedding: query },
    { ...lexicalOnly, embedding: seedVector(9001) },
    { ...semanticOnly, embedding: query },
  ];
  const db = databaseFor(rows);
  const vector = createFakeVectorize(vectorProjection(rows).records);
  const page = await runVector(db, vector, { query: "Alpha Beta", mode: "hybrid", limit: 10, embedding: query });
  assert.equal(page.retrievalMode, "hybrid");
  assert.equal(ids(page)[0], articleId(41), "the document found by both lists must win");
  const entry = page.entries.find((candidate) => candidate.id === articleId(41));
  assert.ok(entry);
  assert.equal(entry?.lexicalRank, 1);
  assert.equal(entry?.semanticRank, 1);
  assert.ok(entry ? Math.abs((entry.score ?? 0) - (1 / 61 + 1 / 61)) < 1e-12 : false, "RRF score must be 1/(60+1)+1/(60+1)");
  const other = page.entries.find((candidate) => candidate.id !== articleId(41));
  assert.ok(other && (other.score ?? 0) < (entry?.score ?? 0));
});

test("hybrid requires each candidate limit <= 100 and defers otherwise", async () => {
  const db = databaseFor(CORPUS);
  const vector = createFakeVectorize(vectorProjection(CORPUS).records);
  const embedding = seedVector(1);
  await assertVectorRejects(
    () => runVector(db, vector, { query: "constitution", mode: "hybrid", limit: 20, offset: 34, embedding }),
    "vector_window_exceeded",
  );
  const page = await runVector(db, vector, { query: "constitution", mode: "hybrid", limit: 20, offset: 0, embedding });
  assert.equal(page.retrievalMode, "hybrid");
});

test("a semantic-only exact-title candidate receives exact-title priority from the D1 metadata lookup", async () => {
  const query = seedVector(555);
  const fillers: Row[] = [];
  for (let index = 0; index < 100; index += 1) {
    fillers.push(
      row(2001 + index, {
        title: "Alpha Beta",
        sourceKey: "us-scotus",
        jurisdiction: "United States",
        contentType: "opinion",
        language: "en",
        publishedAt: "2026-09-10T00:00:00.000Z",
        cleanedText: "alpha beta filler",
      }),
    );
  }
  const decoys: Row[] = [];
  for (let index = 0; index < 100; index += 1) {
    decoys.push({
      ...row(1001 + index, {
        title: `Omega Decoy ${index}`,
        sourceKey: "us-scotus",
        jurisdiction: "United States",
        contentType: "opinion",
        language: "en",
        publishedAt: "2026-09-01T00:00:00.000Z",
        cleanedText: "omega decoy unrelated",
      }),
      embedding: query,
    });
  }
  const highSim = { ...row(1, { title: "Gamma Delta", sourceKey: "us-scotus", jurisdiction: "United States", contentType: "opinion", language: "en", publishedAt: "2026-09-09T00:00:00.000Z", cleanedText: "gamma delta unrelated" }), embedding: query };
  const target = { ...row(2, { title: "Alpha Beta", sourceKey: "us-scotus", jurisdiction: "United States", contentType: "opinion", language: "en", publishedAt: "2026-09-08T00:00:00.000Z", cleanedText: "alpha beta target" }), embedding: query };
  const rows: Row[] = [highSim, target, ...decoys, ...fillers];

  const db = databaseFor(rows);
  const vector = createFakeVectorize(vectorProjection(rows).records);
  const page = await runVector(db, vector, { query: "Alpha Beta", mode: "hybrid", limit: 20, embedding: query });

  const targetEntry = page.entries.find((entry) => entry.id === articleId(2));
  assert.ok(targetEntry, "the semantic-only target must be on the page because it is exact-title");
  assert.equal(targetEntry?.lexicalRank, null, "the target is outside the 100-document lexical candidate list");
  assert.equal(targetEntry?.semanticRank, 2);
  assert.equal(ids(page)[2], articleId(2), "exact-title priority must place the semantic-only target above non-exact candidates");
  assert.ok(!ids(page).includes(articleId(1)), "the higher-RRF non-exact semantic candidate must not outrank the exact-title target");
});

test("hybrid candidate metadata lookups are fully parameterized and never interpolate ids or query text", async () => {
  const db = databaseFor(CORPUS);
  const vector = createFakeVectorize(vectorProjection(CORPUS).records);
  const captured: { sql: string; params: unknown[] }[] = [];
  const spy = localBinding(db, captured);
  const page = await runVectorRankedSearchPage({
    d1: spy,
    vector,
    input: makeInput({ query: "constitution", mode: "hybrid", limit: 10, jurisdiction: "United States", source: "us-scotus", embedding: seedVector(1) }),
  });
  assert.ok(page.retrievalMode === "hybrid");
  assert.ok(captured.length > 0);
  for (const statement of captured) {
    assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i.test(statement.sql), "no article UUID may be interpolated into SQL");
    assert.ok(!statement.sql.includes("constitution"), "query text must never enter SQL");
    assert.ok(!statement.sql.includes("us-scotus"), "filter text must never enter SQL");
    const placeholders = (statement.sql.match(/\?/g) ?? []).length;
    assert.equal(placeholders, statement.params.length, `every ? must be bound for:\n${statement.sql}`);
    for (const param of statement.params) {
      assert.ok(typeof param === "string" || typeof param === "number" || param === null, "every bound value must be a primitive");
      if (typeof param === "string" && param.length > 0) {
        assert.ok(!statement.sql.includes(param), `bound value ${param} must not be interpolated into SQL`);
      }
    }
  }
  const metadataStatement = captured.find((statement) => statement.sql.includes("in ("));
  assert.ok(metadataStatement, "the candidate metadata lookup must bind an IN list of parameters");
  assert.ok(metadataStatement.sql.includes("search_documents"));
  assert.ok(metadataStatement.sql.includes("search_fts"));
});

// ---------------------------------------------------------------------------
// D. Repository authority + runtime neutrality
// ---------------------------------------------------------------------------

test("SearchRepository stays Supabase-authoritative and search_m7 stays a blocker", () => {
  const selection = fs.readFileSync(path.join(rootDir, "lib", "search", "repository", "index.ts"), "utf8");
  assert.ok(selection.includes("createSupabaseSearchRepository"));
  assert.ok(selection.includes("failClosedSearchRepository"));
  assert.ok(!/vector/i.test(selection), "no Vectorize adapter may be selected");
  assert.ok(!/d1/i.test(selection), "no D1 search adapter may be selected");
  assert.ok(!fs.existsSync(path.join(rootDir, "lib", "search", "repository", "d1-repository.ts")));

  const coverage = fs.readFileSync(path.join(rootDir, "lib", "cloudflare", "d1", "shadow", "coverage.ts"), "utf8");
  assert.ok(coverage.includes("search_m7"), "M6.5 must keep the search_m7 blocker");
});

test("the search-vector and search-ranked libraries stay runtime-neutral with no remote mutation", () => {
  for (const directoryName of ["search-vector", "search-ranked"]) {
    const directory = path.join(rootDir, "lib", "cloudflare", directoryName);
    for (const entry of fs.readdirSync(directory)) {
      if (!entry.endsWith(".ts")) continue;
      const source = fs.readFileSync(path.join(directory, entry), "utf8");
      assert.ok(!source.includes('from "node:'), `${directoryName}/${entry} must not import a Node builtin`);
      assert.ok(!source.includes("from 'node:"), `${directoryName}/${entry} must not import a Node builtin`);
      assert.ok(!source.includes("require("), `${directoryName}/${entry} must not require()`);
      assert.ok(!source.includes("fetch("), `${directoryName}/${entry} must not perform network I/O`);
      assert.ok(!source.includes("process.env"), `${directoryName}/${entry} must not read process.env`);
      assert.ok(!source.includes("upsert("), `${directoryName}/${entry} must not call a Vectorize mutation`);
      assert.ok(!source.includes("deleteByIds("), `${directoryName}/${entry} must not call a Vectorize delete`);
      assert.ok(!source.includes("createIndex("), `${directoryName}/${entry} must not create a remote index`);
    }
  }
});

test("package scripts wire the vector test exactly once", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  assert.equal(packageJson.scripts["test:d1-vector-search"], "tsx --test tests/d1-vector-search.test.ts");
  const verifyRelease = packageJson.scripts["verify:release"];
  assert.equal(verifyRelease.split("test:d1-vector-search").length - 1, 1, "test:d1-vector-search must run exactly once in verify:release");
  assert.ok(packageJson.scripts["d1:vector-local"], "d1:vector-local operator CLI must exist");
  assert.ok(packageJson.scripts["d1:hybrid-local"], "d1:hybrid-local operator CLI must exist");
});
