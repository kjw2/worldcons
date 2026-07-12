import "dotenv/config";
import path from "node:path";
import { execFileSync } from "node:child_process";
import pg, { type QueryResultRow } from "pg";
import {
  createEmptyGate0Report,
  GATE0_OUTPUT_DIRECTORY,
  GATE0_QUERIES,
  GATE0_RELEVANT_TABLES,
  GATE0_THRESHOLDS,
  GATE0_TRANSACTION_BEGIN,
  redactGate0Value,
  writeGate0Artifacts,
  type Gate0Report,
} from "@/lib/admin/gate0";

const { Client } = pg;
const SAFE_LABEL = /^[A-Za-z0-9._-]{1,64}$/;
const SAFE_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_$-]{0,127}$/;
const SAFE_STATE = /^[a-zA-Z0-9_<>.-]{1,120}$/;

interface CliOptions {
  dry: boolean;
  environment: string;
}

type LiveStage =
  | "connect"
  | "begin"
  | "verify-transaction"
  | "table-stats"
  | "state-distributions"
  | "publication-counts"
  | "job-health"
  | "indexes"
  | "constraints"
  | "commit";

type FailureCategory = "network" | "authentication" | "tls" | "timeout" | "database" | "unknown";

class Gate0LiveFailure extends Error {
  constructor(
    readonly stage: LiveStage,
    readonly category: FailureCategory,
  ) {
    super("Gate 0 live collection failed safely.");
  }
}

function failureCategory(error: unknown): FailureCategory {
  if (!error || typeof error !== "object") return "unknown";
  const code = String((error as { code?: unknown }).code ?? "").toUpperCase();
  if (["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH"].includes(code)) return "network";
  if (["ETIMEDOUT", "QUERY_READ_TIMEOUT"].includes(code)) return "timeout";
  if (["28P01", "28000"].includes(code)) return "authentication";
  if (["SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID"].includes(code)) {
    return "tls";
  }
  if (/^[0-9A-Z]{5}$/.test(code)) return "database";
  return "unknown";
}

function parseOptions(argv: string[]): CliOptions {
  let dry = false;
  let environment = process.env.GATE0_ENVIRONMENT ?? (process.env.CI ? "ci" : process.env.NODE_ENV ?? "local");

  for (const argument of argv) {
    if (argument === "--dry-run" || argument === "--no-db") {
      dry = true;
      continue;
    }
    if (argument.startsWith("--environment=")) {
      environment = argument.slice("--environment=".length);
      continue;
    }
    throw new Error("Unsupported Gate 0 argument.");
  }

  if (!SAFE_LABEL.test(environment)) throw new Error("Gate 0 environment label must use safe characters.");
  return { dry, environment };
}

function commitSha() {
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  if (!/^[a-f0-9]{40,64}$/.test(sha)) throw new Error("Gate 0 could not determine a valid commit SHA.");
  return sha;
}

function assertPostgresConnectionString(connectionString: string | undefined): asserts connectionString is string {
  if (!connectionString) throw new Error("Gate 0 requires DATABASE_URL unless --dry-run is used.");
  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error("Gate 0 requires a valid PostgreSQL DATABASE_URL.");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("Gate 0 accepts only a PostgreSQL DATABASE_URL.");
  }
}

function count(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("Gate 0 received an invalid aggregate count.");
  return parsed;
}

function catalogLabel(value: unknown) {
  if (typeof value !== "string" || !SAFE_IDENTIFIER.test(value)) return "[REDACTED]";
  if (/(?:^|_)(?:password|passwd|secret|token|credential|api_key)(?:$|_)/i.test(value)) return "[REDACTED]";
  return value;
}

function stateLabel(value: unknown) {
  if (typeof value !== "string" || !SAFE_STATE.test(value)) return "[REDACTED]";
  return redactGate0Value(value) as string;
}

function definition(value: unknown) {
  if (typeof value !== "string") return "[REDACTED]";
  return redactGate0Value(value) as string;
}

function firstRow<T extends QueryResultRow>(rows: T[], queryId: string): T {
  if (rows.length !== 1) throw new Error(`Gate 0 aggregate query ${queryId} returned an invalid shape.`);
  return rows[0];
}

async function collectLiveReport(report: Gate0Report, connectionString: string) {
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 10_000,
    query_timeout: 30_000,
    statement_timeout: 30_000,
  });
  let transactionStarted = false;
  let stage: LiveStage = "connect";

  try {
    await client.connect();
    stage = "begin";
    await client.query(GATE0_TRANSACTION_BEGIN);
    transactionStarted = true;

    stage = "verify-transaction";
    const environmentResult = await client.query(GATE0_QUERIES.environment);
    const environment = firstRow(environmentResult.rows, "environment");
    const observedIsolation = String(environment.transaction_isolation ?? "").toLowerCase();
    const observedReadOnly = String(environment.transaction_read_only ?? "").toLowerCase() === "on";
    if (observedIsolation !== "repeatable read" || !observedReadOnly) {
      throw new Error("Gate 0 transaction safety verification failed.");
    }
    report.transaction.observedIsolation = observedIsolation;
    report.transaction.observedReadOnly = observedReadOnly;
    report.transaction.verified = true;

    const postgresVersion = String(environment.server_version ?? "");
    if (!/^[0-9][0-9A-Za-z.+-]{0,63}$/.test(postgresVersion)) throw new Error("Gate 0 received an invalid PostgreSQL version.");
    report.postgres.version = postgresVersion;
    report.postgres.versionNumber = count(environment.server_version_num);

    stage = "table-stats";
    const tableStats = await client.query(GATE0_QUERIES.tableStats, [GATE0_RELEVANT_TABLES]);
    report.tableStats = tableStats.rows.map((row) => ({
      table: catalogLabel(row.table_name),
      liveRows: count(row.live_rows),
      deadRows: count(row.dead_rows),
    }));

    stage = "state-distributions";
    const stateDistributions = await client.query(GATE0_QUERIES.stateDistributions);
    report.stateDistributions = stateDistributions.rows.map((row) => ({
      table: catalogLabel(row.table_name),
      column: catalogLabel(row.column_name),
      state: stateLabel(row.state),
      count: count(row.row_count),
    }));

    stage = "publication-counts";
    const publicationResult = await client.query(GATE0_QUERIES.publicationCounts, [GATE0_THRESHOLDS.staleArticleMinutes]);
    const publication = firstRow(publicationResult.rows, "publicationCounts");
    report.publicationCounts = {
      explicitPublic: count(publication.explicit_public_count),
      legacyPublic: count(publication.legacy_public_count),
      markerTrueNonSummarized: count(publication.marker_true_non_summarized_count),
      publicMissingSummary: count(publication.public_missing_summary_count),
      malformedMarker: count(publication.malformed_marker_count),
      malformedPublicTotal: count(publication.malformed_public_total_count),
      staleSummarizing: count(publication.stale_summarizing_count),
    };

    stage = "job-health";
    const jobResult = await client.query(GATE0_QUERIES.jobHealth, [
      GATE0_THRESHOLDS.staleQueuedJobMinutes,
      GATE0_THRESHOLDS.staleCancelMinutes,
    ]);
    const jobs = firstRow(jobResult.rows, "jobHealth");
    report.jobHealth = {
      staleQueued: count(jobs.stale_queued_count),
      staleRunning: count(jobs.stale_running_count),
      cancelBacklog: count(jobs.cancel_backlog_count),
      staleCancel: count(jobs.stale_cancel_count),
      cancelledMissingTimestamp: count(jobs.cancelled_missing_timestamp_count),
      terminalMissingFinished: count(jobs.terminal_missing_finished_count),
    };

    stage = "indexes";
    const indexes = await client.query(GATE0_QUERIES.indexes, [GATE0_RELEVANT_TABLES]);
    report.indexes = indexes.rows.map((row) => ({
      schema: catalogLabel(row.schema_name),
      table: catalogLabel(row.table_name),
      name: catalogLabel(row.index_name),
      sizeBytes: count(row.size_bytes),
      definition: definition(row.definition),
    }));

    stage = "constraints";
    const constraints = await client.query(GATE0_QUERIES.constraints, [GATE0_RELEVANT_TABLES]);
    report.constraints = constraints.rows.map((row) => ({
      schema: catalogLabel(row.schema_name),
      table: catalogLabel(row.table_name),
      name: catalogLabel(row.constraint_name),
      type: catalogLabel(row.constraint_type),
      validated: row.validated === true,
      definition: definition(row.definition),
    }));

    report.anomalyCounts = {
      legacyPublic: report.publicationCounts.legacyPublic,
      malformedPublic: report.publicationCounts.malformedPublicTotal,
      staleArticles: report.publicationCounts.staleSummarizing,
      staleJobs: report.jobHealth.staleQueued + report.jobHealth.staleRunning,
      cancelBacklog: report.jobHealth.cancelBacklog,
    };

    stage = "commit";
    await client.query("COMMIT");
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) await client.query("ROLLBACK").catch(() => undefined);
    throw new Gate0LiveFailure(stage, failureCategory(error));
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const report = createEmptyGate0Report({
    commitSha: commitSha(),
    capturedAt: new Date().toISOString(),
    environment: options.environment,
    mode: options.dry ? "dry" : "live",
  });

  if (!options.dry) {
    assertPostgresConnectionString(process.env.DATABASE_URL);
    await collectLiveReport(report, process.env.DATABASE_URL);
  }

  writeGate0Artifacts(path.resolve(process.cwd(), GATE0_OUTPUT_DIRECTORY), report);
  console.log(`Gate 0 ${report.tool.mode} baseline complete.`);
  console.log(`Artifacts: ${GATE0_OUTPUT_DIRECTORY.replace(/\\/g, "/")}`);
  console.log(
    `Aggregate anomalies: legacy_public=${report.anomalyCounts.legacyPublic} malformed_public=${report.anomalyCounts.malformedPublic} stale_articles=${report.anomalyCounts.staleArticles} stale_jobs=${report.anomalyCounts.staleJobs} cancel_backlog=${report.anomalyCounts.cancelBacklog}`,
  );
}

main().catch((error) => {
  const diagnostic = error instanceof Gate0LiveFailure ? ` Stage: ${error.stage}. Category: ${error.category}.` : "";
  console.error(`Gate 0 failed safely.${diagnostic} No connection details, row data, metadata, credentials, or secrets were emitted.`);
  process.exitCode = 1;
});
