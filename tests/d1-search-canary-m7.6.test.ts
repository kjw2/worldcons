import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  SEARCH_CANARY_DEFAULT_THRESHOLDS,
  artifactReferenceParity,
  buildSearchCanaryReport,
  buildSearchCanaryWritePlan,
  deriveSearchCanaryRankBlockers,
  evaluateSearchCanaryCase,
  executeSearchCanaryWritePlan,
  isAuthorizedCanaryRequest,
  isCanaryDevUnauthorized,
  isLoopbackCanaryHostname,
  SEARCH_CANARY_DEV_UNAUTH_ENV,
  parseCanaryWorkerD1Response,
  parseCanaryWorkerD1Statement,
  parseCanaryWorkerRunRequest,
  parseCanaryWorkerRunResponse,
  planSearchCanaryProjectionExtension,
  renderCanaryWorkerError,
  renderSearchCanaryMarkdown,
  resolveSearchCanaryOracleMode,
  summarizeSearchCanary,
  summarizeSearchCanaryExpansionIssues,
  summarizeSearchCanaryTimings,
  summarizeSearchCanaryWritePlan,
  buildCanaryQueryEmbedding,
  hasCanaryVectorId,
  SEARCH_CANARY_QUERY_EMBEDDING_DIMENSIONS,
  SEARCH_CANARY_VECTOR_ID_REQUIRED_CODE,
  type SearchCanaryCase,
  type SearchCanaryObservation,
} from "../lib/cloudflare/search-canary";
import type { SearchProjectionDocument, SearchProjectionFtsDocument } from "../lib/cloudflare/search-projection";
import {
  assertLoopbackCanaryEndpoint,
  createLocalDevSearchCanaryWriter,
  createWorkerSearchCanaryWriter,
  resolveSearchCanaryBindingTarget,
  resolveSearchCanaryWriter,
  runWorkerCanaryCases,
} from "../lib/cloudflare/search-canary/operator/parameterized-writer";
import worker from "../workers/search-canary/src/index";

/**
 * M7.6 isolated canary tests: worker contract, parameterized writer, auth/no-leak,
 * artifact-reference oracle and the runtime-neutral boundary. No network, no
 * Supabase, no Wrangler and no remote resource.
 */

const CREATED = "2026-01-01T00:00:00.000Z";

function articleId(index: number): string {
  return `aaaaaaaa-0000-0000-0000-${String(index).padStart(12, "0")}`;
}

function hex64(seed: number): string {
  return seed.toString(16).padStart(64, "0").slice(-64);
}

function payload(ids: string[], mode: "fulltext" | "semantic" | "hybrid" = "fulltext") {
  return {
    entries: ids.map((id) => ({ id })),
    retrievalMode: mode,
    total: ids.length,
    hasMore: false,
    totalIsExact: false,
  };
}

function caseDef(overrides: Partial<SearchCanaryCase> = {}): SearchCanaryCase {
  return { id: "c", mode: "fulltext", query: "q", limit: 5, offset: 0, expectation: { kind: "top-id", id: "a" }, ...overrides };
}

// ---------------------------------------------------------------------------
// Worker contract
// ---------------------------------------------------------------------------

test("worker contract parses a valid parameterized D1 statement", () => {
  const parsed = parseCanaryWorkerD1Statement({ sql: "insert into t (a) values (?)", params: ["x", 1, null] });
  assert.equal(parsed.sql, "insert into t (a) values (?)");
  assert.deepEqual(parsed.params, ["x", 1, null]);
});

test("worker contract fails closed on a malformed D1 statement", () => {
  assert.throws(() => parseCanaryWorkerD1Statement({ sql: "", params: [] }), /sql is required/);
  assert.throws(() => parseCanaryWorkerD1Statement({ sql: "select 1" }), /params must be an array/);
  assert.throws(() => parseCanaryWorkerD1Statement({ sql: "select ?", params: [{}] }), /param is unsupported/);
  assert.throws(() => parseCanaryWorkerD1Statement(null), /must be an object/);
});

test("worker contract parses D1 results and rejects invalid change counts", () => {
  assert.deepEqual(parseCanaryWorkerD1Response({ ok: true, changes: 2, rowsRead: 0 }), { ok: true, changes: 2, rowsRead: 0 });
  assert.deepEqual(parseCanaryWorkerD1Response({ ok: false, error: "d1_error" }), { ok: false, error: "d1_error" });
  assert.throws(() => parseCanaryWorkerD1Response({ ok: true, changes: -1, rowsRead: 0 }), /changes is invalid/);
});

test("worker contract parses a run request and response", () => {
  const cases = parseCanaryWorkerRunRequest({
    cases: [{ id: "semantic-1", mode: "semantic", query: "q", limit: 5, offset: 0, vectorId: "a" }],
  });
  assert.equal(cases.length, 1);
  assert.equal(cases[0].vectorId, "a");
  assert.throws(() => parseCanaryWorkerRunRequest({ cases: [] }), /non-empty cases/);
  const response = parseCanaryWorkerRunResponse({
    ok: true,
    observations: [{ caseId: "semantic-1", latencyMs: 12, topIds: ["a"], retrievalMode: "semantic" }],
  });
  assert.equal(response.observations.length, 1);
});

// ---------------------------------------------------------------------------
// Auth / no-leak
// ---------------------------------------------------------------------------

test("canary worker auth accepts only the exact bearer token and fails closed", () => {
  const token = "0123456789abcdef";
  assert.equal(isAuthorizedCanaryRequest(`Bearer ${token}`, token), true);
  assert.equal(isAuthorizedCanaryRequest(`Bearer ${token}x`, token), false);
  assert.equal(isAuthorizedCanaryRequest("Basic abc", token), false);
  assert.equal(isAuthorizedCanaryRequest(null, token), false);
  assert.equal(isAuthorizedCanaryRequest(`Bearer ${token}`, "short"), false);
  assert.equal(isAuthorizedCanaryRequest(`Bearer ${token}`, undefined), false);
});

test("canary worker error bodies never leak a token and collapse unknown codes", () => {
  const token = "super-secret-token-value";
  const body = renderCanaryWorkerError(`unauthorized ${token}`);
  assert.deepEqual(body, { ok: false, error: "canary_worker_error" });
  assert.ok(!JSON.stringify(body).includes(token));
  assert.deepEqual(renderCanaryWorkerError("d1_statement_failed"), { ok: false, error: "d1_statement_failed" });
});

test("the worker writer surfaces a bounded error without the token", async () => {
  const token = "super-secret-token-value";
  const writer = createWorkerSearchCanaryWriter({
    endpoint: "https://canary.example",
    token,
    fetch: async () => new Response("denied", { status: 403 }),
  });
  await assert.rejects(
    () => writer.execute({ sql: "insert into t (a) values (?)", params: ["x"] }),
    (error: Error) => !error.message.includes(token),
  );
});

test("the binding canary sends only ids/latency fields with the bearer token", async () => {
  let capturedUrl = "";
  let capturedAuth = "";
  let capturedBody = "";
  const results = await runWorkerCanaryCases(
    {
      endpoint: "https://canary.example/",
      token: "0123456789abcdef",
      fetch: async (input, init) => {
        capturedUrl = String(input);
        capturedAuth = new Headers(init?.headers).get("authorization") ?? "";
        capturedBody = String(init?.body ?? "");
        return new Response(
          JSON.stringify({ ok: true, observations: [{ caseId: "semantic-1", latencyMs: 7, topIds: ["a"], retrievalMode: "semantic" }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    },
    [{ id: "semantic-1", mode: "semantic", query: "q", limit: 5, offset: 0, vectorId: "a" }],
  );
  assert.equal(capturedUrl, "https://canary.example/canary/run");
  assert.equal(capturedAuth, "Bearer 0123456789abcdef");
  assert.ok(!capturedBody.includes("embedding"));
  assert.ok(!capturedBody.includes("expectation"));
  assert.deepEqual(results, [{ caseId: "semantic-1", latencyMs: 7, topIds: ["a"], retrievalMode: "semantic", errorCode: null }]);
});

// ---------------------------------------------------------------------------
// Parameterized writer
// ---------------------------------------------------------------------------

test("write plan keeps a large document as a bound parameter and never literalizes it", () => {
  const bigDocument = "constitution ".repeat(20_000);
  const plan = buildSearchCanaryWritePlan([
    { sql: "insert into search_documents (article_id, search_text) values (?, ?)", params: ["a", bigDocument] },
  ]);
  assert.equal(plan.destructive, false);
  assert.equal(plan.counts.statements, 1);
  assert.equal(plan.counts.parameters, 2);
  assert.equal(plan.counts.literalOversizedStatements, 1);
  assert.ok(plan.counts.maxLiteralBytes > 100_000);
  assert.ok(!plan.statements[0].sql.includes("constitution"));
  assert.equal(plan.statements[0].params[1], bigDocument);
});

test("write plan refuses a non-INSERT statement and an unsupported param", () => {
  assert.throws(() => buildSearchCanaryWritePlan([{ sql: "delete from t", params: [] }]), /refuses a non-INSERT/);
  assert.throws(() => buildSearchCanaryWritePlan([{ sql: "insert into t (a) values (?)", params: [new Uint8Array([1])] }]), /string\/number\/null/);
});

test("write plan execution is serial and sums the affected rows", async () => {
  const plan = buildSearchCanaryWritePlan([
    { sql: "insert into t (a) values (?)", params: ["x"] },
    { sql: "insert into t (a) values (?)", params: ["y"] },
  ]);
  const seen: string[] = [];
  const result = await executeSearchCanaryWritePlan(plan, "worker-binding", async (statement) => {
    seen.push(statement.params[0] as string);
    return 1;
  });
  assert.deepEqual(seen, ["x", "y"]);
  assert.deepEqual(result, { transport: "worker-binding", executedStatements: 2, totalChanges: 2 });
});

// ---------------------------------------------------------------------------
// Artifact-reference oracle / drift
// ---------------------------------------------------------------------------

test("oracle mode resolution is explicit for lexical, semantic and unavailable cases", () => {
  assert.equal(resolveSearchCanaryOracleMode({ mode: "fulltext", productionOracleAvailable: true, productionSemanticEligible: false, artifactBacked: false }).mode, "production-rpc");
  assert.equal(resolveSearchCanaryOracleMode({ mode: "fulltext", productionOracleAvailable: false, productionSemanticEligible: false, artifactBacked: false }).mode, "none");

  const eligible = resolveSearchCanaryOracleMode({ mode: "semantic", productionOracleAvailable: true, productionSemanticEligible: true, artifactBacked: true });
  assert.equal(eligible.mode, "production-rpc");
  assert.equal(eligible.drift, false);

  const drifted = resolveSearchCanaryOracleMode({ mode: "semantic", productionOracleAvailable: true, productionSemanticEligible: false, artifactBacked: true });
  assert.equal(drifted.mode, "artifact-reference");
  assert.equal(drifted.drift, true);

  const noOracle = resolveSearchCanaryOracleMode({ mode: "hybrid", productionOracleAvailable: false, productionSemanticEligible: false, artifactBacked: true });
  assert.equal(noOracle.mode, "artifact-reference");
  assert.equal(noOracle.drift, false);

  assert.equal(resolveSearchCanaryOracleMode({ mode: "semantic", productionOracleAvailable: false, productionSemanticEligible: false, artifactBacked: false }).mode, "none");
});

test("artifact reference parity follows the frozen expectation with no production call", () => {
  assert.equal(artifactReferenceParity(caseDef(), payload(["a", "b"])), "match");
  assert.equal(artifactReferenceParity(caseDef(), payload(["b", "a"])), "mismatch");
});

test("evaluate records the explicit oracle mode and drift", () => {
  const observation = evaluateSearchCanaryCase({
    case: caseDef(),
    payload: payload(["a"]),
    latencyMs: 5,
    oracleMode: "artifact-reference",
    oracleDrift: true,
    oracle: null,
  });
  assert.equal(observation.status, "pass");
  assert.equal(observation.oracleMode, "artifact-reference");
  assert.equal(observation.oracleDrift, true);
  assert.equal(observation.oracleParity, "match");

  const driftedMismatch = evaluateSearchCanaryCase({
    case: caseDef(),
    payload: payload(["b"]),
    latencyMs: 5,
    oracleMode: "artifact-reference",
    oracleDrift: true,
  });
  assert.equal(driftedMismatch.status, "mismatch");
  assert.equal(driftedMismatch.oracleParity, "mismatch");
});

// ---------------------------------------------------------------------------
// Timing separation
// ---------------------------------------------------------------------------

function withBindings(operatorLatency: number, bindingLatency: number | null): SearchCanaryObservation {
  return evaluateSearchCanaryCase({
    case: caseDef(),
    payload: payload(["a"]),
    latencyMs: operatorLatency,
    bindingLatencyMs: bindingLatency,
  });
}

test("timings keep operator wall time separate from binding/runtime latency", () => {
  const timings = summarizeSearchCanaryTimings([withBindings(100, 10), withBindings(200, 20), withBindings(300, null)]);
  assert.equal(timings.operator.samples, 3);
  assert.equal(timings.binding.samples, 2);
  assert.equal(timings.operator.p50Ms, 200);
  assert.equal(timings.binding.p50Ms, 10);
});

test("runtime binding thresholds gate only when binding samples exist", () => {
  const slowOperatorFastBinding = summarizeSearchCanary([withBindings(10, 5000)], {
    ...SEARCH_CANARY_DEFAULT_THRESHOLDS,
    maxLatencyP50Ms: 1000,
    maxLatencyP95Ms: 1000,
    maxBindingLatencyP50Ms: 100,
    maxBindingLatencyP95Ms: 100,
  });
  assert.equal(slowOperatorFastBinding.modes.find((mode) => mode.mode === "fulltext")?.pass, false);

  const noBindingSamples = evaluateSearchCanaryCase({ case: caseDef(), payload: payload(["a"]), latencyMs: 10 });
  const metrics = summarizeSearchCanary([noBindingSamples], {
    ...SEARCH_CANARY_DEFAULT_THRESHOLDS,
    maxLatencyP50Ms: 1000,
    maxLatencyP95Ms: 1000,
    maxBindingLatencyP50Ms: 100,
    maxBindingLatencyP95Ms: 100,
  });
  assert.equal(metrics.bindingSamples, 0);
  assert.equal(metrics.modes.find((mode) => mode.mode === "fulltext")?.pass, true);
});

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

test("report carries the write plan summary, timings and oracle accounting", () => {
  const writePlan = buildSearchCanaryWritePlan([{ sql: "insert into t (a) values (?)", params: ["a"] }]);
  const observation = withBindings(12, 3);
  const report = buildSearchCanaryReport({
    generatedAt: "2026-09-26T00:00:00.000Z",
    vectorIndex: "worldcons-search-canary-v2",
    database: "worldcons_search_canary_v2",
    source: "fixture",
    projection: {
      version: 1,
      maxArticles: 1,
      truncated: false,
      documents: [],
      records: [],
      changes: { projectedDocuments: 1, vectorRecords: 0, missingArtifacts: 0, staleArtifacts: 0 },
      blockers: [],
      manifest: { searchHash: "x", vectorHash: "y" },
    },
    vectorBootstrap: null,
    remoteWrites: {
      indexCreated: false,
      metadataIndexesCreated: [],
      vectorsUpserted: 0,
      searchRowsInserted: 1,
      databaseCreated: false,
      writer: "worker-binding",
      parameterizedStatements: 1,
      literalOversizedStatements: 0,
    },
    writePlan: summarizeSearchCanaryWritePlan(writePlan),
    observations: [observation],
  });
  assert.equal(report.writePlan?.counts.statements, 1);
  assert.ok(report.writePlan && !("statements" in report.writePlan), "the report must never carry executable statements");
  assert.equal(report.timings.binding.samples, 1);
  assert.equal(report.remoteWrites.writer, "worker-binding");
  const markdown = renderSearchCanaryMarkdown(report);
  assert.match(markdown, /## Timings/);
  assert.match(markdown, /## Oracle modes/);
  assert.match(markdown, /parameterizedStatements=1/);
  assert.match(markdown, /maxAuthoredSqlBytes=\d+/);
});

// ---------------------------------------------------------------------------
// No-content evidence (M7.6 safety regression)
// ---------------------------------------------------------------------------

// Unique sentinel that must never survive into any serialized report/output.
const LEAK_SENTINEL = "M7.6_NO_LEAK_SENTINEL_9f3c2a7d";

function reportWithWritePlan(writePlan: Parameters<typeof buildSearchCanaryReport>[0]["writePlan"]) {
  return buildSearchCanaryReport({
    generatedAt: "2026-09-26T00:00:00.000Z",
    vectorIndex: "worldcons-search-canary-v2",
    database: "worldcons_search_canary_v2",
    source: "fixture",
    projection: {
      version: 1,
      maxArticles: 1,
      truncated: false,
      documents: [],
      records: [],
      changes: { projectedDocuments: 1, vectorRecords: 0, missingArtifacts: 0, staleArtifacts: 0 },
      blockers: [],
      manifest: { searchHash: "x", vectorHash: "y" },
    },
    vectorBootstrap: null,
    remoteWrites: { indexCreated: false, metadataIndexesCreated: [], vectorsUpserted: 0, searchRowsInserted: 1, databaseCreated: false },
    writePlan,
    observations: [],
  });
}

test("a large sentinel search_text never reaches JSON, markdown, summary or output summaries", () => {
  const bigSearchText = `${LEAK_SENTINEL} ` + "constitution ".repeat(12_000);
  const plan = buildSearchCanaryWritePlan([
    { sql: "insert into search_documents (article_id, search_text) values (?, ?)", params: ["article-1", bigSearchText] },
  ]);

  // The executable in-memory plan still carries the value for the write transport.
  assert.equal(plan.statements[0].params[1], bigSearchText);

  // Its content-free summary carries sizes/counts only.
  const summary = summarizeSearchCanaryWritePlan(plan);
  const summaryJson = JSON.stringify(summary);
  assert.ok(!summaryJson.includes(LEAK_SENTINEL), "summary must not contain bound param content");
  assert.ok(!("statements" in summary), "summary must not expose executable statements");
  assert.equal(summary.counts.statements, 1);
  assert.equal(summary.counts.parameters, 2);
  assert.equal(summary.counts.literalOversizedStatements, 1);
  assert.ok(summary.counts.literalOversizedBytes > 100_000);
  assert.ok(summary.counts.maxParamBytes >= bigSearchText.length);
  assert.ok(summary.counts.maxAuthoredSqlBytes < 100);

  // The report, its JSON and its markdown are all content-free.
  const report = reportWithWritePlan(summary);
  const json = JSON.stringify(report);
  const markdown = renderSearchCanaryMarkdown(report);
  assert.ok(!json.includes(LEAK_SENTINEL), "JSON report must not contain the bound search_text");
  assert.ok(!markdown.includes(LEAK_SENTINEL), "markdown report must not contain the bound search_text");
  assert.ok(!json.includes('"params"'), "JSON report must not contain a params field");
  assert.ok(report.writePlan && !("statements" in report.writePlan), "report must never carry executable statements");
});

test("a thrown write error does not echo the bound search_text", async () => {
  const bigSearchText = `${LEAK_SENTINEL} ` + "constitution ".repeat(12_000);
  const plan = buildSearchCanaryWritePlan([
    { sql: "insert into search_documents (article_id, search_text) values (?, ?)", params: ["article-1", bigSearchText] },
  ]);
  // The operator error path only ever surfaces bounded, value-free transport
  // errors; a rejected write must never leak the param it was carrying.
  await assert.rejects(
    () =>
      executeSearchCanaryWritePlan(plan, "worker-binding", async () => {
        throw new Error("canary worker d1 statement failed (status 500)");
      }),
    (error: Error) => !error.message.includes(LEAK_SENTINEL),
  );
});

test("the canary CLI passes only the write-plan summary to the report and never logs it", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "scripts", "d1-search-canary.ts"), "utf8");
  assert.match(source, /writePlan: summarizeSearchCanaryWritePlan\(/, "the CLI must summarize the executable plan for the report");
  assert.ok(!/JSON\.stringify\([^)]*writePlanInfo\.writePlan/.test(source), "the CLI must not serialize the executable plan");
  assert.ok(!/console\.(log|error|warn)\([^)]*\.params\b/.test(source), "the CLI must not log bound params");
  assert.ok(!/console\.(log|error|warn)\([^)]*writePlan\.statements/.test(source), "the CLI must not log executable statements");
});

// ---------------------------------------------------------------------------
// Append-only projection expansion (15 -> 100)
// ---------------------------------------------------------------------------

function projectionDocument(index: number): SearchProjectionDocument {
  return {
    article_id: articleId(index),
    jurisdiction: "Germany",
    source_key: "de-bverfg",
    language: "de",
    content_type: "decision",
    publication_state: "published",
    review_state: null,
    original_published_at: "2026-08-01T00:00:00.000Z",
    display_title: `Decision ${index}`,
    case_numbers: null,
    search_text: `constitution decision ${index}`,
    tags_text: null,
    projection_version: 1,
    checksum: hex64(index),
    updated_at: CREATED,
  };
}

function projectionFtsDocument(index: number): SearchProjectionFtsDocument {
  return {
    article_id: articleId(index),
    title: `decision ${index}`,
    case_numbers: "",
    search_text: `constitution decision ${index}`,
    tags_text: "",
  };
}

function extensionCorpus(count: number): {
  documents: SearchProjectionDocument[];
  ftsDocuments: SearchProjectionFtsDocument[];
} {
  return {
    documents: Array.from({ length: count }, (_, index) => projectionDocument(index + 1)),
    ftsDocuments: Array.from({ length: count }, (_, index) => projectionFtsDocument(index + 1)),
  };
}

function currentRow(document: SearchProjectionDocument): { article_id: string; checksum: string; projection_version: number } {
  return { article_id: document.article_id, checksum: document.checksum, projection_version: document.projection_version };
}

test("a verified 15-row canary expands append-only to a 100-row projection", () => {
  const { documents, ftsDocuments } = extensionCorpus(100);
  const currentDocuments = documents.slice(0, 15).map(currentRow);
  const plan = planSearchCanaryProjectionExtension({
    documents,
    ftsDocuments,
    currentDocuments,
    currentFtsArticleIds: currentDocuments.map((row) => row.article_id),
  });

  assert.equal(plan.ok, true);
  assert.equal(plan.noop, false);
  assert.equal(plan.desiredDocumentCount, 100);
  assert.equal(plan.currentDocumentCount, 15);
  assert.equal(plan.insertedDocuments, 85);
  assert.equal(plan.missingDocumentIds.length, 85);
  assert.equal(plan.plan.destructive, false);
  assert.equal(plan.plan.counts.statements, 170);
  assert.ok(plan.plan.statements.every((statement) => /^\s*insert\b/i.test(statement.sql)), "only INSERT statements are planned");
  assert.ok(
    plan.plan.statements.every((statement) => !/^\s*(delete|update|replace)\b/i.test(statement.sql)),
    "no destructive statement is planned",
  );
  const plannedIds = new Set(plan.plan.statements.map((statement) => String(statement.params[0])));
  const expectedIds = new Set(documents.slice(15).map((document) => document.article_id));
  assert.deepEqual([...plannedIds].sort(), [...expectedIds].sort());
});

test("expansion fails closed on a remote-only canary id", () => {
  const { documents, ftsDocuments } = extensionCorpus(3);
  const remoteOnly = articleId(99);
  const currentDocuments = [currentRow(documents[0]), { article_id: remoteOnly, checksum: "remote", projection_version: 1 }];
  const plan = planSearchCanaryProjectionExtension({
    documents,
    ftsDocuments,
    currentDocuments,
    currentFtsArticleIds: [documents[0].article_id, remoteOnly],
  });

  assert.equal(plan.ok, false);
  assert.equal(plan.insertedDocuments, 0);
  assert.equal(plan.plan.counts.statements, 0);
  assert.deepEqual(plan.missingDocumentIds, []);
  assert.ok(plan.issues.some((issue) => issue.code === "remote_only_document" && issue.articleId === remoteOnly));
  assert.ok(plan.issues.some((issue) => issue.code === "remote_only_fts" && issue.articleId === remoteOnly));
  const summary = summarizeSearchCanaryExpansionIssues(plan.issues);
  assert.match(summary, /remote_only_document=1/);
  assert.ok(!summary.includes(remoteOnly), "the issue summary is content-free");
});

test("expansion fails closed on a checksum mismatch for an overlapping id", () => {
  const { documents, ftsDocuments } = extensionCorpus(3);
  const currentDocuments = documents.map(currentRow);
  currentDocuments[1] = { ...currentDocuments[1], checksum: "not-the-desired-checksum" };
  const plan = planSearchCanaryProjectionExtension({
    documents,
    ftsDocuments,
    currentDocuments,
    currentFtsArticleIds: currentDocuments.map((row) => row.article_id),
  });

  assert.equal(plan.ok, false);
  assert.equal(plan.insertedDocuments, 0);
  assert.equal(plan.plan.counts.statements, 0);
  assert.ok(plan.issues.some((issue) => issue.code === "checksum_mismatch" && issue.articleId === documents[1].article_id));
});

test("expansion fails closed on a projection-version mismatch", () => {
  const { documents, ftsDocuments } = extensionCorpus(3);
  const currentDocuments = documents.map(currentRow);
  currentDocuments[0] = { ...currentDocuments[0], projection_version: 0 };
  const plan = planSearchCanaryProjectionExtension({
    documents,
    ftsDocuments,
    currentDocuments,
    currentFtsArticleIds: currentDocuments.map((row) => row.article_id),
  });

  assert.equal(plan.ok, false);
  assert.ok(plan.issues.some((issue) => issue.code === "projection_version_mismatch" && issue.articleId === documents[0].article_id));
});

test("expansion fails closed when search_fts identity diverges from search_documents", () => {
  const { documents, ftsDocuments } = extensionCorpus(3);
  const currentDocuments = documents.map(currentRow);
  const plan = planSearchCanaryProjectionExtension({
    documents,
    ftsDocuments,
    currentDocuments,
    currentFtsArticleIds: [documents[0].article_id, documents[1].article_id],
  });

  assert.equal(plan.ok, false);
  assert.equal(plan.plan.counts.statements, 0);
  assert.ok(plan.issues.some((issue) => issue.code === "fts_identity_mismatch" && issue.articleId === documents[2].article_id));
});

test("an exact existing canary projection is a true no-op", () => {
  const { documents, ftsDocuments } = extensionCorpus(15);
  const plan = planSearchCanaryProjectionExtension({
    documents,
    ftsDocuments,
    currentDocuments: documents.map(currentRow),
    currentFtsArticleIds: documents.map((document) => document.article_id),
  });

  assert.equal(plan.ok, true);
  assert.equal(plan.noop, true);
  assert.equal(plan.insertedDocuments, 0);
  assert.deepEqual(plan.missingDocumentIds, []);
  assert.equal(plan.plan.counts.statements, 0);
  assert.equal(plan.plan.destructive, false);
});

// ---------------------------------------------------------------------------
// Runtime-neutral boundary + isolated config
// ---------------------------------------------------------------------------

test("the runtime-neutral canary modules import no node builtin and exclude the operator", () => {
  const dir = path.join(process.cwd(), "lib", "cloudflare", "search-canary");
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".ts")) continue;
    const source = fs.readFileSync(path.join(dir, file), "utf8");
    assert.ok(!/from\s+["']node:/.test(source), `${file} must not import a node builtin`);
    assert.ok(!/require\(["']node:/.test(source), `${file} must not require a node builtin`);
  }
  const barrel = fs.readFileSync(path.join(dir, "index.ts"), "utf8");
  assert.ok(!/from\s+["']\.\/operator/.test(barrel), "the runtime-neutral barrel must not export the operator adapters");
});

test("the isolated canary Worker config has no production route and the production config is untouched", () => {
  const canaryConfig = fs.readFileSync(path.join(process.cwd(), "workers", "search-canary", "wrangler.jsonc"), "utf8");
  assert.ok(!/"routes"\s*:/.test(canaryConfig), "canary config must declare no routes");
  assert.ok(!/"route"\s*:/.test(canaryConfig), "canary config must declare no route");
  assert.ok(!/"domain"\s*:/.test(canaryConfig), "canary config must declare no custom domain");
  assert.match(canaryConfig, /"worldcons_search_canary_v2"/);
  assert.match(canaryConfig, /"worldcons-search-canary-v2"/);

  const productionConfig = fs.readFileSync(path.join(process.cwd(), "wrangler.jsonc"), "utf8");
  assert.ok(!productionConfig.includes("SEARCH_CANARY"), "production wrangler.jsonc must remain unchanged");
});

test("the worker source declares real D1 + Vectorize bindings and requires auth", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "workers", "search-canary", "src", "index.ts"), "utf8");
  assert.match(source, /SEARCH_CANARY_DB/);
  assert.match(source, /SEARCH_CANARY_INDEX/);
  assert.match(source, /isAuthorizedCanaryRequest/);
  assert.ok(!/console\.log/.test(source), "the worker must not log request data");
});

// ---------------------------------------------------------------------------
// M7.6 vectorId-backed semantic/hybrid canary (binding-canary fix)
// ---------------------------------------------------------------------------

const CANARY_TOKEN = "0123456789abcdef";
const DOC_ID = "dddddddd-0000-0000-0000-000000000001";

interface CanaryWorkerObservation {
  caseId: string;
  latencyMs: number;
  errorCode?: string;
  topIds?: string[];
  retrievalMode?: string;
}

interface CanaryWorkerResponseBody {
  ok: boolean;
  observations?: CanaryWorkerObservation[];
  error?: string;
}

async function runCanaryWorker(
  cases: unknown[],
  env: { db?: unknown; index?: unknown; token?: string | null },
): Promise<{ status: number; body: CanaryWorkerResponseBody; text: string }> {
  const token = env.token === null ? undefined : (env.token ?? CANARY_TOKEN);
  const request = new Request("https://canary.example/canary/run", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({ cases }),
  });
  const response = await worker.fetch(
    request,
    {
      SEARCH_CANARY_DB: env.db,
      SEARCH_CANARY_INDEX: env.index,
      WORLDCONS_SEARCH_CANARY_TOKEN: token,
    } as unknown as Parameters<typeof worker.fetch>[1],
  );
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text) as CanaryWorkerResponseBody, text };
}

/** A Vectorize fake that records raw query vs queryById usage. */
function fakeCanaryVectorize(): {
  index: unknown;
  queryCalls: number[][];
  queryByIdCalls: { id: string; options: { topK?: number; returnValues?: boolean; returnMetadata?: string } }[];
} {
  const queryCalls: number[][] = [];
  const queryByIdCalls: { id: string; options: { topK?: number; returnValues?: boolean; returnMetadata?: string } }[] = [];
  const index = {
    async query(values: number[]): Promise<{ matches: { id: string; score: number }[] }> {
      queryCalls.push(values);
      return { matches: [] };
    },
    async queryById(id: string, options: { topK?: number; returnValues?: boolean; returnMetadata?: string }) {
      queryByIdCalls.push({ id, options });
      return { matches: [{ id: DOC_ID, score: 0.75 }], count: 1 };
    },
  };
  return { index, queryCalls, queryByIdCalls };
}

function throwingD1(): unknown {
  return {
    prepare(): never {
      throw new Error("D1 must not be read for this case");
    },
  };
}

/** A structural D1 fake: FTS query (contains bm25) vs hybrid metadata lookup. */
function fakeHybridD1(options: { ftsRows: unknown[]; metadataRows: unknown[] }): unknown {
  return {
    prepare(sql: string) {
      return {
        bind(..._params: unknown[]) {
          return {
            async all() {
              if (sql.includes("bm25(")) return { success: true, results: options.ftsRows };
              return { success: true, results: options.metadataRows };
            },
          };
        },
      };
    },
  };
}

test("the canary query embedding is a local-only 1536-d unit vector", () => {
  const embedding = buildCanaryQueryEmbedding();
  assert.equal(SEARCH_CANARY_QUERY_EMBEDDING_DIMENSIONS, 1536);
  assert.equal(embedding.length, 1536);
  assert.ok(embedding.every((value) => Number.isFinite(value)));
  const norm = Math.sqrt(embedding.reduce((sum, value) => sum + value * value, 0));
  assert.ok(Math.abs(norm - 1) < 1e-12, "the synthesized embedding must be exactly unit length");
});

test("hasCanaryVectorId rejects blank/absent/non-string ids", () => {
  assert.equal(hasCanaryVectorId("vec-1"), true);
  assert.equal(hasCanaryVectorId(""), false);
  assert.equal(hasCanaryVectorId("   "), false);
  assert.equal(hasCanaryVectorId(null), false);
  assert.equal(hasCanaryVectorId(undefined), false);
  assert.equal(hasCanaryVectorId(3), false);
});

test("the worker source is vectorId-backed and never forwards a raw query vector", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "workers", "search-canary", "src", "index.ts"), "utf8");
  assert.match(source, /hasCanaryVectorId/);
  assert.match(source, /SEARCH_CANARY_VECTOR_ID_REQUIRED_CODE/);
  assert.match(source, /buildCanaryQueryEmbedding/);
  assert.match(source, /embedding: needsVector \? buildCanaryQueryEmbedding\(\) : null/);
  assert.match(source, /async query\(_vector/);
  assert.match(source, /await index\.queryById!\(vectorId, options\)/);
  assert.ok(!source.includes("index.query("), "the canary vectorId adapter must never forward a raw query vector");
});

test("a semantic canary case resolves through queryById and ignores the local embedding", async () => {
  const vector = fakeCanaryVectorize();
  const { body, text } = await runCanaryWorker(
    [{ id: "semantic-1", mode: "semantic", query: "constitution", limit: 5, offset: 0, vectorId: "vec-1" }],
    { db: throwingD1(), index: vector.index },
  );

  assert.equal(body.ok, true);
  assert.equal(vector.queryCalls.length, 0, "the raw Vectorize query path must never be used");
  assert.equal(vector.queryByIdCalls.length, 1);
  assert.equal(vector.queryByIdCalls[0].id, "vec-1");
  assert.equal(vector.queryByIdCalls[0].options.topK, 6);
  assert.equal(vector.queryByIdCalls[0].options.returnValues, false);
  assert.equal(vector.queryByIdCalls[0].options.returnMetadata, "indexed");

  const observation = body.observations?.[0];
  assert.equal(observation?.retrievalMode, "semantic");
  assert.deepEqual(observation?.topIds, [DOC_ID]);
  assert.ok(!text.includes("embedding"), "no embedding field may cross the Worker boundary");
});

test("a hybrid canary case resolves through queryById and ignores the local embedding", async () => {
  const vector = fakeCanaryVectorize();
  const db = fakeHybridD1({
    ftsRows: [{ article_id: DOC_ID, relevance_score: 1.25 }],
    metadataRows: [{ article_id: DOC_ID, original_published_at: "2026-08-01T00:00:00.000Z", title: "decision 1" }],
  });
  const { body } = await runCanaryWorker(
    [{ id: "hybrid-1", mode: "hybrid", query: "constitution", limit: 5, offset: 0, vectorId: "vec-9" }],
    { db, index: vector.index },
  );

  assert.equal(body.ok, true);
  assert.equal(vector.queryCalls.length, 0, "the raw Vectorize query path must never be used");
  assert.deepEqual(vector.queryByIdCalls.map((call) => call.id), ["vec-9"]);
  const observation = body.observations?.[0];
  assert.equal(observation?.retrievalMode, "hybrid");
  assert.deepEqual(observation?.topIds, [DOC_ID]);
});

test("the worker rejects semantic/hybrid cases without a vectorId fail-closed", async () => {
  for (const mode of ["semantic", "hybrid"] as const) {
    const vector = fakeCanaryVectorize();
    const { body } = await runCanaryWorker(
      [{ id: `${mode}-missing`, mode, query: "constitution", limit: 5, offset: 0 }],
      { db: throwingD1(), index: vector.index },
    );
    const observation = body.observations?.[0];
    assert.equal(observation?.errorCode, SEARCH_CANARY_VECTOR_ID_REQUIRED_CODE, `${mode} without a vectorId must fail closed`);
    assert.equal(vector.queryCalls.length, 0);
    assert.equal(vector.queryByIdCalls.length, 0);
  }

  const blank = fakeCanaryVectorize();
  const { body } = await runCanaryWorker(
    [{ id: "semantic-blank", mode: "semantic", query: "constitution", limit: 5, offset: 0, vectorId: "   " }],
    { db: throwingD1(), index: blank.index },
  );
  assert.equal(body.observations?.[0].errorCode, SEARCH_CANARY_VECTOR_ID_REQUIRED_CODE);
  assert.equal(blank.queryByIdCalls.length, 0);
});

// ---------------------------------------------------------------------------
// M7.6 local-only remote-binding execution path
// ---------------------------------------------------------------------------

async function fetchCanaryWorker(
  url: string,
  env: Record<string, unknown>,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; text: string; body: Record<string, unknown> }> {
  const response = await worker.fetch(
    new Request(url, { method: init.method ?? "GET", headers: init.headers, body: init.body }),
    env as unknown as Parameters<typeof worker.fetch>[1],
  );
  const text = await response.text();
  return { status: response.status, text, body: JSON.parse(text) as Record<string, unknown> };
}

test("the local-dev bypass accepts exactly the loopback hosts when the flag is true", async () => {
  for (const host of ["127.0.0.1:8787", "localhost:8787", "[::1]:8787"]) {
    const result = await fetchCanaryWorker(`http://${host}/health`, { WORLDCONS_SEARCH_CANARY_DEV_UNAUTH: "true" });
    assert.equal(result.status, 200, `${host} must bypass auth`);
    assert.equal(result.body.ok, true);
  }
});

test("the local-dev bypass is refused on every non-loopback host", async () => {
  const urls = [
    "https://canary.example/health",
    "https://worldcons-search-canary.account.workers.dev/health",
    "http://192.168.1.10:8787/health",
    "http://10.0.0.1/health",
    "http://127.0.0.1.evil.example/health",
    "http://notlocalhost/health",
    "http://localhost.evil.example/health",
  ];
  for (const url of urls) {
    const result = await fetchCanaryWorker(url, { WORLDCONS_SEARCH_CANARY_DEV_UNAUTH: "true" });
    assert.equal(result.status, 401, `${url} must stay bearer-protected`);
    assert.equal(result.body.error, "unauthorized");
  }
});

test("the local-dev bypass requires the flag to be exactly the string true", async () => {
  for (const value of ["TRUE", "True", "1", "yes", " true", "true ", "", "truthy", undefined]) {
    const result = await fetchCanaryWorker("http://127.0.0.1:8787/health", {
      WORLDCONS_SEARCH_CANARY_DEV_UNAUTH: value,
    });
    assert.equal(result.status, 401, `${JSON.stringify(value)} must not enable the bypass`);
  }
});

test("the normal bearer path is unchanged on loopback when the dev flag is absent", async () => {
  const unauthenticated = await fetchCanaryWorker("http://127.0.0.1:8787/health", {});
  assert.equal(unauthenticated.status, 401);

  const authenticated = await fetchCanaryWorker(
    "http://127.0.0.1:8787/health",
    { WORLDCONS_SEARCH_CANARY_TOKEN: CANARY_TOKEN },
    { headers: { authorization: `Bearer ${CANARY_TOKEN}` } },
  );
  assert.equal(authenticated.status, 200);

  // A valid token still opens a non-loopback host even when the dev flag is set.
  const remoteWithToken = await fetchCanaryWorker(
    "https://canary.example/health",
    { WORLDCONS_SEARCH_CANARY_DEV_UNAUTH: "true", WORLDCONS_SEARCH_CANARY_TOKEN: CANARY_TOKEN },
    { headers: { authorization: `Bearer ${CANARY_TOKEN}` } },
  );
  assert.equal(remoteWithToken.status, 200);
});

test("the local-dev health response leaks neither the dev flag nor the token", async () => {
  const result = await fetchCanaryWorker("http://127.0.0.1:8787/health", {
    WORLDCONS_SEARCH_CANARY_DEV_UNAUTH: "true",
    WORLDCONS_SEARCH_CANARY_TOKEN: CANARY_TOKEN,
  });
  assert.equal(result.status, 200);
  assert.ok(!result.text.includes("DEV_UNAUTH"));
  assert.ok(!result.text.includes(CANARY_TOKEN));
});

test("isLoopbackCanaryHostname accepts only the exact loopback hosts", () => {
  for (const host of ["127.0.0.1", "localhost", "LOCALHOST", "::1", "[::1]", " localhost "]) {
    assert.equal(isLoopbackCanaryHostname(host), true, host);
  }
  for (const host of [
    "127.0.0.1.evil.example",
    "notlocalhost",
    "0.0.0.0",
    "::2",
    "localhost.evil.example",
    "example.com",
    "",
    null,
    undefined,
  ]) {
    assert.equal(isLoopbackCanaryHostname(host), false, String(host));
  }
});

test("isCanaryDevUnauthorized requires both the exact flag and a loopback host", () => {
  assert.equal(isCanaryDevUnauthorized({ devUnauth: "true", hostname: "localhost" }), true);
  assert.equal(isCanaryDevUnauthorized({ devUnauth: "true", hostname: "canary.example" }), false);
  assert.equal(isCanaryDevUnauthorized({ devUnauth: "1", hostname: "localhost" }), false);
  assert.equal(isCanaryDevUnauthorized({ devUnauth: undefined, hostname: "localhost" }), false);
});

test("the local-dev writer refuses non-loopback, https and malformed endpoints", () => {
  assert.doesNotThrow(() => assertLoopbackCanaryEndpoint("http://127.0.0.1:8787"));
  assert.throws(() => assertLoopbackCanaryEndpoint("https://canary.example"), /plain http/);
  assert.throws(() => assertLoopbackCanaryEndpoint("https://127.0.0.1:8787"), /plain http/);
  assert.throws(() => assertLoopbackCanaryEndpoint("http://192.168.1.10:8787"), /loopback/);
  assert.throws(() => assertLoopbackCanaryEndpoint("not-a-url"), /valid URL/);
});

test("the local-dev writer sends no authorization header and never a token", async () => {
  let capturedUrl = "";
  let capturedAuth: string | null = "unset";
  const writer = createLocalDevSearchCanaryWriter({
    endpoint: "http://127.0.0.1:8787/",
    fetch: async (input, init) => {
      capturedUrl = String(input);
      capturedAuth = new Headers(init?.headers).get("authorization");
      return new Response(JSON.stringify({ ok: true, changes: 1, rowsRead: 0 }), { status: 200 });
    },
  });
  assert.equal(writer.kind, "local-dev");
  const changes = await writer.execute({ sql: "insert into t (a) values (?)", params: ["secret-value-must-not-leak"] });
  assert.equal(changes, 1);
  assert.equal(capturedUrl, "http://127.0.0.1:8787/d1/statement");
  assert.equal(capturedAuth, null);
  assert.ok(!writer.detail.includes("token"));
});

test("resolveSearchCanaryWriter picks local-dev only on an explicit opt-in", () => {
  const loopback = "http://127.0.0.1:8787";
  assert.equal(
    resolveSearchCanaryWriter({ requested: "local-dev", env: { WORLDCONS_SEARCH_CANARY_WORKER_URL: loopback } })?.kind,
    "local-dev",
  );
  assert.equal(
    resolveSearchCanaryWriter({
      requested: "auto",
      env: { [SEARCH_CANARY_DEV_UNAUTH_ENV]: "true", WORLDCONS_SEARCH_CANARY_WORKER_URL: "http://localhost:8787" },
    })?.kind,
    "local-dev",
  );
  // auto without the flag and without a token must not silently use local-dev.
  assert.equal(resolveSearchCanaryWriter({ requested: "auto", env: { WORLDCONS_SEARCH_CANARY_WORKER_URL: loopback } }), null);
  // normal worker mode still requires the token.
  assert.throws(
    () => resolveSearchCanaryWriter({ requested: "worker", env: { WORLDCONS_SEARCH_CANARY_WORKER_URL: loopback } }),
    /requires/,
  );
  // local-dev fails closed on https/public hosts.
  assert.throws(
    () => resolveSearchCanaryWriter({ requested: "local-dev", env: { WORLDCONS_SEARCH_CANARY_WORKER_URL: "https://canary.example" } }),
    /plain http/,
  );
});

test("resolveSearchCanaryBindingTarget requires an explicit loopback opt-in for a tokenless run", () => {
  assert.equal(resolveSearchCanaryBindingTarget({ requested: "auto", env: {} }), null);
  const tokenValue = "0123456789abcdef";
  assert.deepEqual(
    resolveSearchCanaryBindingTarget({
      requested: "auto",
      env: { WORLDCONS_SEARCH_CANARY_WORKER_URL: "https://canary.example", WORLDCONS_SEARCH_CANARY_TOKEN: tokenValue },
    }),
    { endpoint: "https://canary.example", token: tokenValue, localDev: false },
  );
  // tokenless without opt-in -> null (bounded blocker, no remote call).
  assert.equal(
    resolveSearchCanaryBindingTarget({ requested: "auto", env: { WORLDCONS_SEARCH_CANARY_WORKER_URL: "http://127.0.0.1:8787" } }),
    null,
  );
  // explicit --writer=local-dev and explicit env flag both allow tokenless loopback.
  assert.deepEqual(
    resolveSearchCanaryBindingTarget({ requested: "local-dev", env: { WORLDCONS_SEARCH_CANARY_WORKER_URL: "http://127.0.0.1:8787" } }),
    { endpoint: "http://127.0.0.1:8787", token: null, localDev: true },
  );
  assert.deepEqual(
    resolveSearchCanaryBindingTarget({
      requested: "auto",
      env: { [SEARCH_CANARY_DEV_UNAUTH_ENV]: "true", WORLDCONS_SEARCH_CANARY_WORKER_URL: "http://localhost:8787" },
    }),
    { endpoint: "http://localhost:8787", token: null, localDev: true },
  );
  // tokenless non-loopback is refused fail-closed.
  assert.throws(
    () => resolveSearchCanaryBindingTarget({ requested: "local-dev", env: { WORLDCONS_SEARCH_CANARY_WORKER_URL: "https://canary.example" } }),
    /plain http/,
  );
});

test("the binding canary omits authorization only for the explicit loopback dev path", async () => {
  let capturedAuth: string | null = "unset";
  const results = await runWorkerCanaryCases(
    {
      endpoint: "http://127.0.0.1:8787",
      token: null,
      allowUnauthenticatedLocalhost: true,
      fetch: async (_input, init) => {
        capturedAuth = new Headers(init?.headers).get("authorization");
        return new Response(JSON.stringify({ ok: true, observations: [] }), { status: 200 });
      },
    },
    [{ id: "c1", mode: "fulltext", query: "q", limit: 5, offset: 0 }],
  );
  assert.equal(capturedAuth, null);
  assert.deepEqual(results, []);

  // A tokenless public endpoint must fail closed before any request is sent.
  let called = false;
  await assert.rejects(
    () =>
      runWorkerCanaryCases(
        {
          endpoint: "https://canary.example",
          token: null,
          allowUnauthenticatedLocalhost: true,
          fetch: async () => {
            called = true;
            return new Response(JSON.stringify({ ok: true, observations: [] }), { status: 200 });
          },
        },
        [{ id: "c1", mode: "fulltext", query: "q", limit: 5, offset: 0 }],
      ),
    /loopback|plain http/,
  );
  assert.equal(called, false, "no request may be sent to a tokenless non-loopback endpoint");

  // Tokenless without the explicit opt-in also fails closed.
  await assert.rejects(
    () =>
      runWorkerCanaryCases(
        {
          endpoint: "http://127.0.0.1:8787",
          token: null,
          fetch: async () => new Response(JSON.stringify({ ok: true, observations: [] }), { status: 200 }),
        },
        [{ id: "c1", mode: "fulltext", query: "q", limit: 5, offset: 0 }],
      ),
    /opt-in/,
  );
});

test("the isolated bindings opt into remote dev resolution without changing identities or routes", () => {
  const canaryConfig = fs.readFileSync(path.join(process.cwd(), "workers", "search-canary", "wrangler.jsonc"), "utf8");
  assert.match(canaryConfig, /"database_name": "worldcons_search_canary_v2"/);
  assert.match(canaryConfig, /"index_name": "worldcons-search-canary-v2"/);
  const remoteEnabled = (canaryConfig.match(/"remote":\s*true/g) ?? []).length;
  assert.equal(remoteEnabled, 2, "both isolated bindings must set remote:true for local wrangler dev");
  assert.ok(!/"routes"\s*:/.test(canaryConfig), "canary config must declare no routes");
  assert.ok(!/"route"\s*:/.test(canaryConfig), "canary config must declare no route");
  assert.ok(!/"domain"\s*:/.test(canaryConfig), "canary config must declare no custom domain");

  const productionConfig = fs.readFileSync(path.join(process.cwd(), "wrangler.jsonc"), "utf8");
  assert.ok(!productionConfig.includes("SEARCH_CANARY"), "production wrangler.jsonc must remain unchanged");
  assert.ok(!productionConfig.includes("remote"), "the dev-only remote option must not touch production config");
});

test("the worker source gates the bypass on the helper and never hardcodes a token bypass", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "workers", "search-canary", "src", "index.ts"), "utf8");
  assert.match(source, /isCanaryDevUnauthorized/);
  assert.match(source, /WORLDCONS_SEARCH_CANARY_DEV_UNAUTH/);
  assert.ok(!/console\.log/.test(source), "the worker must not log request data");
});

// ---------------------------------------------------------------------------
// M7.6 conservative rank + latency evidence gates (M7.2/M7.5 refined)
// ---------------------------------------------------------------------------

function reportWithObservations(observations: readonly SearchCanaryObservation[]) {
  return buildSearchCanaryReport({
    generatedAt: "2026-09-26T00:00:00.000Z",
    vectorIndex: "worldcons-search-canary-v2",
    database: "worldcons_search_canary_v2",
    source: "fixture",
    projection: {
      version: 1,
      maxArticles: 1,
      truncated: false,
      documents: [],
      records: [],
      changes: { projectedDocuments: 1, vectorRecords: 0, missingArtifacts: 0, staleArtifacts: 0 },
      blockers: [],
      manifest: { searchHash: "x", vectorHash: "y" },
    },
    vectorBootstrap: null,
    remoteWrites: { indexCreated: false, metadataIndexesCreated: [], vectorsUpserted: 0, searchRowsInserted: 0, databaseCreated: false },
    observations: [...observations],
  });
}

test("exact-case fulltext keeps strict production-rpc top-id parity", () => {
  const exact = caseDef({ id: "exact-case-a", expectation: { kind: "top-id", id: "a" } });
  const match = evaluateSearchCanaryCase({
    case: exact,
    payload: payload(["a", "b"]),
    latencyMs: 1,
    oracle: payload(["a", "b"]),
    oracleMode: "production-rpc",
  });
  assert.equal(match.status, "pass");
  assert.equal(match.oracleParity, "match");
  assert.equal(match.rankComparison?.strict, true);
  assert.equal(match.rankComparison?.exactOrder, true);

  const mismatch = evaluateSearchCanaryCase({
    case: exact,
    payload: payload(["a", "b"]),
    latencyMs: 1,
    oracle: payload(["b", "a"]),
    oracleMode: "production-rpc",
  });
  assert.equal(mismatch.status, "mismatch");
  assert.equal(mismatch.oracleParity, "mismatch");
  assert.equal(mismatch.rankComparison?.strict, true);
});

test("generic lexical fulltext stores informational rank metrics and does not fail", () => {
  const generic = caseDef({ id: "fulltext-a", expectation: { kind: "contains", id: "a", withinTop: 10 } });
  const observation = evaluateSearchCanaryCase({
    case: generic,
    payload: payload(["x", "a", "b"]),
    latencyMs: 1,
    oracle: payload(["b", "x"]),
    oracleMode: "production-rpc",
  });
  assert.equal(observation.status, "pass");
  assert.equal(observation.oracleParity, "informational");
  const rank = observation.rankComparison;
  assert.ok(rank, "a lexical rank comparison must be recorded");
  assert.equal(rank.strict, false);
  assert.equal(rank.k, 10);
  // oracle={b,x}, observed={x,a,b}; overlap over the k=10 windows is {b,x} => 2.
  assert.equal(rank.overlapAtKCount, 2);
  assert.equal(rank.prefixMatchCount, 0);
  assert.deepEqual(rank.missing, []);
  assert.deepEqual(rank.extra, ["a"]);
  assert.match(observation.detail ?? "", /informational/);
});

test("the unagreed fulltext rank threshold blocker derives only from non-strict lexical comparisons", () => {
  const generic = caseDef({ id: "fulltext-a", expectation: { kind: "contains", id: "a", withinTop: 10 } });
  const informational = evaluateSearchCanaryCase({
    case: generic,
    payload: payload(["x", "a"]),
    latencyMs: 1,
    oracle: payload(["b"]),
    oracleMode: "production-rpc",
  });
  assert.deepEqual(
    deriveSearchCanaryRankBlockers([informational]).map((blocker) => blocker.code),
    ["fulltext_rank_threshold_unagreed"],
  );

  const exact = caseDef({ id: "exact-case-a", expectation: { kind: "top-id", id: "a" } });
  const strict = evaluateSearchCanaryCase({
    case: exact,
    payload: payload(["a"]),
    latencyMs: 1,
    oracle: payload(["a"]),
    oracleMode: "production-rpc",
  });
  assert.deepEqual(deriveSearchCanaryRankBlockers([strict]), [], "a strict exact comparison must not raise the blocker");

  const report = reportWithObservations([informational]);
  assert.ok(report.blockers.some((blocker) => blocker.code === "fulltext_rank_threshold_unagreed"));
  assert.ok(!JSON.stringify(report).includes(LEAK_SENTINEL));

  // A report with only a strict comparison must stay free of the rank blocker.
  const strictReport = reportWithObservations([strict]);
  assert.ok(!strictReport.blockers.some((blocker) => blocker.code === "fulltext_rank_threshold_unagreed"));
});

test("binding samples make binding thresholds the latency gate and operator time evidence only", () => {
  const thresholds = {
    ...SEARCH_CANARY_DEFAULT_THRESHOLDS,
    maxLatencyP50Ms: 1,
    maxLatencyP95Ms: 1,
    maxBindingLatencyP50Ms: 100,
    maxBindingLatencyP95Ms: 100,
  };
  // Operator is within its own (now irrelevant) threshold but binding exceeds its ceiling.
  const slowBinding = evaluateSearchCanaryCase({ case: caseDef(), payload: payload(["a"]), latencyMs: 10, bindingLatencyMs: 500 });
  assert.equal(summarizeSearchCanary([slowBinding], thresholds).modes[0].pass, false);

  // Operator exceeds the operator ceiling but binding is within; operator is evidence only.
  const slowOperator = evaluateSearchCanaryCase({ case: caseDef(), payload: payload(["a"]), latencyMs: 9000, bindingLatencyMs: 10 });
  const metrics = summarizeSearchCanary([slowOperator], thresholds);
  assert.equal(metrics.modes[0].pass, true);
  assert.equal(metrics.modes[0].latencyP95Ms, 9000, "operator latency is still recorded as evidence");
  assert.equal(metrics.modes[0].bindingLatencyP95Ms, 10);
});

test("without binding samples the legacy operator latency thresholds still gate", () => {
  const thresholds = {
    ...SEARCH_CANARY_DEFAULT_THRESHOLDS,
    maxLatencyP50Ms: 100,
    maxLatencyP95Ms: 100,
    maxBindingLatencyP50Ms: 1,
    maxBindingLatencyP95Ms: 1,
  };
  const within = evaluateSearchCanaryCase({ case: caseDef(), payload: payload(["a"]), latencyMs: 50 });
  assert.equal(summarizeSearchCanary([within], thresholds).modes[0].pass, true);

  const over = evaluateSearchCanaryCase({ case: caseDef(), payload: payload(["a"]), latencyMs: 5000 });
  const metrics = summarizeSearchCanary([over], thresholds);
  assert.equal(metrics.bindingSamples, 0);
  assert.equal(metrics.modes[0].pass, false);
});

test("rank comparison evidence carries ids/counts only and no bound content", () => {
  const generic = caseDef({ id: "fulltext-a", expectation: { kind: "contains", id: "a", withinTop: 10 } });
  const observation = evaluateSearchCanaryCase({
    case: generic,
    payload: payload(["x", "a", "b"]),
    latencyMs: 1,
    oracle: payload(["b", "x"]),
    oracleMode: "production-rpc",
  });
  const rank = observation.rankComparison;
  assert.ok(rank);
  assert.deepEqual(
    Object.keys(rank).sort(),
    [
      "actualCount",
      "exactOrder",
      "expectedCount",
      "extra",
      "k",
      "missing",
      "overlapAtK",
      "overlapAtKCount",
      "prefixMatchCount",
      "prefixMatchRate",
      "sameSet",
      "strict",
    ].sort(),
  );
  assert.ok(!JSON.stringify(observation).includes("expectation"));
  assert.ok(!JSON.stringify(observation).includes("query"));
});

