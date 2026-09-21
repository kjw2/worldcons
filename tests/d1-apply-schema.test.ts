import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { D1_DATABASES, d1Schema, type D1Database } from "../lib/cloudflare/d1";
import {
  D1_REMOTE_SCHEMA_APPLY_VERSION,
  D1_SCHEMA_OBJECT_QUERY,
  D1RemoteError,
  buildD1SchemaApplyManifest,
  d1SchemaObjects,
  parseD1ExecuteResultsJson,
  type WranglerD1Runner,
} from "../lib/cloudflare/d1/remote";

const rootDir = process.cwd();

interface FakeObject {
  type: string;
  name: string;
}

interface FakeDatabase {
  uuid: string;
  name: string;
  created_at: string;
  objects: FakeObject[];
}

interface FakeWrangler {
  runner: WranglerD1Runner;
  calls: string[][];
  databases: FakeDatabase[];
}

function expectedObjects(database: D1Database): FakeObject[] {
  const { tables, indexes } = d1SchemaObjects(database);
  return [
    ...tables.map((name) => ({ type: "table", name })),
    ...indexes.map((name) => ({ type: "index", name })),
  ];
}

function fakeDatabase(name: D1Database, objects: FakeObject[] = []): FakeDatabase {
  return {
    uuid: `uuid-${name}`,
    name,
    created_at: "2026-09-21T00:00:00.000Z",
    objects: objects.map((object) => ({ ...object })),
  };
}

function allDatabases(objects: (database: D1Database) => FakeObject[] = () => []): FakeDatabase[] {
  return [...D1_DATABASES].map((name) => fakeDatabase(name, objects(name)));
}

function expectedByDatabase(): Partial<Record<D1Database, FakeObject[]>> {
  const result: Partial<Record<D1Database, FakeObject[]>> = {};
  for (const name of D1_DATABASES) result[name] = expectedObjects(name);
  return result;
}

function createFakeWrangler(options: {
  databases: FakeDatabase[];
  applyObjects?: Partial<Record<D1Database, FakeObject[]>>;
  failExecuteFor?: string;
}): FakeWrangler {
  const calls: string[][] = [];
  const runner: WranglerD1Runner = async (args) => {
    calls.push(args);
    const [group, command, name] = args;
    if (group !== "d1") throw new Error(`unexpected wrangler group: ${group}`);
    const database = options.databases.find((entry) => entry.name === name);
    if (command === "list") {
      return JSON.stringify(
        options.databases.map((entry) => ({ name: entry.name, uuid: entry.uuid, created_at: entry.created_at })),
      );
    }
    if (command === "info") {
      if (!database) throw new Error(`no such database: ${name}`);
      const tables = database.objects.filter((object) => object.type === "table").length;
      return JSON.stringify({
        name: database.name,
        uuid: database.uuid,
        created_at: database.created_at,
        num_tables: tables,
        file_size: 0,
      });
    }
    if (command === "execute") {
      if (!database) throw new Error(`no such database: ${name}`);
      if (args.includes("--file")) {
        if (options.failExecuteFor === name) throw new Error("execute failed");
        database.objects = (options.applyObjects?.[database.name as D1Database] ?? []).map((object) => ({ ...object }));
        return JSON.stringify([{ results: [{ "Total queries executed": 1 }], success: true, meta: {} }]);
      }
      return JSON.stringify([{ results: database.objects.map((object) => ({ ...object })), success: true, meta: {} }]);
    }
    throw new Error(`unexpected wrangler d1 command: ${command}`);
  };
  return { runner, calls, databases: options.databases };
}
test("dry-run reads the remote objects and never writes a file", async () => {
  const fake = createFakeWrangler({ databases: allDatabases() });
  const manifest = await buildD1SchemaApplyManifest({ runner: fake.runner });
  assert.equal(manifest.version, D1_REMOTE_SCHEMA_APPLY_VERSION);
  assert.equal(manifest.stage, "d1-remote-schema-apply");
  assert.equal(manifest.dryRun, true);
  assert.equal(manifest.applied, false);
  assert.equal(manifest.ok, true);
  assert.deepEqual(manifest.totals, { targets: 4, applied: 0, present: 0, missing: 0, refused: 0 });
  for (const target of manifest.targets) {
    assert.equal(target.state, "existing");
    assert.equal(target.action, "apply");
    assert.equal(target.verified, false);
    assert.ok(target.expectedObjects > 0);
    assert.equal(target.foundObjects, 0);
    assert.equal(target.missingObjects.length, target.expectedObjects);
  }
  assert.equal(manifest.commands[0], "d1 list --json");
  assert.ok(manifest.commands.includes("d1 info worldcons_core --json"));
  assert.ok(manifest.commands.some((entry) => entry.includes("--command")));
  assert.ok(!manifest.commands.some((entry) => entry.includes("--file")), "dry-run must not execute DDL");
  assert.ok(!manifest.commands.some((entry) => entry.includes("d1 create")));
  assert.ok(D1_SCHEMA_OBJECT_QUERY.startsWith("select"));
});

test("dry-run verifies a schema that is already present", async () => {
  const fake = createFakeWrangler({ databases: allDatabases((database) => expectedObjects(database)) });
  const manifest = await buildD1SchemaApplyManifest({ runner: fake.runner });
  assert.equal(manifest.ok, true);
  assert.deepEqual(manifest.totals, { targets: 4, applied: 0, present: 4, missing: 0, refused: 0 });
  for (const target of manifest.targets) {
    assert.equal(target.verified, true);
    assert.equal(target.action, "none");
    assert.deepEqual(target.missingObjects, []);
  }
});

test("apply materializes the DDL, executes it remotely and verifies every object", async () => {
  const fake = createFakeWrangler({ databases: allDatabases(), applyObjects: expectedByDatabase() });
  const materialized: { database: D1Database; sql: string }[] = [];
  const manifest = await buildD1SchemaApplyManifest({
    runner: fake.runner,
    apply: true,
    materializeDdl: (database, sql) => {
      materialized.push({ database, sql });
      return `fake/${database}.sql`;
    },
  });
  assert.equal(manifest.dryRun, false);
  assert.equal(manifest.applied, true);
  assert.equal(manifest.ok, true, JSON.stringify(manifest.errors));
  assert.deepEqual(manifest.totals, { targets: 4, applied: 4, present: 4, missing: 0, refused: 0 });
  for (const target of manifest.targets) {
    assert.equal(target.state, "applied");
    assert.equal(target.action, "apply");
    assert.equal(target.verified, true);
    assert.equal(target.foundObjects, target.expectedObjects);
    assert.deepEqual(target.missingObjects, []);
  }
  assert.equal(materialized.length, 4);
  for (const entry of materialized) assert.ok(entry.sql.includes("create table if not exists"));
  assert.equal(new Set(materialized.map((entry) => entry.database)).size, 4);
  assert.ok(
    manifest.commands.includes("d1 execute worldcons_core --remote --yes --json --file fake/worldcons_core.sql"),
  );
});

test("a missing remote database is refused and nothing is applied", async () => {
  const databases = allDatabases().filter((entry) => entry.name !== "worldcons_ops");
  const fake = createFakeWrangler({ databases });
  const manifest = await buildD1SchemaApplyManifest({ runner: fake.runner, apply: true, materializeDdl: () => "x" });
  assert.equal(manifest.ok, false);
  const ops = manifest.targets.find((target) => target.name === "worldcons_ops");
  assert.ok(ops);
  assert.equal(ops.state, "missing");
  assert.equal(ops.action, "refused");
  assert.equal(manifest.totals.missing, 1);
  assert.equal(manifest.totals.applied, 0);
  assert.ok(!manifest.commands.some((entry) => entry.includes("--file")), "no apply happens when a target is missing");
});

test("an ambiguous name is refused before any apply", async () => {
  const databases = allDatabases();
  databases.push(fakeDatabase("worldcons_core"));
  const fake = createFakeWrangler({ databases });
  const manifest = await buildD1SchemaApplyManifest({ runner: fake.runner, apply: true, materializeDdl: () => "x" });
  assert.equal(manifest.ok, false);
  const core = manifest.targets.find((target) => target.name === "worldcons_core");
  assert.ok(core);
  assert.equal(core.state, "ambiguous");
  assert.equal(core.action, "refused");
  assert.ok(!manifest.commands.some((entry) => entry.includes("--file")));
});

test("a preflight failure is reported without throwing", async () => {
  const runner: WranglerD1Runner = async () => {
    throw new Error("no auth");
  };
  const manifest = await buildD1SchemaApplyManifest({ runner });
  assert.equal(manifest.ok, false);
  assert.ok(manifest.errors.some((error) => error.includes("preflight")));
  assert.ok(manifest.targets.every((target) => target.state === "unknown" && target.action === "refused"));
});

test("an execute failure aborts the remaining applies and fails the run", async () => {
  const fake = createFakeWrangler({
    databases: allDatabases(),
    applyObjects: expectedByDatabase(),
    failExecuteFor: "worldcons_ingest",
  });
  const manifest = await buildD1SchemaApplyManifest({
    runner: fake.runner,
    apply: true,
    materializeDdl: (database) => `fake/${database}.sql`,
  });
  assert.equal(manifest.ok, false);
  const core = manifest.targets.find((target) => target.name === "worldcons_core");
  const ingest = manifest.targets.find((target) => target.name === "worldcons_ingest");
  const ops = manifest.targets.find((target) => target.name === "worldcons_ops");
  assert.ok(core && ingest && ops);
  assert.equal(core.verified, true);
  assert.equal(ingest.state, "unknown");
  assert.equal(ingest.action, "refused");
  assert.equal(ops.action, "refused");
  assert.ok(ops.errors.some((error) => error.includes("not attempted")));
  assert.equal(fake.calls.filter((args) => args[1] === "execute" && args.includes("--file")).length, 2);
});

test("verification detects a missing object", async () => {
  const partial = expectedByDatabase();
  const core = expectedObjects("worldcons_core");
  const dropped = core[core.length - 1].name;
  partial.worldcons_core = core.slice(0, core.length - 1);
  const fake = createFakeWrangler({ databases: allDatabases(), applyObjects: partial });
  const manifest = await buildD1SchemaApplyManifest({
    runner: fake.runner,
    apply: true,
    materializeDdl: (database) => `fake/${database}.sql`,
  });
  const coreTarget = manifest.targets.find((target) => target.name === "worldcons_core");
  assert.ok(coreTarget);
  assert.equal(coreTarget.verified, false);
  assert.deepEqual(coreTarget.missingObjects, [dropped]);
  assert.equal(manifest.ok, false);
});

test("apply requires a materializeDdl callback", async () => {
  const fake = createFakeWrangler({ databases: allDatabases() });
  await assert.rejects(() => buildD1SchemaApplyManifest({ runner: fake.runner, apply: true }), /materializeDdl/);
});

test("the expected object set is derived from the M5.1 schema", () => {
  for (const database of D1_DATABASES) {
    const objects = d1SchemaObjects(database);
    assert.equal(objects.objects.length, objects.tables.length + objects.indexes.length);
    assert.deepEqual(objects.objects, [...objects.tables, ...objects.indexes]);
  }
  const core = d1SchemaObjects("worldcons_core");
  assert.ok(core.tables.includes("articles"));
  assert.ok(core.tables.includes("sources"));
  assert.ok(core.indexes.includes("articles_slug_key"));
  const search = d1SchemaObjects("worldcons_search");
  assert.ok(search.tables.includes("search_documents"));
  assert.ok(search.tables.includes("search_fts"), "the FTS5 virtual table is an expected object");
  const totalTables = D1_DATABASES.reduce((sum, database) => sum + d1SchemaObjects(database).tables.length, 0);
  assert.equal(totalTables, d1Schema.tables.length);
});

test("the execute parser accepts a success envelope and fails closed otherwise", () => {
  assert.deepEqual(parseD1ExecuteResultsJson('[{"results":[{"name":"articles"}],"success":true,"meta":{}}]'), [
    { name: "articles" },
  ]);
  assert.deepEqual(parseD1ExecuteResultsJson('[{"results":[],"success":true}]'), []);
  const bad = [
    "nope",
    "{}",
    '[{"results":[]}]',
    '[{"success":true}]',
    '[{"results":[],"success":false}]',
    '["x"]',
    '[{"results":[1],"success":true}]',
  ];
  for (const value of bad) assert.throws(() => parseD1ExecuteResultsJson(value), D1RemoteError);
});

test("the schema apply stays out of the runtime barrel and the CLI is apply-gated", () => {
  const barrel = fs.readFileSync(path.join(rootDir, "lib/cloudflare/d1/remote/index.ts"), "utf8");
  assert.ok(!barrel.includes('from "node:"'), "the runtime barrel must not import node builtins");
  assert.ok(barrel.includes("./schema-apply"), "the pure schema-apply seam is exported");

  const seam = fs.readFileSync(path.join(rootDir, "lib/cloudflare/d1/remote/schema-apply.ts"), "utf8");
  assert.ok(!seam.includes('from "node:"'), "the seam must stay Node-free so runtime code can load it");
  for (const forbidden of ["drop table", "delete from", "d1 delete", "d1 create"]) {
    assert.ok(!seam.includes(forbidden), `the seam must not contain ${forbidden}`);
  }

  const script = path.join(rootDir, "scripts", "d1-apply-schema.ts");
  assert.ok(fs.existsSync(script), "the operator CLI must exist");
  const scriptSource = fs.readFileSync(script, "utf8");
  assert.ok(scriptSource.includes("createWranglerD1Runner"), "the CLI must import the Wrangler runner directly");
  assert.ok(scriptSource.includes('args.includes("--apply")'), "the CLI must gate the remote write behind --apply");
  for (const forbidden of ["drop table", "delete from", "d1 delete", "d1 create"]) {
    assert.ok(!scriptSource.includes(forbidden), `the CLI must not contain ${forbidden}`);
  }
});
