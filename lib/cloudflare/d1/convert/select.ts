import type { D1TableDefinition } from "../types";
import type { CanonicalRelocationRecord, PostgresReadRequest } from "./types";

const POSTGRES_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/**
 * Postgres identifiers are quoted by construction: every name comes from the
 * hand-authored D1 schema, and this guard fails closed so a future schema edit
 * cannot smuggle an unsafe identifier into the generated SELECT. Values are
 * always bound parameters, never interpolated.
 */
export function assertPostgresIdentifier(identifier: string): string {
  if (!POSTGRES_IDENTIFIER.test(identifier)) throw new Error(`invalid postgres identifier: ${identifier}`);
  return identifier;
}

/** The Postgres relation a D1 table is copied from, or null when derived/virtual. */
export function postgresRelationFor(table: D1TableDefinition): string | null {
  if (table.virtual || table.sourceTable === null) return null;
  return table.sourceTable;
}

/** The D1 columns sourced from Postgres, in authored schema order. */
export function projectableColumns(table: D1TableDefinition): string[] {
  const columns: string[] = [];
  for (const column of table.columns) {
    if (column.source !== null) columns.push(column.source.column);
  }
  return columns;
}

/** The Postgres columns relocated out of the relational D1 schema. */
export function relocatedColumnsFor(table: D1TableDefinition): CanonicalRelocationRecord[] {
  return table.relocated.map((relocation) => ({ column: relocation.source.column, target: relocation.target }));
}

/**
 * Builds the bounded, deterministic Postgres projection for a D1 table:
 * authored column order, primary-key ordering, optional batch limit/offset.
 * Returns null for virtual/derived tables, which are not copied from Postgres.
 */
export function postgresReadRequest(
  table: D1TableDefinition,
  options: { limit?: number | null; offset?: number } = {},
): PostgresReadRequest | null {
  const relation = postgresRelationFor(table);
  if (relation === null) return null;
  const columns = projectableColumns(table);
  if (columns.length === 0) return null;
  return {
    relation: assertPostgresIdentifier(relation),
    columns: columns.map(assertPostgresIdentifier),
    orderBy: table.primaryKey.map(assertPostgresIdentifier),
    limit: options.limit ?? null,
    offset: options.offset ?? 0,
  };
}