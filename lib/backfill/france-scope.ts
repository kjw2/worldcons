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
export const FRANCE_CONSEIL_POLICY_VERSION_V3 = "france-dila-constit-2026-09-v3";
/**
 * `france-dila-constit-2026-09-v3` is the current reviewed successor for future
 * discovery. It keeps the exact v1/v2 scope (2010-2024 QPC/DC, DILA-ID stable
 * identity) and adds only the owner-approved exact-tuple exceptions that the
 * official sources require:
 *   - the v2 2022 DC E1 omission fallback and 2022 QPC E2 canonicalization stay
 *     recognized through v2;
 *   - v3 adds exactly six 2017 QPC E1 omission fallbacks.
 * `france-dila-constit-2026-09-v1` and `...-v2` stay immutable and continue to
 * bind the already-closed snapshots.
 */
export const FRANCE_CONSEIL_APPROVED_POLICY_VERSION = FRANCE_CONSEIL_POLICY_VERSION_V3;
export const FRANCE_CONSEIL_APPROVED_POLICY_REVIEW_DUE_AT = "2027-03-15";
export const FRANCE_CONSEIL_PRIOR_POLICY_VERSIONS = [
  FRANCE_CONSEIL_POLICY_VERSION_V1,
  FRANCE_CONSEIL_POLICY_VERSION_V2,
] as const;
/**
 * The WorldCons owner explicitly approved the France DILA/Conseil QPC/DC source
 * policy on 2026-09-16, scoped only to the 2010-2024 QPC/DC tranches. On
 * 2026-09-16 the owner additionally approved BOTH v2 proposal exceptions E1
 * (single Conseil-provider omission fallback for 2022 DC `2022847DC`) and E2
 * (single DILA canonicalization pair for 2022 QPC `20225813AN_QPC`). On
 * 2026-09-17 the owner directed continuation through 2010 and approved the
 * deterministic 2017 QPC DILA-omission resolution as the additive successor
 * `france-dila-constit-2026-09-v3` (six exact Conseil-only omission tuples).
 * The approval is recorded here as reviewed policy metadata only; execution
 * still requires the exact `CASE_CATALOG_FRANCE_HISTORY_ENABLED` flag, so the
 * env flag is never sufficient on its own and no runtime env-only bypass is
 * introduced.
 */
export const FRANCE_CONSEIL_HISTORY_SOURCE_POLICY_APPROVED = true;

export type FranceConseilDocumentType = (typeof FRANCE_CONSEIL_DOCUMENT_TYPES)[number];
export type FranceConseilPolicyVersion =
  | typeof FRANCE_CONSEIL_POLICY_VERSION_V1
  | typeof FRANCE_CONSEIL_POLICY_VERSION_V2
  | typeof FRANCE_CONSEIL_POLICY_VERSION_V3;

/**
 * E1 — an owner-approved Conseil-provider fallback for a decision that the
 * official DILA CONSTIT stock plus every ordered increment verifiably omits.
 * Every field is an exact literal; there is no wildcard, prefix, year range, or
 * nature-wide rule, and the fallback can never masquerade as a DILA-derived
 * item. `nor` is the official JORF NOR when the official Conseil detail page
 * publishes it; when the page does not publish a NOR the frozen `ecli` is the
 * deterministic secondary absence cross-check and `nor` is null.
 */
export interface FranceConseilOmissionException {
  readonly exceptionId: "e1_conseil_provider_fallback";
  readonly sourceKey: "fr-conseil-constitutionnel";
  readonly year: number;
  readonly documentType: FranceConseilDocumentType;
  readonly sourceRecordId: string;
  readonly provider: "conseil";
  readonly reasonCode: "dila_omission_verified_absent";
  readonly authorityUrl: string;
  readonly stableItemKey: string;
  readonly conseil: {
    readonly ecli: string;
    readonly decisionNumber: string;
    readonly decisionDate: string;
    readonly jorf: string;
    readonly nor: string | null;
    readonly authorityTitle: string;
    readonly authorityDescription: string;
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
    authorityTitle: "Décision n° 2022-847 DC du 29 décembre 2022",
    authorityDescription: "Loi de finances pour 2023",
  }),
});

/**
 * The six exact 2017 QPC decisions that the official Conseil annual/type facet
 * publishes but the DILA CONSTIT stock plus every ordered increment verifiably
 * omit (identity and ECLI both absent from all scanned members). Every field is
 * frozen from the official Conseil detail page and the v3 discovery recomputes
 * the per-discover absence proof; no year-wide, type-wide, or general fallback
 * exists.
 */
export const FRANCE_CONSEIL_V3_OMISSION_EXCEPTIONS: readonly FranceConseilOmissionException[] = Object.freeze([
  Object.freeze({
    exceptionId: "e1_conseil_provider_fallback",
    sourceKey: "fr-conseil-constitutionnel",
    year: 2017,
    documentType: "QPC",
    sourceRecordId: "2016613QPC",
    provider: "conseil",
    reasonCode: "dila_omission_verified_absent",
    authorityUrl: "https://www.conseil-constitutionnel.fr/decision/2017/2016613QPC.htm",
    stableItemKey: "constit:conseil-omission:2016613qpc",
    conseil: Object.freeze({
      ecli: "ECLI:FR:CC:2017:2016.613.QPC",
      decisionNumber: "2016-613",
      decisionDate: "2017-02-24",
      jorf: "JORF n°0048 du 25 février 2017 texte n° 122",
      nor: null,
      authorityTitle: "Décision n° 2016-613 QPC du 24 février 2017",
      authorityDescription: "Département d'Ille-et-Vilaine [Recours subrogatoire des départements servant des prestations sociales]",
    }),
  }),
  Object.freeze({
    exceptionId: "e1_conseil_provider_fallback",
    sourceKey: "fr-conseil-constitutionnel",
    year: 2017,
    documentType: "QPC",
    sourceRecordId: "2017663QPC",
    provider: "conseil",
    reasonCode: "dila_omission_verified_absent",
    authorityUrl: "https://www.conseil-constitutionnel.fr/decision/2017/2017663QPC.htm",
    stableItemKey: "constit:conseil-omission:2017663qpc",
    conseil: Object.freeze({
      ecli: "ECLI:FR:CC:2017:2017.663.QPC",
      decisionNumber: "2017-663",
      decisionDate: "2017-10-19",
      jorf: "JORF n° 2048 du 22 octobre 2017",
      nor: null,
      authorityTitle: "Décision n° 2017-663 QPC du 19 octobre 2017",
      authorityDescription: "Époux T. [Exonération d'impôt sur le revenu de l'indemnité compensatrice de cessation de mandat d'un agent général d'assurances II]",
    }),
  }),
  Object.freeze({
    exceptionId: "e1_conseil_provider_fallback",
    sourceKey: "fr-conseil-constitutionnel",
    year: 2017,
    documentType: "QPC",
    sourceRecordId: "2017664QPC",
    provider: "conseil",
    reasonCode: "dila_omission_verified_absent",
    authorityUrl: "https://www.conseil-constitutionnel.fr/decision/2017/2017664QPC.htm",
    stableItemKey: "constit:conseil-omission:2017664qpc",
    conseil: Object.freeze({
      ecli: "ECLI:FR:CC:2017:2017.664.QPC",
      decisionNumber: "2017-664",
      decisionDate: "2017-10-20",
      jorf: "JORF n°0248 du 22 octobre 2017, texte n° 33",
      nor: null,
      authorityTitle: "Décision n° 2017-664 QPC du 20 octobre 2017",
      authorityDescription: "Confédération générale du travail - Force ouvrière [Conditions d'organisation de la consultation des salariés sur un accord minoritaire d'entreprise ou d'établissement]",
    }),
  }),
  Object.freeze({
    exceptionId: "e1_conseil_provider_fallback",
    sourceKey: "fr-conseil-constitutionnel",
    year: 2017,
    documentType: "QPC",
    sourceRecordId: "2017665QPC",
    provider: "conseil",
    reasonCode: "dila_omission_verified_absent",
    authorityUrl: "https://www.conseil-constitutionnel.fr/decision/2017/2017665QPC.htm",
    stableItemKey: "constit:conseil-omission:2017665qpc",
    conseil: Object.freeze({
      ecli: "ECLI:FR:CC:2017:2017.665.QPC",
      decisionNumber: "2017-665",
      decisionDate: "2017-10-20",
      jorf: "JORF n°0248 du 22 octobre 2017, texte n° 34",
      nor: null,
      authorityTitle: "Décision n° 2017-665 QPC du 20 octobre 2017",
      authorityDescription: "Confédération générale du travail - Force ouvrière [Licenciement en cas de refus d'application d'un accord en vue de la préservation ou du développement de l'emploi]",
    }),
  }),
  Object.freeze({
    exceptionId: "e1_conseil_provider_fallback",
    sourceKey: "fr-conseil-constitutionnel",
    year: 2017,
    documentType: "QPC",
    sourceRecordId: "2017666QPC",
    provider: "conseil",
    reasonCode: "dila_omission_verified_absent",
    authorityUrl: "https://www.conseil-constitutionnel.fr/decision/2017/2017666QPC.htm",
    stableItemKey: "constit:conseil-omission:2017666qpc",
    conseil: Object.freeze({
      ecli: "ECLI:FR:CC:2017:2017.666.QPC",
      decisionNumber: "2017-666",
      decisionDate: "2017-10-20",
      jorf: "JORF n°0248 du 22 octobre 2017, texte n° 35",
      nor: null,
      authorityTitle: "Décision n° 2017-666 QPC du 20 octobre 2017",
      authorityDescription: "M. Jean-Marc L. [Compétence du vice-président du Conseil d'État pour établir la charte de déontologie de la juridiction administrative]",
    }),
  }),
  Object.freeze({
    exceptionId: "e1_conseil_provider_fallback",
    sourceKey: "fr-conseil-constitutionnel",
    year: 2017,
    documentType: "QPC",
    sourceRecordId: "2017670QPC",
    provider: "conseil",
    reasonCode: "dila_omission_verified_absent",
    authorityUrl: "https://www.conseil-constitutionnel.fr/decision/2017/2017670QPC.htm",
    stableItemKey: "constit:conseil-omission:2017670qpc",
    conseil: Object.freeze({
      ecli: "ECLI:FR:CC:2017:2017.670.QPC",
      decisionNumber: "2017-670",
      decisionDate: "2017-10-27",
      jorf: "JORF n°0254 du 29 octobre 2017 texte n° 38",
      nor: null,
      authorityTitle: "Décision n° 2017-670 QPC du 27 octobre 2017",
      authorityDescription: "M. Mikhail P. [Effacement anticipé des données à caractère personnel inscrites dans un fichier de traitement d'antécédents judiciaires]",
    }),
  }),
]);

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
    supersedesPolicyVersion: FRANCE_CONSEIL_POLICY_VERSION_V2,
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
 * Recognizes exactly the three immutable France policy versions. v1/v2 stay
 * recognized so their closed snapshots keep resolving, while v3 is the current
 * reviewed successor.
 */
export function franceConseilPolicyVersionRecognized(
  value: string | null | undefined,
): value is FranceConseilPolicyVersion {
  return value === FRANCE_CONSEIL_POLICY_VERSION_V1
    || value === FRANCE_CONSEIL_POLICY_VERSION_V2
    || value === FRANCE_CONSEIL_POLICY_VERSION_V3;
}

/**
 * The exception set is intentionally exact and policy-version-gated. No
 * wildcard, year-range, or "same year/type" fallback is representable here.
 *
 * - v2 exposes only the 2022 DC E1 tuple.
 * - v3 exposes exactly the six 2017 QPC E1 tuples.
 */
export function franceConseilOmissionExceptionsFor(
  year: number,
  documentType: string,
  policyVersion: string | null | undefined,
): readonly FranceConseilOmissionException[] {
  const normalizedType = franceConseilDocumentType(documentType);
  if (!normalizedType) return [];
  if (policyVersion === FRANCE_CONSEIL_POLICY_VERSION_V2) {
    if (year === FRANCE_CONSEIL_V2_E1_EXCEPTION.year
      && normalizedType === FRANCE_CONSEIL_V2_E1_EXCEPTION.documentType) {
      return [FRANCE_CONSEIL_V2_E1_EXCEPTION];
    }
    return [];
  }
  if (policyVersion === FRANCE_CONSEIL_POLICY_VERSION_V3) {
    return FRANCE_CONSEIL_V3_OMISSION_EXCEPTIONS.filter((exception) => (
      exception.year === year && exception.documentType === normalizedType
    ));
  }
  return [];
}

/**
 * Single-exception accessor retained for the v2 contract and its tests. Returns
 * null when the exact (year, type, policy) tuple does not identify exactly one
 * approved exception.
 */
export function franceConseilOmissionExceptionFor(
  year: number,
  documentType: string,
  policyVersion: string | null | undefined,
): FranceConseilOmissionException | null {
  const exceptions = franceConseilOmissionExceptionsFor(year, documentType, policyVersion);
  return exceptions.length === 1 ? exceptions[0] : null;
}

/**
 * The v2/v3 E2 canonicalization is recognized for both immutable successors so
 * a future re-run under v3 preserves the approved 2022 canonicalization.
 */
export function franceConseilDilaCanonicalizationsFor(
  year: number,
  documentType: string,
  policyVersion: string | null | undefined,
): readonly FranceConseilDilaCanonicalizationException[] {
  if (policyVersion !== FRANCE_CONSEIL_POLICY_VERSION_V2
    && policyVersion !== FRANCE_CONSEIL_POLICY_VERSION_V3) return [];
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
