import assert from "node:assert/strict";
import test from "node:test";
import {
  M13_FINAL_DELTA_DATABASES,
  buildM13FinalDeltaManifest,
  evaluateM13FinalDelta,
} from "@/lib/cloudflare/m13/final-delta";
import type { D1RemoteReconcileManifest } from "@/lib/cloudflare/d1/remote/reconcile";
import type { PostgresRowSource } from "@/lib/cloudflare/d1/convert";

type TableTarget = D1RemoteReconcileManifest["targets"][number]["tables"][number];

function table(overrides: Partial<TableTarget> & { table: string }): TableTarget {
  return {
    database: "worldcons_core",
    sourceTable: overrides.table,
    state: "exact",
    action: "none",
    expectedRowCount: 1,
    expectedHash: "hash-a",
    remoteRowCount: 1,
    remoteHash: "hash-a",
    insertRowCount: 0,
    updateRowCount: 0,
    remoteOnlyRowCount: 0,
    commonUnchangedRowCount: 1,
    insertStatementCount: 0,
    updateStatementCount: 0,
    verified: true,
    errors: [],
    ...overrides,
  };
}

function manifest(tables: TableTarget[], ok = true): D1RemoteReconcileManifest {
  const byDatabase = new Map<string, TableTarget[]>();
  for (const entry of tables) {
    const list = byDatabase.get(entry.database) ?? [];
    list.push(entry);
    byDatabase.set(entry.database, list);
  }
  return {
    version: 1,
    stage: "d1-remote-reconcile",
    dryRun: true,
    applied: false,
    commands: [],
    ok,
    errors: ok ? [] : ["fake"],
    totals: {
      databases: byDatabase.size, tables: tables.length, expectedRows: 0, remoteRows: 0,
      insertedRows: 0, updatedRows: 0, exact: 0, insertOnly: 0, updateOnly: 0, mixed: 0, refused: 0,
    },
    targets: [...byDatabase.entries()].map(([name, list]) => ({
      name: name as D1RemoteReconcileManifest["targets"][number]["name"],
      binding: "WORLDCONS_CORE",
      state: "exact",
      action: "none",
      tableCount: list.length,
      expectedRowCount: 0,
      remoteRowCount: 0,
      insertedRowCount: 0,
      updatedRowCount: 0,
      verified: true,
      errors: [],
      tables: list,
    })),
  };
}

test("M13 final delta is clear only when every table is exact with a matching canonical hash", () => {
  const report = evaluateM13FinalDelta(manifest([
    table({ table: "articles" }),
    table({ table: "ingestion_runs", database: "worldcons_ingest" }),
    table({ table: "admin_ops_events", database: "worldcons_ops" }),
  ]));
  assert.equal(report.deltaClear, true);
  assert.equal(report.exactCount, 3);
  assert.equal(report.remoteOnlyTotal, 0);
  assert.equal(report.blockers.length, 0);
  assert.deepEqual(report.databases, M13_FINAL_DELTA_DATABASES);
});

test("M13 final delta reports pending inserts and updates as blockers, never a pass", () => {
  const report = evaluateM13FinalDelta(manifest([
    table({ table: "articles", state: "insert-only", action: "reconcile", insertRowCount: 2, remoteHash: null }),
  ]));
  assert.equal(report.deltaClear, false);
  assert.equal(report.pendingInsertTotal, 2);
  assert.ok(report.blockers.some((blocker) => blocker.code === "pending_inserts"));
});

test("M13 final delta refuses any remote-only row (never a delete)", () => {
  const report = evaluateM13FinalDelta(manifest([
    table({ table: "tags", state: "refused", action: "refused", remoteOnlyRowCount: 3, remoteHash: null, errors: ["remote-only"] }),
  ]));
  assert.equal(report.deltaClear, false);
  assert.equal(report.remoteOnlyTotal, 3);
  assert.ok(report.blockers.some((blocker) => blocker.code === "remote_only_rows"));
  assert.ok(report.blockers.some((blocker) => blocker.code === "table_refused"));
});

test("M13 final delta treats an unknown/unverified table as a blocker", () => {
  const report = evaluateM13FinalDelta(manifest([
    table({ table: "articles", state: "unknown", action: "refused", remoteHash: null, errors: ["read failed"] }),
  ]));
  assert.equal(report.deltaClear, false);
  assert.ok(report.blockers.some((blocker) => blocker.code === "table_unknown"));
});

test("M13 final delta fails closed on an exact/hash-matching table with verified=false", () => {
  const report = evaluateM13FinalDelta(manifest([
    table({ table: "articles", state: "exact", remoteHash: "hash-a", verified: false }),
  ]));
  assert.equal(report.deltaClear, false);
  assert.equal(report.exactCount, 0);
  assert.ok(report.blockers.some((blocker) => blocker.code === "table_unverified"));
});

test("M13 final delta fails closed on an exact/hash-matching table with non-empty errors", () => {
  const report = evaluateM13FinalDelta(manifest([
    table({ table: "articles", state: "exact", remoteHash: "hash-a", verified: true, errors: ["post-read drift"] }),
  ]));
  assert.equal(report.deltaClear, false);
  assert.ok(report.blockers.some((blocker) => blocker.code === "table_errors"));
});

test("M13 final delta is not clear on an empty or unconfigured source", () => {
  const empty = evaluateM13FinalDelta(manifest([]));
  assert.equal(empty.deltaClear, false);
  const unconfigured = evaluateM13FinalDelta(manifest([], false));
  assert.equal(unconfigured.deltaClear, false);
  assert.ok(unconfigured.blockers.some((blocker) => blocker.code === "postgres_source_unconfigured"));
});

test("buildM13FinalDeltaManifest forces apply off and stays read-only", async () => {
  const source: PostgresRowSource = {
    isConfigured: () => false,
    readRows: async () => [],
    close: async () => {},
  };
  const { manifest: built, report } = await buildM13FinalDeltaManifest({
    source,
    runner: async () => "",
  });
  assert.equal(built.dryRun, true);
  assert.equal(built.applied, false);
  assert.equal(report.dryRun, true);
  assert.equal(report.deltaClear, false, "an unconfigured read-only source can never be a silent pass");
});
