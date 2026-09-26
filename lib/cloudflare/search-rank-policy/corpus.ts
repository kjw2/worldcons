import { canonicalJson } from "@/lib/backfill/canonical-json";
import { shadowDigest } from "@/lib/cloudflare/d1/shadow/digest";
import {
  RANK_CORPUS_CATEGORIES,
  RANK_POLICY_VERSION,
  type RankCorpusCase,
  type RankCorpusCategory,
  type RankCorpusFilters,
  type RankCorpusInvariant,
  type RankCorpusManifest,
  type RankCorpusRange,
} from "./types";

/**
 * M7.7-B frozen representative corpus selection (runtime-neutral).
 *
 * The candidate pool below is authored ONLY from existing public
 * integration/test query shapes (the `cclrag2`/`cclmetasearch` contract tests,
 * the M7.2/M7.3 FTS/ranked fixtures, the exact-case reference parser tests) and
 * from broad multilingual/legal coverage. It was frozen BEFORE any new
 * D1-vs-Postgres fulltext parity outcome was read, and it MUST NOT be edited to
 * match an observed result.
 *
 * Every case is content-free: a query shape, bounded filters, a category, a
 * result `limit` and an overlap `k`. It never carries document text, a summary,
 * a URL or a vector.
 */

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

type RankCorpusCaseOverrides = Partial<Omit<RankCorpusCase, "filters">> & { filters?: Partial<RankCorpusFilters> };

function kase(
  id: string,
  category: RankCorpusCategory,
  query: string,
  invariant: RankCorpusInvariant,
  overrides: RankCorpusCaseOverrides = {},
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
 * The M7.7-B v4 strict anchors, chosen by a deterministic source-only rule that
 * reads authoritative PUBLIC METADATA ONLY (never a D1/Postgres rank outcome):
 * for each supported `source_key`, take the lowest article id in
 * `public_article_projection_p3` having a non-null `case_key` and a recognized
 * display case-number metadata field. The four `articleId`s below are the frozen
 * result of that rule from the read-only metadata snapshot; `displayCase` is the
 * authoritative display case number and `originalTitle` the authoritative
 * original title for the same article.
 *
 * `caseIds` and `titleIds` are the COMPLETE authoritative exact-match target
 * sets for the already-frozen queries, obtained from public metadata BEFORE any
 * v4 parity outcome was read. A metadata-only query proves every public
 * projection id carrying the exact case key or the exact original title. The
 * Spain case key `572025` is authoritative for BOTH an AUTO and a SENTENCIA, so
 * its `caseIds` set has two members; every other exact-case set is a singleton.
 * Spain/France/US titles are unique (one id). The BVerfG title
 * `Beschluss vom 21. Oktober 2025` is authoritative but NOT unique, so its set
 * has three members. The exact invariants therefore require the top result to
 * belong to the frozen set rather than arbitrarily requiring one lowest id.
 * These frozen sets MUST NOT be edited to match an observed rank result.
 */
export const RANK_STRICT_ANCHORS = [
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

function strictCaseId(kind: "case" | "title", sourceKey: string): string {
  return `exact-${kind}-${sourceKey}`;
}

/**
 * The authored candidate pool. The 8 strict cases are exactly the frozen v4
 * anchors (all selected); the informational pool is larger than the 10 selected
 * cases, so informational selection stays a real deterministic reduction.
 */
export const RANK_CORPUS_CANDIDATES: readonly RankCorpusCase[] = [
  // exact-case: authoritative display case numbers for the four source anchors.
  ...RANK_STRICT_ANCHORS.map((anchor) =>
    kase(strictCaseId("case", anchor.sourceKey), "exact-case", anchor.displayCase, "exact-case", {
      expectedIds: targetSet(anchor.caseIds),
    }),
  ),

  // exact-title: the authoritative original titles for the same four anchors.
  ...RANK_STRICT_ANCHORS.map((anchor) =>
    kase(strictCaseId("title", anchor.sourceKey), "exact-title", anchor.originalTitle, "exact-title", {
      expectedIds: targetSet(anchor.titleIds),
    }),
  ),

  // Generic multilingual legal terms (no pre-registered threshold exists).
  kase("multilingual-korean-constitution", "multilingual-legal-term", "헌법", "informational", { limit: 10 }),
  kase("multilingual-korean-free-expression", "multilingual-legal-term", "표현의 자유", "informational", { limit: 10 }),
  kase("multilingual-spanish-amparo", "multilingual-legal-term", "amparo", "informational", { limit: 10 }),
  kase("multilingual-german-verfassung", "multilingual-legal-term", "Verfassungsbeschwerde", "informational", { limit: 10 }),
  kase("multilingual-french-droit", "multilingual-legal-term", "droit constitutionnel", "informational", { limit: 10 }),
  kase("multilingual-english-privacy", "multilingual-legal-term", "privacy", "informational", { limit: 10 }),

  // Case-number-like identifiers (exact token shapes, still generic for ranking).
  kase("case-number-bverfg", "case-number-identifier", "1 BvR 2656/18", "informational", { limit: 10 }),
  kase("case-number-france", "case-number-identifier", "2026-1194 QPC", "informational", { limit: 10 }),
  kase("case-number-spain", "case-number-identifier", "123-2025", "informational", { limit: 10 }),
  kase("case-number-us", "case-number-identifier", "24-781", "informational", { limit: 10 }),

  // Jurisdictions/sources: filter-scoped generic legal term.
  kase("jurisdiction-us-scotus", "jurisdiction-source", "constitution", "informational", {
    filters: { source: "us-scotus", jurisdiction: "United States" },
    limit: 10,
  }),
  kase("jurisdiction-de-bverfg", "jurisdiction-source", "constitution", "informational", {
    filters: { source: "de-bverfg", jurisdiction: "Germany" },
    limit: 10,
  }),
  kase("jurisdiction-fr-conseil", "jurisdiction-source", "constitution", "informational", {
    filters: { source: "fr-conseil-constitutionnel", jurisdiction: "France" },
    limit: 10,
  }),
  kase("jurisdiction-es-tribunal", "jurisdiction-source", "constitution", "informational", {
    filters: { source: "es-tribunal-constitucional", jurisdiction: "Spain" },
    limit: 10,
  }),

  // cclrag2 public API query shape (test/contract queries).
  kase(
    "cclrag2-neubauer-comparison",
    "cclrag2-shape",
    "한국 헌재 기후결정과 독일 연방헌법재판소 Neubauer 기후결정을 비교",
    "informational",
    { limit: 10 },
  ),
  kase("cclrag2-qpc", "cclrag2-shape", "2026-912 QPC", "informational", { limit: 10 }),
  kase("cclrag2-climate-rights", "cclrag2-shape", "climate change constitutional rights", "informational", { limit: 10 }),

  // cclmetasearch public API query shape (test/contract queries).
  kase("cclmetasearch-free-expression", "cclmetasearch-shape", "표현의 자유", "informational", { limit: 10 }),
  kase("cclmetasearch-privacy", "cclmetasearch-shape", "privacy", "informational", { limit: 10 }),
  kase("cclmetasearch-constitution", "cclmetasearch-shape", "constitution", "informational", { limit: 10 }),
];

/** Default number of selected informational cases per category. */
export const RANK_CORPUS_DEFAULT_PER_CATEGORY = 2;

/** The strict categories select every frozen anchor (one per supported source). */
export const RANK_CORPUS_STRICT_PER_CATEGORY = 4;

/** True for the exact strict-invariant categories. */
export function isStrictRankCorpusCategory(category: RankCorpusCategory): boolean {
  return category === "exact-case" || category === "exact-title";
}

function selectionCountFor(category: RankCorpusCategory, perCategory: number): number {
  return isStrictRankCorpusCategory(category) ? RANK_CORPUS_STRICT_PER_CATEGORY : perCategory;
}

const VALID_RANGES: readonly RankCorpusRange[] = ["latest", "today", "week", "month"];

function stableCaseKey(kase: RankCorpusCase): string {
  return canonicalJson({
    category: kase.category,
    query: kase.query,
    filters: kase.filters,
  });
}

function compareCaseIds(left: RankCorpusCase, right: RankCorpusCase): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/**
 * Validates one candidate's bounded shape and category/invariant consistency.
 * The strict categories must carry their matching invariant; every other
 * category must be informational.
 */
export function assertRankCorpusCase(kase: RankCorpusCase): void {
  if (kase.query.trim().length === 0) throw new Error(`rank corpus case ${kase.id} has an empty query`);
  if (!(RANK_CORPUS_CATEGORIES as readonly string[]).includes(kase.category)) {
    throw new Error(`rank corpus case ${kase.id} has an unknown category`);
  }
  if (!Number.isInteger(kase.limit) || kase.limit < 1 || kase.limit > 100) {
    throw new Error(`rank corpus case ${kase.id} has an out-of-range limit`);
  }
  if (!Number.isInteger(kase.k) || kase.k < 1) {
    throw new Error(`rank corpus case ${kase.id} has an invalid overlap k`);
  }
  if (!VALID_RANGES.includes(kase.filters.range)) {
    throw new Error(`rank corpus case ${kase.id} has an invalid range`);
  }
  const expectedInvariant: RankCorpusInvariant =
    kase.category === "exact-case" ? "exact-case" : kase.category === "exact-title" ? "exact-title" : "informational";
  if (kase.invariant !== expectedInvariant) {
    throw new Error(
      `rank corpus case ${kase.id} category ${kase.category} must carry invariant ${expectedInvariant}`,
    );
  }
  const strict = isStrictRankCorpusCategory(kase.category);
  const expectedIds = kase.expectedIds;
  const hasExpectedIds =
    Array.isArray(expectedIds) && expectedIds.length > 0 && expectedIds.every((id) => typeof id === "string" && id.length > 0);
  if (strict && !hasExpectedIds) {
    throw new Error(`rank corpus case ${kase.id} strict case must carry a non-empty frozen expectedIds target set`);
  }
  if (!strict && expectedIds !== undefined && expectedIds !== null) {
    throw new Error(`rank corpus case ${kase.id} informational case must not carry an expectedIds target set`);
  }
  if (strict && hasExpectedIds) {
    const sorted = [...(expectedIds as string[])].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    if (new Set(sorted).size !== sorted.length) {
      throw new Error(`rank corpus case ${kase.id} expectedIds target set must be unique`);
    }
    if (sorted.join("\u0000") !== (expectedIds as string[]).join("\u0000")) {
      throw new Error(`rank corpus case ${kase.id} expectedIds target set must be sorted`);
    }
  }
}

/**
 * Deterministically selects the representative corpus:
 *
 * - iterate the categories in their authored order;
 * - within a category, stable-sort the candidates by case id and de-duplicate by
 *   canonical `(category, query, filters)`;
 * - take the first `perCategory` cases.
 *
 * Selection reads no parity outcome and no wall clock; the same candidate pool
 * always yields the same ordered selection.
 */
export function selectRepresentativeCorpus(
  candidates: readonly RankCorpusCase[] = RANK_CORPUS_CANDIDATES,
  options: { perCategory?: number } = {},
): RankCorpusCase[] {
  const perCategory = options.perCategory ?? RANK_CORPUS_DEFAULT_PER_CATEGORY;
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
      assertRankCorpusCase(candidate);
      const key = stableCaseKey(candidate);
      if (seen.has(key)) continue;
      seen.add(key);
      selected.push(candidate);
      taken += 1;
    }
  }
  return selected;
}

/**
 * Stable, order-independent digest of a corpus selection. It hashes only the
 * canonical content-free case fields.
 */
export function rankCorpusHash(cases: readonly RankCorpusCase[]): string {
  const sorted = [...cases].sort(compareCaseIds);
  return shadowDigest(`search-rank-policy-corpus/v${RANK_POLICY_VERSION}\n${canonicalJson(sorted)}`);
}

/** Builds the frozen manifest (selected cases + their stable hash). */
export function buildRankCorpusManifest(cases?: readonly RankCorpusCase[]): RankCorpusManifest {
  const selected = cases ? [...cases] : selectRepresentativeCorpus();
  return { version: RANK_POLICY_VERSION, corpusHash: rankCorpusHash(selected), cases: selected };
}
