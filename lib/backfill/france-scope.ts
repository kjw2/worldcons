import {
  assertHistoricalGateYear,
  HISTORICAL_GATE_MAX_YEAR,
} from "@/lib/backfill/country-history-policy";

export const CASE_CATALOG_FRANCE_HISTORY_FLAG = "CASE_CATALOG_FRANCE_HISTORY_ENABLED";
export const FRANCE_CONSEIL_HISTORY_START_YEAR = 2010;
export const FRANCE_CONSEIL_DOCUMENT_TYPES = ["QPC", "DC"] as const;
export const FRANCE_CONSEIL_HISTORY_SOURCE_POLICY_STATUS = "pending_owner_approval" as const;
/**
 * The France DILA/Conseil source policy review identified no human
 * `reviewed_by`, `review_due_at`, or retention decision, so no immutable policy
 * row is approved. The env flag must never be sufficient on its own.
 */
export const FRANCE_CONSEIL_HISTORY_SOURCE_POLICY_APPROVED = false;

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
