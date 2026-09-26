import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { createSupabaseLinkedQueryRunner } from "@/lib/cloudflare/d1/convert/supabase-linked-source";
import { createWranglerD1Runner } from "@/lib/cloudflare/d1/remote/runner";
import {
  CLOUDFLARE_ACCOUNT_ID_ENV,
  CLOUDFLARE_API_TOKEN_ENV,
  parseWranglerSearchDatabaseId,
  requireAccountId,
  requireApiToken,
  resolveSearchD1Target,
} from "@/lib/cloudflare/search-materialize/cloudflare";
import {
  assertD1SnapshotShape,
  buildD1RestoreStatements,
  createD1RestClient,
  d1DocumentStateHash,
  executeD1Statements,
  readD1CurrentState,
} from "@/lib/cloudflare/search-materialize/d1";
import { runSearchMaterialization } from "@/lib/cloudflare/search-materialize/materialize";
import {
  SEARCH_MATERIALIZE_D1_DATABASE,
  SEARCH_MATERIALIZE_D1_BATCH_SIZE,
  SEARCH_MATERIALIZE_VECTOR_INDEX,
  type SearchMaterializationGates,
} from "@/lib/cloudflare/search-materialize/types";
import { createVectorizeRestClient } from "@/lib/cloudflare/search-materialize/vectorize";
import { parseAuthTokenJson, parseWhoamiAccountId } from "./d1-copy-data";

/**
 * M7.5 remote search materialization operator CLI.
 *
 *   pnpm d1:search-materialize                      # dry-run (default, no write)
 *   pnpm d1:search-materialize --json
 *   pnpm d1:search-materialize --apply-d1 --confirm-search-db=worldcons_search
 *   pnpm d1:search-materialize --apply-vector --confirm-vector-index=worldcons-search
 *   pnpm d1:search-materialize --apply-vector --provision-vector-index --confirm-vector-index=worldcons-search
 *   pnpm d1:search-materialize --rollback-d1=artifacts/.../snapshot.json --confirm-search-db=worldcons_search
 *
 * Operator-only and dry-run by default. Supabase remains the sole search
 * authority. There is no deploy flag and no binding flag; D1 and Vectorize are
 * gated by independent explicit confirmation pairs. A bare `--apply` is refused.
 */
const REPORT_PATH = path.join("artifacts", "cloudflare-m7", "d1-search-materialize-report.json");
const SNAPSHOT_PATH = path.join("artifacts", "cloudflare-m7", "d1-search-materialize-snapshot.json");
const WRANGLER_CONFIG = "wrangler.jsonc";

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

function readWranglerExpectedUuid(): string | null {
  const file = path.resolve(WRANGLER_CONFIG);
  if (!fs.existsSync(file)) return null;
  return parseWranglerSearchDatabaseId(fs.readFileSync(file, "utf8"));
}

function assertNoUnsupportedFlags(args: readonly string[]): void {
  const forbidden = args.filter(
    (arg) => arg === "--apply" || arg.startsWith("--deploy") || arg.startsWith("--binding"),
  );
  if (forbidden.length > 0) {
    throw new Error(`unsupported flag refused (no deploy, no binding, no bare apply): ${forbidden.join(", ")}`);
  }
}

function parseGates(args: readonly string[]): SearchMaterializationGates {
  const applyD1 = args.includes("--apply-d1");
  const applyVector = args.includes("--apply-vector");
  const provisionVectorIndex = args.includes("--provision-vector-index");
  const confirmSearchDb = argValue(args, "confirm-search-db");
  const confirmVectorIndex = argValue(args, "confirm-vector-index");
  if (applyD1 && confirmSearchDb !== SEARCH_MATERIALIZE_D1_DATABASE) {
    throw new Error(`--apply-d1 requires --confirm-search-db=${SEARCH_MATERIALIZE_D1_DATABASE}`);
  }
  if (applyVector && confirmVectorIndex !== SEARCH_MATERIALIZE_VECTOR_INDEX) {
    throw new Error(`--apply-vector requires --confirm-vector-index=${SEARCH_MATERIALIZE_VECTOR_INDEX}`);
  }
  if (provisionVectorIndex && !applyVector) {
    throw new Error("--provision-vector-index requires --apply-vector");
  }
  if (args.includes("--rollback-d1") || argValue(args, "rollback-d1") !== null) {
    throw new Error("--rollback-d1 cannot be combined with a materialization run");
  }
  return { applyD1, confirmSearchDb, applyVector, provisionVectorIndex, confirmVectorIndex };
}

async function resolveCredentials(runner: ReturnType<typeof createWranglerD1Runner>) {
  const env = process.env;
  const envAccountId = (env[CLOUDFLARE_ACCOUNT_ID_ENV] ?? "").trim();
  const envApiToken = (env[CLOUDFLARE_API_TOKEN_ENV] ?? "").trim();
  // The Wrangler session is consulted only when the environment omits a value,
  // so a fully credentialed run performs no whoami/auth-token call.
  const accountId = envAccountId.length > 0
    ? requireAccountId(envAccountId, envAccountId)
    : requireAccountId(undefined, parseWhoamiAccountId(await runner(["whoami", "--json"]), null));
  const apiToken = envApiToken.length > 0
    ? requireApiToken(envApiToken, envApiToken)
    : requireApiToken(undefined, parseAuthTokenJson(await runner(["auth", "token", "--json"])));
  return { accountId, apiToken };
}

async function runRollback(args: readonly string[]): Promise<void> {
  const snapshotFile = argValue(args, "rollback-d1");
  if (snapshotFile === null || snapshotFile.trim().length === 0) throw new Error("--rollback-d1 requires a snapshot path");
  if (argValue(args, "confirm-search-db") !== SEARCH_MATERIALIZE_D1_DATABASE) {
    throw new Error(`--rollback-d1 requires --confirm-search-db=${SEARCH_MATERIALIZE_D1_DATABASE}`);
  }
  const snapshot = assertD1SnapshotShape(JSON.parse(fs.readFileSync(snapshotFile, "utf8")) as unknown);
  const runner = createWranglerD1Runner({ timeoutMs: positiveIntegerArg(args, "timeout-ms") ?? undefined });
  const credentials = await resolveCredentials(runner);
  const target = await resolveSearchD1Target({ runner, expectedUuid: readWranglerExpectedUuid() });
  const client = createD1RestClient({ ...credentials, databaseId: target.uuid });
  const statements = buildD1RestoreStatements(snapshot);
  await executeD1Statements(client.batch, statements, positiveIntegerArg(args, "d1-batch-size") ?? SEARCH_MATERIALIZE_D1_BATCH_SIZE);
  const current = await readD1CurrentState(client.query);
  if (args.includes("--json")) {
    process.stdout.write(
      `${JSON.stringify(
        {
          stage: "d1-search-materialize-rollback",
          database: SEARCH_MATERIALIZE_D1_DATABASE,
          restoredDocuments: snapshot.documents.length,
          restoredFts: snapshot.fts.length,
          current: {
            documentCount: current.documentCount,
            ftsCount: current.ftsCount,
            documentChecksumHash: d1DocumentStateHash(current.documents),
          },
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  console.log(`D1 search materialize rollback (${snapshotFile})`);
  console.log(`  restored documents ${snapshot.documents.length}, fts ${snapshot.fts.length}`);
  console.log(`  current documents ${current.documentCount}, fts ${current.ftsCount}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  assertNoUnsupportedFlags(args);
  if (args.includes("--rollback-d1") || argValue(args, "rollback-d1") !== null) {
    if (args.includes("--apply-d1") || args.includes("--apply-vector") || args.includes("--provision-vector-index")) {
      throw new Error("--rollback-d1 cannot be combined with an apply/provision run");
    }
    await runRollback(args);
    return;
  }

  const source = argValue(args, "source");
  if (source !== null && source !== "supabase-linked") {
    throw new Error(`unknown --source=${source} (expected supabase-linked)`);
  }
  const gates = parseGates(args);
  const asJson = args.includes("--json");
  const writeReport = args.includes("--report");

  const linked = createSupabaseLinkedQueryRunner({
    maxStdoutBytes: positiveIntegerArg(args, "linked-max-stdout-bytes") ?? undefined,
    timeoutMs: positiveIntegerArg(args, "linked-timeout-ms") ?? undefined,
  });
  const runner = createWranglerD1Runner({ timeoutMs: positiveIntegerArg(args, "timeout-ms") ?? undefined });
  const credentials = await resolveCredentials(runner);
  const target = await resolveSearchD1Target({ runner, expectedUuid: readWranglerExpectedUuid() });
  const d1Client = createD1RestClient({
    ...credentials,
    databaseId: target.uuid,
    timeoutMs: positiveIntegerArg(args, "d1-timeout-ms") ?? undefined,
  });
  const vectorizeClient = createVectorizeRestClient({
    ...credentials,
    timeoutMs: positiveIntegerArg(args, "vector-timeout-ms") ?? undefined,
  });

  const relationsPageSize = positiveIntegerArg(args, "relations-page-size") ?? undefined;
  const relationsMaxRows = positiveIntegerArg(args, "relations-max-rows") ?? undefined;
  const snapshotPath = argValue(args, "snapshot") ?? SNAPSHOT_PATH;

  const { report } = await runSearchMaterialization({
    source: {
      runner: linked,
      pageSize: {
        versions: positiveIntegerArg(args, "versions-page-size") ?? undefined,
        artifacts: positiveIntegerArg(args, "artifacts-page-size") ?? undefined,
        publications: relationsPageSize,
        articles: relationsPageSize,
        tags: relationsPageSize,
        articleTags: relationsPageSize,
      },
      maxRows: {
        versions: positiveIntegerArg(args, "versions-max-rows") ?? undefined,
        artifacts: positiveIntegerArg(args, "artifacts-max-rows") ?? undefined,
        publications: relationsMaxRows,
        articles: relationsMaxRows,
        tags: relationsMaxRows,
        articleTags: relationsMaxRows,
      },
      maxStdoutBytes: positiveIntegerArg(args, "linked-max-stdout-bytes") ?? undefined,
      timeoutMs: positiveIntegerArg(args, "linked-timeout-ms") ?? undefined,
    },
    gates,
    d1: {
      query: d1Client.query,
      batch: gates.applyD1 ? d1Client.batch : undefined,
      batchSize: positiveIntegerArg(args, "d1-batch-size") ?? undefined,
      snapshotPath,
      writeSnapshot: gates.applyD1
        ? (snapshot, file) => {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, `${JSON.stringify(snapshot)}\n`, "utf8");
          }
        : undefined,
    },
    // The Vectorize client is always provided so a dry-run can report the exact
    // preflight state (including `needs_provision`); it only mutates when the
    // `--apply-vector` gate pair is present.
    vectorize: {
      client: vectorizeClient,
      upsertBatchSize: positiveIntegerArg(args, "vector-upsert-batch-size") ?? undefined,
      deleteBatchSize: positiveIntegerArg(args, "vector-delete-batch-size") ?? undefined,
      mutationTimeoutMs: positiveIntegerArg(args, "vector-mutation-timeout-ms") ?? undefined,
    },
  });

  if (writeReport) {
    fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
    fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  if (asJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    console.log(`WorldCons D1 search materialize (${report.dryRun ? "dry-run" : "apply"})`);
    console.log(
      `  source: published ${report.source.publishedCount}, fingerprint ${report.source.fingerprint}, pages ${report.source.pageCount}`,
    );
    console.log(
      `  desired: search ${report.desired.search.documentCount} hash ${report.desired.search.hash}, vector ${report.desired.vector.recordCount} hash ${report.desired.vector.hash} (missing ${report.omissions.missingCount}, stale ${report.omissions.staleCount})`,
    );
    console.log(
      `  d1: state ${report.d1.state}, current ${report.d1.current.documentCount} docs / ${report.d1.current.ftsCount} fts, desired ${report.d1.desired.documentCount} / ${report.d1.desired.ftsCount}, statements ${report.d1.plan?.statementCount ?? 0} in ${report.d1.plan?.batchCount ?? 0} batches, verified ${report.d1.verified}`,
    );
    console.log(
      `  vector: state ${report.vector.state}, current ${report.vector.current.idCount} ids, desired ${report.vector.desired.recordCount}, upserts ${report.vector.plan?.upsertCount ?? 0}, deletes ${report.vector.plan?.deleteCount ?? 0}, verified ${report.vector.verified}`,
    );
    console.log(`  blocked by: ${report.blockedBy.join(", ")}`);
    if (writeReport) console.log(`  wrote ${REPORT_PATH}`);
    for (const error of report.errors) console.error(`  error: ${error}`);
    for (const error of report.d1.errors) console.error(`  d1 error: ${error}`);
    for (const error of report.vector.errors) console.error(`  vector error: ${error}`);
    console.log(report.ok ? "D1 search materialize: OK" : "D1 search materialize: FAILED");
  }
  if (!report.ok) process.exitCode = 1;
}

const invokedAsEntryScript =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedAsEntryScript) {
  main().catch((error) => {
    console.error(`d1-search-materialize failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
