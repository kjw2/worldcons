import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { D1_DATABASES, type D1Database } from "../lib/cloudflare/d1";
import {
  D1_MIGRATION_OBJECT_QUERY,
  D1_REMOTE_MIGRATION_APPLY_VERSION,
  D1RemoteError,
  buildD1MigrationApplyManifest,
  buildD1RemoteMigrations,
  normalizeD1MigrationSql,
  parseD1MigrationVerifyDirectives,
  type D1MigrationSourceFile,
  type WranglerD1Runner,
} from "../lib/cloudflare/d1/remote";

const rootDir = process.cwd();
const OPS_DIR = path.join(rootDir, "d1", "worldcons_ops");
const MIGRATION_FILE = "0002_admin_command_runs_partial_dedupe.sql";
const INDEX_NAME = "admin_command_runs_active_dedupe_key_uidx";
const FULL_UNIQUE_SQL = `CREATE UNIQUE INDEX ${INDEX_NAME} ON admin_command_runs (dedupe_key)`;
const PARTIAL_UNIQUE_SQL = `CREATE UNIQUE INDEX ${INDEX_NAME} ON admin_command_runs (dedupe_key) WHERE status IN ('queued','running','retry_wait')`;

interface FakeObject {
  type: string;
  name: string;
  sql: string | null;
}

interface FakeDatabase {
  uuid: string;
  name: string;
  objects: FakeObject[];
}

interface FakeWrangler {
  runner: WranglerD1Runner;
  calls: string[][];
  databases: FakeDatabase[];
}

function fakeDatabase(name: D1Database, objects: FakeObject[]): FakeDatabase {
  return { uuid: `uuid-${name}`, name, objects: objects.map((object) => ({ ...object })) };
}

function indexObject(sql: string | null): FakeObject {
  return { type: "index", name: INDEX_NAME, sql };
}

function createFakeWrangler(options: {
  databases: FakeDatabase[];
  onFile?: (database: FakeDatabase, args: string[]) => void;
}): FakeWrangler {
  const calls: string[][] = [];
  const runner: WranglerD1Runner = async (args) => {
    calls.push(args);
    const [group, command, name] = args;
    if (group !== "d1") throw new Error(`unexpected wrangler group: ${group}`);
    const database = options.databases.find((entry) => entry.name === name);
    if (command === "list") {
      return JSON.stringify(
        options.databases.map((entry) => ({ name: entry.name, uuid: entry.uuid, created_at: "2026-09-21T00:00:00.000Z" })),
      );
    }
    if (command === "info") {
      if (!database) throw new Error(`no such database: ${name}`);
      return JSON.stringify({
        name: database.name,
        uuid: database.uuid,
        created_at: "2026-09-21T00:00:00.000Z",
        num_tables: database.objects.filter((object) => object.type === "table").length,
        file_size: 0,
      });
    }
    if (command === "execute") {
      if (!database) throw new Error(`no such database: ${name}`);
      if (args.includes("--file")) {
        options.onFile?.(database, args);
        return "⛅️ wrangler 4.135.0\n🚣 Executed 2 queries in 0.1s\n✨ Done\n";
      }
      return JSON.stringify([{ results: database.objects.map((object) => ({ ...object })), success: true, meta: {} }]);
    }
    throw new Error(`unexpected wrangler d1 command: ${command}`);
  };
  return { runner, calls, databases: options.databases };
}

/** Reads the real committed worldcons_ops migration files in file-name order. */
function realMigrationSources(): D1MigrationSourceFile[] {
  return fs
    .readdirSync(OPS_DIR)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((file) => ({
      database: "worldcons_ops" as D1Database,
      file,
      sql: fs.readFileSync(path.join(OPS_DIR, file), "utf8"),
    }));
}

function migrationSource(database: D1Database, file: string, body: string): D1MigrationSourceFile {
  return { database, file, sql: body };
}

function fileCalls(fake: FakeWrangler): string[][] {
  return fake.calls.filter((args) => args[1] === "execute" && args.includes("--file"));
}

test("the historical worldcons_ops 0001 baseline is unchanged and still declares the unconditional unique index", () => {
  const baseline = fs.readFileSync(path.join(OPS_DIR, "0001_init.sql"), "utf8");
  assert.ok(
    baseline.includes(`create unique index if not exists ${INDEX_NAME} on admin_command_runs (dedupe_key);`),
    "0001 must keep the original unconditional unique index",
  );
  assert.ok(!baseline.includes("where status in"), "0001 must not be edited to a partial index");
  assert.ok(baseline.includes("create table if not exists admin_command_runs"), "0001 still owns the table");

  const migrations = buildD1RemoteMigrations(realMigrationSources());
  assert.ok(
    migrations.every((migration) => migration.number > 1),
    "discovery must filter the 0001 baseline out",
  );
  assert.deepEqual(
    migrations.map((migration) => migration.id),
    ["0002"],
  );
});

test("the worldcons_ops 0002 migration is a partial unique index that drops only that one index", () => {
  const source = fs.readFileSync(path.join(OPS_DIR, MIGRATION_FILE), "utf8");
  assert.ok(source.includes(`drop index if exists ${INDEX_NAME};`), "the migration must drop the old index");
  assert.ok(
    source.includes(`create unique index if not exists ${INDEX_NAME}`),
    "the migration must recreate the index under the same name",
  );
  assert.ok(
    source.includes("where status in ('queued', 'running', 'retry_wait')"),
    "the migration must use the exact SQLite partial predicate",
  );
  assert.ok(!/\b(delete|update|insert|truncate)\b/i.test(source.replace(/--.*$/gm, "")), "the migration must not mutate rows");
  assert.ok(!source.includes("drop table"), "the migration must not drop a table");

  const verify = parseD1MigrationVerifyDirectives(source);
  assert.equal(verify.length, 1);
  assert.equal(verify[0].type, "index");
  assert.equal(verify[0].name, INDEX_NAME);
  assert.ok(verify[0].sqlIncludes.includes("unique index"));
  assert.ok(verify[0].sqlIncludes.includes("where status in ('queued', 'running', 'retry_wait')"));
});

test("discovery keeps only additive migrations after 0001 and orders them deterministically", () => {
  const files: D1MigrationSourceFile[] = [
    migrationSource("worldcons_ops", "0001_init.sql", "-- baseline\n"),
    migrationSource("worldcons_core", "0003_third.sql", "-- @d1-verify {\"type\":\"index\",\"name\":\"c3\"}\n"),
    migrationSource("worldcons_ops", "0002_second.sql", "-- @d1-verify {\"type\":\"index\",\"name\":\"o2\"}\n"),
    migrationSource("worldcons_core", "0002_second.sql", "-- @d1-verify {\"type\":\"index\",\"name\":\"c2\"}\n"),
  ];
  const migrations = buildD1RemoteMigrations(files);
  assert.deepEqual(
    migrations.map((migration) => `${migration.database}/${migration.id}`),
    ["worldcons_core/0002", "worldcons_core/0003", "worldcons_ops/0002"],
    "discovery must be ordered by database, then number",
  );
});

test("discovery fails closed on an unnumbered file, a duplicate number and a migration without a verify directive", () => {
  assert.throws(
    () => buildD1RemoteMigrations([migrationSource("worldcons_ops", "notes.sql", "-- no number\n")]),
    (error: unknown) => error instanceof D1RemoteError && error.code === "d1_remote.unnumbered_migration",
  );
  assert.throws(
    () =>
      buildD1RemoteMigrations([
        migrationSource("worldcons_ops", "0002_a.sql", "-- @d1-verify {\"type\":\"index\",\"name\":\"a\"}\n"),
        migrationSource("worldcons_ops", "0002_b.sql", "-- @d1-verify {\"type\":\"index\",\"name\":\"b\"}\n"),
      ]),
    (error: unknown) => error instanceof D1RemoteError && error.code === "d1_remote.duplicate_migration",
  );
  assert.throws(
    () => buildD1RemoteMigrations([migrationSource("worldcons_ops", "0002_a.sql", "-- no directive\n")]),
    (error: unknown) => error instanceof D1RemoteError && error.code === "d1_remote.migration_without_verify",
  );
});

test("normalization ignores SQL whitespace and case so the stored partial predicate matches", () => {
  assert.equal(normalizeD1MigrationSql("WHERE   status IN ('queued','running','retry_wait')"), "wherestatusin('queued','running','retry_wait')");
  assert.equal(
    normalizeD1MigrationSql("where status in ('queued', 'running', 'retry_wait')"),
    normalizeD1MigrationSql("WHERE status IN ('queued','running','retry_wait')"),
  );
  assert.ok(D1_MIGRATION_OBJECT_QUERY.startsWith("select"));
  assert.ok(D1_MIGRATION_OBJECT_QUERY.includes("sql"));
});

test("dry-run reports the pending migration and writes nothing", async () => {
  const fake = createFakeWrangler({
    databases: [fakeDatabase("worldcons_ops", [indexObject(FULL_UNIQUE_SQL)])],
  });
  const migrations = buildD1RemoteMigrations(realMigrationSources());
  const manifest = await buildD1MigrationApplyManifest({ runner: fake.runner, migrations });

  assert.equal(manifest.version, D1_REMOTE_MIGRATION_APPLY_VERSION);
  assert.equal(manifest.stage, "d1-remote-migration-apply");
  assert.equal(manifest.dryRun, true);
  assert.equal(manifest.applied, false);
  assert.equal(manifest.ok, true, JSON.stringify(manifest.errors));
  assert.deepEqual(manifest.totals, {
    targets: 1,
    migrations: 1,
    pending: 1,
    applied: 0,
    present: 0,
    missing: 0,
    refused: 0,
  });
  const ops = manifest.targets[0];
  assert.equal(ops.state, "existing");
  assert.equal(ops.action, "apply");
  assert.equal(ops.pending, 1);
  assert.equal(ops.verified, false);
  assert.equal(ops.migrations[0].state, "pending");
  assert.match(ops.migrations[0].detail ?? "", /does not include where status in/);
  assert.equal(fileCalls(fake).length, 0, "a dry-run must never execute a migration file");
  assert.ok(manifest.commands.includes("d1 list --json"));
  assert.ok(manifest.commands.includes("d1 info worldcons_ops --json"));
  assert.ok(manifest.commands.some((entry) => entry.includes("--command")));
});

test("dry-run verifies a migration whose partial index is already present as a no-op", async () => {
  const fake = createFakeWrangler({
    databases: [fakeDatabase("worldcons_ops", [indexObject(PARTIAL_UNIQUE_SQL)])],
  });
  const migrations = buildD1RemoteMigrations(realMigrationSources());
  const manifest = await buildD1MigrationApplyManifest({ runner: fake.runner, migrations });

  assert.equal(manifest.ok, true, JSON.stringify(manifest.errors));
  assert.deepEqual(manifest.totals, {
    targets: 1,
    migrations: 1,
    pending: 0,
    applied: 0,
    present: 1,
    missing: 0,
    refused: 0,
  });
  const ops = manifest.targets[0];
  assert.equal(ops.action, "none");
  assert.equal(ops.pending, 0);
  assert.equal(ops.verified, true);
  assert.equal(ops.migrations[0].state, "verified");
  assert.equal(ops.migrations[0].verified, true);
  assert.equal(fileCalls(fake).length, 0);
});

test("apply executes only the pending migration, materializes it once and verifies the partial predicate", async () => {
  const fake = createFakeWrangler({
    databases: [fakeDatabase("worldcons_ops", [indexObject(FULL_UNIQUE_SQL)])],
    onFile: (database) => {
      database.objects = database.objects.map((object) =>
        object.name === INDEX_NAME ? { ...object, sql: PARTIAL_UNIQUE_SQL } : object,
      );
    },
  });
  const materialized: string[] = [];
  const migrations = buildD1RemoteMigrations(realMigrationSources());
  const manifest = await buildD1MigrationApplyManifest({
    runner: fake.runner,
    migrations,
    apply: true,
    materializeMigration: (migration) => {
      materialized.push(migration.file);
      return `fake/${migration.file}`;
    },
  });

  assert.equal(manifest.dryRun, false);
  assert.equal(manifest.applied, true);
  assert.equal(manifest.ok, true, JSON.stringify(manifest.errors));
  assert.deepEqual(manifest.totals, {
    targets: 1,
    migrations: 1,
    pending: 0,
    applied: 1,
    present: 1,
    missing: 0,
    refused: 0,
  });
  const ops = manifest.targets[0];
  assert.equal(ops.state, "existing");
  assert.equal(ops.action, "apply");
  assert.equal(ops.applied, 1);
  assert.equal(ops.verified, true);
  assert.equal(ops.migrations[0].state, "applied");
  assert.equal(ops.migrations[0].verified, true);
  assert.deepEqual(materialized, [MIGRATION_FILE]);
  assert.equal(fileCalls(fake).length, 1);
  assert.ok(manifest.commands.includes(`d1 execute worldcons_ops --remote --yes --json --file fake/${MIGRATION_FILE}`));
});

test("a rerun after apply is an idempotent no-op with zero writes", async () => {
  const fake = createFakeWrangler({
    databases: [fakeDatabase("worldcons_ops", [indexObject(FULL_UNIQUE_SQL)])],
    onFile: (database) => {
      database.objects = database.objects.map((object) =>
        object.name === INDEX_NAME ? { ...object, sql: PARTIAL_UNIQUE_SQL } : object,
      );
    },
  });
  const migrations = buildD1RemoteMigrations(realMigrationSources());
  const first = await buildD1MigrationApplyManifest({
    runner: fake.runner,
    migrations,
    apply: true,
    materializeMigration: (migration) => `fake/${migration.file}`,
  });
  assert.equal(first.ok, true, JSON.stringify(first.errors));
  assert.equal(fileCalls(fake).length, 1);

  const second = await buildD1MigrationApplyManifest({
    runner: fake.runner,
    migrations,
    apply: true,
    materializeMigration: (migration) => `fake/${migration.file}`,
  });
  assert.equal(second.ok, true, JSON.stringify(second.errors));
  assert.equal(second.totals.pending, 0);
  assert.equal(second.totals.applied, 0);
  assert.equal(second.targets[0].action, "none");
  assert.equal(second.targets[0].migrations[0].state, "verified");
  assert.equal(fileCalls(fake).length, 1, "the rerun must not execute any migration file");
});

test("apply against an already partial index materializes nothing and makes zero --file calls", async () => {
  const fake = createFakeWrangler({
    databases: [fakeDatabase("worldcons_ops", [indexObject(PARTIAL_UNIQUE_SQL)])],
  });
  let materializeCalls = 0;
  const migrations = buildD1RemoteMigrations(realMigrationSources());
  const manifest = await buildD1MigrationApplyManifest({
    runner: fake.runner,
    migrations,
    apply: true,
    materializeMigration: (migration) => {
      materializeCalls += 1;
      return `fake/${migration.file}`;
    },
  });
  assert.equal(manifest.ok, true, JSON.stringify(manifest.errors));
  assert.equal(materializeCalls, 0, "a verified migration must not materialize a file");
  assert.equal(fileCalls(fake).length, 0);
  assert.equal(manifest.targets[0].verified, true);
});

test("verification treats an index whose stored SQL lacks the predicate as pending", async () => {
  const fake = createFakeWrangler({
    databases: [fakeDatabase("worldcons_ops", [indexObject(FULL_UNIQUE_SQL)])],
  });
  const migrations = buildD1RemoteMigrations(realMigrationSources());
  const manifest = await buildD1MigrationApplyManifest({ runner: fake.runner, migrations });
  assert.equal(manifest.targets[0].migrations[0].state, "pending");
  assert.equal(manifest.targets[0].migrations[0].verified, false);
  assert.match(manifest.targets[0].migrations[0].detail ?? "", /where status in/);

  const missing = createFakeWrangler({ databases: [fakeDatabase("worldcons_ops", [])] });
  const missingManifest = await buildD1MigrationApplyManifest({ runner: missing.runner, migrations });
  assert.equal(missingManifest.targets[0].migrations[0].state, "pending");
  assert.match(missingManifest.targets[0].migrations[0].detail ?? "", /missing index/);
});

test("apply requires a materializeMigration callback", async () => {
  const fake = createFakeWrangler({
    databases: [fakeDatabase("worldcons_ops", [indexObject(FULL_UNIQUE_SQL)])],
  });
  const migrations = buildD1RemoteMigrations(realMigrationSources());
  await assert.rejects(
    () => buildD1MigrationApplyManifest({ runner: fake.runner, migrations, apply: true }),
    /materializeMigration/,
  );
});

test("a missing remote database is refused and nothing is applied", async () => {
  const fake = createFakeWrangler({ databases: [fakeDatabase("worldcons_core", [])] });
  const migrations = buildD1RemoteMigrations(realMigrationSources());
  const manifest = await buildD1MigrationApplyManifest({
    runner: fake.runner,
    migrations,
    apply: true,
    materializeMigration: (migration) => `fake/${migration.file}`,
  });
  assert.equal(manifest.ok, false);
  const ops = manifest.targets.find((target) => target.name === "worldcons_ops");
  assert.ok(ops);
  assert.equal(ops.state, "missing");
  assert.equal(ops.action, "refused");
  assert.equal(manifest.totals.missing, 1);
  assert.equal(manifest.totals.applied, 0);
  assert.equal(fileCalls(fake).length, 0, "no migration is executed when the target database is missing");
});

test("an ambiguous remote database is refused before any apply", async () => {
  const fake = createFakeWrangler({
    databases: [fakeDatabase("worldcons_ops", []), fakeDatabase("worldcons_ops", [])],
  });
  const migrations = buildD1RemoteMigrations(realMigrationSources());
  const manifest = await buildD1MigrationApplyManifest({
    runner: fake.runner,
    migrations,
    apply: true,
    materializeMigration: (migration) => `fake/${migration.file}`,
  });
  assert.equal(manifest.ok, false);
  const ops = manifest.targets.find((target) => target.name === "worldcons_ops");
  assert.ok(ops);
  assert.equal(ops.state, "ambiguous");
  assert.equal(ops.action, "refused");
  assert.equal(fileCalls(fake).length, 0);
});

test("a preflight failure is reported without throwing", async () => {
  const runner: WranglerD1Runner = async () => {
    throw new Error("no auth");
  };
  const migrations = buildD1RemoteMigrations(realMigrationSources());
  const manifest = await buildD1MigrationApplyManifest({ runner, migrations });
  assert.equal(manifest.ok, false);
  assert.ok(manifest.errors.some((error) => error.includes("preflight")));
  assert.ok(manifest.targets.every((target) => target.state === "unknown" && target.action === "refused"));
});

test("an execute failure aborts the run and leaves the migration unverified", async () => {
  const fake = createFakeWrangler({
    databases: [fakeDatabase("worldcons_ops", [indexObject(FULL_UNIQUE_SQL)])],
    onFile: () => {
      throw new Error("execute failed");
    },
  });
  const migrations = buildD1RemoteMigrations(realMigrationSources());
  const manifest = await buildD1MigrationApplyManifest({
    runner: fake.runner,
    migrations,
    apply: true,
    materializeMigration: (migration) => `fake/${migration.file}`,
  });
  assert.equal(manifest.ok, false);
  const ops = manifest.targets.find((target) => target.name === "worldcons_ops");
  assert.ok(ops);
  assert.equal(ops.state, "unknown");
  assert.equal(ops.action, "refused");
  assert.equal(ops.verified, false);
  assert.equal(ops.migrations[0].state, "unknown");
  assert.equal(ops.migrations[0].verified, false);
  assert.equal(fileCalls(fake).length, 1);
});

test("a selected database with no additive migrations is a clean no-op", async () => {
  const fake = createFakeWrangler({ databases: [fakeDatabase("worldcons_core", [])] });
  const migrations = buildD1RemoteMigrations(realMigrationSources());
  const manifest = await buildD1MigrationApplyManifest({ runner: fake.runner, migrations, databases: ["worldcons_core"] });
  assert.equal(manifest.ok, true, JSON.stringify(manifest.errors));
  assert.equal(manifest.targets[0].name, "worldcons_core");
  assert.equal(manifest.targets[0].action, "none");
  assert.equal(manifest.targets[0].verified, true);
  assert.equal(manifest.totals.migrations, 0);
  assert.equal(fileCalls(fake).length, 0);
});

test("the migration seam stays Node-free and barrelled and the CLI is apply-gated", () => {
  const barrel = fs.readFileSync(path.join(rootDir, "lib/cloudflare/d1/remote/index.ts"), "utf8");
  assert.ok(!barrel.includes('from "node:"'), "the runtime barrel must not import node builtins");
  assert.ok(barrel.includes("./migration-apply"), "the pure migration-apply seam is exported");

  const seam = fs.readFileSync(path.join(rootDir, "lib/cloudflare/d1/remote/migration-apply.ts"), "utf8");
  assert.ok(!seam.includes('from "node:"'), "the seam must stay Node-free so runtime code can load it");
  for (const forbidden of ["delete from", "truncate", "drop table", "insert into", "update "]) {
    assert.ok(!seam.includes(forbidden), `the seam must not contain ${forbidden}`);
  }

  const script = path.join(rootDir, "scripts", "d1-migrate.ts");
  assert.ok(fs.existsSync(script), "the operator CLI must exist");
  const scriptSource = fs.readFileSync(script, "utf8");
  assert.ok(scriptSource.includes("createWranglerD1Runner"), "the CLI must import the Wrangler runner directly");
  assert.ok(scriptSource.includes('args.includes("--apply")'), "the CLI must gate the remote write behind --apply");
  assert.ok(scriptSource.includes("buildD1RemoteMigrations"), "the CLI must discover additive migrations");
  const scriptCode = scriptSource.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(!scriptCode.includes("0001_init.sql"), "the CLI must not special-case or rerun the baseline");

  assert.deepEqual([...D1_DATABASES], ["worldcons_core", "worldcons_ingest", "worldcons_ops", "worldcons_search"]);
});
