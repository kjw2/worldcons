import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { PostgresReadRequest } from "../lib/cloudflare/d1/convert";
import {
  buildPostgresSelectSql,
  buildSupabaseLinkedInvocation,
  createSupabaseLinkedQueryRunner,
  createSupabaseLinkedRowSource,
  defaultSupabaseBinary,
  parseSupabaseLinkedRows,
  resolveWindowsSupabaseBinary,
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

function assertRowPreserved(rows: Record<string, unknown>[]): void {
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
}

test("parseSupabaseLinkedRows reads a bare top-level row array out of preamble/footer text and preserves every value exactly", () => {
  const stdout = [
    "Connecting to linked project: worldcons",
    "Fetching schema...",
    JSON.stringify([PARSED_ROW]),
    "Query finished in 42ms",
    "",
  ].join("\n");

  assertRowPreserved(parseSupabaseLinkedRows(stdout));
});

test("parseSupabaseLinkedRows still accepts the legacy object envelope out of preamble/footer text and preserves every value exactly", () => {
  const stdout = [
    "Connecting to linked project: worldcons",
    "Fetching schema...",
    JSON.stringify({ rows: [PARSED_ROW] }),
    "Query finished in 42ms",
    "",
  ].join("\n");

  assertRowPreserved(parseSupabaseLinkedRows(stdout));
});

test("parseSupabaseLinkedRows accepts an empty bare array or an empty envelope", () => {
  assert.deepEqual(parseSupabaseLinkedRows("[]"), []);
  assert.deepEqual(parseSupabaseLinkedRows("Loading...\n[]\nDone."), []);
  assert.deepEqual(parseSupabaseLinkedRows('{"rows": []}'), []);
});

test("parseSupabaseLinkedRows treats a bare array row that happens to carry a rows key as an ordinary row", () => {
  assert.deepEqual(parseSupabaseLinkedRows('[{"rows": []}]'), [{ rows: [] }]);
  assert.deepEqual(parseSupabaseLinkedRows('[{"rows": [1]}]'), [{ rows: [1] }]);
});

test("parseSupabaseLinkedRows fails closed on missing, malformed, ambiguous or non-object output", () => {
  assert.throws(() => parseSupabaseLinkedRows(""), /did not return a JSON payload/);
  assert.throws(() => parseSupabaseLinkedRows("no json payload here"), /did not return a JSON payload/);
  assert.throws(() => parseSupabaseLinkedRows('{ "rows": [ '), /did not return a JSON payload/);
  assert.throws(() => parseSupabaseLinkedRows('{"result": []}'), /missing a rows array/);
  assert.throws(() => parseSupabaseLinkedRows('{"rows": {}}'), /missing a rows array/);
  assert.throws(() => parseSupabaseLinkedRows('{"rows": [1]}'), /non-object row/);
  assert.throws(() => parseSupabaseLinkedRows("[1]"), /non-object row/);
  assert.throws(() => parseSupabaseLinkedRows("[null]"), /non-object row/);
  assert.throws(() => parseSupabaseLinkedRows('{"rows": []}\n{"rows": [{}]}'), /multiple JSON payloads/);
  assert.throws(() => parseSupabaseLinkedRows('{"rows": []}\n[{}]'), /multiple JSON payloads/);
  assert.throws(() => parseSupabaseLinkedRows("[{}]\n[{}]"), /multiple JSON payloads/);
  assert.throws(() => parseSupabaseLinkedRows("Loading...\n{}\n{}\nDone."), /multiple JSON payloads/);
});

test("createSupabaseLinkedRowSource runs the deterministic SELECT and projects only the requested columns from a bare array", async () => {
  const sqlCalls: string[] = [];
  const runner = async (sql: string): Promise<string> => {
    sqlCalls.push(sql);
    const payload = JSON.stringify([
      { id: "a", title: "t", body: "drop me", big_counter: "9007199254740993" },
      { id: "b", title: "u", body: "drop me too", big_counter: "12" },
    ]);
    return `supabase: linked\n${payload}\n`;
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

test("createSupabaseLinkedRowSource still reads the legacy rows envelope", async () => {
  const runner = async (): Promise<string> =>
    `supabase: linked\n${JSON.stringify({ rows: [{ id: "a", title: "t", body: "drop me" }] })}\n`;
  const source = createSupabaseLinkedRowSource({ runner });
  const rows = await source.readRows(request({ columns: ["id", "title"] }));
  assert.deepEqual(rows, [{ id: "a", title: "t" }]);
});

test("createSupabaseLinkedRowSource fails closed when the runner returns no payload", async () => {
  const source = createSupabaseLinkedRowSource({ runner: async () => "not json" });
  await assert.rejects(() => source.readRows(request()), /did not return a JSON payload/);
});

test("supabaseLinkedQueryArgs returns the exact deterministic argv for one statement", () => {
  const sql = buildPostgresSelectSql(request());
  assert.deepEqual(supabaseLinkedQueryArgs(sql), ["db", "query", "--linked", "-o", "json", sql]);
  assert.deepEqual(supabaseLinkedQueryArgs("select 1"), ["db", "query", "--linked", "-o", "json", "select 1"]);
});

test("buildSupabaseLinkedInvocation directly spawns a resolved Windows .exe with the SQL as one argv entry", () => {
  const sql = 'select "id", "title" from "articles" order by "id"';
  const args = ["db", "query", "--linked", "-o", "json", sql];
  const invocation = buildSupabaseLinkedInvocation({
    binary: "supabase",
    args,
    platform: "win32",
    resolveBinary: () => "C:\\tools\\supabase\\supabase.exe",
  });
  assert.deepEqual(invocation, { command: "C:\\tools\\supabase\\supabase.exe", args });
  assert.equal(invocation.args[5], sql, "the quoted SQL stays exactly one argv entry");
  assert.equal(invocation.windowsVerbatimArguments, undefined, "a native spawn is not verbatim");

  // An explicitly named executable short-circuits the PATH search entirely.
  assert.deepEqual(
    buildSupabaseLinkedInvocation({ binary: "C:\\tools\\supabase.exe", args: ["db"], platform: "win32" }),
    { command: "C:\\tools\\supabase.exe", args: ["db"] },
  );
});

test("buildSupabaseLinkedInvocation routes a Windows .cmd shim through cmd.exe with a safely-quoted verbatim command line", () => {
  const sql = 'select "id", "title" from "articles" order by "id"';
  const args = ["db", "query", "--linked", "-o", "json", sql];
  const shim = "C:\\Users\\op\\AppData\\Roaming\\npm\\supabase.cmd";
  const invocation = buildSupabaseLinkedInvocation({
    binary: "supabase",
    args,
    platform: "win32",
    env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
    resolveBinary: () => shim,
  });
  assert.equal(invocation.command, "C:\\Windows\\System32\\cmd.exe");
  assert.equal(invocation.windowsVerbatimArguments, true, "cmd fallback must not let Node re-quote");
  assert.deepEqual(invocation.args.slice(0, 3), ["/d", "/s", "/c"]);
  const line = invocation.args[3];
  assert.equal(
    line,
    `""${shim}" "db" "query" "--linked" "-o" "json" "select \\"id\\", \\"title\\" from \\"articles\\" order by \\"id\\"""`,
    "each argument is quoted, embedded quotes are escaped, and the whole line is wrapped for cmd /s",
  );
});

test("buildSupabaseLinkedInvocation leaves an unresolved bare name for cmd.exe to resolve", () => {
  const args = ["db", "query", "--linked", "-o", "json", "select 1"];
  const invocation = buildSupabaseLinkedInvocation({
    binary: "supabase",
    args,
    platform: "win32",
    resolveBinary: () => null,
    env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
  });
  assert.equal(invocation.command, "C:\\Windows\\System32\\cmd.exe");
  assert.equal(invocation.windowsVerbatimArguments, true);
  assert.equal(
    invocation.args[3],
    '"supabase "db" "query" "--linked" "-o" "json" "select 1""',
    "the bare command stays unquoted so cmd.exe resolves it via PATH",
  );
});

test("buildSupabaseLinkedInvocation honors the Windows interpreter override and spawns directly elsewhere", () => {
  const shim = () => "C:\\tools\\supabase.cmd";
  assert.equal(
    buildSupabaseLinkedInvocation({
      binary: "supabase",
      args: [],
      platform: "win32",
      comspec: "C:\\custom\\cmd.exe",
      resolveBinary: shim,
    }).command,
    "C:\\custom\\cmd.exe",
    "an explicit comspec override wins",
  );
  assert.equal(
    buildSupabaseLinkedInvocation({
      binary: "supabase",
      args: [],
      platform: "win32",
      env: { COMSPEC: "C:\\upper\\cmd.exe" },
      resolveBinary: shim,
    }).command,
    "C:\\upper\\cmd.exe",
    "the uppercase COMSPEC is a fallback",
  );
  assert.equal(
    buildSupabaseLinkedInvocation({
      binary: "supabase",
      args: [],
      platform: "win32",
      env: { ComSpec: "   " },
      resolveBinary: shim,
    }).command,
    "cmd.exe",
    "a blank interpreter falls back to cmd.exe",
  );
  assert.equal(
    buildSupabaseLinkedInvocation({ binary: "supabase", args: [], platform: "win32", env: {}, resolveBinary: shim })
      .command,
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

  assert.equal(defaultSupabaseBinary(), "supabase", "the bare name is resolved dynamically, never hard-coded");
  assert.equal(defaultSupabaseBinary(), defaultSupabaseBinary(), "the default is platform-independent and stable");
});

test(
  "resolveWindowsSupabaseBinary searches PATH and prefers a native .exe over a .cmd shim",
  { skip: process.platform !== "win32" },
  () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "d1-linked-resolve-"));
    try {
      fs.writeFileSync(path.join(dir, "supabase.cmd"), "");
      assert.equal(
        resolveWindowsSupabaseBinary("supabase", { Path: dir }),
        path.join(dir, "supabase.cmd"),
        "a lone .cmd shim is found",
      );
      fs.writeFileSync(path.join(dir, "supabase.exe"), "");
      assert.equal(
        resolveWindowsSupabaseBinary("supabase", { Path: dir }),
        path.join(dir, "supabase.exe"),
        "the native .exe wins over the .cmd in the same directory",
      );
      assert.equal(resolveWindowsSupabaseBinary("supabase", { Path: path.join(dir, "missing") }), null);
      assert.equal(
        resolveWindowsSupabaseBinary("C:\\custom\\supabase.exe", { Path: dir }),
        "C:\\custom\\supabase.exe",
        "an explicit path is not searched",
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("the child-process linked source stays out of the runtime convert barrel", () => {
  const barrel = fs.readFileSync(path.join(rootDir, "lib/cloudflare/d1/convert/index.ts"), "utf8");
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

  const adapter = fs.readFileSync(path.join(rootDir, "lib/cloudflare/d1/convert/supabase-linked-source.ts"), "utf8");
  assert.ok(
    adapter.includes('from "node:child_process"'),
    "the operator adapter must own the child-process import",
  );
});

/**
 * Writes a Node probe that emits `target` as raw UTF-8 bytes, deliberately split
 * into chunks of the given byte sizes and separated by a short delay so each
 * write is delivered as its own stdout data event. Exits with `exitCode` (0 by
 * default) once every byte has been written.
 */
function writeSplitUtf8Probe(
  dir: string,
  name: string,
  target: string,
  split: readonly number[],
  exitCode = 0,
): string {
  const file = path.join(dir, name);
  const source = [
    `const bytes = Buffer.from(${JSON.stringify(target)}, "utf8");`,
    `const split = ${JSON.stringify(split)};`,
    `const exitCode = ${exitCode};`,
    "let index = 0;",
    "let step = 0;",
    "function pump() {",
    "  if (index >= bytes.length) process.exit(exitCode);",
    "  const size = split[step % split.length];",
    "  process.stdout.write(bytes.subarray(index, index + size));",
    "  index += size;",
    "  step += 1;",
    "  setTimeout(pump, 25);",
    "}",
    "pump();",
  ].join("\n");
  fs.writeFileSync(file, source, "utf8");
  return file;
}

test("the linked child-process runner reassembles a UTF-8 code point split across stdout chunks", async () => {
  const target = "\uC11C"; // Korean 'seo' — 3 UTF-8 bytes (ec 84 9c)
  for (const split of [[1, 2], [1, 1, 1]] as const) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "d1-linked-decode-"));
    try {
      const probe = writeSplitUtf8Probe(dir, "probe.js", target, split);
      // The probe is launched as Node directly so the assertion measures stream
      // decoding only; the platform seam keeps argv entries intact on every host.
      const runner = createSupabaseLinkedQueryRunner({
        binary: process.execPath,
        prefixArgs: [probe],
        platform: "linux",
        timeoutMs: 10_000,
      });
      const stdout = await runner("select 1");
      assert.equal(stdout, target, `split ${split.join("+")} must decode to exactly ${target}`);
      assert.ok(!stdout.includes("\uFFFD"), `split ${split.join("+")} must not emit U+FFFD`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("a failed linked run rejects with the bounded message and never surfaces decoded output", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "d1-linked-decode-fail-"));
  try {
    const probe = writeSplitUtf8Probe(dir, "probe-fail.js", "\uC11C", [1], 3);
    const runner = createSupabaseLinkedQueryRunner({
      binary: process.execPath,
      prefixArgs: [probe],
      platform: "linux",
      timeoutMs: 10_000,
    });
    await assert.rejects(
      () => runner("select 1"),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /supabase db query failed with exit code 3/);
        assert.ok(!error.message.includes("\uC11C"));
        assert.ok(!error.message.includes("\uFFFD"));
        return true;
      },
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Writes a `.cmd` shim plus a Node probe that records the argv it receives to
 * `argv.json` beside itself. The shim forwards `%*` to Node, so the recorded argv
 * is exactly what a real `.cmd` Supabase shim's child process would see.
 */
function writeArgvProbeCmd(dir: string): string {
  fs.writeFileSync(
    path.join(dir, "dump-argv.js"),
    'require("fs").writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)));',
    "utf8",
  );
  fs.writeFileSync(path.join(dir, "probe.cmd"), '@echo off\r\nnode "%~dp0dump-argv.js" "%~dp0argv.json" %*\r\n', "ascii");
  return path.join(dir, "probe.cmd");
}

test(
  "the Windows cmd fallback delivers quoted SQL to a .cmd shim as one argv entry",
  { skip: process.platform !== "win32" },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "d1-linked-cmd-"));
    try {
      const probe = writeArgvProbeCmd(dir);
      const runner = createSupabaseLinkedQueryRunner({
        binary: "supabase",
        resolveBinary: () => probe,
        platform: "win32",
        cwd: dir,
        timeoutMs: 10_000,
      });
      const sql = 'select "id", "title" from "articles" order by "id"';
      const stdout = await runner(sql);
      assert.equal(stdout, "", "the shim probe only writes to its side file");
      const argv = JSON.parse(fs.readFileSync(path.join(dir, "argv.json"), "utf8"));
      assert.deepEqual(argv, supabaseLinkedQueryArgs(sql), "cmd.exe must not reparse the quoted SQL");
      assert.equal(argv[5], sql);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "the Windows native .exe path spawns directly and preserves the quoted SQL as one argv entry",
  { skip: process.platform !== "win32" },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "d1-linked-exe-"));
    try {
      const dump = path.join(dir, "dump-argv.js");
      const out = path.join(dir, "argv.json");
      fs.writeFileSync(
        dump,
        'require("fs").writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)));',
        "utf8",
      );
      const runner = createSupabaseLinkedQueryRunner({
        binary: process.execPath,
        prefixArgs: [dump, out],
        platform: "win32",
        cwd: dir,
        timeoutMs: 10_000,
      });
      const sql = 'select "id" from "articles"';
      await runner(sql);
      const argv = JSON.parse(fs.readFileSync(out, "utf8"));
      assert.deepEqual(argv, supabaseLinkedQueryArgs(sql));
      assert.equal(argv[5], sql);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
