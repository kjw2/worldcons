import type {
  D1RuntimeDatabase,
  D1RuntimePreparedStatement,
  D1RuntimeResult,
} from "@/lib/cloudflare/d1/runtime-binding";

/**
 * D1 per-request read accounting.
 *
 * `result.meta.rows_read` is the only truthful per-statement cost D1 exposes.
 * The Worker wraps its `worldcons_core` binding with a probe, then logs the
 * accumulated rows for the public read routes so a regression (for example a
 * query that starts scanning the corpus again) is visible in Workers Logs.
 *
 * The wrapper is structural and has no platform import so it can be unit-tested
 * with a fake binding.
 */

export interface D1ReadCost {
  /** Sum of every `meta.rows_read` observed in this request. */
  rowsRead: number;
  /** Number of recorded statements/results. */
  queries: number;
  /** False when at least one result did not expose `meta.rows_read`. */
  rowsReadAvailable: boolean;
  /** The five most expensive statements in this request. */
  topReads: Array<{ sql: string; rowsRead: number }>;
}

export function createD1ReadCost(): D1ReadCost {
  return { rowsRead: 0, queries: 0, rowsReadAvailable: true, topReads: [] };
}

const ORIGINAL_STATEMENT = Symbol("worldcons.originalD1Statement");

interface StatementWithOriginal extends D1RuntimePreparedStatement {
  [ORIGINAL_STATEMENT]?: D1RuntimePreparedStatement;
}

function recordResult(cost: D1ReadCost, result: unknown, sql = "unknown"): void {
  if (!result || typeof result !== "object") return;
  cost.queries += 1;
  const meta = (result as { meta?: unknown }).meta;
  if (!meta || typeof meta !== "object") {
    cost.rowsReadAvailable = false;
    return;
  }
  const rowsRead = (meta as { rows_read?: unknown }).rows_read;
  if (typeof rowsRead !== "number" || !Number.isFinite(rowsRead) || rowsRead < 0) {
    cost.rowsReadAvailable = false;
    return;
  }
  cost.rowsRead += rowsRead;
  cost.topReads.push({ sql: sql.slice(0, 140), rowsRead });
  cost.topReads.sort((left, right) => right.rowsRead - left.rowsRead);
  if (cost.topReads.length > 5) cost.topReads.length = 5;
}

function callable(value: unknown): value is (...args: never[]) => unknown {
  return typeof value === "function";
}

function wrapStatement(statement: D1RuntimePreparedStatement, cost: D1ReadCost, sql = "unknown"): StatementWithOriginal {
  const wrapped: StatementWithOriginal = {
    bind(...values: unknown[]) {
      return wrapStatement(statement.bind(...values), cost, sql);
    },
    all<T = Record<string, unknown>>() {
      return Promise.resolve(statement.all<T>()).then((result) => {
        recordResult(cost, result, sql);
        return result;
      });
    },
  };
  if (callable(statement.run)) {
    wrapped.run = () =>
      Promise.resolve((statement.run as () => Promise<D1RuntimeResult>)()).then((result) => {
        recordResult(cost, result, sql);
        return result;
      });
  }
  wrapped[ORIGINAL_STATEMENT] = statement;
  return wrapped;
}

/**
 * Wraps a D1 binding so every `prepare().bind().all()/run()` (and `batch()`)
 * contributes to one shared cost accumulator. Values and rows are untouched.
 */
export function wrapD1BindingWithReadCost(
  binding: D1RuntimeDatabase,
  cost: D1ReadCost,
): D1RuntimeDatabase {
  const wrapped: D1RuntimeDatabase = {
    prepare(query: string) {
      return wrapStatement(binding.prepare(query), cost, query);
    },
  };
  if (callable(binding.batch)) {
    wrapped.batch = (statements: D1RuntimePreparedStatement[]) => {
      const originals = statements.map(
        (statement) => (statement as StatementWithOriginal)[ORIGINAL_STATEMENT] ?? statement,
      );
      return Promise.resolve((binding.batch as (items: D1RuntimePreparedStatement[]) => Promise<D1RuntimeResult[]>)(originals))
        .then((results) => {
          for (const result of results) recordResult(cost, result, "batch");
          return results;
        });
    };
  }
  return wrapped;
}
