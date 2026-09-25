import { columnCanonicalKind } from "./canonical-kind";
import { parseCanonicalJsonText } from "./canonical-values";
import type { D1RuntimeDatabase } from "./runtime-binding";
import type { D1ColumnDefinition, D1TableDefinition } from "./types";

/**
 * M6.1/M6.2 runtime-safe D1 read runner.
 *
 * This is the ONLY runtime surface allowed to touch D1: it executes a single
 * read-only `SELECT` through the Worker binding's
 * `prepare(sql).bind(...values).all()` and revives JSON/array canonical text so
 * the shared row mappers see the same value shape Supabase returns.
 *
 * M6.2 extends the request with an optional authored column projection,
 * `eq`/`gte` predicates and `asc`/`desc` (with optional null placement)
 * ordering. The safety properties are unchanged:
 *
 * - identifiers (table, columns, order by) are authored D1 schema names guarded
 *   by a strict regex; a name never reaches SQL unguarded;
 * - every value travels as a bound parameter; no value is ever interpolated;
 * - the response is validated fail-closed (a malformed envelope or a non-object
 *   row is an error, never a silently shorter result);
 * - this module imports no Node builtin and no remote-operator module, so it can
 *   run inside the Worker.
 */
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

export class D1RuntimeReadError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = "D1RuntimeReadError";
    this.code = code;
  }
}

/**
 * A guarded predicate. `eq` renders `column = ?` and `gte` renders
 * `column >= ?`; the column is always an authored D1 name and the value is
 * always bound, never interpolated.
 */
export type D1RuntimeReadOperator = "eq" | "gte";

export interface D1RuntimeReadPredicate {
  /** An authored D1 column name. */
  column: string;
  /** Comparison operator; defaults to `eq`. */
  op?: D1RuntimeReadOperator;
  /** A value bound as a `?` parameter, never interpolated. */
  value: unknown;
}

/**
 * A guarded ordering clause. The column is an authored D1 name; the direction
 * and null placement are literal enum values, never caller text.
 */
export interface D1RuntimeReadOrder {
  column: string;
  direction?: "asc" | "desc";
  nulls?: "first" | "last";
}

export interface D1RuntimeReadRequest {
  readonly binding: D1RuntimeDatabase;
  readonly table: D1TableDefinition;
  /** Authored columns to project; defaults to every authored column. */
  readonly select?: readonly string[];
  readonly where?: readonly D1RuntimeReadPredicate[];
  /** Authored order-by columns/orders; defaults to the table primary key. */
  readonly orderBy?: readonly (string | D1RuntimeReadOrder)[];
  /** Bounded row limit (the shadow `maxRows`). */
  readonly limit?: number | null;
  readonly offset?: number;
}

function assertIdentifier(name: string): string {
  if (!IDENTIFIER.test(name)) throw new D1RuntimeReadError("d1_runtime_read.invalid_identifier", `invalid D1 identifier: ${name}`);
  return name;
}

function authoredColumnNames(table: D1TableDefinition): Set<string> {
  return new Set(table.columns.map((column) => column.name));
}

/**
 * Resolves and validates a projection to authored D1 columns (in declaration
 * order, de-duplicated). An absent/empty projection means every authored
 * column. An unknown column fails closed rather than being interpolated.
 */
function resolveReadColumns(
  table: D1TableDefinition,
  select?: readonly string[],
): D1ColumnDefinition[] {
  if (!select || select.length === 0) return table.columns;
  const authored = authoredColumnNames(table);
  const seen = new Set<string>();
  const columns: D1ColumnDefinition[] = [];
  for (const name of select) {
    if (!authored.has(name)) {
      throw new D1RuntimeReadError("d1_runtime_read.unknown_column", `unknown select column: ${name}`);
    }
    if (seen.has(name)) continue;
    seen.add(name);
    const column = table.columns.find((entry) => entry.name === name);
    if (column) columns.push(column);
  }
  if (columns.length === 0) {
    throw new D1RuntimeReadError("d1_runtime_read.no_columns", `${table.name} has no readable columns`);
  }
  return columns;
}

function reviveRow(
  table: D1TableDefinition,
  columns: readonly D1ColumnDefinition[],
  row: Record<string, unknown>,
): Record<string, unknown> {
  const revived: Record<string, unknown> = {};
  for (const column of columns) {
    const value = row[column.name] ?? null;
    const kind = columnCanonicalKind(column);
    if ((kind === "json" || kind === "array") && typeof value === "string") {
      try {
        revived[column.name] = parseCanonicalJsonText(value);
      } catch {
        throw new D1RuntimeReadError(
          "d1_runtime_read.invalid_json",
          `${table.name}.${column.name} is not valid canonical JSON text`,
        );
      }
    } else {
      revived[column.name] = value;
    }
  }
  return revived;
}

/** Builds the guarded, parameterized SELECT (identifiers guarded, values bound). */
export function buildD1RuntimeReadStatement(request: D1RuntimeReadRequest): { sql: string; params: unknown[] } {
  const { table } = request;
  const relation = assertIdentifier(table.name);
  const columns = resolveReadColumns(table, request.select);
  const authored = authoredColumnNames(table);

  const predicates = request.where ?? [];
  const whereSql: string[] = [];
  const params: unknown[] = [];
  for (const predicate of predicates) {
    if (!authored.has(predicate.column)) {
      throw new D1RuntimeReadError("d1_runtime_read.unknown_column", `unknown predicate column: ${predicate.column}`);
    }
    const op = predicate.op ?? "eq";
    if (op === "eq") whereSql.push(`${assertIdentifier(predicate.column)} = ?`);
    else if (op === "gte") whereSql.push(`${assertIdentifier(predicate.column)} >= ?`);
    else throw new D1RuntimeReadError("d1_runtime_read.invalid_operator", `unsupported predicate operator: ${String(op)}`);
    params.push(predicate.value);
  }

  const orderBy = (request.orderBy ?? table.primaryKey).map((entry) => {
    const column = typeof entry === "string" ? entry : entry.column;
    if (!authored.has(column)) throw new D1RuntimeReadError("d1_runtime_read.unknown_column", `unknown order column: ${column}`);
    const name = assertIdentifier(column);
    if (typeof entry === "string") return name;
    const direction = entry.direction ?? "asc";
    if (direction !== "asc" && direction !== "desc") {
      throw new D1RuntimeReadError("d1_runtime_read.invalid_order", `unsupported order direction: ${String(direction)}`);
    }
    let clause = `${name} ${direction}`;
    if (entry.nulls === "first" || entry.nulls === "last") clause += ` nulls ${entry.nulls}`;
    return clause;
  });

  let sql = `select ${columns.map((column) => assertIdentifier(column.name)).join(", ")} from ${relation}`;
  if (whereSql.length > 0) sql += ` where ${whereSql.join(" and ")}`;
  if (orderBy.length > 0) sql += ` order by ${orderBy.join(", ")}`;

  const limit = request.limit ?? null;
  if (limit !== null) {
    if (!Number.isInteger(limit) || limit <= 0) throw new D1RuntimeReadError("d1_runtime_read.invalid_limit", "limit must be a positive integer");
    params.push(limit);
    sql += " limit ?";
  }
  const offset = request.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0) throw new D1RuntimeReadError("d1_runtime_read.invalid_offset", "offset must be a non-negative integer");
  if (offset > 0) {
    params.push(offset);
    sql += " offset ?";
  }
  return { sql, params };
}

/** Runs one bounded, read-only D1 query and returns revived rows. */
export async function runD1RuntimeRead(request: D1RuntimeReadRequest): Promise<Record<string, unknown>[]> {
  const columns = resolveReadColumns(request.table, request.select);
  const { sql, params } = buildD1RuntimeReadStatement(request);
  const statement = request.binding.prepare(sql).bind(...params);
  if (typeof statement?.all !== "function") {
    throw new D1RuntimeReadError("d1_runtime_read.unavailable", "D1 binding did not provide prepare().bind().all()");
  }
  const result = await statement.all<Record<string, unknown>>();

  if (result === null || typeof result !== "object") {
    throw new D1RuntimeReadError("d1_runtime_read.invalid_response", "D1 returned a non-object result");
  }
  if (result.success === false) {
    throw new D1RuntimeReadError("d1_runtime_read.query_failed", result.error || "D1 query failed");
  }
  const rows = result.results;
  if (!Array.isArray(rows)) {
    throw new D1RuntimeReadError("d1_runtime_read.invalid_response", "D1 result did not carry a row array");
  }
  const revived: Record<string, unknown>[] = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      throw new D1RuntimeReadError("d1_runtime_read.invalid_response", "D1 returned a non-object row");
    }
    revived.push(reviveRow(request.table, columns, row as Record<string, unknown>));
  }
  return revived;
}
