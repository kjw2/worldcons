import {
  assertHistoricalGateYear,
  HISTORICAL_GATE_MAX_YEAR,
} from "@/lib/backfill/country-history-policy";

export const CASE_CATALOG_FRANCE_HISTORY_FLAG = "CASE_CATALOG_FRANCE_HISTORY_ENABLED";
export const FRANCE_CONSEIL_HISTORY_START_YEAR = 2010;
export const FRANCE_CONSEIL_HISTORY_END_YEAR = 2024;
export const FRANCE_CONSEIL_DOCUMENT_TYPES = ["QPC", "DC"] as const;
export const FRANCE_CONSEIL_HISTORY_SOURCE_POLICY_STATUS = "approved_source_policy" as const;
export const FRANCE_CONSEIL_APPROVED_POLICY_VERSION = "france-dila-constit-2026-09-v1";
export const FRANCE_CONSEIL_APPROVED_POLICY_REVIEW_DUE_AT = "2027-03-15";
/**
 * The WorldCons owner explicitly approved the France DILA/Conseil QPC/DC source
 * policy on 2026-09-16, scoped only to the 2010-2024 QPC/DC tranches. The
 * immutable row is inserted by migration
 * `20260916090000_constitutional_case_france_policy_approval.sql`. The approval
 * is recorded here as reviewed policy metadata only; execution still requires
 * the exact `CASE_CATALOG_FRANCE_HISTORY_ENABLED` flag, so the env flag is never
 * sufficient on its own and no runtime env-only bypass is introduced.
 */
export const FRANCE_CONSEIL_HISTORY_SOURCE_POLICY_APPROVED = true;

export type FranceConseilDocumentType = (typeof FRANCE_CONSEIL_DOCUMENT_TYPES)[number];

export interface FranceConseilScopeOptions {
  policyApproved?: boolean;
}

function explicitTrue(value?: string) {
  return value?.trim().toLowerCase() === "true";
}

export function franceConseilHistorySourcePolicyApproved() {
  return FRANCE_CONSEIL_HISTORY_SOURCE_POLICY_APPROVED;
}

/**
 * Read-only descriptor of the owner-approved France policy. It exposes the exact
 * approved document types and year bounds without widening the approved scope to
 * `L`/`LP`/`OTHER_CONSEIL_NATURE`, which stay deferred to a later policy version.
 */
export function franceConseilApprovedPolicyDescriptor() {
  return {
    policyVersion: FRANCE_CONSEIL_APPROVED_POLICY_VERSION,
    reviewDueAt: FRANCE_CONSEIL_APPROVED_POLICY_REVIEW_DUE_AT,
    documentTypes: [...FRANCE_CONSEIL_DOCUMENT_TYPES],
    approvedYearFrom: FRANCE_CONSEIL_HISTORY_START_YEAR,
    approvedYearTo: FRANCE_CONSEIL_HISTORY_END_YEAR,
    historyStartYear: FRANCE_CONSEIL_HISTORY_START_YEAR,
    historicalMaxYear: HISTORICAL_GATE_MAX_YEAR,
  };
}

/**
 * The owner approval covers exactly the 2010-2024 QPC/DC selections. Other
 * Conseil natures remain deferred, and any year outside the Gate 5 boundary is
 * never authorized by this policy.
 */
export function franceConseilApprovedSelection(year: number, documentType: string) {
  const normalizedType = franceConseilDocumentType(documentType);
  if (!normalizedType) return false;
  if (year < FRANCE_CONSEIL_HISTORY_START_YEAR || year > FRANCE_CONSEIL_HISTORY_END_YEAR) return false;
  return year <= HISTORICAL_GATE_MAX_YEAR;
}

export function franceConseilYearSupported(year: number, currentYear = new Date().getUTCFullYear()) {
  try {
    assertHistoricalGateYear(year, currentYear);
    return Number.isInteger(year)
      && Number.isInteger(currentYear)
      && year >= FRANCE_CONSEIL_HISTORY_START_YEAR;
  } catch {
    return false;
  }
}

export function franceConseilDocumentType(value: string): FranceConseilDocumentType | null {
  const normalized = value.trim().toUpperCase();
  return (FRANCE_CONSEIL_DOCUMENT_TYPES as readonly string[]).includes(normalized)
    ? normalized as FranceConseilDocumentType
    : null;
}

export function franceConseilScope(
  year: number,
  documentType: string,
  currentYear = new Date().getUTCFullYear(),
) {
  if (!franceConseilYearSupported(year, currentYear)) {
    throw new Error("case_backfill.france_year_not_supported");
  }
  const normalizedType = franceConseilDocumentType(documentType);
  if (!normalizedType) throw new Error("case_backfill.france_document_type_not_supported");
  return {
    year,
    scopeFrom: `${year}-01-01`,
    scopeTo: `${year}-12-31`,
    documentType: normalizedType,
  };
}

export function franceConseilScopeEnabled(
  year: number,
  documentType: string,
  environment: Record<string, string | undefined> = process.env,
  currentYear = new Date().getUTCFullYear(),
  options: FranceConseilScopeOptions = {},
) {
  try {
    franceConseilScope(year, documentType, currentYear);
  } catch {
    return false;
  }
  const approved = options.policyApproved ?? franceConseilHistorySourcePolicyApproved();
  return approved && explicitTrue(environment[CASE_CATALOG_FRANCE_HISTORY_FLAG]);
}

export function assertFranceConseilScopeEnabled(
  year: number,
  documentType: string,
  environment: Record<string, string | undefined> = process.env,
  currentYear = new Date().getUTCFullYear(),
  options: FranceConseilScopeOptions = {},
) {
  franceConseilScope(year, documentType, currentYear);
  if (!explicitTrue(environment[CASE_CATALOG_FRANCE_HISTORY_FLAG])) {
    throw new Error("case_backfill.france_history_disabled");
  }
  const approved = options.policyApproved ?? franceConseilHistorySourcePolicyApproved();
  if (!approved) {
    throw new Error("case_backfill.france_history_source_policy_not_approved");
  }
}

export function franceConseilExpansionPlan(
  environment: Record<string, string | undefined> = process.env,
  currentYear = new Date().getUTCFullYear(),
  options: FranceConseilScopeOptions = {},
) {
  const plan: Array<ReturnType<typeof franceConseilScope> & { enabled: boolean }> = [];
  const newestYear = Math.min(currentYear, HISTORICAL_GATE_MAX_YEAR);
  for (let year = FRANCE_CONSEIL_HISTORY_START_YEAR; year <= newestYear; year += 1) {
    for (const documentType of FRANCE_CONSEIL_DOCUMENT_TYPES) {
      plan.push({
        ...franceConseilScope(year, documentType, currentYear),
        enabled: franceConseilScopeEnabled(year, documentType, environment, currentYear, options),
      });
    }
  }
  return plan;
}
