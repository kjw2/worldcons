export const CASE_CATALOG_FRANCE_HISTORY_FLAG = "CASE_CATALOG_FRANCE_HISTORY_ENABLED";
export const FRANCE_CONSEIL_HISTORY_START_YEAR = 2010;
export const FRANCE_CONSEIL_DOCUMENT_TYPES = ["QPC", "DC"] as const;

export type FranceConseilDocumentType = (typeof FRANCE_CONSEIL_DOCUMENT_TYPES)[number];

function explicitTrue(value?: string) {
  return value?.trim().toLowerCase() === "true";
}

export function franceConseilYearSupported(year: number, currentYear = new Date().getUTCFullYear()) {
  return Number.isInteger(year)
    && Number.isInteger(currentYear)
    && year >= FRANCE_CONSEIL_HISTORY_START_YEAR
    && year <= currentYear;
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
) {
  try {
    franceConseilScope(year, documentType, currentYear);
    return explicitTrue(environment[CASE_CATALOG_FRANCE_HISTORY_FLAG]);
  } catch {
    return false;
  }
}

export function assertFranceConseilScopeEnabled(
  year: number,
  documentType: string,
  environment: Record<string, string | undefined> = process.env,
  currentYear = new Date().getUTCFullYear(),
) {
  franceConseilScope(year, documentType, currentYear);
  if (!explicitTrue(environment[CASE_CATALOG_FRANCE_HISTORY_FLAG])) {
    throw new Error("case_backfill.france_history_disabled");
  }
}

export function franceConseilExpansionPlan(
  environment: Record<string, string | undefined> = process.env,
  currentYear = new Date().getUTCFullYear(),
) {
  const plan: Array<ReturnType<typeof franceConseilScope> & { enabled: boolean }> = [];
  for (let year = FRANCE_CONSEIL_HISTORY_START_YEAR; year <= currentYear; year += 1) {
    for (const documentType of FRANCE_CONSEIL_DOCUMENT_TYPES) {
      plan.push({
        ...franceConseilScope(year, documentType, currentYear),
        enabled: franceConseilScopeEnabled(year, documentType, environment, currentYear),
      });
    }
  }
  return plan;
}
