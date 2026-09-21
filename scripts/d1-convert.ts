import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { D1_DATABASES, type D1Database } from "@/lib/cloudflare/d1";
import { buildD1ConversionReport, createMemoryRowSource } from "@/lib/cloudflare/d1/convert";
import type { PostgresRowSource } from "@/lib/cloudflare/d1/convert";
import { createPostgresRowSource } from "@/lib/cloudflare/d1/convert/postgres-source";

const REPORT_PATH = path.join("artifacts", "cloudflare-m5", "d1-convert-report.json");
const SOURCE_URL_ENV_VAR = "WORLDCONS_D1_SOURCE_URL";

/**
 * M5.2a canonical transform CLI.
 *
 *   pnpm d1:convert --source=memory --fixture=fixture.json
 *   pnpm d1:convert --source=postgres --url=$WORLDCONS_D1_SOURCE_URL
 *   pnpm d1:convert --database=worldcons_core --tables=articles,sources --json
 *   pnpm d1:convert --report
 *
 * Local and read-only: this exports Postgres rows and reduces them to canonical
 * datasets. It never writes to D1, creates a remote database, deploys, or
 * changes production authority. The D1 import stage is M5.2b+.
 */
function argValue(args: readonly string[], name: string): string | null {
  const prefix = `--${name}=`;
  for (const arg of args) if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  return null;
}

function positiveIntegerArg(args: readonly string[], name: string): number | null {
  const raw = argValue(args, name);
  if (raw === null) return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`--${name} must be a positive integer`);
  return value;
}

function listArg(args: readonly string[], name: string): string[] | null {
  const raw = argValue(args, name);
  if (raw === null) return null;
  const items = raw.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  return items.length > 0 ? items : null;
}
function parseDatabases(args: readonly string[]): D1Database[] | null {
  const items = listArg(args, "database");
  if (items === null) return null;
  for (const item of items) {
    if (!(D1_DATABASES as readonly string[]).includes(item)) throw new Error(`unknown database: ${item}`);
  }
  return items as D1Database[];
}

function loadMemorySource(args: readonly string[]): PostgresRowSource {
  const fixture = argValue(args, "fixture");
  if (fixture === null) return createMemoryRowSource({});
  const raw = JSON.parse(fs.readFileSync(fixture, "utf8")) as Record<string, Record<string, unknown>[]>;
  return createMemoryRowSource({ rows: raw });
}

function resolveSource(args: readonly string[]): { source: PostgresRowSource; kind: string } {
  const kind = argValue(args, "source") ?? "postgres";
  if (kind === "memory") return { source: loadMemorySource(args), kind };
  if (kind !== "postgres") throw new Error(`--source must be postgres or memory (received ${kind})`);
  const url = (argValue(args, "url") ?? process.env[SOURCE_URL_ENV_VAR] ?? "").trim();
  if (url.length === 0) {
    throw new Error(`postgres export requires --url= or ${SOURCE_URL_ENV_VAR}; refusing to guess a production read`);
  }
  return { source: createPostgresRowSource({ connectionString: url }), kind };
}
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const writeReport = args.includes("--report");
  const { source, kind } = resolveSource(args);
  try {
    const report = await buildD1ConversionReport({
      source,
      sourceKind: kind,
      databases: parseDatabases(args) ?? undefined,
      tables: listArg(args, "tables") ?? undefined,
      batchSize: positiveIntegerArg(args, "batch-size") ?? undefined,
      maxRows: positiveIntegerArg(args, "limit"),
    });
    if (writeReport) {
      fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
      fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    }
    if (asJson) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      console.log(`D1 canonical transform (${report.stage}, source ${report.source.kind})`);
      for (const database of report.databases) {
        console.log(
          `  ${database.database}: ${database.tableCount} tables, ${database.rowCount} rows, hash ${database.hash.slice(0, 12)}`,
        );
        for (const table of database.tables) {
          const relocated = table.relocated.map((entry) => `${entry.column}->${entry.target}`).join(",") || "-";
          console.log(`    ${table.table} (${table.rowCount} rows, hash ${table.hash.slice(0, 12)}, relocated ${relocated})`);
        }
      }
      for (const entry of report.skipped) console.log(`  skip ${entry.database}::${entry.table} (${entry.reason})`);
      if (writeReport) console.log(`wrote ${REPORT_PATH}`);
      console.log(`totals: ${report.totals.databases} databases, ${report.totals.tables} tables, ${report.totals.rows} rows`);
    }
  } finally {
    await source.close();
  }
}

main().catch((error) => {
  console.error(`d1-convert failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});