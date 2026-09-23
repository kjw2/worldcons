import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { D1_DATABASES, type D1Database } from "@/lib/cloudflare/d1";
import type { PostgresRowSource } from "@/lib/cloudflare/d1/convert";
import { createPostgresRowSource } from "@/lib/cloudflare/d1/convert/postgres-source";
import { createSupabaseLinkedRowSource } from "@/lib/cloudflare/d1/convert/supabase-linked-source";
import type { D1ImportStatement } from "@/lib/cloudflare/d1/import/types";
import type { WranglerD1Runner } from "@/lib/cloudflare/d1/remote";
import {
  D1RemoteError,
  classifyD1RemoteTargets,
  parseD1RemoteListJson,
} from "@/lib/cloudflare/d1/remote/classify";
import { buildD1RemoteDataCopyManifest, D1_REMOTE_DATA_COPY_DATABASES } from "@/lib/cloudflare/d1/remote/data-copy";
import { createD1HttpParameterizedWriter } from "@/lib/cloudflare/d1/remote/http-query";
import { createWranglerD1Runner } from "@/lib/cloudflare/d1/remote/runner";
import { selectD1RemoteTargets } from "@/lib/cloudflare/d1/remote/targets";

const CHUNK_DIR = path.join("artifacts", "cloudflare-m5", "d1-data-copy");
const REPORT_PATH = path.join("artifacts", "cloudflare-m5", "d1-remote-data-copy.json");
const SOURCE_URL_ENV_VAR = "WORLDCONS_D1_SOURCE_URL";

/**
 * The HTTP parameterized writer is credentialed from the environment ONLY. The
 * CLI deliberately exposes no token or account argument and never echoes either
 * value. Credentials are resolved LAZILY, on the first oversized statement only:
 * a dry-run passes no writer at all, and a small file-only apply never resolves a
 * credential. A missing env value falls back to the operator's existing Wrangler
 * session through the same runner (`auth token --json` / `whoami --json`), so no
 * secret is ever placed on the command line or in the persisted manifest.
 */
const ACCOUNT_ID_ENV_VAR = "CLOUDFLARE_ACCOUNT_ID";
const API_TOKEN_ENV_VAR = "CLOUDFLARE_API_TOKEN";

/** A 32-character hexadecimal Cloudflare account id. */
const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/i;

/** The bound-parameter write surface the manifest calls for an oversized statement. */
type ExecuteParameterized = (database: D1Database, statement: D1ImportStatement) => Promise<void>;

/** The credential environment the lazy writer reads; defaults to `process.env`. */
export type ParameterizedWriterEnv = Record<string, string | undefined>;

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
 *   pnpm d1:copy-data --max-rows=1000 --database=worldcons_core
 *
 * Operator-only and dry-run by default. It reads the M5.2a canonical datasets
 * from the read-only source and copies the missing suffix into the three
 * relational remote `worldcons_*` databases as PLAIN insert chunks. It never
 * creates or deletes a database, never applies DDL, never deploys a Worker and
 * never changes production authority. `--max-rows=` optionally caps the rows read
 * per table (a positive integer); when absent the whole table is read.
 *
 * A statement too large to materialize into a chunk file is written through the
 * D1 HTTP query API instead, because the Wrangler CLI cannot carry a multi-megabyte
 * literal. That bound-parameter writer is resolved LAZILY: in apply mode the CLI
 * hands the manifest a callback that authenticates and lists the databases only on
 * its first oversized statement, so a dry-run passes no writer and a small
 * file-only apply never resolves a credential, runs `whoami` or runs `d1 list`.
 * Credentials come from the environment ONLY (`CLOUDFLARE_ACCOUNT_ID` +
 * `CLOUDFLARE_API_TOKEN`); a missing value falls back to the operator's existing
 * Wrangler session through the same runner (`auth token --json` for the token,
 * `whoami --json` for the account). The CLI exposes no token or account argument
 * and never prints a token, `whoami` output or any other secret.
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function nonEmptyEnv(value: string | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Parses `wrangler auth token --json`. It accepts ONLY
 * `{ type: "api_token" | "oauth", token: <non-empty string> }`; a global
 * `api_key`, a missing/blank token or malformed JSON fails closed with a stable
 * code. The message never includes the raw output or the token.
 */
export function parseAuthTokenJson(stdout: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new D1RemoteError("d1_remote.malformed_auth_token_json", "wrangler auth token --json did not return JSON");
  }
  const record = asRecord(parsed);
  const type = record === null ? null : nonEmptyString(record, "type");
  const token = record === null ? null : nonEmptyString(record, "token");
  if ((type !== "api_token" && type !== "oauth") || token === null) {
    throw new D1RemoteError(
      "d1_remote.auth_token_unusable",
      "wrangler auth token --json did not return a usable api_token/oauth token",
    );
  }
  return token;
}

/**
 * Parses `wrangler whoami --json`. It requires `loggedIn === true` and an
 * `accounts` array. With no expected id (the account env is absent) it requires
 * exactly ONE account and returns its 32-hex id; with an expected id (only read
 * when `whoami` was actually needed) it requires an exact matching account.
 * Malformed output, a logged-out session, an ambiguous account set, a mismatch or
 * a non-32-hex id all fail closed with a stable code, and the message never
 * includes the raw output.
 */
export function parseWhoamiAccountId(stdout: string, expectedAccountId: string | null): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new D1RemoteError("d1_remote.malformed_whoami_json", "wrangler whoami --json did not return JSON");
  }
  const record = asRecord(parsed);
  if (record === null || record.loggedIn !== true) {
    throw new D1RemoteError("d1_remote.not_logged_in", "wrangler whoami --json did not report loggedIn true");
  }
  if (!Array.isArray(record.accounts)) {
    throw new D1RemoteError("d1_remote.malformed_whoami_json", "wrangler whoami --json is missing an accounts array");
  }
  const accountIds: string[] = [];
  for (const entry of record.accounts) {
    const account = asRecord(entry);
    const id = account === null ? null : nonEmptyString(account, "id");
    if (id !== null) accountIds.push(id);
  }
  if (expectedAccountId !== null) {
    if (!accountIds.includes(expectedAccountId)) {
      throw new D1RemoteError(
        "d1_remote.account_mismatch",
        "wrangler whoami --json does not contain the configured CLOUDFLARE_ACCOUNT_ID",
      );
    }
    return expectedAccountId;
  }
  if (accountIds.length !== 1) {
    throw new D1RemoteError(
      "d1_remote.ambiguous_account",
      `wrangler whoami --json resolved ${accountIds.length} accounts; set CLOUDFLARE_ACCOUNT_ID to select exactly one`,
    );
  }
  const [accountId] = accountIds;
  if (!ACCOUNT_ID_PATTERN.test(accountId)) {
    throw new D1RemoteError(
      "d1_remote.invalid_account_id",
      "wrangler whoami --json account id is not a 32-character hex id",
    );
  }
  return accountId;
}

/**
 * Resolves the operator-only HTTP bound-parameter writer, fail-closed.
 *
 * The account id and API token come from the environment when non-empty;
 * otherwise the existing Wrangler session supplies them through the injected
 * runner (`whoami --json` for the account, `auth token --json` for the token).
 * It then runs exactly `d1 list --json` once, classifies ONLY the selected
 * data-copy targets by exact name (the `--database=` selection, else the three
 * normal copy databases, so `worldcons_search` is never required), and fails
 * closed unless every target is exactly `existing` with a non-null entry. The
 * resulting writer maps each target name to its `entry.uuid`.
 *
 * It performs no I/O of its own beyond the injected runner and never prints a
 * credential; the lazy wrapper below defers it to the first oversized statement.
 */
export async function resolveParameterizedWriter(options: {
  runner: WranglerD1Runner;
  databases: readonly D1Database[] | null;
  env: ParameterizedWriterEnv;
  fetch?: typeof fetch;
}): Promise<ExecuteParameterized> {
  const { runner, env } = options;
  const envAccountId = nonEmptyEnv(env[ACCOUNT_ID_ENV_VAR]);
  const envApiToken = nonEmptyEnv(env[API_TOKEN_ENV_VAR]);

  const apiToken = envApiToken ?? parseAuthTokenJson(await runner(["auth", "token", "--json"]));
  const accountId = envAccountId ?? parseWhoamiAccountId(await runner(["whoami", "--json"]), null);

  const entries = parseD1RemoteListJson(await runner(["d1", "list", "--json"]));
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

  return createD1HttpParameterizedWriter({ accountId, apiToken, databaseIds, fetch: options.fetch });
}

/**
 * Builds the lazy bound-parameter writer the manifest receives in apply mode.
 *
 * It returns `undefined` for a dry-run without reading any credential. In apply
 * mode it returns a callback that resolves credentials, `whoami`, `d1 list` and
 * the writer ONCE, on its first actual invocation, caching the resulting promise
 * so a copy with hundreds of oversized statements authenticates and lists at
 * most once. A small file-only apply never invokes the callback, so it never runs
 * `auth token`, `whoami` or `d1 list`.
 */
export function createLazyParameterizedWriter(options: {
  apply: boolean;
  runner: WranglerD1Runner;
  databases: readonly D1Database[] | null;
  env?: ParameterizedWriterEnv;
  fetch?: typeof fetch;
}): ExecuteParameterized | undefined {
  if (!options.apply) return undefined;
  const env = options.env ?? process.env;
  let writer: Promise<ExecuteParameterized> | null = null;
  const load = (): Promise<ExecuteParameterized> => {
    writer ??= resolveParameterizedWriter({
      runner: options.runner,
      databases: options.databases,
      env,
      fetch: options.fetch,
    });
    return writer;
  };
  return async (database, statement) => {
    const execute = await load();
    await execute(database, statement);
  };
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
    const executeParameterized = createLazyParameterizedWriter({ apply, runner, databases });
    const manifest = await buildD1RemoteDataCopyManifest({
      runner,
      source,
      sourceKind,
      apply,
      databases: databases ?? undefined,
      tables: listArg(args, "tables") ?? undefined,
      batchSize: positiveIntegerArg(args, "batch-size") ?? undefined,
      maxRows: positiveIntegerArg(args, "max-rows") ?? undefined,
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

/**
 * Runs the CLI only when this module is the entry script, so the operator can
 * import the credential parsers and the lazy-writer factory under test without
 * executing the copy.
 */
const invokedAsEntryScript =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedAsEntryScript) {
  main().catch((error) => {
    console.error(`d1-copy-data failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
