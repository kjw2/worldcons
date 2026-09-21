import { DatabaseSync } from "node:sqlite";
import type { D1ImportParam, D1ImportTarget } from "./types";

/**
 * Local D1 import target backed by `node:sqlite`.
 *
 * D1 is SQLite, so an in-memory or file-backed `node:sqlite` database is a
 * faithful stand-in for a local `wrangler d1 execute --local` run. This module is
 * deliberately NOT re-exported from the import barrel (like the `pg` operator
 * source) so runtime Workers code never loads `node:sqlite`; only the operator
 * CLI and tests import it directly.
 */
export function createLocalD1Target(path = ":memory:"): D1ImportTarget {
  const database = new DatabaseSync(path);
  return {
    exec(sql: string) {
      database.exec(sql);
    },
    run(sql: string, params: readonly D1ImportParam[]) {
      database.prepare(sql).run(...params);
    },
    all(sql: string, params: readonly D1ImportParam[]) {
      return database.prepare(sql).all(...params) as Record<string, unknown>[];
    },
    close() {
      database.close();
    },
  };
}
