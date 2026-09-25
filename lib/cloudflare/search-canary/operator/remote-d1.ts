import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { D1RuntimeDatabase, D1RuntimePreparedStatement, D1RuntimeResult } from "@/lib/cloudflare/d1/runtime-binding";
import type { RankedSearchParam } from "@/lib/cloudflare/search-ranked";
import { literalizeStatement } from "./literalize";

/**
 * Operator-only Wrangler-backed remote D1 client for the M7.5 canary.
 *
 * It never builds SQL from untrusted identifiers: callers pass authored SQL with
 * `?` placeholders and bound values, and `literalizeStatement` inlines the values
 * safely. It is deliberately NOT re-exported from the runtime-neutral barrel and
 * imports `node:*`, so runtime Worker code can never load it.
 */
export interface WranglerRunner {
  (args: string[]): Promise<string>;
}

export interface RemoteD1Envelope {
  rows: Record<string, unknown>[];
  rowsRead: number;
  changes: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parses `wrangler d1 execute --json` stdout, retaining `meta.rows_read`. */
export function parseRemoteD1Envelope(stdout: string): RemoteD1Envelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("wrangler d1 execute --json did not return JSON");
  }
  if (!Array.isArray(parsed)) throw new Error("wrangler d1 execute --json did not return a JSON array");
  const rows: Record<string, unknown>[] = [];
  let rowsRead = 0;
  let changes = 0;
  for (const [index, entry] of parsed.entries()) {
    if (!isPlainObject(entry) || entry.success !== true) {
      throw new Error(`wrangler d1 execute --json entry ${index} is not a successful envelope`);
    }
    const meta = entry.meta;
    if (isPlainObject(meta)) {
      const read = meta.rows_read;
      if (typeof read === "number" && Number.isFinite(read)) rowsRead += read;
      const changed = meta.changes;
      if (typeof changed === "number" && Number.isFinite(changed)) changes += changed;
    }
    const results = entry.results;
    if (results === undefined) continue;
    if (!Array.isArray(results)) throw new Error(`wrangler d1 execute --json entry ${index} results is not an array`);
    for (const row of results) {
      if (!isPlainObject(row)) throw new Error(`wrangler d1 execute --json entry ${index} contained a non-object row`);
      rows.push(row);
    }
  }
  return { rows, rowsRead, changes };
}

export interface RemoteD1Client {
  readonly database: string;
  /** Cumulative D1 rows-read across all statements issued by this client. */
  readonly stats: { rowsRead: number };
  /** Runs one parameterized read and returns rows plus the D1 rows-read metric. */
  queryRows(sql: string, params?: readonly RankedSearchParam[]): Promise<RemoteD1Envelope>;
  /** Executes one parameterized statement (write) and returns affected changes. */
  executeStatement(sql: string, params?: readonly RankedSearchParam[]): Promise<number>;
  /** Executes a multi-statement SQL script through `d1 execute --file`. */
  executeScript(sql: string): Promise<void>;
  /** A structural `D1RuntimeDatabase` so M7.2/M7.3/M7.4 readers can run remotely. */
  runtimeBinding(): D1RuntimeDatabase;
  countRows(table: string): Promise<number>;
}

const TABLE_NAME_PATTERN = /^[a-z_][a-z0-9_]*$/;

export function createRemoteD1Client(options: { runner: WranglerRunner; database: string }): RemoteD1Client {
  const { runner, database } = options;
  if (!TABLE_NAME_PATTERN.test(database)) throw new Error(`invalid remote D1 database name: ${database}`);
  const stats = { rowsRead: 0 };

  async function command(sql: string): Promise<RemoteD1Envelope> {
    const stdout = await runner(["d1", "execute", database, "--remote", "--yes", "--json", "--command", sql]);
    const envelope = parseRemoteD1Envelope(stdout);
    stats.rowsRead += envelope.rowsRead;
    return envelope;
  }

  return {
    database,
    stats,
    async queryRows(sql, params = []) {
      return command(literalizeStatement(sql, params));
    },
    async executeStatement(sql, params = []) {
      return (await command(literalizeStatement(sql, params))).changes;
    },
    async executeScript(sql) {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "worldcons-canary-"));
      const file = path.join(directory, "projection.sql");
      try {
        fs.writeFileSync(file, sql, "utf8");
        // `d1 execute --file` may emit spinner/human text even with `--json`, so
        // success is accepted purely by the runner's non-zero-exit rejection.
        await runner(["d1", "execute", database, "--remote", "--yes", "--file", file]);
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
    runtimeBinding() {
      const binding: D1RuntimeDatabase = {
        prepare(sql: string): D1RuntimePreparedStatement {
          let bound: RankedSearchParam[] = [];
          const chain: D1RuntimePreparedStatement = {
            bind(...values: unknown[]) {
              bound = values as RankedSearchParam[];
              return chain;
            },
            async all<T = Record<string, unknown>>(): Promise<D1RuntimeResult<T>> {
              try {
                const envelope = await command(literalizeStatement(sql, bound));
                return { success: true, results: envelope.rows as unknown as T[], meta: { rows_read: envelope.rowsRead } };
              } catch (error) {
                return { success: false, error: error instanceof Error ? error.message : String(error) };
              }
            },
          };
          return chain;
        },
      };
      return binding;
    },
    async countRows(table) {
      if (!TABLE_NAME_PATTERN.test(table)) throw new Error(`invalid table name: ${table}`);
      const envelope = await command(`select count(*) as n from ${table}`);
      const value = envelope.rows[0]?.n;
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
        throw new Error(`unexpected count for ${table}`);
      }
      return value;
    },
  };
}
