import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  compareHeartbeatReadParity,
  heartbeatReadParityHolds,
  readOpsHeartbeatsViaHttp,
  type OpsHeartbeatHttpQueryExecutor,
  type OpsHeartbeatParityDifference,
} from "@/lib/cloudflare/ops-write/read-parity";
import {
  OPS_HEARTBEAT_BOUNDARY_BASE_URL_ENV,
  OPS_HEARTBEAT_BOUNDARY_OIDC_AUDIENCE_ENV,
  OPS_HEARTBEAT_BOUNDARY_OIDC_DEFAULT_AUDIENCE,
  readOpsHeartbeatsViaBoundary,
} from "@/lib/cloudflare/ops-write/boundary-client";
import { OPS_HEARTBEAT_READ_AUTHORITY_ENV, type OpsHeartbeatReadRecord } from "@/lib/cloudflare/ops-write/heartbeat";
import { readWorkflowHeartbeatsFromSupabase } from "@/lib/ops/workflow-heartbeat";
import { createD1HttpQueryExecutor } from "@/lib/cloudflare/d1/remote/http-query";

/**
 * M11.3R live D1 read-parity probe (READ-ONLY).
 *
 * One dedicated GitHub Actions job authenticates `GET /v1/ops/heartbeats` on the
 * `worldcons-ops-write` boundary with its per-job OIDC token and compares the
 * returned five-field records against:
 *
 *   1. the authoritative Supabase projection (the resting reader), read through
 *      the service-role client with a plain SELECT; and
 *   2. an independent direct D1 read of the same projection through the D1 HTTP
 *      query API.
 *
 * It performs NO write of any kind: every statement is a SELECT and the only
 * network calls are the OIDC mint, the boundary GET and the two reads. It never
 * invokes `recordWorkflowHeartbeat` or the watchdog. It prints no credential and
 * no token, and the persisted evidence contains only the five-field records,
 * booleans and counts.
 *
 * The probe forces the read authority to `d1` ONLY inside its own request
 * environment, so it can prove the D1 read path without changing any repository
 * or Worker authority. The boundary still resolves its OWN read authority from
 * its own `env`; when that is `supabase` the boundary returns the fail-closed
 * `503 READ_AUTHORITY_UNAVAILABLE` and the probe reports the mismatch rather than
 * a false pass.
 */

const REPORT_DIR = path.join("artifacts", "cloudflare-m11");
const REPORT_JSON = "m11.3r-read-parity-live-evidence.json";
const SOURCE_WRANGLER = "wrangler.jsonc";
const OPS_DATABASE_NAME = "worldcons_ops";
const ACCOUNT_ID_ENV_VAR = "CLOUDFLARE_ACCOUNT_ID";
const API_TOKEN_ENV_VAR = "CLOUDFLARE_API_TOKEN";

function argValue(args: readonly string[], name: string): string | null {
  const prefix = `--${name}=`;
  for (const arg of args) if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  return null;
}

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** Resolves the `worldcons_ops` D1 database id from `wrangler.jsonc` by name. */
export function resolveWorldconsOpsDatabaseId(source: string): string {
  const binding = new RegExp(
    `"database_name"\\s*:\\s*"${OPS_DATABASE_NAME}"[^}]*?"database_id"\\s*:\\s*"([0-9a-f-]{36})"`,
    "isu",
  ).exec(source);
  if (!binding) throw new Error(`could not resolve the ${OPS_DATABASE_NAME} database id from ${SOURCE_WRANGLER}`);
  return binding[1];
}

function recordsByKey(records: readonly OpsHeartbeatReadRecord[]) {
  return [...records]
    .sort((left, right) => left.workflowKey.localeCompare(right.workflowKey))
    .map((record) => ({
      workflowKey: record.workflowKey,
      lastStartedAt: record.lastStartedAt,
      lastCompletedAt: record.lastCompletedAt,
      lastStatus: record.lastStatus,
      runId: record.runId,
    }));
}

function differenceSummary(differences: readonly OpsHeartbeatParityDifference[]) {
  return differences.map((entry) => ({
    workflowKey: entry.workflowKey,
    field: entry.field,
    left: entry.left,
    right: entry.right,
  }));
}

function printDryRun(): void {
  console.log("WorldCons M11.3R live D1 read parity (dry-run)");
  console.log(`  boundary: GET /v1/ops/heartbeats at $${OPS_HEARTBEAT_BOUNDARY_BASE_URL_ENV}`);
  console.log("  compares the five-field projection against Supabase and direct D1");
  console.log("  read-only: no heartbeat write, no watchdog, no authority change");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--apply")) throw new Error("--apply is unavailable: the read-parity probe is read-only");
  if (!args.includes("--run")) {
    printDryRun();
    return;
  }
  const asJson = args.includes("--json");
  const writeReport = args.includes("--report");
  const skipDirectD1 = args.includes("--no-direct-d1");

  const baseUrl = nonEmpty(argValue(args, "base-url") ?? process.env[OPS_HEARTBEAT_BOUNDARY_BASE_URL_ENV]);
  if (!baseUrl) throw new Error(`--base-url= or ${OPS_HEARTBEAT_BOUNDARY_BASE_URL_ENV} is required`);

  // Force ONLY this probe's read authority to d1 so the boundary D1 read is
  // exercised while every repository/Worker authority remains untouched.
  const probeEnvironment: Record<string, string | undefined> = {
    ...process.env,
    [OPS_HEARTBEAT_READ_AUTHORITY_ENV]: "d1",
    [OPS_HEARTBEAT_BOUNDARY_BASE_URL_ENV]: baseUrl,
    [OPS_HEARTBEAT_BOUNDARY_OIDC_AUDIENCE_ENV]:
      nonEmpty(process.env[OPS_HEARTBEAT_BOUNDARY_OIDC_AUDIENCE_ENV]) ?? OPS_HEARTBEAT_BOUNDARY_OIDC_DEFAULT_AUDIENCE,
  };

  const boundaryRecords = await readOpsHeartbeatsViaBoundary({ environment: probeEnvironment });
  if (boundaryRecords === null) throw new Error("ops_heartbeat_read_parity.boundary_not_selected");

  const supabaseRecords = await readWorkflowHeartbeatsFromSupabase();
  if (supabaseRecords === null) {
    throw new Error("ops_heartbeat_read_parity.supabase_not_configured");
  }

  let directD1Records: OpsHeartbeatReadRecord[] | null = null;
  let directD1Error: string | null = null;
  if (!skipDirectD1) {
    const accountId = nonEmpty(process.env[ACCOUNT_ID_ENV_VAR]);
    const apiToken = nonEmpty(process.env[API_TOKEN_ENV_VAR]);
    if (!accountId || !apiToken) {
      directD1Error = "direct_d1_credentials_missing";
    } else {
      const databaseId = resolveWorldconsOpsDatabaseId(fs.readFileSync(path.join(process.cwd(), SOURCE_WRANGLER), "utf8"));
      const execute = createD1HttpQueryExecutor({
        accountId,
        apiToken,
        databaseIds: { worldcons_ops: databaseId },
      }) as OpsHeartbeatHttpQueryExecutor;
      directD1Records = await readOpsHeartbeatsViaHttp(execute);
    }
  }

  const boundaryVsSupabase = compareHeartbeatReadParity(boundaryRecords, supabaseRecords);
  const boundaryVsDirectD1 = directD1Records === null
    ? null
    : compareHeartbeatReadParity(boundaryRecords, directD1Records);
  const directD1Holds = boundaryVsDirectD1 === null ? null : boundaryVsDirectD1.length === 0;
  const ok = heartbeatReadParityHolds(boundaryRecords, supabaseRecords) && directD1Holds !== false;

  const evidence = {
    schemaVersion: 1,
    milestone: "M11.3R-read-parity",
    mode: "run",
    date: new Date().toISOString(),
    scope: {
      database: OPS_DATABASE_NAME,
      table: "ops_workflow_heartbeats",
      kind: "read-authority-parity",
      readOnly: true,
      heartbeatWritePerformed: false,
      watchdogInvoked: false,
      authorityChanged: false,
    },
    boundary: {
      path: "/v1/ops/heartbeats",
      host: new URL(baseUrl).host,
      count: boundaryRecords.length,
      records: recordsByKey(boundaryRecords),
    },
    supabase: {
      count: supabaseRecords.length,
      records: recordsByKey(supabaseRecords),
    },
    directD1: directD1Records === null
      ? { enabled: false, error: directD1Error }
      : { enabled: true, count: directD1Records.length, records: recordsByKey(directD1Records) },
    comparison: {
      boundaryVsSupabase: {
        holds: boundaryVsSupabase.length === 0,
        differences: differenceSummary(boundaryVsSupabase),
      },
      boundaryVsDirectD1: boundaryVsDirectD1 === null
        ? null
        : { holds: boundaryVsDirectD1.length === 0, differences: differenceSummary(boundaryVsDirectD1) },
    },
    ok,
  };

  if (writeReport) {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    fs.writeFileSync(path.join(REPORT_DIR, REPORT_JSON), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  }
  if (asJson) process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  else {
    console.log("WorldCons M11.3R live D1 read parity (read-only)");
    console.log(`  boundary: ${evidence.boundary.count} rows; supabase: ${evidence.supabase.count} rows`);
    console.log(`  boundary vs supabase: ${evidence.comparison.boundaryVsSupabase.holds ? "PARITY" : `${evidence.comparison.boundaryVsSupabase.differences.length} difference(s)`}`);
    console.log(`  boundary vs direct D1: ${directD1Holds === null ? "skipped" : directD1Holds ? "PARITY" : "MISMATCH"}`);
    if (writeReport) console.log(`  wrote ${path.join(REPORT_DIR, REPORT_JSON)}`);
    console.log(ok ? "M11.3R read parity: OK" : "M11.3R read parity: FAILED");
  }
  if (!ok) process.exitCode = 1;
}

const invokedAsEntryScript =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedAsEntryScript) {
  main().catch((error: unknown) => {
    console.error(`ops-heartbeat-read-parity failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
