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
 * that extends the exact same reviewed source-policy assumptions to one
 * additional year, 2023 only. The successor never widens document type, hosts,
 * robots/terms, discovery method, coverage assurance, or public/AI posture, and
 * 2022 and older remain blocked under the existing expansion guard.
 */
export const GERMANY_BVERFG_2024_BASELINE_POLICY_VERSION = "bverfg-unattended-canary-v1";
export const GERMANY_BVERFG_2023_POLICY_VERSION = "bverfg-unattended-canary-v2";
export const GERMANY_BVERFG_APPROVED_SHADOW_POLICY_VERSION = GERMANY_BVERFG_2023_POLICY_VERSION;
export const GERMANY_BVERFG_APPROVED_SHADOW_POLICY_REVIEW_DUE_AT = "2027-03-15";
export const GERMANY_BVERFG_APPROVED_CANARY_YEAR = 2024;
export const GERMANY_BVERFG_APPROVED_SHADOW_YEARS: readonly number[] = Object.freeze([
  GERMANY_BVERFG_APPROVED_CANARY_YEAR,
  2023,
]);
export const GERMANY_BVERFG_APPROVED_POLICY_BY_YEAR: Readonly<Record<number, string>> = Object.freeze({
  [GERMANY_BVERFG_APPROVED_CANARY_YEAR]: GERMANY_BVERFG_2024_BASELINE_POLICY_VERSION,
  2023: GERMANY_BVERFG_2023_POLICY_VERSION,
});

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
 * Only the two owner-approved private-shadow years are authorized for
 * unattended execution: the pre-existing 2024 canary (`bverfg-unattended-canary-v1`)
 * and the additive 2023 successor (`bverfg-unattended-canary-v2`, review due
 * 2027-03-15). Every other supported year (1998-2022) is an M5 expansion that
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
