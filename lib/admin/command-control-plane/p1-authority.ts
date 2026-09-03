export const ADMIN_QUEUE_V3_WORKER_FLAG = "ADMIN_QUEUE_V3_WORKER_ENABLED";
export const ADMIN_QUEUE_V3_WORKER_COMMAND_TYPES_FLAG = "ADMIN_QUEUE_V3_WORKER_COMMAND_TYPES";
export const ADMIN_QUEUE_V3_WORKER_COHORTS_FLAG = "ADMIN_QUEUE_V3_WORKER_COHORTS";

export const ADMIN_QUEUE_P1_COMMAND_TYPES = [
  "p1.collect",
  "p1.summarize",
  "p1.candidate.retry",
  "p1.refresh-derived",
  "p1.public-cache.revalidate",
  "p1.case-backfill.discover",
  "p1.case-backfill.fetch",
  "p1.case-backfill.normalize",
  "p1.case-backfill.verify",
  "p1.case-backfill.publish",
  "p1.case-backfill.reconcile",
] as const;

export const ADMIN_QUEUE_P1_COHORTS = ["daily", "candidate-retry", "manual", "catalog-backfill", "catalog-enrichment"] as const;

export type AdminQueueP1CommandType = (typeof ADMIN_QUEUE_P1_COMMAND_TYPES)[number];
export type AdminQueueP1Cohort = (typeof ADMIN_QUEUE_P1_COHORTS)[number];

export type AdminQueueP1Authority =
  | { enabled: false; reason: "flag_disabled" }
  | {
      enabled: true;
      commandTypes: AdminQueueP1CommandType[];
      cohorts: AdminQueueP1Cohort[];
    }
  | { enabled: false; reason: "invalid_allowlist"; invalidValues: string[] };

function explicitTrue(value?: string) {
  return value?.trim().toLowerCase() === "true";
}

function parseAllowlist<T extends string>(raw: string | undefined, allowed: readonly T[]) {
  const values = [...new Set((raw ?? "").split(",").map((value) => value.trim()).filter(Boolean))];
  const invalidValues = values.filter((value) => !allowed.includes(value as T));
  if (values.length === 0 || values.length > allowed.length) invalidValues.push("__allowlist_bounds__");
  return { values: values as T[], invalidValues };
}

export function resolveAdminQueueP1Authority(
  environment: Record<string, string | undefined> = process.env,
): AdminQueueP1Authority {
  if (!explicitTrue(environment[ADMIN_QUEUE_V3_WORKER_FLAG])) {
    return { enabled: false, reason: "flag_disabled" };
  }

  const commandTypes = parseAllowlist(environment[ADMIN_QUEUE_V3_WORKER_COMMAND_TYPES_FLAG], ADMIN_QUEUE_P1_COMMAND_TYPES);
  const cohorts = parseAllowlist(environment[ADMIN_QUEUE_V3_WORKER_COHORTS_FLAG], ADMIN_QUEUE_P1_COHORTS);
  const invalidValues = [...commandTypes.invalidValues, ...cohorts.invalidValues];
  if (invalidValues.length > 0) return { enabled: false, reason: "invalid_allowlist", invalidValues };

  return { enabled: true, commandTypes: commandTypes.values, cohorts: cohorts.values };
}

export function adminQueueP1CommandAuthorized(
  authority: AdminQueueP1Authority,
  commandType: string,
  payloadRef: Record<string, unknown>,
) {
  if (!authority.enabled) return false;
  const cohort = typeof payloadRef.cohort === "string" ? payloadRef.cohort : "";
  return authority.commandTypes.includes(commandType as AdminQueueP1CommandType)
    && authority.cohorts.includes(cohort as AdminQueueP1Cohort);
}
