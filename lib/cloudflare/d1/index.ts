import { d1Schema } from "./schema";
import { scanPostgresSchema, type PostgresSchemaRegistry } from "./postgres/scan";
import { validateD1Schema } from "./validate";
import { CANONICAL_FOUNDATION_VERSION } from "./canonical-values";
import { CANONICAL_ROW_HASH_VERSION } from "./canonical-row";
import { POSTGRES_TYPE_MAPPING_RULES } from "./mapping";
import type { D1Database, D1Schema, D1SchemaValidation } from "./types";

export * from "./types";
export {
  d1Schema,
  coreTables,
  ingestTables,
  opsTables,
  searchTables,
  ownership,
  buildTable,
  index,
  uniqueIndex,
} from "./schema";
export type { ColumnSpec, TableSpec } from "./schema";
export {
  canonicalizeUuid,
  canonicalizeTimestamp,
  canonicalizeBoolean,
  canonicalizeInteger,
  canonicalizeBigIntText,
  canonicalizeReal,
  canonicalizeJsonText,
  parseCanonicalJsonText,
  canonicalizeArrayText,
  canonicalizeEnum,
  canonicalizeText,
  CANONICAL_FOUNDATION_VERSION,
} from "./canonical-values";
export {
  canonicalizeColumnValue,
  canonicalizeRow,
  hashCanonicalRow,
  hashCanonicalTable,
  compareCanonicalScalar,
  columnCanonicalKind,
  CANONICAL_ROW_HASH_VERSION,
} from "./canonical-row";
export type { CanonicalRow, CanonicalScalar, CanonicalTableHash } from "./canonical-row";
export {
  mapPostgresType,
  normalizePostgresType,
  postgresTypeCanonicalKind,
  POSTGRES_TYPE_MAPPING_RULES,
  D1_CANONICAL_KINDS,
} from "./mapping";
export type { D1TypeMapping, D1StorageMapping, D1RelocatedMapping, D1CanonicalKind } from "./mapping";
export { emitDatabaseDdl, emitTableDdl, emitAllDatabaseDdl } from "./ddl";
export { validateD1Schema } from "./validate";
export { scanPostgresSchema, normalizeScannedType, DEFAULT_MIGRATIONS_DIR } from "./postgres/scan";
export type {
  PostgresSchemaRegistry,
  PostgresTableDefinition,
  PostgresColumnDefinition,
  PostgresIndexDefinition,
  ScanPostgresSchemaOptions,
} from "./postgres/scan";
export interface D1SchemaReportTable {
  name: string;
  database: D1Database;
  columns: number;
  primaryKey: string[];
  indexes: number;
  relocated: string[];
}

export interface D1SchemaReport {
  version: 1;
  foundationVersion: number;
  rowHashVersion: number;
  generatedFrom: { migrations: number; statements: number; postgresTables: number };
  summary: {
    databases: D1Database[];
    tables: number;
    coveredTables: number;
    plannedTables: number;
    postgresTables: number;
  };
  mappingRules: readonly { pattern: string; target: string; note: string }[];
  tables: D1SchemaReportTable[];
  validation: D1SchemaValidation;
}

/** Builds the machine-readable M5.1 D1 schema report from the live source tree. */
export function buildD1SchemaReport(rootDir: string, schema: D1Schema = d1Schema): D1SchemaReport {
  const registry: PostgresSchemaRegistry = scanPostgresSchema({ rootDir });
  const validation = validateD1Schema(schema, registry);
  const tables: D1SchemaReportTable[] = schema.tables
    .slice()
    .sort((left, right) => left.database.localeCompare(right.database) || left.name.localeCompare(right.name))
    .map((table) => ({
      name: table.name,
      database: table.database,
      columns: table.columns.length,
      primaryKey: [...table.primaryKey],
      indexes: table.indexes.length,
      relocated: table.relocated.map((entry) => `${entry.source.column}->${entry.target}`),
    }));
  return {
    version: 1,
    foundationVersion: CANONICAL_FOUNDATION_VERSION,
    rowHashVersion: CANONICAL_ROW_HASH_VERSION,
    generatedFrom: {
      migrations: registry.filesScanned,
      statements: registry.statementsScanned,
      postgresTables: Object.keys(registry.tables).length,
    },
    summary: {
      databases: [...schema.databases],
      tables: schema.tables.length,
      coveredTables: validation.coveredTableCount,
      plannedTables: validation.plannedTableCount,
      postgresTables: Object.keys(registry.tables).length,
    },
    mappingRules: POSTGRES_TYPE_MAPPING_RULES,
    tables,
    validation,
  };
}