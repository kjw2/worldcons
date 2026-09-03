export const CASE_CATALOG_SPAIN_HISTORY_FLAG = "CASE_CATALOG_SPAIN_HISTORY_ENABLED";
export const SPAIN_SENTENCIA_BASELINE_YEAR = 2024;
export const SPAIN_SENTENCIA_HISTORY_START_YEAR = 2020;
export const SPAIN_SENTENCIA_HISTORY_YEARS = [2020,2021,2022,2023] as const;
export const SPAIN_SENTENCIA_SUPPORTED_YEARS = [2020,2021,2022,2023,2024] as const;

function explicitTrue(value?: string) {
  return value?.trim().toLowerCase() === "true";
}

export function spainSentenciaYearSupported(year: number) {
  return Number.isInteger(year) && (SPAIN_SENTENCIA_SUPPORTED_YEARS as readonly number[]).includes(year);
}

export function spainSentenciaYearEnabled(
  year: number,
  environment: Record<string, string | undefined> = process.env,
) {
  if (!spainSentenciaYearSupported(year)) return false;
  return year === SPAIN_SENTENCIA_BASELINE_YEAR || explicitTrue(environment[CASE_CATALOG_SPAIN_HISTORY_FLAG]);
}

export function assertSpainSentenciaYearEnabled(
  year: number,
  environment: Record<string, string | undefined> = process.env,
) {
  if (!spainSentenciaYearSupported(year)) throw new Error("case_backfill.spain_year_not_supported");
  if (!spainSentenciaYearEnabled(year, environment)) throw new Error("case_backfill.spain_history_disabled");
}

export function spainSentenciaYearScope(year: number) {
  if (!spainSentenciaYearSupported(year)) throw new Error("case_backfill.spain_year_not_supported");
  return {
    year,
    scopeFrom: `${year}-01-01`,
    scopeTo: `${year}-12-31`,
    documentType: "SENTENCIA" as const,
  };
}

export function spainSentenciaExpansionPlan(
  environment: Record<string, string | undefined> = process.env,
) {
  return SPAIN_SENTENCIA_SUPPORTED_YEARS.map((year) => ({
    ...spainSentenciaYearScope(year),
    baseline: year === SPAIN_SENTENCIA_BASELINE_YEAR,
    enabled: spainSentenciaYearEnabled(year, environment),
  }));
}
