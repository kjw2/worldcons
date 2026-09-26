import { canonicalJson } from "@/lib/backfill/canonical-json";
import { shadowDigest } from "@/lib/cloudflare/d1/shadow/digest";
import type { RankPolicyBlocker, RankPolicyReport, RankPolicyState } from "./types";
import type { EquivalenceReport } from "./equivalence";

/**
 * M7.7-B content-free FTS parity evidence assembly (runtime-neutral).
 *
 * A report is ids/counts/hashes/states only: no query text, no document text,
 * no summary, no URL and no vector is ever copied into it. The frozen corpus
 * (including its query shapes) lives in `corpus.manifest.json`; the report
 * references it only by its stable `corpusHash`.
 */

export const FTS_PARITY_REPORT_VERSION = 1 as const;

export interface FtsParityProjectionSummary {
  /** Bounded published source rows read from the authority. */
  sourceRows: number;
  /** Projected `search_documents` rows materialized into the local D1 corpus. */
  documents: number;
  /** Published `public_article_projection_p3` ids read for like-for-like scoping, or null. */
  productionProjectionIds: number | null;
}

/**
 * Content-free full-scope accounting of the read-only FTS source pager. It
 * carries only counts and a boolean: the production projection ids themselves,
 * and the local document ids, are NEVER copied into the evidence summary.
 */
export interface FtsParitySourceScopeSummary {
  /** Size of the full `public_article_projection_p3` id set (read-only ceiling 5000). */
  productionProjectionIds: number;
  /** Published source authority rows fetched by the pager, before id restriction. */
  sourceRowsFetched: number;
  /** Projected `search_documents` rows after restricting to the projection ids. */
  localDocuments: number;
  /** Production projection ids with no local projected document. */
  missingIds: number;
  /** Local projected ids absent from the production projection id set. */
  extraIds: number;
  /** True only when the two id sets are exactly equal (fail-closed gate). */
  scopeValid: boolean;
}

export interface FtsParityReport {
  version: typeof FTS_PARITY_REPORT_VERSION;
  generatedAt: string;
  scope: "fts-parity";
  source: "supabase" | "fixture";
  maxArticles: number;
  truncated: boolean;
  corpusHash: string;
  corpusCases: number;
  /** Selected cases per category (counts only). */
  categories: Record<string, number>;
  projection: FtsParityProjectionSummary;
  /** Content-free full-scope pager accounting, or null in fixture mode. */
  sourceScope: FtsParitySourceScopeSummary | null;
  oracleAvailable: boolean;
  /** Case ids whose local/oracle query errored (ids only; never a message). */
  errors: string[];
  policy: RankPolicyReport;
  boundaries: string[];
}

export interface BuildFtsParityReportInput {
  generatedAt: string;
  source: "supabase" | "fixture";
  maxArticles: number;
  truncated: boolean;
  projection: FtsParityProjectionSummary;
  sourceScope?: FtsParitySourceScopeSummary | null;
  oracleAvailable: boolean;
  errors?: readonly string[];
  policy: RankPolicyReport;
}

export const FTS_PARITY_BOUNDARIES = [
  "read-only: no Supabase mutation, no D1/Vectorize write, no canary data write and no --apply path",
  "production authority unchanged: SearchRepository, GO-SEARCH, DNS and traffic are untouched",
  "the frozen corpus was selected before any D1-vs-Postgres fulltext parity outcome was read",
  "no generic lexical acceptance threshold is invented or tuned; without an independently pre-registered threshold the generic categories are insufficient_evidence",
  "report is content-free: query/document text, summaries, URLs and vectors are never copied into it",
  "production evidence is full like-for-like scope through a read-only FTS source pager that never selects embeddings; rank evaluation fails closed unless the local projected article-id set exactly equals the production projection id set",
] as const;

export function buildFtsParityReport(input: BuildFtsParityReportInput): FtsParityReport {
  const categories: Record<string, number> = {};
  for (const caseOutcome of input.policy.outcomes) {
    categories[caseOutcome.category] = (categories[caseOutcome.category] ?? 0) + 1;
  }
  return {
    version: FTS_PARITY_REPORT_VERSION,
    generatedAt: input.generatedAt,
    scope: "fts-parity",
    source: input.source,
    maxArticles: input.maxArticles,
    truncated: input.truncated,
    corpusHash: input.policy.corpusHash,
    corpusCases: input.policy.outcomes.length,
    categories,
    projection: input.projection,
    sourceScope: input.sourceScope ?? null,
    oracleAvailable: input.oracleAvailable,
    errors: [...(input.errors ?? [])],
    policy: input.policy,
    boundaries: [...FTS_PARITY_BOUNDARIES],
  };
}

/** A stable digest over the content-free report body (excluding `generatedAt`). */
export function ftsParityReportHash(report: FtsParityReport): string {
  return shadowDigest(`fts-parity-report/v${FTS_PARITY_REPORT_VERSION}\n${canonicalJson({ ...report, generatedAt: "" })}`);
}

const CATEGORY_ORDER = [
  "exact-case",
  "exact-title",
  "multilingual-legal-term",
  "case-number-identifier",
  "jurisdiction-source",
  "cclrag2-shape",
  "cclmetasearch-shape",
] as const;

function rate(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

/** Renders the content-free markdown evidence artifact. */
export function renderFtsParityMarkdown(report: FtsParityReport): string {
  const lines: string[] = [];
  lines.push("# WorldCons M7.7-B fulltext rank-policy / FTS parity evidence");
  lines.push("");
  lines.push(`- generatedAt: ${report.generatedAt}`);
  lines.push(`- state: **${report.policy.state}**`);
  lines.push(`- source: ${report.source}`);
  lines.push(`- maxArticles: ${report.maxArticles}`);
  lines.push(`- truncated: ${report.truncated}`);
  lines.push(`- corpusHash: ${report.corpusHash}`);
  lines.push(`- corpusCases: ${report.corpusCases}`);
  lines.push(
    `- projection: sourceRows=${report.projection.sourceRows}, documents=${report.projection.documents}, productionProjectionIds=${report.projection.productionProjectionIds ?? "n/a"}`,
  );
  if (report.sourceScope) {
    lines.push(
      `- sourceScope: productionProjectionIds=${report.sourceScope.productionProjectionIds}, sourceRowsFetched=${report.sourceScope.sourceRowsFetched}, localDocuments=${report.sourceScope.localDocuments}, missingIds=${report.sourceScope.missingIds}, extraIds=${report.sourceScope.extraIds}, scopeValid=${report.sourceScope.scopeValid}`,
    );
  } else {
    lines.push("- sourceScope: (fixture mode)");
  }
  lines.push(`- oracleAvailable: ${report.oracleAvailable}`);
  lines.push(`- errors: ${report.errors.length}`);
  lines.push(`- thresholds: ${report.policy.thresholds ? JSON.stringify(report.policy.thresholds) : "(none pre-registered)"}`);
  lines.push("");
  lines.push("## Strict exact invariants (must hold 100%)");
  lines.push("");
  lines.push(`- cases: ${report.policy.strict.cases}`);
  lines.push(`- passed: ${report.policy.strict.passed}`);
  lines.push(`- failed: ${report.policy.strict.failed}`);
  lines.push(`- notApplicable: ${report.policy.strict.notApplicable}`);
  lines.push(`- strictPassRate: ${rate(report.policy.strict.strictPassRate)}`);
  lines.push(`- exactCase: ${report.policy.strict.exactCasePassed}/${report.policy.strict.exactCaseCases}`);
  lines.push(`- exactTitle: ${report.policy.strict.exactTitlePassed}/${report.policy.strict.exactTitleCases}`);
  lines.push("");
  lines.push("## Aggregate evidence metrics (non-gating)");
  lines.push("");
  lines.push("| metric | value |");
  lines.push("| --- | --- |");
  lines.push(`| compared | ${report.policy.aggregate.compared} |`);
  lines.push(`| overlapAtKCount | ${report.policy.aggregate.overlapAtKCount} |`);
  lines.push(`| overlapAtKMacro | ${report.policy.aggregate.overlapAtKMacro.toFixed(4)} |`);
  lines.push(`| prefixMatchCount | ${report.policy.aggregate.prefixMatchCount} |`);
  lines.push(`| prefixMatchMacro | ${report.policy.aggregate.prefixMatchMacro.toFixed(4)} |`);
  lines.push(`| exactOrderCount | ${report.policy.aggregate.exactOrderCount} |`);
  lines.push(`| exactOrderMacro | ${report.policy.aggregate.exactOrderMacro.toFixed(4)} |`);
  lines.push(`| sameSetCount | ${report.policy.aggregate.sameSetCount} |`);
  lines.push(`| sameSetMacro | ${report.policy.aggregate.sameSetMacro.toFixed(4)} |`);
  lines.push("");
  lines.push("## Categories");
  lines.push("");
  lines.push("| category | cases | strictCases | strictPassed | strictFailed | notApplicable | compared | overlapAtKMacro | prefixMatchMacro | exactOrderMacro | sameSetMacro | threshold | thresholdState |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const category of CATEGORY_ORDER) {
    const metric = report.policy.categories.find((entry) => entry.category === category);
    if (!metric) continue;
    lines.push(
      `| ${metric.category} | ${metric.cases} | ${metric.strictCases} | ${metric.strictPassed} | ${metric.strictFailed} | ${metric.notApplicable} | ${metric.compared} | ${metric.aggregate.overlapAtKMacro.toFixed(4)} | ${metric.aggregate.prefixMatchMacro.toFixed(4)} | ${metric.aggregate.exactOrderMacro.toFixed(4)} | ${metric.aggregate.sameSetMacro.toFixed(4)} | ${metric.hasPreRegisteredThreshold ? "registered" : "none"} | ${metric.thresholdState} |`,
    );
  }
  lines.push("");
  lines.push("## Blockers");
  lines.push("");
  if (report.policy.blockers.length === 0) lines.push("(none)");
  else for (const blocker of report.policy.blockers) lines.push(`- \`${blocker.code}\`: ${blocker.detail}`);
  lines.push("");
  lines.push("## Outcomes (ids only)");
  lines.push("");
  lines.push("| case | category | status | strict | expectedIds | observedId | oracleTopId | oracleCompared | overlapAtK | exactOrder | sameSet |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const outcome of report.policy.outcomes) {
    lines.push(
      `| ${outcome.caseId} | ${outcome.category} | ${outcome.status} | ${outcome.strict} | ${outcome.expectedIds.join(",")} | ${outcome.observedId ?? ""} | ${outcome.oracleTopId ?? ""} | ${outcome.oracleCompared} | ${outcome.metrics ? outcome.metrics.overlapAtKCount : ""} | ${outcome.metrics ? outcome.metrics.exactOrder : ""} | ${outcome.metrics ? outcome.metrics.sameSet : ""} |`,
    );
  }
  lines.push("");
  lines.push("## Boundaries");
  lines.push("");
  for (const boundary of report.boundaries) lines.push(`- ${boundary}`);
  lines.push("");
  return lines.join("\n");
}

/**
 * M7.8-B content-free v5 HOLDOUT evidence (runtime-neutral).
 *
 * A holdout report is counts/hashes/states only. It is produced ONLY after a
 * valid, finalized decision record is supplied, and it is bound to BOTH the
 * signed `decisionHash` and the v5 `holdoutHash`. It never carries query text,
 * document text, ids or vectors, and it never contains a sealed v4 metric
 * literal.
 */

export const FTS_PARITY_HOLDOUT_REPORT_VERSION = 1 as const;

export type FtsParityHoldoutPolicy =
  | "candidate-coverage-equivalence"
  | "numeric-thresholds"
  | "informational-only";

export interface FtsParityHoldoutReport {
  version: typeof FTS_PARITY_HOLDOUT_REPORT_VERSION;
  generatedAt: string;
  scope: "fts-parity-holdout";
  source: "supabase" | "fixture";
  maxArticles: number;
  truncated: boolean;
  /** The v5 holdout hash this evidence is bound to. */
  holdoutHash: string;
  /** The signed decision hash this evidence is bound to. */
  decisionHash: string;
  policy: FtsParityHoldoutPolicy;
  /** The human signer role (never a secret; a role label only). */
  decidedByRole: string;
  holdoutCases: number;
  categories: Record<string, number>;
  projection: FtsParityProjectionSummary;
  sourceScope: FtsParitySourceScopeSummary | null;
  oracleAvailable: boolean;
  errors: string[];
  /**
   * The candidate-coverage E1-E4 report, or null for numeric/informational mode.
   * Content-free: counts and per-invariant pass/fail only.
   */
  equivalence: EquivalenceReport | null;
  /** The numeric-threshold policy report, or null for non-numeric mode. */
  numeric: RankPolicyReport | null;
  /** The policy verdict state derived from the signed decision. */
  state: RankPolicyState;
  /** The blockers, unchanged: informational-only keeps `fulltext_rank_threshold_unagreed`. */
  blockers: RankPolicyBlocker[];
  boundaries: string[];
}

export const FTS_PARITY_HOLDOUT_BOUNDARIES = [
  "read-only: no Supabase mutation, no D1/Vectorize write, no canary data write and no --apply path",
  "production authority unchanged: SearchRepository, GO-SEARCH, DNS and traffic are untouched",
  "the v5 holdout candidate pool is disjoint from v4 by normalized (category, query, filters) and selects nothing from a v4 rank outcome",
  "a valid finalized decision record is required before any linked query is issued; an undecided record is refused",
  "evidence is bound to decisionHash + holdoutHash",
  "report is content-free: query/document text, summaries, URLs, ids and vectors are never copied into it",
  "exact-order/same-set/overlap remain informational and never gate candidate-coverage-equivalence mode",
] as const;

export interface BuildFtsParityHoldoutReportInput {
  generatedAt: string;
  source: "supabase" | "fixture";
  maxArticles: number;
  truncated: boolean;
  holdoutHash: string;
  decisionHash: string;
  policy: FtsParityHoldoutPolicy;
  decidedByRole: string;
  projection: FtsParityProjectionSummary;
  sourceScope?: FtsParitySourceScopeSummary | null;
  oracleAvailable: boolean;
  errors?: readonly string[];
  equivalence: EquivalenceReport | null;
  numeric: RankPolicyReport | null;
  state: RankPolicyState;
  blockers?: readonly RankPolicyBlocker[];
}

export function buildFtsParityHoldoutReport(input: BuildFtsParityHoldoutReportInput): FtsParityHoldoutReport {
  const categories: Record<string, number> = {};
  const holdoutCases = input.equivalence?.cases ?? input.numeric?.outcomes.length ?? 0;
  if (input.numeric) {
    for (const caseOutcome of input.numeric.outcomes) {
      categories[caseOutcome.category] = (categories[caseOutcome.category] ?? 0) + 1;
    }
  }
  return {
    version: FTS_PARITY_HOLDOUT_REPORT_VERSION,
    generatedAt: input.generatedAt,
    scope: "fts-parity-holdout",
    source: input.source,
    maxArticles: input.maxArticles,
    truncated: input.truncated,
    holdoutHash: input.holdoutHash,
    decisionHash: input.decisionHash,
    policy: input.policy,
    decidedByRole: input.decidedByRole,
    holdoutCases,
    categories,
    projection: input.projection,
    sourceScope: input.sourceScope ?? null,
    oracleAvailable: input.oracleAvailable,
    errors: [...(input.errors ?? [])],
    equivalence: input.equivalence,
    numeric: input.numeric,
    state: input.state,
    blockers: [...(input.blockers ?? [])],
    boundaries: [...FTS_PARITY_HOLDOUT_BOUNDARIES],
  };
}

/** A stable digest over the content-free holdout report body (excluding `generatedAt`). */
export function ftsParityHoldoutReportHash(report: FtsParityHoldoutReport): string {
  return shadowDigest(
    `fts-parity-holdout-report/v${FTS_PARITY_HOLDOUT_REPORT_VERSION}\n${canonicalJson({ ...report, generatedAt: "" })}`,
  );
}

/** Renders the content-free holdout markdown evidence artifact. */
export function renderFtsParityHoldoutMarkdown(report: FtsParityHoldoutReport): string {
  const lines: string[] = [];
  lines.push("# WorldCons M7.8-B rank-policy HOLDOUT evidence");
  lines.push("");
  lines.push(`- generatedAt: ${report.generatedAt}`);
  lines.push(`- policy: **${report.policy}**`);
  lines.push(`- state: **${report.state}**`);
  lines.push(`- source: ${report.source}`);
  lines.push(`- maxArticles: ${report.maxArticles}`);
  lines.push(`- truncated: ${report.truncated}`);
  lines.push(`- holdoutHash: ${report.holdoutHash}`);
  lines.push(`- decisionHash: ${report.decisionHash}`);
  lines.push(`- decidedByRole: ${report.decidedByRole}`);
  lines.push(`- holdoutCases: ${report.holdoutCases}`);
  lines.push(
    `- projection: sourceRows=${report.projection.sourceRows}, documents=${report.projection.documents}, productionProjectionIds=${report.projection.productionProjectionIds ?? "n/a"}`,
  );
  if (report.sourceScope) {
    lines.push(
      `- sourceScope: productionProjectionIds=${report.sourceScope.productionProjectionIds}, sourceRowsFetched=${report.sourceScope.sourceRowsFetched}, localDocuments=${report.sourceScope.localDocuments}, missingIds=${report.sourceScope.missingIds}, extraIds=${report.sourceScope.extraIds}, scopeValid=${report.sourceScope.scopeValid}`,
    );
  } else {
    lines.push("- sourceScope: (fixture mode)");
  }
  lines.push(`- oracleAvailable: ${report.oracleAvailable}`);
  lines.push(`- errors: ${report.errors.length}`);
  lines.push("");
  if (report.equivalence) {
    lines.push("## Candidate-coverage equivalence invariants (gating)");
    lines.push("");
    lines.push("| invariant | applicable | passed | failed |");
    lines.push("| --- | --- | --- | --- |");
    for (const invariant of report.equivalence.invariants) {
      const counts = report.equivalence.counts[invariant];
      lines.push(`| ${invariant} | ${counts.applicable} | ${counts.passed} | ${counts.failed} |`);
    }
    lines.push(`- passed: **${report.equivalence.passed}**`);
    lines.push(`- failures: ${report.equivalence.failures.length}`);
  } else {
    lines.push("## Candidate-coverage equivalence invariants");
    lines.push("");
    lines.push("(not evaluated: policy is not candidate-coverage-equivalence)");
  }
  lines.push("");
  if (report.numeric) {
    lines.push("## Numeric-threshold policy");
    lines.push("");
    lines.push(`- state: ${report.numeric.state}`);
    lines.push(`- thresholds: ${report.numeric.thresholds ? JSON.stringify(report.numeric.thresholds) : "(none)"}`);
  } else {
    lines.push("## Numeric-threshold policy");
    lines.push("");
    lines.push("(not evaluated: policy is not numeric-thresholds)");
  }
  lines.push("");
  lines.push("## Blockers");
  lines.push("");
  if (report.blockers.length === 0) lines.push("(none)");
  else for (const blocker of report.blockers) lines.push(`- \`${blocker.code}\`: ${blocker.detail}`);
  lines.push("");
  lines.push("## Boundaries");
  lines.push("");
  for (const boundary of report.boundaries) lines.push(`- ${boundary}`);
  lines.push("");
  return lines.join("\n");
}
