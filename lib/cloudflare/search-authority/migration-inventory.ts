import fs from "node:fs";
import path from "node:path";
import { MIGRATION_VERSION, readLinkedProjectIdentity } from "./migration-contract";

/**
 * M7.8-A migration inventory (direct `schema_migrations` read + CLI migration
 * list cross-check). Pure parsing and set logic; the operator script supplies
 * the raw rows/stdout.
 *
 * The pending set is computed as "local migration versions not present in the
 * remote migration ledger". M7.8-A requires that set to be EXACTLY
 * `[MIGRATION_VERSION]`: no earlier migration may still be pending and no later
 * migration (for example the staged rollback candidate, which lives outside
 * `supabase/migrations`) may be swept into the apply.
 */

/** The direct, read-only migration-ledger query. */
export const SCHEMA_MIGRATIONS_SQL = `select version from supabase_migrations.schema_migrations order by version`;

/** The read-only CLI migration-list argv (never `migration up`). */
export const MIGRATION_LIST_ARGS = ["migration", "list", "--linked"] as const;

/** Local migration files must be `<14-digit timestamp>_<name>.sql`. */
export const MIGRATION_FILENAME_PATTERN = /^(\d{14})_.+\.sql$/u;

export const MIGRATION_INVENTORY_ERROR_CODES = [
  "local_migration_missing",
  "pending_set_mismatch",
  "remote_target_version_present",
  "inventory_parse_failed",
  "inventory_cross_check_unreliable",
] as const;

export type MigrationInventoryErrorCode = (typeof MIGRATION_INVENTORY_ERROR_CODES)[number];

export class MigrationInventoryError extends Error {
  readonly code: MigrationInventoryErrorCode;

  constructor(code: MigrationInventoryErrorCode, message: string) {
    super(message);
    this.name = "MigrationInventoryError";
    this.code = code;
  }
}

function isMigrationVersion(value: unknown): value is string {
  return typeof value === "string" && /^\d{14}$/u.test(value.trim());
}

/** Sorted, de-duplicated valid 14-digit versions from a raw list. */
export function normalizeVersions(values: readonly unknown[]): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const candidate = typeof value === "number" ? String(value) : value;
    if (typeof candidate === "string") {
      const trimmed = candidate.trim();
      if (isMigrationVersion(trimmed)) seen.add(trimmed);
    }
  }
  return [...seen].sort();
}

/**
 * Extracts the 14-digit version from local migration filenames. Non-matching
 * entries (`.gitkeep`, directories, the staged rollback candidate outside this
 * directory) are ignored, so the local set is exactly `supabase/migrations`.
 */
export function parseLocalMigrationFilenames(filenames: readonly string[]): string[] {
  const versions: string[] = [];
  for (const filename of filenames) {
    const match = MIGRATION_FILENAME_PATTERN.exec(filename.trim());
    if (match) versions.push(match[1]);
  }
  return normalizeVersions(versions);
}

/** Reads and parses the local `supabase/migrations` directory filenames. */
export function readLocalMigrationVersions(rootDir: string): string[] {
  const directory = path.join(rootDir, "supabase/migrations");
  if (!fs.existsSync(directory)) {
    throw new MigrationInventoryError("local_migration_missing", "supabase/migrations is missing");
  }
  return parseLocalMigrationFilenames(fs.readdirSync(directory));
}

/** Parses direct `schema_migrations` rows into a sorted version list. */
export function parseSchemaMigrationRows(rows: readonly Record<string, unknown>[]): string[] {
  return normalizeVersions(rows.map((row) => row.version));
}

/**
 * Parses `supabase migration list --linked` stdout. The CLI prints a table with
 * `LOCAL | REMOTE | TIME (UTC)` columns; either side may be blank. Only the
 * 14-digit version cells are kept, so a header or a relative-time footer cannot
 * contaminate the set.
 */
export function parseSupabaseMigrationList(stdout: string): { local: string[]; remote: string[] } {
  const local: string[] = [];
  const remote: string[] = [];
  for (const rawLine of stdout.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (!line.includes("|")) continue;
    const cells = line.split("|").map((cell) => cell.trim());
    if (cells.length < 2) continue;
    const localCell = cells[0];
    const remoteCell = cells[1];
    if (isMigrationVersion(localCell)) local.push(localCell.trim());
    if (isMigrationVersion(remoteCell)) remote.push(remoteCell.trim());
  }
  return { local: normalizeVersions(local), remote: normalizeVersions(remote) };
}

export interface ComputePendingMigrationsInput {
  localVersions: readonly string[];
  remoteVersions: readonly string[];
}

/** Local versions absent from the remote ledger, sorted ascending. */
export function computePendingMigrations(input: ComputePendingMigrationsInput): string[] {
  const remote = new Set(normalizeVersions(input.remoteVersions));
  return normalizeVersions(input.localVersions).filter((version) => !remote.has(version));
}

export interface MigrationInventoryReport {
  targetVersion: string;
  localVersions: string[];
  directRemoteVersions: string[];
  /** CLI remote versions, or null when the CLI inventory was not usable. */
  cliRemoteVersions: string[] | null;
  cliReliable: boolean;
  /** True only when the direct and CLI remote ledgers agree (where reliable). */
  crossCheckReliable: boolean;
  pendingVersions: string[];
  /** True when the target version is absent from every remote ledger seen. */
  targetAbsent: boolean;
  /** True only when the pending set is exactly `[targetVersion]`. */
  pendingSetExact: boolean;
}

export interface BuildMigrationInventoryInput {
  targetVersion?: string;
  localVersions: readonly string[];
  directRemoteVersions: readonly string[];
  cliRemoteVersions?: readonly string[] | null;
  cliReliable?: boolean;
}

function sameVersionSet(left: readonly string[], right: readonly string[]): boolean {
  const a = normalizeVersions(left);
  const b = normalizeVersions(right);
  return a.length === b.length && a.every((version, index) => version === b[index]);
}

/**
 * Cross-checks the direct ledger against the CLI ledger. The CLI is only trusted
 * "where reliable": when `cliReliable` is false the CLI set is recorded but never
 * used to fail the rollout, and `crossCheckReliable` is false.
 */
export function buildMigrationInventory(input: BuildMigrationInventoryInput): MigrationInventoryReport {
  const targetVersion = input.targetVersion ?? MIGRATION_VERSION;
  const localVersions = normalizeVersions(input.localVersions);
  const directRemoteVersions = normalizeVersions(input.directRemoteVersions);
  const cliRemoteVersions =
    input.cliRemoteVersions === undefined || input.cliRemoteVersions === null
      ? null
      : normalizeVersions(input.cliRemoteVersions);
  const cliReliable = input.cliReliable === true && cliRemoteVersions !== null;
  const crossCheckReliable =
    cliReliable && sameVersionSet(directRemoteVersions, cliRemoteVersions ?? []);
  const pendingVersions = computePendingMigrations({ localVersions, remoteVersions: directRemoteVersions });
  const targetAbsent = !directRemoteVersions.includes(targetVersion) &&
    (cliRemoteVersions === null || !cliRemoteVersions.includes(targetVersion));
  const pendingSetExact =
    pendingVersions.length === 1 && pendingVersions[0] === targetVersion && targetAbsent;
  return {
    targetVersion,
    localVersions,
    directRemoteVersions,
    cliRemoteVersions,
    cliReliable,
    crossCheckReliable,
    pendingVersions,
    targetAbsent,
    pendingSetExact,
  };
}

/** Fails closed unless the target is absent and the pending set is exactly `[target]`. */
export function assertPendingSetIsExactlyTarget(report: MigrationInventoryReport): void {
  if (!report.targetAbsent) {
    throw new MigrationInventoryError(
      "remote_target_version_present",
      "the target migration version is already present in the remote migration ledger",
    );
  }
  if (!report.pendingSetExact) {
    throw new MigrationInventoryError(
      "pending_set_mismatch",
      "the pending migration set is not exactly the single M7.8-A target version",
    );
  }
}

/**
 * Combines the direct ledger, the CLI ledger (when reliable) and the local
 * directory into one report, failing closed on an unreliable cross-check when
 * the CLI was explicitly requested as reliable.
 */
export function collectMigrationInventory(input: {
  rootDir?: string;
  localVersions?: readonly string[];
  directRemoteVersions: readonly string[];
  cliRemoteVersions?: readonly string[] | null;
  cliReliable?: boolean;
}): MigrationInventoryReport {
  const localVersions = input.localVersions ?? (input.rootDir ? readLocalMigrationVersions(input.rootDir) : []);
  const report = buildMigrationInventory({
    localVersions,
    directRemoteVersions: input.directRemoteVersions,
    cliRemoteVersions: input.cliRemoteVersions ?? null,
    cliReliable: input.cliReliable ?? false,
  });
  if (report.cliRemoteVersions !== null && report.cliReliable && !report.crossCheckReliable) {
    throw new MigrationInventoryError(
      "inventory_cross_check_unreliable",
      "the direct schema_migrations ledger and the CLI migration inventory disagree",
    );
  }
  return report;
}

/** Convenience identity assertion used by the preflight before any inventory read. */
export function assertWorldconsLinkedProject(rootDir: string): { ref: string; name: string } {
  return readLinkedProjectIdentity(rootDir);
}
