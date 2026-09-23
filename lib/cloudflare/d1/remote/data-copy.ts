import { canonicalJson } from "@/lib/backfill/canonical-json";
import { columnCanonicalKind } from "../canonical-row";
import type { CanonicalRow } from "../canonical-row";
import { convertTable, migratableTables } from "../convert/pipeline";
import { toCanonicalTableDataset } from "../convert/transform";
import type { CanonicalTableDataset, PostgresRowSource } from "../convert/types";
import { d1ReadStatement } from "../import/apply";
import { emitTableImport, renderImportStatement } from "../import/emitter";
import type { D1ImportStatement } from "../import/types";
import { d1Schema } from "../schema";
import type { D1Database, D1Schema, D1TableDefinition } from "../types";
import { D1RemoteError, parseD1ExecuteResultsJson } from "./classify";
import { selectD1RemoteTargets, type D1RemoteTarget } from "./targets";
import type { WranglerD1Runner } from "./types";

/**
 * M5.2c PART 2b remote D1 data copy.
 *
 * M5.2c PART 1 created the four remote `worldcons_*` databases and PART 2a
 * applied the M5.1 DDL to them. This slice copies the M5.2a canonical datasets
 * into the three relational databases through the same narrow, operator-only
 * remote surface:
 *
 * - `worldcons_core`, `worldcons_ingest` and `worldcons_ops` are in scope;
 *   `worldcons_search` is deliberately skipped because its tables are virtual or
 *   derived (the M7 projection rebuilds them, so they are never copied);
 * - the source is read once per table through the injected `PostgresRowSource`
 *   and reduced to canonical datasets with the M5.2a transform;
 * - the remote side is read back with the safe authored projection (D1 columns
 *   only, primary-key order, bounded `LIMIT`/`OFFSET`) through
 *   `d1 execute --remote --yes --json --command`; JSON/array text is revived
 *   before canonicalizing so the remote hash is directly comparable;
 * - the comparison is fail-closed: an empty remote table is `pending`, an exact
 *   full count + hash match is `existing` (a verified no-op with zero writes), a
 *   strict canonical prefix is `resumable` (only the suffix is copied), and
 *   anything else is `refused`;
 * - every copy candidate (pending/resumable) gets a write plan computed once,
 *   before the dry-run/apply branch, so a dry-run reports the exact
 *   `plannedWriteCount`/`plannedParameterizedWriteCount`/`requiresParameterizedWriter`
 *   without materializing a chunk, writing a file or making an HTTP call, and apply
 *   reuses that same plan (`chunkCount` stays the executed write items only);
 * - apply mode is opt-in (`apply:true` plus a `materializeChunk` implementation)
 *   and emits PLAIN `insert` statements only. It never emits
 *   `replace`/`upsert`/`update`/`delete`/`drop`/`create`. Each emitted statement
 *   stays parameterized until it is classified: a statement whose literal
 *   rendering fits `D1_REMOTE_DATA_COPY_MAX_LITERAL_STATEMENT_BYTES` is grouped
 *   into deterministic statement/byte-bounded files and run through
 *   `d1 execute --remote --yes --file`, while an oversized statement flushes any
 *   pending file chunk and is written unfragmented through the injected
 *   `executeParameterized` writer using its ORIGINAL `?` SQL and bound params
 *   (never its literal rendering), so it is never silently materialized. The
 *   writes run serially in authored row order, the write stdout is ignored, the
 *   row count is re-read after every write item and must equal the exact
 *   expected progress, then a final full read/hash check runs. It aborts after
 *   the first failure.
 *
 * It never creates or deletes a database, never applies DDL, never deploys and
 * never changes production authority. The Wrangler child-process adapter and the
 * `pg` source are injected by the operator CLI, so this module stays free of
 * `node:child_process` and `pg`.
 */
export const D1_REMOTE_DATA_COPY_VERSION = 1 as const;

/** The reload-only databases this seam copies; `worldcons_search` is skipped. */
export const D1_REMOTE_DATA_COPY_DATABASES: readonly D1Database[] = [
  "worldcons_core",
  "worldcons_ingest",
  "worldcons_ops",
];

/**
 * A table's remote state after comparison:
 * - `pending`   the remote table is empty;
 * - `existing`  the remote rows exactly match the full canonical dataset;
 * - `resumable` the remote rows are a strict canonical prefix of the dataset;
 * - `applied`   this run copied the missing suffix and the final read matched;
 * - `refused`   the remote rows are neither exact nor a prefix (never written);
 * - `unknown`   a read or verification failed, so the state is unproven.
 */
export const D1_REMOTE_DATA_COPY_STATES = [
  "pending",
  "existing",
  "resumable",
  "applied",
  "refused",
  "unknown",
] as const;
export type D1RemoteDataCopyState = (typeof D1_REMOTE_DATA_COPY_STATES)[number];
/** What the run did (or, in dry-run, plans to do) for a table. */
export const D1_REMOTE_DATA_COPY_ACTIONS = ["none", "copy", "refused"] as const;
export type D1RemoteDataCopyAction = (typeof D1_REMOTE_DATA_COPY_ACTIONS)[number];

/**
 * The largest literal statement a file chunk may carry. A statement whose
 * `renderImportStatement` rendering exceeds this many bytes is never materialized
 * into a chunk file: it is emitted as a parameterized write so its `?` SQL and
 * bound params are sent uncorrupted, staying well under the Wrangler/D1
 * command-length limit a multi-megabyte literal would otherwise breach.
 */
export const D1_REMOTE_DATA_COPY_MAX_LITERAL_STATEMENT_BYTES = 90_000;

/** One migratable table's data-copy comparison/result. */
export interface D1RemoteDataCopyTableTarget {
  table: string;
  database: D1Database;
  sourceTable: string;
  state: D1RemoteDataCopyState;
  action: D1RemoteDataCopyAction;
  /** Canonical rows the M5.2a transform expects for this table. */
  expectedRowCount: number;
  /** Canonical hash the transform produced for this table. */
  expectedHash: string;
  /** Rows present on the remote table at comparison time (the prefix length). */
  remoteRowCount: number;
  /** Remote canonical hash when the full dataset was read, otherwise null. */
  remoteHash: string | null;
  /** Rows this run copied into the remote table. */
  copiedRowCount: number;
  /** Write items this run executed for the table (file chunks plus parameterized statements). */
  chunkCount: number;
  /**
   * Write items the preflight plan would execute for the table, computed for every
   * copy candidate (pending/resumable) in both dry-run and apply, before any write.
   * Zero for a table that needs no copy (existing/refused/empty-source).
   */
  plannedWriteCount: number;
  /** Planned write items that must go through the parameterized writer. */
  plannedParameterizedWriteCount: number;
  /** True when the plan contains an oversized statement that needs the parameterized writer. */
  requiresParameterizedWriter: boolean;
  /** Whether the remote table now equals the canonical dataset exactly. */
  verified: boolean;
  errors: string[];
}

/** One database's data-copy result. */
export interface D1RemoteDataCopyManifestTarget {
  name: D1Database;
  binding: string;
  state: D1RemoteDataCopyState;
  action: D1RemoteDataCopyAction;
  tableCount: number;
  expectedRowCount: number;
  remoteRowCount: number;
  copiedRowCount: number;
  verified: boolean;
  tables: D1RemoteDataCopyTableTarget[];
  errors: string[];
}

export interface D1RemoteDataCopyManifestTotals {
  databases: number;
  tables: number;
  expectedRows: number;
  remoteRows: number;
  copiedRows: number;
  /** Tables already exactly present (`state:"existing"`). */
  existing: number;
  /** Tables whose remote rows are a strict canonical prefix. */
  resumable: number;
  /** Tables whose remote table is empty. */
  pending: number;
  /** Tables this run copied (`state:"applied"`). */
  copied: number;
  /** Tables refused or unverified. */
  refused: number;
  /** Sum of every table's planned write items (dry-run preflight). */
  plannedWrites: number;
  /** Sum of every table's planned parameterized write items. */
  plannedParameterizedWrites: number;
  /** Tables whose plan requires the parameterized writer. */
  parameterizedTables: number;
}

/**
 * The deterministic local manifest written to
 * `artifacts/cloudflare-m5/d1-remote-data-copy.json`. It contains no wall-clock
 * timestamp, so identical remote state produces byte-identical JSON.
 */
export interface D1RemoteDataCopyManifest {
  version: typeof D1_REMOTE_DATA_COPY_VERSION;
  stage: "d1-remote-data-copy";
  dryRun: boolean;
  applied: boolean;
  targets: D1RemoteDataCopyManifestTarget[];
  totals: D1RemoteDataCopyManifestTotals;
  /** Wrangler commands the run executed, in order, for the audit trail. */
  commands: string[];
  ok: boolean;
  errors: string[];
}

export interface BuildD1RemoteDataCopyManifestOptions {
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
   * compared/copied in the authored deterministic order; duplicates collapse to
   * a single entry and an empty array selects zero tables (and zero writes). A
   * name that is not migratable in any selected copy database fails closed
   * before any remote read or write. Omit to process every migratable table.
   */
  tables?: readonly string[];
  /** The D1 schema to copy. Defaults to the live M5.1 schema. */
  schema?: D1Schema;
  /** Rows per source and remote read batch. */
  batchSize?: number;
  /** Upper bound on rows read per table, or null for the whole table. */
  maxRows?: number | null;
  /** Max rows per insert statement; clamped to the D1 parameter limit. */
  rowsPerStatement?: number | null;
  /** Max statements per chunk file. */
  maxStatementsPerChunk?: number;
  /** Max bytes per chunk file. */
  maxBytesPerChunk?: number;
  /**
   * Persists one chunk's plain-insert SQL and returns the path passed to
   * `wrangler d1 execute --file`. Required in apply mode. Called serially, once
   * per chunk, with the authored D1 table name and the chunk's zero-based index
   * within that table (deterministic for identical inputs).
   */
  materializeChunk?: (database: D1Database, table: string, chunkIndex: number, sql: string) => string;
  /**
   * Executes one oversized statement through a bound-parameter surface (for
   * example `wrangler d1 execute --command` with positional params) instead of a
   * literal file chunk. Called serially, in authored row order, only for a
   * statement whose literal rendering exceeds
   * `D1_REMOTE_DATA_COPY_MAX_LITERAL_STATEMENT_BYTES`. It receives the ORIGINAL
   * parameterized statement (the `?` SQL plus its bound values), never its
   * literal rendering. When an oversized statement must be written and this is
   * absent, apply fails closed before any write for that table.
   */
  executeParameterized?: (database: D1Database, statement: D1ImportStatement) => Promise<void>;
  /** Diagnostics only: the configured source kind. */
  sourceKind?: string;
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const DEFAULT_BATCH_SIZE = 1000;
const DEFAULT_MAX_STATEMENTS_PER_CHUNK = 100;
const DEFAULT_MAX_BYTES_PER_CHUNK = 500_000;
const encoder = new TextEncoder();

function assertDataCopyIdentifier(name: string): string {
  if (!IDENTIFIER.test(name)) throw new Error(`invalid D1 identifier: ${name}`);
  return name;
}

function message(error: unknown): string {
  if (error instanceof D1RemoteError || error instanceof Error) return error.message;
  return String(error);
}

function byteLength(value: string): number {
  return encoder.encode(value).length;
}

/**
 * Revives a stored remote D1 row into the value shape the M5.1 canonicalizer
 * consumes. D1 stores canonical scalar text; JSON-family columns are stored as
 * canonical JSON text and are parsed back so the shared canonicalizer re-derives
 * the identical text and the remote hash is directly comparable. Mirrors the
 * local import verifier.
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

/** True when `prefix` equals the first rows of `full` under canonical JSON. */
function isCanonicalPrefix(full: readonly CanonicalRow[], prefix: readonly CanonicalRow[]): boolean {
  if (prefix.length > full.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (canonicalJson(full[index]) !== canonicalJson(prefix[index])) return false;
  }
  return true;
}

type RemoteComparison = "pending" | "existing" | "resumable" | "refused";

/** Classifies the remote table against the canonical dataset, fail-closed. */
function compareRemote(source: CanonicalTableDataset, remote: CanonicalTableDataset): RemoteComparison {
  if (remote.rowCount === source.rowCount && remote.hash === source.hash) return "existing";
  if (remote.rowCount === 0) return "pending";
  if (remote.rowCount < source.rowCount && isCanonicalPrefix(source.rows, remote.rows)) return "resumable";
  return "refused";
}

/**
 * One planned write, in authored row order:
 * - `file`      a deterministic chunk file (literal SQL) run through
 *               `wrangler d1 execute --file`;
 * - `parameter` one oversized statement kept parameterized (its original `?` SQL
 *               plus bound params) for the injected parameterized writer.
 */
type PlannedWrite =
  | { kind: "file"; sql: string; rowCount: number }
  | { kind: "parameter"; statement: D1ImportStatement; rowCount: number };

/**
 * Classifies the plain-insert suffix into ordered write items. Statements come
 * from the M5.2b emitter (so the D1 bound-parameter limit is respected) and stay
 * parameterized until classified here. A statement whose literal rendering fits
 * the literal-statement threshold is grouped greedily, bounded by statement count
 * and byte size; a statement whose literal rendering exceeds the threshold flushes
 * any pending file chunk and is emitted as a parameterized write carrying the
 * ORIGINAL statement, so an oversized row is never materialized into a file.
 */
function planWrites(
  table: D1TableDefinition,
  dataset: CanonicalTableDataset,
  from: number,
  options: { rowsPerStatement?: number | null; maxStatements: number; maxBytes: number },
): { writes: PlannedWrite[]; totalRows: number } {
  const rows = dataset.rows.slice(from);
  const suffix: CanonicalTableDataset = { ...dataset, rowCount: rows.length, rows };
  const imported = emitTableImport(table, suffix, { rowsPerStatement: options.rowsPerStatement ?? null });
  const columns = imported.columns.length;
  const writes: PlannedWrite[] = [];
  let pendingSql: string[] = [];
  let pendingBytes = 0;
  let pendingRows = 0;
  const flush = (): void => {
    if (pendingSql.length === 0) return;
    writes.push({ kind: "file", sql: pendingSql.join("\n"), rowCount: pendingRows });
    pendingSql = [];
    pendingBytes = 0;
    pendingRows = 0;
  };
  for (const statement of imported.statements) {
    const rowCount = columns > 0 ? statement.params.length / columns : 0;
    const rendered = renderImportStatement(statement);
    const renderedBytes = byteLength(rendered);
    if (renderedBytes > D1_REMOTE_DATA_COPY_MAX_LITERAL_STATEMENT_BYTES) {
      flush();
      writes.push({ kind: "parameter", statement, rowCount });
      continue;
    }
    const size = renderedBytes + 1;
    if (pendingSql.length > 0 && (pendingSql.length >= options.maxStatements || pendingBytes + size > options.maxBytes)) {
      flush();
    }
    pendingSql.push(rendered);
    pendingBytes += size;
    pendingRows += rowCount;
  }
  flush();
  return { writes, totalRows: rows.length };
}

function emptyTableTarget(table: D1TableDefinition): D1RemoteDataCopyTableTarget {
  return {
    table: table.name,
    database: table.database,
    sourceTable: table.sourceTable ?? table.name,
    state: "unknown",
    action: "refused",
    expectedRowCount: 0,
    expectedHash: "",
    remoteRowCount: 0,
    remoteHash: null,
    copiedRowCount: 0,
    chunkCount: 0,
    plannedWriteCount: 0,
    plannedParameterizedWriteCount: 0,
    requiresParameterizedWriter: false,
    verified: false,
    errors: [],
  };
}

/**
 * `null` means "every migratable table"; a set (possibly empty) is an explicit
 * selection. Duplicates collapse to one and an empty array selects zero tables.
 */
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

function summarizeTarget(target: D1RemoteTarget, tables: D1RemoteDataCopyTableTarget[]): D1RemoteDataCopyManifestTarget {
  const sum = (pick: (table: D1RemoteDataCopyTableTarget) => number): number =>
    tables.reduce((total, table) => total + pick(table), 0);
  const anyUnknown = tables.some((table) => table.state === "unknown");
  const anyRefused = tables.some((table) => table.state === "refused");
  const allExisting = tables.length > 0 && tables.every((table) => table.state === "existing");
  const anyApplied = tables.some((table) => table.state === "applied");
  const anyResumable = tables.some((table) => table.state === "resumable");
  let state: D1RemoteDataCopyState;
  if (anyUnknown) state = "unknown";
  else if (anyRefused) state = "refused";
  else if (allExisting) state = "existing";
  else if (anyApplied) state = "applied";
  else if (anyResumable) state = "resumable";
  else state = "pending";
  return {
    name: target.name,
    binding: target.binding,
    state,
    action: anyUnknown || anyRefused ? "refused" : allExisting ? "none" : "copy",
    tableCount: tables.length,
    expectedRowCount: sum((table) => table.expectedRowCount),
    remoteRowCount: sum((table) => table.remoteRowCount),
    copiedRowCount: sum((table) => table.copiedRowCount),
    verified: tables.length > 0 && tables.every((table) => table.verified),
    tables,
    errors: [],
  };
}

/**
 * Preflights, compares and (only with `apply` plus `materializeChunk`) copies the
 * M5.2a canonical datasets into the three relational remote D1 databases.
 *
 * The function never throws for a remote failure: it returns a manifest with
 * `ok:false` and per-table errors. It throws only for a caller error (apply
 * without `materializeChunk`) or an invalid argument.
 */
export async function buildD1RemoteDataCopyManifest(
  options: BuildD1RemoteDataCopyManifestOptions,
): Promise<D1RemoteDataCopyManifest> {
  const apply = options.apply === true;
  const schema = options.schema ?? d1Schema;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize <= 0) throw new Error("batchSize must be a positive integer");
  const maxStatementsPerChunk = options.maxStatementsPerChunk ?? DEFAULT_MAX_STATEMENTS_PER_CHUNK;
  if (!Number.isInteger(maxStatementsPerChunk) || maxStatementsPerChunk <= 0) {
    throw new Error("maxStatementsPerChunk must be a positive integer");
  }
  const maxBytesPerChunk = options.maxBytesPerChunk ?? DEFAULT_MAX_BYTES_PER_CHUNK;
  if (!Number.isInteger(maxBytesPerChunk) || maxBytesPerChunk <= 0) {
    throw new Error("maxBytesPerChunk must be a positive integer");
  }
  if (apply && typeof options.materializeChunk !== "function") {
    throw new Error("materializeChunk is required to copy remote D1 data");
  }
  const scope = new Set<D1Database>(D1_REMOTE_DATA_COPY_DATABASES);
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
        `unknown data-copy table selection: ${unknown.join(", ")}; not migratable in the selected copy databases`,
      );
    }
  }

  const commands: string[] = [];
  const errors: string[] = [];
  const results: D1RemoteDataCopyManifestTarget[] = [];

  async function runWrangler(args: string[]): Promise<string> {
    commands.push(args.join(" "));
    return options.runner(args);
  }

  /** Bounded, primary-key-ordered remote read of the authored projection. */
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
      const batch = parseD1ExecuteResultsJson(
        await runWrangler(["d1", "execute", target.name, "--remote", "--yes", "--json", "--command", command]),
      );
      rows.push(...batch);
      if (batch.length < limit) break;
      offset += batch.length;
    }
    return rows;
  }

  async function readRemoteRowCount(target: D1RemoteTarget, table: D1TableDefinition): Promise<number> {
    const command = `select count(*) as n from ${assertDataCopyIdentifier(table.name)}`;
    const rows = parseD1ExecuteResultsJson(
      await runWrangler(["d1", "execute", target.name, "--remote", "--yes", "--json", "--command", command]),
    );
    const value = rows[0]?.n;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      throw new D1RemoteError("d1_remote.malformed_count", `count(*) for ${table.name} was not a non-negative integer`);
    }
    return value;
  }

  function finalize(): D1RemoteDataCopyManifest {
    const tables = results.flatMap((target) => target.tables);
    const countState = (state: D1RemoteDataCopyState): number =>
      tables.filter((table) => table.state === state).length;
    return {
      version: D1_REMOTE_DATA_COPY_VERSION,
      stage: "d1-remote-data-copy",
      dryRun: !apply,
      applied: apply,
      targets: results,
      totals: {
        databases: results.length,
        tables: tables.length,
        expectedRows: tables.reduce((total, table) => total + table.expectedRowCount, 0),
        remoteRows: tables.reduce((total, table) => total + table.remoteRowCount, 0),
        copiedRows: tables.reduce((total, table) => total + table.copiedRowCount, 0),
        existing: countState("existing"),
        resumable: countState("resumable"),
        pending: countState("pending"),
        copied: countState("applied"),
        refused: tables.filter((table) => table.state === "refused" || table.state === "unknown").length,
        plannedWrites: tables.reduce((total, table) => total + table.plannedWriteCount, 0),
        plannedParameterizedWrites: tables.reduce((total, table) => total + table.plannedParameterizedWriteCount, 0),
        parameterizedTables: tables.filter((table) => table.requiresParameterizedWriter).length,
      },
      commands: [...commands],
      ok: errors.length === 0,
      errors: [...errors],
    };
  }

  if (!options.source.isConfigured()) {
    errors.push("postgres row source is not configured");
    for (const target of targets) {
      results.push(summarizeTarget(target, tableTables(target.name, schema, selectedTables).map(emptyTableTarget)));
    }
    return finalize();
  }

  let aborted = false;
  for (const target of targets) {
    const tables = tableTables(target.name, schema, selectedTables);
    const tableResults: D1RemoteDataCopyTableTarget[] = [];
    for (const table of tables) {
      if (aborted) {
        const skipped = emptyTableTarget(table);
        skipped.state = "refused";
        skipped.action = "refused";
        skipped.errors.push("not attempted: data copy aborted after an earlier failure");
        tableResults.push(skipped);
        continue;
      }
      let result: D1RemoteDataCopyTableTarget;
      try {
        const dataset = await convertTable(table, options.source, { schema, batchSize, maxRows: options.maxRows ?? null });
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
          copiedRowCount: 0,
          chunkCount: 0,
          plannedWriteCount: 0,
          plannedParameterizedWriteCount: 0,
          requiresParameterizedWriter: false,
          verified: false,
          errors: [],
        };

        const comparison = compareRemote(dataset, remote);
        if (comparison === "existing") {
          result.state = "existing";
          result.action = "none";
          result.verified = true;
        } else if (comparison === "refused") {
          result.state = "refused";
          result.action = "refused";
          result.errors.push(
            `remote rows (${remote.rowCount}) are neither the full dataset (${dataset.rowCount} rows, hash ${dataset.hash.slice(0, 12)}) nor a canonical prefix`,
          );
          errors.push(`${target.name}::${table.name}: remote rows are not a canonical prefix; refused`);
          aborted = true;
        } else {
          // A pending/resumable table is a copy candidate. Plan its writes once, here
          // and before the apply branch, so the dry-run preflight records the exact
          // plan while materializing nothing, writing nothing and making no HTTP call,
          // and apply reuses this same plan instead of recomputing it. `chunkCount`
          // below stays executed write items only.
          const { writes, totalRows } = planWrites(table, dataset, remote.rowCount, {
            rowsPerStatement: options.rowsPerStatement ?? null,
            maxStatements: maxStatementsPerChunk,
            maxBytes: maxBytesPerChunk,
          });
          result.plannedWriteCount = writes.length;
          result.plannedParameterizedWriteCount = writes.filter((write) => write.kind === "parameter").length;
          result.requiresParameterizedWriter = result.plannedParameterizedWriteCount > 0;
          if (!apply) {
            result.state = comparison;
            result.action = "copy";
          } else {
            const executeParameterized = options.executeParameterized;
            // Fail closed before any write when an oversized statement needs the
            // parameterized writer but none was injected: never silently materialize
            // an oversized statement into a file chunk instead.
            if (result.requiresParameterizedWriter && typeof executeParameterized !== "function") {
              throw new D1RemoteError(
                "d1_remote.data_copy_oversized_statement",
                `${table.name} has a statement larger than ${D1_REMOTE_DATA_COPY_MAX_LITERAL_STATEMENT_BYTES} bytes but no parameterized writer is configured`,
              );
            }
            let expected = remote.rowCount;
            let fileChunkIndex = 0;
            for (const write of writes) {
              if (write.kind === "file") {
                const path = (
                  options.materializeChunk as (database: D1Database, table: string, chunkIndex: number, sql: string) => string
                )(target.name, table.name, fileChunkIndex, write.sql);
                fileChunkIndex += 1;
                // The write stdout is deliberately not parsed: the runner rejects a
                // non-zero exit and the count/hash re-reads below are authoritative.
                await runWrangler(["d1", "execute", target.name, "--remote", "--yes", "--file", path]);
              } else {
                await (executeParameterized as (database: D1Database, statement: D1ImportStatement) => Promise<void>)(
                  target.name,
                  write.statement,
                );
              }
              const actual = await readRemoteRowCount(target, table);
              if (actual !== expected + write.rowCount) {
                throw new D1RemoteError(
                  "d1_remote.data_copy_progress_mismatch",
                  `${table.name} expected ${expected + write.rowCount} rows after a ${write.rowCount}-row ${write.kind === "file" ? "chunk" : "statement"}, found ${actual}`,
                );
              }
              expected = actual;
            }
            const finalRows = await readRemoteRows(target, table, batchSize);
            const finalDataset = toCanonicalTableDataset(table, finalRows.map((row) => reviveRow(table, row)));
            result.remoteRowCount = finalDataset.rowCount;
            result.remoteHash = finalDataset.hash;
            result.copiedRowCount = totalRows;
            result.chunkCount = writes.length;
            if (finalDataset.rowCount !== dataset.rowCount || finalDataset.hash !== dataset.hash) {
              throw new D1RemoteError(
                "d1_remote.data_copy_final_mismatch",
                `${table.name} final remote dataset (${finalDataset.rowCount} rows, hash ${finalDataset.hash.slice(0, 12)}) != canonical dataset (${dataset.rowCount} rows, hash ${dataset.hash.slice(0, 12)})`,
              );
            }
            result.state = "applied";
            result.action = "copy";
            result.verified = true;
          }
        }
      } catch (error) {
        result = emptyTableTarget(table);
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
