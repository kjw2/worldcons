/**
 * M5.1 canonical D1 schema foundation types.
 *
 * These types are the platform-neutral contract for the four Cloudflare D1
 * databases described in the full-migration plan (section 5) plus their
 * Postgres -> D1 type mapping (section 6.1). They are intentionally free of
 * Supabase/Postgres client types so the D1 converter (M5.2+) and the D1
 * repository adapters can consume them directly.
 *
 * M5.1 is local-only: nothing here creates, deploys or mutates a database.
 */

/** The four D1 databases from plan section 5, using their exact names. */
export const D1_DATABASES = [
  "worldcons_core",
  "worldcons_ingest",
  "worldcons_ops",
  "worldcons_search",
] as const;
export type D1Database = (typeof D1_DATABASES)[number];

/**
 * SQLite storage class a Postgres type maps to (plan section 6.1). JSON, enum,
 * UUID and timestamp text all map to `text`; booleans map to `integer` 0/1.
 */
export const D1_STORAGE_KINDS = ["text", "integer", "real", "blob"] as const;
export type D1StorageKind = (typeof D1_STORAGE_KINDS)[number];

/**
 * Postgres constructs deliberately relocated out of the relational D1 schema:
 * `tsvector` becomes an FTS5 projection (plan 6.1/11.1) and `vector(1536)`
 * becomes a Vectorize index (plan 6.1/11.2).
 */
export const D1_RELOCATED_TARGETS = ["fts5", "vectorize"] as const;
export type D1RelocatedTarget = (typeof D1_RELOCATED_TARGETS)[number];

/** Whether a table is fully modeled in M5.1 or explicitly deferred to a later slice. */
export const D1_OWNERSHIP_STATUSES = ["covered", "planned"] as const;
export type D1OwnershipStatus = (typeof D1_OWNERSHIP_STATUSES)[number];/** A Postgres column that a D1 column (or relocation) derives from. */
export interface PostgresColumnRef {
  table: string;
  column: string;
  postgresType: string;
}

export interface D1ColumnDefinition {
  name: string;
  kind: D1StorageKind;
  notNull: boolean;
  /** Retained SQL default expression, or null when the value is application-generated. */
  defaultSql: string | null;
  /** Canonical CHECK values for an enum-like Postgres column, or null when unconstrained. */
  enumValues: string[] | null;
  /** Postgres origin, or null for a derived projection column with no Postgres source. */
  source: PostgresColumnRef | null;
  note: string | null;
}

/** A Postgres column intentionally stored outside D1 (FTS5 / Vectorize). */
export interface D1RelocatedColumn {
  source: PostgresColumnRef;
  target: D1RelocatedTarget;
  note: string;
}

export interface D1IndexDefinition {
  name: string;
  columns: string[];
  unique: boolean;
  note: string | null;
}

export interface D1VirtualTableDefinition {
  module: "fts5";
  columns: string[];
}
export interface D1TableDefinition {
  name: string;
  database: D1Database;
  columns: D1ColumnDefinition[];
  primaryKey: string[];
  indexes: D1IndexDefinition[];
  relocated: D1RelocatedColumn[];
  /** Postgres source table, or null for a derived projection table. */
  sourceTable: string | null;
  virtual: D1VirtualTableDefinition | null;
  note: string | null;
}

/** Plan section 5 ownership: which D1 database owns a Postgres table, and its M5.1 status. */
export interface D1OwnershipEntry {
  table: string;
  database: D1Database;
  status: D1OwnershipStatus;
  note: string;
}

export interface D1Schema {
  version: 1;
  databases: D1Database[];
  tables: D1TableDefinition[];
  ownership: D1OwnershipEntry[];
}

export interface D1SchemaIssue {
  code: string;
  message: string;
}

export interface D1SchemaValidation {
  ok: boolean;
  errors: D1SchemaIssue[];
  warnings: D1SchemaIssue[];
  tableCount: number;
  coveredTableCount: number;
  plannedTableCount: number;
}