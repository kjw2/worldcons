import type { CaseBackfillSnapshot } from "@/lib/backfill/types";

/**
 * M4 common boundary contract.
 *
 * Gate 5 historical backfill owns pre-2025 official-source years only. From
 * 2025 onward, official decisions belong to the incremental ingestion workflow
 * (`p1.collect` / `runIngest`), so the historical ledger must never open a
 * 2025+ annual snapshot and silently duplicate live collection.
 */
export const HISTORICAL_GATE = 5 as const;
export const HISTORICAL_GATE_MAX_YEAR = 2024;
export const INCREMENTAL_INGESTION_OWNED_FROM_YEAR = 2025;

export interface CaseHistoryBoundary {
  readonly gate: typeof HISTORICAL_GATE;
  readonly historicalMaxYear: number;
  readonly incrementalOwnedFromYear: number;
  readonly rule: "pre_2025_gate5_historical";
}

export const CASE_HISTORY_BOUNDARY: CaseHistoryBoundary = Object.freeze({
  gate: HISTORICAL_GATE,
  historicalMaxYear: HISTORICAL_GATE_MAX_YEAR,
  incrementalOwnedFromYear: INCREMENTAL_INGESTION_OWNED_FROM_YEAR,
  rule: "pre_2025_gate5_historical",
});

export type CountryHistoryStageStatus =
  | "approved_private_shadow"
  | "approved_source_policy"
  | "blocked_source_policy"
  | "pending_owner_approval"
  | "candidate_graph_only";

export interface CountryHistoryStage {
  readonly order: number;
  readonly country: "Germany" | "France" | "Spain" | "United States";
  readonly sourceKey: string;
  readonly documentTypes: readonly string[];
  readonly yearFrom: number;
  readonly yearTo: number;
  readonly approvedYearFrom: number | null;
  readonly approvedYearTo: number | null;
  readonly status: CountryHistoryStageStatus;
  readonly blocking: readonly string[];
  readonly policyVersion: string | null;
  readonly policyReviewDueAt: string | null;
}

/**
 * Country expansion order is machine-readable so the CLI plan/discover output
 * and the P1 worker share one ordering. The order is readiness-based:
 * Germany first (approved 2024 private-shadow canary), then the pending-owner
 * sources, and finally the U.S. candidate graph which is explicitly not a
 * verified SCOTUS corpus.
 */
export const COUNTRY_HISTORY_EXPANSION_ORDER: readonly CountryHistoryStage[] = Object.freeze([
  Object.freeze({
    order: 1,
    country: "Germany",
    sourceKey: "de-bverfg",
    documentTypes: ["DECISION"],
    yearFrom: 1998,
    yearTo: 2024,
    approvedYearFrom: 2024,
    approvedYearTo: 2024,
    status: "approved_private_shadow",
    blocking: [],
    policyVersion: "bverfg-unattended-canary-v1",
    policyReviewDueAt: "2027-03-03",
  }),
  Object.freeze({
    order: 2,
    country: "France",
    sourceKey: "fr-conseil-constitutionnel",
    documentTypes: ["QPC", "DC"],
    yearFrom: 2010,
    yearTo: 2024,
    approvedYearFrom: 2010,
    approvedYearTo: 2024,
    status: "approved_source_policy",
    blocking: [],
    policyVersion: "france-dila-constit-2026-09-v1",
    policyReviewDueAt: "2027-03-15",
  }),
  Object.freeze({
    order: 3,
    country: "France",
    sourceKey: "fr-conseil-constitutionnel",
    documentTypes: ["L", "LP", "OTHER_CONSEIL_NATURE"],
    yearFrom: 2010,
    yearTo: 2024,
    approvedYearFrom: null,
    approvedYearTo: null,
    status: "pending_owner_approval",
    blocking: ["owner_source_policy_not_approved", "deferred_after_qpc_dc"],
    policyVersion: null,
    policyReviewDueAt: null,
  }),
  Object.freeze({
    order: 4,
    country: "Spain",
    sourceKey: "es-tribunal-constitucional",
    documentTypes: ["SENTENCIA"],
    yearFrom: 2020,
    yearTo: 2024,
    approvedYearFrom: null,
    approvedYearTo: null,
    status: "blocked_source_policy",
    blocking: ["spain_hj_legal_robots_policy_blocked"],
    policyVersion: null,
    policyReviewDueAt: null,
  }),
  Object.freeze({
    order: 5,
    country: "Spain",
    sourceKey: "es-tribunal-constitucional",
    documentTypes: ["SENTENCIA", "DECLARACION"],
    yearFrom: 1980,
    yearTo: 2019,
    approvedYearFrom: null,
    approvedYearTo: null,
    status: "blocked_source_policy",
    blocking: ["spain_hj_legal_robots_policy_blocked", "deferred_after_2020_2024"],
    policyVersion: null,
    policyReviewDueAt: null,
  }),
  Object.freeze({
    order: 6,
    country: "Spain",
    sourceKey: "es-tribunal-constitucional",
    documentTypes: ["AUTO"],
    yearFrom: 1980,
    yearTo: 2024,
    approvedYearFrom: null,
    approvedYearTo: null,
    status: "blocked_source_policy",
    blocking: ["spain_hj_legal_robots_policy_blocked", "deferred_after_sentencia"],
    policyVersion: null,
    policyReviewDueAt: null,
  }),
  Object.freeze({
    order: 7,
    country: "United States",
    sourceKey: "us-constitution-annotated",
    documentTypes: ["CONSTITUTION_ANNOTATED_TABLE_CITATION"],
    yearFrom: 1789,
    yearTo: 2024,
    approvedYearFrom: null,
    approvedYearTo: null,
    status: "candidate_graph_only",
    blocking: ["candidate_graph_is_not_verified_scotus_corpus"],
    policyVersion: null,
    policyReviewDueAt: null,
  }),
]);

export function countryHistoryStage(sourceKey: string) {
  return COUNTRY_HISTORY_EXPANSION_ORDER.filter((stage) => stage.sourceKey === sourceKey);
}

export function caseHistoryBoundaryDescriptor() {
  return {
    ...CASE_HISTORY_BOUNDARY,
    expansionOrder: COUNTRY_HISTORY_EXPANSION_ORDER.map((stage) => ({ ...stage })),
  };
}

export function isIncrementalIngestionYear(year: number) {
  return Number.isInteger(year) && year >= INCREMENTAL_INGESTION_OWNED_FROM_YEAR;
}

export function isHistoricalGateYear(year: number) {
  return Number.isInteger(year) && year <= HISTORICAL_GATE_MAX_YEAR;
}

export function assertHistoricalGateYear(year: number, currentYear = new Date().getUTCFullYear()) {
  if (!Number.isInteger(year) || year > HISTORICAL_GATE_MAX_YEAR) {
    throw new Error("case_backfill.historical_year_out_of_gate5_boundary");
  }
  if (!Number.isInteger(currentYear) || year > currentYear) {
    throw new Error("case_backfill.historical_year_in_future");
  }
  return year;
}

function scopeYear(value: string | null | undefined) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const year = Number(value.slice(0, 4));
  return Number.isInteger(year) ? year : null;
}

/**
 * Applied before a backfill run row is created, so a 2025+ snapshot can never
 * be opened or resumed through the historical ledger.
 */
export function assertHistoricalSnapshotBoundary(snapshot: Pick<CaseBackfillSnapshot, "scopeFrom" | "scopeTo">) {
  const fromYear = scopeYear(snapshot.scopeFrom);
  const toYear = scopeYear(snapshot.scopeTo);
  if (fromYear === null || toYear === null) {
    throw new Error("case_backfill.historical_scope_missing");
  }
  if (isIncrementalIngestionYear(fromYear) || isIncrementalIngestionYear(toYear)) {
    throw new Error("case_backfill.incremental_year_not_historical");
  }
  if (fromYear > HISTORICAL_GATE_MAX_YEAR || toYear > HISTORICAL_GATE_MAX_YEAR) {
    throw new Error("case_backfill.historical_year_out_of_gate5_boundary");
  }
  return { fromYear, toYear, boundary: CASE_HISTORY_BOUNDARY };
}
