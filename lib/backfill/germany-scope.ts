export const CASE_CATALOG_GERMANY_HISTORY_FLAG = "CASE_CATALOG_GERMANY_HISTORY_ENABLED";
export const GERMANY_BVERFG_HISTORY_START_YEAR = 1998;
export const GERMANY_BVERFG_DOCUMENT_TYPE = "DECISION" as const;

function explicitTrue(value?: string) {
  return value?.trim().toLowerCase() === "true";
}

export function germanyBverfgYearSupported(
  year: number,
  currentYear = new Date().getUTCFullYear(),
) {
  return Number.isInteger(year)
    && Number.isInteger(currentYear)
    && year >= GERMANY_BVERFG_HISTORY_START_YEAR
    && year <= currentYear;
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
    && explicitTrue(environment[CASE_CATALOG_GERMANY_HISTORY_FLAG]);
}

export function assertGermanyBverfgYearEnabled(
  year: number,
  environment: Record<string, string | undefined> = process.env,
  currentYear = new Date().getUTCFullYear(),
) {
  germanyBverfgYearScope(year, currentYear);
  if (!explicitTrue(environment[CASE_CATALOG_GERMANY_HISTORY_FLAG])) {
    throw new Error("case_backfill.germany_history_disabled");
  }
}

export function germanyBverfgExpansionPlan(
  environment: Record<string, string | undefined> = process.env,
  currentYear = new Date().getUTCFullYear(),
) {
  const plan: Array<ReturnType<typeof germanyBverfgYearScope> & { enabled: boolean }> = [];
  for (let year = currentYear; year >= GERMANY_BVERFG_HISTORY_START_YEAR; year -= 1) {
    plan.push({
      ...germanyBverfgYearScope(year, currentYear),
      enabled: germanyBverfgYearEnabled(year, environment, currentYear),
    });
  }
  return plan;
}
