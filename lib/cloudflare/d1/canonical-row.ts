import crypto from "node:crypto";
import { canonicalJson } from "@/lib/backfill/canonical-json";
import {
  canonicalizeArrayText,
  canonicalizeBigIntText,
  canonicalizeBoolean,
  canonicalizeEnum,
  canonicalizeInteger,
  canonicalizeJsonText,
  canonicalizeReal,
  canonicalizeText,
  canonicalizeTimestamp,
  canonicalizeUuid,
} from "./canonical-values";
import { postgresTypeCanonicalKind, type D1CanonicalKind } from "./mapping";
import type { D1ColumnDefinition, D1TableDefinition, D1StorageKind } from "./types";

/**
 * Canonical row/table foundation (M5 acceptance: "canonical per-table hashes").
 *
 * A D1 row is reduced to a canonical scalar map, serialized with the shared
 * canonical JSON (sorted keys), and hashed with SHA-256. Table order is
 * normalized by primary key, so the table hash depends only on the row set, not
 * on row or column order.
 */
export const CANONICAL_ROW_HASH_VERSION = 1;

export type CanonicalScalar = string | number | null;
export type CanonicalRow = Record<string, CanonicalScalar>;

export function canonicalizeBlob(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  throw new Error("blob column requires a base64 string or Uint8Array value");
}
function storageFallbackKind(kind: D1StorageKind): D1CanonicalKind {
  if (kind === "integer") return "integer";
  if (kind === "real") return "real";
  if (kind === "blob") return "blob";
  return "text";
}

export function columnCanonicalKind(column: D1ColumnDefinition): D1CanonicalKind {
  if (column.enumValues && column.enumValues.length > 0) return "text";
  if (column.source) {
    const kind = postgresTypeCanonicalKind(column.source.postgresType);
    if (kind && kind !== "fts5" && kind !== "vectorize") return kind;
  }
  return storageFallbackKind(column.kind);
}

export function canonicalizeColumnValue(column: D1ColumnDefinition, value: unknown): CanonicalScalar {
  if (value === null || value === undefined) {
    if (column.notNull) throw new Error(`column ${column.name} is NOT NULL`);
    return null;
  }
  switch (columnCanonicalKind(column)) {
    case "uuid":
      return canonicalizeUuid(value);
    case "timestamp":
      return canonicalizeTimestamp(value);
    case "json":
      return canonicalizeJsonText(value);
    case "array":
      return canonicalizeArrayText(value);
    case "bigint":
      return canonicalizeBigIntText(value);
    case "boolean":
      return canonicalizeBoolean(value);
    case "integer":
      return canonicalizeInteger(value);
    case "real":
      return canonicalizeReal(value);
    case "blob":
      return canonicalizeBlob(value);
    default:
      return column.enumValues ? canonicalizeEnum(value, column.enumValues) : canonicalizeText(value);
  }
}
/** Normalizes every declared column of a table to its canonical scalar. */
export function canonicalizeRow(table: D1TableDefinition, row: Record<string, unknown>): CanonicalRow {
  const normalized: CanonicalRow = {};
  for (const column of table.columns) {
    normalized[column.name] = canonicalizeColumnValue(column, row[column.name]);
  }
  return normalized;
}

/** Type-stable scalar ordering used to normalize row order by primary key. */
export function compareCanonicalScalar(left: CanonicalScalar, right: CanonicalScalar): number {
  if (left === right) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left) < String(right) ? -1 : 1;
}

function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

export function hashCanonicalRow(table: D1TableDefinition, row: Record<string, unknown>): string {
  const normalized = canonicalizeRow(table, row);
  const payload = `d1-row/v${CANONICAL_ROW_HASH_VERSION}\n${table.name}\n${canonicalJson(normalized)}`;
  return sha256Hex(payload);
}
export interface CanonicalTableHash {
  table: string;
  version: 1;
  rowCount: number;
  hash: string;
}

/**
 * Deterministic hash over a whole table: rows are normalized by primary key so
 * the result is independent of input row order. This is the M5 per-table parity
 * primitive (`hashCanonicalTable` on Postgres rows must equal the D1 side).
 */
export function hashCanonicalTable(
  table: D1TableDefinition,
  rows: readonly Record<string, unknown>[],
): CanonicalTableHash {
  const keyColumns = table.primaryKey.length > 0 ? table.primaryKey : table.columns.map((column) => column.name);
  const sorted = [...rows].sort((left, right) => {
    for (const key of keyColumns) {
      const column = table.columns.find((entry) => entry.name === key);
      const comparison = compareCanonicalScalar(
        column ? canonicalizeColumnValue(column, left[key]) : null,
        column ? canonicalizeColumnValue(column, right[key]) : null,
      );
      if (comparison !== 0) return comparison;
    }
    return 0;
  });
  const rowHashes = sorted.map((row) => hashCanonicalRow(table, row));
  const payload = `d1-table/v${CANONICAL_ROW_HASH_VERSION}\n${table.name}\n${sorted.length}\n${rowHashes.join("\n")}`;
  return { table: table.name, version: 1, rowCount: sorted.length, hash: sha256Hex(payload) };
}