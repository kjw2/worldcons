import { mapPostgresType } from "./mapping";
import type { PostgresSchemaRegistry } from "./postgres/scan";
import type { D1OwnershipEntry, D1Schema, D1SchemaIssue, D1SchemaValidation, D1TableDefinition } from "./types";

const STORAGE_KINDS = new Set(["text", "integer", "real", "blob"]);

type Push = (code: string, message: string) => void;

function validateTable(table: D1TableDefinition, push: Push): void {
  const columnNames = new Set<string>();
  for (const column of table.columns) {
    if (columnNames.has(column.name)) push("duplicate-column", `${table.name}.${column.name} is duplicated`);
    columnNames.add(column.name);
    if (!STORAGE_KINDS.has(column.kind)) push("invalid-storage-kind", `${table.name}.${column.name} has unknown kind ${column.kind}`);
    if (column.enumValues && column.kind !== "text") {
      push("enum-non-text", `${table.name}.${column.name} has enum values but kind ${column.kind}`);
    }
  }
  for (const relocation of table.relocated) {
    if (columnNames.has(relocation.source.column)) {
      push("relocated-column-collision", `${table.name}.${relocation.source.column} is both a D1 column and relocated`);
    }
  }
  if (table.virtual) {
    if (table.columns.length > 0 || table.primaryKey.length > 0 || table.indexes.length > 0) {
      push("virtual-table-constraints", `${table.name} virtual table must not declare columns/pk/indexes`);
    }
    return;
  }
  if (table.columns.length === 0) push("empty-table", `${table.name} has no columns`);
  if (table.primaryKey.length === 0) push("missing-primary-key", `${table.name} has no primary key`);
  for (const key of table.primaryKey) {
    if (!columnNames.has(key)) push("unknown-primary-key-column", `${table.name} primary key references unknown column ${key}`);
  }
  const indexNames = new Set<string>();
  for (const index of table.indexes) {
    if (indexNames.has(index.name)) push("duplicate-index", `${table.name} index ${index.name} is duplicated`);
    indexNames.add(index.name);
    for (const column of index.columns) {
      if (!columnNames.has(column)) push("unknown-index-column", `${table.name} index ${index.name} references unknown column ${column}`);
    }
  }
}
function validateAgainstPostgres(table: D1TableDefinition, registry: PostgresSchemaRegistry, push: Push, warn: Push): void {
  if (table.virtual || table.sourceTable === null) return;
  const pgTable = registry.tables[table.sourceTable];
  if (!pgTable) {
    push("source-table-not-found", `${table.name} source table ${table.sourceTable} is not a scanned Postgres table`);
    return;
  }
  const accounted = new Map<string, "column" | "relocated">();
  for (const column of table.columns) {
    if (column.source) accounted.set(column.source.column, "column");
  }
  for (const relocation of table.relocated) {
    if (accounted.has(relocation.source.column)) {
      push("duplicate-source-column", `${table.name}.${relocation.source.column} is mapped twice`);
      continue;
    }
    accounted.set(relocation.source.column, "relocated");
  }
  for (const pgColumn of pgTable.columns) {
    const kind = accounted.get(pgColumn.name);
    if (!kind) {
      push("uncovered-postgres-column", `${table.name} does not model Postgres column ${pgColumn.name} (${pgColumn.type})`);
      continue;
    }
    const expected = mapPostgresType(pgColumn.type);
    if (!expected) {
      push("unmapped-postgres-column", `${table.name}.${pgColumn.name} has unmapped Postgres type ${pgColumn.type}`);
      continue;
    }
    if ("relocated" in expected) {
      if (kind === "column") {
        push("relocation-expected", `${table.name}.${pgColumn.name} must be relocated to ${expected.relocated}`);
      } else {
        const relocation = table.relocated.find((entry) => entry.source.column === pgColumn.name);
        if (relocation && relocation.target !== expected.relocated) {
          push("relocation-target-mismatch", `${table.name}.${pgColumn.name}: target ${relocation.target} != ${expected.relocated}`);
        }
      }
      continue;
    }
    if (kind === "relocated") {
      const relocation = table.relocated.find((entry) => entry.source.column === pgColumn.name);
      if (!relocation || relocation.target !== "r2") {
        push("column-expected", `${table.name}.${pgColumn.name} must be a stored D1 column`);
      }
      continue;
    }
    const column = table.columns.find((entry) => entry.source?.column === pgColumn.name);
    if (column && column.kind !== expected.kind) {
      push("storage-kind-mismatch", `${table.name}.${pgColumn.name}: kind ${column.kind} != ${expected.kind}`);
    }
  }
  for (const column of table.columns) {
    const pgCheck = pgTable.enumChecks[column.source?.column ?? column.name];
    if (pgCheck && !column.enumValues) {
      warn("unmodeled-enum-check", `${table.name}.${column.name} has a Postgres check list the D1 model does not declare`);
    }
    if (pgCheck && column.enumValues && pgCheck.join("|") !== column.enumValues.join("|")) {
      push("enum-check-drift", `${table.name}.${column.name}: enum values differ from the Postgres check`);
    }
  }
}
/**
 * Validates the canonical D1 schema:
 *
 * 1. internal consistency (unique names, valid kinds, primary keys, indexes);
 * 2. ownership coverage (every scanned Postgres table is owned exactly once,
 *    every `covered` entry has a D1 table, every `planned` entry still exists in
 *    Postgres and has no D1 table yet);
 * 3. full column parity for covered tables against the scanned Postgres DDL,
 *    including the plan 6.1 storage-kind/relocation mapping and enum checks.
 */
export function validateD1Schema(schema: D1Schema, registry: PostgresSchemaRegistry): D1SchemaValidation {
  const errors: D1SchemaIssue[] = [];
  const warnings: D1SchemaIssue[] = [];
  const push: Push = (code, message) => errors.push({ code, message });
  const warn: Push = (code, message) => warnings.push({ code, message });

  const tableNames = new Set<string>();
  for (const table of schema.tables) {
    if (tableNames.has(table.name)) push("duplicate-table", `duplicate D1 table ${table.name}`);
    tableNames.add(table.name);
    validateTable(table, push);
  }

  const ownershipByTable = new Map<string, D1OwnershipEntry>();
  for (const entry of schema.ownership) {
    if (ownershipByTable.has(entry.table)) push("duplicate-ownership", `duplicate ownership entry for ${entry.table}`);
    ownershipByTable.set(entry.table, entry);
  }  for (const table of schema.tables) {
    const entry = ownershipByTable.get(table.name);
    if (!entry) {
      push("d1-table-without-ownership", `D1 table ${table.name} has no ownership entry`);
      continue;
    }
    if (entry.status !== "covered") push("covered-table-marked-planned", `D1 table ${table.name} must be a covered ownership entry`);
    if (entry.database !== table.database) {
      push("ownership-database-mismatch", `${table.name}: ownership ${entry.database} != table ${table.database}`);
    }
  }
  for (const entry of schema.ownership) {
    if (entry.status === "planned") {
      if (tableNames.has(entry.table)) push("planned-table-has-d1-table", `planned table ${entry.table} must not have a D1 table in M5.1`);
      if (!registry.tables[entry.table]) push("planned-table-not-found", `planned table ${entry.table} is not a scanned Postgres table`);
    } else if (!schema.tables.some((table) => table.name === entry.table)) {
      push("covered-without-d1-table", `covered entry ${entry.table} has no D1 table`);
    }
  }
  for (const name of Object.keys(registry.tables)) {
    if (!ownershipByTable.has(name)) push("unowned-postgres-table", `Postgres table ${name} has no D1 ownership entry`);
  }
  for (const table of schema.tables) validateAgainstPostgres(table, registry, push, warn);
  const coveredTableCount = schema.ownership.filter((entry) => entry.status === "covered").length;
  const plannedTableCount = schema.ownership.filter((entry) => entry.status === "planned").length;
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    tableCount: schema.tables.length,
    coveredTableCount,
    plannedTableCount,
  };
}