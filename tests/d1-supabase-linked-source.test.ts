import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import type { PostgresReadRequest } from "../lib/cloudflare/d1/convert";
import {
  buildPostgresSelectSql,
  buildSupabaseLinkedInvocation,
  createSupabaseLinkedRowSource,
  defaultSupabaseBinary,
  parseSupabaseLinkedRows,
  supabaseLinkedQueryArgs,
} from "../lib/cloudflare/d1/convert/supabase-linked-source";

const rootDir = process.cwd();

function request(overrides: Partial<PostgresReadRequest> = {}): PostgresReadRequest {
  return { relation: "articles", columns: ["id", "title"], orderBy: ["id"], limit: null, offset: 0, ...overrides };
}

/**
 * One realistic `rows` payload covering every scalar family the parser must
 * preserve: a bigint decimal past Number.MAX_SAFE_INTEGER, a jsonb object, a
 * text[] array, a boolean, a null and a timestamp string.
 */
const PARSED_ROW: Record<string, unknown> = {
  id: "aaaaaaaa-0000-0000-0000-000000000001",
  big_counter: "9007199254740993",
  payload: { b: 1, a: 2, nested: { ok: true } },
  labels: ["z", "a"],
  is_active: true,
  deleted_at: null,
  created_at: "2026-05-08T10:00:00+00:00",
};

test("buildPostgresSelectSql quotes identifiers and inlines bounded limit/offset deterministically", () => {
  assert.equal(
    buildPostgresSelectSql(request({ columns: ["id", "created_at", "payload"], limit: 100, offset: 200 })),
    'select "id", "created_at", "payload" from "articles" order by "id" limit 100 offset 200',
  );
  assert.equal(
    buildPostgresSelectSql(request({ orderBy: ["tenant_id", "id"] })),
    'select "id", "title" from "articles" order by "tenant_id", "id"',
  );
  assert.equal(buildPostgresSelectSql(request()), 'select "id", "title" from "articles" order by "id"');
  assert.equal(buildPostgresSelectSql(request({ orderBy: [] })), 'select "id", "title" from "articles"');
  assert.equal(
    buildPostgresSelectSql(request({ orderBy: [], limit: 5 })),
    'select "id", "title" from "articles" limit 5',
  );
  assert.equal(
    buildPostgresSelectSql(request({ orderBy: [], limit: null, offset: 7 })),
    'select "id", "title" from "articles" offset 7',
  );
  assert.equal(
    buildPostgresSelectSql(request()),
    buildPostgresSelectSql(request()),
    "identical requests must produce byte-identical SQL",
  );
});

test("buildPostgresSelectSql fails closed on an unsafe identifier or an invalid bound", () => {
  assert.throws(() => buildPostgresSelectSql(request({ relation: "Articles" })), /invalid postgres identifier/);
  assert.throws(
    () => buildPostgresSelectSql(request({ relation: 'articles"; drop table x; --' })),
    /invalid postgres identifier/,
  );
  assert.throws(() => buildPostgresSelectSql(request({ columns: ["id", "bad column"] })), /invalid postgres identifier/);
  assert.throws(() => buildPostgresSelectSql(request({ orderBy: ["id; drop table x"] })), /invalid postgres identifier/);
  assert.throws(() => buildPostgresSelectSql(request({ columns: [] })), /no projectable columns/);
  assert.throws(() => buildPostgresSelectSql(request({ offset: -1 })), /invalid postgres offset/);
  assert.throws(() => buildPostgresSelectSql(request({ offset: 1.5 })), /invalid postgres offset/);
  assert.throws(() => buildPostgresSelectSql(request({ limit: -1 })), /invalid postgres limit/);
  assert.throws(() => buildPostgresSelectSql(request({ limit: 1.5 })), /invalid postgres limit/);
  assert.throws(
    () => buildPostgresSelectSql(request({ limit: Number.MAX_SAFE_INTEGER + 1 })),
    /invalid postgres limit/,
  );
});

test("parseSupabaseLinkedRows reads one envelope out of preamble/footer text and preserves every value exactly", () => {
  const stdout = [
    "Connecting to linked project: worldcons",
    "Fetching schema...",
    JSON.stringify({ rows: [PARSED_ROW] }),
    "Query finished in 42ms",
    "",
  ].join("\n");

  const rows = parseSupabaseLinkedRows(stdout);
  assert.deepEqual(rows, [PARSED_ROW]);
  assert.equal(rows.length, 1);

  // bigint decimals stay exact strings past Number.MAX_SAFE_INTEGER.
  assert.equal(typeof rows[0].big_counter, "string");
  assert.ok(Number(rows[0].big_counter as string) > Number.MAX_SAFE_INTEGER);

  // jsonb stays an object, text[] stays an array, boolean/null are untouched and the timestamp keeps its string.
  assert.deepEqual(rows[0].payload, { b: 1, a: 2, nested: { ok: true } });
  assert.deepEqual(rows[0].labels, ["z", "a"]);
  assert.equal(rows[0].is_active, true);
  assert.equal(rows[0].deleted_at, null);
  assert.equal(rows[0].created_at, "2026-05-08T10:00:00+00:00");
});

test("parseSupabaseLinkedRows accepts an empty rows array", () => {
  assert.deepEqual(parseSupabaseLinkedRows('{"rows": []}'), []);
});

test("parseSupabaseLinkedRows fails closed on missing, malformed, ambiguous or non-object output", () => {
  assert.throws(() => parseSupabaseLinkedRows(""), /did not return a JSON envelope/);
  assert.throws(() => parseSupabaseLinkedRows("no json envelope here"), /did not return a JSON envelope/);
  assert.throws(() => parseSupabaseLinkedRows('{ "rows": [ '), /did not return a JSON envelope/);
  assert.throws(() => parseSupabaseLinkedRows('[{"rows": []}]'), /did not return a JSON envelope/);
  assert.throws(() => parseSupabaseLinkedRows('{"result": []}'), /missing a rows array/);
  assert.throws(() => parseSupabaseLinkedRows('{"rows": {}}'), /missing a rows array/);
  assert.throws(() => parseSupabaseLinkedRows('{"rows": [1]}'), /non-object row/);
  assert.throws(() => parseSupabaseLinkedRows('{"rows": []}\n{"rows": [{}]}'), /multiple JSON envelopes/);
  assert.throws(() => parseSupabaseLinkedRows("Loading...\n{}\n{}\nDone."), /multiple JSON envelopes/);
});

test("createSupabaseLinkedRowSource runs the deterministic SELECT and projects only the requested columns", async () => {
  const sqlCalls: string[] = [];
  const runner = async (sql: string): Promise<string> => {
    sqlCalls.push(sql);
    const envelope = JSON.stringify({
      rows: [
        { id: "a", title: "t", body: "drop me", big_counter: "9007199254740993" },
        { id: "b", title: "u", body: "drop me too", big_counter: "12" },
      ],
    });
    return `supabase: linked\n${envelope}\n`;
  };

  const source = createSupabaseLinkedRowSource({ runner });
  assert.equal(source.isConfigured(), true);

  const readRequest = request({ columns: ["id", "title", "big_counter"], limit: 2, offset: 1 });
  const rows = await source.readRows(readRequest);
  assert.deepEqual(rows, [
    { id: "a", title: "t", big_counter: "9007199254740993" },
    { id: "b", title: "u", big_counter: "12" },
  ]);
  assert.equal(typeof rows[0].big_counter, "string");
  assert.deepEqual(sqlCalls, [buildPostgresSelectSql(readRequest)]);

  await source.close();
  await assert.rejects(() => source.readRows(readRequest), /closed/);
});

test("createSupabaseLinkedRowSource fails closed when the runner returns no envelope", async () => {
  const source = createSupabaseLinkedRowSource({ runner: async () => "not json" });
  await assert.rejects(() => source.readRows(request()), /did not return a JSON envelope/);
});

test("supabaseLinkedQueryArgs returns the exact deterministic argv for one statement", () => {
  const sql = buildPostgresSelectSql(request());
  assert.deepEqual(supabaseLinkedQueryArgs(sql), ["db", "query", "--linked", "-o", "json", sql]);
  assert.deepEqual(supabaseLinkedQueryArgs("select 1"), ["db", "query", "--linked", "-o", "json", "select 1"]);
});

test("buildSupabaseLinkedInvocation routes Windows shims through ComSpec/cmd.exe and spawns directly elsewhere", () => {
  assert.deepEqual(
    buildSupabaseLinkedInvocation({
      binary: "supabase.cmd",
      args: ["db", "query", "--linked", "-o", "json", "select 1"],
      platform: "win32",
      env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
    }),
    {
      command: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/c", "supabase.cmd", "db", "query", "--linked", "-o", "json", "select 1"],
    },
  );
  assert.equal(
    buildSupabaseLinkedInvocation({
      binary: "supabase.cmd",
      args: [],
      platform: "win32",
      comspec: "C:\\custom\\cmd.exe",
    }).command,
    "C:\\custom\\cmd.exe",
    "an explicit comspec override wins",
  );
  assert.equal(
    buildSupabaseLinkedInvocation({
      binary: "supabase.cmd",
      args: [],
      platform: "win32",
      env: { COMSPEC: "C:\\upper\\cmd.exe" },
    }).command,
    "C:\\upper\\cmd.exe",
    "the uppercase COMSPEC is a fallback",
  );
  assert.equal(
    buildSupabaseLinkedInvocation({ binary: "supabase.cmd", args: [], platform: "win32", env: { ComSpec: "   " } })
      .command,
    "cmd.exe",
    "a blank interpreter falls back to cmd.exe",
  );
  assert.equal(
    buildSupabaseLinkedInvocation({ binary: "supabase.cmd", args: [], platform: "win32", env: {} }).command,
    "cmd.exe",
  );

  assert.deepEqual(buildSupabaseLinkedInvocation({ binary: "supabase", args: ["db", "query"], platform: "linux" }), {
    command: "supabase",
    args: ["db", "query"],
  });
  assert.deepEqual(
    buildSupabaseLinkedInvocation({ binary: "/usr/local/bin/supabase", args: ["db"], platform: "darwin" }),
    { command: "/usr/local/bin/supabase", args: ["db"] },
  );

  assert.equal(defaultSupabaseBinary(), "supabase", "the bare command resolves via cmd.exe PATH/PATHEXT");
  assert.equal(defaultSupabaseBinary(), defaultSupabaseBinary(), "the default is platform-independent and stable");
});

test("the child-process linked source stays out of the runtime convert barrel", () => {
  const barrel = readFileSync(path.join(rootDir, "lib/cloudflare/d1/convert/index.ts"), "utf8");
  assert.ok(!barrel.includes("supabase-linked-source"), "the source must not be re-exported from the barrel");
  for (const name of [
    "buildPostgresSelectSql",
    "parseSupabaseLinkedRows",
    "createSupabaseLinkedRowSource",
    "supabaseLinkedQueryArgs",
    "buildSupabaseLinkedInvocation",
  ]) {
    assert.ok(!barrel.includes(name), `the barrel must not export ${name}`);
  }

  const adapter = readFileSync(path.join(rootDir, "lib/cloudflare/d1/convert/supabase-linked-source.ts"), "utf8");
  assert.ok(
    adapter.includes('from "node:child_process"'),
    "the operator adapter must own the child-process import",
  );
});
