import process from "node:process";
import { pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { D1_DATABASES, type D1Database } from "@/lib/cloudflare/d1";
import type { PostgresRowSource } from "@/lib/cloudflare/d1/convert";
import { createPostgresRowSource } from "@/lib/cloudflare/d1/convert/postgres-source";
import { createSupabaseLinkedRowSource } from "@/lib/cloudflare/d1/convert/supabase-linked-source";
import type { D1ImportStatement } from "@/lib/cloudflare/d1/import/types";
import type { WranglerD1Runner } from "@/lib/cloudflare/d1/remote";
import { classifyD1RemoteTargets, parseD1RemoteListJson } from "@/lib/cloudflare/d1/remote/classify";
import {
  D1_REMOTE_RECONCILE_DATABASES,
  buildD1RemoteReconcileManifest,
} from "@/lib/cloudflare/d1/remote/reconcile";
import {
  createD1HttpAffectedWriter,
  createD1HttpQueryExecutor,
} from "@/lib/cloudflare/d1/remote/http-query";
import { createWranglerD1Runner } from "@/lib/cloudflare/d1/remote/runner";
import { selectD1RemoteTargets } from "@/lib/cloudflare/d1/remote/targets";
import { parseAuthTokenJson, parseWhoamiAccountId } from "./d1-copy-data";

const REPORT_PATH = path.join("artifacts", "cloudflare-m5", "d1-remote-reconcile.json");
const SOURCE_URL_ENV_VAR = "WORLDCONS_D1_SOURCE_URL";

/**
 * M5.2d remote D1 reconciliation CLI.
 *
 *   pnpm d1:reconcile --source=supabase-linked --database=worldcons_core
 *   pnpm d1:reconcile --source=supabase-linked --database=worldcons_core --apply
 *   pnpm d1:reconcile --source=supabase-linked --tables=tags,articles --json
 *   pnpm d1:reconcile --source=postgres --url=$WORLDCONS_D1_SOURCE_URL --batch-size=500
 *
 * Operator-only and dry-run by default. It reads the M5.2a canonical datasets
 * from the read-only source and reconciles the nine mutable drift tables in the
 * three relational remote `worldcons_*` databases: source-only rows as PLAIN
 * INSERTs and changed common-PK rows as full-row parameterized UPDATEs by the
 * exact primary key (PK columns excluded from SET). It never DELETEs, TRUNCATEs,
 * REPLACEs, UPSERTs/ON-CONFLICTs, applies DDL, mutates a primary key, creates or
 * deletes a database, deploys or changes production authority.
 *
 * The option surface is deliberately narrow and an implicit all-database apply is
 * impossible: `--database=` selects the exact databases (it defaults to the CLI's
 * own dry-run read scope only when the operator names it), and apply still
 * requires an explicit `--apply`.
 *
 * Credentials for the D1 HTTP writer/read fallback come from the environment ONLY
 * (`CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN`); any missing value falls back
 * to the operator's existing Wrangler session through the same runner. No token
 * or account argument is exposed and no secret is ever printed.
 */
export function argValue(args: readonly string[], name: string): string | null {
  const prefix = `--${name}=`;
  for (const arg of args) if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  return null;
}

export function positiveIntegerArg(args: readonly string[], name: string): number | null {
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
    if (!D1_REMOTE_RECONCILE_DATABASES.includes(item as D1Database)) {
      throw new Error(`database is out of reconcile scope: ${item}`);
    }
  }
  return items as D1Database[];
}

const SOURCE_KINDS = ["postgres", "supabase-linked"] as const;
type SourceKind = (typeof SOURCE_KINDS)[number];

function resolveSourceKind(args: readonly string[]): SourceKind {
  const raw = (argValue(args, "source") ?? "postgres").trim();
  if (!(SOURCE_KINDS as readonly string[]).includes(raw)) {
    throw new Error(`unknown --source=${raw} (expected ${SOURCE_KINDS.join("|")})`);
  }
  return raw as SourceKind;
}

function resolveSourceUrl(args: readonly string[]): string {
  const url = (argValue(args, "url") ?? process.env[SOURCE_URL_ENV_VAR] ?? "").trim();
  if (url.length === 0) {
    throw new Error(`postgres export requires --url= or ${SOURCE_URL_ENV_VAR}; refusing to guess a production read`);
  }
  return url;
}

function createRowSource(kind: SourceKind, args: readonly string[]): PostgresRowSource {
  if (kind === "supabase-linked") {
    return createSupabaseLinkedRowSource({
      maxStdoutBytes: positiveIntegerArg(args, "linked-max-stdout-bytes") ?? undefined,
      timeoutMs: positiveIntegerArg(args, "linked-timeout-ms") ?? undefined,
    });
  }
  return createPostgresRowSource({ connectionString: resolveSourceUrl(args) });
}

/** A 32-character hexadecimal Cloudflare account id. */
const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/i;
const ACCOUNT_ID_ENV_VAR = "CLOUDFLARE_ACCOUNT_ID";
const API_TOKEN_ENV_VAR = "CLOUDFLARE_API_TOKEN";

function nonEmptyEnv(value: string | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

export type ReconcileWriterEnv = Record<string, string | undefined>;

type ExecuteStatement = (database: D1Database, statement: D1ImportStatement) => Promise<{ changes: number }>;
type ExecuteRemoteQuery = (
  database: D1Database,
  statement: D1ImportStatement,
) => Promise<Record<string, unknown>[]>;

interface HttpCredentials {
  accountId: string;
  apiToken: string;
  databaseIds: Partial<Record<D1Database, string>>;
}

/**
 * Resolves operator-only HTTP credentials plus the exact selected database ids,
 * fail-closed. It shares the credential precedence with M5.2c: env values when
 * present, otherwise the existing Wrangler session (`whoami --json` / `auth token
 * --json`), then exactly `d1 list --json` once, classifying ONLY the selected
 * reconcile targets by exact name and failing closed unless every target is
 * exactly `existing` with a non-null entry.
 */
async function resolveHttpCredentials(options: {
  runner: WranglerD1Runner;
  databases: readonly D1Database[] | null;
  env: ReconcileWriterEnv;
}): Promise<HttpCredentials> {
  const { runner, env } = options;
  const envAccountId = nonEmptyEnv(env[ACCOUNT_ID_ENV_VAR]);
  const envApiToken = nonEmptyEnv(env[API_TOKEN_ENV_VAR]);
  const accountId = envAccountId ?? parseWhoamiAccountId(await runner(["whoami", "--json"]), null);
  const apiToken = envApiToken ?? parseAuthTokenJson(await runner(["auth", "token", "--json"]));
  if (!ACCOUNT_ID_PATTERN.test(accountId)) throw new Error("resolved account id is not a 32-character hex id");

  const entries = parseD1RemoteListJson(await runner(["d1", "list", "--json"]));
  const classifications = classifyD1RemoteTargets(
    entries,
    selectD1RemoteTargets(options.databases ?? D1_REMOTE_RECONCILE_DATABASES),
  );

  const databaseIds: Partial<Record<D1Database, string>> = {};
  for (const classification of classifications) {
    if (classification.state !== "existing" || classification.entry === null) {
      throw new Error(
        `d1 list did not resolve ${classification.target.name} to exactly one existing database (${classification.state}); refusing the HTTP surface`,
      );
    }
    databaseIds[classification.target.name] = classification.entry.uuid;
  }
  return { accountId, apiToken, databaseIds };
}

/**
 * Builds the lazy affected-writer the manifest receives in apply mode. It returns
 * `undefined` for a dry-run without reading any credential; in apply mode it
 * caches the resolved writer promise behind its first invocation, so a run with
 * many statements authenticates and lists at most once.
 */
export function createLazyAffectedWriter(options: {
  apply: boolean;
  runner: WranglerD1Runner;
  databases: readonly D1Database[] | null;
  env?: ReconcileWriterEnv;
  fetch?: typeof fetch;
}): ExecuteStatement | undefined {
  if (!options.apply) return undefined;
  const env = options.env ?? process.env;
  let writer: Promise<ExecuteStatement> | null = null;
  const load = (): Promise<ExecuteStatement> => {
    writer ??= resolveHttpCredentials({ runner: options.runner, databases: options.databases, env }).then(
      (credentials) => createD1HttpAffectedWriter({ ...credentials, fetch: options.fetch }),
    );
    return writer;
  };
  return async (database, statement) => {
    const execute = await load();
    return execute(database, statement);
  };
}

/**
 * Builds the lazy remote READ query the manifest always receives (dry-run too) so
 * the confirmed Windows Wrangler read crash can be retried through the D1 HTTP
 * API. It resolves credentials once, only on first invocation.
 */
export function createLazyRemoteQuery(options: {
  runner: WranglerD1Runner;
  databases: readonly D1Database[] | null;
  env?: ReconcileWriterEnv;
  fetch?: typeof fetch;
}): ExecuteRemoteQuery {
  const env = options.env ?? process.env;
  let executor: Promise<ExecuteRemoteQuery> | null = null;
  const load = (): Promise<ExecuteRemoteQuery> => {
    executor ??= resolveHttpCredentials({ runner: options.runner, databases: options.databases, env }).then(
      (credentials) => createD1HttpQueryExecutor({ ...credentials, fetch: options.fetch }),
    );
    return executor;
  };
  return async (database, statement) => {
    const execute = await load();
    return execute(database, statement);
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
  // No broad implicit all-database apply: an apply MUST name at least one exact
  // database through `--database=`, so a bare `--apply` can never reconcile every
  // database by default.
  if (apply && databases === null) {
    throw new Error("--apply requires an explicit --database= selection; refusing an implicit all-database apply");
  }
  const runner = createWranglerD1Runner({ timeoutMs: positiveIntegerArg(args, "timeout-ms") ?? undefined });
  try {
    const executeStatement = createLazyAffectedWriter({ apply, runner, databases });
    const executeRemoteQuery = createLazyRemoteQuery({ runner, databases });
    const manifest = await buildD1RemoteReconcileManifest({
      runner,
      source,
      apply,
      databases: databases ?? undefined,
      tables: listArg(args, "tables") ?? undefined,
      batchSize: positiveIntegerArg(args, "batch-size") ?? undefined,
      rowsPerInsertStatement: positiveIntegerArg(args, "rows-per-insert-statement") ?? undefined,
      executeStatement,
      executeRemoteQuery,
    });

    if (writeReport) {
      fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
      fs.writeFileSync(REPORT_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    }
    if (asJson) {
      process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
    } else {
      console.log(`D1 remote reconcile (${manifest.dryRun ? "dry-run" : "apply"})`);
      for (const target of manifest.targets) {
        console.log(
          `  ${target.name} [${target.binding}]: ${target.state} / ${target.action} (tables ${target.tableCount}, rows ${target.remoteRowCount}/${target.expectedRowCount}, inserted ${target.insertedRowCount}, updated ${target.updatedRowCount}, verified ${target.verified})`,
        );
        for (const table of target.tables) {
          console.log(
            `    ${table.table}: ${table.state} / ${table.action} (remote-only ${table.remoteOnlyRowCount}, insert ${table.insertRowCount}, update ${table.updateRowCount}, unchanged ${table.commonUnchangedRowCount}, insert-stmts ${table.insertStatementCount}, update-stmts ${table.updateStatementCount})`,
          );
          for (const error of table.errors) console.error(`      error: ${error}`);
        }
        for (const error of target.errors) console.error(`    error: ${error}`);
      }
      console.log(
        `totals: ${manifest.totals.databases} databases, ${manifest.totals.tables} tables, ${manifest.totals.exact} exact, ${manifest.totals.insertOnly} insert-only, ${manifest.totals.updateOnly} update-only, ${manifest.totals.mixed} mixed, ${manifest.totals.refused} refused, inserted ${manifest.totals.insertedRows}, updated ${manifest.totals.updatedRows}`,
      );
      if (writeReport) console.log(`wrote ${REPORT_PATH}`);
      for (const error of manifest.errors) console.error(`error: ${error}`);
      console.log(manifest.ok ? "D1 remote reconcile: OK" : "D1 remote reconcile: FAILED");
    }
    if (!manifest.ok) process.exitCode = 1;
  } finally {
    await source.close();
  }
}

const invokedAsEntryScript =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedAsEntryScript) {
  main().catch((error) => {
    console.error(`d1-reconcile failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
