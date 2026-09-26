import { canonicalJson } from "@/lib/backfill/canonical-json";
import { shadowDigest } from "@/lib/cloudflare/d1/shadow/digest";
import { isStrictRankCorpusCategory } from "./corpus";
import {
  RANK_CORPUS_CATEGORIES,
  RANK_CORPUS_RANGES,
  type RankCorpusCase,
  type RankCorpusCategory,
  type RankCorpusFilters,
  type RankCorpusInvariant,
} from "./types";

/**
 * M7.8-B additive v5 HOLDOUT contract (runtime-neutral).
 *
 * This module is deliberately free of `node:*` imports and performs no remote
 * read or write. It defines an additive, content-free HOLDOUT candidate pool that
 * is DISJOINT from the active v4 manifest by normalized
 * `(category, query, filters)` and a deterministic selection with a stable v5
 * hash. It NEVER touches, rewrites or re-hashes the active v4 corpus; the v4
 * `corpus.manifest.json` / `corpusHash ed18add749fe4a23` remain byte-for-byte
 * unchanged.
 *
 * The holdout exists only to keep a future acceptance decision honest: it lets a
 * human sign a policy against candidate coverage without re-using any v4 case
 * whose rank outcome was already observed. It selects NOTHING from a v4 rank
 * outcome: the candidate pool is authored from public API/integration query
 * SHAPES that were present in coverage but NOT selected in v4, plus
 * metadata-only deterministic source rules for strict targets.
 */

/** The additive holdout contract version. */
export const RANK_POLICY_HOLDOUT_VERSION = 5 as const;

/**
 * The frozen v4 corpus hash this holdout must stay disjoint from. If the active
 * v4 manifest ever changes, the v5 holdout is stale and must be re-authored.
 */
export const RANK_POLICY_V4_HASH = "ed18add749fe4a23";

const ALL_FILTERS: RankCorpusFilters = {
  source: null,
  jurisdiction: null,
  contentType: null,
  language: null,
  range: "latest",
};

function filters(overrides: Partial<RankCorpusFilters> = {}): RankCorpusFilters {
  return { ...ALL_FILTERS, ...overrides };
}

type HoldoutCaseOverrides = Partial<Omit<RankCorpusCase, "filters">> & { filters?: Partial<RankCorpusFilters> };

function kase(
  id: string,
  category: RankCorpusCategory,
  query: string,
  invariant: RankCorpusInvariant,
  overrides: HoldoutCaseOverrides = {},
): RankCorpusCase {
  const built: RankCorpusCase = {
    id,
    category,
    query,
    filters: filters(overrides.filters),
    limit: overrides.limit ?? 10,
    k: overrides.k ?? 10,
    invariant,
  };
  if (overrides.expectedIds !== undefined) built.expectedIds = overrides.expectedIds;
  return built;
}

/** Sorted, de-duplicated frozen target set (content-free ids only). */
function targetSet(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/**
 * The normalized disjointness key. Two cases collide iff their category, exact
 * query and every filter field are identical. This is the SAME key the v4
 * selection de-duplicates by (`selectRepresentativeCorpus`), so a v5 candidate
 * carrying a v4 case's key is provably non-disjoint.
 */
export function holdoutCaseKey(kase: RankCorpusCase): string {
  return canonicalJson({
    category: kase.category,
    query: kase.query,
    filters: kase.filters,
  });
}

/**
 * The deterministic v5 strict HOLDOUT anchors. They are derived by a
 * metadata-only source rule that NEVER reads a v4 (or any) rank outcome and that
 * is disjoint from v4 by the SAME normalized `(category, query, filters)` key
 * the corpus uses:
 *
 * - the query text and the frozen `expectedIds` are the authoritative metadata
 *   values (the display case number / original title and the complete
 *   authoritative exact-match id set); and
 * - the v5 strict case carries an explicit `source` FILTER, whereas the matching
 *   v4 strict case had `source: null`, so the normalized key differs.
 *
 * This makes the v5 holdout a distinct filter-scoped query SHAPE over the same
 * authoritative metadata, never a re-run of a v4 case whose rank outcome was
 * already observed. The `source` filter is itself authoritative metadata. The
 * anchor set below is frozen and MUST NOT be edited to match an observed rank
 * result.
 */
export const RANK_HOLDOUT_STRICT_ANCHORS = [
  {
    sourceKey: "de-bverfg",
    articleId: "00083deb-5bc9-4b28-bbcd-68076cd05514",
    displayCase: "2 BvL 21/14",
    caseIds: ["00083deb-5bc9-4b28-bbcd-68076cd05514"],
    originalTitle: "Beschluss vom 21. Oktober 2025",
    titleIds: [
      "00083deb-5bc9-4b28-bbcd-68076cd05514",
      "5dce7909-0bdb-4739-acb2-8106abe45c0b",
      "c27578dc-af58-4c29-9511-d48bf4327682",
    ],
  },
  {
    sourceKey: "es-tribunal-constitucional",
    articleId: "00cc18bd-ace3-4b5e-aabb-f3aacbd6d077",
    displayCase: "57/2025",
    caseIds: [
      "00cc18bd-ace3-4b5e-aabb-f3aacbd6d077",
      "e6e97786-ad78-46b1-8549-7a69788ea178",
    ],
    originalTitle: "AUTO 57/2025, de 27 de mayo de 2025",
    titleIds: ["00cc18bd-ace3-4b5e-aabb-f3aacbd6d077"],
  },
  {
    sourceKey: "fr-conseil-constitutionnel",
    articleId: "0018a822-df15-4526-abd8-6c22e6ba7988",
    displayCase: "2024-6412 AN",
    caseIds: ["0018a822-df15-4526-abd8-6c22e6ba7988"],
    originalTitle: "Décision n° 2024-6412 AN du 6 juin 2025",
    titleIds: ["0018a822-df15-4526-abd8-6c22e6ba7988"],
  },
  {
    sourceKey: "us-scotus",
    articleId: "0346769f-97d0-48e2-b2e2-3a371e7d2eee",
    displayCase: "24-304",
    caseIds: ["0346769f-97d0-48e2-b2e2-3a371e7d2eee"],
    originalTitle: "Laboratory Corp. of America Holdings v. Davis",
    titleIds: ["0346769f-97d0-48e2-b2e2-3a371e7d2eee"],
  },
] as const;

/**
 * The authored v5 HOLDOUT candidate pool. It is large enough that the
 * deterministic selection is a real reduction, and every candidate is disjoint
 * from v4 by normalized `(category, query, filters)`. Exact-case/exact-title
 * candidates reuse public API/contract query SHAPES (Korean, Spanish, German,
 * French, English, case-number, crag/meta shapes) that were present in coverage
 * but NOT selected in v4.
 */
export const RANK_HOLDOUT_CANDIDATES: readonly RankCorpusCase[] = [
  // exact-case: a metadata-only derived anchor, disjoint by an explicit source filter.
  ...RANK_HOLDOUT_STRICT_ANCHORS.map((anchor) =>
    kase(`holdout-exact-case-${anchor.sourceKey}`, "exact-case", anchor.displayCase, "exact-case", {
      filters: { source: anchor.sourceKey },
      expectedIds: targetSet(anchor.caseIds),
    }),
  ),

  // exact-title: a metadata-only derived anchor, disjoint by an explicit source filter.
  ...RANK_HOLDOUT_STRICT_ANCHORS.map((anchor) =>
    kase(`holdout-exact-title-${anchor.sourceKey}`, "exact-title", anchor.originalTitle, "exact-title", {
      filters: { source: anchor.sourceKey },
      expectedIds: targetSet(anchor.titleIds),
    }),
  ),

  // Generic multilingual legal terms not selected in v4.
  kase("holdout-multilingual-korean-equality", "multilingual-legal-term", "평등", "informational", { limit: 10 }),
  kase("holdout-multilingual-spanish-libertad", "multilingual-legal-term", "libertad de expresión", "informational", { limit: 10 }),
  kase("holdout-multilingual-german-menschenwuerde", "multilingual-legal-term", "Menschenwürde", "informational", { limit: 10 }),
  kase("holdout-multilingual-french-liberte", "multilingual-legal-term", "liberté d'expression", "informational", { limit: 10 }),
  kase("holdout-multilingual-english-standing", "multilingual-legal-term", "standing", "informational", { limit: 10 }),

  // Case-number-like identifiers not selected in v4.
  kase("holdout-case-number-bverfg", "case-number-identifier", "2 BvR 2415/15", "informational", { limit: 10 }),
  kase("holdout-case-number-france", "case-number-identifier", "2026-1234 QPC", "informational", { limit: 10 }),
  kase("holdout-case-number-spain", "case-number-identifier", "99-2024", "informational", { limit: 10 }),
  kase("holdout-case-number-us", "case-number-identifier", "24-999", "informational", { limit: 10 }),

  // Jurisdictions/sources: filter-scoped generic legal term (disjoint filters).
  kase("holdout-jurisdiction-us-scotus", "jurisdiction-source", "amendment", "informational", {
    filters: { source: "us-scotus", jurisdiction: "United States" },
    limit: 10,
  }),
  kase("holdout-jurisdiction-de-bverfg", "jurisdiction-source", "grundrechte", "informational", {
    filters: { source: "de-bverfg", jurisdiction: "Germany" },
    limit: 10,
  }),
  kase("holdout-jurisdiction-fr-conseil", "jurisdiction-source", "liberté", "informational", {
    filters: { source: "fr-conseil-constitutionnel", jurisdiction: "France" },
    limit: 10,
  }),
  kase("holdout-jurisdiction-es-tribunal", "jurisdiction-source", "derechos fundamentales", "informational", {
    filters: { source: "es-tribunal-constitucional", jurisdiction: "Spain" },
    limit: 10,
  }),

  // cclrag2 public API query shape (test/contract queries not selected in v4).
  kase("holdout-cclrag2-korean-climate", "cclrag2-shape", "기후변화 헌법소원", "informational", { limit: 10 }),
  kase("holdout-cclrag2-neubauer", "cclrag2-shape", "Neubauer", "informational", { limit: 10 }),
  kase("holdout-cclrag2-qpc", "cclrag2-shape", "2026-456 QPC", "informational", { limit: 10 }),

  // cclmetasearch public API query shape (test/contract queries not selected in v4).
  kase("holdout-cclmetasearch-expression", "cclmetasearch-shape", "표현의 자유 침해", "informational", { limit: 10 }),
  kase("holdout-cclmetasearch-standing", "cclmetasearch-shape", "standing", "informational", { limit: 10 }),
];

/** Default number of selected informational holdout cases per category. */
export const RANK_HOLDOUT_DEFAULT_PER_CATEGORY = 2;

/** Strict holdout categories select every frozen holdout anchor. */
export const RANK_HOLDOUT_STRICT_PER_CATEGORY = RANK_HOLDOUT_STRICT_ANCHORS.length;

function selectionCountFor(category: RankCorpusCategory, perCategory: number): number {
  return isStrictRankCorpusCategory(category) ? RANK_HOLDOUT_STRICT_PER_CATEGORY : perCategory;
}

function compareCaseIds(left: RankCorpusCase, right: RankCorpusCase): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/**
 * Validates one holdout candidate's bounded shape. It delegates the full shape
 * rules to the shared v4 validator (imported lazily to avoid a cycle) by
 * reproducing the invariant/limit/range/expectedIds contract here; the shared
 * `assertRankCorpusCase` is the canonical implementation and is re-exported by
 * the corpus module.
 */
export function assertHoldoutCase(kase: RankCorpusCase): void {
  if (kase.query.trim().length === 0) throw new Error(`rank holdout case ${kase.id} has an empty query`);
  if (!(RANK_CORPUS_CATEGORIES as readonly string[]).includes(kase.category)) {
    throw new Error(`rank holdout case ${kase.id} has an unknown category`);
  }
  if (!Number.isInteger(kase.limit) || kase.limit < 1 || kase.limit > 100) {
    throw new Error(`rank holdout case ${kase.id} has an out-of-range limit`);
  }
  if (!Number.isInteger(kase.k) || kase.k < 1) {
    throw new Error(`rank holdout case ${kase.id} has an invalid overlap k`);
  }
  if (!(RANK_CORPUS_RANGES as readonly string[]).includes(kase.filters.range)) {
    throw new Error(`rank holdout case ${kase.id} has an invalid range`);
  }
  const expectedInvariant: RankCorpusInvariant =
    kase.category === "exact-case" ? "exact-case" : kase.category === "exact-title" ? "exact-title" : "informational";
  if (kase.invariant !== expectedInvariant) {
    throw new Error(`rank holdout case ${kase.id} category ${kase.category} must carry invariant ${expectedInvariant}`);
  }
  const strict = isStrictRankCorpusCategory(kase.category);
  const expectedIds = kase.expectedIds;
  const hasExpectedIds =
    Array.isArray(expectedIds) &&
    expectedIds.length > 0 &&
    expectedIds.every((id) => typeof id === "string" && id.length > 0);
  if (strict && !hasExpectedIds) {
    throw new Error(`rank holdout case ${kase.id} strict case must carry a non-empty frozen expectedIds target set`);
  }
  if (!strict && expectedIds !== undefined && expectedIds !== null) {
    throw new Error(`rank holdout case ${kase.id} informational case must not carry an expectedIds target set`);
  }
}

/**
 * Deterministically selects the holdout corpus: iterate categories in the
 * authored order, stable-sort candidates by id within a category, de-duplicate
 * by canonical `(category, query, filters)`, and take the first `perCategory`.
 * Selection reads no parity outcome and no wall clock.
 */
export function selectHoldoutCorpus(
  candidates: readonly RankCorpusCase[] = RANK_HOLDOUT_CANDIDATES,
  options: { perCategory?: number } = {},
): RankCorpusCase[] {
  const perCategory = options.perCategory ?? RANK_HOLDOUT_DEFAULT_PER_CATEGORY;
  if (!Number.isInteger(perCategory) || perCategory <= 0) {
    throw new Error("perCategory must be a positive integer");
  }
  const selected: RankCorpusCase[] = [];
  for (const category of RANK_CORPUS_CATEGORIES) {
    const perCategoryTarget = selectionCountFor(category, perCategory);
    const scoped = candidates.filter((candidate) => candidate.category === category).sort(compareCaseIds);
    const seen = new Set<string>();
    let taken = 0;
    for (const candidate of scoped) {
      if (taken >= perCategoryTarget) break;
      assertHoldoutCase(candidate);
      const key = holdoutCaseKey(candidate);
      if (seen.has(key)) continue;
      seen.add(key);
      selected.push(candidate);
      taken += 1;
    }
  }
  return selected;
}

/**
 * Stable, order-independent digest of a holdout selection. The domain string is
 * v5-scoped so the holdout hash can never collide with a v4 corpus hash.
 */
export function rankHoldoutHash(cases: readonly RankCorpusCase[]): string {
  const sorted = [...cases].sort(compareCaseIds);
  return shadowDigest(`search-rank-policy-holdout/v${RANK_POLICY_HOLDOUT_VERSION}\n${canonicalJson(sorted)}`);
}

/**
 * The frozen v5 holdout manifest shape. It is DECLARED here so the JSON artifact
 * and the runtime contract stay in lockstep; unlike v4 it is not selected from
 * any observed outcome.
 */
export interface RankHoldoutManifest {
  version: typeof RANK_POLICY_HOLDOUT_VERSION;
  /** The frozen v4 corpus hash this holdout is disjoint from. */
  disjointFromCorpusHash: string;
  /** Stable, order-independent digest of the canonical selected holdout. */
  holdoutHash: string;
  cases: RankCorpusCase[];
}

/** Builds the frozen holdout manifest (selected cases + their stable hash). */
export function buildRankHoldoutManifest(cases?: readonly RankCorpusCase[]): RankHoldoutManifest {
  const selected = cases ? [...cases] : selectHoldoutCorpus();
  return {
    version: RANK_POLICY_HOLDOUT_VERSION,
    disjointFromCorpusHash: RANK_POLICY_V4_HASH,
    holdoutHash: rankHoldoutHash(selected),
    cases: selected,
  };
}

/**
 * Asserts that a holdout selection is DISJOINT from a reference corpus by
 * normalized `(category, query, filters)`. It throws with the colliding case ids
 * so a drift is impossible to miss. This is the core governance invariant: the
 * holdout must never re-use a v4 case whose rank outcome was already read.
 */
export function assertHoldoutDisjoint(
  holdout: readonly RankCorpusCase[],
  reference: readonly RankCorpusCase[],
): void {
  const referenceKeys = new Map<string, string>();
  for (const caseDef of reference) referenceKeys.set(holdoutCaseKey(caseDef), caseDef.id);
  const collisions: string[] = [];
  for (const caseDef of holdout) {
    const collisionId = referenceKeys.get(holdoutCaseKey(caseDef));
    if (collisionId !== undefined) collisions.push(`${caseDef.id}~${collisionId}`);
  }
  if (collisions.length > 0) {
    throw new Error(`holdout-not-disjoint: ${collisions.join(", ")}`);
  }
}
