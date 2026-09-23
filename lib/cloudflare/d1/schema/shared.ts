import { mapPostgresType } from "../mapping";
import type {
  D1ColumnDefinition,
  D1Database,
  D1IndexDefinition,
  D1RelocatedColumn,
  D1RelocatedTarget,
  D1TableDefinition,
  D1VirtualTableDefinition,
  PostgresColumnRef,
} from "../types";

/** One D1 column/relocation, authored against its Postgres origin. */
export interface ColumnSpec {
  name: string;
  /** Normalized Postgres type (see `postgres/scan.ts`). */
  type: string;
  nn?: boolean;
  /** Retained SQL default expression (D1 only). Omitted when app-generated. */
  def?: string;
  /** Enum-like CHECK values (plan 6.1: enums -> TEXT + CHECK). */
  enum?: readonly string[];
  note?: string;
  /** Explicit relocation target, overriding the Postgres type mapping. */
  relocate?: D1RelocatedTarget;
  /** Derived projection column with no single Postgres source table. */
  derived?: boolean;
}

export interface TableSpec {
  name: string;
  database: D1Database;
  columns: ColumnSpec[];
  primaryKey: string[];
  indexes?: D1IndexDefinition[];
  /** Postgres source table when it differs from the D1 table name. */
  sourceTable?: string;
  virtual?: D1VirtualTableDefinition;
  note?: string;
}
export function uniqueIndex(name: string, columns: string[]): D1IndexDefinition {
  return { name, columns, unique: true, note: null };
}

export function index(name: string, columns: string[]): D1IndexDefinition {
  return { name, columns, unique: false, note: null };
}

/**
 * Builds a D1 table from its authored column specs. The storage kind, enum
 * requirement and FTS5/Vectorize relocation are derived from the Postgres type
 * through the plan 6.1 mapping, so the schema cannot drift from the mapping.
 */
export function buildTable(spec: TableSpec): D1TableDefinition {
  const columns: D1ColumnDefinition[] = [];
  const relocated: D1RelocatedColumn[] = [];
  const derivedProjection = spec.columns.length > 0 && spec.columns.every((column) => column.derived);
  const sourceTable = spec.sourceTable ?? spec.name;
  for (const column of spec.columns) {
    const source: PostgresColumnRef = { table: sourceTable, column: column.name, postgresType: column.type };
    if (column.relocate) {
      relocated.push({ source, target: column.relocate, note: column.note ?? "" });
      continue;
    }
    const mapping = mapPostgresType(column.type);
    if (!mapping) throw new Error(`${spec.name}.${column.name}: unmapped Postgres type ${column.type}`);
    if ("relocated" in mapping) {
      relocated.push({ source, target: mapping.relocated, note: column.note ?? mapping.note });
      continue;
    }
    columns.push({
      name: column.name,
      kind: mapping.kind,
      notNull: column.nn ?? false,
      defaultSql: column.def ?? null,
      enumValues: column.enum ? [...column.enum] : null,
      source: column.derived ? null : source,
      note: column.note ?? null,
    });
  }
  return {
    name: spec.name,
    database: spec.database,
    columns,
    primaryKey: spec.primaryKey,
    indexes: spec.indexes ?? [],
    relocated,
    sourceTable: spec.virtual ? null : spec.sourceTable ?? (derivedProjection ? null : spec.name),
    virtual: spec.virtual ?? null,
    note: spec.note ?? null,
  };
}