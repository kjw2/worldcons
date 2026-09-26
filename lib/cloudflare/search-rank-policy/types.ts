import type { RankedIdParityReport } from "@/lib/cloudflare/search-fts";

/**
 * M7.7-B runtime-neutral fulltext rank-policy types.
 *
 * This module is deliberately free of `node:*` imports and performs no remote
 * read or write. It defines the frozen representative corpus contract, the
 * aggregate evidence metrics and the policy state machine for the
 * FTS5-bm25-vs-Postgres-`ts_rank_cd` ordering decision.
 *
 * The policy never invents a generic lexical numeric threshold. Exact-case and
 * exact-title are exact-match invariants that must hold for 100% of the cases
 * that can be evaluated; every generic lexical category stays
 * `insufficient_evidence` until a threshold is pre-registered from outside this
 * module (see `RankPolicyThresholds`).
 */

/**
 * The frozen corpus/policy contract version.
 *
 * v1 is archived as `corpus.manifest.v1-invalid.json`: its strict fixture-shaped
 * candidates had zero exact matches in the current production projection and its
 * evidence compared a 1258-row production id window against only the first 100
 * local source rows, so it was neither like-for-like nor a valid strict corpus.
 * v2 replaces only the strict cases (8 authoritative-metadata anchors) and keeps
 * the v1 informational cases unchanged; its full-scope evidence is archived as
 * `corpus.manifest.v2-harness-invalid.json` and is harness-invalid: v2 executed
 * the exact-case strict cases through the FTS-only path/oracle even though
 * exact-case is a distinct M7.3 branch, and it required a single `expectedId`
 * for the BVerfG exact title even though three authoritative public rows share
 * that exact title.
 * v3 kept every v2 query/filter/category unchanged and changed only the strict
 * target contract to frozen `expectedIds` target sets. Its first full-scope run
 * exposed one remaining metadata-preflight defect: Spain case key `572025`
 * legitimately belongs to both an AUTO and a SENTENCIA, while v3 froze only the
 * deterministic anchor id. That run is archived as target-set-invalid.
 * v4 keeps every query/filter/category unchanged and freezes the complete
 * authoritative exact-match target set for BOTH exact-case and exact-title.
 */
export const RANK_POLICY_VERSION = 4 as const;

/**
 * The representative corpus categories. Every category is selected from
 * existing public integration/test query shapes and broad multilingual/legal
 * coverage, never from an observed D1-vs-Postgres rank outcome.
 */
export const RANK_CORPUS_CATEGORIES = [
  "exact-case",
  "exact-title",
  "multilingual-legal-term",
  "case-number-identifier",
  "jurisdiction-source",
  "cclrag2-shape",
  "cclmetasearch-shape",
] as const;

export type RankCorpusCategory = (typeof RANK_CORPUS_CATEGORIES)[number];

/**
 * Strict exact-match invariants that must hold for 100% of evaluable cases:
 *
 * - `exact-case`: a query carrying a recognized primary case reference must
 *   return the corpus document whose `case_numbers` holds that reference first;
 * - `exact-title`: a query equal to an authoritative title must return the
 *   document with that exact encoded title first.
 *
 * `informational` cases are generic lexical queries for which no numeric
 * acceptance threshold exists here.
 */
export const RANK_CORPUS_INVARIANTS = ["exact-case", "exact-title", "informational"] as const;
export type RankCorpusInvariant = (typeof RANK_CORPUS_INVARIANTS)[number];

/** The supported UTC ranges, mirroring the fulltext RPC. */
export const RANK_CORPUS_RANGES = ["latest", "today", "week", "month"] as const;
export type RankCorpusRange = (typeof RANK_CORPUS_RANGES)[number];

/**
 * Content-free filters. No document text, summary, URL or vector is ever part
 * of the corpus: only bounded query/filter metadata.
 */
export interface RankCorpusFilters {
  source: string | null;
  jurisdiction: string | null;
  contentType: string | null;
  language: string | null;
  range: RankCorpusRange;
}

/** One frozen, content-free representative corpus case. */
export interface RankCorpusCase {
  /** Stable, category-scoped case id. */
  id: string;
  category: RankCorpusCategory;
  /** The content-free query text (query shapes only; never document body text). */
  query: string;
  filters: RankCorpusFilters;
  /** Result window to request from both the D1 FTS5 path and the production oracle. */
  limit: number;
  /** Overlap window K for `compareRankedIds`. */
  k: number;
  invariant: RankCorpusInvariant;
  /**
   * Frozen expected article-id SET for a strict case, selected from
   * authoritative PUBLIC METADATA ONLY (never a D1/Postgres rank outcome) BEFORE
   * any v4 parity outcome was read. It is a sorted, de-duplicated list of ids
   * only (no text). An exact-case set freezes every authoritative public
   * projection id that carries the exact case key (the Spain case key `572025`
   * is shared by an AUTO and a SENTENCIA, so its set has two ids while the
   * others are singletons), while an exact title that is authoritative but not
   * unique (for example the BVerfG `Beschluss vom 21. Oktober 2025`) freezes
   * every authoritative public projection id that carries that exact original
   * title. Strict target
   * evaluation must confirm that the local authoritative projection still
   * reproduces exactly this frozen set before any parity is evaluated; a
   * mismatch (drift or a new ambiguity) fails closed.
   * `undefined`/absent for informational cases.
   */
  expectedIds?: string[] | null;
}

/** The frozen, content-free representative corpus manifest. */
export interface RankCorpusManifest {
  version: typeof RANK_POLICY_VERSION;
  /** Stable, order-independent digest of the canonical selected corpus. */
  corpusHash: string;
  cases: RankCorpusCase[];
}

/** Macro (mean-over-cases) aggregate of the M7.2 `compareRankedIds` metrics. */
export interface RankAggregateMetrics {
  /** Number of compared case/metric pairs. */
  compared: number;
  /** Sum of per-case `overlapAtKCount`. */
  overlapAtKCount: number;
  /** Mean of per-case `overlapAtK` (each already normalized by its own K). */
  overlapAtKMacro: number;
  /** Sum of per-case `prefixMatchCount`. */
  prefixMatchCount: number;
  /** Mean of per-case `prefixMatchRate`. */
  prefixMatchMacro: number;
  /** Count of per-case `exactOrder === true`. */
  exactOrderCount: number;
  /** Mean of per-case `exactOrder` (0 or 1). */
  exactOrderMacro: number;
  /** Count of per-case `sameSet === true`. */
  sameSetCount: number;
  /** Mean of per-case `sameSet` (0 or 1). */
  sameSetMacro: number;
}

/** Per-category aggregate evidence and threshold accounting. */
export interface RankCategoryMetrics {
  category: RankCorpusCategory;
  cases: number;
  strictCases: number;
  strictPassed: number;
  strictFailed: number;
  /** Cases that had no comparable D1/production pair (or no resolvable target). */
  notApplicable: number;
  compared: number;
  aggregate: RankAggregateMetrics;
  /** True only when a threshold was supplied for this category from outside. */
  hasPreRegisteredThreshold: boolean;
  thresholdState: RankPolicyState;
}

/**
 * Independently pre-registered numeric acceptance thresholds for the generic
 * lexical categories. M7.7-B ships NONE of these: the type exists so an operator
 * can register one deliberately, and its absence is exactly what yields
 * `insufficient_evidence`. Values must come from outside any single observed
 * query result.
 */
export interface RankPolicyThresholds {
  /** Minimum macro overlap@K required for informational categories to pass. */
  minOverlapAtKMacro?: number;
  /** Minimum macro prefix-match rate required for informational categories to pass. */
  minPrefixMatchMacro?: number;
  /** Minimum macro `exactOrder` rate required for informational categories to pass. */
  minExactOrderMacro?: number;
  /** Minimum macro `sameSet` rate required for informational categories to pass. */
  minSameSetMacro?: number;
}

/** The policy verdict state. */
export type RankPolicyState = "pass" | "fail" | "insufficient_evidence";

export const RANK_POLICY_BLOCKER_CODES = [
  "fulltext_rank_threshold_unagreed",
  "rank_policy_no_strict_cases",
  "rank_policy_strict_invariant_failed",
  "rank_policy_no_comparable_cases",
] as const;

export type RankPolicyBlockerCode = (typeof RANK_POLICY_BLOCKER_CODES)[number];

export interface RankPolicyBlocker {
  code: RankPolicyBlockerCode;
  detail: string;
}

/** One case outcome. IDs only: no query/document text ever enters an outcome. */
export interface RankPolicyCaseOutcome {
  caseId: string;
  category: RankCorpusCategory;
  invariant: RankCorpusInvariant;
  /**
   * `pass`/`fail` for a comparable strict or threshold-backed case;
   * `informational` for a generic case with no pre-registered threshold;
   * `not_applicable` when no deterministic target could be resolved in the
   * bounded corpus or no production oracle window was available.
   */
  status: "pass" | "fail" | "informational" | "not_applicable";
  strict: boolean;
  /**
   * Frozen expected article-id set (strict cases only), sorted and unique; an
   * empty array for informational cases. It may contain a single id (exact-case
   * and unique titles) or the full authoritative set (a non-unique title).
   */
  expectedIds: string[];
  /** Observed D1 FTS5 top id (when the local path returned a row), or null. */
  observedId: string | null;
  /** Production oracle top id (when available), or null. */
  oracleTopId: string | null;
  /** True when a production oracle window was available for this case. */
  oracleCompared: boolean;
  metrics: RankedIdParityReport | null;
}

/** Structured strict-invariant accounting. */
export interface RankStrictInvariantSummary {
  cases: number;
  passed: number;
  failed: number;
  notApplicable: number;
  strictPassRate: number;
  exactCaseCases: number;
  exactCasePassed: number;
  exactTitleCases: number;
  exactTitlePassed: number;
}

/** Structured informational accounting. */
export interface RankInformationalSummary {
  cases: number;
  compared: number;
  hasPreRegisteredThreshold: boolean;
}

/** The complete, content-free rank-policy report. */
export interface RankPolicyReport {
  version: typeof RANK_POLICY_VERSION;
  state: RankPolicyState;
  corpusHash: string;
  strict: RankStrictInvariantSummary;
  informational: RankInformationalSummary;
  aggregate: RankAggregateMetrics;
  categories: RankCategoryMetrics[];
  thresholds: RankPolicyThresholds | null;
  blockers: RankPolicyBlocker[];
  outcomes: RankPolicyCaseOutcome[];
}
