import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { D1_DATABASES, buildTable, d1Schema, hashCanonicalTable } from "../lib/cloudflare/d1";
import type { D1TableDefinition } from "../lib/cloudflare/d1";
import {
  CANONICAL_DATABASE_HASH_VERSION,
  CANONICAL_DATASET_VERSION,
  assertPostgresIdentifier,
  buildD1ConversionReport,
  convertDatabase,
  convertTable,
  createMemoryRowSource,
  hashCanonicalDatabase,
  migratableTables,
  postgresReadRequest,
  postgresRelationFor,
  projectableColumns,
  relocatedColumnsFor,
  skipReason,
  sortCanonicalRows,
  summarizeDatabaseDataset,
  summarizeTableDataset,
  toCanonicalTableDataset,
} from "../lib/cloudflare/d1/convert";

const rootDir = process.cwd();

function findTable(name: string): D1TableDefinition {
  const table = d1Schema.tables.find((entry) => entry.name === name);
  assert.ok(table, `${name} must exist`);
  return table;
}

const probeTable = buildTable({
  name: "convert_probe",
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
    { name: "search_vector", type: "tsvector" },
    { name: "embedding", type: "vector(1536)" },
  ],
});

const otherTable = buildTable({
  name: "convert_other",
  database: "worldcons_core",
  primaryKey: ["id"],
  columns: [
    { name: "id", type: "uuid", nn: true },
    { name: "body", type: "text" },
  ],
});
const probeRowA: Record<string, unknown> = {
  id: "AAAAAAAA-0000-0000-0000-000000000001",
  created_at: "2026-05-08T10:00:00Z",
  is_active: true,
  payload: { b: 1, a: 2 },
  labels: ["z", "a"],
  big_counter: "9007199254740993",
  score: "1.5",
  status: "summarized",
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
  search_vector: "ignored-relocation",
  embedding: null,
};

test("the Postgres projection excludes relocated and derived columns and orders by primary key", () => {
  assert.deepEqual(projectableColumns(probeTable), [
    "id",
    "created_at",
    "is_active",
    "payload",
    "labels",
    "big_counter",
    "score",
    "status",
  ]);
  const request = postgresReadRequest(probeTable);
  assert.ok(request);
  assert.equal(request.relation, "convert_probe");
  assert.deepEqual(request.orderBy, ["id"]);
  assert.equal(request.limit, null);
  assert.equal(request.offset, 0);
  assert.ok(!request.columns.includes("search_vector") && !request.columns.includes("embedding"));
  assert.deepEqual(relocatedColumnsFor(probeTable), [
    { column: "search_vector", target: "fts5" },
    { column: "embedding", target: "vectorize" },
  ]);

  const derived = buildTable({
    name: "convert_derived",
    database: "worldcons_search",
    primaryKey: [],
    columns: [{ name: "article_id", type: "uuid", derived: true }],
  });
  assert.equal(postgresRelationFor(derived), null);
  assert.equal(postgresReadRequest(derived), null);
  assert.equal(postgresReadRequest(findTable("search_fts")), null);

  assert.equal(assertPostgresIdentifier("articles"), "articles");
  assert.throws(() => assertPostgresIdentifier("Articles"), /invalid postgres identifier/);
  assert.throws(() => assertPostgresIdentifier("articles; drop table x"), /invalid postgres identifier/);
});
test("the canonical transform reduces every plan 6.1 family and hashes by row set", () => {
  const dataset = toCanonicalTableDataset(probeTable, [probeRowA, probeRowB]);
  assert.equal(dataset.version, CANONICAL_DATASET_VERSION);
  assert.equal(dataset.table, "convert_probe");
  assert.equal(dataset.database, "worldcons_core");
  assert.equal(dataset.sourceTable, "convert_probe");
  assert.equal(dataset.rowCount, 2);
  assert.deepEqual(dataset.columns, projectableColumns(probeTable));
  assert.deepEqual(dataset.relocated, [
    { column: "search_vector", target: "fts5" },
    { column: "embedding", target: "vectorize" },
  ]);

  assert.deepEqual(dataset.rows.map((row) => row.id), [
    "aaaaaaaa-0000-0000-0000-000000000001",
    "aaaaaaaa-0000-0000-0000-000000000002",
  ]);
  const first = dataset.rows[0];
  assert.equal(first.created_at, "2026-05-08T10:00:00.000Z");
  assert.equal(first.is_active, 1);
  assert.equal(first.payload, '{"a":2,"b":1}');
  assert.equal(first.labels, '["z","a"]');
  assert.equal(first.big_counter, "9007199254740993");
  assert.equal(first.score, 1.5);
  assert.equal(first.status, "summarized");

  const second = dataset.rows[1];
  assert.equal(second.created_at, "2026-05-07T10:00:00.000Z");
  assert.equal(second.is_active, 0);
  assert.equal(second.payload, null);
  assert.equal(second.labels, "[]");
  assert.equal(second.big_counter, "12");
  assert.equal(second.score, 2);
  assert.equal(second.status, "failed");

  const reversed = toCanonicalTableDataset(probeTable, [probeRowB, probeRowA]);
  assert.equal(reversed.hash, dataset.hash, "row order must not change the table hash");
  assert.deepEqual(reversed.rows, dataset.rows);
  assert.equal(dataset.hash, hashCanonicalTable(probeTable, [probeRowA, probeRowB]).hash);
  assert.deepEqual(sortCanonicalRows(probeTable, dataset.rows).map((row) => row.id), dataset.rows.map((row) => row.id));
});

test("the canonical transform fails closed on a missing required value or a bad enum", () => {
  assert.throws(() => toCanonicalTableDataset(probeTable, [{ id: probeRowA.id }]), /NOT NULL/);
  assert.throws(() => toCanonicalTableDataset(probeTable, [{ ...probeRowA, status: "bogus" }]), /not one of/);
  assert.throws(() => toCanonicalTableDataset(probeTable, [{ ...probeRowA, id: "not-a-uuid" }]), /invalid uuid/);
});
test("database hashing is table-order independent and aggregates counts", () => {
  const a = toCanonicalTableDataset(probeTable, [probeRowA]);
  const b = toCanonicalTableDataset(otherTable, [{ id: "aaaaaaaa-0000-0000-0000-000000000003", body: "x" }]);
  const forward = hashCanonicalDatabase("worldcons_core", [a, b]);
  const reversed = hashCanonicalDatabase("worldcons_core", [b, a]);
  assert.equal(forward.hash, reversed.hash, "table order must not change the database hash");
  assert.equal(forward.tableCount, 2);
  assert.equal(forward.rowCount, 2);
  assert.deepEqual(forward.tables.map((entry) => entry.table), ["convert_other", "convert_probe"]);
  assert.equal(CANONICAL_DATABASE_HASH_VERSION, 1);
  assert.notEqual(hashCanonicalDatabase("worldcons_core", [a]).hash, forward.hash);

  const summary = summarizeTableDataset(a);
  assert.ok(!("rows" in summary));
  assert.equal(summary.hash, a.hash);
  assert.ok(!("rows" in summarizeDatabaseDataset(forward)));
});

test("the memory source projects columns and fails closed once closed", async () => {
  const rows = Array.from({ length: 5 }, (_, index) => ({
    id: `aaaaaaaa-0000-0000-0000-00000000000${index}`,
    body: `b${index}`,
    extra: "dropped",
  }));
  const source = createMemoryRowSource({ rows: { convert_other: rows } });
  const batch = await source.readRows({ relation: "convert_other", columns: ["id", "body"], orderBy: ["id"], limit: 2, offset: 1 });
  assert.deepEqual(batch, [
    { id: "aaaaaaaa-0000-0000-0000-000000000001", body: "b1" },
    { id: "aaaaaaaa-0000-0000-0000-000000000002", body: "b2" },
  ]);
  await source.close();
  await assert.rejects(
    () => source.readRows({ relation: "convert_other", columns: ["id"], orderBy: ["id"], limit: null, offset: 0 }),
    /closed/,
  );
});
test("convertTable bounds reads with batchSize and maxRows", async () => {
  const rows = Array.from({ length: 5 }, (_, index) => ({ id: `aaaaaaaa-0000-0000-0000-00000000000${index}`, body: `b${index}` }));
  const source = createMemoryRowSource({ rows: { convert_other: rows } });
  assert.equal((await convertTable(otherTable, source, { batchSize: 2, maxRows: 3 })).rowCount, 3);
  assert.equal((await convertTable(otherTable, source, { batchSize: 2 })).rowCount, 5);
  await assert.rejects(() => convertTable(otherTable, source, { batchSize: 0 }), /batchSize/);
});

test("an unconfigured source fails closed instead of returning an empty dataset", async () => {
  const source = createMemoryRowSource({ configured: false });
  assert.equal(source.isConfigured(), false);
  await assert.rejects(() => convertDatabase("worldcons_core", source), /not configured/);
  await assert.rejects(() => buildD1ConversionReport({ source, sourceKind: "memory" }), /not configured/);
});
test("the live report covers four databases and skips the derived search projection", async () => {
  const report = await buildD1ConversionReport({ source: createMemoryRowSource({}), sourceKind: "memory" });
  assert.equal(report.version, CANONICAL_DATASET_VERSION);
  assert.equal(report.stage, "canonical-transform");
  assert.equal(report.foundationVersion, 1);
  assert.equal(report.rowHashVersion, 1);
  assert.equal(report.databaseHashVersion, CANONICAL_DATABASE_HASH_VERSION);
  assert.deepEqual(report.source, { kind: "memory", configured: true });
  assert.deepEqual(report.databases.map((entry) => entry.database), [...D1_DATABASES]);
  assert.equal(report.totals.databases, 4);
  assert.equal(report.totals.tables, 75);
  assert.equal(report.totals.rows, 0);

  const search = report.databases.find((entry) => entry.database === "worldcons_search");
  assert.ok(search);
  assert.equal(search.tableCount, 0);
  assert.deepEqual(report.skipped, [
    { table: "search_documents", database: "worldcons_search", reason: "derived" },
    { table: "search_fts", database: "worldcons_search", reason: "virtual" },
  ]);

  const articles = report.databases
    .find((entry) => entry.database === "worldcons_core")
    ?.tables.find((entry) => entry.table === "articles");
  assert.ok(articles);
  assert.deepEqual(articles.relocated, [
    { column: "raw_text", target: "r2" },
    { column: "search_vector", target: "fts5" },
    { column: "embedding", target: "vectorize" },
  ]);
  assert.ok(!articles.columns.includes("raw_text"), "raw_text must be relocated to R2, not projected");
  assert.ok(articles.columns.includes("cleaned_text"), "cleaned_text must stay inline in D1");
  assert.ok(!articles.columns.includes("search_vector") && !articles.columns.includes("embedding"));

  const versions = report.databases
    .find((entry) => entry.database === "worldcons_core")
    ?.tables.find((entry) => entry.table === "article_content_versions_p3");
  assert.ok(versions);
  assert.deepEqual(versions.relocated, [
    { column: "raw_text", target: "r2" },
    { column: "search_vector", target: "fts5" },
    { column: "embedding", target: "vectorize" },
  ]);
  assert.ok(!versions.columns.includes("raw_text"), "raw_text must be relocated to R2, not projected");
  assert.ok(versions.columns.includes("cleaned_text"), "cleaned_text must stay inline in D1");
  assert.ok(!versions.columns.includes("search_vector") && !versions.columns.includes("embedding"));

  const versionsTable = findTable("article_content_versions_p3");
  assert.ok(!versionsTable.columns.some((column) => column.name === "raw_text"));
  assert.ok(projectableColumns(versionsTable).includes("cleaned_text"));
  assert.ok(!projectableColumns(versionsTable).includes("raw_text"));

  const again = await buildD1ConversionReport({ source: createMemoryRowSource({}), sourceKind: "memory" });
  assert.deepEqual(again, report, "the report must be deterministic");
  assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
});
test("the pipeline classifies migratable and skipped tables", () => {
  assert.equal(migratableTables(d1Schema, "worldcons_search").length, 0);
  assert.equal(migratableTables(d1Schema, "worldcons_core").length, 30);
  assert.equal(migratableTables(d1Schema, "worldcons_ingest").length, 26);
  assert.equal(migratableTables(d1Schema, "worldcons_ops").length, 19);
  assert.ok(migratableTables(d1Schema, "worldcons_core").some((entry) => entry.name === "articles"));
  assert.equal(skipReason(findTable("search_fts")), "virtual");
  assert.equal(skipReason(findTable("search_documents")), "derived");
  assert.equal(skipReason(findTable("articles")), null);
});

test("the pg-backed operator source stays out of the runtime convert barrel", () => {
  const barrel = fs.readFileSync(path.join(rootDir, "lib/cloudflare/d1/convert/index.ts"), "utf8");
  assert.ok(!barrel.includes('from "./postgres-source"'), "the pg-backed source must not be re-exported from the barrel");
  const script = path.join(rootDir, "scripts", "d1-convert.ts");
  assert.ok(fs.existsSync(script), "the operator CLI must exist");
  const scriptSource = fs.readFileSync(script, "utf8");
  assert.ok(scriptSource.includes("createPostgresRowSource"), "the CLI must import the read-only pg source");
  assert.ok(scriptSource.includes("WORLDCONS_D1_SOURCE_URL"), "the CLI must gate reads behind an explicit env var");
  assert.ok(!scriptSource.includes("d1 execute"), "the CLI must not execute D1 DDL/DML");
});