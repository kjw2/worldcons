export interface PostgresReleaseSpec {
  label: string;
  envVar: string;
  databaseName: string;
  databaseNamePattern: RegExp;
  testFile: string;
}

export const POSTGRES_RELEASE_SPECS: PostgresReleaseSpec[] = [
  {
    label: "P0 admin command control plane",
    envVar: "P0_TEST_DATABASE_URL",
    databaseName: "worldcons_p0_test",
    databaseNamePattern: /(?:^|_)p0(?:_|$)/i,
    testFile: "tests/admin-command-control-plane.postgres.test.ts",
  },
  {
    label: "P1 admin command worker",
    envVar: "P1_TEST_DATABASE_URL",
    databaseName: "worldcons_p1_test",
    databaseNamePattern: /(?:^|_)p1(?:_|$)/i,
    testFile: "tests/admin-command-worker-p1.postgres.test.ts",
  },
  {
    label: "P2 article lifecycle",
    envVar: "P2_TEST_DATABASE_URL",
    databaseName: "worldcons_p2_test",
    databaseNamePattern: /(?:^|_)p2(?:_|$)/i,
    testFile: "tests/article-lifecycle-p2.postgres.test.ts",
  },
  {
    label: "P3 article publication",
    envVar: "P3_TEST_DATABASE_URL",
    databaseName: "worldcons_p3_test",
    databaseNamePattern: /(?:^|_)p3(?:_|$)/i,
    testFile: "tests/article-publication-p3.postgres.test.ts",
  },
  {
    label: "P5 admin governance",
    envVar: "P5_TEST_DATABASE_URL",
    databaseName: "worldcons_p5_test",
    databaseNamePattern: /(?:^|_)p5(?:_|$)/i,
    testFile: "tests/admin-governance-p5.postgres.test.ts",
  },
  {
    label: "Constitutional case backfill Gate 1",
    envVar: "BACKFILL_TEST_DATABASE_URL",
    databaseName: "worldcons_backfill_test",
    databaseNamePattern: /backfill/i,
    testFile: "tests/constitutional-case-backfill-gate1.postgres.test.ts",
  },
  {
    label: "Constitutional case catalog Gate 2",
    envVar: "CATALOG_TEST_DATABASE_URL",
    databaseName: "worldcons_catalog_test",
    databaseNamePattern: /catalog/i,
    testFile: "tests/constitutional-case-catalog-gate2.postgres.test.ts",
  },
];

export const ADMIN_URL_ENV_VAR = "POSTGRES_RELEASE_ADMIN_URL";

export function databaseNameFromUrl(connectionString: string | undefined): string | null {
  if (!connectionString) return null;
  try {
    const url = new URL(connectionString);
    const name = decodeURIComponent(url.pathname.replace(/^\//u, ""));
    return name.length > 0 ? name : null;
  } catch {
    return null;
  }
}

export function withDatabaseName(connectionString: string, databaseName: string): string {
  if (!/^[a-z0-9_]+$/u.test(databaseName)) throw new Error(`backfill_release.invalid_database_name:${databaseName}`);
  const url = new URL(connectionString);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

export interface PostgresReleasePreflight {
  missingEnvVars: string[];
  invalidDatabaseNames: Array<{ label: string; envVar: string; databaseName: string | null }>;
}

export function preflightPostgresReleaseEnvironment(
  env: Record<string, string | undefined>,
): PostgresReleasePreflight {
  const missingEnvVars: string[] = [];
  const invalidDatabaseNames: Array<{ label: string; envVar: string; databaseName: string | null }> = [];
  if (!env[ADMIN_URL_ENV_VAR]) missingEnvVars.push(ADMIN_URL_ENV_VAR);
  for (const spec of POSTGRES_RELEASE_SPECS) {
    if (!spec.databaseNamePattern.test(spec.databaseName)) {
      invalidDatabaseNames.push({ label: spec.label, envVar: spec.envVar, databaseName: spec.databaseName });
    }
  }
  return { missingEnvVars, invalidDatabaseNames };
}

export interface PostgresReleaseResult {
  label: string;
  envVar: string;
  testFile: string;
  exitCode: number;
  skipped: number;
  ok: boolean;
  reason: string | null;
}

export function skippedTestCount(tapOutput: string): number {
  const directives = (tapOutput.match(/#\s*SKIP\b/gu) ?? []).length;
  const summaryMatch = tapOutput.match(/#\s*skipped\s+(\d+)/iu);
  const summary = summaryMatch ? Number(summaryMatch[1]) : 0;
  return Math.max(directives, summary);
}

export function evaluatePostgresReleaseResult(input: {
  label: string;
  envVar: string;
  testFile: string;
  exitCode: number;
  skipped: number;
}): PostgresReleaseResult {
  let reason: string | null = null;
  if (input.exitCode !== 0) reason = "test_failed";
  else if (input.skipped > 0) reason = "test_skipped";
  return { ...input, ok: reason === null, reason };
}

export function redactConnectionStrings(output: string, connectionStrings: string[]): string {
  let redacted = output;
  for (const connectionString of connectionStrings) {
    if (!connectionString) continue;
    redacted = redacted.split(connectionString).join("[test-database-url]");
  }
  return redacted;
}
