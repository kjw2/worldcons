import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  RANK_HOLDOUT_CANDIDATES,
  RANK_HOLDOUT_DEFAULT_PER_CATEGORY,
  RANK_POLICY_HOLDOUT_VERSION,
  RANK_POLICY_V4_HASH,
  assertHoldoutCase,
  assertHoldoutDisjoint,
  buildRankHoldoutManifest,
  holdoutCaseKey,
  rankHoldoutHash,
  selectHoldoutCorpus,
} from "../lib/cloudflare/search-rank-policy/holdout";
import {
  RANK_POLICY_DECISIONS,
  RANK_POLICY_DECISION_VERSION,
  RANK_POLICY_INVARIANTS,
  SEALED_V4_FORBIDDEN_KEYS,
  SEALED_V4_METRIC_LITERALS,
  assertRankPolicyDecision,
  parseRankPolicyDecision,
  rankDecisionHash,
  validateRankPolicyDecision,
  type RankPolicyDecisionPolicy,
  type RankPolicyDecisionRecord,
} from "../lib/cloudflare/search-rank-policy/decision";
import {
  evaluateCandidateCoverageEquivalence,
  evaluateE1,
  evaluateE2,
  evaluateE3,
  evaluateE4,
  type EquivalenceCaseInput,
} from "../lib/cloudflare/search-rank-policy/equivalence";
import {
  buildFtsParityHoldoutReport,
  ftsParityHoldoutReportHash,
  renderFtsParityHoldoutMarkdown,
  type FtsParityHoldoutReport,
} from "../lib/cloudflare/search-rank-policy/evidence";
import { rankCorpusHash, selectRepresentativeCorpus } from "../lib/cloudflare/search-rank-policy/corpus";
import type { RankCorpusCase, RankCorpusCategory } from "../lib/cloudflare/search-rank-policy/types";

/**
 * M7.8-B rank-policy governance + disjoint v5 holdout tests.
 * Static contracts only: no network/Supabase/Wrangler, and the committed v5
 * manifest must never be regenerated from an observed parity outcome.
 */
const rootDir = process.cwd();
const holdoutManifest = JSON.parse(
  fs.readFileSync(path.join(rootDir, "lib/cloudflare/search-rank-policy/corpus.manifest.v5-holdout.json"), "utf8"),
) as { version: number; disjointFromCorpusHash: string; holdoutHash: string; cases: RankCorpusCase[] };
const v4Manifest = JSON.parse(
  fs.readFileSync(path.join(rootDir, "lib/cloudflare/search-rank-policy/corpus.manifest.json"), "utf8"),
) as { version: number; corpusHash: string; cases: RankCorpusCase[] };
const decisionTemplate = JSON.parse(
  fs.readFileSync(path.join(rootDir, "docs/operations/worldcons-m7.8b-rank-policy-decision.template.json"), "utf8"),
) as RankPolicyDecisionRecord;
const harnessSource = fs.readFileSync(path.join(rootDir, "scripts/d1-fts-parity.ts"), "utf8");
const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};
const FROZEN_HOLDOUT_HASH = "1452c95c29fba160";

function makeCase(
  overrides: Partial<RankCorpusCase> & Pick<RankCorpusCase, "id" | "category" | "query" | "invariant">,
): RankCorpusCase {
  return {
    filters: { source: null, jurisdiction: null, contentType: null, language: null, range: "latest" },
    limit: 10,
    k: 10,
    ...overrides,
  };
}

function finalizedDecision(
  policy: RankPolicyDecisionPolicy,
  overrides: Partial<RankPolicyDecisionRecord> = {},
): RankPolicyDecisionRecord {
  const body = {
    version: RANK_POLICY_DECISION_VERSION,
    policy,
    decisionId: "m7.8b-decision-test",
    decidedAt: "2026-09-26T00:00:00.000Z",
    decidedByRole: "product-owner",
    holdoutManifestHash: FROZEN_HOLDOUT_HASH,
    v4EvidenceSealed: true as const,
    invariants: [...RANK_POLICY_INVARIANTS],
    thresholds: null,
    rationale: "",
    ...overrides,
  };
  return { ...body, decisionHash: rankDecisionHash(body) };
}

function equivalenceInput(overrides: Partial<EquivalenceCaseInput> = {}): EquivalenceCaseInput {
  const caseDef = makeCase({ id: "case-1", category: "exact-title", query: "query shape", invariant: "exact-title" });
  return {
    case: caseDef,
    observedIds: ["local-top", "local-second"],
    oracleIds: ["local-top", "oracle-second"],
    oracleCompared: true,
    target: { expectedIds: ["local-top"], matchCount: 1, frozen: true, frozenValidated: true },
    scopeIds: new Set(["local-top", "local-second"]),
    ...overrides,
  };
}

test("the committed v5 holdout manifest reproduces the deterministic selection and frozen hash", () => {
  assert.deepEqual(buildRankHoldoutManifest(), holdoutManifest);
  assert.equal(holdoutManifest.version, RANK_POLICY_HOLDOUT_VERSION);
  assert.equal(holdoutManifest.version, 5);
  assert.equal(holdoutManifest.holdoutHash, FROZEN_HOLDOUT_HASH);
  assert.equal(rankHoldoutHash(holdoutManifest.cases), FROZEN_HOLDOUT_HASH);
  assert.equal(holdoutManifest.disjointFromCorpusHash, RANK_POLICY_V4_HASH);
});

test("the v5 holdout hash is order-independent and distinct from the v4 corpus hash", () => {
  assert.equal(rankHoldoutHash([...holdoutManifest.cases].reverse()), FROZEN_HOLDOUT_HASH);
  assert.equal(v4Manifest.version, 4);
  assert.equal(v4Manifest.corpusHash, RANK_POLICY_V4_HASH);
  assert.equal(rankCorpusHash(selectRepresentativeCorpus()), RANK_POLICY_V4_HASH);
  assert.notEqual(holdoutManifest.holdoutHash, v4Manifest.corpusHash);
});

test("holdout selection is deterministic, category-complete and disjoint from v4", () => {
  const first = selectHoldoutCorpus();
  assert.deepEqual(first, selectHoldoutCorpus());
  assert.deepEqual(first, holdoutManifest.cases);
  assert.deepEqual(selectHoldoutCorpus([...RANK_HOLDOUT_CANDIDATES].reverse()), first);

  const categories: RankCorpusCategory[] = [
    "exact-case",
    "exact-title",
    "multilingual-legal-term",
    "case-number-identifier",
    "jurisdiction-source",
    "cclrag2-shape",
    "cclmetasearch-shape",
  ];
  for (const category of categories) {
    const scoped = first.filter((caseDef) => caseDef.category === category);
    const expectedCount = category === "exact-case" || category === "exact-title" ? 4 : RANK_HOLDOUT_DEFAULT_PER_CATEGORY;
    assert.equal(scoped.length, expectedCount, `category ${category} must select ${expectedCount} cases`);
  }
  assert.equal(first.length, 18, "v5 selects 8 strict anchors + 10 informational cases");
  assert.ok(RANK_HOLDOUT_CANDIDATES.length > first.length, "the candidate pool must stay larger than the selection");

  const v4 = selectRepresentativeCorpus();
  assert.doesNotThrow(() => assertHoldoutDisjoint(first, v4));
  const v4Keys = new Set(v4.map(holdoutCaseKey));
  assert.equal(first.filter((caseDef) => v4Keys.has(holdoutCaseKey(caseDef))).length, 0);

  assert.throws(() => assertHoldoutDisjoint([...first, v4[0]], v4), /holdout-not-disjoint/u);
});

test("the v5 strict anchors are metadata-derived source-scoped shapes, never a v4 re-run", () => {
  const strict = holdoutManifest.cases.filter((caseDef) => caseDef.invariant !== "informational");
  assert.equal(strict.length, 8);
  for (const caseDef of strict) {
    assert.ok(caseDef.filters.source !== null, `${caseDef.id} must carry an explicit source filter`);
    assert.ok(Array.isArray(caseDef.expectedIds) && caseDef.expectedIds.length > 0);
    const sorted = [...(caseDef.expectedIds as string[])].sort();
    assert.deepEqual(caseDef.expectedIds, sorted, `${caseDef.id} target set must stay sorted`);
    assert.equal(new Set(caseDef.expectedIds).size, caseDef.expectedIds?.length, `${caseDef.id} target set must be unique`);
  }
  const v4StrictQueries = new Set(v4Manifest.cases.filter((c) => c.invariant !== "informational").map((c) => c.query));
  assert.ok(
    strict.every((caseDef) => v4StrictQueries.has(caseDef.query)),
    "every v5 strict query must reuse an authoritative v4 query shape under a new filter",
  );
});

test("holdout candidate validation rejects a category/invariant mismatch", () => {
  assert.throws(
    () => assertHoldoutCase(makeCase({ id: "bad", category: "exact-title", query: "x", invariant: "informational" })),
    /must carry invariant/u,
  );
  assert.throws(
    () => assertHoldoutCase(makeCase({ id: "bad-expected", category: "exact-case", query: "x", invariant: "exact-case" })),
    /expectedIds/u,
  );
  assert.throws(
    () =>
      assertHoldoutCase(
        makeCase({ id: "bad-info", category: "multilingual-legal-term", query: "x", invariant: "informational", expectedIds: ["a"] }),
      ),
    /must not carry an expectedIds/u,
  );
});

test("the v5 holdout manifest is content-free and carries only queries/ids/filters/categories", () => {
  assert.deepEqual(Object.keys(holdoutManifest).sort(), ["cases", "disjointFromCorpusHash", "holdoutHash", "version"]);
  const allowedFilterKeys = ["contentType", "jurisdiction", "language", "range", "source"].sort();
  for (const caseDef of holdoutManifest.cases) {
    const strict = caseDef.invariant !== "informational";
    const allowedCaseKeys = strict
      ? ["category", "expectedIds", "filters", "id", "invariant", "k", "limit", "query"].sort()
      : ["category", "filters", "id", "invariant", "k", "limit", "query"].sort();
    assert.deepEqual(Object.keys(caseDef).sort(), allowedCaseKeys);
    assert.deepEqual(Object.keys(caseDef.filters).sort(), allowedFilterKeys);
    assert.ok(caseDef.query.length <= 300, "a content-free query shape must stay short");
  }
  const serialized = JSON.stringify(holdoutManifest);
  assert.doesNotMatch(serialized, /https?:\/\//u, "no URL may appear in the holdout");
  assert.doesNotMatch(
    serialized,
    /"(search_text|cleaned_text|display_title|summary|summary_json|url|embedding|vector|raw_text|body|content)"\s*:/u,
    "no document text/summary/url/vector field may appear in the holdout",
  );
});

test("the checked-in decision template is explicitly undecided and refuses to pass as a decision", () => {
  assert.deepEqual(Object.keys(decisionTemplate).sort(), [
    "decidedAt",
    "decidedByRole",
    "decisionHash",
    "decisionId",
    "holdoutManifestHash",
    "invariants",
    "policy",
    "rationale",
    "thresholds",
    "v4EvidenceSealed",
    "version",
  ]);
  assert.equal(decisionTemplate.policy, "undecided");
  assert.equal(decisionTemplate.decisionId, "");
  assert.equal(decisionTemplate.decidedAt, "");
  assert.equal(decisionTemplate.decidedByRole, "");
  assert.equal(decisionTemplate.decisionHash, "");
  assert.equal(decisionTemplate.thresholds, null);
  assert.equal(decisionTemplate.v4EvidenceSealed, true);
  assert.equal(decisionTemplate.holdoutManifestHash, FROZEN_HOLDOUT_HASH);
  assert.deepEqual(decisionTemplate.invariants, [...RANK_POLICY_INVARIANTS]);

  const validation = validateRankPolicyDecision(decisionTemplate, parseRankPolicyDecision(decisionTemplate), {
    expectedHoldoutManifestHash: FROZEN_HOLDOUT_HASH,
  });
  assert.equal(validation.valid, false);
  assert.equal(validation.finalized, false);
  assert.ok(validation.errors.some((error) => error.startsWith("decision_undecided")));
  assert.throws(
    () => assertRankPolicyDecision(decisionTemplate, { expectedHoldoutManifestHash: FROZEN_HOLDOUT_HASH }),
    /decision_fail_closed: .*decision_undecided/u,
  );
});

test("a finalized decision validates and is bound to the v5 holdout hash", () => {
  for (const policy of RANK_POLICY_DECISIONS) {
    if (policy === "undecided") continue;
    const record = policy === "numeric-thresholds"
      ? finalizedDecision(policy, { thresholds: { minOverlapAtKMacro: 0.5 }, rationale: "independently pre-registered" })
      : finalizedDecision(policy);
    const validation = validateRankPolicyDecision(record, parseRankPolicyDecision(record), {
      expectedHoldoutManifestHash: FROZEN_HOLDOUT_HASH,
    });
    assert.equal(validation.valid, true, `${policy} must validate: ${validation.errors.join(", ")}`);
    assert.equal(validation.finalized, true);
    assert.equal(assertRankPolicyDecision(record, { expectedHoldoutManifestHash: FROZEN_HOLDOUT_HASH }).policy, policy);
  }

  const wrongHash = finalizedDecision("candidate-coverage-equivalence", { holdoutManifestHash: "0000000000000000" });
  const validation = validateRankPolicyDecision(wrongHash, parseRankPolicyDecision(wrongHash), {
    expectedHoldoutManifestHash: FROZEN_HOLDOUT_HASH,
  });
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((error) => error.startsWith("decision_hash_mismatch")));
});

test("the decision parser fails closed on structural violations", () => {
  assert.throws(() => parseRankPolicyDecision(null), /must be a JSON object/u);
  assert.throws(() => parseRankPolicyDecision({ version: 2, policy: "undecided" }), /unsupported decision version/u);
  assert.throws(() => parseRankPolicyDecision({ version: 1, policy: "not-a-policy" }), /unknown policy/u);
  assert.throws(
    () => parseRankPolicyDecision({ version: 1, policy: "undecided", invariants: ["E5"] }),
    /subset of E1-E4/u,
  );
  assert.throws(
    () => parseRankPolicyDecision({ version: 1, policy: "undecided", invariants: ["E1"], thresholds: "nope" }),
    /thresholds must be an object or null/u,
  );
});

test("the sealed v4 metric/reference guards reject any leak recursively", () => {
  assert.ok(SEALED_V4_FORBIDDEN_KEYS.includes("observedId"));
  assert.ok(SEALED_V4_FORBIDDEN_KEYS.includes("oracleTopId"));
  assert.ok(SEALED_V4_FORBIDDEN_KEYS.includes("expectedIds"));
  assert.ok(SEALED_V4_FORBIDDEN_KEYS.includes("metrics"));
  assert.ok(SEALED_V4_METRIC_LITERALS.includes("0.5833333333"));
  assert.ok(SEALED_V4_METRIC_LITERALS.includes(RANK_POLICY_V4_HASH));

  const literal = finalizedDecision("informational-only", { rationale: "the sealed v4 value was 0.5833333333" });
  const literalValidation = validateRankPolicyDecision(literal, parseRankPolicyDecision(literal), {
    expectedHoldoutManifestHash: FROZEN_HOLDOUT_HASH,
  });
  assert.equal(literalValidation.valid, false);
  assert.ok(literalValidation.errors.some((error) => error.startsWith("sealed-v4-metric")));

  const keyed = finalizedDecision("informational-only") as RankPolicyDecisionRecord & { metrics?: unknown };
  keyed.metrics = { overlapAtKCount: 3, observedId: "x" };
  const keyedValidation = validateRankPolicyDecision(keyed, parseRankPolicyDecision(keyed), {
    expectedHoldoutManifestHash: FROZEN_HOLDOUT_HASH,
  });
  assert.equal(keyedValidation.valid, false);
  assert.ok(keyedValidation.errors.some((error) => error.startsWith("sealed-v4-reference")));
  assert.throws(
    () => assertRankPolicyDecision(keyed, { expectedHoldoutManifestHash: FROZEN_HOLDOUT_HASH }),
    /decision_fail_closed/u,
  );
});

test("numeric mode requires explicit thresholds and a rationale while non-numeric modes reject thresholds", () => {
  const numericMissing = finalizedDecision("numeric-thresholds");
  const missingValidation = validateRankPolicyDecision(numericMissing, parseRankPolicyDecision(numericMissing), {
    expectedHoldoutManifestHash: FROZEN_HOLDOUT_HASH,
  });
  assert.equal(missingValidation.valid, false);
  assert.ok(missingValidation.errors.some((error) => error.startsWith("decision_numeric_thresholds_missing")));
  assert.ok(missingValidation.errors.some((error) => error.startsWith("decision_rationale_missing")));

  const numericOutOfRange = finalizedDecision("numeric-thresholds", {
    thresholds: { minOverlapAtKMacro: 1.5 },
    rationale: "pre-registered",
  });
  assert.ok(
    validateRankPolicyDecision(numericOutOfRange, parseRankPolicyDecision(numericOutOfRange), {
      expectedHoldoutManifestHash: FROZEN_HOLDOUT_HASH,
    }).errors.some((error) => error.startsWith("decision_numeric_thresholds_invalid")),
  );

  const nonNumeric = finalizedDecision("candidate-coverage-equivalence", { thresholds: { minOverlapAtKMacro: 0.5 } });
  assert.ok(
    validateRankPolicyDecision(nonNumeric, parseRankPolicyDecision(nonNumeric), {
      expectedHoldoutManifestHash: FROZEN_HOLDOUT_HASH,
    }).errors.some((error) => error.startsWith("decision_thresholds_forbidden")),
  );
});

test("the decision hash is canonical, order-independent and ignores the hash field", () => {
  const record = finalizedDecision("informational-only", { rationale: "same-rationale" });
  assert.equal(rankDecisionHash(record), record.decisionHash);
  const body = { ...record };
  delete (body as { decisionHash?: string }).decisionHash;
  assert.equal(rankDecisionHash(body), record.decisionHash);
  const reordered = {
    rationale: record.rationale,
    invariants: record.invariants,
    policy: record.policy,
    version: record.version,
    decisionId: record.decisionId,
    decidedAt: record.decidedAt,
    decidedByRole: record.decidedByRole,
    holdoutManifestHash: record.holdoutManifestHash,
    v4EvidenceSealed: record.v4EvidenceSealed,
    thresholds: record.thresholds,
  };
  assert.equal(rankDecisionHash(reordered), record.decisionHash);
  assert.notEqual(rankDecisionHash(finalizedDecision("informational-only", { rationale: "different" })), record.decisionHash);
});

test("equivalence E1 requires a frozen validated target and both observed tops inside the set", () => {
  assert.equal(evaluateE1(equivalenceInput()), true);
  assert.equal(
    evaluateE1(
      equivalenceInput({
        case: makeCase({ id: "g", category: "multilingual-legal-term", query: "standing", invariant: "informational" }),
        target: null,
      }),
    ),
    null,
  );
  assert.equal(evaluateE1(equivalenceInput({ target: { expectedIds: [], matchCount: 0, frozen: false, frozenValidated: false } })), null);
  assert.equal(
    evaluateE1(equivalenceInput({ target: { expectedIds: ["local-top"], matchCount: 1, frozen: true, frozenValidated: false } })),
    false,
  );
  assert.equal(evaluateE1(equivalenceInput({ oracleIds: ["outside"], oracleCompared: true })), false);
  assert.equal(evaluateE1(equivalenceInput({ observedIds: ["outside"], oracleIds: ["local-top"] })), false);
  const oracleAbsent = equivalenceInput({ oracleIds: [], oracleCompared: false });
  assert.equal(evaluateE1(oracleAbsent), true, "an empty production window does not fail the local top-1 rule");
});

test("E2, E3 and E4 evaluate candidate coverage without ever reading order metrics", () => {
  assert.equal(evaluateE2(equivalenceInput()), true);
  assert.equal(evaluateE2(equivalenceInput({ oracleIds: [], oracleCompared: false })), null);
  assert.equal(evaluateE2(equivalenceInput({ observedIds: ["a", "b"], oracleIds: ["z"] })), false);

  assert.equal(evaluateE3(equivalenceInput()), true);
  assert.equal(evaluateE3(equivalenceInput({ scopeIds: null })), null);
  assert.equal(evaluateE3(equivalenceInput({ observedIds: ["outside", "local-second"] })), false);

  assert.equal(evaluateE4(equivalenceInput()), true);
  assert.equal(evaluateE4(equivalenceInput({ observedIds: [], oracleIds: [] , oracleCompared: false })), true);
  assert.equal(evaluateE4(equivalenceInput({ observedIds: ["a"], oracleIds: [], oracleCompared: true })), false);
});

test("candidate-coverage equivalence gates on every applicable invariant and never on order metrics", () => {
  const passing = evaluateCandidateCoverageEquivalence([equivalenceInput()]);
  assert.equal(passing.policy, "candidate-coverage-equivalence");
  assert.deepEqual(passing.invariants, [...RANK_POLICY_INVARIANTS]);
  assert.equal(passing.cases, 1);
  assert.equal(passing.passed, true);
  assert.deepEqual(passing.failures, []);
  for (const invariant of RANK_POLICY_INVARIANTS) {
    assert.deepEqual(passing.counts[invariant], { applicable: 1, passed: 1, failed: 0 });
  }
  assert.deepEqual(Object.keys(passing).sort(), ["cases", "counts", "failures", "invariants", "passed", "policy"]);

  const failingCase = equivalenceInput({ oracleIds: ["oracle-outside"], oracleCompared: true });
  const failing = evaluateCandidateCoverageEquivalence([equivalenceInput(), failingCase]);
  assert.equal(failing.passed, false);
  assert.ok(failing.failures.includes("E1:case-1"));
  assert.ok(failing.failures.includes("E2:case-1"));

  assert.equal(evaluateCandidateCoverageEquivalence([]).passed, false, "an empty holdout can never pass");
});

test("the holdout evidence report is content-free and bound to decisionHash + holdoutHash", () => {
  const equivalence = evaluateCandidateCoverageEquivalence([equivalenceInput()]);
  const report = buildFtsParityHoldoutReport({
    generatedAt: "2026-09-26T00:00:00.000Z",
    source: "fixture",
    maxArticles: 10,
    truncated: false,
    holdoutHash: FROZEN_HOLDOUT_HASH,
    decisionHash: "abcdef0123456789",
    policy: "candidate-coverage-equivalence",
    decidedByRole: "product-owner",
    projection: { sourceRows: 2, documents: 2, productionProjectionIds: null },
    oracleAvailable: false,
    equivalence,
    numeric: null,
    state: "pass",
    blockers: [],
  });
  assert.equal(report.holdoutHash, FROZEN_HOLDOUT_HASH);
  assert.equal(report.decisionHash, "abcdef0123456789");
  assert.equal(report.scope, "fts-parity-holdout");
  assert.equal(report.state, "pass");
  assert.ok(report.boundaries.some((boundary) => /read-only/u.test(boundary)));
  assert.match(renderFtsParityHoldoutMarkdown(report), /Candidate-coverage equivalence invariants/u);

  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /query shape|local-top|local-second/u, "ids and query text must never enter the report");
  assert.doesNotMatch(renderFtsParityHoldoutMarkdown(report), /query shape|local-top|local-second/u);
});

test("the holdout report hash excludes generatedAt and the informational blocker is preserved", () => {
  const build = (generatedAt: string): FtsParityHoldoutReport =>
    buildFtsParityHoldoutReport({
      generatedAt,
      source: "supabase",
      maxArticles: 1258,
      truncated: false,
      holdoutHash: FROZEN_HOLDOUT_HASH,
      decisionHash: "abcdef0123456789",
      policy: "informational-only",
      decidedByRole: "product-owner",
      projection: { sourceRows: 1258, documents: 1258, productionProjectionIds: 1258 },
      oracleAvailable: true,
      equivalence: null,
      numeric: null,
      state: "insufficient_evidence",
      blockers: [
        {
          code: "fulltext_rank_threshold_unagreed",
          detail: "the signed decision is informational-only: GO-SEARCH stays blocked",
        },
      ],
    });
  const first = build("2026-09-26T00:00:00.000Z");
  const second = build("2026-09-27T12:34:56.000Z");
  assert.equal(ftsParityHoldoutReportHash(first), ftsParityHoldoutReportHash(second));
  const markdown = renderFtsParityHoldoutMarkdown(first);
  assert.match(markdown, /fulltext_rank_threshold_unagreed/u);
  assert.match(markdown, /informational-only/u);
  assert.equal(first.state, "insufficient_evidence");
});

function runHoldoutBlock(): string {
  const start = harnessSource.indexOf("async function runHoldout");
  const end = harnessSource.indexOf("async function main");
  assert.ok(start >= 0 && end > start, "runHoldout must be present in the harness");
  return harnessSource.slice(start, end);
}

test("the holdout harness refuses an unfinalized/mismatched decision before any linked query", () => {
  const block = runHoldoutBlock();
  assert.match(block, /--decision/u);
  assert.match(block, /assertRankPolicyDecision/u);
  assert.match(block, /requireFinalized: true/u);
  assert.match(block, /expectedHoldoutManifestHash/u);
  const failClosed = block.indexOf("assertRankPolicyDecision");
  const load = block.indexOf("loadSourceRows");
  assert.ok(block.indexOf("readFileSync(decisionPath") < failClosed, "the decision must be read before it is validated");
  assert.ok(failClosed < load, "decision validation must run before any source read or linked query");
  assert.match(harnessSource, /--manifest=holdout-v5/u);
  assert.match(harnessSource, /assertHoldoutDisjoint/u);
  assert.match(harnessSource, /m7\.8b-fts-parity-holdout\.json/u);
});

test("the holdout harness is read-only and never writes to Supabase/D1/Vectorize", () => {
  assert.match(harnessSource, /--apply is not available/u);
  assert.match(harnessSource, /read-only by construction/u);
  assert.doesNotMatch(harnessSource, /\.insert\(|\.update\(|\.delete\(|d1 execute|\bfetch\(/u);
  assert.match(harnessSource, /createSupabaseLinkedQueryRunner/u);
  assert.match(harnessSource, /assertFullProjectionScope/u);
});

test("the M7.8-B package scripts are wired and included in the release gate", () => {
  assert.equal(packageJson.scripts["m7.8b:holdout"], "tsx scripts/d1-fts-parity.ts --manifest=holdout-v5");
  assert.equal(packageJson.scripts["test:m7.8b"], "tsx --test tests/m7.8b-rank-policy-decision.test.ts");
  assert.equal(packageJson.scripts["d1:fts-parity"], "tsx scripts/d1-fts-parity.ts");
  assert.match(packageJson.scripts["verify:release"], /pnpm test:m7\.8b/u);
});

test("the M7.8-B rank-policy surfaces are runtime-neutral with no node builtin or network code", () => {
  const dir = path.join(rootDir, "lib/cloudflare/search-rank-policy");
  for (const file of ["decision.ts", "equivalence.ts", "holdout.ts"]) {
    const source = fs.readFileSync(path.join(dir, file), "utf8");
    assert.doesNotMatch(source, /from ["']node:/u, `${file} must not import a Node builtin`);
    assert.doesNotMatch(source, /\bfetch\(/u, `${file} must not perform network I/O`);
  }
  assert.equal(RANK_POLICY_DECISIONS.length, 4);
  assert.ok(RANK_POLICY_DECISIONS.includes("undecided"));
  assert.ok(RANK_POLICY_DECISIONS.includes("candidate-coverage-equivalence"));
  assert.deepEqual(RANK_POLICY_INVARIANTS, ["E1", "E2", "E3", "E4"]);
});
