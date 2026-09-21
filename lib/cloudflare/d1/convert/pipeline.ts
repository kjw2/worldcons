import { CANONICAL_ROW_HASH_VERSION } from "../canonical-row";
import { CANONICAL_FOUNDATION_VERSION } from "../canonical-values";
import { d1Schema } from "../schema";
import type { D1Database, D1Schema, D1TableDefinition } from "../types";
import { postgresReadRequest } from "./select";
import {
  CANONICAL_DATABASE_HASH_VERSION,
  hashCanonicalDatabase,
  summarizeTableDataset,
  toCanonicalTableDataset,
} from "./transform";
import {
  CANONICAL_DATASET_VERSION,
  type CanonicalConversionReport,
  type CanonicalConversionSkipped,
  type CanonicalDatabaseDataset,
  type CanonicalDatabaseSummary,
  type CanonicalTableDataset,
  type PostgresRowSource,
} from "./types";

const DEFAULT_BATCH_SIZE = 1000;

export interface ConvertDatabaseOptions {
  schema?: D1Schema;
  /** Restrict the conversion to these D1 table names. */
  tables?: readonly string[];
  /** Rows per read batch. */
  batchSize?: number;
  /** Upper bound on rows per table, or null for the whole table. */
  maxRows?: number | null;
}

export interface BuildD1ConversionReportOptions extends ConvertDatabaseOptions {
  source: PostgresRowSource;
  databases?: readonly D1Database[];
  sourceKind?: string;
}
/** D1 tables that are copied from a Postgres source table. */
export function migratableTables(schema: D1Schema, database: D1Database): D1TableDefinition[] {
  return schema.tables.filter((table) => table.database === database && !table.virtual && table.sourceTable !== null);
}

/** Why a table is not copied from Postgres, or null when it is migratable. */
export function skipReason(table: D1TableDefinition): CanonicalConversionSkipped["reason"] | null {
  if (table.virtual) return "virtual";
  if (table.sourceTable === null) return "derived";
  return null;
}

async function readTableRows(
  table: D1TableDefinition,
  source: PostgresRowSource,
  batchSize: number,
  maxRows: number | null,
): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  let offset = 0;
  for (;;) {
    const remaining = maxRows === null ? batchSize : Math.min(batchSize, maxRows - rows.length);
    if (remaining <= 0) break;
    const request = postgresReadRequest(table, { limit: remaining, offset });
    if (request === null) throw new Error(`${table.name} has no Postgres projection`);
    const batch = await source.readRows(request);
    rows.push(...batch);
    if (batch.length < remaining) break;
    offset += batch.length;
  }
  return rows;
}
/** Reads a whole table and returns its canonical dataset. */
export async function convertTable(
  table: D1TableDefinition,
  source: PostgresRowSource,
  options: ConvertDatabaseOptions = {},
): Promise<CanonicalTableDataset> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize <= 0) throw new Error("batchSize must be a positive integer");
  const rows = await readTableRows(table, source, batchSize, options.maxRows ?? null);
  return toCanonicalTableDataset(table, rows);
}

/** Converts one D1 database's migratable tables into a canonical dataset. */
export async function convertDatabase(
  database: D1Database,
  source: PostgresRowSource,
  options: ConvertDatabaseOptions = {},
): Promise<CanonicalDatabaseDataset> {
  if (!source.isConfigured()) throw new Error("postgres row source is not configured");
  const schema = options.schema ?? d1Schema;
  const allowed = options.tables ? new Set(options.tables) : null;
  const tables = migratableTables(schema, database).filter((table) => allowed === null || allowed.has(table.name));
  const datasets: CanonicalTableDataset[] = [];
  for (const table of tables) datasets.push(await convertTable(table, source, options));
  return hashCanonicalDatabase(database, datasets);
}
/** Drops the row payload for the machine-readable report. */
export function summarizeDatabaseDataset(dataset: CanonicalDatabaseDataset): CanonicalDatabaseSummary {
  return {
    version: dataset.version,
    database: dataset.database,
    tableCount: dataset.tableCount,
    rowCount: dataset.rowCount,
    hash: dataset.hash,
    tables: dataset.tables.map(summarizeTableDataset),
  };
}

/** Builds the read-only M5.2a canonical transform report. No D1 write occurs. */
export async function buildD1ConversionReport(
  options: BuildD1ConversionReportOptions,
): Promise<CanonicalConversionReport> {
  const schema = options.schema ?? d1Schema;
  const selected = options.databases ? new Set(options.databases) : null;
  const databases: CanonicalDatabaseSummary[] = [];
  for (const database of schema.databases) {
    if (selected !== null && !selected.has(database)) continue;
    databases.push(summarizeDatabaseDataset(await convertDatabase(database, options.source, options)));
  }
  const skipped: CanonicalConversionSkipped[] = [];
  for (const table of schema.tables) {
    const reason = skipReason(table);
    if (reason !== null && (selected === null || selected.has(table.database))) {
      skipped.push({ table: table.name, database: table.database, reason });
    }
  }
  skipped.sort((left, right) => left.database.localeCompare(right.database) || left.table.localeCompare(right.table));
  return {
    version: CANONICAL_DATASET_VERSION,
    stage: "canonical-transform",
    foundationVersion: CANONICAL_FOUNDATION_VERSION,
    rowHashVersion: CANONICAL_ROW_HASH_VERSION,
    databaseHashVersion: CANONICAL_DATABASE_HASH_VERSION,
    source: { kind: options.sourceKind ?? "unknown", configured: options.source.isConfigured() },
    databases,
    skipped,
    totals: {
      databases: databases.length,
      tables: databases.reduce((sum, entry) => sum + entry.tableCount, 0),
      rows: databases.reduce((sum, entry) => sum + entry.rowCount, 0),
    },
  };
}