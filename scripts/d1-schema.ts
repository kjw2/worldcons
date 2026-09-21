import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { buildD1SchemaReport, d1Schema, emitAllDatabaseDdl } from "@/lib/cloudflare/d1";

const D1_DIR = "d1";
const REPORT_PATH = path.join("artifacts", "cloudflare-m5", "d1-schema-report.json");

/**
 * M5.1 D1 schema CLI.
 *
 *   pnpm d1:schema            validate the schema against the scanned Postgres DDL
 *   pnpm d1:schema --json     print the machine-readable schema report
 *   pnpm d1:schema --emit     write the local DDL to d1/<database>/0001_init.sql
 *   pnpm d1:schema --report   write the report to artifacts/cloudflare-m5/d1-schema-report.json
 *
 * Local only: this never creates a remote database or deploys anything.
 */
function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const emit = args.includes("--emit");
  const writeReport = args.includes("--report");
  const bundle = buildD1SchemaReport(process.cwd());

  if (emit) {
    const ddl = emitAllDatabaseDdl(d1Schema);
    for (const [database, sql] of Object.entries(ddl)) {
      const dir = path.join(D1_DIR, database);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "0001_init.sql"), sql, "utf8");
    }
  }
  if (writeReport) {
    fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
    fs.writeFileSync(REPORT_PATH, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
  }
  if (asJson) {
    process.stdout.write(`${JSON.stringify(bundle, null, 2)}\n`);
  } else {
    const { summary, validation } = bundle;
    console.log(
      `D1 schema: ${summary.tables} tables (${summary.coveredTables} covered, ${summary.plannedTables} planned) across ${summary.databases.length} databases`,
    );
    console.log(
      `Postgres source: ${bundle.generatedFrom.migrations} migrations, ${bundle.generatedFrom.statements} statements, ${summary.postgresTables} tables`,
    );
    for (const table of bundle.tables) {
      console.log(`  ${table.database} :: ${table.name} (${table.columns} cols, pk ${table.primaryKey.join("+")}, ${table.indexes} idx, relocated ${table.relocated.join(",") || "-"})`);
    }
    if (emit) console.log(`wrote ${D1_DIR}/<database>/0001_init.sql`);
    if (writeReport) console.log(`wrote ${REPORT_PATH}`);
    for (const warning of validation.warnings) console.log(`warn ${warning.code}: ${warning.message}`);
    for (const error of validation.errors) console.error(`error ${error.code}: ${error.message}`);
    console.log(validation.ok ? "D1 schema validation: OK" : `D1 schema validation: FAILED (${validation.errors.length} errors)`);
  }

  if (!bundle.validation.ok) process.exitCode = 1;
}

main();