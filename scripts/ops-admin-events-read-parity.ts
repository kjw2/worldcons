import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  adminOpsEventsReadParityHolds,
  canonicalJson,
  compareAdminOpsEventsReadParity,
  readAdminOpsEventsViaHttp,
  type AdminOpsEventParityDifference,
  type AdminOpsEventsHttpQueryExecutor,
} from "@/lib/cloudflare/ops-write/admin-ops-events-read-parity";
import {
  ADMIN_OPS_EVENTS_DEFAULT_LIST_LIMIT,
  ADMIN_OPS_EVENTS_READ_AUTHORITY_ENV,
  type AdminOpsEventRecord,
} from "@/lib/cloudflare/ops-write/admin-ops-events";
import { listAdminOpsEventsViaBoundary } from "@/lib/cloudflare/ops-write/admin-ops-events-client";
import {
  OPS_HEARTBEAT_BOUNDARY_BASE_URL_ENV,
} from "@/lib/cloudflare/ops-write/boundary-client";
import { createD1HttpQueryExecutor } from "@/lib/cloudflare/d1/remote/http-query";
import { resolveWorldconsOpsDatabaseId } from "@/scripts/ops-heartbeat-read-parity";

/**
 * M11.4R live `admin_ops_events` list read-parity probe (READ-ONLY).
 *
 * Manual/local operators authenticate
 * `GET /v1/ops/admin-events/list?limit=20` on the `worldcons-ops-write`
 * boundary with `WORLDCONS_OPS_WRITE_TOKEN` and compare the returned records
 * against an independent direct D1 read of the same descending projection.
 *
 * It performs NO write of any kind: every statement is a SELECT and the only
 * network calls are the boundary GET and direct D1 read. It never
 * invokes `recordAdminOpsEvent`/`recordWatchdogEvents`, the watchdog, the
 * insert, the prune, or any heartbeat path, and it mutates no authority. It
 * prints no credential and no token, and the persisted evidence contains only
 * the compared records (with `detail` as canonical JSON), booleans and counts.
 *
 * The probe forces the admin read authority to `d1` only inside its own request
 * environment and never changes Worker authority.
 */

const REPORT_DIR = path.join("artifacts", "cloudflare-m11");
const REPORT_JSON = "m11.4r-admin-ops-events-read-parity-live-evidence.json";
const SOURCE_WRANGLER = "wrangler.jsonc";
const OPS_DATABASE_NAME = "worldcons_ops";
const ACCOUNT_ID_ENV_VAR = "CLOUDFLARE_ACCOUNT_ID";
const API_TOKEN_ENV_VAR = "CLOUDFLARE_API_TOKEN";
const LIST_LIMIT = ADMIN_OPS_EVENTS_DEFAULT_LIST_LIMIT;

function argValue(args: readonly string[], name: string): string | null {
  const prefix = `--${name}=`;
  for (const arg of args) if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  return null;
}

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function recordSnapshot(record: AdminOpsEventRecord) {
  return {
    id: record.id,
    event_type: record.event_type,
    severity: record.severity,
    source_key: record.source_key,
    summary: record.summary,
    detail: canonicalJson(record.detail),
    created_at: record.created_at,
  };
}

function differenceSummary(differences: readonly AdminOpsEventParityDifference[]) {
  return differences.map((entry) => ({
    index: entry.index,
    id: entry.id,
    field: entry.field,
    left: entry.left,
    right: entry.right,
  }));
}

function printDryRun(): void {
  console.log("WorldCons M11.4R live admin_ops_events list read parity (dry-run)");
  console.log(`  boundary: GET /v1/ops/admin-events/list?limit=${LIST_LIMIT} at $${OPS_HEARTBEAT_BOUNDARY_BASE_URL_ENV}`);
  console.log("  compares the list projection against direct D1");
  console.log("  read-only: no insert, no prune, no watchdog, no heartbeat, no authority change");
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

  // Force ONLY this probe's admin read authority to d1 so the boundary D1 list
  // read is exercised while every repository/Worker authority remains untouched.
  const probeEnvironment: Record<string, string | undefined> = {
    ...process.env,
    [ADMIN_OPS_EVENTS_READ_AUTHORITY_ENV]: "d1",
    [OPS_HEARTBEAT_BOUNDARY_BASE_URL_ENV]: baseUrl,
  };

  const boundaryRecords = await listAdminOpsEventsViaBoundary(LIST_LIMIT, { environment: probeEnvironment });
  if (boundaryRecords === null) throw new Error("admin_ops_events_read_parity.boundary_not_selected");

  let directD1Records: AdminOpsEventRecord[] | null = null;
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
        databaseIds: { [OPS_DATABASE_NAME]: databaseId },
      }) as AdminOpsEventsHttpQueryExecutor;
      directD1Records = await readAdminOpsEventsViaHttp(execute, LIST_LIMIT);
    }
  }

  const boundaryVsDirectD1 = directD1Records === null
    ? null
    : compareAdminOpsEventsReadParity(boundaryRecords, directD1Records);
  const directD1Holds = boundaryVsDirectD1 === null ? null : boundaryVsDirectD1.length === 0;
  const ok = directD1Records !== null && adminOpsEventsReadParityHolds(boundaryRecords, directD1Records);

  const evidence = {
    schemaVersion: 1,
    milestone: "M11.4R-admin-ops-events-read-parity",
    mode: "run",
    date: new Date().toISOString(),
    scope: {
      database: OPS_DATABASE_NAME,
      table: "admin_ops_events",
      kind: "list-read-authority-parity",
      limit: LIST_LIMIT,
      readOnly: true,
      insertPerformed: false,
      prunePerformed: false,
      watchdogInvoked: false,
      heartbeatWritePerformed: false,
      authorityChanged: false,
    },
    boundary: {
      path: "/v1/ops/admin-events/list",
      host: new URL(baseUrl).host,
      count: boundaryRecords.length,
      records: boundaryRecords.map(recordSnapshot),
    },
    directD1: directD1Records === null
      ? { enabled: false, error: directD1Error }
      : { enabled: true, count: directD1Records.length, records: directD1Records.map(recordSnapshot) },
    comparison: {
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
    console.log("WorldCons M11.4R live admin_ops_events list read parity (read-only)");
    console.log(`  boundary: ${evidence.boundary.count} rows`);
    console.log(`  boundary vs direct D1: ${directD1Holds === null ? "skipped" : directD1Holds ? "PARITY" : "MISMATCH"}`);
    if (writeReport) console.log(`  wrote ${path.join(REPORT_DIR, REPORT_JSON)}`);
    console.log(ok ? "M11.4R admin_ops_events list read parity: OK" : "M11.4R admin_ops_events list read parity: FAILED");
  }
  if (!ok) process.exitCode = 1;
}

const invokedAsEntryScript =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedAsEntryScript) {
  main().catch((error: unknown) => {
    console.error(`ops-admin-events-read-parity failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
