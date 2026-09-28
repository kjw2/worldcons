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

test("M11.4R feature-branch dispatch shell exposes a dispatch-only admin_ops_events_read_parity_only boolean", () => {
  const source = fs.readFileSync(path.join(process.cwd(), ".github/workflows/admin-watchdog.yml"), "utf8");
  assert.match(source, /^\s*admin_ops_events_read_parity_only:\s*$/mu);
  assert.match(
    source,
    /admin_ops_events_read_parity_only:[\s\S]{0,240}?type:\s*boolean[\s\S]{0,120}?default:\s*false/u,
  );
});

test("M11.4R admin_ops_events_read_parity_only skips the watchdog and runs only the read-only probe", () => {
  const source = fs.readFileSync(path.join(process.cwd(), ".github/workflows/admin-watchdog.yml"), "utf8");
  const lines = source.split(/\r?\n/u);

  const steps: { name: string; body: string[] }[] = [];
  for (const line of lines) {
    const name = /^\s*- name:\s*(.+?)\s*$/u.exec(line);
    if (name) steps.push({ name: name[1], body: [] });
    else if (steps.length > 0) steps[steps.length - 1].body.push(line);
  }

  const watchdog = steps.find((step) => step.body.some((line) => /run:\s*pnpm ops:watchdog/u.test(line)));
  assert.ok(watchdog, "the watchdog step must remain present for normal runs");
  assert.ok(
    watchdog!.body.some((line) => /if:\s*\$\{\{\s*inputs\.read_parity_only != true && inputs\.admin_ops_events_read_parity_only != true\s*\}\}/u.test(line)),
    "the watchdog step must be skipped when either read-parity-only input is true",
  );

  // There are now two steps running the admin_ops_events probe (the M11.4R
  // read-parity-only step and the M11.4 combined-window step), so select the
  // read-parity-only step by its exact guard rather than by first match.
  const probe = steps.find((step) => step.body.some((line) => /if:\s*\$\{\{\s*inputs\.admin_ops_events_read_parity_only == true\s*\}\}/u.test(line)));
  assert.ok(probe, "the read-only admin_ops_events probe step must exist in the dispatch shell");
  assert.ok(
    probe!.body.some((line) => /pnpm ops:admin-events-read-parity/u.test(line)),
    "the read-parity-only step must run the admin_ops_events probe",
  );
  assert.ok(
    probe!.body.some((line) => line.includes("pnpm ops:admin-events-read-parity -- --run --no-direct-d1 --report --json")),
    "the read_parity_only branch must run the exact read-only admin_ops_events probe command",
  );

  // The read-only branch must not broaden trust: OIDC stays id-token: write and
  // no contents/issues write appears.
  assert.doesNotMatch(source, /contents:\s*write/u);
  assert.match(source, /id-token:\s*write/u);
});

test("M11.4 combined dispatch exposes a boolean and lets one run exercise write + read", () => {
  const source = fs.readFileSync(path.join(process.cwd(), ".github/workflows/admin-watchdog.yml"), "utf8");
  assert.match(source, /^\s*admin_ops_events_combined:\s*$/mu);
  assert.match(
    source,
    /admin_ops_events_combined:[\s\S]{0,300}?type:\s*boolean[\s\S]{0,120}?default:\s*false/u,
    "the combined window input must be a boolean defaulting to false",
  );

  const lines = source.split(/\r?\n/u);
  const steps: { name: string; body: string[] }[] = [];
  for (const line of lines) {
    const name = /^\s*- name:\s*(.+?)\s*$/u.exec(line);
    if (name) steps.push({ name: name[1], body: [] });
    else if (steps.length > 0) steps[steps.length - 1].body.push(line);
  }

  // The ordinary watchdog step must STILL run in combined mode (the combined
  // window proves the write path too), i.e. the watchdog guard excludes only the
  // two read-parity-only inputs, never the combined input.
  const watchdog = steps.find((step) => step.body.some((line) => /run:\s*pnpm ops:watchdog/u.test(line)));
  assert.ok(watchdog, "the watchdog step must remain present for normal and combined runs");
  assert.ok(
    watchdog!.body.some((line) => /if:\s*\$\{\{\s*inputs\.read_parity_only != true && inputs\.admin_ops_events_read_parity_only != true\s*\}\}/u.test(line)),
    "the watchdog step must run in combined mode and only be skipped for read-parity-only modes",
  );
  assert.ok(
    !watchdog!.body.some((line) => /inputs\.admin_ops_events_combined/u.test(line)),
    "the combined input must never skip the watchdog write step",
  );

  const combined = steps.find((step) => step.name.includes("combined window, read-only"));
  assert.ok(combined, "the combined-window read-parity step must exist");
  assert.ok(
    combined!.body.some((line) => /if:\s*\$\{\{\s*inputs\.admin_ops_events_combined == true\s*\}\}/u.test(line)),
    "the combined read-parity step must run only when admin_ops_events_combined is true",
  );
  assert.ok(
    combined!.body.some((line) => line.includes("pnpm ops:admin-events-read-parity -- --run --no-direct-d1 --report --json")),
    "the combined branch must run the exact read-only admin_ops_events probe command",
  );

  // Combined mode must not broaden trust.
  assert.doesNotMatch(source, /contents:\s*write/u);
  assert.match(source, /id-token:\s*write/u);
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
