import {
  assertHistoricalGateYear,
  HISTORICAL_GATE_MAX_YEAR,
} from "@/lib/backfill/country-history-policy";

export const CASE_CATALOG_GERMANY_HISTORY_FLAG = "CASE_CATALOG_GERMANY_HISTORY_ENABLED";
export const GERMANY_BVERFG_HISTORY_START_YEAR = 1998;
export const GERMANY_BVERFG_DOCUMENT_TYPE = "DECISION" as const;

/**
 * The 2024 private-shadow canary is the pre-existing baseline approval.
 * `bverfg-unattended-canary-v2` is an additive, immutable successor recorded by
 * migration `20260916110000_constitutional_case_germany_2023_policy_approval.sql`
 * extended the exact same reviewed source-policy assumptions to 2023. The
 * additive v3 successor recorded on 2026-10-03 extends them to 2022. The
 * additive v4 successor approved on 2026-10-06 extends the exact same reviewed
 * source-policy assumptions to the NEXT SINGLE YEAR, 2021, after a read-only
 * Dejure inventory audit found exactly 412 unique date+docket targets and a
 * 2022 cross-check reproduced the sealed 366-target snapshot exactly. The
 * successor never widens document type, hosts, discovery method, coverage
 * assurance, or public/AI posture, and 2020 and older remain blocked.
 */
export const GERMANY_BVERFG_2024_BASELINE_POLICY_VERSION = "bverfg-unattended-canary-v1";
export const GERMANY_BVERFG_2023_POLICY_VERSION = "bverfg-unattended-canary-v2";
export const GERMANY_BVERFG_2022_POLICY_VERSION = "bverfg-unattended-canary-v3";
export const GERMANY_BVERFG_2021_POLICY_VERSION = "bverfg-unattended-canary-v4";
export const GERMANY_BVERFG_APPROVED_SHADOW_POLICY_VERSION = GERMANY_BVERFG_2021_POLICY_VERSION;
export const GERMANY_BVERFG_APPROVED_SHADOW_POLICY_REVIEW_DUE_AT = "2027-04-01";
export const GERMANY_BVERFG_2021_EXPECTED_COUNT = 412;
export const GERMANY_BVERFG_2021_EXPECTED_COUNT_BASIS = "dejure_listing_date_docket_audit_2026-10-06";
export const GERMANY_BVERFG_APPROVED_CANARY_YEAR = 2024;
export const GERMANY_BVERFG_APPROVED_SHADOW_YEARS: readonly number[] = Object.freeze([
  GERMANY_BVERFG_APPROVED_CANARY_YEAR,
  2023,
  2022,
  2021,
]);
export const GERMANY_BVERFG_APPROVED_POLICY_BY_YEAR: Readonly<Record<number, string>> = Object.freeze({
  [GERMANY_BVERFG_APPROVED_CANARY_YEAR]: GERMANY_BVERFG_2024_BASELINE_POLICY_VERSION,
  2023: GERMANY_BVERFG_2023_POLICY_VERSION,
  2022: GERMANY_BVERFG_2022_POLICY_VERSION,
  2021: GERMANY_BVERFG_2021_POLICY_VERSION,
});

export function germanyBverfgVerifiedInventoryExpectation(year: number) {
  if (year !== 2021) return null;
  return {
    expectedCount: GERMANY_BVERFG_2021_EXPECTED_COUNT,
    expectedCountBasis: GERMANY_BVERFG_2021_EXPECTED_COUNT_BASIS,
    evidence: {
      auditedAt: "2026-10-06",
      providerKey: "dejure.org",
      stableIdentity: "decision_date_plus_docket_key",
      firstPage: 33,
      lastPage: 43,
      pageCount: 11,
      earliestDecisionDate: "2021-01-04",
      latestDecisionDate: "2021-12-23",
      crossPageDuplicates: 0,
      boundaryStable: true,
      crosscheckYear: 2022,
      crosscheckExpectedCount: 366,
      crosscheckObservedCount: 366,
    },
  } as const;
}

function explicitTrue(value?: string) {
  return value?.trim().toLowerCase() === "true";
}

export function germanyBverfgYearSupported(
  year: number,
  currentYear = new Date().getUTCFullYear(),
) {
  try {
    assertHistoricalGateYear(year, currentYear);
    return Number.isInteger(year) && year >= GERMANY_BVERFG_HISTORY_START_YEAR;
  } catch {
    return false;
  }
}

/**
 * Only the four owner-approved private-shadow years are authorized for
 * unattended execution: the pre-existing 2024 canary (`bverfg-unattended-canary-v1`)
 * plus additive 2023 (`bverfg-unattended-canary-v2`) and 2022
 * (`bverfg-unattended-canary-v3`) and 2021 (`bverfg-unattended-canary-v4`,
 * review due 2027-04-01). Every other supported year (1998-2020) is an M5 expansion that
 * needs another owner-approved policy version. The guard stays fail-closed even
 * when the history flag is true.
 */
export function germanyBverfgExpansionGuard(year: number) {
  if (!Number.isInteger(year) || year > HISTORICAL_GATE_MAX_YEAR || year < GERMANY_BVERFG_HISTORY_START_YEAR) {
    return { allowed: false as const, reason: "case_backfill.germany_year_not_supported" as const };
  }
  if (!GERMANY_BVERFG_APPROVED_SHADOW_YEARS.includes(year)) {
    return { allowed: false as const, reason: "case_backfill.germany_expansion_not_approved" as const };
  }
  return { allowed: true as const, reason: null };
}

export function germanyBverfgApprovedPolicyVersionForYear(year: number) {
  return GERMANY_BVERFG_APPROVED_POLICY_BY_YEAR[year] ?? null;
}

export function germanyBverfgApprovedPolicyDescriptor() {
  return {
    policyVersion: GERMANY_BVERFG_APPROVED_SHADOW_POLICY_VERSION,
    reviewDueAt: GERMANY_BVERFG_APPROVED_SHADOW_POLICY_REVIEW_DUE_AT,
    approvedCanaryYear: GERMANY_BVERFG_APPROVED_CANARY_YEAR,
    approvedYears: [...GERMANY_BVERFG_APPROVED_SHADOW_YEARS],
    approvedPolicyVersions: { ...GERMANY_BVERFG_APPROVED_POLICY_BY_YEAR },
    historyStartYear: GERMANY_BVERFG_HISTORY_START_YEAR,
    historicalMaxYear: HISTORICAL_GATE_MAX_YEAR,
  };
}

export function germanyBverfgYearScope(
  year: number,
  currentYear = new Date().getUTCFullYear(),
) {
  if (!germanyBverfgYearSupported(year, currentYear)) {
    throw new Error("case_backfill.germany_year_not_supported");
  }
  return {
    year,
    scopeFrom: `${year}-01-01`,
    scopeTo: `${year}-12-31`,
    documentType: GERMANY_BVERFG_DOCUMENT_TYPE,
  };
}

export function germanyBverfgYearEnabled(
  year: number,
  environment: Record<string, string | undefined> = process.env,
  currentYear = new Date().getUTCFullYear(),
) {
  return germanyBverfgYearSupported(year, currentYear)
    && germanyBverfgExpansionGuard(year).allowed
    && explicitTrue(environment[CASE_CATALOG_GERMANY_HISTORY_FLAG]);
}

export function assertGermanyBverfgYearEnabled(
  year: number,
  environment: Record<string, string | undefined> = process.env,
  currentYear = new Date().getUTCFullYear(),
) {
  germanyBverfgYearScope(year, currentYear);
  const guard = germanyBverfgExpansionGuard(year);
  if (!guard.allowed) throw new Error(guard.reason);
  if (!explicitTrue(environment[CASE_CATALOG_GERMANY_HISTORY_FLAG])) {
    throw new Error("case_backfill.germany_history_disabled");
  }
}

export function germanyBverfgExpansionPlan(
  environment: Record<string, string | undefined> = process.env,
  currentYear = new Date().getUTCFullYear(),
) {
  const plan: Array<ReturnType<typeof germanyBverfgYearScope> & { enabled: boolean }> = [];
  const newestYear = Math.min(currentYear, HISTORICAL_GATE_MAX_YEAR);
  for (let year = newestYear; year >= GERMANY_BVERFG_HISTORY_START_YEAR; year -= 1) {
    plan.push({
      ...germanyBverfgYearScope(year, currentYear),
      enabled: germanyBverfgYearEnabled(year, environment, currentYear),
    });
  }
  return plan;
}
