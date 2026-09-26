import { renderSqlLiteral } from "@/lib/cloudflare/d1/import/literal";
import type {
  SearchCanaryParameterizedStatement,
  SearchCanaryWriteParam,
  SearchCanaryWritePlan,
  SearchCanaryWritePlanSummary,
  SearchCanaryWriteResult,
  SearchCanaryWriteTransportKind,
} from "./types";

/**
 * M7.6 runtime-neutral parameterized write planning for the isolated canary.
 *
 * M7.5's operator inlined every bound value into SQL text so it could use
 * `wrangler d1 execute --command`, which hits Cloudflare D1's 100 KB
 * per-statement limit on large `search_text` values. M7.6 never literalizes a
 * write: the plan keeps the authored `?` SQL and the bound params SEPARATE, so
 * the SQL statement text stays tiny and a large document is carried entirely in
 * the parameter payload. The literal-size fields are diagnostics only (they
 * measure what the old path would have produced); they never cause truncation
 * and they never gate a write.
 *
 * This module imports no Node builtin and performs no remote call. The transport
 * (isolated Worker D1 binding or the D1 HTTP query API) is injected by the
 * operator.
 */
export const SEARCH_CANARY_WRITE_VERSION = 1 as const;

/** Cloudflare D1's documented maximum SQL statement length (not payload size). */
export const SEARCH_CANARY_D1_SQL_STATEMENT_MAX_BYTES = 100_000 as const;

/** The bound-parameter execution surface: returns the statement's affected rows. */
export type SearchCanaryWriteExecutor = (
  statement: SearchCanaryParameterizedStatement,
) => Promise<number>;

/**
 * Minimal authored statement shape accepted by the planner. It is deliberately
 * looser than `D1ImportStatement` so both the D1 emitter and the search
 * projection emitter (readonly params) can feed it; every param is validated.
 */
export interface SearchCanaryWriteInputStatement {
  sql: string;
  params: readonly unknown[];
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** Bytes contributed by one bound parameter, without ever rendering its value. */
function paramByteLength(param: SearchCanaryWriteParam): number {
  if (param === null) return 0;
  if (typeof param === "number") return byteLength(String(param));
  return byteLength(param);
}

function encodeParam(param: unknown): SearchCanaryWriteParam {
  if (param === null) return null;
  if (typeof param === "string") return param;
  if (typeof param === "number") {
    if (!Number.isFinite(param)) throw new Error("search canary write param must be a finite number");
    return param;
  }
  // A boolean/blob/search-projection param would need an encoding decision that
  // the search projection never emits, so fail closed instead of guessing.
  throw new Error(`search canary write param is not a string/number/null (${typeof param})`);
}

function isInsertOnly(sql: string): boolean {
  return /^\s*insert\b/i.test(sql);
}

/**
 * Builds a parameterized write plan from the emitter's statements. Every
 * statement must be a plain `INSERT` (the search projection is insert-only); a
 * destructive statement fails closed. `params` are never merged into `sql`.
 */
export function buildSearchCanaryWritePlan(
  statements: readonly SearchCanaryWriteInputStatement[],
  options: { limitBytes?: number } = {},
): SearchCanaryWritePlan {
  const limitBytes = options.limitBytes ?? SEARCH_CANARY_D1_SQL_STATEMENT_MAX_BYTES;
  if (!Number.isInteger(limitBytes) || limitBytes <= 0) throw new Error("limitBytes must be a positive integer");

  let parameters = 0;
  let maxAuthoredSqlBytes = 0;
  let maxParamBytes = 0;
  let maxLiteralBytes = 0;
  let literalOversizedStatements = 0;
  let literalOversizedBytes = 0;
  const planned: SearchCanaryParameterizedStatement[] = [];

  for (const statement of statements) {
    if (typeof statement.sql !== "string" || statement.sql.trim().length === 0) {
      throw new Error("search canary write statement is empty");
    }
    if (!isInsertOnly(statement.sql)) {
      throw new Error("search canary write plan refuses a non-INSERT statement");
    }
    const params = statement.params.map(encodeParam);
    parameters += params.length;
    const authoredBytes = byteLength(statement.sql);
    if (authoredBytes > maxAuthoredSqlBytes) maxAuthoredSqlBytes = authoredBytes;
    for (const param of params) {
      const bytes = paramByteLength(param);
      if (bytes > maxParamBytes) maxParamBytes = bytes;
    }
    // Measure exactly what the legacy literalized path would have produced, so
    // the report can show the oversize that the parameterized path now avoids.
    const renderedBytes = byteLength(renderStatement(statement.sql, params));
    if (renderedBytes > maxLiteralBytes) maxLiteralBytes = renderedBytes;
    if (renderedBytes > limitBytes) {
      literalOversizedStatements += 1;
      literalOversizedBytes += renderedBytes;
    }
    planned.push({ sql: statement.sql, params });
  }

  return {
    version: SEARCH_CANARY_WRITE_VERSION,
    destructive: false,
    limitBytes,
    counts: {
      statements: planned.length,
      parameters,
      maxAuthoredSqlBytes,
      maxParamBytes,
      maxLiteralBytes,
      literalOversizedStatements,
      literalOversizedBytes,
    },
    statements: planned,
  };
}

/**
 * Reduces an executable plan to its content-free summary. This is the ONLY shape
 * that may be attached to a `SearchCanaryReport`, serialized to JSON, rendered as
 * Markdown or logged: the authored SQL and the bound params (which may contain
 * document/search text) are dropped entirely here.
 */
export function summarizeSearchCanaryWritePlan(plan: SearchCanaryWritePlan): SearchCanaryWritePlanSummary {
  return {
    version: SEARCH_CANARY_WRITE_VERSION,
    destructive: false,
    limitBytes: plan.limitBytes,
    counts: { ...plan.counts },
  };
}

/**
 * Diagnostic rendering used ONLY to measure the literal byte size the legacy
 * path would have produced. It never feeds an executed statement.
 */
function renderStatement(sql: string, params: readonly SearchCanaryWriteParam[]): string {
  let output = "";
  let valueIndex = 0;
  let index = 0;
  while (index < sql.length) {
    const character = sql[index];
    if (character === "'" || character === '"' || character === "`") {
      output += character;
      index += 1;
      while (index < sql.length) {
        const inner = sql[index];
        output += inner;
        index += 1;
        if (inner === character) {
          if (sql[index] === character) {
            output += character;
            index += 1;
            continue;
          }
          break;
        }
      }
      continue;
    }
    if (character === "?") {
      output += renderSqlLiteral(params[valueIndex] ?? null);
      valueIndex += 1;
      index += 1;
      continue;
    }
    output += character;
    index += 1;
  }
  return output;
}

/**
 * Executes a write plan through the injected parameterized transport, serially
 * and in authored order, summing the affected rows. A non-integer/negative
 * reported change count fails closed so a silent no-op write cannot pass.
 */
export async function executeSearchCanaryWritePlan(
  plan: SearchCanaryWritePlan,
  transport: SearchCanaryWriteTransportKind,
  execute: SearchCanaryWriteExecutor,
): Promise<SearchCanaryWriteResult> {
  let executedStatements = 0;
  let totalChanges = 0;
  for (const statement of plan.statements) {
    const changes = await execute(statement);
    if (typeof changes !== "number" || !Number.isInteger(changes) || changes < 0) {
      throw new Error("search canary write transport returned an invalid change count");
    }
    totalChanges += changes;
    executedStatements += 1;
  }
  return { transport, executedStatements, totalChanges };
}
