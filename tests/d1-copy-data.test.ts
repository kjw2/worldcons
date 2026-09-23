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
import type { D1ImportStatement } from "../lib/cloudflare/d1/import/types";
import { D1RemoteError, type WranglerD1Runner } from "../lib/cloudflare/d1/remote";
import {
  buildD1RemoteDataCopyManifest,
  D1_REMOTE_DATA_COPY_DATABASES,
  D1_REMOTE_DATA_COPY_MAX_LITERAL_STATEMENT_BYTES,
} from "../lib/cloudflare/d1/remote/data-copy";
import {
  createLazyParameterizedWriter,
  parseAuthTokenJson,
  parseWhoamiAccountId,
  resolveParameterizedWriter,
} from "../scripts/d1-copy-data";

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

/** One captured `executeParameterized` call: the target database and the ORIGINAL `?` statement. */
interface ParameterCall {
  database: D1Database;
  statement: D1ImportStatement;
}

interface CopyHarness {
  runner: WranglerD1Runner;
  calls: string[][];
  files: Map<string, string>;
  materialized: MaterializedChunk[];
  /** Ordered write kinds, so a mixed small/oversized copy can prove file, parameter, file. */
  executions: ("file" | "parameter")[];
  parameterCalls: ParameterCall[];
  materialize: (database: D1Database, table: string, chunkIndex: number, sql: string) => string;
  executeParameterized: (database: D1Database, statement: D1ImportStatement) => Promise<void>;
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
  const executions: ("file" | "parameter")[] = [];
  const parameterCalls: ParameterCall[] = [];
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

  /**
   * Applies the ORIGINAL parameterized statement to the in-memory store by binding
   * each `?` to its param directly. It never renders or parses SQL literals, so a
   * value larger than the literal-statement threshold round-trips verbatim.
   */
  const applyParameterized = (database: D1Database, statement: D1ImportStatement): void => {
    const match = /^insert into (\w+) \(([^)]*)\) values (.+);$/.exec(statement.sql);
    assert.ok(match, `unexpected parameterized statement: ${statement.sql}`);
    const columns = match[2].split(", ");
    const placeholders = match[3].match(/\?/g) ?? [];
    assert.equal(placeholders.length, statement.params.length, "every placeholder must have a bound parameter");
    assert.equal(statement.params.length % columns.length, 0, "bound parameters must fill whole rows");
    for (let index = 0; index < statement.params.length; index += columns.length) {
      const row: Record<string, unknown> = {};
      columns.forEach((column, offset) => {
        row[column] = statement.params[index + offset];
      });
      remoteRows(match[1]).push(row);
    }
    parameterCalls.push({ database, statement });
    executions.push("parameter");
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
      executions.push("file");
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
    executeParameterized: async (database, statement) => {
      applyParameterized(database, statement);
    },
    executions,
    parameterCalls,
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
    plannedWrites: 1,
    plannedParameterizedWrites: 0,
    parameterizedTables: 0,
  });

  const [table] = manifest.targets[0].tables;
  assert.equal(table.state, "pending");
  assert.equal(table.action, "copy");
  assert.equal(table.verified, false);
  assert.equal(table.expectedRowCount, 6);
  assert.equal(table.remoteRowCount, 0);
  // The dry-run preflight plans the copy without executing any of it.
  assert.ok(table.plannedWriteCount > 0, "a dry-run small table must plan at least one write");
  assert.equal(table.plannedParameterizedWriteCount, 0, "a small table must plan no parameterized write");
  assert.equal(table.requiresParameterizedWriter, false);
  assert.equal(table.chunkCount, 0, "a dry-run executes no write item");
  assert.equal(manifest.totals.plannedWrites, table.plannedWriteCount);
  assert.equal(manifest.commands.filter((command) => command.includes("--file")).length, 0);
  assert.equal(harness.files.size, 0);
  assert.equal(harness.materialized.length, 0);
  assert.equal(harness.parameterCalls.length, 0);
  assert.equal(harness.executions.length, 0);
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
  // Apply reuses the exact plan a dry-run would report: the executed items equal the plan.
  assert.equal(table.plannedWriteCount, table.chunkCount);
  assert.equal(table.plannedParameterizedWriteCount, 0);
  assert.equal(table.requiresParameterizedWriter, false);
  assert.equal(manifest.totals.plannedWrites, table.chunkCount);
  assert.equal(manifest.totals.plannedParameterizedWrites, 0);
  assert.equal(manifest.totals.parameterizedTables, 0);
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
  // An existing table plans nothing.
  assert.equal(table.plannedWriteCount, 0);
  assert.equal(table.plannedParameterizedWriteCount, 0);
  assert.equal(table.requiresParameterizedWriter, false);
  assert.equal(manifest.totals.plannedWrites, 0);
  assert.equal(manifest.totals.plannedParameterizedWrites, 0);
  assert.equal(manifest.totals.parameterizedTables, 0);
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
  // A refused table plans nothing.
  assert.equal(table.plannedWriteCount, 0);
  assert.equal(table.plannedParameterizedWriteCount, 0);
  assert.equal(table.requiresParameterizedWriter, false);
  assert.equal(manifest.totals.plannedWrites, 0);
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
  // An empty source over an empty remote is `existing`: nothing is planned or executed.
  assert.equal(table.plannedWriteCount, 0);
  assert.equal(table.plannedParameterizedWriteCount, 0);
  assert.equal(table.requiresParameterizedWriter, false);
  assert.equal(manifest.totals.plannedWrites, 0);
  assert.equal(manifest.totals.plannedParameterizedWrites, 0);
  assert.equal(manifest.totals.parameterizedTables, 0);
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

test("a small apply writes through Wrangler --file and never calls the parameterized writer", async () => {
  const harness = createHarness();
  const manifest = await buildD1RemoteDataCopyManifest({
    runner: harness.runner,
    source: source(),
    schema,
    databases: ["worldcons_core"],
    apply: true,
    materializeChunk: harness.materialize,
    executeParameterized: harness.executeParameterized,
  });

  assert.equal(manifest.ok, true, manifest.errors.join("; "));
  assert.ok(harness.files.size > 0, "a small table must still be materialized into a chunk file");
  assert.ok(manifest.commands.some((command) => command.includes("--file")));
  assert.deepEqual(harness.executions, ["file"], "every write must go through the --file surface");
  assert.equal(harness.parameterCalls.length, 0, "the parameterized writer must not be called for a small table");

  const [table] = manifest.targets[0].tables;
  assert.equal(table.state, "applied");
  assert.equal(table.verified, true);
  assert.equal(table.remoteHash, table.expectedHash);
});

/** A one-row `copy_probe` whose text body comfortably exceeds the literal-statement threshold. */
function oversizedSource(body: string): PostgresRowSource {
  assert.ok(
    body.length > D1_REMOTE_DATA_COPY_MAX_LITERAL_STATEMENT_BYTES,
    "the test body must exceed the literal-statement threshold",
  );
  return createFakeSource({ copy_probe: [{ id: "huge-1", body, rank: 1 }] });
}

test("an oversized row applies through the parameterized writer without materializing its body", async () => {
  const harness = createHarness();
  const body = "x".repeat(120_000);
  const manifest = await buildD1RemoteDataCopyManifest({
    runner: harness.runner,
    source: oversizedSource(body),
    schema,
    databases: ["worldcons_core"],
    apply: true,
    materializeChunk: harness.materialize,
    executeParameterized: harness.executeParameterized,
  });

  assert.equal(manifest.ok, true, manifest.errors.join("; "));
  assert.equal(manifest.commands.filter((command) => command.includes("--file")).length, 0);
  assert.equal(harness.files.size, 0, "an oversized statement must never be materialized into a chunk file");
  assert.equal(harness.parameterCalls.length, 1, "the oversized statement must be written exactly once");

  const [call] = harness.parameterCalls;
  assert.equal(call.database, "worldcons_core");
  assert.equal((call.statement.sql.match(/\?/g) ?? []).length, 3, "the original SQL must keep its `?` placeholders");
  assert.ok(call.statement.sql.includes("?"), "the SQL is sent parameterized, not rendered");
  assert.ok(!call.statement.sql.includes(body), "the huge body must never appear as a SQL literal");
  assert.ok(call.statement.params.includes(body), "the exact huge body must travel as a bound parameter");
  assert.equal(call.statement.params.length, 3);

  const [table] = manifest.targets[0].tables;
  assert.equal(table.state, "applied");
  assert.equal(table.verified, true);
  assert.equal(table.copiedRowCount, 1);
  assert.equal(table.remoteRowCount, 1);
  assert.equal(table.remoteHash, table.expectedHash);
  // The applied plan is one oversized, parameterized write.
  assert.equal(table.plannedWriteCount, 1);
  assert.equal(table.plannedParameterizedWriteCount, 1);
  assert.equal(table.requiresParameterizedWriter, true);
  assert.equal(table.chunkCount, 1);
  assert.equal(manifest.totals.plannedWrites, 1);
  assert.equal(manifest.totals.plannedParameterizedWrites, 1);
  assert.equal(manifest.totals.parameterizedTables, 1);
  assert.equal(harness.remoteRows("copy_probe").length, 1);
});

test("an oversized row without a parameterized writer fails closed with zero writes", async () => {
  const harness = createHarness();
  const body = "y".repeat(120_000);
  const manifest = await buildD1RemoteDataCopyManifest({
    runner: harness.runner,
    source: oversizedSource(body),
    schema,
    databases: ["worldcons_core"],
    apply: true,
    materializeChunk: harness.materialize,
  });

  assert.equal(manifest.ok, false);
  assert.equal(manifest.totals.refused, 1);
  assert.equal(manifest.commands.filter((command) => command.includes("--file")).length, 0);
  assert.equal(harness.files.size, 0);
  assert.equal(harness.remoteRows("copy_probe").length, 0, "no row may reach the remote table");
  assert.ok(manifest.errors.some((error) => error.includes("no parameterized writer")));

  const [table] = manifest.targets[0].tables;
  assert.equal(table.state, "unknown");
  assert.equal(table.action, "refused");
  assert.equal(table.verified, false);
  assert.equal(table.copiedRowCount, 0);
});

test("a mixed small/oversized/small table writes file, parameter, file in authored row order", async () => {
  const harness = createHarness();
  const body = "z".repeat(120_000);
  const manifest = await buildD1RemoteDataCopyManifest({
    runner: harness.runner,
    source: createFakeSource({
      copy_probe: [
        { id: "row-1", body: "small one", rank: 1 },
        { id: "row-2", body, rank: 2 },
        { id: "row-3", body: "small three", rank: 3 },
      ],
    }),
    schema,
    databases: ["worldcons_core"],
    apply: true,
    materializeChunk: harness.materialize,
    executeParameterized: harness.executeParameterized,
    rowsPerStatement: 1,
  });

  assert.equal(manifest.ok, true, manifest.errors.join("; "));
  assert.deepEqual(
    harness.executions,
    ["file", "parameter", "file"],
    "the oversized middle row must flush the leading file chunk and the trailing row its own file",
  );
  assert.equal(harness.parameterCalls.length, 1);
  assert.equal(harness.files.size, 2);
  assert.ok(harness.parameterCalls[0].statement.params.includes(body));

  const [table] = manifest.targets[0].tables;
  assert.equal(table.state, "applied");
  assert.equal(table.verified, true);
  assert.equal(table.copiedRowCount, 3);
  assert.equal(table.remoteRowCount, 3);
  assert.equal(table.remoteHash, table.expectedHash);
  assert.equal(table.chunkCount, 3);
  assert.equal(table.plannedWriteCount, 3, "the plan is file, parameter, file");
  assert.equal(table.plannedParameterizedWriteCount, 1, "only the oversized middle row is parameterized");
  assert.equal(table.requiresParameterizedWriter, true);
  assert.equal(manifest.totals.plannedWrites, 3);
  assert.equal(manifest.totals.plannedParameterizedWrites, 1);
  assert.equal(manifest.totals.parameterizedTables, 1);
  assert.deepEqual(
    harness.remoteRows("copy_probe").map((row) => row.id),
    ["row-1", "row-2", "row-3"],
  );
});

test("a dry-run over an oversized row plans the parameterized writer without materializing or writing", async () => {
  const harness = createHarness();
  const body = "w".repeat(120_000);
  const manifest = await buildD1RemoteDataCopyManifest({
    runner: harness.runner,
    source: oversizedSource(body),
    schema,
    databases: ["worldcons_core"],
  });

  assert.equal(manifest.dryRun, true);
  assert.equal(manifest.ok, true, manifest.errors.join("; "));

  const [table] = manifest.targets[0].tables;
  assert.equal(table.state, "pending");
  assert.equal(table.action, "copy");
  assert.equal(table.plannedWriteCount, 1);
  assert.equal(table.plannedParameterizedWriteCount, 1);
  assert.equal(table.requiresParameterizedWriter, true);
  assert.equal(table.chunkCount, 0, "a dry-run executes no write item");

  assert.equal(manifest.totals.plannedWrites, 1);
  assert.equal(manifest.totals.plannedParameterizedWrites, 1);
  assert.equal(manifest.totals.parameterizedTables, 1);

  // The plan is recorded without materializing a chunk or writing anything.
  assert.equal(manifest.commands.filter((command) => command.includes("--file")).length, 0);
  assert.equal(harness.files.size, 0);
  assert.equal(harness.materialized.length, 0);
  assert.equal(harness.parameterCalls.length, 0);
  assert.equal(harness.executions.length, 0);
  assert.equal(harness.remoteRows("copy_probe").length, 0);
});

test("a mixed small/oversized/small dry-run plans three writes with one parameterized and executes none", async () => {
  const harness = createHarness();
  const body = "v".repeat(120_000);
  const manifest = await buildD1RemoteDataCopyManifest({
    runner: harness.runner,
    source: createFakeSource({
      copy_probe: [
        { id: "row-1", body: "small one", rank: 1 },
        { id: "row-2", body, rank: 2 },
        { id: "row-3", body: "small three", rank: 3 },
      ],
    }),
    schema,
    databases: ["worldcons_core"],
    rowsPerStatement: 1,
  });

  assert.equal(manifest.dryRun, true);
  assert.equal(manifest.ok, true, manifest.errors.join("; "));

  const [table] = manifest.targets[0].tables;
  assert.equal(table.state, "pending");
  assert.equal(table.action, "copy");
  assert.equal(table.plannedWriteCount, 3, "file, parameter, file is three planned writes");
  assert.equal(table.plannedParameterizedWriteCount, 1, "only the oversized middle row is parameterized");
  assert.equal(table.requiresParameterizedWriter, true);
  assert.equal(table.chunkCount, 0, "a dry-run writes nothing");

  assert.equal(manifest.totals.plannedWrites, 3);
  assert.equal(manifest.totals.plannedParameterizedWrites, 1);
  assert.equal(manifest.totals.parameterizedTables, 1);
  assert.equal(manifest.commands.filter((command) => command.includes("--file")).length, 0);
  assert.equal(harness.files.size, 0);
  assert.equal(harness.materialized.length, 0);
  assert.equal(harness.parameterCalls.length, 0);
  assert.equal(harness.executions.length, 0);
});

test("a dry-run and an apply of the same source report the identical write plan", async () => {
  const chunking = { rowsPerStatement: 1, maxStatementsPerChunk: 2 } as const;

  const dryHarness = createHarness();
  const dryRun = await buildD1RemoteDataCopyManifest({
    runner: dryHarness.runner,
    source: source(),
    schema,
    databases: ["worldcons_core"],
    ...chunking,
  });

  const applyHarness = createHarness();
  const applied = await buildD1RemoteDataCopyManifest({
    runner: applyHarness.runner,
    source: source(),
    schema,
    databases: ["worldcons_core"],
    apply: true,
    materializeChunk: applyHarness.materialize,
    ...chunking,
  });

  assert.equal(dryRun.ok, true, dryRun.errors.join("; "));
  assert.equal(applied.ok, true, applied.errors.join("; "));

  const [dryTable] = dryRun.targets[0].tables;
  const [appliedTable] = applied.targets[0].tables;
  assert.equal(dryTable.chunkCount, 0, "the dry-run executes nothing");
  assert.ok(dryTable.plannedWriteCount > 0);
  assert.equal(dryTable.plannedWriteCount, appliedTable.plannedWriteCount, "apply reuses the dry-run plan");
  assert.equal(dryTable.plannedParameterizedWriteCount, appliedTable.plannedParameterizedWriteCount);
  assert.equal(dryTable.requiresParameterizedWriter, appliedTable.requiresParameterizedWriter);
  assert.equal(appliedTable.chunkCount, appliedTable.plannedWriteCount, "an apply executes exactly its plan");
  assert.equal(dryRun.totals.plannedWrites, applied.totals.plannedWrites);
  assert.equal(dryRun.totals.plannedParameterizedWrites, applied.totals.plannedParameterizedWrites);
  assert.equal(dryRun.totals.parameterizedTables, applied.totals.parameterizedTables);
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

  // Source selection: `--source=` with `postgres` as the default kind.
  assert.ok(cliCode.includes('argValue(args, "source")'), "the CLI must resolve the source kind from `--source=`");
  assert.ok(
    cliCode.includes('argValue(args, "source") ?? "postgres"'),
    "postgres must remain the default source kind",
  );
  assert.ok(cliCode.includes('"supabase-linked"'), "the CLI must know the linked source kind");

  // The postgres branch stays exactly URL-gated: it is the only branch that resolves a URL.
  assert.ok(
    /createPostgresRowSource\(\{\s*connectionString:\s*resolveSourceUrl\(args\)\s*\}\)/.test(cliCode),
    "the postgres branch must remain URL-gated through resolveSourceUrl",
  );

  // The linked mode is a real import + branch that builds the source without any URL.
  assert.ok(
    cliSource.includes("createSupabaseLinkedRowSource"),
    "the CLI must import the linked Supabase row source",
  );
  assert.ok(
    /if\s*\(kind === "supabase-linked"\)\s*\{[\s\S]*?return createSupabaseLinkedRowSource\(\{[\s\S]*?\}\)/.test(cliCode),
    "the linked branch must construct the linked source without inspecting any URL",
  );

  // `--linked-max-stdout-bytes=` is a positive-integer option read ONLY by the linked
  // branch: absent, `positiveIntegerArg` yields null, `?? undefined` keeps the option
  // unset and the adapter retains its own 8 MiB cap.
  assert.ok(cliSource.includes("linked-max-stdout-bytes"), "the CLI must document --linked-max-stdout-bytes");
  assert.ok(
    cliCode.includes('positiveIntegerArg(args, "linked-max-stdout-bytes")'),
    "the linked stdout bound must be parsed as a positive integer",
  );
  assert.ok(
    /createSupabaseLinkedRowSource\(\{\s*maxStdoutBytes:\s*positiveIntegerArg\(args, "linked-max-stdout-bytes"\)\s*\?\?\s*undefined,?[\s\S]*?\}\)/.test(
      cliCode,
    ),
    "the linked branch must thread --linked-max-stdout-bytes into createSupabaseLinkedRowSource as maxStdoutBytes",
  );
  assert.equal(
    (cliCode.match(/maxStdoutBytes/g) ?? []).length,
    1,
    "maxStdoutBytes must be wired exactly once, in the linked branch",
  );
  assert.equal(
    (cliCode.match(/linked-max-stdout-bytes/g) ?? []).length,
    1,
    "--linked-max-stdout-bytes must be read exactly once, so the postgres source ignores it",
  );

  // `--linked-timeout-ms=` is a positive-integer option read ONLY by the linked
  // branch and threaded in as `timeoutMs` alongside `maxStdoutBytes`; absent,
  // `?? undefined` keeps it unset and the adapter retains its own 60s default.
  // It is distinct from the Wrangler runner's `--timeout-ms`, whose semantics are
  // untouched.
  assert.ok(cliSource.includes("linked-timeout-ms"), "the CLI must document --linked-timeout-ms");
  assert.ok(
    cliCode.includes('positiveIntegerArg(args, "linked-timeout-ms")'),
    "the linked timeout must be parsed as a positive integer",
  );
  assert.ok(
    /createSupabaseLinkedRowSource\(\{[\s\S]*?timeoutMs:\s*positiveIntegerArg\(args, "linked-timeout-ms"\)\s*\?\?\s*undefined,?\s*\}\)/.test(
      cliCode,
    ),
    "the linked branch must thread --linked-timeout-ms into createSupabaseLinkedRowSource as timeoutMs",
  );
  assert.equal(
    (cliCode.match(/linked-timeout-ms/g) ?? []).length,
    1,
    "--linked-timeout-ms must be read exactly once, so the postgres source ignores it",
  );

  // `--max-rows=` is a positive-integer read cap threaded straight into
  // buildD1RemoteDataCopyManifest as `maxRows`. Absent, `positiveIntegerArg`
  // yields null, `?? undefined` leaves the field unset and the builder keeps its
  // own unlimited default, so absence preserves the current behaviour exactly.
  assert.ok(cliSource.includes("max-rows"), "the CLI must document --max-rows");
  assert.ok(
    cliCode.includes('positiveIntegerArg(args, "max-rows")'),
    "the read cap must be parsed as a positive integer with the shared helper",
  );
  assert.ok(
    /buildD1RemoteDataCopyManifest\(\{[\s\S]*?maxRows:\s*positiveIntegerArg\(args, "max-rows"\)\s*\?\?\s*undefined/.test(
      cliCode,
    ),
    "the CLI must thread --max-rows into buildD1RemoteDataCopyManifest as maxRows",
  );
  assert.equal(
    (cliCode.match(/maxRows/g) ?? []).length,
    1,
    "maxRows must be wired exactly once, so absence preserves the unlimited default",
  );
  assert.equal(
    (cliCode.match(/max-rows/g) ?? []).length,
    1,
    "--max-rows must be read exactly once",
  );

  // The postgres branch is untouched: it never mentions the linked stdout bound and
  // still resolves its connection URL explicitly.
  const sourceFactory = /function createRowSource[\s\S]*?\n\}/.exec(cliCode)?.[0] ?? "";
  assert.ok(sourceFactory.length > 0, "createRowSource must remain in the CLI source");
  assert.ok(
    /createPostgresRowSource\(\{\s*connectionString:\s*resolveSourceUrl\(args\)\s*\}\)/.test(sourceFactory),
    "the postgres source must stay URL-only gated and ignore --linked-max-stdout-bytes",
  );
  assert.ok(
    !/createPostgresRowSource\([^)]*maxStdoutBytes/.test(sourceFactory),
    "the postgres construction must not consume the linked stdout bound",
  );
  assert.equal(
    (sourceFactory.match(/timeoutMs/g) ?? []).length,
    1,
    "the linked timeout must be wired exactly once inside createRowSource",
  );
  assert.ok(
    !/createPostgresRowSource\([^)]*timeoutMs/.test(sourceFactory),
    "the postgres construction must not consume the linked timeout",
  );

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

  // The oversized-statement writer is the D1 HTTP adapter, imported directly from
  // `remote/http-query` (never through the pure barrel).
  assert.ok(
    cliSource.includes('from "@/lib/cloudflare/d1/remote/http-query"'),
    "the CLI must import the D1 HTTP adapter directly from remote/http-query",
  );
  assert.ok(
    cliCode.includes("createD1HttpParameterizedWriter"),
    "the CLI must build the HTTP parameterized writer",
  );

  // Credentials are env-only: both exact names are read, and no token/account
  // argument exists. Neither value is ever printed.
  assert.ok(cliSource.includes("CLOUDFLARE_ACCOUNT_ID"), "the CLI must read CLOUDFLARE_ACCOUNT_ID");
  assert.ok(cliSource.includes("CLOUDFLARE_API_TOKEN"), "the CLI must read CLOUDFLARE_API_TOKEN");
  assert.ok(
    /const ACCOUNT_ID_ENV_VAR = "CLOUDFLARE_ACCOUNT_ID"/.test(cliCode),
    "the account id env name must be defined as the exact CLOUDFLARE_ACCOUNT_ID string",
  );
  assert.ok(
    /const API_TOKEN_ENV_VAR = "CLOUDFLARE_API_TOKEN"/.test(cliCode),
    "the api token env name must be defined as the exact CLOUDFLARE_API_TOKEN string",
  );
  assert.ok(!cliCode.includes("--api-token"), "the CLI must not expose an --api-token argument");
  assert.ok(!cliCode.includes("--account-id"), "the CLI must not expose an --account-id argument");

  // The writer is LAZY: a dry-run returns undefined before reading a credential,
  // and apply mode builds a callback whose credential/list resolution is deferred
  // behind a cached promise so it runs at most once.
  const lazyStart = cliCode.indexOf("export function createLazyParameterizedWriter");
  const lazyEnd = cliCode.indexOf("\nasync function main", lazyStart);
  const lazyWriter = lazyStart === -1 || lazyEnd === -1 ? "" : cliCode.slice(lazyStart, lazyEnd);
  assert.ok(lazyWriter.length > 0, "createLazyParameterizedWriter must remain in the CLI source");
  assert.ok(
    /if \(!options\.apply\) return undefined;/.test(lazyWriter),
    "the lazy writer must return undefined for a dry-run before reading any credential",
  );
  assert.ok(
    /writer \?\?= resolveParameterizedWriter\(/.test(lazyWriter),
    "the lazy writer must cache the resolved writer promise so auth/list happen at most once",
  );

  // Credential resolution is deferred to `resolveParameterizedWriter`: non-empty
  // env values are used directly, and any missing value falls back to the
  // existing Wrangler session through the same runner.
  const resolverStart = cliCode.indexOf("export async function resolveParameterizedWriter");
  const resolverEnd = cliCode.indexOf("\nexport function createLazyParameterizedWriter", resolverStart);
  const resolver = resolverStart === -1 || resolverEnd === -1 ? "" : cliCode.slice(resolverStart, resolverEnd);
  assert.ok(resolver.length > 0, "resolveParameterizedWriter must remain in the CLI source");
  assert.ok(
    /nonEmptyEnv\(env\[ACCOUNT_ID_ENV_VAR\]\)/.test(resolver) &&
      /nonEmptyEnv\(env\[API_TOKEN_ENV_VAR\]\)/.test(resolver),
    "the resolver must read both credential env values through the non-empty gate",
  );
  assert.ok(
    resolver.includes('runner(["auth", "token", "--json"])'),
    "the resolver must fall back to `auth token --json` when CLOUDFLARE_API_TOKEN is absent",
  );
  assert.ok(
    resolver.includes('runner(["whoami", "--json"])'),
    "the resolver must fall back to `whoami --json` when CLOUDFLARE_ACCOUNT_ID is absent",
  );
  assert.ok(
    resolver.includes('runner(["d1", "list", "--json"])'),
    "the resolver must run `d1 list --json` once to build the database id map",
  );
  assert.equal(
    (cliCode.match(/\["d1", "list", "--json"\]/g) ?? []).length,
    1,
    "the CLI must run exactly `d1 list --json` once",
  );
  assert.equal(
    (cliCode.match(/\["auth", "token", "--json"\]/g) ?? []).length,
    1,
    "the CLI must run exactly `auth token --json` once",
  );
  assert.equal(
    (cliCode.match(/\["whoami", "--json"\]/g) ?? []).length,
    1,
    "the CLI must run exactly `whoami --json` once",
  );

  // Exact-name classification only, defaulting to the copy databases so the
  // out-of-scope search database is never required for a data copy.
  assert.ok(
    cliSource.includes('from "@/lib/cloudflare/d1/remote/classify"'),
    "the CLI must import the exact-name classifier directly from remote/classify",
  );
  assert.ok(
    cliSource.includes('from "@/lib/cloudflare/d1/remote/targets"'),
    "the CLI must import selectD1RemoteTargets directly from remote/targets",
  );
  assert.ok(cliCode.includes("parseD1RemoteListJson"), "the CLI must parse `d1 list --json`");
  assert.ok(
    cliCode.includes("classifyD1RemoteTargets"),
    "the CLI must classify the list entries by exact name",
  );
  assert.ok(
    /classifyD1RemoteTargets\([\s\S]*?selectD1RemoteTargets\(options\.databases \?\? D1_REMOTE_DATA_COPY_DATABASES\)/.test(
      resolver,
    ),
    "the HTTP targets must default to the copy databases, never the full four",
  );
  assert.ok(
    !D1_REMOTE_DATA_COPY_DATABASES.includes("worldcons_search"),
    "the copy databases must exclude worldcons_search",
  );
  assert.ok(D1_REMOTE_DATA_COPY_DATABASES.includes("worldcons_core"));
  assert.ok(D1_REMOTE_DATA_COPY_DATABASES.includes("worldcons_ingest"));
  assert.ok(D1_REMOTE_DATA_COPY_DATABASES.includes("worldcons_ops"));

  // main builds the lazy callback in apply mode and never awaits it eagerly, so a
  // dry-run passes undefined and a small file-only apply never authenticates.
  assert.ok(
    /const executeParameterized = createLazyParameterizedWriter\(\{ apply, runner, databases \}\)/.test(cliCode),
    "main must build the lazy writer with `{ apply, runner, databases }` and never await it eagerly",
  );
  assert.ok(
    /buildD1RemoteDataCopyManifest\(\{[\s\S]*?\bexecuteParameterized,/.test(cliCode),
    "the lazy writer must be passed in as executeParameterized",
  );
  assert.ok(
    /if \(classification\.state !== "existing" \|\| classification\.entry === null\)/.test(resolver) &&
      /databaseIds\[classification\.target\.name\] = classification\.entry\.uuid/.test(resolver),
    "the writer must fail closed unless every target is exactly existing and map its entry.uuid",
  );
  assert.ok(
    cliCode.includes("parseAuthTokenJson") && cliCode.includes("parseWhoamiAccountId"),
    "the CLI must parse auth token and whoami JSON strictly",
  );
  // main only runs when the module is the entry script, so the helpers are import-safe.
  assert.ok(
    cliCode.includes("pathToFileURL") && cliCode.includes("import.meta.url"),
    "the CLI must guard main() so the helpers can be imported under test",
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

  // The human output surfaces the preflight write plan per table and in the totals.
  assert.ok(
    cliSource.includes("planned ${table.plannedWriteCount} / parameterized ${table.plannedParameterizedWriteCount}"),
    "the human output must print each table's planned/parameterized write counts",
  );
  assert.ok(
    cliSource.includes(
      "planned ${manifest.totals.plannedWrites} / parameterized ${manifest.totals.plannedParameterizedWrites}",
    ),
    "the human output must print the planned/parameterized write totals",
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

/** A valid 32-hex Cloudflare account id, a UUID-shaped D1 id and a sentinel token. */
const CREDENTIAL_ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const CREDENTIAL_DATABASE_UUID = "11111111-2222-3333-4444-555555555555";
const CREDENTIAL_TOKEN = "secret-api-token-value";

const CREDENTIAL_LIST_JSON = JSON.stringify([
  { name: "worldcons_core", uuid: CREDENTIAL_DATABASE_UUID, created_at: "2026-09-21T00:00:00.000Z" },
]);
const CREDENTIAL_TOKEN_JSON = JSON.stringify({ type: "api_token", token: CREDENTIAL_TOKEN });
const CREDENTIAL_WHOAMI_JSON = JSON.stringify({
  loggedIn: true,
  accounts: [{ id: CREDENTIAL_ACCOUNT_ID, name: "operator" }],
});

interface CredentialRunner {
  runner: WranglerD1Runner;
  calls: string[][];
}

/**
 * A fake Wrangler runner that answers the three credential/list commands and
 * records every argv, so a test can prove the lazy path makes each call exactly
 * once. Any other command fails, so an unexpected invocation is never silent.
 */
function createCredentialRunner(
  overrides: Partial<{ authToken: string | Error; whoami: string | Error; list: string | Error }> = {},
): CredentialRunner {
  const calls: string[][] = [];
  const runner: WranglerD1Runner = async (args) => {
    calls.push(args);
    const command = args.join(" ");
    const chosen = (value: string | Error | undefined, fallback: string): string => {
      const resolved = value ?? fallback;
      if (resolved instanceof Error) throw resolved;
      return resolved;
    };
    if (command === "auth token --json") return chosen(overrides.authToken, CREDENTIAL_TOKEN_JSON);
    if (command === "whoami --json") return chosen(overrides.whoami, CREDENTIAL_WHOAMI_JSON);
    if (command === "d1 list --json") return chosen(overrides.list, CREDENTIAL_LIST_JSON);
    throw new Error(`unexpected wrangler command: ${command}`);
  };
  return { runner, calls };
}

/** A fake D1 HTTP API that succeeds with zero network and counts its requests. */
function createCredentialFetch(): { fetchImpl: typeof fetch; count: () => number } {
  let count = 0;
  const fetchImpl = (async () => {
    count += 1;
    return new Response(JSON.stringify({ success: true, result: [{ success: true }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchImpl, count: () => count };
}

test("the lazy parameterized writer is undefined in dry-run and reads no credential", () => {
  const { runner, calls } = createCredentialRunner();
  const writer = createLazyParameterizedWriter({ apply: false, runner, databases: null, env: {} });
  assert.equal(writer, undefined);
  assert.equal(calls.length, 0, "a dry-run must not resolve a credential, whoami or d1 list");
});

test("a small file-only apply holds the lazy writer but never invokes it", async () => {
  const harness = createHarness();
  const { runner: credentialRunner, calls } = createCredentialRunner();
  const executeParameterized = createLazyParameterizedWriter({
    apply: true,
    runner: credentialRunner,
    databases: ["worldcons_core"],
    env: {},
  });
  assert.equal(typeof executeParameterized, "function");

  const manifest = await buildD1RemoteDataCopyManifest({
    runner: harness.runner,
    source: source(),
    schema,
    databases: ["worldcons_core"],
    apply: true,
    materializeChunk: harness.materialize,
    executeParameterized,
  });

  assert.equal(manifest.ok, true, manifest.errors.join("; "));
  assert.equal(manifest.totals.copied, 1);
  assert.deepEqual(harness.executions, ["file"], "a small apply writes only through Wrangler --file");
  assert.equal(harness.parameterCalls.length, 0);
  assert.equal(calls.length, 0, "a small file-only apply must never resolve credentials, whoami or d1 list");
});

test("the first oversized write resolves auth token + whoami + d1 list once, then reuses the cached writer", async () => {
  const { runner, calls } = createCredentialRunner();
  const { fetchImpl, count } = createCredentialFetch();
  const executeParameterized = createLazyParameterizedWriter({
    apply: true,
    runner,
    databases: ["worldcons_core"],
    env: {},
    fetch: fetchImpl,
  });
  assert.ok(executeParameterized);

  const statement: D1ImportStatement = {
    sql: "insert into copy_probe (id, body, rank) values (?, ?, ?);",
    params: ["row-1", "body 1", 1],
  };
  await executeParameterized("worldcons_core", statement);
  await executeParameterized("worldcons_core", statement);

  assert.deepEqual(
    calls,
    [
      ["auth", "token", "--json"],
      ["whoami", "--json"],
      ["d1", "list", "--json"],
    ],
    "credential and list resolution must happen exactly once, on the first actual invocation",
  );
  assert.equal(count(), 2, "both statements still reach the D1 HTTP API");
});

test("environment credentials skip auth token and whoami but still classify d1 list once", async () => {
  const { runner, calls } = createCredentialRunner();
  const { fetchImpl } = createCredentialFetch();
  const executeParameterized = createLazyParameterizedWriter({
    apply: true,
    runner,
    databases: ["worldcons_core"],
    env: { CLOUDFLARE_ACCOUNT_ID: CREDENTIAL_ACCOUNT_ID, CLOUDFLARE_API_TOKEN: "env-token" },
    fetch: fetchImpl,
  });
  assert.ok(executeParameterized);

  await executeParameterized("worldcons_core", { sql: "insert into copy_probe (id) values (?);", params: ["row-1"] });

  assert.deepEqual(calls, [["d1", "list", "--json"]], "env credentials must skip auth token and whoami");
});

test("a malformed or global-key auth token fails closed without leaking the token", () => {
  const malformed = [
    "<!doctype html><html>not json</html>",
    JSON.stringify({ type: "api_key", token: CREDENTIAL_TOKEN }),
    JSON.stringify({ type: "api_token" }),
    JSON.stringify({ type: "api_token", token: "" }),
  ];
  for (const output of malformed) {
    assert.throws(
      () => parseAuthTokenJson(output),
      (error: unknown) => {
        assert.ok(error instanceof D1RemoteError, "auth token failures must be a stable D1RemoteError");
        assert.ok(!error.message.includes(CREDENTIAL_TOKEN), "the error must never include the token");
        assert.ok(!error.message.includes("doctype"), "the error must never include the raw output");
        return true;
      },
    );
  }
  assert.equal(
    parseAuthTokenJson(JSON.stringify({ type: "oauth", token: CREDENTIAL_TOKEN })),
    CREDENTIAL_TOKEN,
    "an oauth token is accepted",
  );
});

test("a malformed, logged-out or ambiguous whoami fails closed with a stable code", () => {
  assert.throws(() => parseWhoamiAccountId("<not json>", null), /malformed_whoami_json/);
  assert.throws(
    () => parseWhoamiAccountId(JSON.stringify({ loggedIn: false, accounts: [] }), null),
    /not_logged_in/,
  );
  assert.throws(() => parseWhoamiAccountId(JSON.stringify({ loggedIn: true }), null), /malformed_whoami_json/);
  assert.throws(
    () =>
      parseWhoamiAccountId(
        JSON.stringify({
          loggedIn: true,
          accounts: [{ id: CREDENTIAL_ACCOUNT_ID }, { id: "ffffffffffffffffffffffffffffffff" }],
        }),
        null,
      ),
    /ambiguous_account/,
  );
  assert.throws(
    () => parseWhoamiAccountId(JSON.stringify({ loggedIn: true, accounts: [{ id: "not-a-hex-id" }] }), null),
    /invalid_account_id/,
  );
  assert.throws(
    () =>
      parseWhoamiAccountId(
        JSON.stringify({ loggedIn: true, accounts: [{ id: CREDENTIAL_ACCOUNT_ID }] }),
        "ffffffffffffffffffffffffffffffff",
      ),
    /account_mismatch/,
  );
  assert.equal(
    parseWhoamiAccountId(JSON.stringify({ loggedIn: true, accounts: [{ id: CREDENTIAL_ACCOUNT_ID }] }), null),
    CREDENTIAL_ACCOUNT_ID,
    "a single valid account is selected directly",
  );
  assert.equal(
    parseWhoamiAccountId(
      JSON.stringify({ loggedIn: true, accounts: [{ id: CREDENTIAL_ACCOUNT_ID }] }),
      CREDENTIAL_ACCOUNT_ID,
    ),
    CREDENTIAL_ACCOUNT_ID,
    "a matching expected account is returned unchanged",
  );
});

test("a malformed d1 list fails closed from the resolver before any HTTP request", async () => {
  const { runner, calls } = createCredentialRunner({ list: "not json" });
  const { fetchImpl, count } = createCredentialFetch();
  await assert.rejects(
    resolveParameterizedWriter({
      runner,
      databases: ["worldcons_core"],
      env: { CLOUDFLARE_ACCOUNT_ID: CREDENTIAL_ACCOUNT_ID, CLOUDFLARE_API_TOKEN: "env-token" },
      fetch: fetchImpl,
    }),
    /malformed_list_json/,
  );
  assert.deepEqual(calls, [["d1", "list", "--json"]]);
  assert.equal(count(), 0, "a malformed list must fail before any HTTP request");
});

test("a lazy writer whose first resolution fails stays failed closed and never retries auth", async () => {
  const { runner, calls } = createCredentialRunner({
    authToken: JSON.stringify({ type: "api_key", token: CREDENTIAL_TOKEN }),
  });
  const { fetchImpl } = createCredentialFetch();
  const executeParameterized = createLazyParameterizedWriter({
    apply: true,
    runner,
    databases: ["worldcons_core"],
    env: {},
    fetch: fetchImpl,
  });
  assert.ok(executeParameterized);
  const statement: D1ImportStatement = { sql: "insert into copy_probe (id) values (?);", params: ["row-1"] };
  await assert.rejects(executeParameterized("worldcons_core", statement), /auth_token_unusable/);
  await assert.rejects(executeParameterized("worldcons_core", statement), /auth_token_unusable/);
  assert.deepEqual(calls, [["auth", "token", "--json"]], "a cached rejection must not re-run auth or d1 list");
});
