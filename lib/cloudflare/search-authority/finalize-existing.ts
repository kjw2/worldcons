import {
  BASELINE_ARTIFACT_BACKED_CURRENT_PUBLISHED_ROWS,
  BASELINE_CURRENT_PUBLISHED_ROWS,
  BASELINE_LEGACY_VERSION_EMBEDDING_ONLY_COUNT,
  BASELINE_PROJECTION_ROWS,
  BASELINE_TOTAL_MISMATCH_COUNT,
  assertProjectionColumns,
} from "./migration-contract";
import type { ProjectionIdentity, ProvenanceCounts } from "./preflight-sql";

/**
 * M7.8-A finalize-existing contract (operator-only, READ-ONLY).
 *
 * `--finalize-existing` is a recovery/verification surface for an ALREADY-APPLIED
 * schema + migration-ledger state. Production may reach the desired post-state
 * without a clean `--apply` run (for example the live embedding-NULL baseline
 * changed `872 -> 0` between preflight and the internal apply step, so the normal
 * apply path failed closed). This contract re-reads the already-applied state and
 * writes the applied evidence artifact WITHOUT executing any migration SQL and
 * WITHOUT running `migration repair`.
 *
 * It pins the exact FINALIZED post-state: gate2 36 columns, current published =
 * projection = artifact-backed `1258`, projection embedding NULL `0`, legacy-only
 * `872` and every provenance mismatch `0`, plus a bounded semantic/hybrid smoke
 * with `oracleDrift = 0`. Because no pre-apply capture exists on this path, the
 * evidence must mark `recoveredExistingState = true` and
 * `preIdentityAvailable = false`; a pre/post id-count+digest equality is NEVER
 * fabricated.
 */

/** The read-only finalize-existing mode flag. */
export const FINALIZE_EXISTING_FLAG = "--finalize-existing" as const;

/** The desired post-migration projection embedding-NULL count (none may remain). */
export const FINALIZED_PROJECTION_EMBEDDING_NULL_COUNT = 0 as const;

/**
 * The read-only checks the finalize-existing path performs, in the order the
 * operator runs them. `linked_identity` and `migration_sha256` are evaluated by
 * the operator script; the remainder by `evaluateFinalizeExistingState`.
 */
export const FINALIZE_EXISTING_CHECK_ORDER = [
  "linked_identity",
  "migration_sha256",
  "remote_target_present",
  "pending_set_empty",
  "projection_columns",
  "provenance_post_state",
  "projection_identity",
  "smoke_oracle_drift",
] as const;

export type FinalizeExistingCheck = (typeof FINALIZE_EXISTING_CHECK_ORDER)[number];

export const FINALIZE_EXISTING_ERROR_CODES = [
  "finalize_existing_not_read_only",
  "finalize_columns_unavailable",
  "finalize_columns_mismatch",
  "finalize_counts_unavailable",
  "finalize_count_mismatch",
  "finalize_projection_embedding_null_nonzero",
  "finalize_provenance_mismatch",
  "finalize_identity_unavailable",
  "finalize_target_not_applied",
  "finalize_cli_cross_check_failed",
  "finalize_pending_not_empty",
  "finalize_ledger_unavailable",
  "finalize_smoke_unavailable",
  "finalize_smoke_oracle_drift",
  "finalize_smoke_failed",
] as const;

export type FinalizeExistingErrorCode = (typeof FINALIZE_EXISTING_ERROR_CODES)[number];

export class FinalizeExistingError extends Error {
  readonly code: FinalizeExistingErrorCode;

  constructor(code: FinalizeExistingErrorCode, message: string) {
    super(message);
    this.name = "FinalizeExistingError";
    this.code = code;
  }
}

/**
 * Mutating operations the finalize-existing path may NEVER invoke. This is the
 * machine-checkable read-only contract: it includes the exact-bytes schema apply
 * (`planSemanticAuthorityApply` / `buildSemanticAuthorityApplyArgs`) and the
 * migration-ledger repair (`buildMigrationRepairArgs` / `migration repair`).
 */
export const FINALIZE_EXISTING_FORBIDDEN_OPERATIONS = [
  "planSemanticAuthorityApply",
  "buildSemanticAuthorityApplyArgs",
  "buildMigrationRepairArgs",
  "supabase migration repair",
] as const;

/**
 * Fails closed if any declared operation contains a forbidden mutation. The
 * operator CLIs declare the operations they intend to run, so a finalize-existing
 * path that ever grows a schema-apply or ledger-repair call is rejected before it
 * runs.
 */
export function assertFinalizeExistingReadOnly(operations: readonly string[]): void {
  for (const operation of operations) {
    const forbidden = FINALIZE_EXISTING_FORBIDDEN_OPERATIONS.find((token) => operation.includes(token));
    if (forbidden) {
      throw new FinalizeExistingError(
        "finalize_existing_not_read_only",
        `the finalize-existing path must be read-only; it may not invoke ${forbidden}`,
      );
    }
  }
}

export interface FinalizeExistingStateInput {
  /** Live projection columns, or null when the read failed. */
  columns: readonly string[] | null;
  /** Content-free projection id count+digest, or null when the read failed. */
  identity: ProjectionIdentity | null;
  /** Live semantic provenance counts, or null when the read failed. */
  counts: ProvenanceCounts | null;
  /** Bounded semantic/hybrid smoke summary, or null when it did not run. */
  smoke: { oracleDrift: number; pass: boolean } | null;
  /** True only when the direct `schema_migrations` ledger shows the target applied. */
  targetApplied: boolean;
  /**
   * The reliable CLI `migration list` cross-check of the target: true/false when
   * the CLI inventory was usable, null when it was not.
   */
  cliCrossCheckOk: boolean | null;
  /** Local versions still absent from the direct ledger, or null when unreadable. */
  pendingVersions: readonly string[] | null;
}

export interface FinalizeExistingBlocker {
  code: FinalizeExistingErrorCode;
  detail: string;
}

export interface FinalizeExistingStateResult {
  ok: boolean;
  checks: FinalizeExistingCheck[];
  blockers: FinalizeExistingBlocker[];
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The read-only finalized-state validation. It fails closed unless the live
 * columns equal the frozen gate2 order, every count equals the desired finalized
 * post-state, the projection identity was captured, the target version is in the
 * direct ledger, the pending set is empty and the smoke passes with
 * `oracleDrift = 0`. It never compares a pre-apply identity (none exists).
 */
export function evaluateFinalizeExistingState(input: FinalizeExistingStateInput): FinalizeExistingStateResult {
  const checks: FinalizeExistingCheck[] = [];
  const blockers: FinalizeExistingBlocker[] = [];

  if (input.columns === null) {
    blockers.push({ code: "finalize_columns_unavailable", detail: "the live projection columns could not be read" });
  } else {
    try {
      assertProjectionColumns(input.columns);
      checks.push("projection_columns");
    } catch (error) {
      blockers.push({ code: "finalize_columns_mismatch", detail: message(error) });
    }
  }

  if (input.counts === null) {
    blockers.push({ code: "finalize_counts_unavailable", detail: "the semantic provenance counts could not be read" });
  } else {
    const expected: Array<[keyof ProvenanceCounts, number]> = [
      ["currentPublishedRows", BASELINE_CURRENT_PUBLISHED_ROWS],
      ["projectionRows", BASELINE_PROJECTION_ROWS],
      ["artifactBackedCurrentPublishedRows", BASELINE_ARTIFACT_BACKED_CURRENT_PUBLISHED_ROWS],
      ["projectionEmbeddingNullCount", FINALIZED_PROJECTION_EMBEDDING_NULL_COUNT],
      ["legacyVersionEmbeddingOnlyCount", BASELINE_LEGACY_VERSION_EMBEDDING_ONLY_COUNT],
    ];
    let countsOk = true;
    for (const [key, value] of expected) {
      if (input.counts[key] !== value) {
        countsOk = false;
        blockers.push({
          code: key === "projectionEmbeddingNullCount"
            ? "finalize_projection_embedding_null_nonzero"
            : "finalize_count_mismatch",
          detail: `${key} is not the finalized post-state value`,
        });
      }
    }
    if (input.counts.totalMismatchCount !== BASELINE_TOTAL_MISMATCH_COUNT) {
      countsOk = false;
      blockers.push({ code: "finalize_provenance_mismatch", detail: "every provenance mismatch count must be 0" });
    }
    if (countsOk) checks.push("provenance_post_state");
  }

  if (input.identity === null) {
    blockers.push({ code: "finalize_identity_unavailable", detail: "the projection id count+digest could not be read" });
  } else {
    checks.push("projection_identity");
  }

  if (!input.targetApplied) {
    blockers.push({
      code: "finalize_target_not_applied",
      detail: "the target migration version is not present in the direct schema_migrations ledger",
    });
  } else if (input.cliCrossCheckOk === false) {
    blockers.push({
      code: "finalize_cli_cross_check_failed",
      detail: "the reliable CLI migration list does not show the target version applied",
    });
  } else {
    checks.push("remote_target_present");
  }

  if (input.pendingVersions === null) {
    blockers.push({ code: "finalize_ledger_unavailable", detail: "the migration ledger could not be read" });
  } else if (input.pendingVersions.length > 0) {
    blockers.push({ code: "finalize_pending_not_empty", detail: "the pending migration set must be empty" });
  } else {
    checks.push("pending_set_empty");
  }

  if (input.smoke === null) {
    blockers.push({ code: "finalize_smoke_unavailable", detail: "the semantic/hybrid smoke could not be executed" });
  } else if (input.smoke.oracleDrift !== 0) {
    blockers.push({ code: "finalize_smoke_oracle_drift", detail: "the semantic/hybrid smoke oracle drift must be 0" });
  } else if (!input.smoke.pass) {
    blockers.push({ code: "finalize_smoke_failed", detail: "the semantic/hybrid smoke did not pass" });
  } else {
    checks.push("smoke_oracle_drift");
  }

  const ordered = FINALIZE_EXISTING_CHECK_ORDER.filter((check) => (checks as readonly string[]).includes(check));
  return { ok: blockers.length === 0, checks: ordered, blockers };
}
