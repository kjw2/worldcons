import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { D1_DATABASES, type D1Database } from "@/lib/cloudflare/d1";
import type { PostgresRowSource } from "@/lib/cloudflare/d1/convert";
import { createPostgresRowSource } from "@/lib/cloudflare/d1/convert/postgres-source";
import { createSupabaseLinkedRowSource } from "@/lib/cloudflare/d1/convert/supabase-linked-source";
import { buildD1RemoteDataCopyManifest } from "@/lib/cloudflare/d1/remote/data-copy";
import { createWranglerD1Runner } from "@/lib/cloudflare/d1/remote/runner";

const CHUNK_DIR = path.join("artifacts", "cloudflare-m5", "d1-data-copy");
const REPORT_PATH = path.join("artifacts", "cloudflare-m5", "d1-remote-data-copy.json");
const SOURCE_URL_ENV_VAR = "WORLDCONS_D1_SOURCE_URL";

/** The read sources the operator CLI can use. `postgres` is the default. */
type SourceKind = "postgres" | "supabase-linked";
const SOURCE_KINDS: readonly SourceKind[] = ["postgres", "supabase-linked"];

/**
 * M5.2c PART 2b remote D1 data-copy CLI.
 *
 *   pnpm d1:copy-data                          # dry-run/compare (default, no write)
 *   pnpm d1:copy-data --url=$WORLDCONS_D1_SOURCE_URL
 *   pnpm d1:copy-data --apply --url=$WORLDCONS_D1_SOURCE_URL
 *   pnpm d1:copy-data --database=worldcons_core --tables=events,venues --json
 *   pnpm d1:copy-data --apply --batch-size=1000 --rows-per-statement=50
 *   pnpm d1:copy-data --source=supabase-linked --database=worldcons_core --report
 *   pnpm d1:copy-data --source=supabase-linked --linked-max-stdout-bytes=16777216
 *
 * Operator-only and dry-run by default. It reads the M5.2a canonical datasets
 * from the read-only source and copies the missing suffix into the three
 * relational remote `worldcons_*` databases as PLAIN insert chunks. It never
 * creates or deletes a database, never applies DDL, never deploys a Worker and
 * never changes production authority.
 *
 * Two read sources are available via `--source=`:
 *
 *   postgres        (default) the direct `pg` client. The connection URL MUST be
 *                   supplied explicitly through `--url=`/`WORLDCONS_D1_SOURCE_URL`;
 *                   it never falls back to `DATABASE_URL` or any other environment
 *                   variable, so a production read can never be guessed.
 *   supabase-linked the `supabase db query --linked` CLI. It resolves its own
 *                   linked project, so it deliberately inspects NO URL environment
 *                   variable at all. `--linked-max-stdout-bytes=` optionally raises
 *                   its stdout bound; it is read ONLY here, and defaults to the
 *                   adapter's own 8 MiB cap when absent.
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

function resolveSourceKind(args: readonly string[]): SourceKind {
  const raw = (argValue(args, "source") ?? "postgres").trim();
  if (!(SOURCE_KINDS as readonly string[]).includes(raw)) {
    throw new Error(`unknown --source=${raw} (expected ${SOURCE_KINDS.join("|")})`);
  }
  return raw as SourceKind;
}

/**
 * `postgres` resolves the connection URL explicitly (see `resolveSourceUrl`);
 * `supabase-linked` never touches a URL environment variable, because the linked
 * Supabase CLI resolves its own target project. `--linked-max-stdout-bytes=` is
 * read only inside the linked branch, so the postgres source ignores it entirely
 * and stays URL-only gated; when absent the adapter keeps its own 8 MiB cap.
 */
function createRowSource(kind: SourceKind, args: readonly string[]): PostgresRowSource {
  if (kind === "supabase-linked") {
    return createSupabaseLinkedRowSource({
      maxStdoutBytes: positiveIntegerArg(args, "linked-max-stdout-bytes") ?? undefined,
    });
  }
  return createPostgresRowSource({ connectionString: resolveSourceUrl(args) });
}

function resolveSourceUrl(args: readonly string[]): string {
  const url = (argValue(args, "url") ?? process.env[SOURCE_URL_ENV_VAR] ?? "").trim();
  if (url.length === 0) {
    throw new Error(`postgres export requires --url= or ${SOURCE_URL_ENV_VAR}; refusing to guess a production read`);
  }
  return url;
}

function chunkPath(database: D1Database, table: string, chunkIndex: number): string {
  const dir = path.join(CHUNK_DIR, database, table);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `chunk-${String(chunkIndex).padStart(4, "0")}.sql`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const writeReport = args.includes("--report");
  const apply = args.includes("--apply");
  const sourceKind = resolveSourceKind(args);
  const source = createRowSource(sourceKind, args);
  try {
    const manifest = await buildD1RemoteDataCopyManifest({
      runner: createWranglerD1Runner({ timeoutMs: positiveIntegerArg(args, "timeout-ms") ?? undefined }),
      source,
      sourceKind,
      apply,
      databases: parseDatabases(args) ?? undefined,
      tables: listArg(args, "tables") ?? undefined,
      batchSize: positiveIntegerArg(args, "batch-size") ?? undefined,
      rowsPerStatement: positiveIntegerArg(args, "rows-per-statement") ?? undefined,
      maxStatementsPerChunk: positiveIntegerArg(args, "max-statements-per-chunk") ?? undefined,
      maxBytesPerChunk: positiveIntegerArg(args, "max-bytes-per-chunk") ?? undefined,
      materializeChunk: apply
        ? (database, table, chunkIndex, sql) => {
            const file = chunkPath(database, table, chunkIndex);
            fs.writeFileSync(file, `${sql}\n`, "utf8");
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
      console.log(`D1 remote data copy (${manifest.dryRun ? "dry-run" : "apply"})`);
      for (const target of manifest.targets) {
        console.log(
          `  ${target.name} [${target.binding}]: ${target.state} / ${target.action} (tables ${target.tableCount}, rows ${target.remoteRowCount}/${target.expectedRowCount}, copied ${target.copiedRowCount}, verified ${target.verified})`,
        );
        for (const table of target.tables) {
          const remoteHash = table.remoteHash === null ? "none" : table.remoteHash.slice(0, 12);
          console.log(
            `    ${table.table}: ${table.state} / ${table.action} (expected ${table.expectedRowCount} hash ${table.expectedHash.slice(0, 12)}, remote ${table.remoteRowCount} hash ${remoteHash}, copied ${table.copiedRowCount}, chunks ${table.chunkCount})`,
          );
          for (const error of table.errors) console.error(`      error: ${error}`);
        }
        for (const error of target.errors) console.error(`    error: ${error}`);
      }
      console.log(
        `totals: ${manifest.totals.databases} databases, ${manifest.totals.tables} tables, ${manifest.totals.copied} copied, ${manifest.totals.existing} existing, ${manifest.totals.resumable} resumable, ${manifest.totals.pending} pending, ${manifest.totals.refused} refused`,
      );
      if (writeReport) console.log(`wrote ${REPORT_PATH}`);
      for (const error of manifest.errors) console.error(`error: ${error}`);
      console.log(manifest.ok ? "D1 remote data copy: OK" : "D1 remote data copy: FAILED");
    }
    if (!manifest.ok) process.exitCode = 1;
  } finally {
    await source.close();
  }
}

main().catch((error) => {
  console.error(`d1-copy-data failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
