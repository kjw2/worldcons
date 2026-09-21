import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { D1_DATABASES } from "../lib/cloudflare/d1";
import {
  D1_REMOTE_BOOTSTRAP_VERSION,
  D1_REMOTE_DEFAULT_LOCATION,
  D1_REMOTE_TARGETS,
  D1RemoteError,
  buildD1RemoteManifest,
  classifyD1RemoteTargets,
  parseD1RemoteInfoJson,
  parseD1RemoteListJson,
  selectD1RemoteTargets,
  type D1RemoteListEntry,
  type WranglerD1Runner,
} from "../lib/cloudflare/d1/remote";
import {
  buildWranglerInvocation,
  createWranglerD1Runner,
  defaultWranglerBinary,
  resolveWindowsCommandInterpreter,
} from "../lib/cloudflare/d1/remote/runner";

const rootDir = process.cwd();

interface FakeDatabase {
  uuid: string;
  name: string;
  created_at: string;
}

interface FakeWranglerOptions {
  failCreateFor?: string;
  infoOverride?: (name: string) => string;
}

interface FakeWrangler {
  runner: WranglerD1Runner;
  calls: string[][];
  databases: FakeDatabase[];
}

function createFakeWrangler(initial: readonly FakeDatabase[] = [], options: FakeWranglerOptions = {}): FakeWrangler {
  const databases = initial.map((entry) => ({ ...entry }));
  const calls: string[][] = [];
  const runner: WranglerD1Runner = async (args) => {
    calls.push(args);
    const [group, command, name] = args;
    if (group !== "d1") throw new Error(`unexpected wrangler group: ${group}`);
    if (command === "list") return JSON.stringify(databases);
    if (command === "create") {
      if (options.failCreateFor !== undefined && options.failCreateFor === name) throw new Error("create failed");
      databases.push({ uuid: `uuid-${name}`, name, created_at: "2026-09-21T00:00:00.000Z" });
      return "created";
    }
    if (command === "info") {
      if (options.infoOverride !== undefined) return options.infoOverride(name);
      const entry = databases.find((candidate) => candidate.name === name);
      if (!entry) throw new Error(`unknown database: ${name}`);
      return JSON.stringify({ name: entry.name, uuid: entry.uuid, created_at: entry.created_at, num_tables: 0, file_size: 0 });
    }
    throw new Error(`unexpected wrangler d1 command: ${command}`);
  };
  return { runner, calls, databases };
}

test("the remote targets are the four D1 databases in canonical order with bindings", () => {
  assert.equal(D1_REMOTE_BOOTSTRAP_VERSION, 1);
  assert.equal(D1_REMOTE_DEFAULT_LOCATION, "apac");
  assert.deepEqual(
    D1_REMOTE_TARGETS.map((target) => target.name),
    [...D1_DATABASES],
  );
  assert.deepEqual(
    D1_REMOTE_TARGETS.map((target) => target.binding),
    ["WORLDCONS_CORE", "WORLDCONS_INGEST", "WORLDCONS_OPS", "WORLDCONS_SEARCH"],
  );
  assert.deepEqual(
    selectD1RemoteTargets(["worldcons_search", "worldcons_core"]).map((target) => target.name),
    ["worldcons_core", "worldcons_search"],
  );
  const copy = selectD1RemoteTargets();
  copy[0].binding = "MUTATED";
  assert.equal(D1_REMOTE_TARGETS[0].binding, "WORLDCONS_CORE", "selection must not mutate the canonical targets");
});

test("the list parser accepts valid JSON and fails closed on malformed input", () => {
  const parsed = parseD1RemoteListJson(
    '[{"name":"worldcons_core","uuid":"abc","created_at":"2026-01-01T00:00:00Z"}]',
  );
  assert.deepEqual(parsed, [{ name: "worldcons_core", uuid: "abc", createdAt: "2026-01-01T00:00:00Z" }]);
  for (const bad of ["not json", "{}", '[{"name":"x"}]', "[1]", '[{"uuid":"y"}]', '[{"name":"x","uuid":""}]']) {
    assert.throws(() => parseD1RemoteListJson(bad), D1RemoteError);
  }
});

test("the info parser accepts valid JSON and fails closed on malformed input", () => {
  const parsed = parseD1RemoteInfoJson('{"name":"worldcons_core","uuid":"abc","num_tables":12,"file_size":2048}');
  assert.equal(parsed.name, "worldcons_core");
  assert.equal(parsed.uuid, "abc");
  assert.equal(parsed.numTables, 12);
  assert.equal(parsed.fileSize, 2048);
  assert.equal(parsed.createdAt, null);
  for (const bad of ["nope", "[]", '{"name":"x"}', '{"uuid":"y"}']) {
    assert.throws(() => parseD1RemoteInfoJson(bad), D1RemoteError);
  }
});

test("classification is exact and refuses an ambiguous name", () => {
  const targets = selectD1RemoteTargets(["worldcons_core", "worldcons_ingest"]);
  const entries: D1RemoteListEntry[] = [
    { uuid: "a", name: "worldcons_core", createdAt: null },
    { uuid: "b", name: "worldcons_ingest", createdAt: null },
    { uuid: "c", name: "worldcons_ingest", createdAt: null },
  ];
  const classified = classifyD1RemoteTargets(entries, targets);
  assert.deepEqual(
    classified.map((entry) => entry.state),
    ["existing", "ambiguous"],
  );
  assert.equal(classified[0].matches, 1);
  assert.equal(classified[1].matches, 2);
  assert.deepEqual(
    classifyD1RemoteTargets([], targets).map((entry) => entry.state),
    ["missing", "missing"],
  );
});

test("dry-run preflight lists the remote databases and never creates", async () => {
  const fake = createFakeWrangler();
  const manifest = await buildD1RemoteManifest({ runner: fake.runner });
  assert.equal(manifest.version, D1_REMOTE_BOOTSTRAP_VERSION);
  assert.equal(manifest.stage, "d1-remote-bootstrap");
  assert.equal(manifest.dryRun, true);
  assert.equal(manifest.applied, false);
  assert.equal(manifest.location, "apac");
  assert.equal(manifest.ok, true);
  assert.deepEqual(manifest.totals, { targets: 4, existing: 0, created: 0, missing: 4, refused: 0 });
  assert.ok(manifest.targets.every((target) => target.state === "missing" && target.action === "create" && !target.verified));
  assert.deepEqual(manifest.commands, ["d1 list --json"]);
  assert.ok(!fake.calls.some((args) => args[1] === "create"), "dry-run must not create anything");
});

test("apply creates the missing databases and verifies each create", async () => {
  const fake = createFakeWrangler();
  const manifest = await buildD1RemoteManifest({ runner: fake.runner, apply: true });
  assert.equal(manifest.dryRun, false);
  assert.equal(manifest.applied, true);
  assert.equal(manifest.ok, true, JSON.stringify(manifest.errors));
  assert.deepEqual(manifest.totals, { targets: 4, existing: 0, created: 4, missing: 0, refused: 0 });
  assert.ok(
    manifest.targets.every(
      (target) => target.state === "created" && target.action === "create" && target.verified && target.databaseId !== null,
    ),
  );
  assert.equal(fake.calls.filter((args) => args[1] === "create").length, 4);
  assert.equal(fake.calls.filter((args) => args[1] === "info").length, 4);
  assert.equal(fake.calls.filter((args) => args[1] === "list").length, 2, "apply re-lists after creating");
  assert.equal(manifest.commands[0], "d1 list --json");
  assert.ok(manifest.commands.includes("d1 create worldcons_core --location apac"));
});

test("an existing database is never recreated", async () => {
  const fake = createFakeWrangler([{ uuid: "core-uuid", name: "worldcons_core", created_at: "2026-01-01T00:00:00.000Z" }]);
  const manifest = await buildD1RemoteManifest({ runner: fake.runner, apply: true });
  assert.equal(manifest.ok, true, JSON.stringify(manifest.errors));
  const core = manifest.targets.find((target) => target.name === "worldcons_core");
  assert.ok(core);
  assert.equal(core.state, "existing");
  assert.equal(core.action, "none");
  assert.equal(core.databaseId, "core-uuid");
  assert.equal(core.verified, true);
  assert.deepEqual(manifest.totals, { targets: 4, existing: 1, created: 3, missing: 0, refused: 0 });
  assert.ok(!fake.calls.some((args) => args[1] === "create" && args[2] === "worldcons_core"));
});

test("an ambiguous name is refused and no database is created", async () => {
  const fake = createFakeWrangler([
    { uuid: "a", name: "worldcons_core", created_at: "2026-01-01T00:00:00.000Z" },
    { uuid: "b", name: "worldcons_core", created_at: "2026-01-02T00:00:00.000Z" },
  ]);
  const manifest = await buildD1RemoteManifest({ runner: fake.runner, apply: true });
  assert.equal(manifest.ok, false);
  const core = manifest.targets.find((target) => target.name === "worldcons_core");
  assert.ok(core);
  assert.equal(core.state, "ambiguous");
  assert.equal(core.action, "refused");
  assert.ok(manifest.errors.some((error) => error.includes("ambiguous")));
  assert.ok(!fake.calls.some((args) => args[1] === "create"), "an ambiguous preflight must not create anything");
});

test("a create failure aborts the remaining creates and fails the run", async () => {
  const fake = createFakeWrangler([], { failCreateFor: "worldcons_ingest" });
  const manifest = await buildD1RemoteManifest({ runner: fake.runner, apply: true });
  assert.equal(manifest.ok, false);
  const core = manifest.targets.find((target) => target.name === "worldcons_core");
  const ingest = manifest.targets.find((target) => target.name === "worldcons_ingest");
  const ops = manifest.targets.find((target) => target.name === "worldcons_ops");
  assert.ok(core && ingest && ops);
  assert.equal(core.state, "created");
  assert.equal(ingest.state, "unknown");
  assert.equal(ops.action, "refused");
  assert.ok(ops.errors.some((error) => error.includes("not attempted")));
  assert.equal(fake.calls.filter((args) => args[1] === "create").length, 2, "only core and the failing ingest are attempted");
  assert.ok(manifest.errors.some((error) => error.includes("worldcons_ingest")));
});

test("a create that cannot be verified fails the run", async () => {
  const fake = createFakeWrangler([], {
    infoOverride: (name) => JSON.stringify({ name, uuid: `wrong-${name}` }),
  });
  const manifest = await buildD1RemoteManifest({ runner: fake.runner, apply: true });
  assert.equal(manifest.ok, false);
  assert.ok(manifest.targets.every((target) => !target.verified));
  assert.ok(manifest.errors.some((error) => error.includes("verification_mismatch")));
});

test("a preflight failure is reported without throwing", async () => {
  const runner: WranglerD1Runner = async () => {
    throw new Error("no auth");
  };
  const manifest = await buildD1RemoteManifest({ runner });
  assert.equal(manifest.ok, false);
  assert.ok(manifest.errors.some((error) => error.includes("preflight")));
  assert.ok(manifest.targets.every((target) => target.state === "unknown" && target.action === "refused"));
});

test("an invalid location fails fast", async () => {
  const fake = createFakeWrangler();
  await assert.rejects(() => buildD1RemoteManifest({ runner: fake.runner, location: "APAC!" }), /invalid location/);
  await assert.rejects(() => buildD1RemoteManifest({ runner: fake.runner, location: "" }), /invalid location/);
  const regional = await buildD1RemoteManifest({ runner: fake.runner, location: "weur" });
  assert.equal(regional.location, "weur");
});

test("the Windows invocation routes the .cmd shim through the command interpreter", () => {
  assert.equal(defaultWranglerBinary("win32"), "wrangler.cmd");
  assert.equal(defaultWranglerBinary("linux"), "wrangler");
  assert.equal(defaultWranglerBinary("darwin"), "wrangler");

  const win = buildWranglerInvocation({
    platform: "win32",
    binary: "wrangler.cmd",
    args: ["d1", "list", "--json"],
    comspec: "C:\\Windows\\System32\\cmd.exe",
  });
  assert.equal(win.command, "C:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(win.args, ["/d", "/c", "wrangler.cmd", "d1", "list", "--json"]);

  const posix = buildWranglerInvocation({
    platform: "linux",
    binary: "wrangler",
    args: ["d1", "list", "--json"],
  });
  assert.equal(posix.command, "wrangler");
  assert.deepEqual(posix.args, ["d1", "list", "--json"], "non-Windows spawns the binary directly");
});

test("the Windows interpreter prefers ComSpec and falls back to cmd.exe", () => {
  assert.equal(resolveWindowsCommandInterpreter({ ComSpec: "D:\\cmd.exe" }), "D:\\cmd.exe");
  assert.equal(resolveWindowsCommandInterpreter({ COMSPEC: "D:\\cmd.exe" }), "D:\\cmd.exe");
  assert.equal(resolveWindowsCommandInterpreter({}), "cmd.exe");
  assert.equal(resolveWindowsCommandInterpreter({ ComSpec: "   " }), "cmd.exe");

  const fromEnv = buildWranglerInvocation({
    platform: "win32",
    binary: "wrangler.cmd",
    args: ["d1", "list", "--json"],
    env: { ComSpec: "C:\\custom\\cmd.exe" },
  });
  assert.equal(fromEnv.command, "C:\\custom\\cmd.exe");

  const invokedArgs = ["d1", "list", "--json"];
  const invocation = buildWranglerInvocation({ platform: "win32", binary: "wrangler.cmd", args: invokedArgs });
  invokedArgs.push("--mutated");
  assert.deepEqual(
    invocation.args,
    ["/d", "/c", "wrangler.cmd", "d1", "list", "--json"],
    "the invocation must copy the args, not alias the caller's array",
  );
});

test("the Wrangler runner executes a local .cmd shim on Windows through cmd.exe", async (t) => {
  if (process.platform !== "win32") {
    t.skip("the EINVAL this guards against only occurs when spawning .cmd shims on win32");
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "d1-provision-runner-"));
  try {
    const ok = path.join(dir, "probe-ok.cmd");
    fs.writeFileSync(ok, '@echo off\r\necho {"ok":true}\r\n', "utf8");
    assert.equal(await createWranglerD1Runner({ binary: ok, timeoutMs: 10_000 })(["d1", "list", "--json"]), '{"ok":true}\r\n');

    const fail = path.join(dir, "probe-fail.cmd");
    fs.writeFileSync(fail, "@echo off\r\nexit /b 7\r\n", "utf8");
    await assert.rejects(
      () => createWranglerD1Runner({ binary: fail, timeoutMs: 10_000 })(["d1", "create", "worldcons_core", "--location", "apac"]),
      /wrangler d1 create failed with exit code 7/,
    );

    const missing = path.join(dir, "does-not-exist.cmd");
    await assert.rejects(
      () => createWranglerD1Runner({ binary: missing, timeoutMs: 10_000 })(["d1", "list", "--json"]),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /wrangler d1 list failed with exit code/);
        assert.ok(!/not recognized/i.test(error.message), "raw interpreter output must not leak into the bounded error");
        return true;
      },
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the Wrangler runner stays out of the runtime barrel and the CLI is apply-gated", () => {
  const barrel = fs.readFileSync(path.join(rootDir, "lib/cloudflare/d1/remote/index.ts"), "utf8");
  assert.ok(!barrel.includes('from "./runner"'), "the node:child_process runner must not be barrelled");
  assert.ok(!barrel.includes('from "node:"'), "the runtime barrel must not import node builtins");

  const runnerSource = fs.readFileSync(path.join(rootDir, "lib/cloudflare/d1/remote/runner.ts"), "utf8");
  assert.ok(runnerSource.includes('from "node:child_process"'));
  assert.ok(runnerSource.includes("buildWranglerInvocation"), "the runner must route through the invocation builder");
  assert.ok(runnerSource.includes("ComSpec"), "the Windows path must resolve the interpreter from ComSpec");
  assert.ok(!/shell:\s*true/.test(runnerSource), "the runner must never enable shell interpolation");

  const script = path.join(rootDir, "scripts", "d1-provision.ts");
  assert.ok(fs.existsSync(script), "the operator CLI must exist");
  const scriptSource = fs.readFileSync(script, "utf8");
  assert.ok(scriptSource.includes("createWranglerD1Runner"), "the CLI must import the Wrangler runner directly");
  assert.ok(scriptSource.includes('args.includes("--apply")'), "the CLI must gate creation behind --apply");

  const bootstrapSource = fs.readFileSync(path.join(rootDir, "lib/cloudflare/d1/remote/bootstrap.ts"), "utf8");
  for (const forbidden of ["d1 delete", "d1 execute", "d1 import", "d1 export", "r2 bucket"]) {
    assert.ok(!scriptSource.includes(forbidden), `the CLI must not run ${forbidden}`);
    assert.ok(!bootstrapSource.includes(forbidden), `the bootstrap must not run ${forbidden}`);
  }
});
