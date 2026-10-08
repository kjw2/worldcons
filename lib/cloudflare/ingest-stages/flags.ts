/**
 * Feature flags for the staged ingestion pipeline (M0). All default OFF.
 *
 * A rollout must set BOTH:
 *   1. `WORLDCONS_INGEST_STAGES_ENABLED=true` (master switch), and
 *   2. a non-empty, valid `WORLDCONS_INGEST_STAGE_ALLOWLIST`.
 *
 * The allowlist can only narrow, never widen, what the master switch permits,
 * and an unset/empty/invalid allowlist while the master switch is on resolves
 * to "denied for every stage" (fail closed) — enabling the pipeline must never
 * implicitly enable all stages.
 *
 * Production-only: unless `WORLDCONS_INGEST_STAGE_ENVIRONMENT` is explicitly
 * `production`, the pipeline is disabled. Preview/Staging/Vercel/Supabase
 * environments can never run the new path.
 */
import {
  INGEST_STAGE_NAMES,
  isIngestStage,
  type IngestStage,
} from "./contracts";

export const INGEST_STAGES_ENABLED_FLAG = "WORLDCONS_INGEST_STAGES_ENABLED";
export const INGEST_STAGE_ALLOWLIST_FLAG = "WORLDCONS_INGEST_STAGE_ALLOWLIST";
export const INGEST_STAGE_ENVIRONMENT_FLAG = "WORLDCONS_INGEST_STAGE_ENVIRONMENT";

/**
 * Safe canary bootstrap: only explicitly named, recognized source adapters
 * are permitted. Missing/unknown names seed nothing (fail closed). The stage
 * dispatcher can still process previously registered jobs independently.
 */
export function resolveIngestBootstrapSources(
  raw: string | null | undefined,
  supported: readonly string[],
): string[] {
  const names = (raw ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  if (!names.length || names.some((item) => !supported.includes(item))) return [];
  return [...new Set(names)];
}

/** Sentinel used by the allowlist to opt into every known stage. */
export const INGEST_STAGE_ALLOWLIST_ANY = "*" as const;

function explicitTrue(value?: string) {
  return value?.trim().toLowerCase() === "true";
}

export interface IngestStageAllowlistPolicy {
  any: boolean;
  stages: readonly IngestStage[];
  raw: string;
  valid: boolean;
  reason?: string;
}

/**
 * Parses the allowlist. Semantics mirror `parseM8EnabledKinds`:
 * - comma-separated exact stage names, whitespace trimmed, empty entries ignored;
 * - `*` alone means every stage;
 * - empty/whitespace-only is invalid;
 * - an unknown stage, or `*` mixed with explicit stages, is invalid.
 */
export function parseIngestStageAllowlist(raw: string | undefined | null): IngestStageAllowlistPolicy {
  const value = (raw ?? "").trim();
  if (value === "") {
    return { any: false, stages: [], raw: value, valid: false, reason: "ingest_stage.allowlist_empty" };
  }
  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) {
    return { any: false, stages: [], raw: value, valid: false, reason: "ingest_stage.allowlist_empty" };
  }
  if (entries.includes(INGEST_STAGE_ALLOWLIST_ANY)) {
    if (entries.length !== 1) {
      return { any: false, stages: [], raw: value, valid: false, reason: "ingest_stage.allowlist_wildcard_mixed" };
    }
    return { any: true, stages: [...INGEST_STAGE_NAMES], raw: value, valid: true };
  }
  const unknown = entries.filter((entry) => !isIngestStage(entry));
  if (unknown.length > 0) {
    return {
      any: false,
      stages: [],
      raw: value,
      valid: false,
      reason: `ingest_stage.allowlist_unknown:${unknown.join("|")}`,
    };
  }
  const stages = [...new Set(entries as IngestStage[])];
  return { any: false, stages, raw: value, valid: true };
}

export interface IngestStageRolloutGate {
  masterEnabled: boolean;
  productionEnvironment: boolean;
  policy: IngestStageAllowlistPolicy;
  /** Raw environment name as supplied; informational only. */
  environment: string;
}

/**
 * Resolves the combined rollout gate. The gate is closed unless the master
 * switch is on, the environment is production, and the allowlist is valid.
 */
export function resolveIngestStageRolloutGate(
  masterEnabled: boolean,
  environment: string | undefined | null,
  allowlist: string | undefined | null,
): IngestStageRolloutGate {
  const env = (environment ?? "").trim().toLowerCase();
  return {
    masterEnabled,
    productionEnvironment: env === "production",
    policy: parseIngestStageAllowlist(allowlist),
    environment: env,
  };
}

/** True only when the whole gate is open for the given stage. */
export function isIngestStageEnabled(gate: IngestStageRolloutGate, stage: IngestStage): boolean {
  if (!gate.masterEnabled || !gate.productionEnvironment || !gate.policy.valid) return false;
  return gate.policy.any || gate.policy.stages.includes(stage);
}

/**
 * Reads the gate from an environment record. Default OFF: an unset master switch
 * disables every stage.
 */
export function ingestStageGateFromEnvironment(
  environment: Record<string, string | undefined> = process.env,
): IngestStageRolloutGate {
  return resolveIngestStageRolloutGate(
    explicitTrue(environment[INGEST_STAGES_ENABLED_FLAG]),
    environment[INGEST_STAGE_ENVIRONMENT_FLAG],
    environment[INGEST_STAGE_ALLOWLIST_FLAG],
  );
}

/**
 * Configuration errors surfaced to operators. A master switch on without a valid
 * allowlist is a misconfiguration and reported rather than silently denied.
 */
export function ingestStageFlagErrors(
  environment: Record<string, string | undefined> = process.env,
): string[] {
  const errors: string[] = [];
  const master = explicitTrue(environment[INGEST_STAGES_ENABLED_FLAG]);
  if (!master) return errors;
  const env = (environment[INGEST_STAGE_ENVIRONMENT_FLAG] ?? "").trim().toLowerCase();
  if (env !== "production") {
    errors.push(`${INGEST_STAGES_ENABLED_FLAG} requires ${INGEST_STAGE_ENVIRONMENT_FLAG}=production`);
  }
  const policy = parseIngestStageAllowlist(environment[INGEST_STAGE_ALLOWLIST_FLAG]);
  if (!policy.valid) {
    errors.push(`${INGEST_STAGES_ENABLED_FLAG} requires a valid ${INGEST_STAGE_ALLOWLIST_FLAG} (${policy.reason})`);
  }
  return errors;
}
