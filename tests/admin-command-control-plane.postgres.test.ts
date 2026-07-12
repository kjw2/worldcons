import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { Client, Pool } from "pg";

const databaseUrl = process.env.P0_TEST_DATABASE_URL;
const migrationPath = path.join(
  process.cwd(),
  "supabase/migrations/20260712090000_admin_command_control_plane.sql",
);

interface SubmittedRow {
  command_id: string;
  run_id: string;
  run_status: string;
  created: boolean;
  deduplicated: boolean;
}

interface ClaimedRow {
  command_id: string;
  run_id: string;
  attempt_id: string;
  attempt_number: number;
  fencing_token: string;
  lease_expires_at: Date;
}

async function submit(pool: Pool, suffix: string, options: { idempotency?: string; dedupe?: string; maxAttempts?: number } = {}) {
  const result = await pool.query<SubmittedRow>(
    `select * from admin_submit_command_v3($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      "admin.test",
      { ref: suffix },
      options.idempotency ?? `idempotency-${suffix}`,
      options.dedupe ?? `dedupe-${suffix}`,
      "test",
      0,
      options.maxAttempts ?? 3,
      1,
      4,
      false,
    ],
  );
  return result.rows[0];
}

async function claim(pool: Pool, worker: string, leaseSeconds = 60) {
  const result = await pool.query<ClaimedRow>(
    `select * from admin_claim_command_attempt_v3($1, $2, $3)`,
    [worker, ["admin.test"], leaseSeconds],
  );
  return result.rows[0] ?? null;
}

async function reset(pool: Pool) {
  await pool.query("truncate admin_command_events, admin_command_attempts, admin_command_runs, admin_commands restart identity cascade");
}

test("P0 PostgreSQL command control plane transitions", { skip: !databaseUrl }, async (t) => {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const database = await client.query<{ current_database: string }>("select current_database()");
  assert.match(
    database.rows[0].current_database,
    /(?:^|_)p0(?:_|$)/i,
    "P0 integration tests refuse to reset a database whose name does not contain p0",
  );
  await client.query("drop schema public cascade; create schema public");
  const migrationSql = fs.readFileSync(migrationPath, "utf8");
  await client.query(migrationSql);
  await client.query(migrationSql);
  await client.end();

  const pool = new Pool({ connectionString: databaseUrl, max: 8 });
  try {
    await t.test("duplicate concurrent requests resolve to one active command/run", async () => {
      await reset(pool);
      const [left, right] = await Promise.all([
        submit(pool, "left", { idempotency: "same-idempotency", dedupe: "same-dedupe" }),
        submit(pool, "right", { idempotency: "same-idempotency", dedupe: "same-dedupe" }),
      ]);
      assert.equal(left.command_id, right.command_id);
      assert.equal(left.run_id, right.run_id);
      assert.equal(Number(left.created) + Number(right.created), 1);
      assert.equal(Number(left.deduplicated) + Number(right.deduplicated), 1);

      const [activeLeft, activeRight] = await Promise.all([
        submit(pool, "active-left", { idempotency: "active-left", dedupe: "active-dedupe" }),
        submit(pool, "active-right", { idempotency: "active-right", dedupe: "active-dedupe" }),
      ]);
      assert.equal(activeLeft.run_id, activeRight.run_id, "active-only dedupe must survive concurrent distinct requests");
    });

    await t.test("terminal history does not block a later equivalent run", async () => {
      await reset(pool);
      const first = await submit(pool, "terminal-first", { dedupe: "reusable-dedupe" });
      const attempt = await claim(pool, "worker-terminal", 30);
      assert(attempt);
      await pool.query("select * from admin_complete_command_attempt_v3($1, $2, $3)", [
        attempt.attempt_id,
        attempt.fencing_token,
        {},
      ]);

      const second = await submit(pool, "terminal-second", { dedupe: "reusable-dedupe" });
      assert.notEqual(first.run_id, second.run_id);
      assert.equal(second.created, true);
      assert.equal(second.run_status, "queued");
    });

    await t.test("expired lease is reclaimed with a higher token and stale token is rejected", async () => {
      await reset(pool);
      await submit(pool, "reclaim");
      const first = await claim(pool, "worker-one", 30);
      assert(first);
      await pool.query("update admin_command_attempts set lease_expires_at = now() - interval '1 second' where id = $1", [first.attempt_id]);

      const second = await claim(pool, "worker-two", 30);
      assert(second);
      assert.equal(second.run_id, first.run_id);
      assert.equal(second.attempt_number, first.attempt_number + 1);
      assert(BigInt(second.fencing_token) > BigInt(first.fencing_token));

      await assert.rejects(
        pool.query("select * from admin_complete_command_attempt_v3($1, $2, $3)", [first.attempt_id, first.fencing_token, {}]),
        /ADMIN_QUEUE_STALE_FENCE/,
      );
      const oldAttempt = await pool.query<{ status: string }>("select status from admin_command_attempts where id = $1", [first.attempt_id]);
      assert.equal(oldAttempt.rows[0].status, "lease_expired");
    });

    await t.test("heartbeat persists and extends the active lease", async () => {
      await reset(pool);
      await submit(pool, "heartbeat");
      const attempt = await claim(pool, "worker-heartbeat", 5);
      assert(attempt);
      await pool.query("select pg_sleep(0.02)");
      const heartbeat = await pool.query<{ heartbeat_at: Date; lease_expires_at: Date }>(
        "select heartbeat_at, lease_expires_at from admin_heartbeat_command_attempt_v3($1, $2, $3)",
        [attempt.attempt_id, attempt.fencing_token, 30],
      );
      assert(heartbeat.rows[0].heartbeat_at.getTime() > 0);
      assert(heartbeat.rows[0].lease_expires_at.getTime() > attempt.lease_expires_at.getTime());
      const persisted = await pool.query<{ heartbeat_at: Date; event_count: string }>(
        `select a.heartbeat_at,
                (select count(*) from admin_command_events e where e.attempt_id = a.id and e.event_type = 'heartbeat') as event_count
         from admin_command_attempts a where a.id = $1`,
        [attempt.attempt_id],
      );
      assert.equal(persisted.rows[0].heartbeat_at.getTime(), heartbeat.rows[0].heartbeat_at.getTime());
      assert.equal(persisted.rows[0].event_count, "1");
    });

    await t.test("abort before claim is terminal and unclaimable", async () => {
      await reset(pool);
      const queued = await submit(pool, "abort-before");
      const aborted = await pool.query<{ run_status: string; finished_at: Date }>(
        "select * from admin_abort_command_run_v3($1, $2, $3)",
        [queued.run_id, "operator", "stop"],
      );
      assert.equal(aborted.rows[0].run_status, "aborted");
      assert(aborted.rows[0].finished_at);
      assert.equal(await claim(pool, "worker-after-abort"), null);
      const events = await pool.query<{ event_type: string }>(
        "select event_type from admin_command_events where run_id = $1 and event_type in ('abort_requested', 'run_aborted') order by id",
        [queued.run_id],
      );
      assert.deepEqual(events.rows.map((row) => row.event_type), ["abort_requested", "run_aborted"]);
    });

    await t.test("abort during run terminalizes the attempt and fences the worker", async () => {
      await reset(pool);
      await submit(pool, "abort-running");
      const attempt = await claim(pool, "worker-aborted", 30);
      assert(attempt);
      await pool.query("select * from admin_abort_command_run_v3($1, $2, $3)", [attempt.run_id, "operator", "stop now"]);
      const state = await pool.query<{ run_status: string; attempt_status: string }>(
        `select r.status as run_status, a.status as attempt_status
         from admin_command_runs r join admin_command_attempts a on a.id = r.current_attempt_id where r.id = $1`,
        [attempt.run_id],
      );
      assert.deepEqual(state.rows[0], { run_status: "aborted", attempt_status: "aborted" });
      await assert.rejects(
        pool.query("select * from admin_complete_command_attempt_v3($1, $2, $3)", [attempt.attempt_id, attempt.fencing_token, {}]),
        /ADMIN_QUEUE_ABORTED/,
      );
    });

    await t.test("simultaneous abort and completion resolve without a lock-order deadlock", async () => {
      await reset(pool);
      await submit(pool, "abort-complete-race");
      const attempt = await claim(pool, "worker-race", 30);
      assert(attempt);

      const [abortResult, completionResult] = await Promise.allSettled([
        pool.query("select * from admin_abort_command_run_v3($1, $2, $3)", [attempt.run_id, "operator", "race"]),
        pool.query("select * from admin_complete_command_attempt_v3($1, $2, $3)", [attempt.attempt_id, attempt.fencing_token, {}]),
      ]);
      const failures = [abortResult, completionResult].filter((result) => result.status === "rejected") as PromiseRejectedResult[];
      for (const failure of failures) {
        assert.doesNotMatch(String(failure.reason), /40P01|deadlock detected/i);
        assert.match(String(failure.reason), /ADMIN_QUEUE_ABORTED/);
      }

      const state = await pool.query<{ status: string }>("select status from admin_command_runs where id = $1", [attempt.run_id]);
      assert.match(state.rows[0].status, /^(aborted|succeeded)$/);
    });

    await t.test("retryable failures back off while terminal failures finish", async () => {
      await reset(pool);
      await submit(pool, "retry", { maxAttempts: 3 });
      const first = await claim(pool, "worker-retry-one", 30);
      assert(first);
      const retryable = await pool.query<{ run_status: string; retry_at: Date }>(
        "select * from admin_fail_command_attempt_v3($1, $2, $3, $4, $5, $6)",
        [first.attempt_id, first.fencing_token, "retryable", "timeout", "safe timeout", {}],
      );
      assert.equal(retryable.rows[0].run_status, "retry_wait");
      assert(retryable.rows[0].retry_at.getTime() > Date.now());

      await pool.query("update admin_command_runs set available_at = now() where id = $1", [first.run_id]);
      const second = await claim(pool, "worker-retry-two", 30);
      assert(second);
      const terminal = await pool.query<{ run_status: string; retry_at: Date | null }>(
        "select * from admin_fail_command_attempt_v3($1, $2, $3, $4, $5, $6)",
        [second.attempt_id, second.fencing_token, "terminal", "validation_error", "safe failure", {}],
      );
      assert.equal(terminal.rows[0].run_status, "failed");
      assert.equal(terminal.rows[0].retry_at, null);
    });

    await t.test("database retry backoff remains capped at high attempt numbers", async () => {
      await reset(pool);
      await submit(pool, "retry-cap", { maxAttempts: 100 });
      const attempt = await claim(pool, "worker-retry-cap", 30);
      assert(attempt);
      await pool.query("update admin_command_attempts set attempt_number = 40 where id = $1", [attempt.attempt_id]);
      const before = Date.now();
      const result = await pool.query<{ run_status: string; retry_at: Date }>(
        "select * from admin_fail_command_attempt_v3($1, $2, $3, $4, $5, $6)",
        [attempt.attempt_id, attempt.fencing_token, "retryable", "timeout", "safe timeout", {}],
      );
      const delayMs = result.rows[0].retry_at.getTime() - before;
      assert.equal(result.rows[0].run_status, "retry_wait");
      assert(delayMs > 0 && delayMs <= 4_500, `expected capped retry delay, received ${delayMs}ms`);
    });

    await t.test("unsafe queue data is rejected without echoing the secret", async () => {
      await reset(pool);
      await assert.rejects(
        pool.query("select * from admin_submit_command_v3($1, $2, $3, $4)", [
          "admin.test",
          { apiKey: "secret-value-that-must-not-echo" },
          "unsafe-idempotency",
          "unsafe-dedupe",
        ]),
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          assert.match(message, /ADMIN_QUEUE_UNSAFE_PAYLOAD_REF/);
          assert.doesNotMatch(message, /secret-value-that-must-not-echo/);
          return true;
        },
      );
    });

    await t.test("security-definer RPCs are not executable by PUBLIC and immutable rows reject mutation", async () => {
      await reset(pool);
      const submitted = await submit(pool, "acl");
      const privileges = await pool.query<{ function_public: boolean; table_public: boolean }>(
        `select
           has_function_privilege('public', 'admin_submit_command_v3(text,jsonb,text,text,text,integer,integer,integer,integer,boolean)', 'execute') as function_public,
           has_table_privilege('public', 'admin_commands', 'insert') as table_public`,
      );
      assert.deepEqual(privileges.rows[0], { function_public: false, table_public: false });
      await assert.rejects(
        pool.query("update admin_commands set priority = priority + 1 where id = $1", [submitted.command_id]),
        /ADMIN_QUEUE_IMMUTABLE_RECORD/,
      );
      await assert.rejects(
        pool.query("delete from admin_command_events where run_id = $1", [submitted.run_id]),
        /ADMIN_QUEUE_IMMUTABLE_RECORD/,
      );
    });
  } finally {
    await pool.end();
  }
});
