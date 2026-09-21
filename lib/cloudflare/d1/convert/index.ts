/**
 * M5.2a canonical transform barrel.
 *
 * The read-only Postgres export adapter (`postgres-source.ts`) is intentionally
 * NOT re-exported here: it imports `pg`, and runtime Workers code must never
 * load it. Only the operator CLI imports that module directly.
 */
export * from "./types";
export {
  assertPostgresIdentifier,
  postgresReadRequest,
  postgresRelationFor,
  projectableColumns,
  relocatedColumnsFor,
} from "./select";
export {
  CANONICAL_DATABASE_HASH_VERSION,
  hashCanonicalDatabase,
  sortCanonicalRows,
  summarizeTableDataset,
  toCanonicalTableDataset,
} from "./transform";
export { createMemoryRowSource } from "./memory-source";
export type { MemoryRowSourceOptions } from "./memory-source";
export {
  buildD1ConversionReport,
  convertDatabase,
  convertTable,
  migratableTables,
  skipReason,
  summarizeDatabaseDataset,
} from "./pipeline";
export type { BuildD1ConversionReportOptions, ConvertDatabaseOptions } from "./pipeline";