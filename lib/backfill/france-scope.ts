import {
  assertHistoricalGateYear,
  HISTORICAL_GATE_MAX_YEAR,
} from "@/lib/backfill/country-history-policy";

export const CASE_CATALOG_FRANCE_HISTORY_FLAG = "CASE_CATALOG_FRANCE_HISTORY_ENABLED";
export const FRANCE_CONSEIL_HISTORY_START_YEAR = 2010;
export const FRANCE_CONSEIL_HISTORY_END_YEAR = 2024;
export const FRANCE_CONSEIL_DOCUMENT_TYPES = ["QPC", "DC"] as const;
export const FRANCE_CONSEIL_HISTORY_SOURCE_POLICY_STATUS = "approved_source_policy" as const;
export const FRANCE_CONSEIL_POLICY_VERSION_V1 = "france-dila-constit-2026-09-v1";
export const FRANCE_CONSEIL_POLICY_VERSION_V2 = "france-dila-constit-2026-09-v2";
/**
 * `france-dila-constit-2026-09-v2` is the current reviewed successor for future
 * discovery. It keeps the exact v1 scope (2010-2024 QPC/DC, DILA-ID stable
 * identity) and adds only the two owner-approved exact-tuple exceptions (E1/E2).
 * `france-dila-constit-2026-09-v1` stays immutable and continues to bind the
 * already-closed 2024/2023 snapshots.
 */
export const FRANCE_CONSEIL_APPROVED_POLICY_VERSION = FRANCE_CONSEIL_POLICY_VERSION_V2;
export const FRANCE_CONSEIL_APPROVED_POLICY_REVIEW_DUE_AT = "2027-03-15";
export const FRANCE_CONSEIL_PRIOR_POLICY_VERSIONS = [FRANCE_CONSEIL_POLICY_VERSION_V1] as const;
/**
 * The WorldCons owner explicitly approved the France DILA/Conseil QPC/DC source
 * policy on 2026-09-16, scoped only to the 2010-2024 QPC/DC tranches. On
 * 2026-09-16 the owner additionally approved BOTH v2 proposal exceptions E1
 * (single Conseil-provider omission fallback for 2022 DC `2022847DC`) and E2
 * (single DILA canonicalization pair for 2022 QPC `20225813AN_QPC`). The
 * immutable v1 row is inserted by migration
 * `20260916090000_constitutional_case_france_policy_approval.sql`, and the
 * immutable v2 successor row is inserted by a new additive migration. The
 * approval is recorded here as reviewed policy metadata only; execution still
 * requires the exact `CASE_CATALOG_FRANCE_HISTORY_ENABLED` flag, so the env flag
 * is never sufficient on its own and no runtime env-only bypass is introduced.
 */
export const FRANCE_CONSEIL_HISTORY_SOURCE_POLICY_APPROVED = true;

export type FranceConseilDocumentType = (typeof FRANCE_CONSEIL_DOCUMENT_TYPES)[number];
export type FranceConseilPolicyVersion =
  | typeof FRANCE_CONSEIL_POLICY_VERSION_V1
  | typeof FRANCE_CONSEIL_POLICY_VERSION_V2;

/**
 * E1 — the single owner-approved Conseil-provider fallback (2022 DC
 * `2022847DC`). Every field is an exact literal; there is no wildcard, prefix,
 * year range, or nature-wide rule, and the fallback can never masquerade as a
 * DILA-derived item.
 */
export interface FranceConseilOmissionException {
  readonly exceptionId: "e1_conseil_provider_fallback";
  readonly sourceKey: "fr-conseil-constitutionnel";
  readonly year: 2022;
  readonly documentType: "DC";
  readonly sourceRecordId: "2022847DC";
  readonly provider: "conseil";
  readonly reasonCode: "dila_omission_verified_absent";
  readonly authorityUrl: "https://www.conseil-constitutionnel.fr/decision/2022/2022847DC.htm";
  readonly stableItemKey: "constit:conseil-omission:2022847dc";
  readonly conseil: {
    readonly ecli: "ECLI:FR:CC:2022:2022.847.DC";
    readonly decisionNumber: "2022-847";
    readonly decisionDate: "2022-12-29";
    readonly jorf: "JORF n°0303 du 31 décembre 2022, texte n° 2";
    readonly nor: "CSCL2237744S";
  };
}

export const FRANCE_CONSEIL_V2_E1_EXCEPTION: FranceConseilOmissionException = Object.freeze({
  exceptionId: "e1_conseil_provider_fallback",
  sourceKey: "fr-conseil-constitutionnel",
  year: 2022,
  documentType: "DC",
  sourceRecordId: "2022847DC",
  provider: "conseil",
  reasonCode: "dila_omission_verified_absent",
  authorityUrl: "https://www.conseil-constitutionnel.fr/decision/2022/2022847DC.htm",
  stableItemKey: "constit:conseil-omission:2022847dc",
  conseil: Object.freeze({
    ecli: "ECLI:FR:CC:2022:2022.847.DC",
    decisionNumber: "2022-847",
    decisionDate: "2022-12-29",
    jorf: "JORF n°0303 du 31 décembre 2022, texte n° 2",
    nor: "CSCL2237744S",
  }),
});

/**
 * E2 — the single owner-approved DILA canonicalization pair (2022 QPC
 * `20225813AN_QPC`). Direction is frozen and the retired DILA ID is provenance
 * evidence only; it never becomes a second inventory item.
 */
export interface FranceConseilDilaCanonicalizationException {
  readonly exceptionId: "e2_dila_canonicalization";
  readonly conseilRecordId: "20225813AN_QPC";
  readonly canonicalDilaId: "CONSTEXT000047955984";
  readonly retiredDilaId: "CONSTEXT000046216504";
  readonly basis: "matches_current_conseil_title_and_ecli";
  readonly expectedConseilTitle: "A.N., Français établis hors de France (2ème circ.), M. Christian RODRIGUEZ [ ]";
  readonly expectedConseilEcli: "ECLI:FR:CC:2022:2022.5813.AN.QPC";
}

export const FRANCE_CONSEIL_V2_E2_EXCEPTION: FranceConseilDilaCanonicalizationException = Object.freeze({
  exceptionId: "e2_dila_canonicalization",
  conseilRecordId: "20225813AN_QPC",
  canonicalDilaId: "CONSTEXT000047955984",
  retiredDilaId: "CONSTEXT000046216504",
  basis: "matches_current_conseil_title_and_ecli",
  expectedConseilTitle: "A.N., Français établis hors de France (2ème circ.), M. Christian RODRIGUEZ [ ]",
  expectedConseilEcli: "ECLI:FR:CC:2022:2022.5813.AN.QPC",
});

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
    supersedesPolicyVersion: FRANCE_CONSEIL_POLICY_VERSION_V1,
    priorPolicyVersions: [...FRANCE_CONSEIL_PRIOR_POLICY_VERSIONS],
    reviewDueAt: FRANCE_CONSEIL_APPROVED_POLICY_REVIEW_DUE_AT,
    documentTypes: [...FRANCE_CONSEIL_DOCUMENT_TYPES],
    approvedYearFrom: FRANCE_CONSEIL_HISTORY_START_YEAR,
    approvedYearTo: FRANCE_CONSEIL_HISTORY_END_YEAR,
    historyStartYear: FRANCE_CONSEIL_HISTORY_START_YEAR,
    historicalMaxYear: HISTORICAL_GATE_MAX_YEAR,
  };
}

/**
 * Recognizes exactly the two immutable France policy versions. v1 stays
 * recognized so its closed 2024/2023 snapshots keep resolving, while v2 is the
 * only version that may apply the owner-approved E1/E2 exceptions.
 */
export function franceConseilPolicyVersionRecognized(
  value: string | null | undefined,
): value is FranceConseilPolicyVersion {
  return value === FRANCE_CONSEIL_POLICY_VERSION_V1 || value === FRANCE_CONSEIL_POLICY_VERSION_V2;
}

/**
 * The v2 exception set is intentionally exact and policy-version-gated. No
 * wildcard, year-range, or "same year/type" fallback is representable here.
 */
export function franceConseilOmissionExceptionFor(
  year: number,
  documentType: string,
  policyVersion: string | null | undefined,
): FranceConseilOmissionException | null {
  if (policyVersion !== FRANCE_CONSEIL_POLICY_VERSION_V2) return null;
  if (year !== FRANCE_CONSEIL_V2_E1_EXCEPTION.year) return null;
  if (franceConseilDocumentType(documentType) !== FRANCE_CONSEIL_V2_E1_EXCEPTION.documentType) return null;
  return FRANCE_CONSEIL_V2_E1_EXCEPTION;
}

export function franceConseilDilaCanonicalizationsFor(
  year: number,
  documentType: string,
  policyVersion: string | null | undefined,
): readonly FranceConseilDilaCanonicalizationException[] {
  if (policyVersion !== FRANCE_CONSEIL_POLICY_VERSION_V2) return [];
  if (year !== 2022) return [];
  if (franceConseilDocumentType(documentType) !== "QPC") return [];
  return [FRANCE_CONSEIL_V2_E2_EXCEPTION];
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
