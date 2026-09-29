import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateM13FinalDeltaFromManifestFiles,
  evaluateM13FinalDeltaFromManifests,
  type M13DeltaManifestReader,
} from "@/lib/cloudflare/m13/delta-manifest-evidence";
import { deltaManifestPaths, assertDeltaEvidenceInputs } from "../scripts/m13-readiness";
import type {
  D1RemoteReconcileManifest,
  D1RemoteReconcileTableTarget,
} from "@/lib/cloudflare/d1/remote/reconcile";

type Database = "worldcons_core" | "worldcons_ingest" | "worldcons_ops";

function table(overrides: Partial<D1RemoteReconcileTableTarget> & { table: string }): D1RemoteReconcileTableTarget {
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

function manifestFor(database: Database, tables: D1RemoteReconcileTableTarget[]): D1RemoteReconcileManifest {
  return {
    version: 1,
    stage: "d1-remote-reconcile",
    dryRun: true,
    applied: false,
    commands: [],
    ok: true,
    errors: [],
    totals: {
      databases: 1, tables: tables.length, expectedRows: 0, remoteRows: 0,
      insertedRows: 0, updatedRows: 0, exact: tables.length, insertOnly: 0, updateOnly: 0, mixed: 0, refused: 0,
    },
    targets: [{
      name: database,
      binding: `WORLDCONS_${database.replace("worldcons_", "").toUpperCase()}`,
      state: "exact",
      action: "none",
      tableCount: tables.length,
      expectedRowCount: 0,
      remoteRowCount: 0,
      insertedRowCount: 0,
      updatedRowCount: 0,
      verified: true,
      errors: [],
      tables,
    }],
  };
}

function exactThree(): D1RemoteReconcileManifest[] {
  return [
    manifestFor("worldcons_core", [table({ table: "articles" })]),
    manifestFor("worldcons_ingest", [table({ table: "ingestion_runs", database: "worldcons_ingest" })]),
    manifestFor("worldcons_ops", [table({ table: "admin_ops_events", database: "worldcons_ops" })]),
  ];
}

function readerFor(files: Record<string, unknown>): M13DeltaManifestReader {
  return {
    readFile: (filePath) => {
      if (!(filePath in files)) throw new Error(`ENOENT: no such file or directory, open '${filePath}'`);
      const value = files[filePath];
      return typeof value === "string" ? value : JSON.stringify(value);
    },
  };
}

function readerForManifests(manifests: D1RemoteReconcileManifest[]): M13DeltaManifestReader {
  const files: Record<string, unknown> = {};
  manifests.forEach((manifest, index) => { files[`/evidence/manifest-${index}.json`] = manifest; });
  return readerFor(files);
}

function pathsFor(manifests: D1RemoteReconcileManifest[]): string[] {
  return manifests.map((_, index) => `/evidence/manifest-${index}.json`);
}

test("exact three-manifest PRE-SWITCH evidence evaluates deltaClear true", () => {
  const manifests = exactThree();
  const report = evaluateM13FinalDeltaFromManifestFiles(pathsFor(manifests), readerForManifests(manifests));
  assert.equal(report.deltaClear, true);
  assert.equal(report.tableCount, 3);
  assert.equal(report.exactCount, 3);
  assert.equal(report.blockers.length, 0);
  assert.deepEqual(report.databases, ["worldcons_core", "worldcons_ingest", "worldcons_ops"]);
});

test("missing target database is rejected", () => {
  const manifests = exactThree().slice(0, 2);
  const files = readerForManifests(manifests);
  assert.throws(
    () => evaluateM13FinalDeltaFromManifestFiles(["/evidence/manifest-0.json", "/evidence/manifest-1.json", "/evidence/manifest-2.json"], files),
    /could not read|missing target database/,
  );
});

test("duplicate target database is rejected", () => {
  const manifests = exactThree();
  manifests[2] = manifestFor("worldcons_core", [table({ table: "articles" })]);
  assert.throws(() => evaluateM13FinalDeltaFromManifests(manifests), /duplicate target database: worldcons_core/);
});

test("an out-of-scope extra target database is rejected", () => {
  const manifests = exactThree();
  (manifests[2] as D1RemoteReconcileManifest).targets[0].name = "worldcons_search" as Database;
  assert.throws(() => evaluateM13FinalDeltaFromManifests(manifests), /outside the M13 final-delta scope/);
});

test("an applied or non-dry-run manifest is rejected", () => {
  const applied = exactThree();
  applied[0].dryRun = false;
  applied[0].applied = true;
  assert.throws(() => evaluateM13FinalDeltaFromManifests(applied), /dryRun must be true/);

  const notDryRun = exactThree();
  notDryRun[1].dryRun = false;
  assert.throws(() => evaluateM13FinalDeltaFromManifests(notDryRun), /dryRun must be true/);
});

test("a malformed manifest (multiple targets in one file) is rejected", () => {
  const manifests = exactThree();
  manifests[0].targets.push(manifests[1].targets[0]);
  assert.throws(() => evaluateM13FinalDeltaFromManifests(manifests), /exactly one target database/);
});

test("a manifest with no tables is rejected as malformed evidence", () => {
  const manifests = exactThree();
  manifests[0].targets[0].tables = [];
  assert.throws(() => evaluateM13FinalDeltaFromManifests(manifests), /at least one reconciled table/);
});

test("a table nested under the wrong target database is rejected as structurally inconsistent", () => {
  const manifests = exactThree();
  manifests[0].targets[0].tables = [table({ table: "articles", database: "worldcons_ingest" })];
  assert.throws(() => evaluateM13FinalDeltaFromManifests(manifests), /declares database worldcons_ingest but is nested under target worldcons_core/);
});

test("a target tableCount that disagrees with its tables is rejected", () => {
  const manifests = exactThree();
  manifests[1].targets[0].tableCount = 2;
  assert.throws(() => evaluateM13FinalDeltaFromManifests(manifests), /tableCount 2 does not match its 1 table entries/);
});

test("an exact/hash-matching table with verified=false or errors cannot pass PRE-SWITCH evidence", () => {
  const unverified = exactThree();
  unverified[0].targets[0].tables = [table({ table: "articles", state: "exact", remoteHash: "hash-a", verified: false })];
  const unverifiedReport = evaluateM13FinalDeltaFromManifests(unverified);
  assert.equal(unverifiedReport.deltaClear, false);
  assert.ok(unverifiedReport.blockers.some((blocker) => blocker.code === "table_unverified"));

  const errored = exactThree();
  errored[2].targets[0].tables = [table({
    table: "admin_ops_events", database: "worldcons_ops",
    state: "exact", remoteHash: "hash-a", verified: true, errors: ["tampered"],
  })];
  const erroredReport = evaluateM13FinalDeltaFromManifests(errored);
  assert.equal(erroredReport.deltaClear, false);
  assert.ok(erroredReport.blockers.some((blocker) => blocker.code === "table_errors"));
});

test("a hash mismatch or non-exact table yields deltaClear false, never a silent pass", () => {
  const manifests = exactThree();
  manifests[0].targets[0].tables = [table({ table: "articles", remoteHash: "tampered-hash" })];
  const report = evaluateM13FinalDeltaFromManifests(manifests);
  assert.equal(report.deltaClear, false);
  assert.equal(report.exactCount, 2);
});

test("a pending insert or remote-only row in raw evidence blocks deltaClear", () => {
  const manifests = exactThree();
  manifests[1].targets[0].tables = [table({
    table: "ingestion_runs", database: "worldcons_ingest",
    state: "insert-only", action: "reconcile", insertRowCount: 2, remoteHash: null,
  })];
  const pending = evaluateM13FinalDeltaFromManifests(manifests);
  assert.equal(pending.deltaClear, false);
  assert.ok(pending.blockers.some((blocker) => blocker.code === "pending_inserts"));

  const refused = exactThree();
  refused[2].targets[0].tables = [table({
    table: "admin_ops_events", database: "worldcons_ops",
    state: "refused", action: "refused", remoteOnlyRowCount: 3, remoteHash: null, errors: ["remote-only"],
  })];
  const remoteOnly = evaluateM13FinalDeltaFromManifests(refused);
  assert.equal(remoteOnly.deltaClear, false);
  assert.ok(remoteOnly.blockers.some((blocker) => blocker.code === "remote_only_rows"));
});

test("invalid JSON and a missing file fail closed with clear errors", () => {
  const malformed = readerFor({
    "/evidence/manifest-0.json": "{ not json",
    "/evidence/manifest-1.json": {},
    "/evidence/manifest-2.json": {},
  });
  assert.throws(
    () => evaluateM13FinalDeltaFromManifestFiles(["/evidence/manifest-0.json", "/evidence/manifest-1.json", "/evidence/manifest-2.json"], malformed),
    /is not valid JSON/,
  );

  const missing = readerFor({});
  assert.throws(
    () => evaluateM13FinalDeltaFromManifestFiles(["/evidence/a.json", "/evidence/b.json", "/evidence/c.json"], missing),
    /could not read/,
  );
});

test("the loader requires exactly three manifest files", () => {
  assert.throws(() => evaluateM13FinalDeltaFromManifestFiles(["/evidence/a.json"]), /exactly 3 manifest files/);
});

test("--delta-manifests parses a comma list and rejects an empty list", () => {
  assert.deepEqual(deltaManifestPaths(["--delta-manifests=a.json,b.json,c.json"]), ["a.json", "b.json", "c.json"]);
  assert.equal(deltaManifestPaths([]), null);
  assert.throws(() => deltaManifestPaths(["--delta-manifests=,,"]), /requires a comma-separated list/);
});

test("--source together with --delta-manifests is rejected as ambiguous", () => {
  assert.throws(
    () => assertDeltaEvidenceInputs(["--source=supabase-linked", "--delta-manifests=a.json,b.json,c.json"]),
    /mutually exclusive/,
  );
  assert.doesNotThrow(() => assertDeltaEvidenceInputs(["--delta-manifests=a.json,b.json,c.json"]));
  assert.doesNotThrow(() => assertDeltaEvidenceInputs(["--source=supabase-linked"]));
});
