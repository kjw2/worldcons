import { D1_DATABASES, type D1Database } from "../types";
import {
  D1RemoteError,
  classifyD1RemoteTargets,
  parseD1ExecuteResultsJson,
  parseD1RemoteInfoJson,
  parseD1RemoteListJson,
} from "./classify";
import { selectD1RemoteTargets, type D1RemoteTarget } from "./targets";
import {
  D1_REMOTE_MIGRATION_APPLY_VERSION,
  type D1MigrationSourceFile,
  type D1MigrationVerification,
  type D1RemoteMigration,
  type D1RemoteMigrationManifest,
  type D1RemoteMigrationManifestMigration,
  type D1RemoteMigrationManifestTarget,
  type WranglerD1Runner,
} from "./types";

/**
 * M5.2c PART 2c additive remote D1 migration operator.
 *
 * The `0001_init.sql` baseline is historical: it has already been applied to the
 * four remote `worldcons_*` databases and is never edited or rerun. This seam is
 * the narrow companion that discovers numbered additive migrations *after* 0001
 * and applies only the pending ones:
 *
 * - it is dry-run by default and writes a migration to a remote database only
 *   with an explicit `apply:true` (and a `materializeMigration` implementation);
 * - discovery is deterministic: files are filtered to `NNNN_name.sql` with
 *   number > 1, then ordered by database, number and file name. A duplicate
 *   number in one database, an unnumbered file or a migration without a
 *   `-- @d1-verify` directive fails closed before any write;
 * - each migration is verified idempotently through `sqlite_master`: it is
 *   pending only when an expected object is absent or its stored SQL does not
 *   contain every expected fragment. A migration already in its verified state
 *   is skipped, so a rerun is a no-op with no `--file` write;
 * - it never creates or deletes a database, never deploys, never copies data and
 *   never changes production authority. It authors no table/row mutation: it
 *   only executes the reviewed migration SQL it is handed.
 *
 * It never throws for a remote failure: it returns a manifest with `ok:false`
 * and per-target errors. It throws only for a caller error (apply without a
 * `materializeMigration` implementation) or a malformed migration input.
 */
export const D1_MIGRATION_OBJECT_QUERY =
  "select type, name, sql from sqlite_master where type in ('table', 'index') order by type, name";

/** The single-line comment prefix that carries a migration's verify directive. */
export const D1_MIGRATION_VERIFY_PREFIX = "-- @d1-verify";

/** The `NNNN_name.sql` numbering contract for an additive migration file. */
const MIGRATION_FILE_PATTERN = /^(\d{4})_(.+)\.sql$/;

/** Case-insensitive, whitespace-insensitive normalization for SQL fragments. */
export function normalizeD1MigrationSql(sql: string): string {
  return sql.replace(/\s+/g, "").toLowerCase();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeVerification(value: unknown): D1MigrationVerification {
  const record = asRecord(value);
  if (record === null) {
    throw new D1RemoteError("d1_remote.malformed_migration_verify", "a @d1-verify directive is not a JSON object");
  }
  if (record.type !== "table" && record.type !== "index") {
    throw new D1RemoteError("d1_remote.malformed_migration_verify", "a @d1-verify type must be table or index");
  }
  if (typeof record.name !== "string" || record.name.trim().length === 0) {
    throw new D1RemoteError("d1_remote.malformed_migration_verify", "a @d1-verify name must be a non-empty string");
  }
  let sqlIncludes: string[] = [];
  if (record.sqlIncludes !== undefined) {
    if (
      !Array.isArray(record.sqlIncludes) ||
      record.sqlIncludes.some((fragment) => typeof fragment !== "string" || fragment.length === 0)
    ) {
      throw new D1RemoteError("d1_remote.malformed_migration_verify", "a @d1-verify sqlIncludes must be strings");
    }
    sqlIncludes = record.sqlIncludes as string[];
  }
  return { type: record.type, name: record.name.trim(), sqlIncludes };
}

/**
 * Parses every `-- @d1-verify {json}` directive from a migration's SQL. The
 * directives are the migration's machine-readable, idempotent verification
 * contract; a migration with none cannot be proven applied and is rejected by
 * `buildD1RemoteMigrations`.
 */
export function parseD1MigrationVerifyDirectives(sql: string): D1MigrationVerification[] {
  const directives: D1MigrationVerification[] = [];
  const pattern = new RegExp(`^\\s*${D1_MIGRATION_VERIFY_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+(.+?)\\s*$`);
  for (const line of sql.split(/\r?\n/)) {
    const match = pattern.exec(line);
    if (match === null) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(match[1]);
    } catch {
      throw new D1RemoteError("d1_remote.malformed_migration_verify", "a @d1-verify directive is not valid JSON");
    }
    directives.push(normalizeVerification(parsed));
  }
  return directives;
}

function databaseOrder(database: D1Database): number {
  const index = (D1_DATABASES as readonly string[]).indexOf(database);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function compareMigrations(left: D1RemoteMigration, right: D1RemoteMigration): number {
  return (
    databaseOrder(left.database) - databaseOrder(right.database) ||
    left.number - right.number ||
    left.file.localeCompare(right.file)
  );
}

/**
 * Discovers the additive migrations from already-read source files: it keeps
 * only `NNNN_name.sql` files with number > 1 (the historical 0001 baseline is
 * never rerun), parses each migration's verify directives, rejects a duplicate
 * number within one database and returns the migrations in deterministic order.
 */
export function buildD1RemoteMigrations(files: readonly D1MigrationSourceFile[]): D1RemoteMigration[] {
  const migrations: D1RemoteMigration[] = [];
  const seen = new Set<string>();
  for (const source of files) {
    const match = MIGRATION_FILE_PATTERN.exec(source.file);
    if (match === null) {
      throw new D1RemoteError(
        "d1_remote.unnumbered_migration",
        `migration file is not numbered NNNN_name.sql: ${source.file}`,
      );
    }
    const number = Number(match[1]);
    if (number <= 1) continue;
    const key = `${source.database}/${match[1]}`;
    if (seen.has(key)) {
      throw new D1RemoteError("d1_remote.duplicate_migration", `duplicate migration ${match[1]} for ${source.database}`);
    }
    seen.add(key);
    const verify = parseD1MigrationVerifyDirectives(source.sql);
    if (verify.length === 0) {
      throw new D1RemoteError(
        "d1_remote.migration_without_verify",
        `migration ${source.file} has no ${D1_MIGRATION_VERIFY_PREFIX} directive`,
      );
    }
    migrations.push({ database: source.database, number, id: match[1], file: source.file, sql: source.sql, verify });
  }
  migrations.sort(compareMigrations);
  return migrations;
}

export interface BuildD1MigrationApplyManifestOptions {
  /** The Wrangler invocation boundary. Tests pass a fake runner. */
  runner: WranglerD1Runner;
  /** The discovered additive migrations, normally from `buildD1RemoteMigrations`. */
  migrations: readonly D1RemoteMigration[];
  /** Write pending migrations to the remote databases only when explicitly true. */
  apply?: boolean;
  /** Optional subset of target databases, in canonical order. */
  databases?: readonly D1Database[];
  /**
   * Persists one pending migration and returns the path passed to
   * `wrangler d1 execute --file`. Required in apply mode.
   */
  materializeMigration?: (migration: D1RemoteMigration) => string;
}

function message(error: unknown): string {
  if (error instanceof D1RemoteError || error instanceof Error) return error.message;
  return String(error);
}

function uniqueMigrationDatabases(migrations: readonly D1RemoteMigration[]): D1Database[] {
  const selected = new Set<D1Database>();
  for (const migration of migrations) selected.add(migration.database);
  return D1_DATABASES.filter((database) => selected.has(database));
}

function emptyTarget(target: D1RemoteTarget, migrations: readonly D1RemoteMigration[]): D1RemoteMigrationManifestTarget {
  return {
    name: target.name,
    binding: target.binding,
    state: "unknown",
    action: "refused",
    databaseId: null,
    migrations: migrations.map((migration) => ({
      number: migration.number,
      id: migration.id,
      file: migration.file,
      state: "unknown",
      verified: false,
      detail: null,
      errors: [],
    })),
    pending: migrations.length,
    applied: 0,
    verified: false,
    errors: [],
  };
}

/** Whether one migration's verify directives are satisfied by the object rows. */
function verifyMigration(
  migration: D1RemoteMigration,
  rows: readonly Record<string, unknown>[],
): { verified: boolean; detail: string | null } {
  for (const verification of migration.verify) {
    const row = rows.find((entry) => entry.type === verification.type && entry.name === verification.name);
    if (row === undefined) {
      return { verified: false, detail: `missing ${verification.type} ${verification.name}` };
    }
    const stored = typeof row.sql === "string" ? normalizeD1MigrationSql(row.sql) : "";
    for (const fragment of verification.sqlIncludes) {
      if (!stored.includes(normalizeD1MigrationSql(fragment))) {
        return { verified: false, detail: `${verification.name} sql does not include ${fragment}` };
      }
    }
  }
  return { verified: true, detail: null };
}

/**
 * Discovers pending additive migrations per selected remote database and, only
 * with `apply`, writes exactly those pending migrations in deterministic order
 * and re-verifies them. `0001` is never in `options.migrations` (discovery
 * filters it), so the baseline is never rerun or modified.
 */
export async function buildD1MigrationApplyManifest(
  options: BuildD1MigrationApplyManifestOptions,
): Promise<D1RemoteMigrationManifest> {
  const apply = options.apply === true;
  if (apply && typeof options.materializeMigration !== "function") {
    throw new Error("materializeMigration is required to apply D1 migrations");
  }
  const migrations = [...options.migrations].sort(compareMigrations);
  const databases = options.databases === undefined ? uniqueMigrationDatabases(migrations) : [...options.databases];
  const targets = selectD1RemoteTargets(databases);
  const commands: string[] = [];
  const errors: string[] = [];
  const results = new Map<string, D1RemoteMigrationManifestTarget>();
  for (const target of targets) {
    results.set(
      target.name,
      emptyTarget(
        target,
        migrations.filter((migration) => migration.database === target.name),
      ),
    );
  }

  async function runWrangler(args: string[]): Promise<string> {
    commands.push(args.join(" "));
    return options.runner(args);
  }

  function get(name: D1Database): D1RemoteMigrationManifestTarget {
    return results.get(name) as D1RemoteMigrationManifestTarget;
  }

  async function queryObjects(target: D1RemoteTarget): Promise<Record<string, unknown>[]> {
    return parseD1ExecuteResultsJson(
      await runWrangler([
        "d1",
        "execute",
        target.name,
        "--remote",
        "--yes",
        "--json",
        "--command",
        D1_MIGRATION_OBJECT_QUERY,
      ]),
    );
  }

  function finalize(): D1RemoteMigrationManifest {
    const all = targets.map((target) => get(target.name));
    const allMigrations = all.flatMap((target) => target.migrations);
    return {
      version: D1_REMOTE_MIGRATION_APPLY_VERSION,
      stage: "d1-remote-migration-apply",
      dryRun: !apply,
      applied: apply,
      targets: all,
      totals: {
        targets: all.length,
        migrations: allMigrations.length,
        pending: allMigrations.filter((migration) => migration.state === "pending").length,
        applied: allMigrations.filter((migration) => migration.state === "applied").length,
        present: all.filter((target) => target.verified).length,
        missing: all.filter((target) => target.state === "missing").length,
        refused: all.filter((target) => target.action === "refused").length,
      },
      commands: [...commands],
      ok: errors.length === 0,
      errors: [...errors],
    };
  }

  let classifications: ReturnType<typeof classifyD1RemoteTargets>;
  try {
    const entries = parseD1RemoteListJson(await runWrangler(["d1", "list", "--json"]));
    classifications = classifyD1RemoteTargets(entries, targets);
  } catch (error) {
    errors.push(`preflight: ${message(error)}`);
    return finalize();
  }

  const ready: D1RemoteTarget[] = [];
  for (const classified of classifications) {
    const result = get(classified.target.name);
    if (classified.state === "ambiguous") {
      result.state = "ambiguous";
      result.action = "refused";
      result.databaseId = classified.entry?.uuid ?? null;
      result.errors.push(`ambiguous: ${classified.matches} databases share the name`);
      errors.push(`ambiguous target ${classified.target.name} (${classified.matches} matches)`);
    } else if (classified.state === "missing") {
      result.state = "missing";
      result.action = "refused";
      result.errors.push("remote database does not exist; run pnpm d1:provision --apply first");
      errors.push(`migration target ${classified.target.name} is missing`);
    } else {
      result.databaseId = classified.entry?.uuid ?? null;
      ready.push(classified.target);
    }
  }
  if (errors.length > 0) return finalize();

  let aborted = false;
  for (const target of ready) {
    const result = get(target.name);
    const discovered = migrations.filter((migration) => migration.database === target.name);
    result.state = "existing";
    result.action = discovered.length > 0 ? "apply" : "none";
    if (aborted) {
      result.action = "refused";
      result.errors.push("not attempted: migration apply aborted after an earlier failure");
      continue;
    }
    try {
      const info = parseD1RemoteInfoJson(await runWrangler(["d1", "info", target.name, "--json"]));
      if (result.databaseId !== null && info.uuid !== result.databaseId) {
        throw new D1RemoteError("d1_remote.verification_mismatch", "d1 info did not match the listed database");
      }
      result.databaseId = info.uuid;
    } catch (error) {
      result.state = "unknown";
      result.action = "refused";
      result.errors.push(message(error));
      errors.push(`info ${target.name}: ${message(error)}`);
      aborted = true;
      continue;
    }

    // Read-only sqlite_master check BEFORE any write. A migration already in its
    // verified state is skipped, so a fully corrected target is a real no-op.
    let rows: Record<string, unknown>[];
    try {
      rows = await queryObjects(target);
    } catch (error) {
      result.state = "unknown";
      result.action = "refused";
      result.errors.push(message(error));
      errors.push(`verify ${target.name}: ${message(error)}`);
      aborted = true;
      continue;
    }

    const pending: D1RemoteMigration[] = [];
    for (const migration of discovered) {
      const manifestMigration = result.migrations.find((entry) => entry.id === migration.id) as
        | D1RemoteMigrationManifestMigration
        | undefined;
      const outcome = verifyMigration(migration, rows);
      if (outcome.verified) {
        if (manifestMigration !== undefined) {
          manifestMigration.state = "verified";
          manifestMigration.verified = true;
          manifestMigration.detail = null;
        }
      } else {
        pending.push(migration);
        if (manifestMigration !== undefined) {
          manifestMigration.state = "pending";
          manifestMigration.verified = false;
          manifestMigration.detail = outcome.detail;
        }
      }
    }
    result.pending = pending.length;
    if (pending.length === 0) {
      result.action = "none";
      result.verified = true;
      continue;
    }
    if (!apply) {
      result.verified = false;
      continue;
    }

    // Apply exactly the pending migrations, in deterministic order.
    let targetAborted = false;
    for (const migration of pending) {
      const manifestMigration = result.migrations.find((entry) => entry.id === migration.id) as
        | D1RemoteMigrationManifestMigration
        | undefined;
      let path: string;
      try {
        path = (options.materializeMigration as (migration: D1RemoteMigration) => string)(migration);
      } catch (error) {
        result.state = "unknown";
        result.action = "refused";
        result.errors.push(message(error));
        errors.push(`materialize ${target.name} ${migration.file}: ${message(error)}`);
        if (manifestMigration !== undefined) {
          manifestMigration.state = "unknown";
          manifestMigration.errors.push(message(error));
        }
        targetAborted = true;
        break;
      }
      try {
        await runWrangler(["d1", "execute", target.name, "--remote", "--yes", "--json", "--file", path]);
        if (manifestMigration !== undefined) {
          manifestMigration.state = "applied";
          manifestMigration.verified = false;
        }
      } catch (error) {
        result.state = "unknown";
        result.action = "refused";
        result.errors.push(message(error));
        errors.push(`execute ${target.name} ${migration.file}: ${message(error)}`);
        if (manifestMigration !== undefined) {
          manifestMigration.state = "unknown";
          manifestMigration.errors.push(message(error));
        }
        targetAborted = true;
        break;
      }
    }
    if (targetAborted) {
      aborted = true;
      continue;
    }

    // The read-only re-query is the sole success criterion for an apply.
    let verifiedRows: Record<string, unknown>[];
    try {
      verifiedRows = await queryObjects(target);
    } catch (error) {
      result.state = "unknown";
      result.action = "refused";
      result.verified = false;
      result.errors.push(message(error));
      errors.push(`verify ${target.name}: ${message(error)}`);
      aborted = true;
      continue;
    }
    let allVerified = true;
    for (const migration of discovered) {
      const manifestMigration = result.migrations.find((entry) => entry.id === migration.id) as
        | D1RemoteMigrationManifestMigration
        | undefined;
      const outcome = verifyMigration(migration, verifiedRows);
      if (manifestMigration !== undefined) {
        manifestMigration.verified = outcome.verified;
        manifestMigration.detail = outcome.verified ? null : outcome.detail;
        if (!outcome.verified && manifestMigration.state === "applied") {
          manifestMigration.state = "unknown";
          manifestMigration.errors.push(outcome.detail ?? "verification failed");
        }
      }
      if (!outcome.verified) allVerified = false;
    }
    result.pending = result.migrations.filter((entry) => entry.state === "pending").length;
    result.applied = result.migrations.filter((entry) => entry.state === "applied").length;
    result.verified = allVerified;
    if (!allVerified) {
      result.action = "refused";
      errors.push(`verify ${target.name}: ${result.migrations.filter((entry) => !entry.verified).length} migrations not verified`);
    }
  }

  return finalize();
}
