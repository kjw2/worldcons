import { CANONICAL_ROW_HASH_VERSION } from "../canonical-row";
import { CANONICAL_FOUNDATION_VERSION } from "../canonical-values";
import { convertDatabase, skipReason, type ConvertDatabaseOptions } from "../convert/pipeline";
import { CANONICAL_DATABASE_HASH_VERSION } from "../convert/transform";
import {
  CANONICAL_DATASET_VERSION,
  type CanonicalConversionSkipped,
  type CanonicalDatabaseDataset,
  type PostgresRowSource,
} from "../convert/types";
import { d1Schema } from "../schema";
import type { D1Database, D1Schema } from "../types";
import { applyDatabaseImport, applyDatabaseSchema, verifyDatabaseImport } from "./apply";
import { emitDatabaseImport } from "./emitter";
import {
  D1_IMPORT_VERSION,
  type D1DatabaseImport,
  type D1DatabaseVerification,
  type D1ImportReport,
  type D1ImportReportDatabase,
  type D1ImportReportTable,
  type D1ImportTarget,
} from "./types";

/**
 * M5.2b D1 import pipeline: canonical transform -> emit -> local apply -> verify.
 *
 * For every selected database it applies the local DDL, converts the source rows
 * to canonical datasets, emits the parameterized import, applies it, then reads
 * the rows back and re-derives the canonical hashes. The report is only `ok`
 * when the imported database hash equals the transformed hash, so a successful
 * report is evidence of exact round-trip parity, not just a lack of exceptions.
 */
export interface BuildD1ImportReportOptions extends ConvertDatabaseOptions {
  source: PostgresRowSource;
  /** Restrict the import to these D1 databases. */
  databases?: readonly D1Database[];
  /** One target per database; a selected database without a target fails closed. */
  targets: Partial<Record<D1Database, D1ImportTarget>>;
  sourceKind?: string;
  targetKind?: string;
  targetPersistent?: boolean;
  /** Max rows per insert statement; clamped to the D1 parameter limit. */
  rowsPerStatement?: number | null;
  /** Apply the local DDL before importing (default true). */
  prepareSchema?: boolean;
  /** Include the literal import SQL in each database report entry. */
  includeScripts?: boolean;
}

function reportDatabase(
  dataset: CanonicalDatabaseDataset,
  imported: D1DatabaseImport,
  verification: D1DatabaseVerification,
  includeScripts: boolean,
): D1ImportReportDatabase {
  const statementsByTable = new Map(imported.tables.map((table) => [table.table, table]));
  const tables: D1ImportReportTable[] = verification.tables.map((entry) => ({
    table: entry.table,
    database: entry.database,
    sourceTable: entry.sourceTable,
    rowCount: entry.rowCount,
    expectedRowCount: entry.expectedRowCount,
    hash: entry.hash,
    expectedHash: entry.expectedHash,
    statementCount: statementsByTable.get(entry.table)?.statementCount ?? 0,
    ok: entry.ok,
    errors: entry.errors,
  }));
  const script = imported.tables
    .map((table) => table.sql)
    .filter((sql) => sql.length > 0)
    .join("\n");
  return {
    database: dataset.database,
    tableCount: dataset.tableCount,
    rowCount: verification.rowCount,
    expectedRowCount: verification.expectedRowCount,
    hash: verification.hash,
    expectedHash: verification.expectedHash,
    ok: verification.ok,
    tables,
    script: includeScripts ? script : null,
  };
}

/** Builds the M5.2b import report. Local-only: no remote D1 or authority change. */
export async function buildD1ImportReport(options: BuildD1ImportReportOptions): Promise<D1ImportReport> {
  const schema: D1Schema = options.schema ?? d1Schema;
  const selected = options.databases ? new Set(options.databases) : null;
  const databases: D1ImportReportDatabase[] = [];
  let statements = 0;
  for (const database of schema.databases) {
    if (selected !== null && !selected.has(database)) continue;
    const target = options.targets[database];
    if (!target) throw new Error(`no D1 import target for ${database}`);
    if (options.prepareSchema ?? true) applyDatabaseSchema(target, database, schema);
    const dataset = await convertDatabase(database, options.source, options);
    const imported = emitDatabaseImport(database, dataset.tables, {
      schema,
      rowsPerStatement: options.rowsPerStatement ?? null,
    });
    applyDatabaseImport(target, imported);
    const verification = verifyDatabaseImport(target, database, dataset.tables, options);
    statements += imported.tables.reduce((sum, table) => sum + table.statementCount, 0);
    databases.push(reportDatabase(dataset, imported, verification, options.includeScripts ?? false));
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
    version: D1_IMPORT_VERSION,
    stage: "d1-import",
    datasetVersion: CANONICAL_DATASET_VERSION,
    foundationVersion: CANONICAL_FOUNDATION_VERSION,
    rowHashVersion: CANONICAL_ROW_HASH_VERSION,
    databaseHashVersion: CANONICAL_DATABASE_HASH_VERSION,
    target: { kind: options.targetKind ?? "memory", persistent: options.targetPersistent ?? false },
    source: { kind: options.sourceKind ?? "unknown", configured: options.source.isConfigured() },
    databases,
    skipped,
    totals: {
      databases: databases.length,
      tables: databases.reduce((sum, entry) => sum + entry.tableCount, 0),
      rows: databases.reduce((sum, entry) => sum + entry.rowCount, 0),
      statements,
      verified: databases.every((entry) => entry.ok),
    },
  };
}
