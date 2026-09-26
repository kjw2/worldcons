import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  DEPLOYED_SEARCH_CANARY_ENDPOINT,
  buildDeployedRuntimeReport,
  renderDeployedRuntimeMarkdown,
  type DeployedRuntimeResult,
  type SearchCanaryCase,
} from "../lib/cloudflare/search-canary";

const cases: SearchCanaryCase[] = [
  {
    id: "exact-case-private-id",
    mode: "fulltext",
    query: "1 BvR 2656/18",
    source: "de-bverfg",
    limit: 5,
    offset: 0,
    expectation: { kind: "top-id", id: "article-exact" },
  },
  {
    id: "fulltext-private-id",
    mode: "fulltext",
    query: "secret-query-shape",
    limit: 5,
    offset: 0,
    expectation: { kind: "top-id", id: "article-a" },
  },
  {
    id: "semantic-private-id",
    mode: "semantic",
    query: "semantic-query-shape",
    limit: 5,
    offset: 0,
    vectorId: "article-b",
    embedding: [1, 0],
    expectation: { kind: "self-top", id: "article-b", minScore: 0.999 },
  },
  {
    id: "hybrid-private-id",
    mode: "hybrid",
    query: "hybrid-query-shape",
    limit: 10,
    offset: 0,
    vectorId: "article-c",
    embedding: [0, 1],
    expectation: { kind: "contains", id: "article-c", withinTop: 10 },
  },
];

function passingResults(latencyMs = 100): DeployedRuntimeResult[] {
  return [
    { caseId: cases[0]!.id, latencyMs, topIds: ["article-exact"], retrievalMode: "exact-case", errorCode: null },
    { caseId: cases[1]!.id, latencyMs, topIds: ["article-a"], retrievalMode: "fulltext", errorCode: null },
    { caseId: cases[2]!.id, latencyMs, topIds: ["article-b"], retrievalMode: "semantic", errorCode: null },
    { caseId: cases[3]!.id, latencyMs, topIds: ["article-c"], retrievalMode: "hybrid", errorCode: null },
  ];
}

function report(results: DeployedRuntimeResult[], generatedAt = "2026-09-26T00:00:00.000Z") {
  return buildDeployedRuntimeReport({
    generatedAt,
    cases,
    results,
    projection: { documents: 100, vectorRecords: 100, missingArtifacts: 0, staleArtifacts: 0 },
  });
}

test("deployed runtime evidence passes all three modes within the frozen latency gate", () => {
  const evidence = report(passingResults());
  assert.equal(evidence.state, "pass");
  assert.equal(evidence.blockers.length, 0);
  assert.deepEqual(
    evidence.modes.map((mode) => [mode.mode, mode.pass, mode.latencyP50Ms, mode.latencyP95Ms]),
    [
      ["fulltext", true, 100, 100],
      ["semantic", true, 100, 100],
      ["hybrid", true, 100, 100],
    ],
  );
});

test("missing, errored, mismatched and slow deployed observations fail closed", () => {
  assert.equal(report(passingResults().slice(0, 2)).state, "fail");
  assert.equal(
    report(passingResults().map((result, index) => (index === 0 ? { ...result, errorCode: "worker_error" } : result))).state,
    "fail",
  );
  assert.equal(
    report(passingResults().map((result, index) => (index === 1 ? { ...result, retrievalMode: "hybrid" } : result))).state,
    "fail",
  );
  assert.equal(report(passingResults(1501)).state, "fail");
});

test("deployed runtime evidence is content-free and stable across generatedAt", () => {
  const first = report(passingResults());
  const second = report(passingResults(), "2026-09-26T01:00:00.000Z");
  assert.equal(first.stableHash, second.stableHash);
  assert.deepEqual(first.observations.map((observation) => observation.caseId), [
    "fulltext-1",
    "fulltext-2",
    "semantic-1",
    "hybrid-1",
  ]);
  const serialized = `${JSON.stringify(first)}\n${renderDeployedRuntimeMarkdown(first)}`;
  assert.doesNotMatch(serialized, /secret-query-shape|semantic-query-shape|hybrid-query-shape/u);
  assert.doesNotMatch(serialized, /article-exact|article-a|article-b|article-c|private-id/u);
  assert.doesNotMatch(serialized, /Bearer|WORLDCONS_SEARCH_CANARY_TOKEN=/u);
});

test("operator runner is pinned, dry-run by default and has no apply or write path", () => {
  assert.equal(DEPLOYED_SEARCH_CANARY_ENDPOINT, "https://worldcons-search-canary.cclib.workers.dev");
  const source = fs.readFileSync("scripts/deployed-search-canary-runtime.ts", "utf8");
  assert.match(source, /if \(!run\)/u);
  assert.match(source, /--apply is unavailable/u);
  assert.doesNotMatch(source, /executeScript|upsert|insert|delete|update|wrangler deploy/iu);
  assert.match(source, /runWorkerCanaryCases/u);
  assert.match(source, /createSupabaseCanaryReader/u);
  const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8")) as {
    scripts: Record<string, string>;
  };
  assert.equal(packageJson.scripts["m7.9:deployed-runtime"], "tsx scripts/deployed-search-canary-runtime.ts");
  assert.equal(packageJson.scripts["test:m7.9"], "tsx --test tests/m7.9-deployed-search-canary-runtime.test.ts");
  assert.match(packageJson.scripts["verify:release"] ?? "", /pnpm test:m7\.9/u);
});
