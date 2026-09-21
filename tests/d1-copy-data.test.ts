import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { canonicalJson } from "../lib/backfill/canonical-json";
import {
  buildTable,
  columnCanonicalKind,
  d1Schema,
  type D1Database,
  type D1Schema,
  type D1TableDefinition,
} from "../lib/cloudflare/d1";
import {
  toCanonicalTableDataset,
  type PostgresReadRequest,
  type PostgresRowSource,
} from "../lib/cloudflare/d1/convert";
import type { WranglerD1Runner } from "../lib/cloudflare/d1/remote";
import { buildD1RemoteDataCopyManifest, D1_REMOTE_DATA_COPY_DATABASES } from "../lib/cloudflare/d1/remote/data-copy";

const copyTable = buildTable({
  name: "copy_probe",
  database: "worldcons_core",
  primaryKey: ["id"],
  columns: [
    { name: "id", type: "text", nn: true },
    { name: "body", type: "text" },
    { name: "rank", type: "integer" },
  ],
});

const schema: D1Schema = { version: 1, databases: ["worldcons_core"], tables: [copyTable], ownership: [] };

const SOURCE_ROWS: Record<string, unknown>[] = Array.from({ length: 6 }, (_, index) => ({
  id: `row-${index + 1}`,
  body: `body ${index + 1}`,
  rank: index + 1,
}));

/** Canonical rows are idempotent under re-canonicalization, so a store of them is a faithful remote. */
const FULL_ROWS = toCanonicalTableDataset(copyTable, SOURCE_ROWS).rows;

/** A second compact table exercising the JSON, array, bigint-text and boolean canonical families. */
const richTable = buildTable({
  name: "copy_rich",
  database: "worldcons_core",
  primaryKey: ["id"],
  columns: [
    { name: "id", type: "text", nn: true },
    { name: "payload", type: "jsonb" },
    { name: "labels", type: "text[]" },
    { name: "bignum", type: "bigint" },
    { name: "active", type: "boolean" },
  ],
});

const richSchema: D1Schema = { version: 1, databases: ["worldcons_core"], tables: [richTable], ownership: [] };

/** Two core migratable tables, so a `tables` selection can prove it narrows the copy. */
const pairSchema: D1Schema = {
  version: 1,
  databases: ["worldcons_core"],
  tables: [copyTable, richTable],
  ownership: [],
};

const RICH_SOURCE_ROWS: Record<string, unknown>[] = [
  { id: "rich-2", payload: { beta: 2, alpha: 1 }, labels: ["b", "a"], bignum: "9007199254740993", active: true },
  { id: "rich-1", payload: { k: "v" }, labels: [], bignum: "123456789012345678901234567890", active: false },
];

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

function parseLiteral(text: string): unknown {
  if (text === "null") return null;
  if (text.startsWith("'")) return text.slice(1, -1).replace(/''/g, "'");
  return Number(text);
}

/** Splits a tuple's value text on top-level commas only, so quoted JSON/array text such as `'{"a":1,"b":2}'` or `'["b","a"]'` stays one value. */
function splitSqlValues(text: string): string[] {
  const values: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      current += char;
      if (char === "'") {
        if (text[index + 1] === "'") {
          current += "'";
          index += 1;
        } else {
          quoted = false;
        }
      }
    } else if (char === "'") {
      quoted = true;
      current += char;
    } else if (char === ",") {
      values.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  values.push(current.trim());
  return values;
}

interface MaterializedChunk {
  database: D1Database;
  table: string;
  chunkIndex: number;
  path: string;
}

interface CopyHarness {
  runner: WranglerD1Runner;
  calls: string[][];
  files: Map<string, string>;
  materialized: MaterializedChunk[];
  materialize: (database: D1Database, table: string, chunkIndex: number, sql: string) => string;
  remoteRows: (table: string) => Record<string, unknown>[];
}

interface HarnessOptions {
  /** Throw when a chunk file is executed, before any row is stored. */
  failFileExecution?: boolean;
  /** Return non-JSON for every remote read command. */
  malformedReadJson?: boolean;
  /** Bias every `count(*)` response by this many rows. */
  countDelta?: number;
  /**
   * After a chunk is applied and its `count(*)` progress check reports the exact
   * expected count, corrupt one stored value just before the next full-table
   * read, so the final canonical hash no longer matches while the row count does.
   */
  tamperAfterChunk?: boolean;
}

/** A fake `worldcons_core` that stores canonical rows and applies the emitted chunk files. */
function createHarness(
  initialRows: Record<string, Record<string, unknown>[]> = {},
  options: HarnessOptions = {},
): CopyHarness {
  const files = new Map<string, string>();
  const calls: string[][] = [];
  const materialized: MaterializedChunk[] = [];
  const store: Record<string, Record<string, unknown>[]> = {};
  for (const [table, rows] of Object.entries(initialRows)) store[table] = rows.map((row) => ({ ...row }));

  const remoteRows = (table: string): Record<string, unknown>[] => {
    store[table] ??= [];
    return store[table];
  };
  const envelope = (rows: Record<string, unknown>[]): string =>
    JSON.stringify([{ results: rows, success: true, meta: {} }]);

  const applyChunk = (sql: string): void => {
    for (const line of sql.split("\n")) {
      const match = /^insert into (\w+) \(([^)]*)\) values (.+);$/.exec(line);
      assert.ok(match, `unexpected chunk statement: ${line}`);
      const columns = match[2].split(", ");
      for (const tuple of match[3].match(/\([^()]*\)/g) ?? []) {
        const values = splitSqlValues(tuple.slice(1, -1));
        const row: Record<string, unknown> = {};
        columns.forEach((column, index) => {
          row[column] = parseLiteral(values[index]);
        });
        remoteRows(match[1]).push(row);
      }
    }
  };

  let executedChunk = false;
  let tamperTable: string | null = null;

  const runner: WranglerD1Runner = async (args) => {
    calls.push(args);
    assert.equal(args[2], "worldcons_core");
    if (args.includes("--file")) {
      if (options.failFileExecution) throw new Error("wrangler: failed to execute the chunk file");
      applyChunk(files.get(args[args.indexOf("--file") + 1]) ?? "");
      executedChunk = true;
      return "wrangler: executed the chunk file";
    }
    const command = args[args.indexOf("--command") + 1];
    if (options.malformedReadJson) return "<!doctype html><html>not json</html>";
    const count = /^select count\(\*\) as n from (\w+)$/.exec(command);
    if (count) {
      if (options.tamperAfterChunk && executedChunk) tamperTable = count[1];
      return envelope([{ n: remoteRows(count[1]).length + (options.countDelta ?? 0) }]);
    }
    if (tamperTable) {
      const rows = remoteRows(tamperTable);
      const [first] = rows;
      if (first) {
        const key = Object.keys(first).find((name) => name !== "id") ?? Object.keys(first)[0];
        rows[0] = { ...first, [key]: `${String(first[key])}-tampered` };
      }
      tamperTable = null;
    }
    const table = / from (\w+)/.exec(command)?.[1] ?? "";
    const limit = Number(/ limit (\d+)/.exec(command)?.[1]);
    const offset = Number(/ offset (\d+)/.exec(command)?.[1] ?? 0);
    return envelope(remoteRows(table).slice(offset, offset + limit));
  };

  return {
    runner,
    calls,
    files,
    materialized,
    materialize: (database, table, chunkIndex, sql) => {
      const path = `fake/${database}-${table}-${chunkIndex}.sql`;
      files.set(path, sql);
      materialized.push({ database, table, chunkIndex, path });
      return path;
    },
    remoteRows,
  };
}

const source = (): PostgresRowSource => createFakeSource({ copy_probe: SOURCE_ROWS });

test("dry-run over an empty remote plans a pending copy and writes nothing", async () => {
  const harness = createHarness();
  const manifest = await buildD1RemoteDataCopyManifest({ runner: harness.runner, source: source(), schema, databases: ["worldcons_core"] });

  assert.equal(manifest.dryRun, true);
  assert.equal(manifest.applied, false);
  assert.equal(manifest.ok, true, manifest.errors.join("; "));
  assert.deepEqual(manifest.totals, {
    databases: 1,
    tables: 1,
    expectedRows: 6,
    remoteRows: 0,
    copiedRows: 0,
    existing: 0,
    resumable: 0,
    pending: 1,
    copied: 0,
    refused: 0,
  });

  const [table] = manifest.targets[0].tables;
  assert.equal(table.state, "pending");
  assert.equal(table.action, "copy");
  assert.equal(table.verified, false);
  assert.equal(table.expectedRowCount, 6);
  assert.equal(table.remoteRowCount, 0);
  assert.equal(manifest.commands.filter((command) => command.includes("--file")).length, 0);
  assert.equal(harness.files.size, 0);
});

test("apply from an empty remote reaches exact verified parity", async () => {
  const harness = createHarness();
  const manifest = await buildD1RemoteDataCopyManifest({
    runner: harness.runner,
    source: source(),
    schema,
    databases: ["worldcons_core"],
    apply: true,
    materializeChunk: harness.materialize,
  });

  assert.equal(manifest.applied, true);
  assert.equal(manifest.ok, true, manifest.errors.join("; "));
  assert.equal(manifest.totals.copied, 1);
  assert.equal(manifest.totals.copiedRows, 6);

  const [table] = manifest.targets[0].tables;
  assert.equal(table.state, "applied");
  assert.equal(table.action, "copy");
  assert.equal(table.verified, true);
  assert.equal(table.copiedRowCount, 6);
  assert.equal(table.remoteRowCount, 6);
  assert.equal(table.remoteHash, table.expectedHash);
  assert.ok(table.chunkCount > 0);
  assert.equal(harness.remoteRows("copy_probe").length, 6);
  assert.ok(manifest.commands.some((command) => command.includes("--file")));
});

test("an already-complete remote is a verified no-op with zero writes", async () => {
  const harness = createHarness({ copy_probe: FULL_ROWS });
  const manifest = await buildD1RemoteDataCopyManifest({
    runner: harness.runner,
    source: source(),
    schema,
    databases: ["worldcons_core"],
    apply: true,
    materializeChunk: harness.materialize,
  });

  assert.equal(manifest.ok, true, manifest.errors.join("; "));
  assert.equal(manifest.totals.existing, 1);
  assert.equal(manifest.totals.copied, 0);

  const [table] = manifest.targets[0].tables;
  assert.equal(table.state, "existing");
  assert.equal(table.action, "none");
  assert.equal(table.verified, true);
  assert.equal(table.remoteHash, table.expectedHash);
  assert.equal(manifest.commands.filter((command) => command.includes("--file")).length, 0);
  assert.equal(harness.files.size, 0);
});

test("a strict canonical prefix resumes and copies only the suffix", async () => {
  const harness = createHarness({ copy_probe: FULL_ROWS.slice(0, 2) });
  const manifest = await buildD1RemoteDataCopyManifest({
    runner: harness.runner,
    source: source(),
    schema,
    databases: ["worldcons_core"],
    apply: true,
    materializeChunk: harness.materialize,
  });

  assert.equal(manifest.ok, true, manifest.errors.join("; "));
  assert.equal(manifest.totals.copied, 1);

  const [table] = manifest.targets[0].tables;
  assert.equal(table.state, "applied");
  assert.equal(table.copiedRowCount, 4);
  assert.equal(table.remoteRowCount, 6);
  assert.equal(table.remoteHash, table.expectedHash);
  assert.equal(table.verified, true);

  const chunks = [...harness.files.values()];
  assert.equal(chunks.length, 1);
  assert.ok(chunks[0].includes("'row-6'"));
  assert.ok(!chunks[0].includes("'row-1'"), "the persisted prefix must not be re-inserted");
});

test("a non-prefix partial remote is refused before any write", async () => {
  const strangers = FULL_ROWS.slice(0, 2).map((row) => ({ ...row, id: `zz-${String(row.id)}` }));
  const harness = createHarness({ copy_probe: strangers });
  const manifest = await buildD1RemoteDataCopyManifest({
    runner: harness.runner,
    source: source(),
    schema,
    databases: ["worldcons_core"],
    apply: true,
    materializeChunk: harness.materialize,
  });

  assert.equal(manifest.ok, false);
  assert.equal(manifest.totals.refused, 1);

  const [table] = manifest.targets[0].tables;
  assert.equal(table.state, "refused");
  assert.equal(table.action, "refused");
  assert.equal(table.verified, false);
  assert.equal(table.copiedRowCount, 0);
  assert.ok(table.errors.some((error) => error.includes("neither the full dataset")));
  assert.equal(manifest.commands.filter((command) => command.includes("--file")).length, 0);
  assert.equal(harness.files.size, 0);
});

test("a remote row set longer than the source is refused with zero writes", async () => {
  const longer = toCanonicalTableDataset(copyTable, [
    ...SOURCE_ROWS,
    { id: "row-7", body: "body 7", rank: 7 },
  ]).rows;
  const harness = createHarness({ copy_probe: longer });
  const manifest = await buildD1RemoteDataCopyManifest({
    runner: harness.runner,
    source: source(),
    schema,
    databases: ["worldcons_core"],
    apply: true,
    materializeChunk: harness.materialize,
  });

  assert.equal(manifest.ok, false);
  assert.equal(manifest.totals.refused, 1);

  const [table] = manifest.targets[0].tables;
  assert.equal(table.state, "refused");
  assert.equal(table.action, "refused");
  assert.equal(table.verified, false);
  assert.equal(table.copiedRowCount, 0);
  assert.ok(table.errors.some((error) => error.includes("neither the full dataset")));
  assert.equal(manifest.commands.filter((command) => command.includes("--file")).length, 0);
  assert.equal(harness.files.size, 0);
});

test("a file-execution error on the first data chunk fails the manifest and stops the copy", async () => {
  const harness = createHarness({}, { failFileExecution: true });
  const manifest = await buildD1RemoteDataCopyManifest({
    runner: harness.runner,
    source: source(),
    schema,
    databases: ["worldcons_core"],
    apply: true,
    materializeChunk: harness.materialize,
  });

  assert.equal(manifest.ok, false);
  assert.equal(manifest.totals.copied, 0);
  assert.equal(manifest.totals.refused, 1);

  const [table] = manifest.targets[0].tables;
  assert.equal(table.state, "unknown");
  assert.equal(table.action, "refused");
  assert.equal(table.verified, false);
  assert.equal(table.copiedRowCount, 0);
  assert.ok(table.errors.some((error) => error.includes("failed to execute")));
  assert.equal(manifest.commands.filter((command) => command.includes("--file")).length, 1);
  assert.equal(harness.remoteRows("copy_probe").length, 0);
});

test("malformed JSON from a remote read fails closed with zero writes", async () => {
  const harness = createHarness({}, { malformedReadJson: true });
  const manifest = await buildD1RemoteDataCopyManifest({
    runner: harness.runner,
    source: source(),
    schema,
    databases: ["worldcons_core"],
    apply: true,
    materializeChunk: harness.materialize,
  });

  assert.equal(manifest.ok, false);
  assert.equal(manifest.totals.refused, 1);

  const [table] = manifest.targets[0].tables;
  assert.equal(table.state, "unknown");
  assert.equal(table.action, "refused");
  assert.equal(table.verified, false);
  assert.equal(table.copiedRowCount, 0);
  assert.ok(table.errors.some((error) => error.includes("did not return JSON")));
  assert.equal(manifest.commands.filter((command) => command.includes("--file")).length, 0);
  assert.equal(harness.files.size, 0);
});

test("a row-count response that does not match expected progress fails the manifest", async () => {
  const harness = createHarness({}, { countDelta: 1 });
  const manifest = await buildD1RemoteDataCopyManifest({
    runner: harness.runner,
    source: source(),
    schema,
    databases: ["worldcons_core"],
    apply: true,
    materializeChunk: harness.materialize,
  });

  assert.equal(manifest.ok, false);
  assert.equal(manifest.totals.copied, 0);
  assert.equal(manifest.totals.refused, 1);

  const [table] = manifest.targets[0].tables;
  assert.equal(table.state, "unknown");
  assert.equal(table.action, "refused");
  assert.equal(table.verified, false);
  assert.equal(table.copiedRowCount, 0);
  assert.ok(table.errors.some((error) => error.includes("after a") && error.includes("found")));
  assert.equal(manifest.commands.filter((command) => command.includes("--file")).length, 1);
});

test("a value corrupted after the chunk count check fails the final canonical hash", async () => {
  const harness = createHarness({}, { tamperAfterChunk: true });
  const manifest = await buildD1RemoteDataCopyManifest({
    runner: harness.runner,
    source: source(),
    schema,
    databases: ["worldcons_core"],
    apply: true,
    materializeChunk: harness.materialize,
  });

  assert.equal(manifest.ok, false);
  assert.equal(manifest.totals.copied, 0);
  assert.equal(manifest.totals.refused, 1);

  const [table] = manifest.targets[0].tables;
  assert.equal(table.state, "unknown");
  assert.equal(table.action, "refused");
  assert.equal(table.verified, false);
  assert.ok(table.errors.some((error) => error.includes("final remote dataset")));
  assert.ok(manifest.errors.some((error) => error.includes("final remote dataset")));
  assert.equal(harness.remoteRows("copy_probe").length, SOURCE_ROWS.length);
});

test("an empty source over an empty remote is a verified existing no-op with zero writes", async () => {
  const harness = createHarness();
  const manifest = await buildD1RemoteDataCopyManifest({
    runner: harness.runner,
    source: createFakeSource({}),
    schema,
    databases: ["worldcons_core"],
    apply: true,
    materializeChunk: harness.materialize,
  });

  assert.equal(manifest.ok, true, manifest.errors.join("; "));
  assert.equal(manifest.totals.expectedRows, 0);
  assert.equal(manifest.totals.remoteRows, 0);
  assert.equal(manifest.totals.copiedRows, 0);
  assert.equal(manifest.totals.existing, 1);
  assert.equal(manifest.totals.pending, 0);
  assert.equal(manifest.totals.copied, 0);
  assert.equal(manifest.totals.refused, 0);

  const [table] = manifest.targets[0].tables;
  assert.equal(table.state, "existing");
  assert.equal(table.action, "none");
  assert.equal(table.verified, true);
  assert.equal(table.expectedRowCount, 0);
  assert.equal(table.remoteRowCount, 0);
  assert.equal(table.copiedRowCount, 0);
  assert.equal(table.chunkCount, 0);
  assert.equal(manifest.commands.filter((command) => command.includes("--file")).length, 0);
  assert.equal(harness.files.size, 0);
});

test("two fresh harnesses with identical source and chunking options materialize byte-identical chunks", async () => {
  const first = createHarness();
  const second = createHarness();
  const chunking = { rowsPerStatement: 1, maxStatementsPerChunk: 2 } as const;

  const firstManifest = await buildD1RemoteDataCopyManifest({
    runner: first.runner,
    source: source(),
    schema,
    databases: ["worldcons_core"],
    apply: true,
    materializeChunk: first.materialize,
    ...chunking,
  });
  const secondManifest = await buildD1RemoteDataCopyManifest({
    runner: second.runner,
    source: source(),
    schema,
    databases: ["worldcons_core"],
    apply: true,
    materializeChunk: second.materialize,
    ...chunking,
  });

  assert.equal(firstManifest.ok, true, firstManifest.errors.join("; "));
  assert.equal(secondManifest.ok, true, secondManifest.errors.join("; "));

  const firstChunks = [...first.files.entries()];
  const secondChunks = [...second.files.entries()];
  assert.equal(firstChunks.length, 3, "6 rows at 1 row/statement and 2 statements/chunk must split into 3 chunks");
  assert.deepEqual(firstChunks, secondChunks);

  const refs = (chunks: MaterializedChunk[]): { database: D1Database; table: string; chunkIndex: number }[] =>
    chunks.map(({ database, table, chunkIndex }) => ({ database, table, chunkIndex }));
  assert.deepEqual(refs(first.materialized), refs(second.materialized));
  assert.deepEqual(
    first.materialized.map((chunk) => chunk.chunkIndex),
    [0, 1, 2],
    "chunks are zero-based deterministic per table",
  );
  assert.ok(
    first.materialized.every((chunk) => chunk.database === "worldcons_core" && chunk.table === "copy_probe"),
    "every chunk is materialized with the authored D1 table name",
  );

  assert.deepEqual(firstManifest.totals, secondManifest.totals);

  const [firstTable] = firstManifest.targets[0].tables;
  const [secondTable] = secondManifest.targets[0].tables;
  assert.equal(firstTable.chunkCount, firstChunks.length);
  assert.equal(secondTable.chunkCount, firstChunks.length);
  assert.equal(firstTable.copiedRowCount, 6);
  assert.equal(secondTable.copiedRowCount, 6);
});

test("selecting worldcons_search yields zero copy targets because search is out of data-copy scope", async () => {
  assert.ok(d1Schema.databases.includes("worldcons_search"), "the default schema includes the search database");
  assert.ok(
    d1Schema.tables.some((table) => table.database === "worldcons_search"),
    "the default schema includes the search tables",
  );

  const harness = createHarness();
  const manifest = await buildD1RemoteDataCopyManifest({
    runner: harness.runner,
    source: source(),
    schema: d1Schema,
    databases: ["worldcons_search"],
    apply: true,
    materializeChunk: harness.materialize,
  });

  assert.equal(manifest.ok, true, manifest.errors.join("; "));
  assert.deepEqual(manifest.targets, []);
  assert.equal(manifest.totals.databases, 0);
  assert.equal(manifest.totals.tables, 0);
  assert.equal(manifest.totals.copied, 0);
  assert.equal(manifest.totals.refused, 0);
  assert.equal(manifest.commands.length, 0);
  assert.equal(harness.calls.length, 0);
  assert.equal(manifest.commands.filter((command) => command.includes("--file")).length, 0);
  assert.equal(harness.files.size, 0);
});

const richSource = (): PostgresRowSource => createFakeSource({ copy_rich: RICH_SOURCE_ROWS });

test("applying the rich table from an empty remote reaches verified parity across json, array, bigint and boolean", async () => {
  const harness = createHarness();
  const manifest = await buildD1RemoteDataCopyManifest({
    runner: harness.runner,
    source: richSource(),
    schema: richSchema,
    databases: ["worldcons_core"],
    apply: true,
    materializeChunk: harness.materialize,
  });

  assert.equal(manifest.applied, true);
  assert.equal(manifest.ok, true, manifest.errors.join("; "));
  assert.equal(manifest.totals.copied, 1);
  assert.equal(manifest.totals.copiedRows, 2);
  assert.equal(manifest.totals.existing, 0);
  assert.equal(manifest.totals.refused, 0);

  const [table] = manifest.targets[0].tables;
  assert.equal(table.table, "copy_rich");
  assert.equal(table.state, "applied");
  assert.equal(table.action, "copy");
  assert.equal(table.copiedRowCount, 2);
  assert.equal(table.remoteRowCount, 2);
  assert.ok(table.chunkCount > 0);
  assert.equal(table.verified, true);
  assert.equal(table.remoteHash, table.expectedHash);
  assert.ok(manifest.commands.some((command) => command.includes("--file")));

  const rows = harness.remoteRows("copy_rich");
  assert.equal(rows.length, 2);
  const rich2 = rows.find((row) => row.id === "rich-2");
  const rich1 = rows.find((row) => row.id === "rich-1");
  assert.ok(rich2, "rich-2 must be stored");
  assert.ok(rich1, "rich-1 must be stored");

  // Stored jsonb is canonical JSON text: sorted keys, no whitespace.
  assert.equal(rich2.payload, '{"alpha":1,"beta":2}');
  assert.equal(typeof rich2.payload, "string");
  assert.equal(canonicalJson(JSON.parse(rich2.payload as string)), rich2.payload);
  assert.equal(rich1.payload, '{"k":"v"}');
  assert.equal(typeof rich1.payload, "string");

  // Stored text[] is canonical JSON array text, including the comma between elements.
  assert.equal(rich2.labels, '["b","a"]');
  assert.equal(typeof rich2.labels, "string");
  assert.equal(canonicalJson(JSON.parse(rich2.labels as string)), rich2.labels);
  assert.equal(rich1.labels, "[]");
  assert.equal(typeof rich1.labels, "string");

  // bigint stays an exact decimal string past Number.MAX_SAFE_INTEGER.
  assert.equal(rich2.bignum, "9007199254740993");
  assert.equal(typeof rich2.bignum, "string");
  assert.ok(Number(rich2.bignum as string) > Number.MAX_SAFE_INTEGER);
  assert.equal(rich1.bignum, "123456789012345678901234567890");
  assert.equal(typeof rich1.bignum, "string");

  // boolean is stored as the D1 integer 1/0.
  assert.equal(rich2.active, 1);
  assert.equal(rich1.active, 0);
  assert.equal(typeof rich2.active, "number");
  assert.equal(typeof rich1.active, "number");
});

test("production data-copy seam keeps destructive DML and Node operator imports out", () => {
  const source = readFileSync(path.join(process.cwd(), "lib/cloudflare/d1/remote/data-copy.ts"), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "").toLowerCase();

  const forbidden: [string, RegExp][] = [
    ["node:child_process import", /node:child_process/],
    ["pg import", /\bfrom\s*["']pg["']|require\s*\(\s*["']pg["']\s*\)/],
    ["insert or replace", /insert\s+or\s+replace/],
    ["replace into", /replace\s+into/],
    ["upsert", /upsert/],
    ["delete from", /delete\s+from/],
    ["drop table", /drop\s+table/],
    ["create table", /create\s+table/],
    ["update ... set", /\bupdate\s+[a-z_][a-z0-9_]*\s+set\b/],
  ];
  for (const [label, pattern] of forbidden) {
    assert.ok(!pattern.test(code), `data-copy seam must not contain ${label}`);
  }

  assert.ok(code.includes("if (!apply)"), "apply must remain explicitly opt-in behind `if (!apply)`");
  assert.ok(code.includes("--file"), "chunk writes must go through the `--file` surface");
});

const pairSource = (): PostgresRowSource => createFakeSource({ copy_probe: SOURCE_ROWS, copy_rich: RICH_SOURCE_ROWS });

test("a table selection narrows the copy to one table and never reads the other", async () => {
  const harness = createHarness();
  const manifest = await buildD1RemoteDataCopyManifest({
    runner: harness.runner,
    source: pairSource(),
    schema: pairSchema,
    databases: ["worldcons_core"],
    tables: ["copy_probe"],
  });

  assert.equal(manifest.ok, true, manifest.errors.join("; "));
  assert.equal(manifest.dryRun, true);
  assert.equal(manifest.totals.databases, 1);
  assert.equal(manifest.totals.tables, 1);

  const [target] = manifest.targets;
  assert.equal(target.tableCount, 1);
  assert.deepEqual(target.tables.map((table) => table.table), ["copy_probe"]);

  const [table] = target.tables;
  assert.equal(table.table, "copy_probe");
  assert.equal(table.state, "pending");
  assert.equal(table.action, "copy");
  assert.equal(table.expectedRowCount, SOURCE_ROWS.length);

  const touchedRich = (args: string[]): boolean => args.some((arg) => arg.includes("copy_rich"));
  assert.ok(!harness.calls.some(touchedRich), "the unselected table must never be read");
  assert.ok(!manifest.commands.some((command) => command.includes("copy_rich")));
  assert.equal(manifest.commands.filter((command) => command.includes("--file")).length, 0);
  assert.equal(harness.files.size, 0);
});

test("an unknown table selection fails before the runner is called", async () => {
  const harness = createHarness();
  await assert.rejects(
    buildD1RemoteDataCopyManifest({
      runner: harness.runner,
      source: pairSource(),
      schema: pairSchema,
      databases: ["worldcons_core"],
      tables: ["missing_table"],
    }),
    /unknown data-copy table selection/,
  );
  assert.equal(harness.calls.length, 0);
});

test("the d1:copy-data CLI exposes a deterministic, url-only, opt-in apply contract", () => {
  const cliSource = readFileSync(path.join(process.cwd(), "scripts/d1-copy-data.ts"), "utf8");
  // Negative checks run against comment-stripped code so the safety documentation
  // (which explicitly names the env vars the CLI refuses to fall back to) is not
  // mistaken for executable behaviour.
  const cliCode = cliSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  // The Postgres source must be supplied explicitly, never guessed.
  assert.ok(cliSource.includes("WORLDCONS_D1_SOURCE_URL"), "the CLI must read the explicit source env var");
  assert.ok(cliCode.includes('argValue(args, "url")'), "the CLI must resolve the source from `--url=`");
  assert.ok(!cliCode.includes("DATABASE_URL"), "the CLI must not fall back to DATABASE_URL");

  // Apply is an explicit flag, threaded into the manifest builder.
  assert.ok(cliSource.includes('args.includes("--apply")'), "apply must be an explicit `--apply` flag");
  assert.ok(
    /buildD1RemoteDataCopyManifest\(\{[\s\S]*?\bapply\b/.test(cliSource),
    "the parsed apply flag must be passed into buildD1RemoteDataCopyManifest",
  );

  // Chunk materialization is gated on apply.
  assert.ok(
    /materializeChunk:\s*apply\s*\?[\s\S]*?:\s*undefined/.test(cliSource),
    "materializeChunk must only be provided when apply is true",
  );

  // Deterministic artifact layout.
  assert.ok(
    cliSource.includes('path.join("artifacts", "cloudflare-m5", "d1-data-copy")'),
    "the chunk root must live under artifacts/cloudflare-m5/d1-data-copy",
  );
  assert.ok(
    cliSource.includes("path.join(CHUNK_DIR, database, table)"),
    "each chunk directory must be keyed by database and table",
  );
  assert.ok(
    cliSource.includes('chunk-${String(chunkIndex).padStart(4, "0")}.sql'),
    "chunk files must use zero-padded chunk-NNNN.sql naming",
  );

  // package.json wiring.
  const pkg = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  assert.ok(pkg.scripts["d1:copy-data"], "package.json must expose d1:copy-data");
  assert.ok(pkg.scripts["test:d1-copy-data"], "package.json must expose test:d1-copy-data");
  assert.ok(
    pkg.scripts["verify:release"].includes("pnpm test:d1-copy-data"),
    "verify:release must run pnpm test:d1-copy-data",
  );
});
