import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { D1_DATABASES, type D1Database } from "@/lib/cloudflare/d1";
import {
  buildD1MigrationApplyManifest,
  buildD1RemoteMigrations,
  type D1MigrationSourceFile,
} from "@/lib/cloudflare/d1/remote";
import { createWranglerD1Runner } from "@/lib/cloudflare/d1/remote/runner";

const D1_DIR = "d1";
const MATERIALIZE_DIR = path.join("artifacts", "cloudflare-m5", "d1-migrations");
const REPORT_PATH = path.join("artifacts", "cloudflare-m5", "d1-remote-migration-apply.json");

/**
 * M5.2c PART 2c additive remote D1 migration CLI.
 *
 *   pnpm d1:migrate                        # dry-run/verify (default, no write)
 *   pnpm d1:migrate --apply                # apply only the pending additive migrations
 *   pnpm d1:migrate --database=worldcons_ops --json
 *   pnpm d1:migrate --apply --migration-dir=d1 --report
 *
 * Operator-only and dry-run by default. It discovers numbered additive
 * migrations (`NNNN_name.sql` with number > 0001) for the selected databases and
 * applies only the pending ones through `wrangler d1 execute --remote --file`,
 * verifying each through `sqlite_master`. The historical `0001_init.sql` baseline
 * is filtered out and is never rerun or modified. It never creates or deletes a
 * database, deploys a Worker, copies data, or changes production authority.
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

/**
 * Reads every `*.sql` file under `<migrationDir>/<database>` for the selected
 * databases. Discovery filters to the numbered additive migrations afterwards.
 * A missing directory is skipped; a file that is not `NNNN_name.sql` fails
 * closed inside `buildD1RemoteMigrations`.
 */
function discoverMigrationFiles(migrationDir: string, databases: readonly D1Database[]): D1MigrationSourceFile[] {
  const files: D1MigrationSourceFile[] = [];
  for (const database of databases) {
    const dir = path.join(migrationDir, database);
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir).filter((entry) => entry.endsWith(".sql")).sort()) {
      files.push({ database, file, sql: fs.readFileSync(path.join(dir, file), "utf8") });
    }
  }
  return files;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const writeReport = args.includes("--report");
  const apply = args.includes("--apply");
  const migrationDir = argValue(args, "migration-dir") ?? D1_DIR;
  const databases = parseDatabases(args);
  const runner = createWranglerD1Runner({ timeoutMs: positiveIntegerArg(args, "timeout-ms") ?? undefined });
  const migrations = buildD1RemoteMigrations(discoverMigrationFiles(migrationDir, databases ?? D1_DATABASES));
  const manifest = await buildD1MigrationApplyManifest({
    runner,
    migrations,
    apply,
    databases: databases ?? undefined,
    materializeMigration: apply
      ? (migration) => {
          const dir = path.join(MATERIALIZE_DIR, migration.database);
          fs.mkdirSync(dir, { recursive: true });
          const file = path.join(dir, migration.file);
          fs.writeFileSync(file, migration.sql, "utf8");
          return file;
        }
      : undefined,
  });

  if (writeReport) {
    fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
    fs.writeFileSync(REPORT_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }
  if (asJson) {
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  } else {
    console.log(`D1 remote additive migration (${manifest.dryRun ? "dry-run" : "apply"})`);
    for (const target of manifest.targets) {
      const id = target.databaseId ?? "-";
      console.log(
        `  ${target.name} [${target.binding}]: ${target.state} / ${target.action} (id ${id}, migrations ${target.migrations.length}, pending ${target.pending}, applied ${target.applied}, verified ${target.verified})`,
      );
      for (const migration of target.migrations) {
        console.log(
          `    ${migration.id} ${migration.file}: ${migration.state} (verified ${migration.verified}${migration.detail === null ? "" : `, ${migration.detail}`})`,
        );
        for (const error of migration.errors) console.error(`      error: ${error}`);
      }
      for (const error of target.errors) console.error(`    error: ${error}`);
    }
    console.log(
      `totals: ${manifest.totals.targets} targets, ${manifest.totals.migrations} migrations, ${manifest.totals.pending} pending, ${manifest.totals.applied} applied, ${manifest.totals.present} present, ${manifest.totals.missing} missing, ${manifest.totals.refused} refused`,
    );
    if (writeReport) console.log(`wrote ${REPORT_PATH}`);
    for (const error of manifest.errors) console.error(`error: ${error}`);
    console.log(manifest.ok ? "D1 remote additive migration: OK" : "D1 remote additive migration: FAILED");
  }
  if (!manifest.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`d1-migrate failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
