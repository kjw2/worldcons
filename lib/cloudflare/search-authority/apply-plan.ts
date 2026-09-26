import {
  defaultSupabaseBinary,
  supabaseLinkedQueryArgs,
} from "@/lib/cloudflare/d1/convert/supabase-linked-source";
import { assertMigrationSha256, MIGRATION_PATH, MIGRATION_SHA256, MIGRATION_VERSION } from "./migration-contract";

/**
 * M7.8-A apply plan (operator-only, deterministic). The ONLY mutation path.
 *
 * The apply executes the EXACT bytes of
 * `supabase/migrations/20260926120000_m7_7a_semantic_authority_projection.sql`
 * through `supabase db query --linked -o json <sql>`. That query wraps the file's
 * own `begin; ... commit;` transaction, so the view swap is atomic and is
 * preceded by the migration's own fail-closed column preflight.
 *
 * `supabase db push`, `migration up` and `--include-all` are NEVER valid here:
 * `assertNoForbiddenMigrationTooling` rejects them, and the plan only ever emits
 * a `db query --linked` invocation of the single pinned file.
 */

export const APPLY_FLAG = "--apply" as const;
export const PREFLIGHT_FLAG = "--preflight" as const;
export const DRY_RUN_FLAG = "--dry-run" as const;
export const SMOKE_FLAG = "--smoke" as const;
/**
 * `--record-history` is a post-apply ledger reconciliation ONLY: after the exact
 * migration SQL commits and every post-apply validation/smoke gate passes, it runs
 * exactly `supabase migration repair --linked --status applied 20260926120000` and
 * then re-reads `supabase_migrations.schema_migrations`. It is never a schema-apply
 * mechanism and is rejected outside `--apply`. It is distinct from `--report`,
 * which writes the local evidence artifact.
 */
export const RECORD_HISTORY_FLAG = "--record-history" as const;
/** `--report` writes the content-free evidence artifact only; it never mutates the ledger. */
export const REPORT_FLAG = "--report" as const;
export const ALLOW_LIVE_BASELINE_FLAG = "--allow-live-baseline" as const;

/** Tooling that must never be used to apply the migration. */
export const FORBIDDEN_MIGRATION_TOOLING = ["db push", "migration up", "--include-all"] as const;

export const APPLY_PLAN_ERROR_CODES = [
  "apply_flag_required",
  "preflight_required",
  "dry_run_conflict",
  "forbidden_migration_tooling",
  "apply_invocation_invalid",
] as const;

export type ApplyPlanErrorCode = (typeof APPLY_PLAN_ERROR_CODES)[number];

export class ApplyPlanError extends Error {
  readonly code: ApplyPlanErrorCode;

  constructor(code: ApplyPlanErrorCode, message: string) {
    super(message);
    this.name = "ApplyPlanError";
    this.code = code;
  }
}

function containsForbiddenTooling(text: string): boolean {
  const normalized = text.replace(/\s+/gu, " ").toLowerCase();
  return FORBIDDEN_MIGRATION_TOOLING.some((tooling) => normalized.includes(tooling));
}

/**
 * Rejects any invocation whose tokens contain `db push`, `migration up` or
 * `--include-all`. The whole argv is inspected (the pinned migration SQL never
 * contains a forbidden token), so a forbidden flag in any position fails closed.
 */
export function assertNoForbiddenMigrationTooling(argv: readonly string[]): void {
  if (containsForbiddenTooling(argv.join(" "))) {
    throw new ApplyPlanError(
      "forbidden_migration_tooling",
      "the apply path must use supabase db query --linked; migration push/up and --include-all are forbidden",
    );
  }
}

/** True when an argv looks like a forbidden migration-apply command. */
export function usesForbiddenMigrationTooling(argv: readonly string[]): boolean {
  return containsForbiddenTooling(argv.join(" "));
}

/**
 * Requires the invocation to be exactly `db query --linked` (with the pinned
 * SQL as the final argument).
 */
export function assertApplyInvocation(argv: readonly string[]): void {
  const [command, subcommand] = argv;
  if (command !== "db" || subcommand !== "query" || !argv.includes("--linked")) {
    throw new ApplyPlanError(
      "apply_invocation_invalid",
      "the apply invocation must be `supabase db query --linked -o json <migration-sql>`",
    );
  }
  assertNoForbiddenMigrationTooling(argv);
}

/** Builds the `supabase db query --linked` argv carrying the exact migration SQL. */
export function buildSemanticAuthorityApplyArgs(migrationSql: string): string[] {
  return supabaseLinkedQueryArgs(migrationSql);
}

export interface SemanticAuthorityApplyPlan {
  version: 1;
  destructive: false;
  /** Always true: an apply requires the explicit `--apply` flag. */
  explicit: true;
  /** Always true: the preflight is re-run in the same process before the apply. */
  preflightRequired: true;
  migration: {
    version: string;
    path: string;
    sha256: string;
    sqlBytes: number;
  };
  command: {
    binary: string;
    args: string[];
  };
  forbiddenTooling: readonly string[];
}

/**
 * Builds the deterministic apply plan for the exact forward-migration bytes,
 * failing closed on a SHA-256 mismatch or a non-`db query --linked` invocation.
 * The plan carries the SQL bytes; callers must not serialize it into evidence.
 */
export function planSemanticAuthorityApply(migrationSql: string | Buffer): SemanticAuthorityApplyPlan {
  assertMigrationSha256(migrationSql);
  const sql = typeof migrationSql === "string" ? migrationSql : migrationSql.toString("utf8");
  const args = buildSemanticAuthorityApplyArgs(sql);
  assertApplyInvocation(args);
  return {
    version: 1,
    destructive: false,
    explicit: true,
    preflightRequired: true,
    migration: {
      version: MIGRATION_VERSION,
      path: MIGRATION_PATH,
      sha256: MIGRATION_SHA256,
      sqlBytes: Buffer.byteLength(sql, "utf8"),
    },
    command: {
      binary: defaultSupabaseBinary(),
      args,
    },
    forbiddenTooling: FORBIDDEN_MIGRATION_TOOLING,
  };
}

export interface ApplyGateInput {
  apply: boolean;
  dryRun: boolean;
  preflightPassed: boolean;
}

/** Fails closed unless an explicit `--apply` is present and the preflight passed. */
export function assertApplyGate(input: ApplyGateInput): void {
  if (input.dryRun) {
    throw new ApplyPlanError("dry_run_conflict", "the dry-run mode can never apply the migration");
  }
  if (!input.apply) {
    throw new ApplyPlanError("apply_flag_required", "applying requires the explicit --apply flag");
  }
  if (!input.preflightPassed) {
    throw new ApplyPlanError(
      "preflight_required",
      "all preflight checks must pass in the same process before applying",
    );
  }
}

/** A content-free summary of the apply plan, safe to log or persist. */
export interface SemanticAuthorityApplyPlanSummary {
  version: 1;
  migration: {
    version: string;
    path: string;
    sha256: string;
    sqlBytes: number;
  };
  command: {
    binary: string;
    tooling: "db query --linked";
  };
  explicit: true;
  preflightRequired: true;
  destructive: false;
}

/** Strips the SQL bytes from the plan so only a content-free summary remains. */
export function summarizeSemanticAuthorityApplyPlan(
  plan: SemanticAuthorityApplyPlan,
): SemanticAuthorityApplyPlanSummary {
  return {
    version: 1,
    migration: { ...plan.migration },
    command: { binary: plan.command.binary, tooling: "db query --linked" },
    explicit: true,
    preflightRequired: true,
    destructive: false,
  };
}
