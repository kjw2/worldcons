import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { D1_DATABASES, type D1Database } from "@/lib/cloudflare/d1";
import { buildD1SchemaApplyManifest } from "@/lib/cloudflare/d1/remote";
import { createWranglerD1Runner } from "@/lib/cloudflare/d1/remote/runner";

const DDL_DIR = path.join("artifacts", "cloudflare-m5", "d1-schema-apply");
const REPORT_PATH = path.join("artifacts", "cloudflare-m5", "d1-remote-schema-apply.json");
/**
 * M5.2c PART 2a remote D1 schema-apply CLI.
 *
 *   pnpm d1:apply-schema                 # dry-run/verify (default, no write)
 *   pnpm d1:apply-schema --apply         # apply the M5.1 DDL to the remote D1s
 *   pnpm d1:apply-schema --database=worldcons_core --json
 *   pnpm d1:apply-schema --apply --ddl-dir=artifacts/cloudflare-m5/d1-schema-apply
 *
 * Operator-only and dry-run by default. It applies the M5.1 DDL to the four
 * existing remote `worldcons_*` databases and verifies every expected table and
 * index through `sqlite_master`. It never creates or deletes a database, deploys
 * a Worker, imports data, or changes production authority.
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

function parseDatabases(args: readonly string[]): D1Database[] | null {
  const raw = argValue(args, "database");
  if (raw === null) return null;
  const items = raw.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  if (items.length === 0) throw new Error("--database must list at least one database");
  for (const item of items) {
    if (!(D1_DATABASES as readonly string[]).includes(item)) throw new Error(`unknown database: ${item}`);
  }
  return items as D1Database[];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const writeReport = args.includes("--report");
  const apply = args.includes("--apply");
  const ddlDir = argValue(args, "ddl-dir") ?? DDL_DIR;
  const runner = createWranglerD1Runner({ timeoutMs: positiveIntegerArg(args, "timeout-ms") ?? undefined });
  const manifest = await buildD1SchemaApplyManifest({
    runner,
    apply,
    databases: parseDatabases(args) ?? undefined,
    materializeDdl: (database, sql) => {
      fs.mkdirSync(ddlDir, { recursive: true });
      const file = path.join(ddlDir, `${database}.sql`);
      fs.writeFileSync(file, sql, "utf8");
      return file;
    },
  });

  if (writeReport) {
    fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
    fs.writeFileSync(REPORT_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }
  if (asJson) {
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  } else {
    console.log(`D1 remote schema apply (${manifest.dryRun ? "dry-run" : "apply"})`);
    for (const target of manifest.targets) {
      const id = target.databaseId ?? "-";
      console.log(
        `  ${target.name} [${target.binding}]: ${target.state} / ${target.action} (id ${id}, tables ${target.reportedTables ?? "?"}/${target.expectedTables}, objects ${target.foundObjects}/${target.expectedObjects}, verified ${target.verified})`,
      );
      if (manifest.dryRun) {
        if (target.missingObjects.length > 0) {
          console.log(`    pending: ${target.missingObjects.length} objects to apply`);
        }
      } else {
        for (const object of target.missingObjects) console.error(`    missing: ${object}`);
      }
      for (const error of target.errors) console.error(`    error: ${error}`);
    }
    console.log(
      `totals: ${manifest.totals.targets} targets, ${manifest.totals.applied} applied, ${manifest.totals.present} present, ${manifest.totals.missing} missing, ${manifest.totals.refused} refused`,
    );
    if (writeReport) console.log(`wrote ${REPORT_PATH}`);
    for (const error of manifest.errors) console.error(`error: ${error}`);
    console.log(manifest.ok ? "D1 remote schema apply: OK" : "D1 remote schema apply: FAILED");
  }
  if (!manifest.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`d1-apply-schema failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
