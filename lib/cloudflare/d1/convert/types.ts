import type { CanonicalRow } from "../canonical-row";
import type { D1Database, D1RelocatedTarget } from "../types";

/**
 * M5.2a canonical transform contract.
 *
 * The M5.2 converter is "Postgres export -> canonical transform -> D1 import".
 * This slice implements the first two stages only, as a platform-neutral seam:
 *
 * - `PostgresRowSource` is the export boundary. The operator adapter reads the
 *   live Postgres/Supabase database read-only; tests use an in-memory source.
 * - `CanonicalTableDataset` / `CanonicalDatabaseDataset` are the transform
 *   result: canonical scalar rows (the plan 6.1 mapping) plus the per-table and
 *   per-database hashes the M5 acceptance check compares.
 *
 * M5.2a is local-only: it never writes to D1, creates a remote database,
 * deploys, or changes production authority. The D1 import emitter and the
 * Postgres -> D1 data copy are deferred to M5.2b+.
 */
export const CANONICAL_DATASET_VERSION = 1 as const;
/** A bounded batch read from the Postgres source. */
export interface PostgresReadRequest {
  /** Postgres relation (the D1 table name for every migrated table). */
  relation: string;
  /** Source columns to project, in authored D1 column order (relocations excluded). */
  columns: string[];
  /** Deterministic read order (the primary key columns). */
  orderBy: string[];
  /** Bounded batch size, or null to read the whole table. */
  limit: number | null;
  offset: number;
}

/**
 * The export boundary. A disabled source fails closed rather than reading
 * anything, so a missing connection string can never silently produce an
 * empty-but-plausible dataset.
 */
export interface PostgresRowSource {
  isConfigured(): boolean;
  readRows(request: PostgresReadRequest): Promise<Record<string, unknown>[]>;
  close(): Promise<void>;
}

/** A Postgres column relocated out of the relational D1 schema. */
export interface CanonicalRelocationRecord {
  column: string;
  target: D1RelocatedTarget;
}

/** One migrated table's canonical rows plus its per-table hash. */
export interface CanonicalTableDataset {
  version: typeof CANONICAL_DATASET_VERSION;
  table: string;
  database: D1Database;
  sourceTable: string;
  primaryKey: string[];
  /** D1 columns present in the dataset, in schema order. */
  columns: string[];
  /** Postgres columns relocated to FTS5 / Vectorize. */
  relocated: CanonicalRelocationRecord[];
  rowCount: number;
  /** Canonical per-table hash (M5 acceptance primitive). */
  hash: string;
  /** Canonical rows, normalized by primary key. */
  rows: CanonicalRow[];
}
/** The row-free table view used in the machine-readable report. */
export interface CanonicalTableSummary {
  version: typeof CANONICAL_DATASET_VERSION;
  table: string;
  database: D1Database;
  sourceTable: string;
  primaryKey: string[];
  columns: string[];
  relocated: CanonicalRelocationRecord[];
  rowCount: number;
  hash: string;
}

/** One database's canonical datasets (with rows). */
export interface CanonicalDatabaseDataset {
  version: typeof CANONICAL_DATASET_VERSION;
  database: D1Database;
  tableCount: number;
  rowCount: number;
  hash: string;
  tables: CanonicalTableDataset[];
}

/** The row-free database view used in the machine-readable report. */
export interface CanonicalDatabaseSummary {
  version: typeof CANONICAL_DATASET_VERSION;
  database: D1Database;
  tableCount: number;
  rowCount: number;
  hash: string;
  tables: CanonicalTableSummary[];
}

/** A D1 table the converter intentionally does not copy from Postgres. */
export interface CanonicalConversionSkipped {
  table: string;
  database: D1Database;
  reason: "virtual" | "derived";
}

export interface CanonicalConversionReport {
  version: typeof CANONICAL_DATASET_VERSION;
  stage: "canonical-transform";
  foundationVersion: number;
  rowHashVersion: number;
  databaseHashVersion: number;
  source: { kind: string; configured: boolean };
  databases: CanonicalDatabaseSummary[];
  skipped: CanonicalConversionSkipped[];
  totals: { databases: number; tables: number; rows: number };
}