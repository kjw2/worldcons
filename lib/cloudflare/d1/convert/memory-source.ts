import type { PostgresReadRequest, PostgresRowSource } from "./types";

export interface MemoryRowSourceOptions {
  /** Whether the source reports itself as configured. Defaults to true. */
  configured?: boolean;
  /** Rows per relation; a missing relation reads as an empty table. */
  rows?: Record<string, Record<string, unknown>[]>;
}

function pickColumns(row: Record<string, unknown>, columns: readonly string[]): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const column of columns) {
    if (Object.prototype.hasOwnProperty.call(row, column)) picked[column] = row[column];
  }
  return picked;
}

/**
 * In-memory export source for local runs and tests. It mirrors the bounded,
 * column-projected reads of the Postgres source without any database.
 */
export function createMemoryRowSource(options: MemoryRowSourceOptions = {}): PostgresRowSource {
  const rows = options.rows ?? {};
  let closed = false;
  return {
    isConfigured: () => options.configured ?? true,
    async readRows(request: PostgresReadRequest) {
      if (closed) throw new Error("memory row source is closed");
      const source = rows[request.relation] ?? [];
      const start = request.offset;
      const slice = request.limit === null ? source.slice(start) : source.slice(start, start + request.limit);
      return slice.map((row) => pickColumns(row, request.columns));
    },
    async close() {
      closed = true;
    },
  };
}