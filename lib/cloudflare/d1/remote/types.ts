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
