import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  compareHeartbeatReadParity,
  heartbeatReadParityHolds,
  readOpsHeartbeatsViaHttp,
  type OpsHeartbeatHttpQueryExecutor,
} from "@/lib/cloudflare/ops-write/read-parity";
import {
  OPS_HEARTBEAT_WORKFLOW_KEYS,
  type OpsHeartbeatReadRecord,
} from "@/lib/cloudflare/ops-write/heartbeat";
import { resolveWorldconsOpsDatabaseId } from "@/scripts/ops-heartbeat-read-parity";

function record(overrides: Partial<OpsHeartbeatReadRecord> = {}): OpsHeartbeatReadRecord {
  return {
    workflowKey: "watchdog",
    lastStartedAt: "2026-09-28T01:56:23.596Z",
    lastCompletedAt: "2026-09-28T01:56:32.678Z",
    lastStatus: "success",
    runId: "36367859952",
    ...overrides,
  };
}

const ALL: OpsHeartbeatReadRecord[] = [
  record({ workflowKey: "collection", runId: "36216022066" }),
  record({ workflowKey: "summary", runId: "36216022066" }),
  record({ workflowKey: "embedding", runId: "36223085744" }),
  record({ workflowKey: "watchdog", runId: "36367859952" }),
  record({ workflowKey: "catalog_backfill", runId: "local-11948" }),
];

test("M11.3R parity holds for identical five-key sets regardless of order", () => {
  const shuffled = [...ALL].reverse();
  assert.equal(heartbeatReadParityHolds(ALL, shuffled), true);
  assert.deepEqual(compareHeartbeatReadParity(ALL, shuffled), []);
});

test("M11.3R parity compares timestamps by instant, not byte representation", () => {
  const supabase = [record({ lastStartedAt: "2026-09-28T01:56:23.596+00:00", lastCompletedAt: "2026-09-28T01:56:32.678+00:00" })];
  const d1 = [record({ lastStartedAt: "2026-09-28T01:56:23.596Z", lastCompletedAt: "2026-09-28T01:56:32.678Z" })];
  assert.equal(heartbeatReadParityHolds(supabase, d1), true);
});

test("M11.3R parity reports a missing key, a changed field and a changed run id", () => {
  const right = [
    record({ workflowKey: "collection" }),
    record({ workflowKey: "summary" }),
    // embedding missing
    record({ workflowKey: "watchdog", lastStatus: "failed" }),
    record({ workflowKey: "catalog_backfill", runId: "local-99999" }),
  ];
  const differences = compareHeartbeatReadParity(ALL, right);
  assert.ok(differences.some((entry) => entry.workflowKey === "embedding" && entry.field === "workflowKey"));
  assert.ok(differences.some((entry) => entry.workflowKey === "watchdog" && entry.field === "lastStatus"));
  assert.ok(differences.some((entry) => entry.workflowKey === "catalog_backfill" && entry.field === "runId"));
});

test("M11.3R direct D1 read is one parameterized IN query over the authored keys", async () => {
  const captured: { sql: string; params: readonly unknown[] } = { sql: "", params: [] };
  const execute: OpsHeartbeatHttpQueryExecutor = async (_database, statement) => {
    captured.sql = statement.sql;
    captured.params = statement.params;
    return [{
      workflow_key: "watchdog",
      last_started_at: "2026-09-28T01:56:23.596Z",
      last_completed_at: "2026-09-28T01:56:32.678Z",
      last_status: "success",
      run_id: "36367859952",
    }];
  };
  const records = await readOpsHeartbeatsViaHttp(execute);
  assert.match(captured.sql, /^SELECT workflow_key, last_started_at, last_completed_at, last_status, run_id FROM ops_workflow_heartbeats WHERE workflow_key IN \(\?, \?, \?, \?, \?\)/u);
  assert.doesNotMatch(captured.sql, /detail|updated_at/u);
  assert.deepEqual(captured.params, [...OPS_HEARTBEAT_WORKFLOW_KEYS]);
  assert.equal(records.length, 1);
  assert.equal(records[0].workflowKey, "watchdog");
});

test("M11.3R direct D1 read fails closed on a non-object row", async () => {
  const execute = (async () => [null]) as unknown as OpsHeartbeatHttpQueryExecutor;
  await assert.rejects(() => readOpsHeartbeatsViaHttp(execute), /ops_heartbeat_read_parity\.invalid_d1_rows/u);
});

test("M11.3R database id resolves worldcons_ops by name, not position", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "wrangler.jsonc"), "utf8");
  assert.equal(resolveWorldconsOpsDatabaseId(source), "6ecdf64b-d95a-49b2-8fc4-bdd50581a3e4");
  assert.throws(
    () => resolveWorldconsOpsDatabaseId('{ "database_name": "worldcons_core", "database_id": "0f4c41f0-778f-4ef4-860e-b0dad05f0984" }'),
    /could not resolve/u,
  );
});

test("M11.3R read-only parity remains a manual script and GitHub has no executor", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "scripts/ops-heartbeat-read-parity.ts"), "utf8");
  assert.match(source, /WORLDCONS_OPS_WRITE_TOKEN/u);
  assert.doesNotMatch(source, /GitHub Actions|OIDC mint|ACTIONS_ID_TOKEN/u);
  const workflowDir = path.join(process.cwd(), ".github/workflows");
  assert.equal(fs.existsSync(workflowDir) ? fs.readdirSync(workflowDir).length : 0, 0);
});

test("M11.3R read-parity probe script never writes a heartbeat", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "scripts/ops-heartbeat-read-parity.ts"), "utf8");
  const executable = source
    .split(/\r?\n/u)
    .filter((line) => !/^\s*(?:\/\/|\*|\/\*)/u.test(line))
    .join("\n");
  assert.doesNotMatch(executable, /recordWorkflowHeartbeat|tryRecordWorkflowHeartbeat|runWithWorkflowHeartbeats|ops:watchdog/u);
  assert.doesNotMatch(executable, /insert into|update |delete from|on conflict/iu);
});
