export const CASE_CATALOG_SPAIN_HISTORY_FLAG = "CASE_CATALOG_SPAIN_HISTORY_ENABLED";
export const SPAIN_SENTENCIA_BASELINE_YEAR = 2024;
export const SPAIN_SENTENCIA_HISTORY_START_YEAR = 2020;
export const SPAIN_SENTENCIA_HISTORY_YEARS = [2020,2021,2022,2023] as const;
export const SPAIN_SENTENCIA_SUPPORTED_YEARS = [2020,2021,2022,2023,2024] as const;
export const SPAIN_SENTENCIA_HISTORY_SOURCE_POLICY_STATUS = "blocked_pending_legal_robots_review" as const;
/**
 * The Spain HJ source policy review returned `BLOCKED`: `robots.txt` is 404 and
 * the legal notice is 403, so the history flag alone must never authorize
 * historical execution. The 2024 Gate 1 baseline keeps its no-history-flag
 * semantics, but it is also blocked until source-policy approval is explicit.
 */
export const SPAIN_SENTENCIA_HISTORY_SOURCE_POLICY_APPROVED = false;

export interface SpainSentenciaScopeOptions {
  policyApproved?: boolean;
}

function explicitTrue(value?: string) {
  return value?.trim().toLowerCase() === "true";
}

export function spainSentenciaYearSupported(year: number) {
  return Number.isInteger(year) && (SPAIN_SENTENCIA_SUPPORTED_YEARS as readonly number[]).includes(year);
}

export function spainSentenciaHistorySourcePolicyApproved() {
  return SPAIN_SENTENCIA_HISTORY_SOURCE_POLICY_APPROVED;
}

export function spainSentenciaYearEnabled(
  year: number,
  environment: Record<string, string | undefined> = process.env,
  options: SpainSentenciaScopeOptions = {},
) {
  if (!spainSentenciaYearSupported(year)) return false;
  const approved = options.policyApproved ?? SPAIN_SENTENCIA_HISTORY_SOURCE_POLICY_APPROVED;
  if (!approved) return false;
  if (year === SPAIN_SENTENCIA_BASELINE_YEAR) return true;
  return explicitTrue(environment[CASE_CATALOG_SPAIN_HISTORY_FLAG]);
}

export function assertSpainSentenciaYearEnabled(
  year: number,
  environment: Record<string, string | undefined> = process.env,
  options: SpainSentenciaScopeOptions = {},
) {
  if (!spainSentenciaYearSupported(year)) throw new Error("case_backfill.spain_year_not_supported");
  const approved = options.policyApproved ?? SPAIN_SENTENCIA_HISTORY_SOURCE_POLICY_APPROVED;
  if (year === SPAIN_SENTENCIA_BASELINE_YEAR) {
    if (!approved) throw new Error("case_backfill.spain_history_source_blocked");
    return;
  }
  if (!explicitTrue(environment[CASE_CATALOG_SPAIN_HISTORY_FLAG])) {
    throw new Error("case_backfill.spain_history_disabled");
  }
  if (!approved) throw new Error("case_backfill.spain_history_source_blocked");
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
  options: SpainSentenciaScopeOptions = {},
) {
  return SPAIN_SENTENCIA_SUPPORTED_YEARS.map((year) => ({
    ...spainSentenciaYearScope(year),
    baseline: year === SPAIN_SENTENCIA_BASELINE_YEAR,
    enabled: spainSentenciaYearEnabled(year, environment, options),
  }));
}
