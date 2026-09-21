import type { CanonicalRow } from "../canonical-row";
import { projectableColumns } from "../convert/select";
import type { CanonicalTableDataset } from "../convert/types";
import { d1Schema } from "../schema";
import type { D1ColumnDefinition, D1Database, D1Schema, D1TableDefinition } from "../types";
import { base64ToBytes, renderSqlLiteral } from "./literal";
import {
  D1_IMPORT_VERSION,
  type D1DatabaseImport,
  type D1ImportParam,
  type D1ImportStatement,
  type D1TableImport,
} from "./types";

/**
 * M5.2b D1 import emitter.
 *
 * A canonical dataset is reduced to parameterized `insert` statements. Values are
 * always bound parameters; the only non-parameter text is the table name and the
 * authored column names, which are re-validated here so a future schema edit
 * cannot produce unsafe SQL.
 *
 * `D1_MAX_BOUND_PARAMETERS` mirrors the D1 limit: a multi-row insert can bind at
 * most 100 parameters, so the rows per statement are derived from the column
 * count (a wide table such as `articles` emits one row per statement).
 */
export const D1_MAX_BOUND_PARAMETERS = 100;

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

function assertImportIdentifier(name: string): string {
  if (!IDENTIFIER.test(name)) throw new Error(`invalid D1 identifier: ${name}`);
  return name;
}

export interface EmitTableImportOptions {
  /** Max rows per insert statement; clamped to the D1 parameter limit. */
  rowsPerStatement?: number | null;
}

function resolveRowsPerStatement(columns: number, requested?: number | null): number {
  const limit = Math.max(1, Math.floor(D1_MAX_BOUND_PARAMETERS / Math.max(1, columns)));
  if (requested === null || requested === undefined) return limit;
  if (!Number.isInteger(requested) || requested <= 0) throw new Error("rowsPerStatement must be a positive integer");
  return Math.min(limit, requested);
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

/** Emits the parameterized insert statements for one canonical table dataset. */
export function emitTableImport(
  table: D1TableDefinition,
  dataset: CanonicalTableDataset,
  options: EmitTableImportOptions = {},
): D1TableImport {
  if (table.virtual || table.sourceTable === null) throw new Error(`${table.name} is not a migratable table`);
  if (dataset.table !== table.name) throw new Error(`${dataset.table} dataset cannot be imported into ${table.name}`);
  if (table.primaryKey.length === 0) throw new Error(`${table.name} has no primary key`);
  const columns = projectableColumns(table);
  if (columns.length === 0) throw new Error(`${table.name} has no importable columns`);
  if (columns.length !== dataset.columns.length || columns.some((name, index) => name !== dataset.columns[index])) {
    throw new Error(`${table.name} dataset columns do not match the D1 schema projection`);
  }
  const tableName = assertImportIdentifier(table.name);
  const columnList = columns.map(assertImportIdentifier).join(", ");
  const columnByName = new Map(table.columns.map((column) => [column.name, column]));
  const perStatement = resolveRowsPerStatement(columns.length, options.rowsPerStatement);

  const statements: D1ImportStatement[] = [];
  let paramCount = 0;
  for (let start = 0; start < dataset.rows.length; start += perStatement) {
    const chunk = dataset.rows.slice(start, start + perStatement);
    const placeholders = chunk.map(() => `(${columns.map(() => "?").join(", ")})`).join(", ");
    const params: D1ImportParam[] = [];
    for (const row of chunk) {
      for (const name of columns) {
        const column = columnByName.get(name);
        if (!column) throw new Error(`${table.name}.${name} is not a D1 column`);
        params.push(paramFor(column, row));
      }
    }
    statements.push({ sql: `insert into ${tableName} (${columnList}) values ${placeholders};`, params });
    paramCount += params.length;
  }
  return {
    version: D1_IMPORT_VERSION,
    table: table.name,
    database: table.database,
    sourceTable: table.sourceTable,
    primaryKey: [...table.primaryKey],
    columns,
    rowCount: dataset.rows.length,
    statementCount: statements.length,
    paramCount,
    statements,
    sql: renderImportSql(statements),
  };
}

/** Renders one parameterized statement as a literal SQLite/D1 statement. */
export function renderImportStatement(statement: D1ImportStatement): string {
  let index = 0;
  const rendered = statement.sql.replace(/\?/g, () => {
    if (index >= statement.params.length) throw new Error("import statement has more placeholders than parameters");
    const value = renderSqlLiteral(statement.params[index]);
    index += 1;
    return value;
  });
  if (index !== statement.params.length) throw new Error("import statement has more parameters than placeholders");
  return rendered;
}

/** Renders a batch of statements as the literal import script. */
export function renderImportSql(statements: readonly D1ImportStatement[]): string {
  return statements.map(renderImportStatement).join("\n");
}

/** Emits the ordered parameterized import for every table of one database. */
export function emitDatabaseImport(
  database: D1Database,
  datasets: readonly CanonicalTableDataset[],
  options: EmitTableImportOptions & { schema?: D1Schema } = {},
): D1DatabaseImport {
  const schema = options.schema ?? d1Schema;
  const tableByName = new Map(schema.tables.map((table) => [table.name, table]));
  const ordered = [...datasets].sort((left, right) => left.table.localeCompare(right.table));
  const tables: D1TableImport[] = [];
  for (const dataset of ordered) {
    if (dataset.database !== database) throw new Error(`${dataset.table} belongs to ${dataset.database}, not ${database}`);
    const table = tableByName.get(dataset.table);
    if (!table) throw new Error(`${dataset.table} is not a D1 schema table`);
    tables.push(emitTableImport(table, dataset, options));
  }
  return {
    version: D1_IMPORT_VERSION,
    database,
    tableCount: tables.length,
    rowCount: tables.reduce((sum, entry) => sum + entry.rowCount, 0),
    tables,
  };
}
