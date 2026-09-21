import { columnCanonicalKind } from "../canonical-row";
import { projectableColumns } from "../convert/select";
import { hashCanonicalDatabase, toCanonicalTableDataset } from "../convert/transform";
import type { CanonicalTableDataset } from "../convert/types";
import { emitDatabaseDdl } from "../ddl";
import { d1Schema } from "../schema";
import type { D1Database, D1Schema, D1TableDefinition } from "../types";
import type {
  D1DatabaseImport,
  D1DatabaseVerification,
  D1ImportParam,
  D1ImportTarget,
  D1TableVerification,
} from "./types";

/**
 * M5.2b local D1 apply and verification.
 *
 * Applying is transactional (begin/rollback around the inserts). Verification is
 * not a "did it not throw" check: it reads each table back through the same
 * projection the transform used, re-derives the canonical dataset, and compares
 * the per-table and per-database hashes. A missing row, an extra row, a coerced
 * value or a type drift all change the hash, so parity is proven rather than
 * assumed.
 */
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

function assertImportIdentifier(name: string): string {
  if (!IDENTIFIER.test(name)) throw new Error(`invalid D1 identifier: ${name}`);
  return name;
}

/**
 * Revives a stored D1 row into the value shape the canonicalizer consumes.
 *
 * The D1 row already stores the canonical scalar, so most columns pass through
 * unchanged. JSON-family columns are stored as canonical JSON text; parsing them
 * back lets the shared M5.1 canonicalizer re-derive the identical text, which
 * proves the emitter and the canonical transform agree byte for byte.
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

/** Creates the local D1 schema on the target (idempotent, local-only DDL). */
export function applyDatabaseSchema(target: D1ImportTarget, database: D1Database, schema: D1Schema = d1Schema): void {
  target.exec(emitDatabaseDdl(database, schema));
}

/** Applies one database's emitted import in a single transaction. */
export function applyDatabaseImport(target: D1ImportTarget, imported: D1DatabaseImport): void {
  target.exec("begin");
  try {
    for (const table of imported.tables) {
      for (const statement of table.statements) target.run(statement.sql, statement.params);
    }
    target.exec("commit");
  } catch (error) {
    target.exec("rollback");
    throw error;
  }
}

/** The bounded, primary-key-ordered read of a D1 table used for verification. */
export function d1ReadStatement(
  table: D1TableDefinition,
  options: { limit?: number | null; offset?: number } = {},
): { sql: string; params: D1ImportParam[] } {
  const columns = projectableColumns(table);
  if (columns.length === 0) throw new Error(`${table.name} has no readable columns`);
  const relation = assertImportIdentifier(table.name);
  const orderBy = table.primaryKey.map(assertImportIdentifier);
  let sql = `select ${columns.map(assertImportIdentifier).join(", ")} from ${relation}`;
  if (orderBy.length > 0) sql += ` order by ${orderBy.join(", ")}`;
  const params: D1ImportParam[] = [];
  if (options.limit !== null && options.limit !== undefined) {
    params.push(options.limit);
    sql += " limit ?";
  }
  if (options.offset !== undefined && options.offset > 0) {
    params.push(options.offset);
    sql += " offset ?";
  }
  return { sql, params };
}

function readTargetRows(
  target: D1ImportTarget,
  table: D1TableDefinition,
  batchSize: number,
  maxRows: number | null,
): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  let offset = 0;
  for (;;) {
    const remaining = maxRows === null ? batchSize : Math.min(batchSize, maxRows - rows.length);
    if (remaining <= 0) break;
    const statement = d1ReadStatement(table, { limit: remaining, offset });
    const batch = target.all(statement.sql, statement.params);
    rows.push(...batch);
    if (batch.length < remaining) break;
    offset += batch.length;
  }
  return rows;
}

export interface VerifyImportOptions {
  batchSize?: number;
  maxRows?: number | null;
  schema?: D1Schema;
}

const DEFAULT_VERIFY_BATCH = 1000;

/** Verifies one table's import round trip and returns the re-derived dataset. */
export function verifyTableImport(
  target: D1ImportTarget,
  table: D1TableDefinition,
  dataset: CanonicalTableDataset,
  options: VerifyImportOptions = {},
): { verification: D1TableVerification; actual: CanonicalTableDataset } {
  const batchSize = options.batchSize ?? DEFAULT_VERIFY_BATCH;
  if (!Number.isInteger(batchSize) || batchSize <= 0) throw new Error("batchSize must be a positive integer");
  const rows = readTargetRows(target, table, batchSize, options.maxRows ?? null);
  const actual = toCanonicalTableDataset(table, rows.map((row) => reviveRow(table, row)));
  const errors: string[] = [];
  if (actual.rowCount !== dataset.rowCount) {
    errors.push(`row count ${actual.rowCount} != expected ${dataset.rowCount}`);
  }
  if (actual.hash !== dataset.hash) {
    errors.push(`canonical hash ${actual.hash.slice(0, 12)} != expected ${dataset.hash.slice(0, 12)}`);
  }
  const verification: D1TableVerification = {
    table: table.name,
    database: table.database,
    sourceTable: table.sourceTable ?? table.name,
    rowCount: actual.rowCount,
    expectedRowCount: dataset.rowCount,
    hash: actual.hash,
    expectedHash: dataset.hash,
    ok: errors.length === 0,
    errors,
  };
  return { verification, actual };
}

/** Verifies a whole database: every table plus the composed database hash. */
export function verifyDatabaseImport(
  target: D1ImportTarget,
  database: D1Database,
  datasets: readonly CanonicalTableDataset[],
  options: VerifyImportOptions = {},
): D1DatabaseVerification {
  const schema = options.schema ?? d1Schema;
  const tableByName = new Map(schema.tables.map((table) => [table.name, table]));
  const ordered = [...datasets].sort((left, right) => left.table.localeCompare(right.table));
  const tables: D1TableVerification[] = [];
  const actualDatasets: CanonicalTableDataset[] = [];
  for (const dataset of ordered) {
    const table = tableByName.get(dataset.table);
    if (!table) throw new Error(`${dataset.table} is not a D1 schema table`);
    const { verification, actual } = verifyTableImport(target, table, dataset, options);
    tables.push(verification);
    actualDatasets.push(actual);
  }
  const expected = hashCanonicalDatabase(database, datasets);
  const actual = hashCanonicalDatabase(database, actualDatasets);
  return {
    database,
    ok: tables.every((entry) => entry.ok) && actual.hash === expected.hash && actual.rowCount === expected.rowCount,
    tableCount: tables.length,
    rowCount: actual.rowCount,
    expectedRowCount: expected.rowCount,
    hash: actual.hash,
    expectedHash: expected.hash,
    tables,
  };
}
