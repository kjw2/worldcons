import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  buildTable,
  type D1Database,
  type D1Schema,
} from "../lib/cloudflare/d1";
import {
  toCanonicalTableDataset,
  type PostgresReadRequest,
  type PostgresRowSource,
} from "../lib/cloudflare/d1/convert";
import type { D1ImportStatement } from "../lib/cloudflare/d1/import/types";
import { WranglerD1ExitError, type WranglerD1Runner } from "../lib/cloudflare/d1/remote";
import {
  buildD1RemoteReconcileManifest,
  D1_REMOTE_RECONCILE_DATABASES,
  D1_REMOTE_RECONCILE_DEFAULT_BATCH_SIZE,
} from "../lib/cloudflare/d1/remote/reconcile";

/**
 * M5.2d reconcile tests. The harness models the D1 HTTP affected-writer and the
 * Wrangler read surface against an in-memory store of canonical rows, so every
 * safety property of the reconcile seam can be proven without a network.
 */

const probeTable = buildTable({
  name: "reconcile_probe",
  database: "worldcons_core",
  primaryKey: ["id"],
  columns: [
    { name: "id", type: "text", nn: true },
    { name: "body", type: "text" },
    { name: "rank", type: "integer" },
  ],
});

const schema: D1Schema = { version: 1, databases: ["worldcons_core"], tables: [probeTable], ownership: [] };

const SOURCE_ROWS: Record<string, unknown>[] = [
  { id: "a", body: "A", rank: 1 },
  { id: "b", body: "B", rank: 2 },
  { id: "c", body: "C", rank: 3 },
  { id: "d", body: "D", rank: 4 },
];

/** Canonical rows are idempotent under re-canonicalization, so a store of them is a faithful remote. */
const FULL_ROWS = toCanonicalTableDataset(probeTable, SOURCE_ROWS).rows;

const compositeTable = buildTable({
  name: "reconcile_composite",
  database: "worldcons_core",
  primaryKey: ["tenant", "id"],
  columns: [
    { name: "tenant", type: "text", nn: true },
    { name: "id", type: "text", nn: true },
    { name: "value", type: "text" },
  ],
});

const compositeSchema: D1Schema = {
  version: 1,
  databases: ["worldcons_core"],
  tables: [compositeTable],
  ownership: [],
};

const richTable = buildTable({
  name: "reconcile_rich",
  database: "worldcons_core",
  primaryKey: ["id"],
  columns: [
    { name: "id", type: "text", nn: true },
    { name: "payload", type: "jsonb" },
    { name: "labels", type: "text[]" },
    { name: "bignum", type: "bigint" },
    { name: "active", type: "boolean" },
    { name: "created", type: "timestamptz" },
  ],
});

const richSchema: D1Schema = { version: 1, databases: ["worldcons_core"], tables: [richTable], ownership: [] };

function createFakeSource(rowsByTable: Record<string, Record<string, unknown>[]>): PostgresRowSource {
  return {
    isConfigured: () => true,
    readRows: async (request: PostgresReadRequest) => {
      const rows = rowsByTable[request.relation] ?? [];
      const limit = request.limit ?? rows.length;
      return rows.slice(request.offset, request.offset + limit).map((row) => ({ ...row }));
    },
    close: async () => {},
  };
}

type StoreRow = Record<string, unknown>;

interface AffectedCall {
  database: D1Database;
  statement: D1ImportStatement;
}

interface QueryCall {
  database: D1Database;
  statement: D1ImportStatement;
}

interface HarnessOptions {
  /** Report a wrong affected-row count from every write. */
  affectedDelta?: number;
  /** Make the affected writer reject. */
  writeThrows?: boolean;
  /** Corrupt a stored value after all writes, just before the final read. */
  tamperFinal?: boolean;
  malformedReadJson?: boolean;
  readError?: Error;
  crashReads?: boolean;
  queryThrows?: boolean;
}

interface ReconcileHarness {
  runner: WranglerD1Runner;
  calls: string[][];
  affectedCalls: AffectedCall[];
  queryCalls: QueryCall[];
  executeStatement: (database: D1Database, statement: D1ImportStatement) => Promise<{ changes: number }>;
  executeRemoteQuery: (
    database: D1Database,
    statement: D1ImportStatement,
  ) => Promise<Record<string, unknown>[]>;
  remoteRows: (table: string) => StoreRow[];
}

/**
 * Binds a parameterized `insert into t (cols) values (?, ...), ...;` or
 * `update t set c = ?, ... where k = ?;` against the in-memory store. It never
 * renders SQL literals, so a huge or unicode value round-trips verbatim.
 */
function applyParameterized(store: ReconcileHarness, database: D1Database, statement: D1ImportStatement): number {
  store.affectedCalls.push({ database, statement });
  const insert = /^insert into (\w+) \(([^)]*)\) values (.+);$/.exec(statement.sql);
  if (insert) {
    const [, table, columnList] = insert;
    const columns = columnList.split(", ");
    const placeholders = (insert[3].match(/\?/g) ?? []).length;
    assert.equal(placeholders, statement.params.length, "every placeholder must bind a param");
    assert.equal(statement.params.length % columns.length, 0, "params must fill whole rows");
    const rows = store.remoteRows(table);
    for (let index = 0; index < statement.params.length; index += columns.length) {
      const row: StoreRow = {};
      columns.forEach((column, offset) => {
        row[column] = statement.params[index + offset];
      });
      rows.push(row);
    }
    return statement.params.length / columns.length;
  }
  const update = /^update (\w+) set (.+) where (.+);$/.exec(statement.sql);
  if (update) {
    const [, table, setText, whereText] = update;
    const setColumns = setText.split(", ").map((entry) => entry.replace(/ = \?$/, ""));
    const whereColumns = whereText.split(" and ").map((entry) => entry.replace(/ = \?$/, ""));
    const values = statement.params.slice(0, setColumns.length);
    const keys = statement.params.slice(setColumns.length);
    const rows = store.remoteRows(table);
    let changed = 0;
    for (const existing of rows) {
      const matches = whereColumns.every((column, index) => existing[column] === keys[index]);
      if (!matches) continue;
      setColumns.forEach((column, index) => {
        existing[column] = values[index];
      });
      changed += 1;
    }
    return changed;
  }
  throw new Error(`unexpected parameterized statement: ${statement.sql}`);
}

function createHarness(initialRows: Record<string, StoreRow[]> = {}, options: HarnessOptions = {}): ReconcileHarness {
  const calls: string[][] = [];
  const affectedCalls: AffectedCall[] = [];
  const queryCalls: QueryCall[] = [];
  const store: Record<string, StoreRow[]> = {};
  for (const [table, rows] of Object.entries(initialRows)) store[table] = rows.map((row) => ({ ...row }));

  const harness = {} as ReconcileHarness;
  const remoteRows = (table: string): StoreRow[] => {
    store[table] ??= [];
    return store[table];
  };

  const envelope = (rows: Record<string, unknown>[]): string =>
    JSON.stringify([{ results: rows, success: true, meta: {} }]);

  const executeRemoteQuery = async (
    database: D1Database,
    statement: D1ImportStatement,
  ): Promise<Record<string, unknown>[]> => {
    queryCalls.push({ database, statement });
    if (options.queryThrows) throw new Error("d1_http_query.request_failed");
    const valueAt = (index: number, fallback: number): number => {
      const value = statement.params[index];
      return typeof value === "number" ? value : fallback;
    };
    const count = /^select count\(\*\) as n from (\w+)$/.exec(statement.sql);
    if (count) return [{ n: remoteRows(count[1]).length }];
    const table = / from (\w+)/.exec(statement.sql)?.[1] ?? "";
    const rows = remoteRows(table);
    return rows.slice(valueAt(1, 0), valueAt(1, 0) + valueAt(0, rows.length));
  };

  let wrote = false;
  let tampered = false;
  const runner: WranglerD1Runner = async (args) => {
    calls.push(args);
    assert.equal(args[2], "worldcons_core");
    const command = args[args.indexOf("--command") + 1];
    if (options.readError) throw options.readError;
    if (options.crashReads) {
      throw new WranglerD1ExitError(3221226505, "wrangler d1 execute failed with exit code 3221226505");
    }
    if (options.malformedReadJson) return "<!doctype html><html>not json</html>";
    const count = /^select count\(\*\) as n from (\w+)$/.exec(command);
    if (count) return envelope([{ n: remoteRows(count[1]).length }]);
    if (options.tamperFinal && wrote && !tampered) {
      tampered = true;
      const table = / from (\w+)/.exec(command)?.[1] ?? "";
      const rows = remoteRows(table);
      const [first] = rows;
      if (first) {
        const key = Object.keys(first).find((name) => name !== "id") ?? Object.keys(first)[0];
        rows[0] = { ...first, [key]: `${String(first[key])}-tampered` };
      }
    }
    const table = / from (\w+)/.exec(command)?.[1] ?? "";
    const limit = Number(/ limit (\d+)/.exec(command)?.[1]);
    const offset = Number(/ offset (\d+)/.exec(command)?.[1] ?? 0);
    return envelope(remoteRows(table).slice(offset, offset + limit));
  };

  harness.runner = runner;
  harness.calls = calls;
  harness.affectedCalls = affectedCalls;
  harness.queryCalls = queryCalls;
  harness.executeRemoteQuery = executeRemoteQuery;
  harness.executeStatement = async (database, statement) => {
    if (options.writeThrows) throw new Error("d1_http_query.request_failed");
    const changes = applyParameterized(harness, database, statement);
    wrote = true;
    return { changes: changes + (options.affectedDelta ?? 0) };
  };
  harness.remoteRows = remoteRows;
  return harness;
}

const source = (rows: Record<string, unknown>[] = SOURCE_ROWS): PostgresRowSource =>
  createFakeSource({ reconcile_probe: rows });

test("an exact remote is classified exact and plans zero writes", async () => {
  const harness = createHarness({ reconcile_probe: FULL_ROWS });
  const manifest = await buildD1RemoteReconcileManifest({
    runner: harness.runner,
    source: source(),
    schema,
    databases: ["worldcons_core"],
  });

  assert.equal(manifest.dryRun, true);
  assert.equal(manifest.ok, true, manifest.errors.join("; "));
  assert.equal(manifest.totals.exact, 1);
  assert.equal(manifest.totals.insertedRows, 0);
  assert.equal(manifest.totals.updatedRows, 0);

  const [table] = manifest.targets[0].tables;
  assert.equal(table.state, "exact");
  assert.equal(table.action, "none");
  assert.equal(table.verified, true);
  assert.equal(table.insertRowCount, 0);
  assert.equal(table.updateRowCount, 0);
  assert.equal(table.remoteOnlyRowCount, 0);
  assert.equal(table.insertStatementCount, 0);
  assert.equal(table.updateStatementCount, 0);
  assert.equal(harness.affectedCalls.length, 0);
});

test("source-only rows are planned as insert-only plain inserts", async () => {
  const remote = FULL_ROWS.filter((row) => row.id !== "c");
  const harness = createHarness({ reconcile_probe: remote });
  const manifest = await buildD1RemoteReconcileManifest({
    runner: harness.runner,
    source: source(),
    schema,
    databases: ["worldcons_core"],
  });

  assert.equal(manifest.ok, true, manifest.errors.join("; "));
  assert.equal(manifest.totals.insertOnly, 1);

  const [table] = manifest.targets[0].tables;
  assert.equal(table.state, "insert-only");
  assert.equal(table.action, "reconcile");
  assert.equal(table.insertRowCount, 1);
  assert.equal(table.updateRowCount, 0);
  assert.equal(table.verified, false);
  assert.equal(harness.affectedCalls.length, 0, "a dry-run writes nothing");
});

test("changed common-PK rows are planned as update-only full-row updates", async () => {
  const remote = FULL_ROWS.map((row) => (row.id === "b" ? { ...row, body: "B changed" } : row));
  const harness = createHarness({ reconcile_probe: remote });
  const manifest = await buildD1RemoteReconcileManifest({
    runner: harness.runner,
    source: source(),
    schema,
    databases: ["worldcons_core"],
  });

  assert.equal(manifest.ok, true, manifest.errors.join("; "));
  assert.equal(manifest.totals.updateOnly, 1);

  const [table] = manifest.targets[0].tables;
  assert.equal(table.state, "update-only");
  assert.equal(table.action, "reconcile");
  assert.equal(table.insertRowCount, 0);
  assert.equal(table.updateRowCount, 1);
  assert.equal(table.verified, false);
});

test("a table with both source-only and changed rows is classified mixed", async () => {
  const remote = FULL_ROWS.filter((row) => row.id !== "d").map((row) =>
    row.id === "a" ? { ...row, body: "A changed" } : row,
  );
  const harness = createHarness({ reconcile_probe: remote });
  const manifest = await buildD1RemoteReconcileManifest({
    runner: harness.runner,
    source: source(),
    schema,
    databases: ["worldcons_core"],
  });

  assert.equal(manifest.ok, true, manifest.errors.join("; "));
  assert.equal(manifest.totals.mixed, 1);

  const [table] = manifest.targets[0].tables;
  assert.equal(table.state, "mixed");
  assert.equal(table.insertRowCount, 1);
  assert.equal(table.updateRowCount, 1);
});

test("apply inserts source-only rows and updates changed rows to exact parity", async () => {
  const remote = FULL_ROWS.filter((row) => row.id !== "c").map((row) =>
    row.id === "a" ? { ...row, body: "A stale" } : row,
  );
  const harness = createHarness({ reconcile_probe: remote });
  const manifest = await buildD1RemoteReconcileManifest({
    runner: harness.runner,
    source: source(),
    schema,
    databases: ["worldcons_core"],
    apply: true,
    executeStatement: harness.executeStatement,
  });

  assert.equal(manifest.applied, true);
  assert.equal(manifest.ok, true, manifest.errors.join("; "));
  assert.equal(manifest.totals.insertedRows, 1);
  assert.equal(manifest.totals.updatedRows, 1);

  const [table] = manifest.targets[0].tables;
  assert.equal(table.state, "exact");
  assert.equal(table.action, "reconcile");
  assert.equal(table.verified, true);
  assert.equal(table.remoteRowCount, 4);
  assert.equal(table.remoteHash, table.expectedHash);

  const stored = harness.remoteRows("reconcile_probe");
  assert.equal(stored.length, 4);
  assert.equal(stored.find((row) => row.id === "c")?.body, "C");
  assert.equal(stored.find((row) => row.id === "a")?.body, "A");

  // Inserts and updates both travel as bound parameters, never DELETE/REPLACE.
  const sqls = harness.affectedCalls.map((call) => call.statement.sql);
  assert.ok(sqls.some((sql) => sql.startsWith("insert into reconcile_probe")));
  assert.ok(sqls.some((sql) => sql.startsWith("update reconcile_probe set")));
  for (const call of harness.affectedCalls) {
    assert.ok(call.statement.sql.includes("?"));
  }
});

test("a composite primary key updates by the exact key with PK columns excluded from SET", async () => {
  const compositeRows: Record<string, unknown>[] = [
    { tenant: "t1", id: "a", value: "va" },
    { tenant: "t1", id: "b", value: "vb" },
    { tenant: "t2", id: "a", value: "va2" },
  ];
  const canonical = toCanonicalTableDataset(compositeTable, compositeRows).rows;
  const remote = canonical.map((row) =>
    row.tenant === "t2" && row.id === "a" ? { ...row, value: "stale" } : row,
  );
  const harness = createHarness({ reconcile_composite: remote });
  const manifest = await buildD1RemoteReconcileManifest({
    runner: harness.runner,
    source: createFakeSource({ reconcile_composite: compositeRows }),
    schema: compositeSchema,
    databases: ["worldcons_core"],
    apply: true,
    executeStatement: harness.executeStatement,
  });

  assert.equal(manifest.ok, true, manifest.errors.join("; "));
  const [table] = manifest.targets[0].tables;
  assert.equal(table.state, "exact");
  assert.equal(table.updateRowCount, 1);
  assert.equal(table.verified, true);

  const [update] = harness.affectedCalls.filter((call) => call.statement.sql.startsWith("update"));
  assert.ok(update, "a composite update statement must be emitted");
  assert.equal(
    update.statement.sql,
    "update reconcile_composite set value = ? where tenant = ? and id = ?;",
  );
  const setClause = /^update \w+ set (.+?) where /.exec(update.statement.sql)?.[1] ?? "";
  assert.ok(!/\btenant\b/.test(setClause), "the PK must be excluded from SET");
  assert.ok(!/\bid\b/.test(setClause), "the PK must be excluded from SET");
});

test("a remote-only primary key refuses the table and writes nothing", async () => {
  const remote = [...FULL_ROWS, { id: "ghost", body: "G", rank: 9 }];
  const harness = createHarness({ reconcile_probe: remote });
  const manifest = await buildD1RemoteReconcileManifest({
    runner: harness.runner,
    source: source(),
    schema,
    databases: ["worldcons_core"],
    apply: true,
    executeStatement: harness.executeStatement,
  });

  assert.equal(manifest.ok, false);
  assert.equal(manifest.totals.refused, 1);

  const [table] = manifest.targets[0].tables;
  assert.equal(table.state, "refused");
  assert.equal(table.action, "refused");
  assert.equal(table.remoteOnlyRowCount, 1, "a remote-only refusal reports the true nonzero count");
  assert.equal(table.expectedRowCount, 4, "the known source row count is preserved in the refusal");
  assert.equal(table.remoteRowCount, 5, "the known remote row count is preserved in the refusal");
  assert.ok(table.expectedHash.length > 0, "the known source hash is preserved in the refusal");
  assert.equal(typeof table.remoteHash, "string", "the fully read remote hash is preserved in the refusal");
  assert.ok((table.remoteHash ?? "").length > 0);
  assert.equal(table.verified, false);
  assert.ok(table.errors.some((error) => error.includes("remote-only") || error.includes("never deletes")));
  assert.equal(harness.affectedCalls.length, 0, "a refused table must never be written");
});

test("a duplicate source primary key refuses the table", async () => {
  const duplicateSource = [...SOURCE_ROWS, { id: "a", body: "dup", rank: 99 }];
  const harness = createHarness({ reconcile_probe: FULL_ROWS });
  const manifest = await buildD1RemoteReconcileManifest({
    runner: harness.runner,
    source: source(duplicateSource),
    schema,
    databases: ["worldcons_core"],
    apply: true,
    executeStatement: harness.executeStatement,
  });

  assert.equal(manifest.ok, false);
  const [table] = manifest.targets[0].tables;
  assert.equal(table.state, "refused");
  assert.ok(table.errors.some((error) => error.includes("duplicate")));
  assert.equal(harness.affectedCalls.length, 0);
});

test("a table without a primary key refuses rather than guess", async () => {
  const noPk = buildTable({
    name: "reconcile_nopk",
    database: "worldcons_core",
    primaryKey: [],
    columns: [{ name: "body", type: "text" }],
  });
  const noPkSchema: D1Schema = { version: 1, databases: ["worldcons_core"], tables: [noPk], ownership: [] };
  const harness = createHarness({ reconcile_nopk: [] });
  const manifest = await buildD1RemoteReconcileManifest({
    runner: harness.runner,
    source: createFakeSource({ reconcile_nopk: [{ body: "x" }] }),
    schema: noPkSchema,
    databases: ["worldcons_core"],
    apply: true,
    executeStatement: harness.executeStatement,
  });

  assert.equal(manifest.ok, false);
  const [table] = manifest.targets[0].tables;
  assert.equal(table.state, "refused");
  assert.ok(table.errors.some((error) => error.includes("primary key")));
});

test("an affected-row count mismatch fails closed and is not a silent success", async () => {
  const harness = createHarness({ reconcile_probe: FULL_ROWS }, { affectedDelta: 1 });
  const manifest = await buildD1RemoteReconcileManifest({
    runner: harness.runner,
    source: createFakeSource({ reconcile_probe: [...SOURCE_ROWS, { id: "e", body: "E", rank: 5 }] }),
    schema,
    databases: ["worldcons_core"],
    apply: true,
    executeStatement: harness.executeStatement,
  });

  assert.equal(manifest.ok, false);
  const [table] = manifest.targets[0].tables;
  assert.equal(table.state, "unknown");
  assert.ok(table.errors.some((error) => error.includes("affected row")));
});

test("a final canonical hash mismatch after apply fails verification", async () => {
  const harness = createHarness({ reconcile_probe: FULL_ROWS.filter((row) => row.id !== "d") }, { tamperFinal: true });
  const manifest = await buildD1RemoteReconcileManifest({
    runner: harness.runner,
    source: source(),
    schema,
    databases: ["worldcons_core"],
    apply: true,
    executeStatement: harness.executeStatement,
  });

  assert.equal(manifest.ok, false);
  const [table] = manifest.targets[0].tables;
  assert.equal(table.state, "unknown");
  assert.ok(table.errors.some((error) => error.includes("final remote dataset")));
  assert.ok(manifest.errors.some((error) => error.includes("final remote dataset")));
});

test("a source changed after apply is caught by the final full-table verification", async () => {
  const harness = createHarness({ reconcile_probe: FULL_ROWS.filter((row) => row.id !== "d") });
  const manifest = await buildD1RemoteReconcileManifest({
    runner: harness.runner,
    source: source(),
    schema,
    databases: ["worldcons_core"],
    apply: true,
    executeStatement: harness.executeStatement,
  });
  assert.equal(manifest.ok, true, manifest.errors.join("; "));

  // A concurrent source-side change after apply leaves the remote drifted from the
  // fresh source; a subsequent dry-run must detect and plan the correction rather
  // than silently treat the table as exact.
  harness.remoteRows("reconcile_probe")[0] = { ...harness.remoteRows("reconcile_probe")[0], body: "drifted" };
  const dry = await buildD1RemoteReconcileManifest({
    runner: harness.runner,
    source: source(),
    schema,
    databases: ["worldcons_core"],
  });
  const [table] = dry.targets[0].tables;
  assert.equal(table.state, "update-only", "the drifted row is planned as an update");
  assert.equal(table.updateRowCount, 1);
  assert.equal(dry.ok, true);
});

test("a source mutated during apply fails the fresh final source+remote verification", async () => {
  const harness = createHarness({ reconcile_probe: FULL_ROWS.filter((row) => row.id !== "d") });
  let reads = 0;
  const mutating: PostgresRowSource = {
    isConfigured: () => true,
    readRows: async (request) => {
      reads += 1;
      const rows =
        reads === 1
          ? SOURCE_ROWS
          : SOURCE_ROWS.map((row) => (row.id === "a" ? { ...row, body: "A changed during apply" } : row));
      const limit = request.limit ?? rows.length;
      return rows.slice(request.offset, request.offset + limit).map((row) => ({ ...row }));
    },
    close: async () => {},
  };

  const manifest = await buildD1RemoteReconcileManifest({
    runner: harness.runner,
    source: mutating,
    schema,
    databases: ["worldcons_core"],
    apply: true,
    executeStatement: harness.executeStatement,
  });

  assert.equal(manifest.ok, false);
  const [table] = manifest.targets[0].tables;
  assert.equal(table.state, "unknown");
  assert.equal(table.verified, false);
  assert.ok(
    table.errors.some((error) => error.includes("fresh source dataset")),
    `a source mutation during apply must fail the final verification: ${table.errors.join("; ")}`,
  );
});

test("a successful rerun after apply classifies exact and plans zero writes", async () => {
  const remote = FULL_ROWS.filter((row) => row.id !== "c").map((row) =>
    row.id === "b" ? { ...row, body: "B stale" } : row,
  );
  const harness = createHarness({ reconcile_probe: remote });
  const applied = await buildD1RemoteReconcileManifest({
    runner: harness.runner,
    source: source(),
    schema,
    databases: ["worldcons_core"],
    apply: true,
    executeStatement: harness.executeStatement,
  });
  assert.equal(applied.ok, true, applied.errors.join("; "));
  const writesBefore = harness.affectedCalls.length;
  assert.ok(writesBefore > 0);

  const rerun = await buildD1RemoteReconcileManifest({
    runner: harness.runner,
    source: source(),
    schema,
    databases: ["worldcons_core"],
    apply: true,
    executeStatement: harness.executeStatement,
  });

  assert.equal(rerun.ok, true, rerun.errors.join("; "));
  assert.equal(rerun.totals.exact, 1);
  assert.equal(rerun.totals.insertedRows, 0);
  assert.equal(rerun.totals.updatedRows, 0);
  assert.equal(harness.affectedCalls.length, writesBefore, "a rerun must plan and execute zero writes");
  const [table] = rerun.targets[0].tables;
  assert.equal(table.state, "exact");
  assert.equal(table.action, "none");
  assert.equal(table.verified, true);
});

test("a partially applied run recalculates fresh state and plans only the remainder", async () => {
  // Remote is missing c and d and has a stale a. The first run applies all three.
  const remote = FULL_ROWS.filter((row) => row.id !== "c" && row.id !== "d").map((row) =>
    row.id === "a" ? { ...row, body: "A stale" } : row,
  );
  const harness = createHarness({ reconcile_probe: remote });

  // Simulate a partial apply by pre-applying only the insert of c.
  applyParameterized(
    harness,
    "worldcons_core",
    (() => {
      const dataset = toCanonicalTableDataset(probeTable, [SOURCE_ROWS[2]]);
      const columns = dataset.columns;
      return {
        sql: `insert into reconcile_probe (${columns.join(", ")}) values (${columns.map(() => "?").join(", ")});`,
        params: columns.map((name) => dataset.rows[0][name] as string),
      };
    })(),
  );

  const manifest = await buildD1RemoteReconcileManifest({
    runner: harness.runner,
    source: source(),
    schema,
    databases: ["worldcons_core"],
    apply: true,
    executeStatement: harness.executeStatement,
  });

  assert.equal(manifest.ok, true, manifest.errors.join("; "));
  const [table] = manifest.targets[0].tables;
  assert.equal(table.insertRowCount, 1, "only d remained missing before this run");
  assert.equal(table.updateRowCount, 1, "a remained stale before this run");
  assert.equal(table.remoteOnlyRowCount, 0);
  assert.equal(table.verified, true);
  assert.deepEqual(
    harness.remoteRows("reconcile_probe").map((row) => row.id).sort(),
    ["a", "b", "c", "d"],
  );
});

test("json, array, bigint-text and timestamp values survive an UPDATE as bound parameters", async () => {
  const richSourceRows: Record<string, unknown>[] = [
    { id: "r1", payload: { b: 2, a: 1 }, labels: ["x", "y"], bignum: "9007199254740993", active: true, created: "2026-01-02T03:04:05.000Z" },
  ];
  const canonical = toCanonicalTableDataset(richTable, richSourceRows).rows;
  // Remote stores the canonical row but with a stale json/bigint/timestamp value.
  const remote = canonical.map((row) => ({
    ...row,
    payload: '{"a":0}',
    labels: "[]",
    bignum: "1",
    created: "2000-01-01T00:00:00.000Z",
  }));
  const harness = createHarness({ reconcile_rich: remote });
  const manifest = await buildD1RemoteReconcileManifest({
    runner: harness.runner,
    source: createFakeSource({ reconcile_rich: richSourceRows }),
    schema: richSchema,
    databases: ["worldcons_core"],
    apply: true,
    executeStatement: harness.executeStatement,
  });

  assert.equal(manifest.ok, true, manifest.errors.join("; "));
  const [table] = manifest.targets[0].tables;
  assert.equal(table.state, "exact");
  assert.equal(table.updateRowCount, 1);
  assert.equal(table.verified, true);

  const [update] = harness.affectedCalls.filter((call) => call.statement.sql.startsWith("update"));
  assert.ok(update.statement.sql.includes("?"));
  assert.ok(!update.statement.sql.includes("9007199254740993"), "a bigint value must not be interpolated");
  const bound = update.statement.params.map((param) => (typeof param === "string" ? param : String(param)));
  assert.ok(bound.includes('{"a":1,"b":2}'), "canonical json text travels as a bound parameter");
  assert.ok(bound.includes('["x","y"]'), "canonical array text travels as a bound parameter");
  assert.ok(bound.includes("9007199254740993"), "canonical bigint text travels as a bound parameter");
  assert.ok(bound.includes("2026-01-02T03:04:05.000Z"), "canonical timestamp travels as a bound parameter");
  assert.ok(update.statement.params.includes(1), "boolean is stored as the bound integer 1");

  const stored = harness.remoteRows("reconcile_rich")[0];
  assert.equal(stored.payload, '{"a":1,"b":2}');
  assert.equal(stored.labels, '["x","y"]');
  assert.equal(stored.bignum, "9007199254740993");
  assert.equal(stored.created, "2026-01-02T03:04:05.000Z");
  assert.equal(stored.active, 1);
});

test("the reconcile seam contains no destructive DML, DDL or upsert", () => {
  const sourceText = readFileSync(path.join(process.cwd(), "lib/cloudflare/d1/remote/reconcile.ts"), "utf8");
  const code = sourceText.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "").toLowerCase();

  const forbidden: [string, RegExp][] = [
    ["node:child_process import", /node:child_process/],
    ["pg import", /\bfrom\s*["']pg["']|require\s*\(\s*["']pg["']\s*\)/],
    ["insert or replace", /insert\s+or\s+replace/],
    ["replace into", /replace\s+into/],
    ["upsert", /upsert/],
    ["on conflict", /on\s+conflict/],
    ["delete from", /delete\s+from/],
    ["truncate", /truncate/],
    ["drop table", /drop\s+table/],
    ["create table", /create\s+table/],
    ["alter table", /alter\s+table/],
    ["primary key in set", /set\s+[^;]*\bprimary\b/],
  ];
  for (const [label, pattern] of forbidden) {
    assert.ok(!pattern.test(code), `reconcile seam must not contain ${label}`);
  }

  assert.ok(code.includes("if (apply)"), "apply must remain explicitly opt-in behind `if (apply)`");
  assert.ok(code.includes("insert into"), "source-only rows are written as plain inserts");
  assert.ok(code.includes("update"), "changed common-PK rows are written as updates");
});

test("selecting worldcons_search yields zero reconcile targets", async () => {
  const harness = createHarness();
  const manifest = await buildD1RemoteReconcileManifest({
    runner: harness.runner,
    source: source(),
    schema,
    databases: ["worldcons_search"],
    apply: true,
    executeStatement: harness.executeStatement,
  });

  assert.equal(manifest.ok, true, manifest.errors.join("; "));
  assert.deepEqual(manifest.targets, []);
  assert.equal(harness.calls.length, 0);
  assert.equal(harness.affectedCalls.length, 0);
});

test("an unknown table selection fails before any remote call", async () => {
  const harness = createHarness();
  await assert.rejects(
    buildD1RemoteReconcileManifest({
      runner: harness.runner,
      source: source(),
      schema,
      databases: ["worldcons_core"],
      tables: ["missing_table"],
    }),
    /unknown reconcile table selection/,
  );
  assert.equal(harness.calls.length, 0);
});

test("a table selection narrows reconciliation to one table", async () => {
  const harness = createHarness({ reconcile_probe: FULL_ROWS });
  const manifest = await buildD1RemoteReconcileManifest({
    runner: harness.runner,
    source: source(),
    schema,
    databases: ["worldcons_core"],
    tables: ["reconcile_probe"],
  });
  assert.equal(manifest.ok, true, manifest.errors.join("; "));
  assert.equal(manifest.totals.tables, 1);
  assert.deepEqual(manifest.targets[0].tables.map((table) => table.table), ["reconcile_probe"]);
});

test("the reconcile defaults and scope are conservative and exclude worldcons_search", () => {
  assert.ok(D1_REMOTE_RECONCILE_DEFAULT_BATCH_SIZE >= 100 && D1_REMOTE_RECONCILE_DEFAULT_BATCH_SIZE <= 1000);
  assert.ok(D1_REMOTE_RECONCILE_DATABASES.includes("worldcons_core"));
  assert.ok(D1_REMOTE_RECONCILE_DATABASES.includes("worldcons_ingest"));
  assert.ok(D1_REMOTE_RECONCILE_DATABASES.includes("worldcons_ops"));
  assert.ok(!D1_REMOTE_RECONCILE_DATABASES.includes("worldcons_search"));
});

test("the reconcile CLI exposes an explicit, opt-in, no-broad-apply surface", () => {
  const cliSource = readFileSync(path.join(process.cwd(), "scripts/d1-reconcile.ts"), "utf8");
  const cliCode = cliSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  assert.ok(cliSource.includes("WORLDCONS_D1_SOURCE_URL"), "the CLI must read the explicit source env var");
  assert.ok(cliCode.includes('argValue(args, "source")'), "the CLI must resolve the source kind from `--source=`");
  assert.ok(cliCode.includes('argValue(args, "source") ?? "postgres"'), "postgres must remain the default source");
  assert.ok(cliCode.includes('"supabase-linked"'), "the CLI must know the linked source kind");
  assert.ok(cliSource.includes("createSupabaseLinkedRowSource"), "the CLI must import the linked source");

  assert.ok(cliSource.includes("linked-timeout-ms"), "the CLI must expose --linked-timeout-ms");
  assert.ok(cliSource.includes("linked-max-stdout-bytes"), "the CLI must expose --linked-max-stdout-bytes");
  assert.ok(cliSource.includes("batch-size"), "the CLI must expose --batch-size");
  assert.ok(cliSource.includes("timeout-ms"), "the CLI must expose --timeout-ms");
  assert.ok(cliSource.includes("tables"), "the CLI must expose --tables");
  assert.ok(cliSource.includes("--database"), "the CLI must expose --database");
  assert.ok(cliSource.includes("--apply"), "the CLI must expose an explicit --apply");
  assert.ok(cliSource.includes("--json"), "the CLI must expose --json");

  assert.ok(cliSource.includes('args.includes("--apply")'), "apply must be an explicit `--apply` flag");
  assert.ok(
    /apply && databases === null/.test(cliSource),
    "an implicit all-database apply must be refused",
  );
  assert.ok(
    /buildD1RemoteReconcileManifest\(\{[\s\S]*?\bapply\b/.test(cliSource),
    "the parsed apply flag must be passed into buildD1RemoteReconcileManifest",
  );
  assert.ok(!cliCode.includes("DATABASE_URL"), "the CLI must not fall back to DATABASE_URL");
  assert.ok(cliSource.includes("CLOUDFLARE_ACCOUNT_ID"), "the CLI must read CLOUDFLARE_ACCOUNT_ID");
  assert.ok(cliSource.includes("CLOUDFLARE_API_TOKEN"), "the CLI must read CLOUDFLARE_API_TOKEN");
  assert.ok(!cliCode.includes("--api-token"), "the CLI must not expose an --api-token argument");
  assert.ok(!cliCode.includes("--account-id"), "the CLI must not expose an --account-id argument");
  assert.ok(cliSource.includes("createD1HttpAffectedWriter"), "the CLI must use the affected-row HTTP writer");
  assert.ok(
    cliSource.includes('from "@/lib/cloudflare/d1/remote/reconcile"'),
    "the CLI must import the reconcile manifest builder",
  );

  const pkg = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  assert.ok(pkg.scripts["d1:reconcile"], "package.json must expose d1:reconcile");
  assert.ok(pkg.scripts["test:d1-reconcile"], "package.json must expose test:d1-reconcile");
  assert.ok(
    pkg.scripts["verify:release"].includes("pnpm test:d1-reconcile"),
    "verify:release must run pnpm test:d1-reconcile",
  );
});

test("d1:copy-data remains INSERT-only and does not gain update/delete/upsert behavior", () => {
  const source = readFileSync(path.join(process.cwd(), "lib/cloudflare/d1/remote/data-copy.ts"), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "").toLowerCase();

  const forbidden: [string, RegExp][] = [
    ["insert or replace", /insert\s+or\s+replace/],
    ["replace into", /replace\s+into/],
    ["upsert", /upsert/],
    ["on conflict", /on\s+conflict/],
    ["delete from", /delete\s+from/],
    ["update ... set", /\bupdate\s+[a-z_][a-z0-9_]*\s+set\b/],
  ];
  for (const [label, pattern] of forbidden) {
    assert.ok(!pattern.test(code), `d1:copy-data must remain free of ${label}`);
  }

  // The copied data path is untouched by M5.2d: it still classifies and writes
  // plain inserts only and it still refuses a changed common-PK row.
  assert.ok(code.includes("canonicalsubsetplan"));
  assert.ok(code.includes("emittableimport"));
  assert.ok(code.includes("if (!apply)"));
});

test("a Wrangler read crash falls back to the injected HTTP query and audits a safe marker", async () => {
  const harness = createHarness({ reconcile_probe: FULL_ROWS }, { crashReads: true });
  const manifest = await buildD1RemoteReconcileManifest({
    runner: harness.runner,
    source: source(),
    schema,
    databases: ["worldcons_core"],
    executeRemoteQuery: harness.executeRemoteQuery,
  });

  assert.equal(manifest.ok, true, manifest.errors.join("; "));
  const [table] = manifest.targets[0].tables;
  assert.equal(table.state, "exact");
  assert.ok(harness.queryCalls.length > 0, "the crashed Wrangler read must be retried through HTTP");
  assert.ok(manifest.commands.includes("http-query worldcons_core reconcile_probe"));
});

test("a non-crash Wrangler read failure never falls back and refuses the table", async () => {
  const harness = createHarness({}, { readError: new WranglerD1ExitError(7, "exit 7") });
  const manifest = await buildD1RemoteReconcileManifest({
    runner: harness.runner,
    source: source(),
    schema,
    databases: ["worldcons_core"],
    apply: true,
    executeStatement: harness.executeStatement,
    executeRemoteQuery: harness.executeRemoteQuery,
  });

  assert.equal(manifest.ok, false);
  assert.equal(harness.queryCalls.length, 0, "only exit 3221226505 may fall back");
  const [table] = manifest.targets[0].tables;
  assert.equal(table.state, "unknown");
  assert.equal(table.action, "refused");
});

test("an empty source over an empty remote is exact with zero writes", async () => {
  const harness = createHarness();
  const manifest = await buildD1RemoteReconcileManifest({
    runner: harness.runner,
    source: createFakeSource({}),
    schema,
    databases: ["worldcons_core"],
    apply: true,
    executeStatement: harness.executeStatement,
  });

  assert.equal(manifest.ok, true, manifest.errors.join("; "));
  const [table] = manifest.targets[0].tables;
  assert.equal(table.state, "exact");
  assert.equal(table.verified, true);
  assert.equal(harness.affectedCalls.length, 0);
});

test("an empty source over a non-empty remote refuses because remote-only rows exist", async () => {
  const harness = createHarness({ reconcile_probe: FULL_ROWS });
  const manifest = await buildD1RemoteReconcileManifest({
    runner: harness.runner,
    source: createFakeSource({}),
    schema,
    databases: ["worldcons_core"],
    apply: true,
    executeStatement: harness.executeStatement,
  });

  assert.equal(manifest.ok, false);
  const [table] = manifest.targets[0].tables;
  assert.equal(table.state, "refused");
  assert.equal(table.remoteOnlyRowCount, FULL_ROWS.length, "every remote row is reported as remote-only");
  assert.equal(table.expectedRowCount, 0, "an empty source preserves its known zero row count");
  assert.equal(table.remoteRowCount, FULL_ROWS.length, "the nonempty remote row count is preserved");
  assert.equal(harness.affectedCalls.length, 0);
});

test("two fresh harnesses with identical inputs produce identical manifests and write plans", async () => {
  const remote = FULL_ROWS.filter((row) => row.id !== "c").map((row) =>
    row.id === "b" ? { ...row, body: "B stale" } : row,
  );
  const first = createHarness({ reconcile_probe: remote });
  const second = createHarness({ reconcile_probe: remote });

  const firstManifest = await buildD1RemoteReconcileManifest({
    runner: first.runner,
    source: source(),
    schema,
    databases: ["worldcons_core"],
    apply: true,
    executeStatement: first.executeStatement,
  });
  const secondManifest = await buildD1RemoteReconcileManifest({
    runner: second.runner,
    source: source(),
    schema,
    databases: ["worldcons_core"],
    apply: true,
    executeStatement: second.executeStatement,
  });

  assert.deepEqual(firstManifest.totals, secondManifest.totals);
  assert.deepEqual(
    first.affectedCalls.map((call) => call.statement.sql),
    second.affectedCalls.map((call) => call.statement.sql),
    "the stable statement order must be identical across identical inputs",
  );
});

test("apply without an executeStatement throws a caller error", async () => {
  const harness = createHarness({ reconcile_probe: FULL_ROWS });
  await assert.rejects(
    buildD1RemoteReconcileManifest({
      runner: harness.runner,
      source: source(),
      schema,
      databases: ["worldcons_core"],
      apply: true,
    }),
    /executeStatement is required/,
  );
});
