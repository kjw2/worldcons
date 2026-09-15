import { spawnSync } from "node:child_process";
import { Client } from "pg";
import {
  ADMIN_URL_ENV_VAR,
  POSTGRES_RELEASE_SPECS,
  evaluatePostgresReleaseResult,
  preflightPostgresReleaseEnvironment,
  redactConnectionStrings,
  skippedTestCount,
  withDatabaseName,
  type PostgresReleaseResult,
} from "@/lib/testing/postgres-release-gate";

const repoRoot = process.cwd();
const MAX_OUTPUT_BUFFER = 64 * 1024 * 1024;

function fail(event: string, details: Record<string, unknown>) {
  process.stdout.write(`${JSON.stringify({ event, ok: false, ...details })}\n`);
  process.exitCode = 1;
}

async function initializeDisposableServer(adminUrl: string) {
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query("create extension if not exists vector");
    const version = await client.query<{ extversion: string }>(
      "select extversion from pg_extension where extname = 'vector'",
    );
    if (!version.rows[0]?.extversion) throw new Error("postgres_release.pgvector_unavailable");
    for (const spec of POSTGRES_RELEASE_SPECS) {
      const exists = await client.query("select 1 from pg_database where datname = $1", [spec.databaseName]);
      if (exists.rowCount === 0) {
        await client.query(`create database "${spec.databaseName}"`);
      }
    }
    return version.rows[0].extversion;
  } finally {
    await client.end();
  }
}

function runSpecTest(spec: (typeof POSTGRES_RELEASE_SPECS)[number], connectionString: string): PostgresReleaseResult {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--test", "--test-reporter=tap", spec.testFile],
    {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: MAX_OUTPUT_BUFFER,
      env: {
        ...process.env,
        [spec.envVar]: connectionString,
        P3_TEST_VECTOR_FALLBACK: "false",
      },
    },
  );
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const exitCode = result.status ?? 1;
  const skipped = skippedTestCount(output);
  const evaluated = evaluatePostgresReleaseResult({
    label: spec.label,
    envVar: spec.envVar,
    testFile: spec.testFile,
    exitCode,
    skipped,
  });
  if (!evaluated.ok) {
    const tail = redactConnectionStrings(output, [connectionString]).split(/\r?\n/u).slice(-40).join("\n");
    process.stderr.write(`--- ${spec.label} (${spec.testFile}) [${evaluated.reason}] ---\n${tail}\n`);
  }
  return evaluated;
}

async function main() {
  const adminUrl = process.env[ADMIN_URL_ENV_VAR]?.trim();
  const preflight = preflightPostgresReleaseEnvironment(process.env);
  if (preflight.missingEnvVars.length > 0) {
    fail("postgres_release_preflight_failed", {
      missingEnvVars: preflight.missingEnvVars,
      message:
        `${ADMIN_URL_ENV_VAR} must point at a disposable PostgreSQL+pgvector database. ` +
        "This gate refuses to run without an explicit disposable environment.",
    });
    return;
  }
  if (!adminUrl) return;
  if (preflight.invalidDatabaseNames.length > 0) {
    fail("postgres_release_invalid_specs", { invalidDatabaseNames: preflight.invalidDatabaseNames });
    return;
  }

  const pgvectorVersion = await initializeDisposableServer(adminUrl);
  const results: PostgresReleaseResult[] = [];
  for (const spec of POSTGRES_RELEASE_SPECS) {
    results.push(runSpecTest(spec, withDatabaseName(adminUrl, spec.databaseName)));
  }

  const failed = results.filter((result) => !result.ok);
  process.stdout.write(`${JSON.stringify({
    event: "postgres_release_gate_completed",
    ok: failed.length === 0,
    pgvectorVersion,
    requireZeroSkips: true,
    tests: results.map((result) => ({
      label: result.label,
      envVar: result.envVar,
      testFile: result.testFile,
      exitCode: result.exitCode,
      skipped: result.skipped,
      ok: result.ok,
      reason: result.reason,
    })),
  })}\n`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  process.stdout.write(`${JSON.stringify({
    event: "postgres_release_gate_failed",
    ok: false,
    errorCode: error instanceof Error ? error.message.slice(0, 500) : "unknown_error",
  })}\n`);
  process.exitCode = 1;
});
