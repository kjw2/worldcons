import { assertNoForbiddenMigrationTooling } from "./apply-plan";
import { MIGRATION_VERSION } from "./migration-contract";
import { normalizeVersions } from "./migration-inventory";

/**
 * M7.8-A migration-history repair contract (operator-only, pure).
 *
 * `--record-history` reconciles the REMOTE Supabase migration ledger with the
 * schema that was already applied by the exact-SQL `supabase db query --linked`
 * path. It is NOT a schema-apply mechanism: the ledger entry is written only
 * after the exact migration bytes committed AND every post-apply validation/smoke
 * gate passed. The only allowed invocation is exactly
 * `supabase migration repair --linked --status applied 20260926120000`, and the
 * target version must then be re-read from `supabase_migrations.schema_migrations`
 * (with an optional `supabase migration list --linked` cross-check) before the
 * ledger is considered repaired.
 *
 * A failed repair or a ledger that does not show the target applied is reported
 * as `history_repair_failed`; the schema is deliberately never rolled back
 * automatically.
 */

/** The only migration-repair status M7.8-A may write. */
export const MIGRATION_REPAIR_STATUS = "applied" as const;

/** Human-readable, credential-free description of the only allowed repair tooling. */
export const MIGRATION_REPAIR_TOOLING =
  "supabase migration repair --linked --status applied" as const;

export const MIGRATION_REPAIR_ERROR_CODES = [
  "history_repair_not_applicable",
  "history_repair_before_apply",
  "history_repair_before_validation",
  "history_repair_invocation_invalid",
  "history_repair_failed",
] as const;

export type MigrationRepairErrorCode = (typeof MIGRATION_REPAIR_ERROR_CODES)[number];

export class MigrationRepairError extends Error {
  readonly code: MigrationRepairErrorCode;

  constructor(code: MigrationRepairErrorCode, message: string) {
    super(message);
    this.name = "MigrationRepairError";
    this.code = code;
  }
}

function isMigrationVersion(value: string): boolean {
  return /^\d{14}$/u.test(value);
}

/**
 * The exact `supabase migration repair` argv. The version is guarded as a
 * 14-digit timestamp, so no unguarded text can reach the command.
 */
export function buildMigrationRepairArgs(version: string = MIGRATION_VERSION): string[] {
  if (!isMigrationVersion(version)) {
    throw new MigrationRepairError(
      "history_repair_invocation_invalid",
      "the migration repair version must be a 14-digit timestamp",
    );
  }
  return ["migration", "repair", "--linked", "--status", MIGRATION_REPAIR_STATUS, version];
}

/**
 * Fails closed unless `argv` is EXACTLY the allowed repair invocation. Forbidden
 * schema-apply tooling (`db push`, `migration up`, `--include-all`) is rejected by
 * the same deny-list the apply plan uses, so `migration repair` can never smuggle
 * a schema apply.
 */
export function assertMigrationRepairInvocation(
  argv: readonly string[],
  version: string = MIGRATION_VERSION,
): void {
  const expected = buildMigrationRepairArgs(version);
  const matches = argv.length === expected.length && argv.every((token, index) => token === expected[index]);
  if (!matches) {
    throw new MigrationRepairError(
      "history_repair_invocation_invalid",
      `the history repair invocation must be exactly \`${MIGRATION_REPAIR_TOOLING} ${version}\``,
    );
  }
  assertNoForbiddenMigrationTooling(argv);
}

/** True when an argv is exactly the allowed repair invocation. */
export function isMigrationRepairInvocation(
  argv: readonly string[],
  version: string = MIGRATION_VERSION,
): boolean {
  try {
    assertMigrationRepairInvocation(argv, version);
    return true;
  } catch {
    return false;
  }
}

/**
 * `--record-history` is a post-apply ledger reconciliation: it is only valid
 * with `--apply`. Any other mode (dry-run, preflight, smoke) must reject it
 * before touching the ledger, so preflight can never mutate migration history.
 */
export function assertRecordHistoryScope(mode: string, recordHistory: boolean): void {
  if (!recordHistory) return;
  if (mode !== "apply") {
    throw new MigrationRepairError(
      "history_repair_not_applicable",
      "--record-history is a post-apply ledger reconciliation and is only valid with --apply",
    );
  }
}

/**
 * Fails closed unless the exact migration SQL has already committed AND every
 * post-apply validation/smoke gate passed. This is the "repair may never run
 * before validated apply" gate.
 */
export function assertHistoryRepairEligible(input: {
  exactSqlApplied: boolean;
  postApplyOk: boolean;
}): void {
  if (!input.exactSqlApplied) {
    throw new MigrationRepairError(
      "history_repair_before_apply",
      "migration history may only be repaired after the exact migration SQL has been applied",
    );
  }
  if (!input.postApplyOk) {
    throw new MigrationRepairError(
      "history_repair_before_validation",
      "migration history may only be repaired after all post-apply validation/smoke gates pass",
    );
  }
}

export interface HistoryRepairVerification {
  targetVersion: string;
  /** True only when the direct `schema_migrations` ledger shows the target. */
  applied: boolean;
  /** Local versions still absent from the direct ledger after repair (should be empty). */
  pendingVersions: string[];
  /** True/false when the CLI cross-check was usable, null when it was not. */
  cliCrossCheck: boolean | null;
  /** True only when applied, the pending set is empty and any CLI cross-check agrees. */
  verified: boolean;
}

/**
 * Re-reads the post-repair ledgers and requires the target version to be present.
 * `verified` is true only when the direct ledger shows the target, no local
 * migration is still pending and (where the CLI cross-check is reliable) the CLI
 * ledger agrees.
 */
export function verifyHistoryRepair(input: {
  targetVersion?: string;
  localVersions: readonly string[];
  directRemoteVersions: readonly string[];
  cliRemoteVersions?: readonly string[] | null;
  cliReliable?: boolean;
}): HistoryRepairVerification {
  const targetVersion = input.targetVersion ?? MIGRATION_VERSION;
  const direct = normalizeVersions(input.directRemoteVersions);
  const cli =
    input.cliRemoteVersions === undefined || input.cliRemoteVersions === null
      ? null
      : normalizeVersions(input.cliRemoteVersions);
  const cliReliable = input.cliReliable === true && cli !== null;
  const applied = direct.includes(targetVersion);
  const cliCrossCheck = cliReliable ? (cli as string[]).includes(targetVersion) : null;
  const pendingVersions = normalizeVersions(input.localVersions).filter((version) => !direct.includes(version));
  const verified =
    applied && pendingVersions.length === 0 && (cliCrossCheck === null || cliCrossCheck === true);
  return { targetVersion, applied, pendingVersions, cliCrossCheck, verified };
}

export interface HistoryRepairEvaluation {
  /** True only when the repair command exited 0 AND the ledger re-read verified it. */
  ok: boolean;
  historyRecorded: boolean;
  historyVerified: boolean;
  blocker: "history_repair_failed" | null;
}

/**
 * The post-repair decision. A non-zero repair exit or a ledger that still does
 * not show the target is reported as `history_repair_failed`; the caller never
 * rolls the schema back automatically.
 */
export function evaluateHistoryRepair(input: {
  repairExitOk: boolean;
  verification: HistoryRepairVerification;
}): HistoryRepairEvaluation {
  const historyRecorded = input.repairExitOk;
  const historyVerified = input.verification.verified;
  const ok = historyRecorded && historyVerified;
  return { ok, historyRecorded, historyVerified, blocker: ok ? null : "history_repair_failed" };
}
