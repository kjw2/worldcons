import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { D1_DATABASES, type D1Database } from "@/lib/cloudflare/d1";
import type { PostgresRowSource } from "@/lib/cloudflare/d1/convert";
import { createPostgresRowSource } from "@/lib/cloudflare/d1/convert/postgres-source";
import { createSupabaseLinkedRowSource } from "@/lib/cloudflare/d1/convert/supabase-linked-source";
import type { D1ImportStatement } from "@/lib/cloudflare/d1/import/types";
import type { WranglerD1Runner } from "@/lib/cloudflare/d1/remote";
import { classifyD1RemoteTargets, parseD1RemoteListJson } from "@/lib/cloudflare/d1/remote/classify";
import { buildD1RemoteDataCopyManifest, D1_REMOTE_DATA_COPY_DATABASES } from "@/lib/cloudflare/d1/remote/data-copy";
import { createD1HttpParameterizedWriter } from "@/lib/cloudflare/d1/remote/http-query";
import { createWranglerD1Runner } from "@/lib/cloudflare/d1/remote/runner";
import { selectD1RemoteTargets } from "@/lib/cloudflare/d1/remote/targets";

const CHUNK_DIR = path.join("artifacts", "cloudflare-m5", "d1-data-copy");
const REPORT_PATH = path.join("artifacts", "cloudflare-m5", "d1-remote-data-copy.json");
const SOURCE_URL_ENV_VAR = "WORLDCONS_D1_SOURCE_URL";

/**
 * The HTTP parameterized writer is credentialed from the environment ONLY. The
 * CLI deliberately exposes no token or account argument, and never echoes either
 * value: the operator places them in the environment, and a dry-run never even
 * reads them.
 */
const ACCOUNT_ID_ENV_VAR = "CLOUDFLARE_ACCOUNT_ID";
const API_TOKEN_ENV_VAR = "CLOUDFLARE_API_TOKEN";

/** The bound-parameter write surface the manifest calls for an oversized statement. */
type ExecuteParameterized = (database: D1Database, statement: D1ImportStatement) => Promise<void>;

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
 *   pnpm d1:copy-data --source=supabase-linked --linked-timeout-ms=120000
 *
 * Operator-only and dry-run by default. It reads the M5.2a canonical datasets
 * from the read-only source and copies the missing suffix into the three
 * relational remote `worldcons_*` databases as PLAIN insert chunks. It never
 * creates or deletes a database, never applies DDL, never deploys a Worker and
 * never changes production authority.
 *
 * A statement too large to materialize into a chunk file is written through the
 * D1 HTTP query API instead, because the Wrangler CLI cannot carry a multi-megabyte
 * literal. That bound-parameter writer is credentialed from the environment ONLY
 * (`CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN`): the CLI exposes no token or
 * account argument and never prints either value. When the credentials are absent
 * the writer is undefined, so a small file-only apply still works and an oversized
 * statement fails closed in the manifest.
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
 *                   its stdout bound and `--linked-timeout-ms=` optionally raises
 *                   its child kill timeout; both are read ONLY here, and default to
 *                   the adapter's own 8 MiB cap and 60s bound when absent.
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
 * Supabase CLI resolves its own target project. `--linked-max-stdout-bytes=` and
 * `--linked-timeout-ms=` are read only inside the linked branch, so the postgres
 * source ignores them entirely and stays URL-only gated; when absent the adapter
 * keeps its own 8 MiB cap and 60s timeout.
 */
function createRowSource(kind: SourceKind, args: readonly string[]): PostgresRowSource {
  if (kind === "supabase-linked") {
    return createSupabaseLinkedRowSource({
      maxStdoutBytes: positiveIntegerArg(args, "linked-max-stdout-bytes") ?? undefined,
      timeoutMs: positiveIntegerArg(args, "linked-timeout-ms") ?? undefined,
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

/**
 * Builds the operator-only HTTP bound-parameter writer from the environment, or
 * returns `undefined`.
 *
 * It returns `undefined` unless this run is an apply AND both `CLOUDFLARE_ACCOUNT_ID`
 * and `CLOUDFLARE_API_TOKEN` are non-empty, so a dry-run never reads the
 * credentials and never runs `d1 list` even when the environment is populated.
 * When both are present it runs exactly `d1 list --json` once, classifies ONLY
 * the selected data-copy targets by exact name (the `--database=` selection, else
 * the three normal copy databases, so `worldcons_search` is never required), and
 * fails closed unless every target is exactly `existing` with a non-null entry.
 * The resulting writer maps each target name to its `entry.uuid`.
 */
async function createHttpParameterizedWriter(options: {
  apply: boolean;
  runner: WranglerD1Runner;
  databases: readonly D1Database[] | null;
}): Promise<ExecuteParameterized | undefined> {
  if (!options.apply) return undefined;

  const accountId = (process.env[ACCOUNT_ID_ENV_VAR] ?? "").trim();
  const apiToken = (process.env[API_TOKEN_ENV_VAR] ?? "").trim();
  if (accountId.length === 0 || apiToken.length === 0) return undefined;

  const entries = parseD1RemoteListJson(await options.runner(["d1", "list", "--json"]));
  const classifications = classifyD1RemoteTargets(
    entries,
    selectD1RemoteTargets(options.databases ?? D1_REMOTE_DATA_COPY_DATABASES),
  );

  const databaseIds: Partial<Record<D1Database, string>> = {};
  for (const classification of classifications) {
    if (classification.state !== "existing" || classification.entry === null) {
      throw new Error(
        `d1 list did not resolve ${classification.target.name} to exactly one existing database (${classification.state}); refusing the HTTP parameterized writer`,
      );
    }
    databaseIds[classification.target.name] = classification.entry.uuid;
  }

  return createD1HttpParameterizedWriter({ accountId, apiToken, databaseIds });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const writeReport = args.includes("--report");
  const apply = args.includes("--apply");
  const sourceKind = resolveSourceKind(args);
  const source = createRowSource(sourceKind, args);
  const databases = parseDatabases(args);
  const runner = createWranglerD1Runner({ timeoutMs: positiveIntegerArg(args, "timeout-ms") ?? undefined });
  try {
    const executeParameterized = await createHttpParameterizedWriter({ apply, runner, databases });
    const manifest = await buildD1RemoteDataCopyManifest({
      runner,
      source,
      sourceKind,
      apply,
      databases: databases ?? undefined,
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
      executeParameterized,
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
            `    ${table.table}: ${table.state} / ${table.action} (expected ${table.expectedRowCount} hash ${table.expectedHash.slice(0, 12)}, remote ${table.remoteRowCount} hash ${remoteHash}, copied ${table.copiedRowCount}, chunks ${table.chunkCount}, planned ${table.plannedWriteCount} / parameterized ${table.plannedParameterizedWriteCount})`,
          );
          for (const error of table.errors) console.error(`      error: ${error}`);
        }
        for (const error of target.errors) console.error(`    error: ${error}`);
      }
      console.log(
        `totals: ${manifest.totals.databases} databases, ${manifest.totals.tables} tables, ${manifest.totals.copied} copied, ${manifest.totals.existing} existing, ${manifest.totals.resumable} resumable, ${manifest.totals.pending} pending, ${manifest.totals.refused} refused, planned ${manifest.totals.plannedWrites} / parameterized ${manifest.totals.plannedParameterizedWrites} (${manifest.totals.parameterizedTables} tables)`,
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
