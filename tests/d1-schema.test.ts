import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  D1_CANONICAL_KINDS,
  D1_DATABASES,
  POSTGRES_TYPE_MAPPING_RULES,
  buildD1SchemaReport,
  buildTable,
  canonicalizeArrayText,
  canonicalizeBigIntText,
  canonicalizeBoolean,
  canonicalizeEnum,
  canonicalizeInteger,
  canonicalizeJsonText,
  canonicalizeReal,
  canonicalizeText,
  canonicalizeTimestamp,
  canonicalizeUuid,
  columnCanonicalKind,
  compareCanonicalScalar,
  d1Schema,
  emitAllDatabaseDdl,
  emitDatabaseDdl,
  emitTableDdl,
  hashCanonicalRow,
  hashCanonicalTable,
  mapPostgresType,
  normalizePostgresType,
  normalizeScannedType,
  postgresTypeCanonicalKind,
  scanPostgresSchema,
  uniqueIndex,
  validateD1Schema,
} from "../lib/cloudflare/d1";
import type {
  D1ColumnDefinition,
  D1Database,
  D1OwnershipEntry,
  D1Schema,
  D1TableDefinition,
  PostgresColumnDefinition,
  PostgresSchemaRegistry,
  PostgresTableDefinition,
} from "../lib/cloudflare/d1";
const rootDir = process.cwd();

function pgColumn(name: string, type: string, overrides: Partial<PostgresColumnDefinition> = {}): PostgresColumnDefinition {
  return { name, type, notNull: false, hasDefault: false, primaryKey: false, ...overrides };
}

function pgTable(
  name: string,
  columns: PostgresColumnDefinition[],
  overrides: Partial<PostgresTableDefinition> = {},
): PostgresTableDefinition {
  return {
    name,
    columns,
    primaryKey: columns.filter((column) => column.primaryKey).map((column) => column.name),
    enumChecks: {},
    ...overrides,
  };
}

function registry(tables: PostgresTableDefinition[]): PostgresSchemaRegistry {
  const byName: Record<string, PostgresTableDefinition> = {};
  for (const table of tables) byName[table.name] = table;
  return { version: 1, filesScanned: 0, statementsScanned: 0, enums: {}, tables: byName, indexes: {} };
}

function schemaWith(tables: D1TableDefinition[], ownership: D1OwnershipEntry[]): D1Schema {
  return { version: 1, databases: [...D1_DATABASES], tables, ownership };
}

function covered(table: string, database: D1Database): D1OwnershipEntry {
  return { table, database, status: "covered", note: `${table} covered` };
}

function planned(table: string, database: D1Database): D1OwnershipEntry {
  return { table, database, status: "planned", note: `${table} planned` };
}

function errorCodes(schema: D1Schema, reg: PostgresSchemaRegistry): string[] {
  return validateD1Schema(schema, reg).errors.map((error) => error.code);
}

function columnOf(table: D1TableDefinition, name: string): D1ColumnDefinition {
  const column = table.columns.find((entry) => entry.name === name);
  assert.ok(column, `${table.name}.${name} must exist`);
  return column;
}

function mappingKind(type: string, enums: string[] = []): string {
  const mapping = mapPostgresType(type, new Set(enums));
  assert.ok(mapping, `${type} must map to a D1 target`);
  return "relocated" in mapping ? `relocated:${mapping.relocated}` : mapping.kind;
}
test("the live D1 schema validates against the scanned Postgres DDL", () => {
  const report = buildD1SchemaReport(rootDir);

  assert.equal(report.validation.ok, true, JSON.stringify(report.validation.errors));
  assert.deepEqual(report.validation.errors, []);
  assert.deepEqual(report.validation.warnings, []);
  assert.equal(report.summary.tables, 77);
  assert.equal(report.summary.coveredTables, 77);
  assert.equal(report.summary.plannedTables, 0);
  assert.equal(report.summary.postgresTables, 75);
  assert.deepEqual(report.summary.databases, [...D1_DATABASES]);
  assert.equal(report.foundationVersion, 1);
  assert.equal(report.rowHashVersion, 1);

  const byDatabase = new Map<string, number>();
  for (const table of report.tables) byDatabase.set(table.database, (byDatabase.get(table.database) ?? 0) + 1);
  for (const database of D1_DATABASES) {
    assert.ok((byDatabase.get(database) ?? 0) > 0, `${database} must own at least one covered table`);
  }

  const articles = report.tables.find((table) => table.name === "articles");
  assert.ok(articles);
  assert.deepEqual(articles.primaryKey, ["id"]);
  assert.equal(articles.columns, 56);
  assert.deepEqual(articles.relocated, ["search_vector->fts5", "embedding->vectorize"]);

  const searchFts = report.tables.find((table) => table.name === "search_fts");
  assert.ok(searchFts);
  assert.equal(searchFts.columns, 0);
  assert.deepEqual(searchFts.primaryKey, []);

  const versions = report.tables.find((table) => table.name === "article_content_versions_p3");
  assert.ok(versions);
  assert.deepEqual(versions.primaryKey, ["id"]);
  assert.equal(versions.columns, 45);
  assert.deepEqual(versions.relocated, ["search_vector->fts5", "embedding->vectorize"]);

  const corpusPolicies = report.tables.find((table) => table.name === "source_corpus_policies");
  assert.ok(corpusPolicies);
  assert.deepEqual(corpusPolicies.primaryKey, ["source_key", "policy_version"]);

  const backfillItems = report.tables.find((table) => table.name === "source_backfill_items");
  assert.ok(backfillItems);
  assert.deepEqual(backfillItems.primaryKey, ["id"]);
  assert.equal(backfillItems.columns, 39);

  const adminCommandRuns = report.tables.find((table) => table.name === "admin_command_runs");
  assert.ok(adminCommandRuns);
  assert.equal(adminCommandRuns.indexes, 2);

  const rateLimitBuckets = report.tables.find((table) => table.name === "security_rate_limit_buckets_v1");
  assert.ok(rateLimitBuckets);
  assert.deepEqual(rateLimitBuckets.primaryKey, ["profile", "identifier_hash"]);

  const compatibility = report.tables.find((table) => table.name === "admin_compatibility_observations_p5");
  assert.ok(compatibility);
  assert.equal(compatibility.primaryKey.length, 6);
});
test("the checked-in d1/<database>/0001_init.sql matches the emitter", () => {
  const emitted = emitAllDatabaseDdl(d1Schema);
  assert.deepEqual(Object.keys(emitted).sort(), [...D1_DATABASES].sort());
  for (const database of D1_DATABASES) {
    const file = path.join(rootDir, "d1", database, "0001_init.sql");
    assert.ok(fs.existsSync(file), `d1/${database}/0001_init.sql must be committed`);
    assert.equal(fs.readFileSync(file, "utf8"), emitted[database], `d1/${database}/0001_init.sql must match the emitter`);
    assert.equal(emitDatabaseDdl(database, d1Schema), emitted[database]);
    assert.ok(emitted[database].includes("LOCAL ONLY"), `${database} DDL must stay local-only`);
  }
});

test("the emitted DDL applies to an in-memory SQLite database and the FTS5 projection searches", () => {
  const emitted = emitAllDatabaseDdl(d1Schema);
  for (const database of D1_DATABASES) {
    const db = new DatabaseSync(":memory:");
    db.exec(emitted[database]);
    const rows = db.prepare("select name from sqlite_master where type in ('table','view')").all() as Array<{ name: string }>;
    const present = new Set(rows.map((row) => row.name));
    for (const table of d1Schema.tables.filter((entry) => entry.database === database)) {
      assert.ok(present.has(table.name), `${database} DDL must create ${table.name}`);
    }
    db.exec(emitted[database]);
    db.close();
  }

  const search = new DatabaseSync(":memory:");
  search.exec(emitted.worldcons_search);
  search.exec("insert into search_documents (article_id, updated_at) values ('a1', '2026-01-01T00:00:00.000Z')");
  search.exec(
    "insert into search_fts (article_id, title, case_numbers, search_text, tags_text) values ('a1', 'Due process', '1 BvR 1/25', 'due process text', 'hnb')",
  );
  const hits = search.prepare("select article_id from search_fts where search_fts match ?").all("due") as Array<{ article_id: string }>;
  assert.deepEqual(hits.map((hit) => hit.article_id), ["a1"]);
  search.close();
});
test("Postgres types map to the plan 6.1 D1 storage targets", () => {
  assert.equal(mappingKind("uuid"), "text");
  assert.equal(mappingKind("text"), "text");
  assert.equal(mappingKind("citext"), "text");
  assert.equal(mappingKind("character varying"), "text");
  assert.equal(mappingKind("timestamptz"), "text");
  assert.equal(mappingKind("timestamp with time zone"), "text");
  assert.equal(mappingKind("date"), "text");
  assert.equal(mappingKind("time"), "text");
  assert.equal(mappingKind("jsonb"), "text");
  assert.equal(mappingKind("json"), "text");
  assert.equal(mappingKind("boolean"), "integer");
  assert.equal(mappingKind("bool"), "integer");
  assert.equal(mappingKind("smallint"), "integer");
  assert.equal(mappingKind("integer"), "integer");
  assert.equal(mappingKind("serial"), "integer");
  assert.equal(mappingKind("bigint"), "text");
  assert.equal(mappingKind("bigserial"), "text");
  assert.equal(mappingKind("numeric"), "real");
  assert.equal(mappingKind("decimal"), "real");
  assert.equal(mappingKind("double precision"), "real");
  assert.equal(mappingKind("real"), "real");
  assert.equal(mappingKind("bytea"), "blob");
  assert.equal(mappingKind("text[]"), "text");
  assert.equal(mappingKind("integer[]"), "text");
  assert.equal(mappingKind("tsvector"), "relocated:fts5");
  assert.equal(mappingKind("vector(1536)"), "relocated:vectorize");
  assert.equal(mappingKind("vector"), "relocated:vectorize");
  assert.equal(mappingKind("extensions.vector"), "relocated:vectorize");
  assert.equal(mappingKind("extensions.vector(1536)"), "relocated:vectorize");
  assert.equal(mappingKind("article_status", ["article_status"]), "text");

  assert.equal(mapPostgresType(""), null);
  assert.equal(mapPostgresType("geometry"), null, "unmapped types must fail closed instead of defaulting to text");
});
test("type names normalize and canonical families mirror the type mapping", () => {
  assert.equal(normalizePostgresType("  Timestamp   WITH TIME ZONE "), "timestamp with time zone");
  assert.equal(normalizeScannedType("character varying(255)"), "character varying");
  assert.equal(normalizeScannedType("numeric(10, 2)"), "numeric");
  assert.equal(normalizeScannedType("vector(1536)"), "vector(1536)");
  assert.equal(normalizeScannedType("vector"), "vector");

  assert.equal(postgresTypeCanonicalKind("uuid"), "uuid");
  assert.equal(postgresTypeCanonicalKind("timestamptz"), "timestamp");
  assert.equal(postgresTypeCanonicalKind("jsonb"), "json");
  assert.equal(postgresTypeCanonicalKind("text[]"), "array");
  assert.equal(postgresTypeCanonicalKind("bigint"), "bigint");
  assert.equal(postgresTypeCanonicalKind("boolean"), "boolean");
  assert.equal(postgresTypeCanonicalKind("integer"), "integer");
  assert.equal(postgresTypeCanonicalKind("numeric"), "real");
  assert.equal(postgresTypeCanonicalKind("bytea"), "blob");
  assert.equal(postgresTypeCanonicalKind("tsvector"), "fts5");
  assert.equal(postgresTypeCanonicalKind("vector(1536)"), "vectorize");
  assert.equal(postgresTypeCanonicalKind("mystery"), null);
  assert.ok(D1_CANONICAL_KINDS.includes("fts5") && D1_CANONICAL_KINDS.includes("vectorize"));
});

test("the documented mapping rules cover every plan 6.1 construct", () => {
  const patterns = POSTGRES_TYPE_MAPPING_RULES.map((rule) => rule.pattern);
  for (const expected of [
    "uuid",
    "jsonb / json",
    "boolean",
    "bigint / bigserial",
    "numeric / double precision / real",
    "text[] / arrays",
    "enums (create type ... as enum)",
    "bytea",
    "tsvector",
    "vector(1536)",
  ]) {
    assert.ok(patterns.includes(expected), `${expected} must be documented in the mapping rules`);
  }
  for (const rule of POSTGRES_TYPE_MAPPING_RULES) {
    assert.ok(rule.target.length > 0 && rule.note.length > 0, "every mapping rule needs a target and a note");
  }
});
test("canonical scalar converters are deterministic and fail closed", () => {
  assert.equal(canonicalizeUuid("  AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE "), "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  assert.throws(() => canonicalizeUuid("not-a-uuid"), /invalid uuid/);
  assert.throws(() => canonicalizeUuid(42), /must be a string/);

  assert.equal(canonicalizeTimestamp("2026-05-08T10:00:00Z"), "2026-05-08T10:00:00.000Z");
  assert.equal(canonicalizeTimestamp(new Date("2026-05-08T10:00:00Z")), "2026-05-08T10:00:00.000Z");
  assert.equal(canonicalizeTimestamp(Date.parse("2026-05-08T10:00:00Z")), "2026-05-08T10:00:00.000Z");
  assert.throws(() => canonicalizeTimestamp("not a date"), /invalid timestamp/);

  assert.equal(canonicalizeBoolean(true), 1);
  assert.equal(canonicalizeBoolean("t"), 1);
  assert.equal(canonicalizeBoolean("false"), 0);
  assert.equal(canonicalizeBoolean(0), 0);
  assert.throws(() => canonicalizeBoolean("yes"), /invalid boolean/);

  assert.equal(canonicalizeInteger("42"), 42);
  assert.throws(() => canonicalizeInteger(1.5), /invalid integer/);
  assert.throws(() => canonicalizeInteger(Number.MAX_SAFE_INTEGER + 1), /invalid integer/);

  assert.equal(canonicalizeBigIntText("9007199254740993"), "9007199254740993");
  assert.equal(canonicalizeBigIntText(9007199254740993n), "9007199254740993");
  assert.equal(canonicalizeBigIntText(12.9), "12");
  assert.throws(() => canonicalizeBigIntText("1.5"), /invalid bigint/);

  assert.equal(canonicalizeReal("3.5"), 3.5);
  assert.throws(() => canonicalizeReal(Number.NaN), /invalid real/);

  assert.equal(canonicalizeJsonText({ b: 1, a: [2, { d: 4, c: 3 }] }), '{"a":[2,{"c":3,"d":4}],"b":1}');
  assert.equal(canonicalizeJsonText(undefined), "null");

  assert.equal(canonicalizeArrayText(["b", "a"]), '["b","a"]');
  assert.throws(() => canonicalizeArrayText("nope"), /array column/);

  assert.equal(canonicalizeEnum("summarized", ["summarized", "failed"]), "summarized");
  assert.throws(() => canonicalizeEnum("bogus", ["summarized"]), /not one of/);

  assert.equal(canonicalizeText("x"), "x");
  assert.equal(canonicalizeText(5), "5");
  assert.equal(canonicalizeText(false), "false");
  assert.equal(canonicalizeText(null), null);
  assert.throws(() => canonicalizeText({}), /text column/);
});
const hashTable = buildTable({
  name: "hash_probe",
  database: "worldcons_core",
  primaryKey: ["id"],
  columns: [
    { name: "id", type: "uuid", nn: true },
    { name: "created_at", type: "timestamptz", nn: true },
    { name: "is_active", type: "boolean", nn: true },
    { name: "payload", type: "jsonb" },
    { name: "score", type: "numeric" },
    { name: "labels", type: "text[]" },
  ],
});

const rowA: Record<string, unknown> = {
  id: "ABCDEF00-0000-0000-0000-00000000000B",
  created_at: "2026-05-08T10:00:00Z",
  is_active: true,
  payload: { b: 1, a: 2 },
  score: "1.5",
  labels: ["z", "a"],
};
const rowB: Record<string, unknown> = {
  id: "abcdef00-0000-0000-0000-00000000000a",
  created_at: "2026-05-07T10:00:00Z",
  is_active: false,
  payload: null,
  score: 2,
  labels: [],
};

test("canonical table hashes are stable across key order and row order", () => {
  const first = hashCanonicalRow(hashTable, rowA);
  const reordered: Record<string, unknown> = {};
  for (const key of Object.keys(rowA).reverse()) reordered[key] = rowA[key];
  assert.equal(hashCanonicalRow(hashTable, reordered), first, "input key order must not change a row hash");
  assert.equal(
    hashCanonicalRow(hashTable, { ...rowA, id: "abcdef00-0000-0000-0000-00000000000b" }),
    first,
    "uuid casing must not change a row hash",
  );

  const forward = hashCanonicalTable(hashTable, [rowA, rowB]);
  const reversed = hashCanonicalTable(hashTable, [rowB, rowA]);
  assert.equal(forward.hash, reversed.hash, "row order must not change a table hash");
  assert.equal(forward.rowCount, 2);
  assert.equal(forward.table, "hash_probe");
  assert.equal(forward.version, 1);

  assert.notEqual(hashCanonicalTable(hashTable, [{ ...rowA, score: 9 }, rowB]).hash, forward.hash);
});
test("canonical hashing fails closed on a missing NOT NULL value", () => {
  assert.throws(() => hashCanonicalRow(hashTable, { id: rowA.id, created_at: rowA.created_at }), /NOT NULL/);
});

test("compareCanonicalScalar orders nulls first and numbers numerically", () => {
  assert.equal(compareCanonicalScalar(null, 1), -1);
  assert.equal(compareCanonicalScalar(1, null), 1);
  assert.ok(compareCanonicalScalar(2, 10) < 0);
  assert.ok(compareCanonicalScalar("a", "b") < 0);
  assert.equal(compareCanonicalScalar(3, 3), 0);
});

test("columnCanonicalKind honors enum overrides and the Postgres source type", () => {
  const table = buildTable({
    name: "kind_probe",
    database: "worldcons_core",
    primaryKey: ["id"],
    columns: [
      { name: "id", type: "uuid", nn: true },
      { name: "flag", type: "boolean", nn: true },
      { name: "status", type: "text", enum: ["a", "b"], nn: true },
      { name: "amount", type: "numeric" },
      { name: "blob", type: "bytea" },
      { name: "derived", type: "text", derived: true },
    ],
  });
  assert.equal(columnCanonicalKind(columnOf(table, "id")), "uuid");
  assert.equal(columnCanonicalKind(columnOf(table, "flag")), "boolean");
  assert.equal(columnCanonicalKind(columnOf(table, "status")), "text");
  assert.equal(columnCanonicalKind(columnOf(table, "amount")), "real");
  assert.equal(columnCanonicalKind(columnOf(table, "blob")), "blob");
  assert.equal(columnCanonicalKind(columnOf(table, "derived")), "text");
});
test("validateD1Schema accepts a covered table with full column parity", () => {
  const table = buildTable({
    name: "probe",
    database: "worldcons_core",
    primaryKey: ["id"],
    columns: [
      { name: "id", type: "uuid", nn: true },
      { name: "flag", type: "boolean", nn: true },
      { name: "amount", type: "numeric" },
      { name: "payload", type: "jsonb" },
      { name: "labels", type: "text[]" },
      { name: "embedding", type: "vector(1536)" },
    ],
  });
  const source = pgTable("probe", [
    pgColumn("id", "uuid", { notNull: true, primaryKey: true }),
    pgColumn("flag", "boolean", { notNull: true }),
    pgColumn("amount", "numeric"),
    pgColumn("payload", "jsonb"),
    pgColumn("labels", "text[]"),
    pgColumn("embedding", "vector(1536)"),
  ]);
  const result = validateD1Schema(schemaWith([table], [covered("probe", "worldcons_core")]), registry([source]));

  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.tableCount, 1);
  assert.equal(result.coveredTableCount, 1);
  assert.equal(result.plannedTableCount, 0);
});

test("validateD1Schema rejects a covered table that omits or mistypes a Postgres column", () => {
  const omit = buildTable({
    name: "probe",
    database: "worldcons_core",
    primaryKey: ["id"],
    columns: [{ name: "id", type: "uuid", nn: true }],
  });
  const source = pgTable("probe", [pgColumn("id", "uuid", { primaryKey: true }), pgColumn("extra", "text")]);
  assert.ok(
    errorCodes(schemaWith([omit], [covered("probe", "worldcons_core")]), registry([source])).includes("uncovered-postgres-column"),
  );

  const mistyped = buildTable({
    name: "probe",
    database: "worldcons_core",
    primaryKey: ["id"],
    columns: [
      { name: "id", type: "uuid", nn: true },
      { name: "flag", type: "text", nn: true },
    ],
  });
  const flagSource = pgTable("probe", [pgColumn("id", "uuid", { primaryKey: true }), pgColumn("flag", "boolean")]);
  assert.ok(
    errorCodes(schemaWith([mistyped], [covered("probe", "worldcons_core")]), registry([flagSource])).includes("storage-kind-mismatch"),
  );
});
test("validateD1Schema enforces ownership and relocation parity", () => {
  const table = buildTable({
    name: "probe",
    database: "worldcons_core",
    primaryKey: ["id"],
    columns: [{ name: "id", type: "uuid", nn: true }],
  });
  const source = pgTable("probe", [pgColumn("id", "uuid", { primaryKey: true }), pgColumn("vec", "tsvector")]);

  assert.ok(errorCodes(schemaWith([], []), registry([source])).includes("unowned-postgres-table"));
  assert.ok(errorCodes(schemaWith([], [covered("probe", "worldcons_core")]), registry([source])).includes("covered-without-d1-table"));
  assert.ok(errorCodes(schemaWith([table], []), registry([source])).includes("d1-table-without-ownership"));
  assert.ok(errorCodes(schemaWith([table], [covered("probe", "worldcons_ops")]), registry([source])).includes("ownership-database-mismatch"));

  const plannedWithTable = schemaWith([table], [planned("probe", "worldcons_core")]);
  const plannedCodes = errorCodes(plannedWithTable, registry([source]));
  assert.ok(plannedCodes.includes("planned-table-has-d1-table"));
  assert.ok(plannedCodes.includes("covered-table-marked-planned"));

  assert.ok(errorCodes(schemaWith([], [planned("ghost", "worldcons_core")]), registry([])).includes("planned-table-not-found"));

  const missingRelocation = schemaWith([table], [covered("probe", "worldcons_core")]);
  assert.ok(errorCodes(missingRelocation, registry([source])).includes("uncovered-postgres-column"));

  const wrongTarget = buildTable({
    name: "probe",
    database: "worldcons_core",
    primaryKey: ["id"],
    columns: [
      { name: "id", type: "uuid", nn: true },
      { name: "vec", type: "vector(1536)" },
    ],
  });
  assert.ok(
    errorCodes(schemaWith([wrongTarget], [covered("probe", "worldcons_core")]), registry([source])).includes("relocation-target-mismatch"),
  );
});
test("validateD1Schema rejects internal inconsistencies", () => {
  const noPrimaryKey = buildTable({
    name: "probe",
    database: "worldcons_core",
    primaryKey: [],
    columns: [{ name: "id", type: "uuid", nn: true }],
  });
  assert.ok(errorCodes(schemaWith([noPrimaryKey], []), registry([])).includes("missing-primary-key"));

  const badIndex = buildTable({
    name: "probe",
    database: "worldcons_core",
    primaryKey: ["id"],
    indexes: [uniqueIndex("probe_bad_key", ["missing"])],
    columns: [{ name: "id", type: "uuid", nn: true }],
  });
  assert.ok(errorCodes(schemaWith([badIndex], []), registry([])).includes("unknown-index-column"));

  const duplicated = schemaWith([badIndex, badIndex], []);
  assert.ok(errorCodes(duplicated, registry([])).includes("duplicate-table"));

  const virtualWithColumns = buildTable({
    name: "search_probe",
    database: "worldcons_search",
    primaryKey: [],
    columns: [{ name: "body", type: "text" }],
    virtual: { module: "fts5", columns: ["body"] },
  });
  assert.ok(errorCodes(schemaWith([virtualWithColumns], []), registry([])).includes("virtual-table-constraints"));

  const enumOnInteger = buildTable({
    name: "probe",
    database: "worldcons_core",
    primaryKey: ["id"],
    columns: [{ name: "id", type: "uuid", nn: true }, { name: "level", type: "integer", enum: ["a", "b"] }],
  });
  assert.ok(errorCodes(schemaWith([enumOnInteger], []), registry([])).includes("enum-non-text"));

  assertEqualCodes(errorCodes(schemaWith([tableMissingSource()], [covered("missing_source", "worldcons_core")]), registry([])), [
    "source-table-not-found",
  ]);
});

function tableMissingSource(): D1TableDefinition {
  return buildTable({
    name: "missing_source",
    database: "worldcons_core",
    sourceTable: "missing_source",
    primaryKey: ["id"],
    columns: [{ name: "id", type: "uuid", nn: true }],
  });
}

function assertEqualCodes(actual: string[], expected: string[]): void {
  for (const code of expected) assert.ok(actual.includes(code), `expected ${code} in ${actual.join(", ")}`);
}
test("validateD1Schema flags enum-check drift and warns on an unmodeled enum", () => {
  const source = pgTable("probe", [pgColumn("id", "uuid", { primaryKey: true }), pgColumn("status", "text")], {
    enumChecks: { status: ["a", "b"] },
  });

  const drift = buildTable({
    name: "probe",
    database: "worldcons_core",
    primaryKey: ["id"],
    columns: [
      { name: "id", type: "uuid", nn: true },
      { name: "status", type: "text", enum: ["a", "c"] },
    ],
  });
  assert.ok(errorCodes(schemaWith([drift], [covered("probe", "worldcons_core")]), registry([source])).includes("enum-check-drift"));

  const unmodeled = buildTable({
    name: "probe",
    database: "worldcons_core",
    primaryKey: ["id"],
    columns: [
      { name: "id", type: "uuid", nn: true },
      { name: "status", type: "text" },
    ],
  });
  const result = validateD1Schema(schemaWith([unmodeled], [covered("probe", "worldcons_core")]), registry([source]));
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.ok(result.warnings.some((warning) => warning.code === "unmodeled-enum-check"));
});
test("emitTableDdl emits deterministic DDL with enum checks and indexes", () => {
  const table = buildTable({
    name: "emit_probe",
    database: "worldcons_core",
    primaryKey: ["id"],
    indexes: [uniqueIndex("emit_probe_slug_key", ["slug"])],
    columns: [
      { name: "id", type: "uuid", nn: true },
      { name: "slug", type: "text", nn: true },
      { name: "status", type: "text", nn: true, def: "'new'", enum: ["new", "old"] },
    ],
  });
  const ddl = emitTableDdl(table);
  assert.ok(ddl.includes("create table if not exists emit_probe"));
  assert.ok(ddl.includes("status text not null default 'new' check (status in ('new', 'old'))"));
  assert.ok(ddl.includes("create unique index if not exists emit_probe_slug_key on emit_probe (slug);"));

  const searchFts = d1Schema.tables.find((entry) => entry.name === "search_fts");
  assert.ok(searchFts);
  assert.equal(
    emitTableDdl(searchFts),
    "create virtual table if not exists search_fts using fts5(article_id UNINDEXED, title, case_numbers, search_text, tags_text);",
  );
});
test("buildD1SchemaReport emits a machine-readable, sorted M5.1c report", () => {
  const report = buildD1SchemaReport(rootDir);

  assert.equal(report.version, 1);
  assert.deepEqual(report.mappingRules, POSTGRES_TYPE_MAPPING_RULES);
  assert.equal(report.generatedFrom.migrations, 92);
  assert.equal(report.generatedFrom.statements, 1174);

  const sorted = [...report.tables].sort(
    (left, right) => left.database.localeCompare(right.database) || left.name.localeCompare(right.name),
  );
  assert.deepEqual(
    report.tables.map((table) => `${table.database}::${table.name}`),
    sorted.map((table) => `${table.database}::${table.name}`),
  );

  const roundTripped = JSON.parse(JSON.stringify(report)) as typeof report;
  assert.deepEqual(roundTripped.validation, report.validation);
  for (const table of roundTripped.tables) {
    assert.ok(Number.isInteger(table.columns) && table.columns >= 0);
    assert.ok(Array.isArray(table.primaryKey));
    assert.ok(Array.isArray(table.relocated));
  }
});

test("the Postgres scanner is read-only, deterministic and finds the source tables", () => {
  const first = scanPostgresSchema({ rootDir });
  const second = scanPostgresSchema({ rootDir });

  assert.deepEqual(first, second, "scanning the same tree twice must be deterministic");
  assert.equal(first.filesScanned, 92);
  assert.equal(first.statementsScanned, 1174);
  assert.equal(Object.keys(first.tables).length, 75);

  const articles = first.tables.articles;
  assert.ok(articles);
  assert.ok(articles.columns.length > 50);
  assert.deepEqual(articles.primaryKey, ["id"]);
  assert.ok(articles.columns.some((column) => column.name === "search_vector" && column.type === "tsvector"));
  assert.ok(articles.columns.some((column) => column.name === "embedding" && column.type === "vector(1536)"));
  assert.ok(first.tables.source_url_candidates);
  assert.ok(first.tables.admin_jobs);
  assert.deepEqual(first.tables.source_corpus_policies.enumChecks.normalize_replay_policy, [
    "full_snapshot",
    "bounded_evidence",
    "non_replayable",
  ]);
});