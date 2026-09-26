import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { compareRankedIds } from "../lib/cloudflare/search-fts";
import {
  buildSearchProjection,
  type SearchPublicationP3Row,
  type SearchVersionP3Row,
} from "../lib/cloudflare/search-projection";
import {
  RANK_CORPUS_CANDIDATES,
  aggregateRankComparisons,
  assertRankCorpusCase,
  buildFtsParityReport,
  buildRankCorpusManifest,
  evaluateRankPolicyCase,
  rankCorpusHash,
  renderFtsParityMarkdown,
  resolveExactCaseTarget,
  resolveExactTitleTarget,
  resolveFrozenStrictTarget,
  selectRepresentativeCorpus,
  summarizeRankPolicy,
  type RankCorpusCase,
  type RankCorpusInvariant,
  type RankPolicyThresholds,
} from "../lib/cloudflare/search-rank-policy";
import {
  assertFullProjectionScope,
  assertProductionScopeLargeEnough,
  buildFtsSourcePageSql,
  combineFtsSourcePages,
  evaluateFtsProjectionScope,
  parseFtsSourceRows,
  restrictToProductionIds,
} from "../scripts/d1-fts-source-pager";

/**
 * M7.7-B frozen corpus + rank policy tests.
 *
 * The corpus is static data; the policy is a pure state machine. No network,
 * Supabase or Wrangler is touched, and the committed manifest must never be
 * regenerated from an observed parity outcome.
 */

const rootDir = process.cwd();
const manifestPath = path.join(rootDir, "lib/cloudflare/search-rank-policy/corpus.manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
  version: number;
  corpusHash: string;
  cases: RankCorpusCase[];
};
const v1ManifestPath = path.join(rootDir, "lib/cloudflare/search-rank-policy/corpus.manifest.v1-invalid.json");
const v1Manifest = JSON.parse(fs.readFileSync(v1ManifestPath, "utf8")) as {
  version: number;
  corpusHash: string;
  cases: RankCorpusCase[];
};
const v2ManifestPath = path.join(rootDir, "lib/cloudflare/search-rank-policy/corpus.manifest.v2-harness-invalid.json");
const v2Manifest = JSON.parse(fs.readFileSync(v2ManifestPath, "utf8")) as {
  version: number;
  corpusHash: string;
  cases: Array<RankCorpusCase & { expectedId?: string }>;
};
const v3ManifestPath = path.join(rootDir, "lib/cloudflare/search-rank-policy/corpus.manifest.v3-targetset-invalid.json");
const v3Manifest = JSON.parse(fs.readFileSync(v3ManifestPath, "utf8")) as {
  version: number;
  corpusHash: string;
  cases: RankCorpusCase[];
};
const harnessSource = fs.readFileSync(path.join(rootDir, "scripts/d1-fts-parity.ts"), "utf8");
const pagerSource = fs.readFileSync(path.join(rootDir, "scripts/d1-fts-source-pager.ts"), "utf8");
const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

function makeCase(overrides: Partial<RankCorpusCase> & Pick<RankCorpusCase, "id" | "category" | "query" | "invariant">): RankCorpusCase {
  return {
    filters: { source: null, jurisdiction: null, contentType: null, language: null, range: "latest" },
    limit: 10,
    k: 10,
    ...overrides,
  };
}

function outcomeFor(
  caseDef: RankCorpusCase,
  observedIds: string[],
  oracleIds: string[],
  expectedIds: string[] | null,
  options: { oracleCompared?: boolean; invariant?: RankCorpusInvariant } = {},
) {
  return evaluateRankPolicyCase({
    case: caseDef,
    observedIds,
    oracleIds,
    oracleCompared: options.oracleCompared ?? true,
    metrics: compareRankedIds(oracleIds, observedIds, { k: caseDef.k }),
    target:
      expectedIds === null
        ? null
        : { expectedIds, matchCount: expectedIds.length, frozen: false, frozenValidated: true },
  });
}

test("the committed manifest carries a stable corpus hash and reproduces the selected corpus", () => {
  const built = buildRankCorpusManifest();
  assert.deepEqual(built, manifest, "the committed manifest must equal the deterministic selection");
  assert.equal(buildRankCorpusManifest().corpusHash, manifest.corpusHash);
  assert.equal(rankCorpusHash(manifest.cases), manifest.corpusHash);
});

test("the corpus hash is order-independent", () => {
  const reversed = [...manifest.cases].reverse();
  assert.equal(rankCorpusHash(reversed), manifest.corpusHash);
});

test("corpus selection is deterministic and category-complete", () => {
  const first = selectRepresentativeCorpus();
  const second = selectRepresentativeCorpus();
  assert.deepEqual(first, second);
  assert.deepEqual(first, manifest.cases);
  // Reversing the candidate pool must not change the selected corpus.
  assert.deepEqual(selectRepresentativeCorpus([...RANK_CORPUS_CANDIDATES].reverse()), first);

  const categories = new Set(first.map((caseDef) => caseDef.category));
  for (const category of [
    "exact-case",
    "exact-title",
    "multilingual-legal-term",
    "case-number-identifier",
    "jurisdiction-source",
    "cclrag2-shape",
    "cclmetasearch-shape",
  ]) {
    assert.ok(categories.has(category as RankCorpusCase["category"]), `category ${category} must be represented`);
    const scoped = first.filter((caseDef) => caseDef.category === category);
    const expectedCount = category === "exact-case" || category === "exact-title" ? 4 : 2;
    assert.equal(scoped.length, expectedCount, `category ${category} must select ${expectedCount} cases`);
  }
  assert.equal(first.length, 18, "v4 selects 8 strict anchors + 10 informational cases");
});

test("v1/v2/v3 are archived invalid fixtures while v4 is the active frozen corpus", () => {
  assert.equal(v1Manifest.version, 1);
  assert.equal(v1Manifest.corpusHash, "62c5e359e5b9838d");
  assert.equal(v1Manifest.cases.length, 14);
  assert.equal(v2Manifest.version, 2);
  assert.equal(v2Manifest.corpusHash, "26f2a4d4b03e7a90");
  assert.equal(v3Manifest.version, 3);
  assert.equal(v3Manifest.corpusHash, "fb108124e7fe6ed8");
  assert.equal(manifest.version, 4);
  assert.notEqual(manifest.corpusHash, v1Manifest.corpusHash);
  assert.notEqual(manifest.corpusHash, v2Manifest.corpusHash);
  assert.notEqual(manifest.corpusHash, v3Manifest.corpusHash);
  // The invalid v1 strict candidates must no longer be active.
  const v1StrictIds = new Set(v1Manifest.cases.filter((c) => c.invariant !== "informational").map((c) => c.id));
  for (const id of v1StrictIds) {
    assert.ok(!manifest.cases.some((c) => c.id === id), `invalid v1 strict case ${id} must not be active`);
  }
});

test("v4 preserves every v1/v2/v3 informational query unchanged", () => {
  const key = (c: RankCorpusCase): string => JSON.stringify([c.id, c.query, c.filters]);
  const v1Informational = v1Manifest.cases.filter((c) => c.invariant === "informational").map(key).sort();
  const v2Informational = v2Manifest.cases.filter((c) => c.invariant === "informational").map(key).sort();
  const v3Informational = v3Manifest.cases.filter((c) => c.invariant === "informational").map(key).sort();
  const v4Informational = manifest.cases.filter((c) => c.invariant === "informational").map(key).sort();
  assert.deepEqual(v2Informational, v1Informational);
  assert.deepEqual(v3Informational, v2Informational);
  assert.deepEqual(v4Informational, v3Informational);
});

test("v4 preserves every v3 query, filter and category unchanged", () => {
  const shape = (c: { id: string; category: string; query: string; filters: unknown }): string =>
    JSON.stringify([c.id, c.category, c.query, c.filters]);
  const v3Shapes = v3Manifest.cases.map(shape).sort();
  const v4Shapes = manifest.cases.map(shape).sort();
  assert.deepEqual(v4Shapes, v3Shapes, "v4 may only correct strict target sets, never a query/filter/category");
  assert.equal(v3Shapes.length, 18);
  assert.ok(manifest.cases.filter((c) => c.invariant !== "informational").every((c) => Array.isArray(c.expectedIds)));
});

test("v4 freezes authoritative exact-case and exact-title target sets", () => {
  const anchors = [
    { source: "de-bverfg", caseIds: ["00083deb-5bc9-4b28-bbcd-68076cd05514"], caseQuery: "2 BvL 21/14", title: "Beschluss vom 21. Oktober 2025", titleIds: ["00083deb-5bc9-4b28-bbcd-68076cd05514", "5dce7909-0bdb-4739-acb2-8106abe45c0b", "c27578dc-af58-4c29-9511-d48bf4327682"] },
    { source: "es-tribunal-constitucional", caseIds: ["00cc18bd-ace3-4b5e-aabb-f3aacbd6d077", "e6e97786-ad78-46b1-8549-7a69788ea178"], caseQuery: "57/2025", title: "AUTO 57/2025, de 27 de mayo de 2025", titleIds: ["00cc18bd-ace3-4b5e-aabb-f3aacbd6d077"] },
    { source: "fr-conseil-constitutionnel", caseIds: ["0018a822-df15-4526-abd8-6c22e6ba7988"], caseQuery: "2024-6412 AN", title: "Décision n° 2024-6412 AN du 6 juin 2025", titleIds: ["0018a822-df15-4526-abd8-6c22e6ba7988"] },
    { source: "us-scotus", caseIds: ["0346769f-97d0-48e2-b2e2-3a371e7d2eee"], caseQuery: "24-304", title: "Laboratory Corp. of America Holdings v. Davis", titleIds: ["0346769f-97d0-48e2-b2e2-3a371e7d2eee"] },
  ];
  const exactCase = manifest.cases.filter((c) => c.category === "exact-case");
  const exactTitle = manifest.cases.filter((c) => c.category === "exact-title");
  assert.equal(exactCase.length, 4);
  assert.equal(exactTitle.length, 4);
  for (const anchor of anchors) {
    assert.ok(
      exactCase.some((c) => c.query === anchor.caseQuery && JSON.stringify(c.expectedIds) === JSON.stringify(anchor.caseIds)),
      `missing exact-case anchor for ${anchor.source}`,
    );
    assert.ok(
      exactTitle.some((c) => c.query === anchor.title && JSON.stringify(c.expectedIds) === JSON.stringify(anchor.titleIds)),
      `missing exact-title anchor for ${anchor.source}`,
    );
  }
  // Spain 57/2025 is the only multi-id exact-case set (AUTO and SENTENCIA share
  // the case key); every other exact-case set is an authoritative singleton.
  for (const caseDef of exactCase) {
    if (caseDef.query === "57/2025") {
      assert.deepEqual(caseDef.expectedIds, ["00cc18bd-ace3-4b5e-aabb-f3aacbd6d077", "e6e97786-ad78-46b1-8549-7a69788ea178"]);
    } else {
      assert.equal(caseDef.expectedIds?.length, 1, `exact-case ${caseDef.id} must be a singleton`);
    }
  }
  // The exact-title sets are unchanged from v3: BVerfG three, the rest singletons.
  for (const caseDef of exactTitle) {
    assert.equal(caseDef.expectedIds?.length, caseDef.query === "Beschluss vom 21. Oktober 2025" ? 3 : 1);
  }
});

test("the manifest is content-free and carries only queries/ids/filters/categories", () => {
  assert.deepEqual(Object.keys(manifest).sort(), ["cases", "corpusHash", "version"]);
  const allowedFilterKeys = ["contentType", "jurisdiction", "language", "range", "source"].sort();
  for (const caseDef of manifest.cases) {
    const strict = caseDef.invariant !== "informational";
    const allowedCaseKeys = strict
      ? ["category", "expectedIds", "filters", "id", "invariant", "k", "limit", "query"].sort()
      : ["category", "filters", "id", "invariant", "k", "limit", "query"].sort();
    assert.deepEqual(Object.keys(caseDef).sort(), allowedCaseKeys);
    if (strict) assert.ok(Array.isArray(caseDef.expectedIds) && caseDef.expectedIds.length > 0);
    assert.deepEqual(Object.keys(caseDef.filters).sort(), allowedFilterKeys);
    assert.ok(caseDef.query.length <= 300, "a content-free query shape must stay short");
  }
  const serialized = JSON.stringify(manifest);
  assert.doesNotMatch(serialized, /https?:\/\//u, "no URL may appear in the corpus");
  assert.doesNotMatch(
    serialized,
    /"(search_text|cleaned_text|display_title|summary|summary_json|url|embedding|vector|raw_text|body|content)"\s*:/u,
    "no document text/summary/url/vector field may appear in the corpus",
  );
});

test("candidate validation rejects a category/invariant mismatch", () => {
  assert.throws(
    () =>
      assertRankCorpusCase(
        makeCase({ id: "bad", category: "exact-title", query: "x", invariant: "informational" }),
      ),
    /must carry invariant/u,
  );
  assert.throws(
    () => assertRankCorpusCase(makeCase({ id: "bad-range", category: "exact-case", query: "x", invariant: "exact-case", filters: { source: null, jurisdiction: null, contentType: null, language: null, range: "year" as never } })),
    /invalid range/u,
  );
});

test("aggregate metrics are macro means over the compareRankedIds evidence", () => {
  const first = compareRankedIds(["a", "b"], ["a", "x", "b"], { k: 10 });
  const second = compareRankedIds(["c", "d"], ["c", "d"], { k: 10 });
  const aggregate = aggregateRankComparisons([first, second]);

  assert.equal(aggregate.compared, 2);
  assert.equal(aggregate.overlapAtKCount, 4);
  assert.equal(aggregate.overlapAtKMacro, 0.2);
  assert.equal(aggregate.prefixMatchCount, 3);
  assert.equal(aggregate.prefixMatchMacro, 0.75);
  assert.equal(aggregate.exactOrderCount, 1);
  assert.equal(aggregate.exactOrderMacro, 0.5);
  assert.equal(aggregate.sameSetCount, 1);
  assert.equal(aggregate.sameSetMacro, 0.5);

  assert.deepEqual(aggregateRankComparisons([]), {
    compared: 0,
    overlapAtKCount: 0,
    overlapAtKMacro: 0,
    prefixMatchCount: 0,
    prefixMatchMacro: 0,
    exactOrderCount: 0,
    exactOrderMacro: 0,
    sameSetCount: 0,
    sameSetMacro: 0,
  });
});

const ARTICLE_A = "11111111-0000-0000-0000-000000000001";
const ARTICLE_B = "22222222-0000-0000-0000-000000000002";
const ARTICLE_C = "33333333-0000-0000-0000-000000000003";
const VERSION_A = "aaaaaaaa-0000-0000-0000-00000000000a";
const VERSION_B = "bbbbbbbb-0000-0000-0000-00000000000b";
const VERSION_C = "cccccccc-0000-0000-0000-00000000000c";

function publication(index: number): SearchPublicationP3Row {
  return {
    id: `cccccccc-0000-0000-0000-00000000000${index}`,
    article_id: index === 1 ? ARTICLE_A : ARTICLE_B,
    state: "published",
    version_id: index === 1 ? VERSION_A : VERSION_B,
    created_at: "2026-01-01T00:00:00.000Z",
  };
}

function version(overrides: Partial<SearchVersionP3Row>): SearchVersionP3Row {
  return {
    id: VERSION_A,
    article_id: ARTICLE_A,
    source_key: "de-bverfg",
    jurisdiction: "Germany",
    content_type: "decision",
    original_language: "de",
    original_title: "Klimaschutz Beschluss",
    case_key: "1bvr265618",
    original_published_at: "2026-01-01T00:00:00.000Z",
    cleaned_text: "klimaschutz grundrechte",
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const DUPLICATE_TITLE = "Beschluss vom 21. Oktober 2025";

/** Three authoritative projections that all carry the exact same original title. */
function buildDuplicateTitleCorpus() {
  const articleIds = [ARTICLE_A, ARTICLE_B, ARTICLE_C];
  const versionIds = [VERSION_A, VERSION_B, VERSION_C];
  return buildSearchProjection({
    publications: articleIds.map((articleId, index) => ({
      id: `dddddddd-0000-0000-0000-00000000000${index}`,
      article_id: articleId,
      state: "published",
      version_id: versionIds[index],
      created_at: "2026-01-01T00:00:00.000Z",
    })),
    versions: articleIds.map((articleId, index) =>
      version({
        id: versionIds[index],
        article_id: articleId,
        source_key: "de-bverfg",
        original_title: DUPLICATE_TITLE,
        korean_title: null,
        case_key: null,
        cleaned_text: "beschluss oktober",
      }),
    ),
  });
}

test("exact-case and exact-title targets resolve deterministically against the local corpus", () => {
  const built = buildSearchProjection({
    publications: [publication(1), publication(2)],
    versions: [
      version({}),
      version({
        id: VERSION_B,
        article_id: ARTICLE_B,
        source_key: "us-scotus",
        jurisdiction: "United States",
        original_title: "First Amendment Standing",
        case_key: null,
        cleaned_text: "first amendment standing",
      }),
    ],
  });

  const caseTarget = resolveExactCaseTarget(
    makeCase({ id: "ec", category: "exact-case", query: "1 BvR 2656/18", invariant: "exact-case" }),
    built.documents,
  );
  assert.deepEqual(caseTarget, { expectedIds: [ARTICLE_A], matchCount: 1 });

  const titleTarget = resolveExactTitleTarget(
    makeCase({ id: "et", category: "exact-title", query: "First Amendment Standing", invariant: "exact-title" }),
    built.ftsDocuments,
  );
  assert.deepEqual(titleTarget, { expectedIds: [ARTICLE_B], matchCount: 1 });
});

test("frozen strict targets validate against the local projection and fail closed on drift", () => {
  const built = buildSearchProjection({
    publications: [publication(1), publication(2)],
    versions: [
      version({}),
      version({
        id: VERSION_B,
        article_id: ARTICLE_B,
        source_key: "us-scotus",
        jurisdiction: "United States",
        original_title: "First Amendment Standing",
        case_key: null,
        cleaned_text: "first amendment standing",
      }),
    ],
  });
  const corpus = { documents: built.documents, ftsDocuments: built.ftsDocuments };

  const matching = makeCase({
    id: "ec",
    category: "exact-case",
    query: "1 BvR 2656/18",
    invariant: "exact-case",
    expectedIds: [ARTICLE_A],
  });
  const valid = resolveFrozenStrictTarget(matching, corpus);
  assert.deepEqual(valid, { expectedIds: [ARTICLE_A], matchCount: 1, frozen: true, frozenValidated: true });
  const pass = evaluateRankPolicyCase({
    case: matching,
    observedIds: [ARTICLE_A],
    oracleIds: [ARTICLE_A],
    oracleCompared: true,
    metrics: null,
    target: valid,
  });
  assert.equal(pass.status, "pass");

  // A frozen id that no longer resolves against the projection fails closed.
  const drifted = makeCase({
    id: "ec",
    category: "exact-case",
    query: "1 BvR 2656/18",
    invariant: "exact-case",
    expectedIds: [ARTICLE_B],
  });
  const invalid = resolveFrozenStrictTarget(drifted, corpus);
  assert.equal(invalid.frozen, true);
  assert.equal(invalid.frozenValidated, false);
  const fail = evaluateRankPolicyCase({
    case: drifted,
    observedIds: [ARTICLE_A],
    oracleIds: [ARTICLE_A],
    oracleCompared: true,
    metrics: null,
    target: invalid,
  });
  assert.equal(fail.status, "fail");

  // A non-frozen local resolution stays resolvable (legacy caller behavior).
  const informationalTarget = resolveFrozenStrictTarget(
    makeCase({ id: "et", category: "exact-title", query: "First Amendment Standing", invariant: "exact-title" }),
    corpus,
  );
  assert.equal(informationalTarget.frozen, false);
  assert.deepEqual(informationalTarget.expectedIds, [ARTICLE_B]);
});

test("a non-unique exact title passes for any frozen target-set member and fails outside the set", () => {
  const built = buildDuplicateTitleCorpus();
  const corpus = { documents: built.documents, ftsDocuments: built.ftsDocuments };
  const expectedIds = [ARTICLE_A, ARTICLE_B, ARTICLE_C];
  const duplicate = makeCase({
    id: "et-dup",
    category: "exact-title",
    query: DUPLICATE_TITLE,
    invariant: "exact-title",
    expectedIds,
  });
  const target = resolveFrozenStrictTarget(duplicate, corpus);
  assert.deepEqual(target.expectedIds, expectedIds);
  assert.equal(target.frozen, true);
  assert.equal(target.frozenValidated, true);

  for (const member of expectedIds) {
    const outcome = evaluateRankPolicyCase({
      case: duplicate,
      observedIds: [member],
      oracleIds: [member],
      oracleCompared: true,
      metrics: null,
      target,
    });
    assert.equal(outcome.status, "pass", `frozen member ${member} must pass`);
  }

  const outside = evaluateRankPolicyCase({
    case: duplicate,
    observedIds: ["ffffffff-0000-0000-0000-00000000000f"],
    oracleIds: [ARTICLE_A],
    oracleCompared: true,
    metrics: null,
    target,
  });
  assert.equal(outside.status, "fail", "a top id outside the frozen target set must fail");
});

test("a multi-id exact-case target passes for any frozen set member and fails outside the set", () => {
  // AUTO and SENTENCIA share the Spain case key 572025, so the frozen exact-case
  // set has two authoritative members. Either may be the top result.
  const built = buildSearchProjection({
    publications: [publication(1), publication(2)],
    versions: [
      version({
        source_key: "es-tribunal-constitucional",
        jurisdiction: "Spain",
        original_title: "AUTO 57/2025, de 27 de mayo de 2025",
        case_key: "572025",
        cleaned_text: "auto constitucional",
      }),
      version({
        id: VERSION_B,
        article_id: ARTICLE_B,
        source_key: "es-tribunal-constitucional",
        jurisdiction: "Spain",
        original_title: "SENTENCIA 57/2025, de 27 de mayo de 2025",
        case_key: "572025",
        cleaned_text: "sentencia constitucional",
      }),
    ],
  });
  const corpus = { documents: built.documents, ftsDocuments: built.ftsDocuments };
  const expectedIds = [ARTICLE_A, ARTICLE_B];
  const multiCase = makeCase({
    id: "ec-multi",
    category: "exact-case",
    query: "57/2025",
    invariant: "exact-case",
    expectedIds,
  });
  const target = resolveFrozenStrictTarget(multiCase, corpus);
  assert.deepEqual(target.expectedIds, expectedIds);
  assert.equal(target.frozen, true);
  assert.equal(target.frozenValidated, true);

  for (const member of expectedIds) {
    const outcome = evaluateRankPolicyCase({
      case: multiCase,
      observedIds: [member],
      oracleIds: [member],
      oracleCompared: true,
      metrics: null,
      target,
    });
    assert.equal(outcome.status, "pass", `frozen exact-case member ${member} must pass`);
  }

  const outside = evaluateRankPolicyCase({
    case: multiCase,
    observedIds: ["ffffffff-0000-0000-0000-00000000000f"],
    oracleIds: [ARTICLE_A],
    oracleCompared: true,
    metrics: null,
    target,
  });
  assert.equal(outside.status, "fail", "a top id outside the frozen exact-case set must fail");
});

test("the frozen preflight must reproduce exactly the frozen target set and fails on set drift", () => {
  const built = buildDuplicateTitleCorpus();
  const corpus = { documents: built.documents, ftsDocuments: built.ftsDocuments };
  const base = { id: "et-dup", category: "exact-title" as const, query: DUPLICATE_TITLE, invariant: "exact-title" as const };

  const exact = resolveFrozenStrictTarget(makeCase({ ...base, expectedIds: [ARTICLE_A, ARTICLE_B, ARTICLE_C] }), corpus);
  assert.equal(exact.frozenValidated, true);

  // A frozen set missing an authoritative member fails closed.
  const narrowed = makeCase({ ...base, expectedIds: [ARTICLE_A, ARTICLE_B] });
  const narrowedTarget = resolveFrozenStrictTarget(narrowed, corpus);
  assert.equal(narrowedTarget.frozenValidated, false);
  const narrowedOutcome = evaluateRankPolicyCase({
    case: narrowed,
    observedIds: [ARTICLE_A],
    oracleIds: [ARTICLE_A],
    oracleCompared: true,
    metrics: null,
    target: narrowedTarget,
  });
  assert.equal(narrowedOutcome.status, "fail");

  // A frozen singleton is now ambiguous because a second authoritative title row exists.
  const ambiguous = resolveFrozenStrictTarget(makeCase({ ...base, expectedIds: [ARTICLE_A] }), corpus);
  assert.equal(ambiguous.frozenValidated, false);

  // A frozen set with an id the projection does not carry fails closed.
  const withExtra = resolveFrozenStrictTarget(
    makeCase({ ...base, expectedIds: [ARTICLE_A, ARTICLE_B, ARTICLE_C, "ffffffff-0000-0000-0000-00000000000f"] }),
    corpus,
  );
  assert.equal(withExtra.frozenValidated, false);
});

test("an unresolvable strict target is not_applicable, never a silent pass", () => {
  const caseDef = makeCase({ id: "ec", category: "exact-case", query: "9999-999 QPC", invariant: "exact-case" });
  const outcome = outcomeFor(caseDef, ["x"], ["x"], null);
  assert.equal(outcome.status, "not_applicable");
  assert.equal(outcome.strict, true);
});

test("a strict exact-case/exact-title failure fails the policy", () => {
  const exactCase = makeCase({ id: "ec", category: "exact-case", query: "1 BvR 2656/18", invariant: "exact-case" });
  const exactTitle = makeCase({ id: "et", category: "exact-title", query: "Klimaschutz Beschluss", invariant: "exact-title" });
  const passing = outcomeFor(exactTitle, ["doc-t"], ["doc-t"], ["doc-t"]);
  const failing = outcomeFor(exactCase, ["wrong"], ["wrong"], ["doc-c"]);
  const report = summarizeRankPolicy({ corpusHash: "h", cases: [exactCase, exactTitle], outcomes: [passing, failing] });

  assert.equal(report.state, "fail");
  assert.equal(report.strict.failed, 1);
  assert.equal(report.strict.exactCasePassed, 0);
  assert.equal(report.strict.exactTitlePassed, 1);
  assert.ok(report.blockers.some((blocker) => blocker.code === "rank_policy_strict_invariant_failed"));
});

test("exact-case outcomes are excluded from the FTS aggregate even when metrics are present", () => {
  const exactCase = makeCase({
    id: "ec",
    category: "exact-case",
    query: "1 BvR 2656/18",
    invariant: "exact-case",
    expectedIds: [ARTICLE_A],
  });
  const generic = makeCase({ id: "g", category: "multilingual-legal-term", query: "privacy", invariant: "informational" });
  const exactOutcome = evaluateRankPolicyCase({
    case: exactCase,
    observedIds: [ARTICLE_A],
    oracleIds: [ARTICLE_A],
    oracleCompared: true,
    metrics: compareRankedIds([ARTICLE_A], [ARTICLE_A], { k: 10 }),
    target: { expectedIds: [ARTICLE_A], matchCount: 1, frozen: false, frozenValidated: true },
  });
  assert.notEqual(exactOutcome.metrics, null);

  const report = summarizeRankPolicy({
    corpusHash: "h",
    cases: [exactCase, generic],
    outcomes: [exactOutcome, outcomeFor(generic, ["x"], ["y"], null)],
  });
  assert.equal(report.aggregate.compared, 1, "only the generic lexical case feeds the FTS aggregate");
  assert.equal(report.categories.find((category) => category.category === "exact-case")?.compared, 0);
  assert.equal(report.categories.find((category) => category.category === "multilingual-legal-term")?.compared, 1);
});

test("the production oracle top id must also match a strict target when the oracle window is non-empty", () => {
  const exactTitle = makeCase({ id: "et", category: "exact-title", query: "Klimaschutz Beschluss", invariant: "exact-title" });
  const mismatch = outcomeFor(exactTitle, ["doc-t"], ["other"], ["doc-t"]);
  assert.equal(mismatch.status, "fail");

  const oracleAbsent = outcomeFor(exactTitle, ["doc-t"], [], ["doc-t"], { oracleCompared: false });
  assert.equal(oracleAbsent.status, "pass");
});

test("insufficient_evidence when no independently pre-registered threshold exists", () => {
  const exactTitle = makeCase({ id: "et", category: "exact-title", query: "Klimaschutz Beschluss", invariant: "exact-title" });
  const generic = makeCase({ id: "g", category: "multilingual-legal-term", query: "privacy", invariant: "informational" });
  const outcomes = [
    outcomeFor(exactTitle, ["doc-t"], ["doc-t"], ["doc-t"]),
    outcomeFor(generic, ["x"], ["y"], null),
  ];
  const report = summarizeRankPolicy({ corpusHash: "h", cases: [exactTitle, generic], outcomes });

  assert.equal(report.state, "insufficient_evidence");
  assert.equal(report.strict.strictPassRate, 1);
  assert.equal(report.informational.hasPreRegisteredThreshold, false);
  assert.ok(report.blockers.some((blocker) => blocker.code === "fulltext_rank_threshold_unagreed"));
  assert.equal(report.thresholds, null);
});

test("a pre-registered threshold can make the policy pass or fail", () => {
  const exactTitle = makeCase({ id: "et", category: "exact-title", query: "Klimaschutz Beschluss", invariant: "exact-title" });
  const generic = makeCase({ id: "g", category: "multilingual-legal-term", query: "privacy", invariant: "informational" });
  const outcomes = [
    outcomeFor(exactTitle, ["doc-t"], ["doc-t"], ["doc-t"]),
    outcomeFor(generic, ["x"], ["y"], null),
  ];

  const passing: RankPolicyThresholds = { minOverlapAtKMacro: 0 };
  const passReport = summarizeRankPolicy({ corpusHash: "h", cases: [exactTitle, generic], outcomes, thresholds: passing });
  assert.equal(passReport.state, "pass");
  assert.equal(passReport.thresholds, passing);

  const failing: RankPolicyThresholds = { minOverlapAtKMacro: 0.5 };
  const failReport = summarizeRankPolicy({ corpusHash: "h", cases: [exactTitle, generic], outcomes, thresholds: failing });
  assert.equal(failReport.state, "fail");
});

test("no evaluable strict case is insufficient_evidence with an explicit blocker", () => {
  const generic = makeCase({ id: "g", category: "cclrag2-shape", query: "climate", invariant: "informational" });
  const report = summarizeRankPolicy({
    corpusHash: "h",
    cases: [generic],
    outcomes: [outcomeFor(generic, ["x"], ["y"], null)],
  });
  assert.equal(report.state, "insufficient_evidence");
  assert.ok(report.blockers.some((blocker) => blocker.code === "rank_policy_no_strict_cases"));
});

test("the assembled evidence report and markdown never leak a query or document text", () => {
  const exactTitle = makeCase({ id: "et", category: "exact-title", query: "SECRET QUERY SENTINEL", invariant: "exact-title" });
  const generic = makeCase({ id: "g", category: "multilingual-legal-term", query: "SECRET GENERIC SENTINEL", invariant: "informational" });
  const policy = summarizeRankPolicy({
    corpusHash: "h",
    cases: [exactTitle, generic],
    outcomes: [
      outcomeFor(exactTitle, ["doc-t"], ["doc-t"], ["doc-t"]),
      outcomeFor(generic, ["x"], ["y"], null),
    ],
  });
  const report = buildFtsParityReport({
    generatedAt: "2026-09-26T00:00:00.000Z",
    source: "fixture",
    maxArticles: 10,
    truncated: false,
    projection: { sourceRows: 2, documents: 2, productionProjectionIds: null },
    oracleAvailable: false,
    policy,
  });
  assert.equal(report.corpusHash, "h");
  assert.equal(report.errors.length, 0);
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /SECRET QUERY SENTINEL|SECRET GENERIC SENTINEL/u);
  assert.doesNotMatch(renderFtsParityMarkdown(report), /SECRET QUERY SENTINEL|SECRET GENERIC SENTINEL/u);
  assert.doesNotMatch(serialized, /https?:\/\//u);
});

function sourcePageRow(articleId: string, versionId: string): Record<string, unknown> {
  return {
    publication_id: `cccccccc-0000-0000-0000-00000000000${articleId.slice(-1)}`,
    publication_article_id: articleId,
    publication_state: "published",
    publication_version_id: versionId,
    publication_created_at: "2026-01-01T00:00:00.000Z",
    version_id: versionId,
    version_article_id: articleId,
    source_key: "de-bverfg",
    jurisdiction: "Germany",
    content_type: "decision",
    version_created_at: "2026-01-01T00:00:00.000Z",
    article_review_state: "published",
  };
}

test("the FTS source pager query is SELECT-only, cursor-stable and embedding-free", () => {
  const first = buildFtsSourcePageSql({ afterArticleId: null, limit: 100 });
  assert.match(first, /^select/u);
  assert.match(first, /from public\.article_publications_p3/u);
  assert.match(first, /order by p\.article_id/u);
  assert.doesNotMatch(first, /embedding/iu);
  assert.doesNotMatch(first, /\b(insert|update|delete|upsert|truncate|drop|alter)\b/iu);
  assert.doesNotMatch(first, /p\.article_id >/u);
  assert.equal(buildFtsSourcePageSql({ afterArticleId: null, limit: 100 }), first);

  const second = buildFtsSourcePageSql({ afterArticleId: ARTICLE_B, limit: 50 });
  assert.match(second, /p\.article_id > '22222222-0000-0000-0000-000000000002'/u);
  assert.doesNotMatch(second, /embedding/iu);
  assert.notEqual(second, first);
});

test("the FTS source pager rejects an out-of-range page size or empty cursor", () => {
  assert.throws(() => buildFtsSourcePageSql({ afterArticleId: null, limit: 10 }), /between 50 and 100/u);
  assert.throws(() => buildFtsSourcePageSql({ afterArticleId: null, limit: 101 }), /between 50 and 100/u);
  assert.throws(() => buildFtsSourcePageSql({ afterArticleId: "", limit: 100 }), /cursor/u);
});

test("FTS source page combination is deterministic, order-independent and de-duplicated", () => {
  const pageA = parseFtsSourceRows([sourcePageRow(ARTICLE_A, VERSION_A)]);
  const pageB = parseFtsSourceRows([sourcePageRow(ARTICLE_B, VERSION_B)]);
  const forward = combineFtsSourcePages([pageA, pageB]);
  const reversed = combineFtsSourcePages([pageB, pageA]);
  assert.deepEqual(forward, reversed);
  assert.deepEqual(forward.articleIds, [ARTICLE_A, ARTICLE_B]);
  assert.equal(combineFtsSourcePages([pageA, pageA]).publications.length, 1);

  const restricted = restrictToProductionIds(forward, new Set([ARTICLE_B]));
  assert.deepEqual(restricted.articleIds, [ARTICLE_B]);
  assert.equal(restricted.publications.length, 1);
});

test("projection scope validation requires an exact production/local id set", () => {
  const production = new Set([ARTICLE_A, ARTICLE_B]);
  const exact = evaluateFtsProjectionScope({
    productionProjectionIds: production,
    localArticleIds: new Set([ARTICLE_A, ARTICLE_B]),
    sourceRowsFetched: 2,
  });
  assert.deepEqual(exact, {
    productionProjectionIds: 2,
    sourceRowsFetched: 2,
    localDocuments: 2,
    missingIds: 0,
    extraIds: 0,
    scopeValid: true,
  });
  assert.doesNotThrow(() => assertFullProjectionScope(exact));

  const partial = evaluateFtsProjectionScope({
    productionProjectionIds: production,
    localArticleIds: new Set([ARTICLE_A]),
    sourceRowsFetched: 2,
  });
  assert.equal(partial.missingIds, 1);
  assert.equal(partial.scopeValid, false);
  assert.throws(() => assertFullProjectionScope(partial), /scope-mismatch/u);

  const extra = evaluateFtsProjectionScope({
    productionProjectionIds: new Set([ARTICLE_A]),
    localArticleIds: new Set([ARTICLE_A, ARTICLE_B]),
    sourceRowsFetched: 2,
  });
  assert.equal(extra.extraIds, 1);
  assert.equal(extra.scopeValid, false);
  assert.throws(() => assertFullProjectionScope(extra), /scope-mismatch/u);
});

test("a production window below the projection count fails with scope-too-small", () => {
  assert.doesNotThrow(() => assertProductionScopeLargeEnough(3, 3));
  assert.doesNotThrow(() => assertProductionScopeLargeEnough(3, 5));
  assert.throws(() => assertProductionScopeLargeEnough(3, 2), /scope-too-small/u);
  assert.throws(() => assertProductionScopeLargeEnough(3, 0), /positive integer/u);
});

test("the report carries a content-free source scope summary and never leaks ids", () => {
  const policy = summarizeRankPolicy({
    corpusHash: "h",
    cases: [makeCase({ id: "g", category: "cclrag2-shape", query: "climate", invariant: "informational" })],
    outcomes: [
      outcomeFor(
        makeCase({ id: "g", category: "cclrag2-shape", query: "climate", invariant: "informational" }),
        ["x"],
        ["y"],
        null,
      ),
    ],
  });
  const report = buildFtsParityReport({
    generatedAt: "2026-09-26T00:00:00.000Z",
    source: "supabase",
    maxArticles: 2,
    truncated: false,
    projection: { sourceRows: 2, documents: 2, productionProjectionIds: 2 },
    sourceScope: {
      productionProjectionIds: 2,
      sourceRowsFetched: 2,
      localDocuments: 2,
      missingIds: 0,
      extraIds: 0,
      scopeValid: true,
    },
    oracleAvailable: true,
    policy,
  });
  const serialized = JSON.stringify(report);
  const markdown = renderFtsParityMarkdown(report);
  assert.doesNotMatch(serialized, /11111111-0000-0000-0000-000000000001|22222222-0000-0000-0000-000000000002/iu);
  assert.doesNotMatch(markdown, /11111111-0000-0000-0000-000000000001|22222222-0000-0000-0000-000000000002/iu);
  assert.match(markdown, /scopeValid=true/u);
  assert.equal(report.sourceScope?.missingIds, 0);
});

test("the FTS parity harness is read-only, full-scope paged and wires the expected scripts", () => {
  assert.match(harnessSource, /--apply is not available/u);
  assert.match(harnessSource, /read-only by construction/u);
  assert.match(harnessSource, /public_fulltext_ranked_ids_v1/u);
  assert.match(harnessSource, /createSupabaseLinkedQueryRunner/u);
  assert.match(harnessSource, /readFtsSourcePager/u);
  assert.match(harnessSource, /assertFullProjectionScope/u);
  assert.match(harnessSource, /resolveFrozenStrictTarget/u);
  assert.doesNotMatch(harnessSource, /createSupabaseCanaryReader/u);
  assert.match(harnessSource, /--dry-run/u);
  assert.doesNotMatch(harnessSource, /\.insert\(|\.update\(|\.delete\(|d1 execute/u);
  assert.doesNotMatch(harnessSource, /fetch\(/u);
  assert.equal(packageJson.scripts["d1:fts-parity"], "tsx scripts/d1-fts-parity.ts");
  assert.equal(packageJson.scripts["test:search-rank-policy"], "tsx --test tests/search-rank-policy.test.ts");
});

function harnessFunctionBody(name: string): string {
  const start = harnessSource.indexOf(`function ${name}`);
  assert.ok(start >= 0, `${name} must be present in the FTS parity harness`);
  const next = harnessSource.indexOf("\nfunction ", start + 1);
  return harnessSource.slice(start, next === -1 ? harnessSource.length : next);
}

test("the FTS parity harness routes exact-case through the ranked-page authority, not the fulltext RPC", () => {
  const exactCaseOracle = harnessFunctionBody("buildExactCaseOracleSql");
  const genericOracle = harnessFunctionBody("buildOracleSql");
  assert.match(exactCaseOracle, /worldcons_ranked_search_page_v1/u);
  assert.doesNotMatch(exactCaseOracle, /public_fulltext_ranked_ids_v1/u);
  assert.match(genericOracle, /public_fulltext_ranked_ids_v1/u);
  assert.doesNotMatch(genericOracle, /worldcons_ranked_search_page_v1/u);

  // Local exact-case retrieval uses the M7.3 ranked reader exact-case branch,
  // and the exact-case oracle dispatch never falls back to the fulltext RPC.
  assert.match(harnessSource, /runRankedSearchPage/u);
  assert.match(harnessSource, /caseDef\.invariant === "exact-case"/u);
  assert.match(harnessSource, /caseDef\.invariant === "exact-case" \? readExactCaseOracle : readOracle/u);

  // Exact-case is not an FTS5 ranking case: it must carry no compareRankedIds metrics.
  assert.match(harnessSource, /caseDef\.invariant !== "exact-case" && oracleCompared/u);
});

test("the FTS source pager is operator-only, selector-only and never writes", () => {
  assert.match(pagerSource, /parseSupabaseLinkedRows/u);
  assert.match(pagerSource, /renderSqlLiteral/u);
  assert.match(pagerSource, /PRODUCTION_PROJECTION_CEILING/u);
  assert.doesNotMatch(pagerSource, /\.insert\(|\.update\(|\.delete\(|d1 execute|\bfetch\(/u);
});

test("the rank-policy library is runtime-neutral with no node builtin or network code", () => {
  const dir = path.join(rootDir, "lib/cloudflare/search-rank-policy");
  const sources = fs.readdirSync(dir).filter((name) => name.endsWith(".ts"));
  assert.ok(sources.length >= 5, "the runtime-neutral module must expose its files");
  for (const file of sources) {
    const source = fs.readFileSync(path.join(dir, file), "utf8");
    assert.doesNotMatch(source, /from ["']node:/u, `${file} must not import a Node builtin`);
    assert.doesNotMatch(source, /\bfetch\(/u, `${file} must not perform network I/O`);
  }
});
