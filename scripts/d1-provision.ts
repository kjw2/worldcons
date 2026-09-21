import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { D1_DATABASES, type D1Database } from "@/lib/cloudflare/d1";
import { D1_REMOTE_DEFAULT_LOCATION, buildD1RemoteManifest } from "@/lib/cloudflare/d1/remote";
import { createWranglerD1Runner } from "@/lib/cloudflare/d1/remote/runner";

const REPORT_PATH = path.join("artifacts", "cloudflare-m5", "d1-remote-manifest.json");

/**
 * M5.2c PART 1 remote D1 bootstrap CLI.
 *
 *   pnpm d1:provision                     # dry-run preflight (default, no create)
 *   pnpm d1:provision --apply             # create the missing worldcons_* databases
 *   pnpm d1:provision --apply --location=weur
 *   pnpm d1:provision --database=worldcons_core --json
 *
 * Operator-only and dry-run by default. It lists the remote D1 databases through
 * Wrangler, and only with an explicit `--apply` creates the missing ones, then
 * re-lists and runs `d1 info` to prove each create. It never deletes a database,
 * imports schema/data, deploys a Worker, or changes production authority.
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
  const runner = createWranglerD1Runner({ timeoutMs: positiveIntegerArg(args, "timeout-ms") ?? undefined });
  const manifest = await buildD1RemoteManifest({
    runner,
    apply,
    location: argValue(args, "location") ?? D1_REMOTE_DEFAULT_LOCATION,
    databases: parseDatabases(args) ?? undefined,
  });
  if (writeReport) {
    fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
    fs.writeFileSync(REPORT_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }
  if (asJson) {
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  } else {
    console.log(`D1 remote bootstrap (${manifest.dryRun ? "dry-run" : "apply"}, location ${manifest.location})`);
    for (const target of manifest.targets) {
      const id = target.databaseId ?? "-";
      console.log(`  ${target.name} [${target.binding}]: ${target.state} / ${target.action} (id ${id}, verified ${target.verified})`);
      for (const error of target.errors) console.error(`    error: ${error}`);
    }
    console.log(
      `totals: ${manifest.totals.targets} targets, ${manifest.totals.existing} existing, ${manifest.totals.created} created, ${manifest.totals.missing} missing, ${manifest.totals.refused} refused`,
    );
    if (writeReport) console.log(`wrote ${REPORT_PATH}`);
    for (const error of manifest.errors) console.error(`error: ${error}`);
    console.log(manifest.ok ? "D1 remote bootstrap: OK" : "D1 remote bootstrap: FAILED");
  }
  if (!manifest.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`d1-provision failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
