import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  ADMIN_OPS_EVENTS_READ_COLUMNS,
  adminOpsEventsReadParityHolds,
  canonicalJson,
  compareAdminOpsEventsReadParity,
  readAdminOpsEventsViaHttp,
  type AdminOpsEventsHttpQueryExecutor,
} from "@/lib/cloudflare/ops-write/admin-ops-events-read-parity";
import {
  ADMIN_OPS_EVENTS_MAX_LIST_LIMIT,
  type AdminOpsEventRecord,
} from "@/lib/cloudflare/ops-write/admin-ops-events";

function record(overrides: Partial<AdminOpsEventRecord> = {}): AdminOpsEventRecord {
  return {
    id: "evt-1",
    event_type: "watchdog_ok",
    severity: "info",
    source_key: null,
    summary: "수집 운영이 정상입니다.",
    detail: { signature: "ok", generatedAt: "2026-09-28T12:00:00.000Z" },
    created_at: "2026-09-28T12:00:00.000Z",
    ...overrides,
  };
}

const ALL: AdminOpsEventRecord[] = [
  record({ id: "evt-3", created_at: "2026-09-28T12:02:00.000Z", event_type: "watchdog_violation", severity: "warning" }),
  record({ id: "evt-2", created_at: "2026-09-28T12:01:00.000Z", source_key: "de-bverfg" }),
  record({ id: "evt-1", created_at: "2026-09-28T12:00:00.000Z" }),
];

test("M11.4R list parity holds for identical ordered projections", () => {
  assert.equal(adminOpsEventsReadParityHolds(ALL, [...ALL]), true);
  assert.deepEqual(compareAdminOpsEventsReadParity(ALL, [...ALL]), []);
});

test("M11.4R list parity is order-aware and reports a reordering", () => {
  const reordered = [...ALL].reverse();
  const differences = compareAdminOpsEventsReadParity(ALL, reordered);
  assert.ok(differences.length > 0, "a reordered list is a difference");
  assert.ok(differences.every((entry) => entry.field === "id" || entry.id !== null));
});

test("M11.4R list parity compares detail as canonical JSON regardless of key order", () => {
  const left = [record({ id: "evt-1", detail: { signature: "ok", nested: { b: 2, a: 1 } } })];
  const right = [record({ id: "evt-1", detail: { nested: { a: 1, b: 2 }, signature: "ok" } })];
  assert.equal(adminOpsEventsReadParityHolds(left, right), true);
});

test("M11.4R list parity compares timestamps by instant, not byte representation", () => {
  const supabase = [record({ id: "evt-1", created_at: "2026-09-28T12:00:00.000+00:00" })];
  const d1 = [record({ id: "evt-1", created_at: "2026-09-28T12:00:00.000Z" })];
  assert.equal(adminOpsEventsReadParityHolds(supabase, d1), true);
});

test("M11.4R list parity reports a changed field, a missing row and a differing length", () => {
  const right = [
    record({ id: "evt-3", created_at: "2026-09-28T12:02:00.000Z", event_type: "watchdog_violation", severity: "critical" }),
    record({ id: "evt-2", created_at: "2026-09-28T12:01:00.000Z", source_key: "de-bverfg" }),
    // evt-1 missing
  ];
  const differences = compareAdminOpsEventsReadParity(ALL, right);
  assert.ok(!differences.some((entry) => entry.id === "evt-2"), "an unchanged row must not be reported");
  assert.ok(differences.some((entry) => entry.id === "evt-3" && entry.field === "severity"));
  assert.ok(differences.some((entry) => entry.index === 2 && entry.field === "id"));
});

test("M11.4R canonical JSON sorts object keys recursively and keeps array order", () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(canonicalJson({ z: { d: 4, c: 3 }, a: [2, 1] }), '{"a":[2,1],"z":{"c":3,"d":4}}');
});

test("M11.4R direct D1 list read is one parameterized descending projection", async () => {
  const captured: { sql: string; params: readonly unknown[] } = { sql: "", params: [] };
  const execute: AdminOpsEventsHttpQueryExecutor = async (_database, statement) => {
    captured.sql = statement.sql;
    captured.params = statement.params;
    return [{
      id: "evt-1",
      event_type: "watchdog_ok",
      severity: "info",
      source_key: null,
      summary: "ok",
      detail: "{\"signature\":\"ok\"}",
      created_at: "2026-09-28T12:00:00.000Z",
    }];
  };
  const records = await readAdminOpsEventsViaHttp(execute, 20);
  assert.match(
    captured.sql,
    new RegExp(`^SELECT ${ADMIN_OPS_EVENTS_READ_COLUMNS} FROM admin_ops_events ORDER BY created_at DESC LIMIT \\?`, "u"),
  );
  assert.doesNotMatch(captured.sql, /insert|update|delete|prune/iu);
  assert.deepEqual(captured.params, [20]);
  assert.equal(records.length, 1);
  assert.equal(records[0].id, "evt-1");
  // A D1 TEXT `detail` is parsed back into the record's canonical object.
  assert.deepEqual(records[0].detail, { signature: "ok" });
});

test("M11.4R direct D1 list read fails closed on an invalid limit or a non-object row", async () => {
  const execute = (async () => [null]) as unknown as AdminOpsEventsHttpQueryExecutor;
  await assert.rejects(() => readAdminOpsEventsViaHttp(execute, 0), /admin_ops_events_read_parity\.invalid_limit/u);
  await assert.rejects(
    () => readAdminOpsEventsViaHttp(execute, ADMIN_OPS_EVENTS_MAX_LIST_LIMIT + 1),
    /admin_ops_events_read_parity\.invalid_limit/u,
  );
  await assert.rejects(() => readAdminOpsEventsViaHttp(execute, 20), /admin_ops_events_read_parity\.invalid_d1_rows/u);
});

test("M11.4R admin ops read parity remains a manual bearer-authenticated script", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "scripts/ops-admin-events-read-parity.ts"), "utf8");
  assert.match(source, /WORLDCONS_OPS_WRITE_TOKEN/u);
  assert.doesNotMatch(source, /GitHub Actions|OIDC mint|ACTIONS_ID_TOKEN/u);
  const workflowDir = path.join(process.cwd(), ".github/workflows");
  assert.equal(fs.existsSync(workflowDir) ? fs.readdirSync(workflowDir).length : 0, 0);
});

test("M11.4R admin_ops_events read-parity probe script never writes an admin event or heartbeat", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "scripts/ops-admin-events-read-parity.ts"), "utf8");
  const executable = source
    .split(/\r?\n/u)
    .filter((line) => !/^\s*(?:\/\/|\*|\/\*)/u.test(line))
    .join("\n");
  assert.doesNotMatch(
    executable,
    /recordAdminOpsEvent|recordWatchdogEvents|recordWorkflowHeartbeat|tryRecordWorkflowHeartbeat|runWithWorkflowHeartbeats|ops:watchdog/u,
  );
  assert.doesNotMatch(executable, /insertAdminOpsEventToD1|pruneAdminOpsEventsInD1|insert into|update |delete from|on conflict/iu);
});
