import { canonicalJson } from "@/lib/backfill/canonical-json";
import { columnCanonicalKind } from "../canonical-row";
import type { CanonicalRow, CanonicalScalar } from "../canonical-row";
import { convertTable, migratableTables } from "../convert/pipeline";
import { projectableColumns } from "../convert/select";
import { toCanonicalTableDataset } from "../convert/transform";
import type { CanonicalTableDataset, PostgresRowSource } from "../convert/types";
import type { D1ImportParam, D1ImportStatement } from "../import/types";
import { renderImportStatement, D1_MAX_BOUND_PARAMETERS } from "../import/emitter";
import { base64ToBytes } from "../import/literal";
import { d1ReadStatement } from "../import/apply";
import { d1Schema } from "../schema";
import type { D1ColumnDefinition, D1Database, D1Schema, D1TableDefinition } from "../types";
import { D1RemoteError, parseD1ExecuteResultsJson } from "./classify";
import { selectD1RemoteTargets, type D1RemoteTarget } from "./targets";
import { D1_WRANGLER_CRASH_EXIT_CODE, isWranglerD1ExitError, type WranglerD1Runner } from "./types";

/**
 * M5.2d remote D1 reconciliation.
 *
 * The M5.2c data-copy seam (`data-copy.ts`) is deliberately INSERT-only: it
 * copies a canonical subset and refuses any table whose common primary-key rows
 * have changed. A final audit found nine mutable drift tables where the remote
 * database has no rows the source lacks (`remoteOnly === 0`) but common-PK rows
 * differ, and sometimes source-only rows exist. This NEW operator-only path
 * reconciles exactly that gap without weakening the copy path.
 *
 * Safety contract, enforced here:
 *
 * 1. the source and the remote are read canonically and deterministically by the
 *    authored primary key;
 * 2. the table is classified as `exact` / `insert-only` / `update-only` /
 *    `mixed` / `refused` / `unknown`;
 * 3. the remote-only PK count MUST be zero before any apply, otherwise the table
 *    is refused (never a DELETE);
 * 4. source-only rows may only be PLAIN INSERTs; changed common-PK rows may only
 *    be full-row parameterized UPDATEs by the exact primary key, with every
 *    primary-key column excluded from SET (composite PKs supported);
 * 5. this module contains no DELETE, TRUNCATE, REPLACE, UPSERT/ON CONFLICT, DDL
 *    or PK mutation; INSERTs target source-only keys and UPDATEs never touch a
 *    PK column, so a PK can never change;
 * 6. every value travels as a bound parameter through the injected D1 HTTP
 *    transport (never SQL string interpolation), preserving the JSON / array /
 *    timestamp / bigint-text canonical forms;
 * 7. writes are deterministic bounded chunks (configurable batch size,
 *    conservative default) in a stable order (inserts then updates, PK order);
 * 8. before each write chunk the plan prerequisites are re-checked, and every
 *    insert/update statement re-reads the D1 affected-row count and must match;
 * 9. after apply the full table is re-read from source and remote and must match
 *    on row count AND canonical full-table hash, or the result is non-success;
 * 10. a rerun after a successful apply classifies `exact` and plans zero writes;
 *     a partially applied run recalculates from fresh state and plans only the
 *     remaining inserts/updates;
 * 11. the source may change during apply (Supabase stays the authority), so any
 *     final drift fails verification rather than silently succeeding;
 * 12. the operator CLI exposes an explicit, narrow option surface and never
 *     applies to every database implicitly.
 *
 * The Wrangler child-process adapter and the `pg` source are injected by the
 * operator CLI, so this module stays free of `node:child_process` and `pg`.
 */
export const D1_REMOTE_RECONCILE_VERSION = 1 as const;

/** The reload-only databases this seam reconciles; `worldcons_search` is skipped. */
export const D1_REMOTE_RECONCILE_DATABASES: readonly D1Database[] = [
  "worldcons_core",
  "worldcons_ingest",
  "worldcons_ops",
];

/**
 * A table's reconciliation classification:
 * - `exact`       the remote already equals the canonical source (no writes);
 * - `insert-only` only source-only rows are missing (plain inserts);
 * - `update-only` only common-PK rows changed (full-row updates);
 * - `mixed`       both source-only rows and changed common-PK rows exist;
 * - `refused`     the table cannot be reconciled safely (remote-only rows, a
 *                 duplicate/unstable key, a missing PK or a partial read);
 * - `unknown`     a read or verification failed, so the state is unproven.
 */
export const D1_REMOTE_RECONCILE_STATES = [
  "exact",
  "insert-only",
  "update-only",
  "mixed",
  "refused",
  "unknown",
] as const;
export type D1RemoteReconcileState = (typeof D1_REMOTE_RECONCILE_STATES)[number];

/** What the run did (or, in dry-run, plans to do) for a table. */
export const D1_REMOTE_RECONCILE_ACTIONS = ["none", "reconcile", "refused"] as const;
export type D1RemoteReconcileAction = (typeof D1_REMOTE_RECONCILE_ACTIONS)[number];

/** Conservative default rows per source/remote read batch. */
export const D1_REMOTE_RECONCILE_DEFAULT_BATCH_SIZE = 500;
/** Conservative default rows per multi-row INSERT statement. */
export const D1_REMOTE_RECONCILE_DEFAULT_ROWS_PER_INSERT = 50;

/** One table's reconciliation comparison/result. */
export interface D1RemoteReconcileTableTarget {
  table: string;
  database: D1Database;
  sourceTable: string;
  state: D1RemoteReconcileState;
  action: D1RemoteReconcileAction;
  /** Canonical rows the M5.2a transform expects for this table. */
  expectedRowCount: number;
  /** Canonical hash the transform produced for this table. */
  expectedHash: string;
  /** Rows present on the remote table at comparison time. */
  remoteRowCount: number;
  /** Remote canonical hash when the full dataset was read, otherwise null. */
  remoteHash: string | null;
  /** Source-only PKs to insert (plain INSERTs). */
  insertRowCount: number;
  /** Common-PK rows whose canonical row changed (full-row UPDATEs). */
  updateRowCount: number;
  /** Remote-only PKs; MUST be 0 before any apply. */
  remoteOnlyRowCount: number;
  /** Common-PK rows that already match exactly. */
  commonUnchangedRowCount: number;
  /** Insert statements actually executed (apply) or planned (dry-run). */
  insertStatementCount: number;
  /** Update statements actually executed (apply) or planned (dry-run). */
  updateStatementCount: number;
  /** Whether the remote table now equals the canonical dataset exactly. */
  verified: boolean;
  errors: string[];
}

/** One database's reconciliation result. */
export interface D1RemoteReconcileManifestTarget {
  name: D1Database;
  binding: string;
  state: D1RemoteReconcileState;
  action: D1RemoteReconcileAction;
  tableCount: number;
  expectedRowCount: number;
  remoteRowCount: number;
  insertedRowCount: number;
  updatedRowCount: number;
  verified: boolean;
  tables: D1RemoteReconcileTableTarget[];
  errors: string[];
}

export interface D1RemoteReconcileManifestTotals {
  databases: number;
  tables: number;
  expectedRows: number;
  remoteRows: number;
  insertedRows: number;
  updatedRows: number;
  /** Tables already exactly present (`state:"exact"`). */
  exact: number;
  insertOnly: number;
  updateOnly: number;
  mixed: number;
  /** Tables refused or unverified. */
  refused: number;
}

/**
 * The deterministic local manifest written to
 * `artifacts/cloudflare-m5/d1-remote-reconcile.json`. It contains no wall-clock
 * timestamp, so identical remote state produces byte-identical JSON.
 */
export interface D1RemoteReconcileManifest {
  version: typeof D1_REMOTE_RECONCILE_VERSION;
  stage: "d1-remote-reconcile";
  dryRun: boolean;
  applied: boolean;
  targets: D1RemoteReconcileManifestTarget[];
  totals: D1RemoteReconcileManifestTotals;
  /** Wrangler commands the run executed, in order, for the audit trail. */
  commands: string[];
  ok: boolean;
  errors: string[];
}

export interface BuildD1RemoteReconcileManifestOptions {
  /** The Wrangler invocation boundary. Tests pass a fake runner. */
  runner: WranglerD1Runner;
  /** The read-only Postgres export boundary (the M5.2a source contract). */
  source: PostgresRowSource;
  /** Write to the remote databases only when this is explicitly true. */
  apply?: boolean;
  /** Optional subset of targets; `worldcons_search` is always skipped. */
  databases?: readonly D1Database[];
  /**
   * Optional subset of migratable table names. When set, only those tables are
   * reconciled in the authored deterministic order; duplicates collapse to a
   * single entry and an empty array selects zero tables (and zero writes). A name
   * that is not migratable in any selected reconcilable database fails closed
   * before any remote read or write. Omit to process every migratable table.
   */
  tables?: readonly string[];
  /** The D1 schema to reconcile. Defaults to the live M5.1 schema. */
  schema?: D1Schema;
  /** Rows per source and remote read batch. */
  batchSize?: number;
  /** Rows per multi-row INSERT statement; clamped to the D1 parameter limit. */
  rowsPerInsertStatement?: number | null;
  /**
   * Executes one parameterized write through a bound-parameter surface (the D1
   * HTTP query API). It receives the ORIGINAL `?` SQL plus its bound values, never
   * a literal rendering, and its resolved D1 affected-row count, which must equal
   * the statement's expected row count. Required in apply mode (dry-run plans
   * without writing).
   */
  executeStatement?: (
    database: D1Database,
    statement: D1ImportStatement,
  ) => Promise<{ changes: number }>;
  /**
   * Optional READ fallback for the remote comparison reads. It executes the SAME
   * read-only statement through a bound-parameter HTTP surface and returns its
   * rows. It is used ONLY when the Wrangler `d1 execute --command` invocation
   * rejects with a `WranglerD1ExitError` whose `exitCode` is exactly
   * `D1_WRANGLER_CRASH_EXIT_CODE`. Every other failure stays fail-closed. Never
   * used for a write.
   */
  executeRemoteQuery?: (
    database: D1Database,
    statement: D1ImportStatement,
  ) => Promise<Record<string, unknown>[]>;
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

function assertIdentifier(name: string): string {
  if (!IDENTIFIER.test(name)) throw new Error(`invalid D1 identifier: ${name}`);
  return name;
}

function message(error: unknown): string {
  if (error instanceof D1RemoteError || error instanceof Error) return error.message;
  return String(error);
}

/**
 * Revives a stored remote D1 row into the value shape the M5.1 canonicalizer
 * consumes. JSON-family columns are stored as canonical JSON text and are parsed
 * back so the shared canonicalizer re-derives the identical text and the remote
 * hash is directly comparable.
 */
function reviveRow(table: D1TableDefinition, row: Record<string, unknown>): Record<string, unknown> {
  const revived: Record<string, unknown> = {};
  for (const column of table.columns) {
    const value = row[column.name] ?? null;
    const kind = columnCanonicalKind(column);
    revived[column.name] = (kind === "json" || kind === "array") && typeof value === "string" ? JSON.parse(value) : value;
  }
  return revived;
}

/**
 * The deterministic canonical primary-key identity of a row: the canonical JSON
 * of its declared primary-key column values, in schema order. Composite keys are
 * supported. Returns null when the table declares no primary key (or a declared
 * key column is not a real column).
 */
function canonicalRowKey(table: D1TableDefinition, row: CanonicalRow): string | null {
  if (table.primaryKey.length === 0) return null;
  const values: CanonicalScalar[] = [];
  for (const name of table.primaryKey) {
    if (!table.columns.some((column) => column.name === name)) return null;
    values.push(row[name] ?? null);
  }
  return canonicalJson(values);
}

/** The declared primary-key columns, validated to be real D1 columns. */
function primaryKeyColumns(table: D1TableDefinition): D1ColumnDefinition[] {
  if (table.primaryKey.length === 0) return [];
  const columns: D1ColumnDefinition[] = [];
  for (const name of table.primaryKey) {
    const column = table.columns.find((entry) => entry.name === name);
    if (!column) return [];
    columns.push(column);
  }
  return columns;
}

interface PlannedTable {
  inserts: CanonicalRow[];
  updates: { row: CanonicalRow }[];
  remoteOnly: number;
  unchanged: number;
}

type ReconcileDecision =
  | { kind: "exact" }
  | { kind: "plan"; plan: PlannedTable }
  | { kind: "refused"; reason: string; remoteOnlyRowCount?: number };

/**
 * Classifies the remote table against the canonical dataset and, for a
 * reconcilable table, plans the exact writes:
 *
 * - a remote-only PK (present remotely, absent from the captured source) refuses
 *   the table, because reconciling it would require a DELETE;
 * - a source-only PK is a plain INSERT (never an upsert/replace);
 * - a common PK whose canonical row differs is a full-row UPDATE;
 * - a common PK whose canonical row matches is untouched.
 *
 * A duplicate key on either side, a missing primary key, or a source row whose
 * primary key is not stable refuses the table. Returns `refused` rather than
 * guessing whenever the input cannot be proven safe.
 */
function decideReconcile(
  table: D1TableDefinition,
  source: CanonicalTableDataset,
  remote: CanonicalTableDataset,
): ReconcileDecision {
  if (primaryKeyColumns(table).length !== table.primaryKey.length || table.primaryKey.length === 0) {
    return { kind: "refused", reason: "table has no stable declared primary key" };
  }

  const sourceByKey = new Map<string, CanonicalRow>();
  const sourceOrder: string[] = [];
  for (const row of source.rows) {
    const key = canonicalRowKey(table, row);
    if (key === null || sourceByKey.has(key)) {
      return { kind: "refused", reason: `source has a duplicate or unstable primary key for ${table.name}` };
    }
    if (table.primaryKey.some((name) => row[name] === null)) {
      return { kind: "refused", reason: `source row has a null primary key for ${table.name}` };
    }
    sourceByKey.set(key, row);
    sourceOrder.push(key);
  }

  const remoteByKey = new Map<string, CanonicalRow>();
  for (const row of remote.rows) {
    const key = canonicalRowKey(table, row);
    if (key === null || remoteByKey.has(key)) {
      return { kind: "refused", reason: `remote has a duplicate or unstable primary key for ${table.name}` };
    }
    remoteByKey.set(key, row);
  }

  let remoteOnly = 0;
  for (const key of remoteByKey.keys()) {
    if (!sourceByKey.has(key)) remoteOnly += 1;
  }
  if (remoteOnly > 0) {
    return {
      kind: "refused",
      reason: `${table.name} has ${remoteOnly} remote-only primary key(s); reconciliation never deletes`,
      remoteOnlyRowCount: remoteOnly,
    };
  }

  const inserts: CanonicalRow[] = [];
  let unchanged = 0;
  for (const key of sourceOrder) {
    if (!remoteByKey.has(key)) inserts.push(sourceByKey.get(key) as CanonicalRow);
  }

  const updates: { row: CanonicalRow }[] = [];
  for (const key of sourceOrder) {
    const remoteRow = remoteByKey.get(key);
    if (remoteRow === undefined) continue;
    const sourceRow = sourceByKey.get(key) as CanonicalRow;
    if (canonicalJson(sourceRow) !== canonicalJson(remoteRow)) {
      updates.push({ row: sourceRow });
    } else {
      unchanged += 1;
    }
  }

  if (inserts.length === 0 && updates.length === 0) return { kind: "exact" };
  return { kind: "plan", plan: { inserts, updates, remoteOnly, unchanged } };
}

/**
 * Builds the parameterized full-row UPDATE for a changed common-PK row: every
 * projectable column except the primary-key columns is set, and every primary-key
 * column is bound in the WHERE clause. No value is ever interpolated, and no
 * primary-key column can appear in SET, so a PK can never be mutated.
 */
function buildUpdateStatement(
  table: D1TableDefinition,
  row: CanonicalRow,
  columnByName: Map<string, D1ColumnDefinition>,
): D1ImportStatement {
  const pkNames = new Set(table.primaryKey);
  const setColumns = projectableColumns(table).filter((name) => !pkNames.has(name));
  const tableName = assertIdentifier(table.name);
  const assignments = setColumns.map((name) => `${assertIdentifier(name)} = ?`);
  const where = table.primaryKey.map((name) => `${assertIdentifier(name)} = ?`);
  const params: D1ImportParam[] = [];
  for (const name of setColumns) params.push(paramFor(columnByName.get(name) as D1ColumnDefinition, row));
  for (const name of table.primaryKey) params.push(paramFor(columnByName.get(name) as D1ColumnDefinition, row));
  return {
    sql: `update ${tableName} set ${assignments.join(", ")} where ${where.join(" and ")};`,
    params,
  };
}

function paramFor(column: D1ColumnDefinition, row: CanonicalRow): D1ImportParam {
  const value = row[column.name] ?? null;
  if (value === null) return null;
  if (column.kind === "blob") {
    if (typeof value !== "string") throw new Error(`${column.name} blob value must be canonical base64 text`);
    return base64ToBytes(value);
  }
  return value;
}

/**
 * Emits the ordered parameterized INSERT statements for a set of canonical rows.
 * Rows per statement are derived from the column count and clamped to the D1
 * bound-parameter limit.
 */
function emitInsertStatements(
  table: D1TableDefinition,
  rows: readonly CanonicalRow[],
  rowsPerStatement: number | null,
  columnByName: Map<string, D1ColumnDefinition>,
): D1ImportStatement[] {
  const columns = projectableColumns(table);
  if (columns.length === 0) throw new Error(`${table.name} has no importable columns`);
  const tableName = assertIdentifier(table.name);
  const columnList = columns.map(assertIdentifier).join(", ");
  const limit = Math.max(1, Math.floor(D1_MAX_BOUND_PARAMETERS / Math.max(1, columns.length)));
  const perStatement =
    rowsPerStatement === null
      ? limit
      : Math.max(1, Math.min(limit, Math.floor(rowsPerStatement)));
  const statements: D1ImportStatement[] = [];
  for (let start = 0; start < rows.length; start += perStatement) {
    const chunk = rows.slice(start, start + perStatement);
    const placeholders = chunk.map(() => `(${columns.map(() => "?").join(", ")})`).join(", ");
    const params: D1ImportParam[] = [];
    for (const row of chunk) {
      for (const name of columns) params.push(paramFor(columnByName.get(name) as D1ColumnDefinition, row));
    }
    statements.push({ sql: `insert into ${tableName} (${columnList}) values ${placeholders};`, params });
  }
  return statements;
}

/**
 * Executes one parameterized write and verifies the D1 affected-row count
 * matches the statement's expected row count. A mismatch (a missing common-PK
 * row, a concurrent source change, a partial write) fails closed immediately.
 */
async function writeVerified(
  execute: (database: D1Database, statement: D1ImportStatement) => Promise<{ changes: number }>,
  database: D1Database,
  table: string,
  statement: D1ImportStatement,
  expectedRows: number,
): Promise<void> {
  const outcome = await execute(database, statement);
  const actual = outcome?.changes;
  if (typeof actual !== "number" || !Number.isInteger(actual) || actual !== expectedRows) {
    throw new D1RemoteError(
      "d1_remote.reconcile_affected_mismatch",
      `${table} expected ${expectedRows} affected row(s) but D1 reported ${String(actual)}`,
    );
  }
}

function emptyTableTarget(table: D1TableDefinition, database: D1Database): D1RemoteReconcileTableTarget {
  return {
    table: table.name,
    database,
    sourceTable: table.sourceTable ?? table.name,
    state: "unknown",
    action: "refused",
    expectedRowCount: 0,
    expectedHash: "",
    remoteRowCount: 0,
    remoteHash: null,
    insertRowCount: 0,
    updateRowCount: 0,
    remoteOnlyRowCount: 0,
    commonUnchangedRowCount: 0,
    insertStatementCount: 0,
    updateStatementCount: 0,
    verified: false,
    errors: [],
  };
}

function normalizeTableSelection(tables: readonly string[] | undefined): Set<string> | null {
  if (tables === undefined) return null;
  const selected = new Set<string>();
  for (const table of tables) selected.add(table);
  return selected;
}

function tableTables(
  database: D1Database,
  schema: D1Schema,
  allowed: ReadonlySet<string> | null,
): D1TableDefinition[] {
  const tables = migratableTables(schema, database)
    .slice()
    .sort((left, right) => left.name.localeCompare(right.name));
  return allowed === null ? tables : tables.filter((table) => allowed.has(table.name));
}

function classifyState(insertRows: number, updateRows: number): D1RemoteReconcileState {
  if (insertRows > 0 && updateRows > 0) return "mixed";
  if (insertRows > 0) return "insert-only";
  if (updateRows > 0) return "update-only";
  return "exact";
}

function summarizeTarget(
  target: D1RemoteTarget,
  tables: D1RemoteReconcileTableTarget[],
): D1RemoteReconcileManifestTarget {
  const sum = (pick: (table: D1RemoteReconcileTableTarget) => number): number =>
    tables.reduce((total, table) => total + pick(table), 0);
  const anyUnknown = tables.some((table) => table.state === "unknown");
  const anyRefused = tables.some((table) => table.state === "refused");
  const allExact = tables.length > 0 && tables.every((table) => table.state === "exact");
  const inserted = sum((table) => table.insertRowCount);
  const updated = sum((table) => table.updateRowCount);
  let state: D1RemoteReconcileState;
  if (anyUnknown) state = "unknown";
  else if (anyRefused) state = "refused";
  else if (allExact) state = "exact";
  else if (inserted > 0 && updated > 0) state = "mixed";
  else if (inserted > 0) state = "insert-only";
  else if (updated > 0) state = "update-only";
  else state = "exact";
  return {
    name: target.name,
    binding: target.binding,
    state,
    action: anyUnknown || anyRefused ? "refused" : allExact ? "none" : "reconcile",
    tableCount: tables.length,
    expectedRowCount: sum((table) => table.expectedRowCount),
    remoteRowCount: sum((table) => table.remoteRowCount),
    insertedRowCount: inserted,
    updatedRowCount: updated,
    verified: tables.length > 0 && tables.every((table) => table.verified),
    tables,
    errors: [],
  };
}

/**
 * Reconciles the M5.2a canonical datasets into the three relational remote D1
 * databases: source-only rows as plain INSERTs and changed common-PK rows as
 * full-row parameterized UPDATEs, never a DELETE.
 *
 * The function never throws for a remote failure: it returns a manifest with
 * `ok:false` and per-table errors. It throws only for a caller error (apply
 * without `executeStatement`) or an invalid argument.
 */
export async function buildD1RemoteReconcileManifest(
  options: BuildD1RemoteReconcileManifestOptions,
): Promise<D1RemoteReconcileManifest> {
  const apply = options.apply === true;
  const schema = options.schema ?? d1Schema;
  const batchSize = options.batchSize ?? D1_REMOTE_RECONCILE_DEFAULT_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize <= 0) throw new Error("batchSize must be a positive integer");
  const rowsPerInsert =
    options.rowsPerInsertStatement === undefined
      ? D1_REMOTE_RECONCILE_DEFAULT_ROWS_PER_INSERT
      : options.rowsPerInsertStatement;
  if (apply && typeof options.executeStatement !== "function") {
    throw new Error("executeStatement is required to reconcile remote D1 data");
  }
  const scope = new Set<D1Database>(D1_REMOTE_RECONCILE_DATABASES);
  const targets = selectD1RemoteTargets(options.databases).filter((target) => scope.has(target.name));
  const selectedTables = normalizeTableSelection(options.tables);
  if (selectedTables !== null) {
    const migratableNames = new Set<string>();
    for (const target of targets) {
      for (const table of migratableTables(schema, target.name)) migratableNames.add(table.name);
    }
    const unknown = [...selectedTables].filter((name) => !migratableNames.has(name));
    if (unknown.length > 0) {
      throw new Error(
        `unknown reconcile table selection: ${unknown.join(", ")}; not migratable in the selected reconcile databases`,
      );
    }
  }

  const commands: string[] = [];
  const errors: string[] = [];
  const results: D1RemoteReconcileManifestTarget[] = [];

  async function runWrangler(args: string[]): Promise<string> {
    commands.push(args.join(" "));
    return options.runner(args);
  }

  const executeRemoteQuery = options.executeRemoteQuery;

  /**
   * Executes one remote READ statement through Wrangler, retrying over the
   * injected HTTP query ONLY when that runner invocation rejects with a
   * `WranglerD1ExitError` whose exit code is exactly `D1_WRANGLER_CRASH_EXIT_CODE`
   * and an HTTP query executor is available. This mirrors the data-copy fallback.
   */
  async function readRemoteBatch(
    target: D1RemoteTarget,
    table: D1TableDefinition,
    statement: D1ImportStatement,
    command: string,
  ): Promise<Record<string, unknown>[]> {
    let stdout: string;
    try {
      stdout = await runWrangler([
        "d1",
        "execute",
        target.name,
        "--remote",
        "--yes",
        "--json",
        "--command",
        command,
      ]);
    } catch (error) {
      if (typeof executeRemoteQuery !== "function" || !isWranglerD1ExitError(error, D1_WRANGLER_CRASH_EXIT_CODE)) {
        throw error;
      }
      commands.push(`http-query ${target.name} ${table.name}`);
      return executeRemoteQuery(target.name, statement);
    }
    return parseD1ExecuteResultsJson(stdout);
  }

  async function readRemoteRows(
    target: D1RemoteTarget,
    table: D1TableDefinition,
    limit: number,
  ): Promise<Record<string, unknown>[]> {
    const rows: Record<string, unknown>[] = [];
    let offset = 0;
    for (;;) {
      const statement = d1ReadStatement(table, { limit, offset });
      const command = renderImportStatement(statement);
      const batch = await readRemoteBatch(target, table, statement, command);
      rows.push(...batch);
      if (batch.length < limit) break;
      offset += batch.length;
    }
    return rows;
  }

  function finalize(): D1RemoteReconcileManifest {
    const tables = results.flatMap((target) => target.tables);
    const countState = (state: D1RemoteReconcileState): number =>
      tables.filter((table) => table.state === state).length;
    return {
      version: D1_REMOTE_RECONCILE_VERSION,
      stage: "d1-remote-reconcile",
      dryRun: !apply,
      applied: apply,
      targets: results,
      totals: {
        databases: results.length,
        tables: tables.length,
        expectedRows: tables.reduce((total, table) => total + table.expectedRowCount, 0),
        remoteRows: tables.reduce((total, table) => total + table.remoteRowCount, 0),
        insertedRows: tables.reduce((total, table) => total + table.insertRowCount, 0),
        updatedRows: tables.reduce((total, table) => total + table.updateRowCount, 0),
        exact: countState("exact"),
        insertOnly: countState("insert-only"),
        updateOnly: countState("update-only"),
        mixed: countState("mixed"),
        refused: tables.filter((table) => table.state === "refused" || table.state === "unknown").length,
      },
      commands: [...commands],
      ok: errors.length === 0,
      errors: [...errors],
    };
  }

  if (!options.source.isConfigured()) {
    errors.push("postgres row source is not configured");
    for (const target of targets) {
      results.push(summarizeTarget(target, tableTables(target.name, schema, selectedTables).map((table) => emptyTableTarget(table, target.name))));
    }
    return finalize();
  }

  let aborted = false;
  for (const target of targets) {
    const tables = tableTables(target.name, schema, selectedTables);
    const tableResults: D1RemoteReconcileTableTarget[] = [];
    for (const table of tables) {
      if (aborted) {
        const skipped = emptyTableTarget(table, target.name);
        skipped.state = "refused";
        skipped.action = "refused";
        skipped.errors.push("not attempted: reconcile aborted after an earlier failure");
        tableResults.push(skipped);
        continue;
      }
      let result: D1RemoteReconcileTableTarget;
      try {
        const dataset = await convertTable(table, options.source, { schema, batchSize, maxRows: null });
        const remoteRows = await readRemoteRows(target, table, batchSize);
        const remote = toCanonicalTableDataset(table, remoteRows.map((row) => reviveRow(table, row)));
        result = {
          table: table.name,
          database: table.database,
          sourceTable: table.sourceTable ?? table.name,
          state: "unknown",
          action: "refused",
          expectedRowCount: dataset.rowCount,
          expectedHash: dataset.hash,
          remoteRowCount: remote.rowCount,
          remoteHash: remote.rowCount === dataset.rowCount ? remote.hash : null,
          insertRowCount: 0,
          updateRowCount: 0,
          remoteOnlyRowCount: 0,
          commonUnchangedRowCount: 0,
          insertStatementCount: 0,
          updateStatementCount: 0,
          verified: false,
          errors: [],
        };

        const decision = decideReconcile(table, dataset, remote);
        if (decision.kind === "refused") {
          result.state = "refused";
          result.action = "refused";
          // A refusal still reports what was actually observed: the remote-only
          // count (nonzero for a remote-only refusal, zero otherwise) plus the
          // known source/remote row counts and the full remote canonical hash.
          // Refusing only prohibits writes; it never discards the comparison.
          result.remoteOnlyRowCount = decision.remoteOnlyRowCount ?? 0;
          result.remoteHash = remote.hash;
          result.errors.push(decision.reason);
          errors.push(`${target.name}::${table.name}: ${decision.reason}`);
          aborted = true;
        } else if (decision.kind === "exact") {
          result.state = "exact";
          result.action = "none";
          result.commonUnchangedRowCount = dataset.rowCount;
          result.verified = true;
        } else {
          const { plan } = decision;
          const columnByName = new Map(table.columns.map((column) => [column.name, column]));
          const insertStatements = emitInsertStatements(table, plan.inserts, rowsPerInsert, columnByName);
          const updateStatements = plan.updates.map((entry) => buildUpdateStatement(table, entry.row, columnByName));
          result.state = classifyState(plan.inserts.length, plan.updates.length);
          result.action = "reconcile";
          result.insertRowCount = plan.inserts.length;
          result.updateRowCount = plan.updates.length;
          result.remoteOnlyRowCount = plan.remoteOnly;
          result.commonUnchangedRowCount = plan.unchanged;
          result.insertStatementCount = insertStatements.length;
          result.updateStatementCount = updateStatements.length;

          if (apply) {
            const executeStatement = options.executeStatement as (
              database: D1Database,
              statement: D1ImportStatement,
            ) => Promise<{ changes: number }>;
            // Prerequisite re-check before every write chunk: the plan was
            // computed from a fresh read and must have zero remote-only keys. If
            // not, fail closed rather than guess. (`assertPlanPrerequisites` runs
            // once per chunk below.)
            const assertPlanPrerequisites = (): void => {
              if (result.remoteOnlyRowCount !== 0 || result.state === "refused" || result.state === "unknown") {
                throw new D1RemoteError(
                  "d1_remote.reconcile_remote_only",
                  `${table.name} plan prerequisites are invalid (remote-only=${result.remoteOnlyRowCount}, state=${result.state}); refusing to reconcile`,
                );
              }
            };
            const columns = projectableColumns(table).length;
            for (const statement of insertStatements) {
              assertPlanPrerequisites();
              const expected = statement.params.length / Math.max(1, columns);
              await writeVerified(executeStatement, target.name, table.name, statement, expected);
            }
            for (const statement of updateStatements) {
              assertPlanPrerequisites();
              await writeVerified(executeStatement, target.name, table.name, statement, 1);
            }
            // Re-read BOTH sides from fresh state after apply. Supabase stays the
            // authority: the source is re-read because it may have changed during
            // apply, and the freshly written remote is re-read because a partial or
            // masked write must not pass. The remote must equal the fresh source on
            // row count and canonical full-table hash, so a source mutation during
            // apply fails verification rather than silently succeeding.
            const finalSource = await convertTable(table, options.source, { schema, batchSize, maxRows: null });
            const finalRows = await readRemoteRows(target, table, batchSize);
            const finalDataset = toCanonicalTableDataset(table, finalRows.map((row) => reviveRow(table, row)));
            result.remoteRowCount = finalDataset.rowCount;
            result.remoteHash = finalDataset.hash;
            if (finalDataset.rowCount !== finalSource.rowCount || finalDataset.hash !== finalSource.hash) {
              throw new D1RemoteError(
                "d1_remote.reconcile_final_mismatch",
                `${table.name} final remote dataset (${finalDataset.rowCount} rows, hash ${finalDataset.hash.slice(0, 12)}) != fresh source dataset (${finalSource.rowCount} rows, hash ${finalSource.hash.slice(0, 12)})`,
              );
            }
            result.state = "exact";
            result.verified = true;
          }
        }
      } catch (error) {
        result = emptyTableTarget(table, target.name);
        result.state = "unknown";
        result.action = "refused";
        result.errors.push(message(error));
        errors.push(`${target.name}::${table.name}: ${message(error)}`);
        aborted = true;
      }
      tableResults.push(result);
    }
    const summary = summarizeTarget(target, tableResults);
    summary.errors = tableResults.flatMap((table) => table.errors);
    results.push(summary);
  }

  return finalize();
}
