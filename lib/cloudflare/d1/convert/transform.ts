import crypto from "node:crypto";
import { canonicalizeRow, compareCanonicalScalar, hashCanonicalTable } from "../canonical-row";
import type { CanonicalRow } from "../canonical-row";
import type { D1Database, D1TableDefinition } from "../types";
import { projectableColumns, relocatedColumnsFor } from "./select";
import {
  CANONICAL_DATASET_VERSION,
  type CanonicalDatabaseDataset,
  type CanonicalTableDataset,
  type CanonicalTableSummary,
} from "./types";

/**
 * Canonical transform (M5.2a).
 *
 * Postgres rows are reduced to canonical scalars through the M5.1 converters and
 * hashed with the M5.1 per-table primitive. Rows are normalized by primary key
 * and database tables by name, so a dataset hash depends only on the row sets,
 * never on read order.
 */
export const CANONICAL_DATABASE_HASH_VERSION = 1;

function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

/** Orders canonical rows by primary key (falls back to full column order). */
export function sortCanonicalRows(table: D1TableDefinition, rows: readonly CanonicalRow[]): CanonicalRow[] {
  const keyColumns = table.primaryKey.length > 0 ? table.primaryKey : table.columns.map((column) => column.name);
  return [...rows].sort((left, right) => {
    for (const key of keyColumns) {
      const comparison = compareCanonicalScalar(left[key] ?? null, right[key] ?? null);
      if (comparison !== 0) return comparison;
    }
    return 0;
  });
}
/** Transforms raw Postgres rows for one D1 table into a canonical dataset. */
export function toCanonicalTableDataset(
  table: D1TableDefinition,
  rawRows: readonly Record<string, unknown>[],
): CanonicalTableDataset {
  if (table.virtual || table.sourceTable === null) {
    throw new Error(`${table.name} is not a migratable Postgres table`);
  }
  const canonicalRows = sortCanonicalRows(table, rawRows.map((row) => canonicalizeRow(table, row)));
  return {
    version: CANONICAL_DATASET_VERSION,
    table: table.name,
    database: table.database,
    sourceTable: table.sourceTable,
    primaryKey: [...table.primaryKey],
    columns: projectableColumns(table),
    relocated: relocatedColumnsFor(table),
    rowCount: canonicalRows.length,
    hash: hashCanonicalTable(table, rawRows).hash,
    rows: canonicalRows,
  };
}

/** Drops the row payload for the machine-readable report. */
export function summarizeTableDataset(dataset: CanonicalTableDataset): CanonicalTableSummary {
  return {
    version: dataset.version,
    table: dataset.table,
    database: dataset.database,
    sourceTable: dataset.sourceTable,
    primaryKey: dataset.primaryKey,
    columns: dataset.columns,
    relocated: dataset.relocated,
    rowCount: dataset.rowCount,
    hash: dataset.hash,
  };
}
/** Hashes a database from its table datasets (order-independent). */
export function hashCanonicalDatabase(
  database: D1Database,
  tables: readonly CanonicalTableDataset[],
): CanonicalDatabaseDataset {
  const sorted = [...tables].sort((left, right) => left.table.localeCompare(right.table));
  const payload = [
    `d1-database/v${CANONICAL_DATABASE_HASH_VERSION}`,
    database,
    ...sorted.map((entry) => `${entry.table}\n${entry.rowCount}\n${entry.hash}`),
  ].join("\n");
  return {
    version: CANONICAL_DATASET_VERSION,
    database,
    tableCount: sorted.length,
    rowCount: sorted.reduce((sum, entry) => sum + entry.rowCount, 0),
    hash: sha256Hex(payload),
    tables: sorted,
  };
}