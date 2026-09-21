import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { D1_DATABASES, type D1Database } from "@/lib/cloudflare/d1";
import { createMemoryRowSource } from "@/lib/cloudflare/d1/convert";
import type { PostgresRowSource } from "@/lib/cloudflare/d1/convert";
import { createPostgresRowSource } from "@/lib/cloudflare/d1/convert/postgres-source";
import { buildD1ImportReport } from "@/lib/cloudflare/d1/import";
import type { D1ImportTarget } from "@/lib/cloudflare/d1/import";
import { createLocalD1Target } from "@/lib/cloudflare/d1/import/local-target";

const REPORT_PATH = path.join("artifacts", "cloudflare-m5", "d1-import-report.json");
const SOURCE_URL_ENV_VAR = "WORLDCONS_D1_SOURCE_URL";

/**
 * M5.2b D1 import CLI.
 *
 *   pnpm d1:import --source=memory --fixture=fixture.json
 *   pnpm d1:import --source=postgres --url=$WORLDCONS_D1_SOURCE_URL
 *   pnpm d1:import --db-dir=artifacts/cloudflare-m5/d1-local --emit=artifacts/cloudflare-m5/d1-import
 *
 * Local and read-only against the source: it exports Postgres rows, reduces them
 * to canonical datasets, emits the D1 import, applies it to a local `node:sqlite`
 * database, and verifies the round trip against the canonical hashes. It never
 * creates a remote database, deploys, or changes production authority.
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
  const emitDir = argValue(args, "emit");
  const databases = parseDatabases(args);
  const dbPath = argValue(args, "db");
  const dbDir = argValue(args, "db-dir");
  if (dbPath !== null && dbDir !== null) throw new Error("--db and --db-dir cannot be combined");
  const { source, kind } = resolveSource(args);
  const selected = databases ?? [...D1_DATABASES];
  const targets: Partial<Record<D1Database, D1ImportTarget>> = {};
  const opened: D1ImportTarget[] = [];
  try {
    for (const database of selected) {
      const targetPath = dbPath ?? (dbDir === null ? ":memory:" : path.join(dbDir, `${database}.sqlite`));
      if (targetPath !== ":memory:") fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      const target = createLocalD1Target(targetPath);
      targets[database] = target;
      opened.push(target);
    }
    const report = await buildD1ImportReport({
      source,
      sourceKind: kind,
      targets,
      databases: databases ?? undefined,
      tables: listArg(args, "tables") ?? undefined,
      batchSize: positiveIntegerArg(args, "batch-size") ?? undefined,
      maxRows: positiveIntegerArg(args, "limit"),
      rowsPerStatement: positiveIntegerArg(args, "rows-per-statement"),
      targetKind: "local-sqlite",
      targetPersistent: dbPath !== null || dbDir !== null,
      includeScripts: emitDir !== null,
    });
    if (emitDir !== null) {
      for (const database of report.databases) {
        const file = path.join(emitDir, `${database.database}.sql`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `${database.script ?? ""}\n`, "utf8");
      }
    }
    if (writeReport) {
      fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
      fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    }
    if (asJson) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      console.log(`D1 import (${report.stage}, source ${report.source.kind}, target ${report.target.kind})`);
      for (const database of report.databases) {
        const status = database.ok ? "verified" : "MISMATCH";
        console.log(
          `  ${database.database}: ${database.tables.length} tables, ${database.rowCount} rows, hash ${database.hash.slice(0, 12)}, ${status}`,
        );
        for (const table of database.tables) {
          console.log(`    ${table.table} (${table.rowCount} rows, ${table.statementCount} stmt, hash ${table.hash.slice(0, 12)})`);
          for (const error of table.errors) console.error(`      error: ${error}`);
        }
      }
      for (const entry of report.skipped) console.log(`  skip ${entry.database}::${entry.table} (${entry.reason})`);
      if (emitDir !== null) console.log(`wrote ${emitDir}/<database>.sql`);
      if (writeReport) console.log(`wrote ${REPORT_PATH}`);
      console.log(
        `totals: ${report.totals.databases} databases, ${report.totals.tables} tables, ${report.totals.rows} rows, ${report.totals.statements} statements, verified ${report.totals.verified}`,
      );
    }
    if (!report.totals.verified) process.exitCode = 1;
  } finally {
    for (const target of opened) target.close?.();
    await source.close();
  }
}

main().catch((error) => {
  console.error(`d1-import failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
