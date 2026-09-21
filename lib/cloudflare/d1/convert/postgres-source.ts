import { Client } from "pg";
import { assertPostgresIdentifier } from "./select";
import type { PostgresReadRequest, PostgresRowSource } from "./types";

/**
 * Read-only Postgres export source (operator use only).
 *
 * Deliberately not re-exported from the convert barrel: runtime Workers code
 * must never load `pg`. The operator CLI imports this module directly.
 *
 * Safety: the session is switched to read-only, every identifier is validated
 * against the hand-authored schema, and every value is a bound parameter. No
 * DDL/DML is ever issued and no D1/R2 write happens here.
 */
export interface PostgresRowSourceOptions {
  connectionString: string;
  statementTimeoutMs?: number;
}

export function createPostgresRowSource(options: PostgresRowSourceOptions): PostgresRowSource {
  if (!options.connectionString.trim()) throw new Error("postgres row source requires a connection string");
  const client = new Client({ connectionString: options.connectionString });
  const statementTimeoutMs = options.statementTimeoutMs ?? 60_000;
  let connected = false;

  async function ensureConnected(): Promise<void> {
    if (connected) return;
    await client.connect();
    await client.query("set default_transaction_read_only = on");
    await client.query("select set_config('statement_timeout', $1, false)", [String(statementTimeoutMs)]);
    connected = true;
  }
  return {
    isConfigured: () => true,
    async readRows(request: PostgresReadRequest) {
      await ensureConnected();
      const relation = assertPostgresIdentifier(request.relation);
      const columns = request.columns.map(assertPostgresIdentifier);
      if (columns.length === 0) throw new Error(`no projectable columns for ${relation}`);
      const orderBy = request.orderBy.map(assertPostgresIdentifier);
      const parameters: unknown[] = [];
      let sql = `select ${columns.join(", ")} from ${relation}`;
      if (orderBy.length > 0) sql += ` order by ${orderBy.join(", ")}`;
      if (request.limit !== null) {
        parameters.push(request.limit);
        sql += ` limit $${parameters.length}`;
      }
      if (request.offset > 0) {
        parameters.push(request.offset);
        sql += ` offset $${parameters.length}`;
      }
      const result = await client.query(sql, parameters);
      return result.rows as Record<string, unknown>[];
    },
    async close() {
      if (!connected) return;
      connected = false;
      await client.end();
    },
  };
}