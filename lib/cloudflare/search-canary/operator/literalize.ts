import { renderSqlLiteral } from "@/lib/cloudflare/d1/import/literal";
import type { D1ImportParam } from "@/lib/cloudflare/d1/import/types";

/**
 * Operator-only, deterministic SQL literalizer for the M7.5 remote canary.
 *
 * The M7.2/M7.3/M7.4 query builders emit authored SQL text with `?` placeholders
 * and bound parameter values; only authored table/column identifiers ever appear
 * in the SQL text. This module inlines the bound values so the same parameterized
 * statement can be executed through `wrangler d1 execute --command`, which does
 * not accept bound parameters. It scans the SQL and only replaces `?` that are
 * OUTSIDE a single-quoted, double-quoted or backtick literal, so a `?` inside an
 * authored literal (or inside a literalized value) can never shift the binding.
 * Values are encoded with the shared `renderSqlLiteral`, which doubles single
 * quotes and fails closed on any unsupported value.
 *
 * This is deliberately not re-exported from the runtime-neutral barrel: it is an
 * operator CLI concern, never a Worker concern.
 */
export function literalizeStatement(sql: string, params: readonly D1ImportParam[]): string {
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
      if (valueIndex >= params.length) {
        throw new Error("literalizeStatement: more placeholders than bound parameters");
      }
      output += renderSqlLiteral(params[valueIndex]);
      valueIndex += 1;
      index += 1;
      continue;
    }
    output += character;
    index += 1;
  }
  if (valueIndex !== params.length) {
    throw new Error("literalizeStatement: bound parameter count does not match placeholders");
  }
  return output;
}

/** Renders a list of statements as one `;`-terminated SQL script. */
export function literalizeScript(statements: readonly { sql: string; params: readonly D1ImportParam[] }[]): string {
  return statements.map((statement) => `${literalizeStatement(statement.sql, statement.params)};`).join("\n");
}
