import type { CanonicalScalar } from "../canonical-row";
import type { CanonicalConversionSkipped } from "../convert/types";
import type { D1Database } from "../types";

/**
 * M5.2b D1 import contract.
 *
 * M5.2 is "Postgres export -> canonical transform -> D1 import". M5.2a delivered
 * the first two stages; this slice delivers the third:
 *
 * - `D1ImportStatement` is the emitted, parameterized insert. Every value is a
 *   bound parameter, never interpolated, so an authored identifier is the only
 *   text in the SQL.
 * - `D1ImportTarget` is the write boundary. Local runs and tests apply to an
 *   in-memory `node:sqlite` database; a later slice can point the same contract
 *   at a remote D1 binding.
 * - Verification reads the rows back from the target and re-derives the M5.1
 *   per-table/database hashes, so a successful import is proven equal to the
 *   canonical transform, not assumed.
 *
 * M5.2b is local-only: it never creates a remote database, deploys, or changes
 * production authority.
 */
export const D1_IMPORT_VERSION = 1 as const;

/** A SQLite/D1 bound value. Blobs are byte arrays, never base64 text. */
export type D1ImportParam = CanonicalScalar | Uint8Array;

/** One parameterized D1 statement: `?` placeholders plus their bound values. */
export interface D1ImportStatement {
  sql: string;
  params: D1ImportParam[];
}

/** A table's emitted import statements plus its rendered literal SQL. */
export interface D1TableImport {
  version: typeof D1_IMPORT_VERSION;
  table: string;
  database: D1Database;
  sourceTable: string;
  primaryKey: string[];
  columns: string[];
  rowCount: number;
  statementCount: number;
  paramCount: number;
  statements: D1ImportStatement[];
  /** Literal SQL for the same statements (`wrangler d1 execute --file`). */
  sql: string;
}

/** Every migratable table of one D1 database, emitted for import. */
export interface D1DatabaseImport {
  version: typeof D1_IMPORT_VERSION;
  database: D1Database;
  tableCount: number;
  rowCount: number;
  tables: D1TableImport[];
}

/**
 * The D1 write boundary. `exec` runs DDL/multi-statement text; `run` executes a
 * single parameterized statement; `all` reads rows back for verification.
 */
export interface D1ImportTarget {
  exec(sql: string): void;
  run(sql: string, params: readonly D1ImportParam[]): void;
  all(sql: string, params: readonly D1ImportParam[]): Record<string, unknown>[];
  /** Releases the underlying handle when the target owns one. */
  close?(): void;
}

/** One table's import round-trip verification result. */
export interface D1TableVerification {
  table: string;
  database: D1Database;
  sourceTable: string;
  /** Rows read back from the target. */
  rowCount: number;
  /** Rows the canonical transform expected. */
  expectedRowCount: number;
  /** Canonical hash recomputed from the target rows. */
  hash: string;
  /** Canonical hash the transform produced. */
  expectedHash: string;
  ok: boolean;
  errors: string[];
}

/** One database's import round-trip verification result. */
export interface D1DatabaseVerification {
  database: D1Database;
  ok: boolean;
  tableCount: number;
  rowCount: number;
  expectedRowCount: number;
  hash: string;
  expectedHash: string;
  tables: D1TableVerification[];
}

/** A row-free table entry in the machine-readable import report. */
export interface D1ImportReportTable {
  table: string;
  database: D1Database;
  sourceTable: string;
  rowCount: number;
  expectedRowCount: number;
  hash: string;
  expectedHash: string;
  statementCount: number;
  ok: boolean;
  errors: string[];
}

/** A database entry in the machine-readable import report. */
export interface D1ImportReportDatabase {
  database: D1Database;
  tableCount: number;
  rowCount: number;
  expectedRowCount: number;
  hash: string;
  expectedHash: string;
  ok: boolean;
  tables: D1ImportReportTable[];
  /** Literal import SQL, only when the report was built with `includeScripts`. */
  script: string | null;
}

export interface D1ImportReportTotals {
  databases: number;
  tables: number;
  rows: number;
  statements: number;
  verified: boolean;
}

export interface D1ImportReport {
  version: typeof D1_IMPORT_VERSION;
  stage: "d1-import";
  datasetVersion: number;
  foundationVersion: number;
  rowHashVersion: number;
  databaseHashVersion: number;
  target: { kind: string; persistent: boolean };
  source: { kind: string; configured: boolean };
  databases: D1ImportReportDatabase[];
  skipped: CanonicalConversionSkipped[];
  totals: D1ImportReportTotals;
}
