/** Read-only operator audit of Core vs published immutable P3 snapshots. */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function auditSelectStatements(sql: string): string[] {
  const withoutComments = sql.split(/\r?\n/).filter((line) => !/^\s*--/.test(line)).join("\n");
  const statements = withoutComments.split(";").map((statement) => statement.trim()).filter(Boolean);
  if (statements.length !== 2 || statements.some((statement) => !/^SELECT\s/i.test(statement))) {
    throw new Error("audit_p3_drift.only_two_selects_allowed");
  }
  return statements;
}

function main() {
  const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
  const sqlFile = resolve(root, "scripts/sql/worldcons-p3-snapshot-drift-audit.sql");
  const statements = auditSelectStatements(readFileSync(sqlFile, "utf8"));
  const wrangler = resolve(root, "node_modules/wrangler/bin/wrangler.js");
  const config = resolve(root, "workers/async-pipeline/wrangler.jsonc");
  const sections: unknown[] = [];
  for (let index = 0; index < statements.length; index += 1) {
    const result = spawnSync(process.execPath, [wrangler, "d1", "execute", "worldcons_core",
      "--remote", "--yes", "--json", "--config", config, "--command", statements[index]], {
      cwd: root, encoding: "utf8", timeout: 35_000, maxBuffer: 5 * 1024 * 1024,
    });
    if (result.error || result.status !== 0) {
      throw new Error(`audit_p3_drift.remote_query_${index + 1}_failed: ${result.error?.message ?? String(result.stderr).slice(0, 500)}`);
    }
    const response = JSON.parse(result.stdout) as Array<{ success?: boolean; results?: unknown[] }>;
    if (!Array.isArray(response) || response.some((entry) => entry.success !== true)) {
      throw new Error(`audit_p3_drift.remote_query_${index + 1}_incomplete`);
    }
    sections.push({ query: index === 0 ? "country_summary" : "drift_rows", rows: response.flatMap((entry) => entry.results ?? []) });
  }
  process.stdout.write(`${JSON.stringify({ mode: "production_read_only", sections }, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    console.error(error instanceof Error ? error.message : "audit_p3_drift.unknown_failure");
    process.exitCode = 1;
  }
}
