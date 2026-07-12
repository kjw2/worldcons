import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  adminQueueV3ShadowWriteEnabled,
  executeAdminCompatibilityCommand,
} from "../lib/admin/command-control-plane/compatibility";
import { adminIngestResultSucceeded } from "../lib/admin/admin-ingest-jobs";
import { adminCommandRetryBackoffSeconds, classifyAdminCommandFailure } from "../lib/admin/command-control-plane/policy";

const migrationPath = path.join(
  process.cwd(),
  "supabase/migrations/20260712090000_admin_command_control_plane.sql",
);

test("P0 migration carries database-enforced queue invariants", () => {
  const sql = fs.readFileSync(migrationPath, "utf8");

  assert.match(sql, /create table if not exists admin_commands/i);
  assert.match(sql, /create table if not exists admin_command_runs/i);
  assert.match(sql, /create table if not exists admin_command_attempts/i);
  assert.match(sql, /create table if not exists admin_command_events/i);
  assert.match(sql, /admin_command_runs_active_dedupe_key_uidx[\s\S]*where status in \('queued', 'running', 'retry_wait'\)/i);
  assert.match(sql, /pg_advisory_xact_lock/i, "concurrent command creation must serialize in PostgreSQL");
  assert.match(sql, /for update of r skip locked/i, "claims must be atomic and nonblocking");
  assert.match(sql, /admin_command_fencing_token_seq/i, "claims must allocate monotonic fencing tokens");
  assert.match(sql, /v_attempt\.fencing_token <> p_fencing_token[\s\S]*ADMIN_QUEUE_STALE_FENCE/i);
  assert.match(sql, /lease_expires_at <= now\(\)[\s\S]*status = 'lease_expired'/i);
  assert.match(sql, /heartbeat_at = now\(\)[\s\S]*lease_expires_at = now\(\) \+ make_interval/i);
  assert.match(sql, /p_failure_disposition = 'retryable'[\s\S]*retry_wait/i);
  assert.match(sql, /status = 'aborted'[\s\S]*ADMIN_QUEUE_ABORTED/i);
  assert.match(sql, /admin_commands_immutable_trigger/i);
  assert.match(sql, /admin_command_events_immutable_trigger/i);
  assert.match(sql, /revoke all on function admin_submit_command_v3[\s\S]*from public/i);
  assert.doesNotMatch(sql, /drop table|truncate table|alter table admin_jobs|delete from admin_jobs/i);
});

test("retry classification and exponential backoff are bounded", () => {
  assert.equal(classifyAdminCommandFailure("timeout"), "retryable");
  assert.equal(classifyAdminCommandFailure("summary.rate_limited"), "retryable");
  assert.equal(classifyAdminCommandFailure("validation_error"), "terminal");
  assert.equal(adminCommandRetryBackoffSeconds(1, 15, 900), 15);
  assert.equal(adminCommandRetryBackoffSeconds(4, 15, 900), 120);
  assert.equal(adminCommandRetryBackoffSeconds(20, 15, 900), 900);
});

test("ingestion compatibility success rejects blocked, empty, and partial-failure results", () => {
  assert.equal(adminIngestResultSucceeded({ mode: "blocked", results: [] }), false);
  assert.equal(adminIngestResultSucceeded({ mode: "database", results: [] }), false);
  assert.equal(
    adminIngestResultSucceeded({ mode: "database", results: [{ failedCount: 1, errors: ["failed"] }] }),
    false,
  );
  assert.equal(
    adminIngestResultSucceeded({ mode: "database", results: [{ failedCount: 0, errors: [] }] }),
    true,
  );
});

test("compatibility authority is default-off and preserves legacy results", async () => {
  assert.equal(adminQueueV3ShadowWriteEnabled({}), false);
  assert.equal(adminQueueV3ShadowWriteEnabled({ ADMIN_QUEUE_V3_SHADOW_WRITE_ENABLED: "false" }), false);
  assert.equal(adminQueueV3ShadowWriteEnabled({ ADMIN_QUEUE_V3_SHADOW_WRITE_ENABLED: "true" }), true);

  let submitted = false;
  const result = await executeAdminCompatibilityCommand(
    { commandType: "admin.test", payloadRef: { action: "test" } },
    async () => ({ legacy: true }),
    {
      isLegacySuccess: () => {
        throw new Error("default-off must not evaluate the success predicate");
      },
      shadowEnabled: false,
      submit: async () => {
        submitted = true;
        throw new Error("submit must not be called while disabled");
      },
    },
  );

  assert.deepEqual(result.value, { legacy: true });
  assert.equal(result.authority, "legacy");
  assert.equal(result.shadow, "disabled");
  assert.equal(submitted, false);
});

test("compatibility shadow writes are terminal, redacted, and non-authoritative", async () => {
  let captured: Record<string, unknown> | undefined;
  const result = await executeAdminCompatibilityCommand(
    {
      commandType: "admin.test",
      payloadRef: { action: "test", apiKey: "must-not-persist", nested: { password: "hidden" } },
      requestedBy: "operator",
    },
    () => "legacy-result",
    {
      isLegacySuccess: () => true,
      shadowEnabled: true,
      submit: async (input) => {
        captured = input as unknown as Record<string, unknown>;
        return {
          ok: true,
          data: {
            commandId: "command",
            runId: "run",
            runStatus: "shadowed",
            created: true,
            deduplicated: false,
          },
        };
      },
    },
  );

  assert.equal(result.value, "legacy-result");
  assert.equal(result.shadow, "written");
  assert.equal(captured?.shadowOnly, true);
  assert.deepEqual(captured?.payloadRef, { action: "test", apiKey: "[redacted]", nested: { password: "[redacted]" } });
});

test("resolved legacy failure does not create false-positive shadow evidence", async () => {
  const legacyFailure = { ok: false as const, error: "legacy failure" };
  let submitted = false;
  const result = await executeAdminCompatibilityCommand(
    { commandType: "admin.test", payloadRef: { action: "test" } },
    () => legacyFailure,
    {
      isLegacySuccess: (value) => value.ok,
      shadowEnabled: true,
      submit: async () => {
        submitted = true;
        throw new Error("resolved failures must not submit");
      },
    },
  );

  assert.equal(result.value, legacyFailure);
  assert.equal(result.shadow, "skipped");
  assert.equal(result.shadowResult, undefined);
  assert.equal(submitted, false);
});

test("thrown legacy failure propagates without evaluating or shadow-submitting", async () => {
  const legacyFailure = new Error("legacy threw");
  let predicateEvaluated = false;
  let submitted = false;

  await assert.rejects(
    executeAdminCompatibilityCommand(
      { commandType: "admin.test", payloadRef: { action: "test" } },
      async () => {
        throw legacyFailure;
      },
      {
        isLegacySuccess: () => {
          predicateEvaluated = true;
          return true;
        },
        shadowEnabled: true,
        submit: async () => {
          submitted = true;
          throw new Error("thrown failures must not submit");
        },
      },
    ),
    (error: unknown) => error === legacyFailure,
  );

  assert.equal(predicateEvaluated, false);
  assert.equal(submitted, false);
});

test("success predicate failures skip shadowing without changing the legacy value", async () => {
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];
  let submitted = false;
  console.warn = (...values: unknown[]) => warnings.push(values);
  try {
    const result = await executeAdminCompatibilityCommand(
      { commandType: "admin.test", payloadRef: { action: "test" } },
      () => "legacy-result",
      {
        isLegacySuccess: () => {
          throw new Error("predicate detail must not escape");
        },
        shadowEnabled: true,
        submit: async () => {
          submitted = true;
          throw new Error("predicate failures must not submit");
        },
      },
    );

    assert.equal(result.value, "legacy-result");
    assert.equal(result.shadow, "skipped");
    assert.equal(submitted, false);
    assert.match(JSON.stringify(warnings), /admin_command_success_predicate_failed/);
    assert.doesNotMatch(JSON.stringify(warnings), /predicate detail must not escape/);
  } finally {
    console.warn = originalWarn;
  }
});

test("compatibility shadow exceptions cannot change the legacy response", async () => {
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...values: unknown[]) => warnings.push(values);
  try {
    const result = await executeAdminCompatibilityCommand(
      { commandType: "admin.test", payloadRef: { action: "test" } },
      () => "legacy-result",
      {
        isLegacySuccess: () => true,
        shadowEnabled: true,
        submit: async () => {
          throw new Error("database detail must not escape");
        },
      },
    );

    assert.equal(result.value, "legacy-result");
    assert.equal(result.shadow, "failed");
    assert.equal(result.shadowResult?.ok, false);
    assert.doesNotMatch(JSON.stringify(warnings), /database detail must not escape/);
    assert.match(JSON.stringify(warnings), /admin_command_shadow_failed/);
  } finally {
    console.warn = originalWarn;
  }
});

test("all administrator execution ingress uses auth and the compatibility adapter", () => {
  const mutationRoutes = [
    "app/api/admin/review/route.ts",
    "app/api/admin/ingest/route.ts",
    "app/api/admin/glossary-candidates/route.ts",
    "app/api/admin/candidates/route.ts",
    "app/api/admin/public-content/revalidate/route.ts",
    "app/api/admin/llm-settings/test/route.ts",
    "app/api/admin/llm-settings/route.ts",
    "app/api/admin/articles/bulk/route.ts",
    "app/api/admin/articles/[articleRef]/summary/route.ts",
    "app/api/admin/jobs/[jobId]/route.ts",
    "app/api/admin/jobs/run/route.ts",
  ];
  const cronRoutes = ["app/api/admin/cron/ingest/route.ts", "app/api/admin/cron/jobs/route.ts"];

  for (const route of mutationRoutes) {
    const source = fs.readFileSync(path.join(process.cwd(), route), "utf8");
    assert.match(source, /adminMutationAuthFailureStatus/, `${route} must enforce mutation auth`);
    assert.match(source, /executeAdminCompatibilityCommand/, `${route} must use the compatibility adapter`);
    assert.match(source, /isLegacySuccess/, `${route} must define command shadow success explicitly`);
  }
  for (const route of cronRoutes) {
    const source = fs.readFileSync(path.join(process.cwd(), route), "utf8");
    assert.match(source, /isAuthorizedSecretRequest/, `${route} must retain distinct cron auth`);
    assert.match(source, /executeAdminCompatibilityCommand/, `${route} must use the compatibility adapter`);
    assert.match(source, /isLegacySuccess/, `${route} must define command shadow success explicitly`);
    assert.doesNotMatch(source, /adminMutationAuthFailureStatus/, `${route} must not use session mutation auth`);
  }
});

test("P0 documentation fixes migration order, flag default, evidence, and rollback", () => {
  const architecture = fs.readFileSync(path.join(process.cwd(), "docs/admin-redesign-v2-v4-architecture.md"), "utf8");
  const operations = fs.readFileSync(path.join(process.cwd(), "docs/admin-command-control-plane-p0.md"), "utf8");
  const environment = fs.readFileSync(path.join(process.cwd(), ".env.example"), "utf8");

  assert.match(environment, /^ADMIN_QUEUE_V3_SHADOW_WRITE_ENABLED=false$/m);
  assert.match(architecture, /explicitPublic=1174/);
  assert.match(architecture, /Publication, article-state, version, outbox, and UI work are explicitly outside P0/);
  assert.match(operations, /20260710100000_fix_claim_admin_job_parameter_references\.sql/);
  assert.match(operations, /20260712090000_admin_command_control_plane\.sql/);
  assert.match(operations, /defaults to `false`/);
  assert.match(operations, /Merely resolving is not success/);
  assert.match(operations, /Resolved failures and no-ops/);
  assert.match(operations, /A thrown legacy failure propagates unchanged/);
  assert.match(operations, /Do not delete commands, runs, attempts, or events to roll back/);
  assert.match(operations, /migration is rehearsed on an approved production-shaped copy/);
});

test("unauthorized queue ingress is rejected before execution", async () => {
  const { POST: runJobs } = await import("../app/api/admin/jobs/run/route");
  const response = await runJobs(new Request("https://example.test/api/admin/jobs/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  }));
  assert.equal(response.status, 401);

  const { GET: cronJobs } = await import("../app/api/admin/cron/jobs/route");
  const cronResponse = await cronJobs(new Request("https://example.test/api/admin/cron/jobs"));
  assert.equal(cronResponse.status, 401);
});
