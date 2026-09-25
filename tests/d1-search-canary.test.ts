import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { normalizeEmbeddingVector } from "../lib/ai/embedding-vector";
import type { SearchPublicationP3Row, SearchVersionP3Row } from "../lib/cloudflare/search-projection";
import { planSearchProjectionIncrementalSync } from "../lib/cloudflare/search-projection";
import type { ArticleEmbeddingArtifactRow } from "../lib/cloudflare/search-vector";
import { SEARCH_VECTOR_DIMENSIONS, VECTOR_METADATA_INDEX_MANIFEST } from "../lib/cloudflare/search-vector";
import {
  SEARCH_CANARY_VECTOR_INDEX,
  buildSearchCanaryCases,
  buildSearchCanaryProjectionPlan,
  buildSearchCanaryReport,
  evaluateSearchCanaryCase,
  oracleParity,
  percentile,
  planSearchCanaryVectorBootstrap,
  renderSearchCanaryMarkdown,
  searchCanaryErrorObservation,
  summarizeSearchCanary,
  type SearchCanaryCase,
} from "../lib/cloudflare/search-canary";
import { literalizeScript, literalizeStatement } from "../lib/cloudflare/search-canary/operator/literalize";
import { parseRemoteD1Envelope } from "../lib/cloudflare/search-canary/operator/remote-d1";
import { createSupabaseCanaryReader } from "../lib/cloudflare/search-canary/operator/supabase-read";
import {
  parseMetadataIndexNames,
  parseVectorizeIndexDetail,
  parseVectorizeMatches,
  parseVectorizeUpsertResult,
} from "../lib/cloudflare/search-canary/operator/vectorize-cli";

/**
 * M7.5 remote search canary tests.
 *
 * The corpus is synthetic and every remote seam is a fake: no network, no
 * Supabase, no Wrangler. The tests assert deterministic planning, safe SQL
 * literalization, CLI output parsing, oracle parity rules and threshold
 * accounting. No production parity is claimed.
 */

const CREATED = "2026-01-01T00:00:00.000Z";
const NOW = "2026-09-26T12:00:00.000Z";

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
function seedVector(seed: number): number[] {
  let state = (Math.imul(seed, 0x9e3779b1) + 0x7f4a7c15) >>> 0;
  const raw: number[] = [];
  for (let index = 0; index < SEARCH_VECTOR_DIMENSIONS; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    raw.push(state / 4294967296 - 0.5);
  }
  return normalizeEmbeddingVector(raw, SEARCH_VECTOR_DIMENSIONS);
}

interface Row {
  index: number;
  title: string;
  sourceKey: string;
  caseKey: string | null;
  caseNumbers: string | null;
}

const CORPUS: Row[] = [
  { index: 1, title: "Klimaschutz Beschluss", sourceKey: "de-bverfg", caseKey: "1 BvR 2656/18", caseNumbers: "1 BvR 2656/18" },
  { index: 2, title: "Wahlrecht Beschluss", sourceKey: "de-bverfg", caseKey: null, caseNumbers: null },
  { index: 3, title: "Décision 2026-1194 QPC", sourceKey: "fr-conseil-constitutionnel", caseKey: "2026-1194 QPC", caseNumbers: "2026-1194 QPC" },
];

function publications(rows: readonly Row[]): SearchPublicationP3Row[] {
  return rows.map((entry) => ({
    id: publicationId(entry.index),
    article_id: articleId(entry.index),
    state: "published",
    version_id: versionId(entry.index),
    created_at: CREATED,
    updated_at: CREATED,
  }));
}
function versions(rows: readonly Row[]): SearchVersionP3Row[] {
  return rows.map((entry) => ({
    id: versionId(entry.index),
    article_id: articleId(entry.index),
    source_key: entry.sourceKey,
    jurisdiction: entry.sourceKey === "de-bverfg" ? "Germany" : "France",
    content_type: "decision",
    original_language: entry.sourceKey === "de-bverfg" ? "de" : "fr",
    original_title: entry.title,
    original_published_at: "2026-08-01T00:00:00.000Z",
    cleaned_text: `constitution ${entry.title}`,
    case_key: entry.caseKey,
    created_at: CREATED,
    content_hash: hex64(1000 + entry.index),
  }));
}
function artifacts(rows: readonly Row[]): ArticleEmbeddingArtifactRow[] {
  return rows.map((entry) => ({
    article_version_id: versionId(entry.index),
    article_id: articleId(entry.index),
    content_hash: hex64(1000 + entry.index),
    provider: "gemini",
    model: "gemini-embedding-001",
    dimensions: SEARCH_VECTOR_DIMENSIONS,
    input_hash: hex64(2000 + entry.index),
    embedding: seedVector(entry.index),
    generated_at: CREATED,
    updated_at: CREATED,
  }));
}

function plan(maxArticles?: number) {
  return buildSearchCanaryProjectionPlan({
    publications: publications(CORPUS),
    versions: versions(CORPUS),
    artifacts: artifacts(CORPUS),
    maxArticles,
  });
}

// ---------------------------------------------------------------------------
// Manifest / bootstrap planning
// ---------------------------------------------------------------------------

test("bootstrap plans a create for a missing canary index and all metadata indexes", () => {
  const built = planSearchCanaryVectorBootstrap({ existingIndex: null, existingMetadataIndexes: [] });
  assert.equal(built.index.action, "create");
  assert.equal(built.metadataIndexes.filter((entry) => entry.action === "create").length, VECTOR_METADATA_INDEX_MANIFEST.length);
  assert.equal(built.destructive, false);
  assert.equal(built.ok, true);
});

test("bootstrap is a no-op when the canary index and metadata indexes already exist", () => {
  const built = planSearchCanaryVectorBootstrap({
    existingIndex: { name: SEARCH_CANARY_VECTOR_INDEX, exists: true, dimensions: SEARCH_VECTOR_DIMENSIONS, metric: "cosine" },
    existingMetadataIndexes: VECTOR_METADATA_INDEX_MANIFEST.map((entry) => entry.propertyName),
  });
  assert.equal(built.index.action, "none");
  assert.equal(built.metadataIndexes.every((entry) => entry.action === "none"), true);
  assert.equal(built.ok, true);
});

test("bootstrap refuses to modify an existing index with wrong dimensions", () => {
  const built = planSearchCanaryVectorBootstrap({
    existingIndex: { name: SEARCH_CANARY_VECTOR_INDEX, exists: true, dimensions: 1024, metric: "cosine" },
    existingMetadataIndexes: [],
  });
  assert.equal(built.index.action, "none");
  assert.equal(built.ok, false);
  assert.ok(built.blockers.some((blocker) => blocker.code === "canary_index_mismatch"));
});

// ---------------------------------------------------------------------------
// Literalizer
// ---------------------------------------------------------------------------

test("literalize replaces placeholders outside literals and escapes quotes", () => {
  const sql = "select * from t where a = ? and b = ? and c = 'literal ? here'";
  const rendered = literalizeStatement(sql, ["O'Brien", 42]);
  assert.equal(rendered, "select * from t where a = 'O''Brien' and b = 42 and c = 'literal ? here'");
});

test("literalize fails closed on parameter/placeholder mismatch", () => {
  assert.throws(() => literalizeStatement("select ?", []), /more placeholders/);
  assert.throws(() => literalizeStatement("select 1", ["x"]), /does not match/);
});

test("literalizeScript joins statements with a trailing semicolon", () => {
  const script = literalizeScript([{ sql: "select ?", params: [1] }, { sql: "select ?", params: ["a"] }]);
  assert.equal(script, "select 1;\nselect 'a';");
});

// ---------------------------------------------------------------------------
// CLI output parsing
// ---------------------------------------------------------------------------

test("parseRemoteD1Envelope retains rows and the rows-read metric", () => {
  const stdout = JSON.stringify([{ success: true, results: [{ article_id: "a" }], meta: { rows_read: 7, changes: 0 } }]);
  const envelope = parseRemoteD1Envelope(stdout);
  assert.deepEqual(envelope.rows, [{ article_id: "a" }]);
  assert.equal(envelope.rowsRead, 7);
});

test("parseRemoteD1Envelope fails closed on a non-successful envelope", () => {
  assert.throws(() => parseRemoteD1Envelope(JSON.stringify([{ success: false }])), /successful envelope/);
});

test("parseMetadataIndexNames accepts string and object shapes", () => {
  assert.deepEqual(parseMetadataIndexNames(JSON.stringify(["a", { propertyName: "b" }])), ["a", "b"]);
  assert.deepEqual(parseMetadataIndexNames("[]"), []);
});

test("parseVectorizeMatches accepts a bare array and an envelope", () => {
  const match = { id: "x", score: 0.9, metadata: { sourceKey: "de-bverfg" } };
  assert.deepEqual(parseVectorizeMatches(JSON.stringify([match])), [match]);
  assert.deepEqual(parseVectorizeMatches(JSON.stringify({ matches: [match] })), [match]);
  assert.throws(() => parseVectorizeMatches(JSON.stringify([{ id: "x" }])), /malformed/);
});

test("parseVectorizeMatches accepts Wrangler's human banner followed by JSON", () => {
  const stdout = `Wrangler banner\nSearching for relevant vectors...\n${JSON.stringify({
    count: 1,
    matches: [{ id: "x", score: 0.99, metadata: { sourceKey: "de-bverfg" } }],
  })}`;
  assert.deepEqual(parseVectorizeMatches(stdout), [
    { id: "x", score: 0.99, metadata: { sourceKey: "de-bverfg" } },
  ]);
});

test("parseVectorizeIndexDetail preserves async mutation progress", () => {
  const detail = parseVectorizeIndexDetail(JSON.stringify({
    dimensions: 1536,
    vectorCount: 100,
    processedUpToMutation: "mutation-1",
    processedUpToDatetime: "2026-09-25T15:30:03.904Z",
  }));
  assert.equal(detail.dimensions, 1536);
  assert.equal(detail.vectorCount, 100);
  assert.equal(detail.processedUpToMutation, "mutation-1");
  assert.equal(detail.processedUpToDatetime, "2026-09-25T15:30:03.904Z");
});

test("parseVectorizeUpsertResult requires the accepted record count", () => {
  assert.deepEqual(parseVectorizeUpsertResult(JSON.stringify({ index: SEARCH_CANARY_VECTOR_INDEX, count: 100 })), { count: 100 });
  assert.throws(() => parseVectorizeUpsertResult(JSON.stringify({ index: SEARCH_CANARY_VECTOR_INDEX })), /valid count/);
});

test("semantic oracle resolves the current published embedding server-side when vectorId is available", async () => {
  let captured = "";
  const reader = createSupabaseCanaryReader({
    runner: async (sql) => {
      captured = sql;
      return JSON.stringify([{ page: { retrievalMode: "semantic", total: 1, hasMore: false, totalIsExact: false, entries: [{ id: articleId(1), score: 1 }] } }]);
    },
  });
  const caseDef: SearchCanaryCase = {
    id: "semantic-server-side-vector",
    mode: "semantic",
    query: "constitution",
    limit: 5,
    offset: 0,
    embedding: seedVector(1),
    vectorId: articleId(1),
    expectation: { kind: "self-top", id: articleId(1), minScore: 0.99 },
  };
  const page = await reader.readOraclePage(caseDef, new Set([articleId(1)]));
  assert.equal(page.entries[0]?.id, articleId(1));
  assert.match(captured, /article_embedding_artifacts/);
  assert.match(captured, /article_publications_p3/);
  assert.ok(!captured.includes(String(caseDef.embedding?.[0])), "the raw embedding must not be rendered into the CLI SQL argument");
});

test("production semantic oracle eligibility is false when the public projection embedding is null", async () => {
  const reader = createSupabaseCanaryReader({
    runner: async () => JSON.stringify([{ eligible: false }]),
  });
  assert.equal(await reader.isProductionSemanticOracleEligible(articleId(1)), false);
});

// ---------------------------------------------------------------------------
// Cases / projection plan
// ---------------------------------------------------------------------------

test("projection plan bounds the corpus and reports the full counts", () => {
  const built = plan(2);
  assert.equal(built.documents.length, 2);
  assert.equal(built.records.length, 2);
  assert.equal(built.fullDocumentCount, 3);
  assert.equal(built.truncated, true);
  assert.equal(built.ftsDocuments.length, built.documents.length);
});

test("projection plan fails closed above the max-articles ceiling", () => {
  assert.throws(() => plan(10_000), /must not exceed/);
});

test("an empty canary projection is populated with insert-only statements", () => {
  const built = plan();
  const insertion = planSearchProjectionIncrementalSync([], built.documents, built.ftsDocuments);
  assert.equal(insertion.destructive, false);
  assert.ok(insertion.statements.length > 0);
  assert.equal(insertion.statements.some((statement) => /^DELETE\b/.test(statement.sql)), false);
});

test("the synthetic canary insert statements remain below D1's 100KB statement ceiling", () => {
  const built = plan();
  const insertion = planSearchProjectionIncrementalSync([], built.documents, built.ftsDocuments);
  for (const statement of insertion.statements) {
    const rendered = literalizeStatement(statement.sql, statement.params);
    assert.ok(Buffer.byteLength(rendered, "utf8") <= 100_000);
  }
});

test("cases are deterministic and cover exact-case, fulltext, semantic and hybrid", () => {
  const built = plan();
  const cases = buildSearchCanaryCases({ documents: built.documents, records: built.records, maxCasesPerMode: 1 });
  assert.ok(cases.some((entry) => entry.id.startsWith("exact-case-")));
  assert.ok(cases.some((entry) => entry.id.startsWith("fulltext-")));
  assert.ok(cases.some((entry) => entry.id.startsWith("semantic-")));
  assert.ok(cases.some((entry) => entry.id.startsWith("hybrid-")));
  const exact = cases.find((entry) => entry.id.startsWith("exact-case-"))!;
  assert.equal(exact.source, "de-bverfg");
  const semantic = cases.find((entry) => entry.mode === "semantic")!;
  assert.equal(semantic.embedding?.length, SEARCH_VECTOR_DIMENSIONS);
  assert.equal(semantic.vectorId, semantic.expectation.kind === "self-top" ? semantic.expectation.id : null);
});

// ---------------------------------------------------------------------------
// Evaluation + thresholds
// ---------------------------------------------------------------------------

function payload(ids: string[]): { entries: { id: string; semanticSimilarity?: number }[]; retrievalMode: "fulltext" | "semantic" | "hybrid"; total: number; hasMore: boolean; totalIsExact: boolean } {
  return { entries: ids.map((id) => ({ id })), retrievalMode: "fulltext", total: ids.length, hasMore: false, totalIsExact: false };
}

test("evaluate honors top-id, contains and exact-order expectations", () => {
  const topId: SearchCanaryCase = { id: "c", mode: "fulltext", query: "q", limit: 5, offset: 0, expectation: { kind: "top-id", id: "a" } };
  assert.equal(evaluateSearchCanaryCase({ case: topId, payload: payload(["a", "b"]), latencyMs: 1 }).status, "pass");
  assert.equal(evaluateSearchCanaryCase({ case: topId, payload: payload(["b", "a"]), latencyMs: 1 }).status, "mismatch");

  const contains: SearchCanaryCase = { id: "c", mode: "fulltext", query: "q", limit: 5, offset: 0, expectation: { kind: "contains", id: "b", withinTop: 2 } };
  assert.equal(evaluateSearchCanaryCase({ case: contains, payload: payload(["a", "b"]), latencyMs: 1 }).status, "pass");

  const order: SearchCanaryCase = { id: "c", mode: "fulltext", query: "q", limit: 5, offset: 0, expectation: { kind: "exact-order", ids: ["a", "b"] } };
  assert.equal(evaluateSearchCanaryCase({ case: order, payload: payload(["a", "b", "c"]), latencyMs: 1 }).status, "pass");
  assert.equal(evaluateSearchCanaryCase({ case: order, payload: payload(["b", "a"]), latencyMs: 1 }).status, "mismatch");
});

test("oracle parity requires top-id for lexical and membership for semantic/hybrid", () => {
  assert.equal(oracleParity("fulltext", ["a", "b"], ["a", "b"]), "match");
  assert.equal(oracleParity("fulltext", ["b", "a"], ["a", "b"]), "mismatch");
  assert.equal(oracleParity("semantic", ["x", "a"], ["a", "b"]), "match");
  assert.equal(oracleParity("hybrid", ["x", "y"], ["a"]), "mismatch");
  assert.equal(oracleParity("semantic", ["a"], []), "absent");
});

test("a lexical oracle mismatch fails an otherwise-satisfied case", () => {
  const caseDef: SearchCanaryCase = { id: "c", mode: "fulltext", query: "q", limit: 5, offset: 0, expectation: { kind: "contains", id: "a", withinTop: 5 } };
  const observation = evaluateSearchCanaryCase({
    case: caseDef,
    payload: payload(["a", "b"]),
    latencyMs: 5,
    oracle: payload(["b", "a"]),
  });
  assert.equal(observation.status, "mismatch");
  assert.equal(observation.oracleParity, "mismatch");
});

test("metrics require enough compared cases and reject any mismatch or latency overflow", () => {
  const base: SearchCanaryCase = { id: "c", mode: "fulltext", query: "q", limit: 5, offset: 0, expectation: { kind: "top-id", id: "a" } };
  const pass = evaluateSearchCanaryCase({ case: base, payload: payload(["a"]), latencyMs: 10 });
  const insufficient = summarizeSearchCanary([pass], { minCasesPerMode: 2, maxMismatchRate: 0, maxErrorRate: 0, maxTimeoutRate: 0, maxLatencyP50Ms: 100, maxLatencyP95Ms: 100 });
  assert.equal(insufficient.pass, false);

  const slow = evaluateSearchCanaryCase({ case: base, payload: payload(["a"]), latencyMs: 5000 });
  const tooSlow = summarizeSearchCanary([slow], { minCasesPerMode: 1, maxMismatchRate: 0, maxErrorRate: 0, maxTimeoutRate: 0, maxLatencyP50Ms: 100, maxLatencyP95Ms: 100 });
  assert.equal(tooSlow.pass, false);
});

test("percentile uses nearest-rank semantics", () => {
  assert.equal(percentile([10, 20, 30, 40], 0.5), 20);
  assert.equal(percentile([10, 20, 30, 40], 0.95), 40);
  assert.equal(percentile([], 0.5), 0);
});

test("error observations are counted as errors, never as compared", () => {
  const caseDef: SearchCanaryCase = { id: "c", mode: "semantic", query: "q", limit: 5, offset: 0, expectation: { kind: "top-id", id: "a" } };
  const error = searchCanaryErrorObservation({ case: caseDef, status: "error", latencyMs: 1, errorCode: "vectorize_unavailable" });
  const metrics = summarizeSearchCanary([error]);
  assert.equal(metrics.modes.find((mode) => mode.mode === "semantic")?.errored, 1);
  assert.equal(metrics.totalCompared, 0);
});

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

test("report is deterministic and markdown carries the verdict without vector values", () => {
  const built = plan();
  const id = articleId(1);
  const modes: { mode: "fulltext" | "semantic" | "hybrid"; payload: ReturnType<typeof payload> }[] = [
    { mode: "fulltext", payload: payload([id]) },
    { mode: "semantic", payload: { entries: [{ id, semanticSimilarity: 0.999 }], retrievalMode: "semantic", total: 1, hasMore: false, totalIsExact: false } },
    { mode: "hybrid", payload: payload([id]) },
  ];
  const observations = modes.map((entry) => {
    const caseDef: SearchCanaryCase = { id: `${entry.mode}-${id}`, mode: entry.mode, query: "q", limit: 5, offset: 0, expectation: { kind: "top-id", id } };
    return evaluateSearchCanaryCase({ case: caseDef, payload: entry.payload, latencyMs: 12, oracle: entry.payload });
  });
  const report = buildSearchCanaryReport({
    generatedAt: NOW,
    vectorIndex: SEARCH_CANARY_VECTOR_INDEX,
    database: "worldcons_search_canary",
    source: "fixture",
    projection: built,
    vectorBootstrap: planSearchCanaryVectorBootstrap({ existingIndex: null, existingMetadataIndexes: [] }),
    remoteWrites: { indexCreated: false, metadataIndexesCreated: [], vectorsUpserted: 0, searchRowsInserted: 0, databaseCreated: false },
    observations,
  });
  const markdown = renderSearchCanaryMarkdown(report);
  assert.match(markdown, /verdict: \*\*pass\*\*/);
  assert.ok(!markdown.includes("0.123"), "markdown must not contain vector values");
  assert.equal(report.verdict, "pass");
  assert.equal(report.observations[1].oracleParity, "match");
});

test("report verdict is insufficient_evidence when nothing was compared", () => {
  const built = plan();
  const report = buildSearchCanaryReport({
    generatedAt: NOW,
    vectorIndex: SEARCH_CANARY_VECTOR_INDEX,
    database: "worldcons_search_canary",
    source: "fixture",
    projection: built,
    vectorBootstrap: null,
    remoteWrites: { indexCreated: false, metadataIndexesCreated: [], vectorsUpserted: 0, searchRowsInserted: 0, databaseCreated: false },
    observations: [],
  });
  assert.equal(report.verdict, "insufficient_evidence");
});

// ---------------------------------------------------------------------------
// Runtime neutrality
// ---------------------------------------------------------------------------

test("the runtime-neutral search-canary barrel imports no node builtin", () => {
  const dir = path.join(process.cwd(), "lib", "cloudflare", "search-canary");
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".ts")) continue;
    const source = fs.readFileSync(path.join(dir, file), "utf8");
    assert.ok(!/from\s+["']node:/.test(source), `${file} must not import a node builtin`);
    assert.ok(!/require\(["']node:/.test(source), `${file} must not require a node builtin`);
  }
});
