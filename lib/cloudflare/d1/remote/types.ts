import type { D1Database } from "../types";

/**
 * M5.2c remote D1 bootstrap operator contract.
 *
 * M5 is "create four D1 databases, implement Postgres export -> canonical
 * transform -> D1 import". M5.1 built the schemas, M5.2a/M5.2b built the local
 * converter and import. M5.2c adds the *operator-only* seam that creates the four
 * remote `worldcons_*` D1 databases through the Wrangler CLI.
 *
 * This slice is deliberately the narrowest possible remote surface:
 *
 * - it is a dry-run/preflight by default and only creates databases when the
 *   operator passes an explicit `--apply`;
 * - it never deletes a database, never deploys a Worker, never imports schema or
 *   data, and never changes production authority;
 * - it parses the current `wrangler d1 list --json` / `d1 info NAME --json`
 *   output and fails closed on malformed JSON or an unverifiable create;
 * - it records a deterministic local manifest under
 *   `artifacts/cloudflare-m5/d1-remote-manifest.json`.
 *
 * The Wrangler child-process adapter (`runner.ts`) is intentionally kept out of
 * this contract and out of the barrel so runtime Workers code never loads it.
 */
export const D1_REMOTE_BOOTSTRAP_VERSION = 1 as const;

/** Plan section 5.5 default jurisdiction for the `worldcons_*` databases. */
export const D1_REMOTE_DEFAULT_LOCATION = "apac";

/** The D1 binding name for each database (plan section 4.1). */
export const D1_BINDINGS: Record<D1Database, string> = {
  worldcons_core: "WORLDCONS_CORE",
  worldcons_ingest: "WORLDCONS_INGEST",
  worldcons_ops: "WORLDCONS_OPS",
  worldcons_search: "WORLDCONS_SEARCH",
};

/**
 * A target's remote state after preflight:
 * - `missing` the exact name is absent, so it is a create candidate;
 * - `existing` the exact name appears exactly once;
 * - `ambiguous` the exact name appears more than once and is refused;
 * - `created` this run created it;
 * - `unknown` preflight or verification failed, so the state is unproven.
 */
export const D1_REMOTE_TARGET_STATES = [
  "missing",
  "existing",
  "ambiguous",
  "created",
  "unknown",
] as const;
export type D1RemoteTargetState = (typeof D1_REMOTE_TARGET_STATES)[number];

/** What the run did (or, in dry-run, plans to do) for a target. */
export const D1_REMOTE_TARGET_ACTIONS = ["none", "create", "refused"] as const;
export type D1RemoteTargetAction = (typeof D1_REMOTE_TARGET_ACTIONS)[number];

/** One remote database parsed from `wrangler d1 list --json`. */
export interface D1RemoteListEntry {
  uuid: string;
  name: string;
  createdAt: string | null;
}

/** The subset of `wrangler d1 info NAME --json` this operator records. */
export interface D1RemoteDatabaseInfo {
  uuid: string;
  name: string;
  createdAt: string | null;
  numTables: number | null;
  fileSize: number | null;
  jurisdiction: string | null;
}

/**
 * The Wrangler invocation boundary. A runner receives the Wrangler argument
 * vector (without the binary) and resolves with stdout. A non-zero exit or an
 * unusable result must reject. Tests supply a fake runner; the operator supplies
 * the child-process adapter from `runner.ts`.
 */
export interface WranglerD1Runner {
  (args: string[]): Promise<string>;
}

/**
 * The confirmed Windows `wrangler d1 execute` process crash exit code
 * (`0xC0000005`, STATUS_ACCESS_VIOLATION, surfaced by Node as 3221226505). Only
 * this exact code identifies the known crash the remote read fallback retries.
 */
export const D1_WRANGLER_CRASH_EXIT_CODE = 3221226505;

/**
 * A Wrangler child-process failure that carries the non-zero exit code it closed
 * with. It lives in this runtime-safe contract (no `node:child_process`) so the
 * data-copy module can classify a runner failure without importing the
 * child-process adapter. Only a real non-zero child close code produces this
 * type: a timeout, a spawn failure, a setup error or a signal-killed child
 * rejects with a plain `Error`, so those remain distinguishable and never match
 * the exit-code-gated read fallback.
 */
export class WranglerD1ExitError extends Error {
  readonly exitCode: number;
  constructor(exitCode: number, message: string) {
    super(message);
    this.name = "WranglerD1ExitError";
    this.exitCode = exitCode;
  }
}

/**
 * The narrow classifier the read fallback keys on: true only for a
 * `WranglerD1ExitError`, and when `exitCode` is supplied, only when it matches
 * exactly. A plain `Error` (timeout/spawn/setup failure) is always false.
 */
export function isWranglerD1ExitError(error: unknown, exitCode?: number): error is WranglerD1ExitError {
  return error instanceof WranglerD1ExitError && (exitCode === undefined || error.exitCode === exitCode);
}

/** One target's result in the remote bootstrap manifest. */
export interface D1RemoteManifestTarget {
  name: D1Database;
  binding: string;
  location: string;
  state: D1RemoteTargetState;
  action: D1RemoteTargetAction;
  /** Remote database id when known (`existing`/`created`). */
  databaseId: string | null;
  /** Remote `created_at` when known. */
  createdAt: string | null;
  /** Whether the state was confirmed from Wrangler output this run. */
  verified: boolean;
  errors: string[];
}

export interface D1RemoteManifestTotals {
  targets: number;
  existing: number;
  created: number;
  missing: number;
  refused: number;
}

/**
 * The deterministic local manifest written to
 * `artifacts/cloudflare-m5/d1-remote-manifest.json`. It contains no wall-clock
 * timestamp, so identical remote state produces byte-identical JSON.
 */
export interface D1RemoteManifest {
  version: typeof D1_REMOTE_BOOTSTRAP_VERSION;
  stage: "d1-remote-bootstrap";
  dryRun: boolean;
  applied: boolean;
  location: string;
  targets: D1RemoteManifestTarget[];
  totals: D1RemoteManifestTotals;
  /** Wrangler commands the run executed, in order, for the audit trail. */
  commands: string[];
  ok: boolean;
  errors: string[];
}

/**
 * M5.2c PART 2a remote D1 schema-apply operator contract.
 *
 * M5.2c PART 1 created the four remote `worldcons_*` databases. PART 2a applies
 * the M5.1 DDL to those existing databases with the same narrow remote surface:
 *
 * - dry-run by default; only an explicit `--apply` writes DDL to a remote
 *   database (`wrangler d1 execute --remote --file`);
 * - read-only verification: it reads `sqlite_master` through
 *   `d1 execute --command` before any write (and again after an apply) and
 *   confirms every expected table and index name exists. A fully present schema
 *   is a no-op (`action:"none"`, `verified:true`) with no DDL materialized and no
 *   `--file` write, so a re-apply is idempotent;
 * - it never creates or deletes a database, never deploys, never copies data and
 *   never changes production authority;
 * - it fails closed on malformed Wrangler JSON, a missing/ambiguous target or an
 *   unverifiable apply, and records a deterministic local manifest under
 *   `artifacts/cloudflare-m5/d1-remote-schema-apply.json`.
 */
export const D1_REMOTE_SCHEMA_APPLY_VERSION = 1 as const;

/**
 * A target's schema state:
 * - `missing` the remote database does not exist (it is created by PART 1 only);
 * - `existing` the remote database exists; the schema may or may not be present;
 * - `ambiguous` the exact name appears more than once and is refused;
 * - `applied` this run wrote the DDL to the remote database;
 * - `unknown` preflight, apply or verification failed, so the state is unproven.
 */
export const D1_REMOTE_SCHEMA_STATES = [
  "missing",
  "existing",
  "ambiguous",
  "applied",
  "unknown",
] as const;
export type D1RemoteSchemaState = (typeof D1_REMOTE_SCHEMA_STATES)[number];
/** What the run did (or, in dry-run, plans to do) for a target. */
export const D1_REMOTE_SCHEMA_ACTIONS = ["none", "apply", "refused"] as const;
export type D1RemoteSchemaAction = (typeof D1_REMOTE_SCHEMA_ACTIONS)[number];

/** One target's result in the remote schema-apply manifest. */
export interface D1RemoteSchemaManifestTarget {
  name: D1Database;
  binding: string;
  state: D1RemoteSchemaState;
  action: D1RemoteSchemaAction;
  /** Remote database id when known (from `d1 list`/`d1 info`). */
  databaseId: string | null;
  /** `num_tables` reported by `d1 info`, or null when it was not read. */
  reportedTables: number | null;
  /** Expected table count for this database from the M5.1 schema. */
  expectedTables: number;
  /** Expected index count for this database from the M5.1 schema. */
  expectedIndexes: number;
  /** Expected table + index count for this database. */
  expectedObjects: number;
  /** Table + index names confirmed present in `sqlite_master`. */
  foundObjects: number;
  /** Expected objects that were not found during verification. */
  missingObjects: string[];
  /** Whether every expected table and index was confirmed present this run. */
  verified: boolean;
  errors: string[];
}
export interface D1RemoteSchemaManifestTotals {
  targets: number;
  /** Targets this run wrote DDL to (`state:"applied"`). */
  applied: number;
  /** Targets whose full expected object set is confirmed present (`verified`). */
  present: number;
  /** Targets whose remote database does not exist. */
  missing: number;
  /** Targets refused (ambiguous/missing database or an aborted apply). */
  refused: number;
}

/**
 * The deterministic local manifest written to
 * `artifacts/cloudflare-m5/d1-remote-schema-apply.json`. It contains no
 * wall-clock timestamp, so identical remote state produces byte-identical JSON.
 */
export interface D1RemoteSchemaManifest {
  version: typeof D1_REMOTE_SCHEMA_APPLY_VERSION;
  stage: "d1-remote-schema-apply";
  dryRun: boolean;
  applied: boolean;
  targets: D1RemoteSchemaManifestTarget[];
  totals: D1RemoteSchemaManifestTotals;
  /** Wrangler commands the run executed, in order, for the audit trail. */
  commands: string[];
  ok: boolean;
  errors: string[];
}

/**
 * M5.2c PART 2c additive remote D1 migration operator contract.
 *
 * M5.2c PART 2a applied the M5.1 `0001_init.sql` baseline to the four remote
 * `worldcons_*` databases. A later correction to the authored D1 schema (for
 * example a partial unique index that must match the Postgres predicate) cannot
 * edit `0001_init.sql`, because that file is a historical, already-applied
 * baseline. PART 2c adds the narrow companion operator that discovers numbered
 * additive migrations *after* 0001 and applies only the pending ones.
 *
 * Properties:
 *
 * - additive only: `0001` is filtered out of discovery and is never rerun;
 * - dry-run by default; only an explicit `--apply` writes a migration through
 *   `wrangler d1 execute --remote --file`;
 * - each migration carries one or more `-- @d1-verify` directives. A migration
 *   is applied only when at least one expected object is absent or its
 *   `sqlite_master.sql` does not contain every expected fragment, so a rerun
 *   against the corrected state is a verified no-op;
 * - it never creates or deletes a database, never deploys, never copies data and
 *   never changes production authority. It contains no table/row mutation of its
 *   own: it only executes the reviewed migration files it is handed.
 */
export const D1_REMOTE_MIGRATION_APPLY_VERSION = 1 as const;

/**
 * One expected object a migration must produce, verified idempotently against
 * `sqlite_master`. Matching is case-insensitive with all whitespace removed, so
 * `status in ('queued', 'running', 'retry_wait')` matches the stored
 * `WHERE status IN ('queued','running','retry_wait')`.
 */
export interface D1MigrationVerification {
  type: "table" | "index";
  name: string;
  /** Fragments that must all appear in the object's `sqlite_master.sql`. */
  sqlIncludes: string[];
}

/** One additive numbered migration discovered for a database (number > 0001). */
export interface D1RemoteMigration {
  database: D1Database;
  /** Numeric migration order parsed from the `NNNN_` file prefix. */
  number: number;
  /** Zero-padded migration id from the file prefix, for example `"0002"`. */
  id: string;
  /** File basename, for example `"0002_admin_command_runs_partial_dedupe.sql"`. */
  file: string;
  /** The migration SQL, applied verbatim through `d1 execute --file`. */
  sql: string;
  /** The expected objects that prove the migration is applied. */
  verify: D1MigrationVerification[];
}

/** One additive migration source file, before discovery parses and orders it. */
export interface D1MigrationSourceFile {
  database: D1Database;
  file: string;
  sql: string;
}

/** One migration's state within a target. */
export const D1_REMOTE_MIGRATION_STATES = ["pending", "verified", "applied", "unknown"] as const;
export type D1RemoteMigrationState = (typeof D1_REMOTE_MIGRATION_STATES)[number];

export interface D1RemoteMigrationManifestMigration {
  number: number;
  id: string;
  file: string;
  state: D1RemoteMigrationState;
  verified: boolean;
  /** Why a migration is pending or unverified, when that is known. */
  detail: string | null;
  errors: string[];
}

/** One target's result in the remote migration-apply manifest. */
export interface D1RemoteMigrationManifestTarget {
  name: D1Database;
  binding: string;
  state: D1RemoteSchemaState;
  action: D1RemoteSchemaAction;
  /** Remote database id when known (from `d1 list`/`d1 info`). */
  databaseId: string | null;
  /** The discovered migrations for this database, in deterministic order. */
  migrations: D1RemoteMigrationManifestMigration[];
  /** Migrations not yet in their verified state. */
  pending: number;
  /** Migrations this run applied (`state:"applied"`). */
  applied: number;
  /** Whether every discovered migration for this database is verified. */
  verified: boolean;
  errors: string[];
}

export interface D1RemoteMigrationManifestTotals {
  targets: number;
  /** Discovered migrations across every target. */
  migrations: number;
  /** Migrations not yet in their verified state. */
  pending: number;
  /** Migrations this run applied. */
  applied: number;
  /** Targets whose full migration set is verified. */
  present: number;
  /** Targets whose remote database does not exist. */
  missing: number;
  /** Targets refused (ambiguous/missing database or an aborted apply). */
  refused: number;
}

/**
 * The deterministic local manifest written to
 * `artifacts/cloudflare-m5/d1-remote-migration-apply.json`. It contains no
 * wall-clock timestamp, so identical remote state produces byte-identical JSON.
 */
export interface D1RemoteMigrationManifest {
  version: typeof D1_REMOTE_MIGRATION_APPLY_VERSION;
  stage: "d1-remote-migration-apply";
  dryRun: boolean;
  applied: boolean;
  targets: D1RemoteMigrationManifestTarget[];
  totals: D1RemoteMigrationManifestTotals;
  /** Wrangler commands the run executed, in order, for the audit trail. */
  commands: string[];
  ok: boolean;
  errors: string[];
}
