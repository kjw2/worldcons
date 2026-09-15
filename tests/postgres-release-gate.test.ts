import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  ADMIN_URL_ENV_VAR,
  POSTGRES_RELEASE_SPECS,
  databaseNameFromUrl,
  evaluatePostgresReleaseResult,
  preflightPostgresReleaseEnvironment,
  redactConnectionStrings,
  skippedTestCount,
  withDatabaseName,
} from "@/lib/testing/postgres-release-gate";

const root = process.cwd();
const workflow = fs.readFileSync(path.join(root, ".github/workflows/release-gate.yml"), "utf8");
const runner = fs.readFileSync(path.join(root, "scripts/run-postgres-release-gate.ts"), "utf8");
const gateLibrary = fs.readFileSync(path.join(root, "lib/testing/postgres-release-gate.ts"), "utf8");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

test("release gate covers every PostgreSQL contract database on a disposable pgvector server", () => {
  assert.deepEqual(
    POSTGRES_RELEASE_SPECS.map((spec) => spec.envVar).sort(),
    [
      "BACKFILL_TEST_DATABASE_URL",
      "CATALOG_TEST_DATABASE_URL",
      "P0_TEST_DATABASE_URL",
      "P1_TEST_DATABASE_URL",
      "P2_TEST_DATABASE_URL",
      "P3_TEST_DATABASE_URL",
      "P5_TEST_DATABASE_URL",
    ],
  );
  for (const spec of POSTGRES_RELEASE_SPECS) {
    assert.match(spec.testFile, /^tests\/.*postgres\.test\.ts$/u);
    assert.ok(fs.existsSync(path.join(root, spec.testFile)), `${spec.testFile} must exist`);
    assert.match(spec.databaseName, spec.databaseNamePattern, `${spec.databaseName} must satisfy its isolation pattern`);
  }
  assert.ok(POSTGRES_RELEASE_SPECS.some((spec) => /backfill/u.test(spec.databaseName)));
  assert.ok(POSTGRES_RELEASE_SPECS.some((spec) => /catalog/u.test(spec.databaseName)));
});

test("database names are derived and validated instead of trusting arbitrary URLs", () => {
  assert.equal(databaseNameFromUrl("postgresql://u:p@localhost:5432/worldcons_p3_test"), "worldcons_p3_test");
  assert.equal(databaseNameFromUrl("not-a-url"), null);
  assert.equal(databaseNameFromUrl(undefined), null);
  const derived = withDatabaseName("postgresql://u:p@localhost:5432/worldcons_gate", "worldcons_backfill_test");
  assert.match(derived, /worldcons_backfill_test$/u);
  assert.throws(() => withDatabaseName("postgresql://u:p@localhost:5432/worldcons_gate", "bad;drop"), /invalid_database_name/u);
});

test("skip-0 enforcement fails on skipped TAP cases and on failing tests", () => {
  const skipped = skippedTestCount(`
    # Subtest: sample\nok 1 - sample # SKIP\n1..1\n# tests 1\n# skipped 1\n`);
  assert.equal(skipped, 1);
  assert.equal(skippedTestCount("ok 1 - sample\n1..1\n# tests 1\n# pass 1\n"), 0);

  const skippedResult = evaluatePostgresReleaseResult({
    label: "backfill",
    envVar: "BACKFILL_TEST_DATABASE_URL",
    testFile: "tests/constitutional-case-backfill-gate1.postgres.test.ts",
    exitCode: 0,
    skipped: 1,
  });
  assert.equal(skippedResult.ok, false);
  assert.equal(skippedResult.reason, "test_skipped");
  const failingResult = evaluatePostgresReleaseResult({
    label: "catalog",
    envVar: "CATALOG_TEST_DATABASE_URL",
    testFile: "tests/constitutional-case-catalog-gate2.postgres.test.ts",
    exitCode: 1,
    skipped: 0,
  });
  assert.equal(failingResult.ok, false);
  assert.equal(failingResult.reason, "test_failed");
  const passingResult = evaluatePostgresReleaseResult({
    label: "p0",
    envVar: "P0_TEST_DATABASE_URL",
    testFile: "tests/admin-command-control-plane.postgres.test.ts",
    exitCode: 0,
    skipped: 0,
  });
  assert.equal(passingResult.ok, true);
});

test("preflight refuses to run without an explicit disposable admin URL", () => {
  const missing = preflightPostgresReleaseEnvironment({});
  assert.deepEqual(missing.missingEnvVars, [ADMIN_URL_ENV_VAR]);
  const provided = preflightPostgresReleaseEnvironment({
    [ADMIN_URL_ENV_VAR]: "postgresql://worldcons:worldcons_test@localhost:5432/worldcons_gate",
  });
  assert.deepEqual(provided.missingEnvVars, []);
  assert.deepEqual(provided.invalidDatabaseNames, []);
});

test("connection strings are redacted from failure output", () => {
  const url = "postgresql://user:secret@localhost:5432/worldcons_p3_test";
  assert.equal(redactConnectionStrings(`failed at ${url}`, [url]), "failed at [test-database-url]");
});

test("release workflow uses a disposable pgvector service, PR/push triggers, and no production secrets", () => {
  assert.match(workflow, /^\s*pull_request:/mu);
  assert.match(workflow, /^\s*push:/mu);
  assert.match(workflow, /pgvector\/pgvector:pg16/u);
  assert.match(workflow, /POSTGRES_RELEASE_ADMIN_URL/u);
  assert.match(workflow, /P3_TEST_VECTOR_FALLBACK: "false"/u);
  assert.match(workflow, /pnpm test:postgres:release/u);
  assert.equal(workflow.includes("${{ secrets."), false, "release gate must not use production secrets");
  assert.equal(/\bDATABASE_URL\b/u.test(workflow), false, "release gate must not reference a production DATABASE_URL");
  assert.match(workflow, /health-cmd/u);
});

test("runner mechanically initializes pgvector and fails when any postgres test is skipped", () => {
  assert.match(runner, /create extension if not exists vector/u);
  assert.match(runner, /pgvector_unavailable/u);
  assert.match(runner, /skippedTestCount/u);
  assert.match(runner, /--test-reporter=tap/u);
  assert.match(runner, /requireZeroSkips: true/u);
  assert.match(gateLibrary, /test_skipped/u);
  assert.ok(packageJson.scripts["test:postgres:release"]?.includes("run-postgres-release-gate"));
  assert.ok(packageJson.scripts["test:postgres:release:static"]?.includes("postgres-release-gate.test.ts"));
});
