import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { D1_DATABASES, buildTable, d1Schema, type D1Database, type D1Schema, type D1TableDefinition } from "../lib/cloudflare/d1";
import {
  D1_IMPORT_VERSION,
  D1_MAX_BOUND_PARAMETERS,
  applyDatabaseImport,
  applyDatabaseSchema,
  buildD1ImportReport,
  d1ReadStatement,
  emitDatabaseImport,
  emitTableImport,
  renderImportSql,
  renderSqlLiteral,
  verifyTableImport,
  type D1ImportTarget,
} from "../lib/cloudflare/d1/import";
import { createLocalD1Target } from "../lib/cloudflare/d1/import/local-target";
import { buildD1ConversionReport, createMemoryRowSource, toCanonicalTableDataset } from "../lib/cloudflare/d1/convert";

const rootDir = process.cwd();

function findTable(name: string): D1TableDefinition {
  const table = d1Schema.tables.find((entry) => entry.name === name);
  assert.ok(table, `${name} must exist`);
  return table;
}

const probeTable = buildTable({
  name: "import_probe",
  database: "worldcons_core",
  primaryKey: ["id"],
  columns: [
    { name: "id", type: "uuid", nn: true },
    { name: "created_at", type: "timestamptz", nn: true },
    { name: "is_active", type: "boolean", nn: true },
    { name: "payload", type: "jsonb" },
    { name: "labels", type: "text[]" },
    { name: "big_counter", type: "bigint" },
    { name: "score", type: "numeric" },
    { name: "status", type: "text", enum: ["summarized", "failed"] },
    { name: "blob_data", type: "bytea" },
    { name: "search_vector", type: "tsvector" },
    { name: "embedding", type: "vector(1536)" },
  ],
});

const otherTable = buildTable({
  name: "import_other",
  database: "worldcons_core",
  primaryKey: ["id"],
  columns: [
    { name: "id", type: "uuid", nn: true },
    { name: "body", type: "text" },
  ],
});

const localSchema: D1Schema = {
  version: 1,
  databases: [...D1_DATABASES],
  tables: [probeTable, otherTable],
  ownership: [],
};

const probeRowA: Record<string, unknown> = {
  id: "AAAAAAAA-0000-0000-0000-000000000001",
  created_at: "2026-05-08T10:00:00Z",
  is_active: true,
  payload: { b: 1, a: 2 },
  labels: ["z", "a"],
  big_counter: "9007199254740993",
  score: "1.5",
  status: "summarized",
  blob_data: "aGk=",
  search_vector: "ignored-relocation",
  embedding: [1, 2, 3],
};

const probeRowB: Record<string, unknown> = {
  id: "aaaaaaaa-0000-0000-0000-000000000002",
  created_at: new Date("2026-05-07T10:00:00Z"),
  is_active: false,
  payload: null,
  labels: [],
  big_counter: 12n,
  score: 2,
  status: "failed",
  blob_data: null,
  search_vector: "ignored-relocation",
  embedding: null,
};

test("the emitter excludes relocated columns and emits bounded parameterized inserts", () => {
  const dataset = toCanonicalTableDataset(probeTable, [probeRowA, probeRowB]);
  const imported = emitTableImport(probeTable, dataset);

  assert.equal(imported.version, D1_IMPORT_VERSION);
  assert.equal(imported.table, "import_probe");
  assert.deepEqual(imported.columns, [
    "id",
    "created_at",
    "is_active",
    "payload",
    "labels",
    "big_counter",
    "score",
    "status",
    "blob_data",
  ]);
  assert.ok(!imported.columns.includes("search_vector") && !imported.columns.includes("embedding"));
  assert.equal(imported.rowCount, 2);
  assert.equal(imported.paramCount, 18);
  assert.equal(imported.statementCount, 1, "two narrow rows fit one multi-row insert");

  const statement = imported.statements[0];
  assert.ok(statement.sql.startsWith("insert into import_probe (id, created_at,"));
  assert.ok(statement.sql.endsWith(";"));
  assert.equal(statement.params.length, 18);
  assert.equal(statement.params[0], "aaaaaaaa-0000-0000-0000-000000000001");
  assert.ok(statement.params[8] instanceof Uint8Array, "a blob must bind as bytes, not base64 text");
  assert.deepEqual(statement.params[8], new Uint8Array([104, 105]));
  assert.equal(statement.params[9], "aaaaaaaa-0000-0000-0000-000000000002");
  assert.equal(statement.params[17], null);
  assert.equal(imported.sourceTable, "import_probe");
  assert.deepEqual(imported.primaryKey, ["id"]);

  const reversed = emitTableImport(probeTable, toCanonicalTableDataset(probeTable, [probeRowB, probeRowA]));
  assert.deepEqual(reversed, imported, "the emitted import must be order-independent");
});

test("the emitter keeps multi-row inserts within the D1 bound-parameter limit", () => {
  assert.equal(D1_MAX_BOUND_PARAMETERS, 100);
  const rows = Array.from({ length: 30 }, (_, index) => ({
    id: `aaaaaaaa-0000-0000-0000-0000000000${String(index).padStart(2, "0")}`,
    body: `b${index}`,
  }));
  const dataset = toCanonicalTableDataset(otherTable, rows);

  const wide = emitTableImport(otherTable, dataset);
  assert.equal(wide.statementCount, 1, "2 columns allow 50 rows per statement");
  assert.equal(wide.paramCount, 60);

  const chunked = emitTableImport(otherTable, dataset, { rowsPerStatement: 7 });
  assert.equal(chunked.statementCount, 5);
  assert.deepEqual(chunked.statements.map((entry) => entry.params.length), [14, 14, 14, 14, 4]);

  const clamped = emitTableImport(otherTable, dataset, { rowsPerStatement: 500 });
  assert.equal(clamped.statementCount, 1, "a request above the parameter limit is clamped");
  assert.throws(() => emitTableImport(otherTable, dataset, { rowsPerStatement: 0 }), /rowsPerStatement/);
});

test("the literal renderer escapes text and hex-encodes blobs", () => {
  assert.equal(renderSqlLiteral(null), "null");
  assert.equal(renderSqlLiteral(42), "42");
  assert.equal(renderSqlLiteral(1.5), "1.5");
  assert.equal(renderSqlLiteral("O'Brien"), "'O''Brien'");
  assert.equal(renderSqlLiteral(new Uint8Array([0, 15, 255])), "X'000fff'");
  assert.throws(() => renderSqlLiteral(Number.NaN), /non-finite/);

  const imported = emitTableImport(probeTable, toCanonicalTableDataset(probeTable, [probeRowA]));
  assert.ok(imported.sql.startsWith("insert into import_probe ("));
  assert.ok(imported.sql.includes("X'6869'"), "the blob must render as a hex literal");
  assert.ok(imported.sql.includes("'summarized'"));
  assert.equal(renderImportSql(imported.statements), imported.sql);
});

test("the emitter fails closed on mismatched, derived and virtual tables", () => {
  const dataset = toCanonicalTableDataset(probeTable, [probeRowA]);
  const otherDataset = toCanonicalTableDataset(otherTable, [{ id: probeRowA.id, body: "x" }]);
  assert.throws(() => emitTableImport(probeTable, otherDataset), /cannot be imported/);
  assert.throws(() => emitDatabaseImport("worldcons_ops", [dataset], { schema: localSchema }), /belongs to worldcons_core/);
  assert.throws(() => emitTableImport(findTable("search_documents"), dataset), /not a migratable table/);
  assert.throws(() => emitTableImport(findTable("search_fts"), dataset), /not a migratable table/);
});

test("apply and verify prove canonical parity on a local sqlite target", () => {
  const target = createLocalD1Target();
  try {
    applyDatabaseSchema(target, "worldcons_core", localSchema);
    const dataset = toCanonicalTableDataset(probeTable, [probeRowA, probeRowB]);
    const imported = emitDatabaseImport("worldcons_core", [dataset], { schema: localSchema });
    applyDatabaseImport(target, imported);

    const { verification, actual } = verifyTableImport(target, probeTable, dataset);
    assert.equal(verification.ok, true, verification.errors.join("; "));
    assert.equal(verification.rowCount, 2);
    assert.equal(verification.hash, dataset.hash);
    assert.equal(verification.expectedHash, dataset.hash);
    assert.equal(actual.hash, dataset.hash);
    assert.deepEqual(actual.rows, dataset.rows);
  } finally {
    target.close?.();
  }
});

test("verification detects a tampered or missing row", () => {
  const target = createLocalD1Target();
  try {
    applyDatabaseSchema(target, "worldcons_core", localSchema);
    const dataset = toCanonicalTableDataset(probeTable, [probeRowA, probeRowB]);
    applyDatabaseImport(target, emitDatabaseImport("worldcons_core", [dataset], { schema: localSchema }));

    target.run("update import_probe set score = ?", [9]);
    const tampered = verifyTableImport(target, probeTable, dataset);
    assert.equal(tampered.verification.ok, false);
    assert.ok(tampered.verification.errors.some((error) => error.includes("canonical hash")));

    target.run("delete from import_probe where id = ?", [String(probeRowB.id)]);
    const missing = verifyTableImport(target, probeTable, dataset);
    assert.equal(missing.verification.ok, false);
    assert.ok(missing.verification.errors.some((error) => error.includes("row count")));
  } finally {
    target.close?.();
  }
});

test("a failed import rolls back instead of leaving partial rows", () => {
  const target = createLocalD1Target();
  try {
    applyDatabaseSchema(target, "worldcons_core", localSchema);
    const dataset = toCanonicalTableDataset(probeTable, [probeRowA]);
    const imported = emitDatabaseImport("worldcons_core", [dataset], { schema: localSchema });
    const statement = imported.tables[0].statements[0];
    const broken = {
      ...imported,
      tables: [
        {
          ...imported.tables[0],
          statements: [{ sql: statement.sql, params: statement.params.map((param, index) => (index === 0 ? null : param)) }],
        },
      ],
    };
    assert.throws(() => applyDatabaseImport(target, broken), /constraint/i);
    const rows = target.all("select count(*) as count from import_probe", []);
    assert.equal(Number((rows[0] as { count: number }).count), 0, "the transaction must roll back");
  } finally {
    target.close?.();
  }
});

test("the pipeline fails closed on an unconfigured source or a missing target", async () => {
  const target = createLocalD1Target();
  try {
    await assert.rejects(
      () =>
        buildD1ImportReport({
          source: createMemoryRowSource({ configured: false }),
          databases: ["worldcons_core"],
          targets: { worldcons_core: target },
        }),
      /not configured/,
    );
  } finally {
    target.close?.();
  }
  await assert.rejects(
    () => buildD1ImportReport({ source: createMemoryRowSource({}), databases: ["worldcons_core"], targets: {} }),
    /no D1 import target/,
  );
});

test("the live report imports and verifies all four databases deterministically", async () => {
  const targets: Partial<Record<D1Database, D1ImportTarget>> = {};
  const opened: D1ImportTarget[] = [];
  for (const database of D1_DATABASES) {
    const target = createLocalD1Target();
    targets[database] = target;
    opened.push(target);
  }
  try {
    const report = await buildD1ImportReport({
      source: createMemoryRowSource({}),
      sourceKind: "memory",
      targetKind: "local-sqlite",
      targets,
    });
    assert.equal(report.version, D1_IMPORT_VERSION);
    assert.equal(report.stage, "d1-import");
    assert.equal(report.datasetVersion, 1);
    assert.equal(report.foundationVersion, 1);
    assert.equal(report.rowHashVersion, 1);
    assert.equal(report.databaseHashVersion, 1);
    assert.deepEqual(report.source, { kind: "memory", configured: true });
    assert.deepEqual(report.target, { kind: "local-sqlite", persistent: false });
    assert.deepEqual(report.databases.map((entry) => entry.database), [...D1_DATABASES]);
    assert.equal(report.totals.tables, 75);
    assert.equal(report.totals.rows, 0);
    assert.equal(report.totals.statements, 0);
    assert.equal(report.totals.verified, true);
    assert.ok(report.databases.every((entry) => entry.ok && entry.hash === entry.expectedHash));
    assert.ok(report.databases.every((entry) => entry.script === null));
    assert.deepEqual(report.skipped, [
      { table: "search_documents", database: "worldcons_search", reason: "derived" },
      { table: "search_fts", database: "worldcons_search", reason: "virtual" },
    ]);
    const conversion = await buildD1ConversionReport({ source: createMemoryRowSource({}), sourceKind: "memory" });
    for (const database of report.databases) {
      const expected = conversion.databases.find((entry) => entry.database === database.database);
      assert.ok(expected);
      assert.equal(database.expectedHash, expected.hash);
    }

    const again = await buildD1ImportReport({
      source: createMemoryRowSource({}),
      sourceKind: "memory",
      targetKind: "local-sqlite",
      targets,
    });
    assert.deepEqual(JSON.parse(JSON.stringify(again)), JSON.parse(JSON.stringify(report)), "the report must be deterministic");
  } finally {
    for (const target of opened) target.close?.();
  }
});

test("a real migratable table imports and verifies through the pipeline", async () => {
  const target = createLocalD1Target();
  const sourcesRow: Record<string, unknown> = {
    id: "ffffffff-0000-0000-0000-000000000001",
    source_key: "us-scotus",
    name: "Supreme Court of the United States",
    jurisdiction: "US",
    base_url: "https://www.supremecourt.gov",
    language: "en",
    is_active: true,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
  };
  try {
    const report = await buildD1ImportReport({
      source: createMemoryRowSource({ rows: { sources: [sourcesRow] } }),
      sourceKind: "memory",
      databases: ["worldcons_core"],
      targets: { worldcons_core: target },
      includeScripts: true,
    });
    const database = report.databases[0];
    assert.equal(database.database, "worldcons_core");
    assert.equal(database.tableCount, 30);
    assert.equal(database.rowCount, 1);
    assert.equal(database.ok, true, JSON.stringify(database.tables.flatMap((table) => table.errors)));

    const sources = database.tables.find((table) => table.table === "sources");
    assert.ok(sources);
    assert.equal(sources.rowCount, 1);
    assert.equal(sources.ok, true);
    assert.equal(sources.statementCount, 1);
    assert.ok(database.script?.includes("insert into sources"), "the emitted script must contain the insert");

    const stored = target.all("select source_key, is_active from sources where id = ?", [String(sourcesRow.id)]);
    assert.equal(stored.length, 1);
    assert.equal((stored[0] as { source_key: string }).source_key, "us-scotus");
    assert.equal((stored[0] as { is_active: number }).is_active, 1);
  } finally {
    target.close?.();
  }
});

test("a real ingest table imports and verifies through the pipeline", async () => {
  const target = createLocalD1Target();
  const runRow: Record<string, unknown> = {
    id: "aaaaaaaa-1111-1111-1111-111111111111",
    source_key: "m5-test",
    started_at: "2026-09-21T00:00:00Z",
    finished_at: null,
    status: "running",
    discovered_count: 3,
    fetched_count: 2,
    summarized_count: 1,
    failed_count: 0,
    error_message: null,
    metadata: { phase: "ingest", nested: { ok: true } },
  };
  try {
    const report = await buildD1ImportReport({
      source: createMemoryRowSource({ rows: { ingestion_runs: [runRow] } }),
      sourceKind: "memory",
      databases: ["worldcons_ingest"],
      targets: { worldcons_ingest: target },
    });
    const database = report.databases[0];
    assert.equal(database.database, "worldcons_ingest");
    assert.equal(database.tableCount, 26);
    assert.equal(database.rowCount, 1);
    assert.equal(database.ok, true, JSON.stringify(database.tables.flatMap((table) => table.errors)));
    assert.equal(database.hash, database.expectedHash);

    const runs = database.tables.find((table) => table.table === "ingestion_runs");
    assert.ok(runs);
    assert.equal(runs.rowCount, 1);
    assert.equal(runs.ok, true);
    assert.equal(runs.hash, runs.expectedHash);

    const stored = target.all("select discovered_count, metadata from ingestion_runs where id = ?", [String(runRow.id)]);
    assert.equal(stored.length, 1);
    assert.equal((stored[0] as { discovered_count: number }).discovered_count, 3);
    assert.equal((stored[0] as { metadata: string }).metadata, '{"nested":{"ok":true},"phase":"ingest"}');
  } finally {
    target.close?.();
  }
});

test("a real ops table imports and verifies through the pipeline", async () => {
  const target = createLocalD1Target();
  const settingsRow: Record<string, unknown> = {
    id: "default",
    settings: { provider: "gemini", retries: 2, enabled: true },
    created_at: "2026-09-21T00:00:00Z",
    updated_at: "2026-09-21T00:01:00Z",
  };
  try {
    const report = await buildD1ImportReport({
      source: createMemoryRowSource({ rows: { llm_settings: [settingsRow] } }),
      sourceKind: "memory",
      databases: ["worldcons_ops"],
      targets: { worldcons_ops: target },
    });
    const database = report.databases[0];
    assert.equal(database.database, "worldcons_ops");
    assert.equal(database.tableCount, 19);
    assert.equal(database.rowCount, 1);
    assert.equal(database.ok, true, JSON.stringify(database.tables.flatMap((table) => table.errors)));
    assert.equal(database.hash, database.expectedHash);

    const settings = database.tables.find((table) => table.table === "llm_settings");
    assert.ok(settings);
    assert.equal(settings.rowCount, 1);
    assert.equal(settings.ok, true);
    assert.equal(settings.hash, settings.expectedHash);

    const stored = target.all("select settings from llm_settings where id = ?", [String(settingsRow.id)]);
    assert.equal(stored.length, 1);
    assert.equal((stored[0] as { settings: string }).settings, '{"enabled":true,"provider":"gemini","retries":2}');
  } finally {
    target.close?.();
  }
});

test("verification reads are bounded, ordered and identifier-guarded", () => {
  const statement = d1ReadStatement(probeTable, { limit: 5, offset: 10 });
  assert.ok(statement.sql.startsWith("select id, created_at,"));
  assert.ok(statement.sql.includes("from import_probe"));
  assert.ok(statement.sql.includes("order by id"));
  assert.ok(statement.sql.endsWith("limit ? offset ?"));
  assert.deepEqual(statement.params, [5, 10]);
  assert.ok(!statement.sql.includes("search_vector"));
});

test("the node:sqlite target stays out of the runtime import barrel", () => {
  const barrel = fs.readFileSync(path.join(rootDir, "lib/cloudflare/d1/import/index.ts"), "utf8");
  assert.ok(!barrel.includes('from "./local-target"'), "the node:sqlite target must not be re-exported from the barrel");
  const localTarget = fs.readFileSync(path.join(rootDir, "lib/cloudflare/d1/import/local-target.ts"), "utf8");
  assert.ok(localTarget.includes('from "node:sqlite"'));

  const script = path.join(rootDir, "scripts", "d1-import.ts");
  assert.ok(fs.existsSync(script), "the operator CLI must exist");
  const scriptSource = fs.readFileSync(script, "utf8");
  assert.ok(scriptSource.includes("createLocalD1Target"), "the CLI must import the local target directly");
  assert.ok(scriptSource.includes("WORLDCONS_D1_SOURCE_URL"), "the CLI must gate reads behind an explicit env var");
  assert.ok(!scriptSource.includes("wrangler d1 execute"), "the CLI must not shell out to a remote D1");
  assert.ok(!scriptSource.includes("d1 create"), "the CLI must not create a remote database");
});
