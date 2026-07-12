import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { Client, Pool } from "pg";

const databaseUrl = process.env.P1_TEST_DATABASE_URL;
const p0Migration = path.join(process.cwd(), "supabase/migrations/20260712090000_admin_command_control_plane.sql");
const p1Migration = path.join(process.cwd(), "supabase/migrations/20260712130000_admin_command_worker_p1.sql");

const candidateSchema = `
create table source_url_candidates (
  id uuid primary key default gen_random_uuid(),
  source_key text not null,
  url text not null,
  candidate_type text not null,
  discovered_by text not null,
  status text not null default 'pending',
  last_attempt_at timestamptz,
  attempt_count integer not null default 0,
  last_error_code text,
  last_error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);`;

test("P1 PostgreSQL cohort and candidate transitions", { skip: !databaseUrl }, async (t) => {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const database = await client.query<{ current_database: string }>("select current_database()");
  assert.match(database.rows[0].current_database, /(?:^|_)p1(?:_|$)/i, "P1 tests refuse to reset a database whose name does not contain p1");
  await client.query("drop schema public cascade; create schema public");
  await client.query("create extension if not exists pgcrypto");
  await client.query(fs.readFileSync(p0Migration, "utf8"));
  await client.query(candidateSchema);
  const p1Sql = fs.readFileSync(p1Migration, "utf8");
  await client.query(p1Sql);
  await client.query(p1Sql);
  await client.end();

  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  try {
    await t.test("claim filters cohort before locking and cannot claim shadow evidence", async () => {
      const daily = await pool.query<{ run_id: string }>(
        "select * from admin_submit_command_v3($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
        ["p1.collect", { cohort: "daily" }, "daily-id", "daily-dedupe", "test", 0, 3, 1, 4, false],
      );
      const manual = await pool.query<{ run_id: string }>(
        "select * from admin_submit_command_v3($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
        ["p1.collect", { cohort: "manual" }, "manual-id", "manual-dedupe", "test", 0, 3, 1, 4, false],
      );
      const shadow = await pool.query<{ run_id: string }>(
        "select * from admin_submit_command_v3($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
        ["p1.collect", { cohort: "daily" }, "shadow-id", "shadow-dedupe", "test", 0, 3, 1, 4, true],
      );
      const claimed = await pool.query<{ run_id: string; attempt_id: string; fencing_token: string; payload_ref: { cohort: string } }>(
        "select * from admin_claim_command_attempt_p1($1, $2, $3, $4)",
        ["worker", ["p1.collect"], ["daily"], 30],
      );
      assert.equal(claimed.rows[0].run_id, daily.rows[0].run_id);
      assert.equal(claimed.rows[0].payload_ref.cohort, "daily");
      await pool.query("select * from admin_heartbeat_command_attempt_v3($1, $2, $3)", [
        claimed.rows[0].attempt_id,
        claimed.rows[0].fencing_token,
        30,
      ]);
      await pool.query("select * from admin_complete_command_attempt_v3($1, $2, $3)", [
        claimed.rows[0].attempt_id,
        claimed.rows[0].fencing_token,
        {},
      ]);
      const states = await pool.query<{ id: string; status: string; attempts: string }>(
        `select r.id, r.status, count(a.id)::text as attempts
         from admin_command_runs r left join admin_command_attempts a on a.run_id = r.id
         where r.id = any($1) group by r.id, r.status`,
        [[manual.rows[0].run_id, shadow.rows[0].run_id]],
      );
      const state = new Map(states.rows.map((row) => [row.id, row]));
      assert.deepEqual(state.get(manual.rows[0].run_id), { id: manual.rows[0].run_id, status: "queued", attempts: "0" });
      assert.deepEqual(state.get(shadow.rows[0].run_id), { id: shadow.rows[0].run_id, status: "shadowed", attempts: "0" });
    });

    await t.test("candidate begin/finish is idempotent and rejects a stale attempt count", async () => {
      const inserted = await pool.query<{ id: string }>(
        `insert into source_url_candidates (source_key, url, candidate_type, discovered_by)
         values ('de-bverfg', 'https://www.bundesverfassungsgericht.de/SharedDocs/Entscheidungen/DE/test.html', 'decision', 'test') returning id`,
      );
      const candidateId = inserted.rows[0].id;
      const begun = await pool.query<{ candidate_status: string; attempt_count: number; should_fetch: boolean }>(
        "select * from admin_begin_source_url_candidate_retry_p1($1)",
        [candidateId],
      );
      assert.equal(begun.rows[0].candidate_status, "retrying");
      assert.equal(begun.rows[0].attempt_count, 1);
      assert.equal(begun.rows[0].should_fetch, true);
      await assert.rejects(
        pool.query("select * from admin_finish_source_url_candidate_retry_p1($1, $2, $3, $4, $5)", [candidateId, 0, "fetched", null, null]),
        /ADMIN_QUEUE_STALE_CANDIDATE_ATTEMPT/,
      );
      await pool.query("select * from admin_finish_source_url_candidate_retry_p1($1, $2, $3, $4, $5)", [candidateId, 1, "fetched", null, null]);
      const idempotent = await pool.query<{ candidate_status: string; attempt_count: number; should_fetch: boolean }>(
        "select * from admin_begin_source_url_candidate_retry_p1($1)",
        [candidateId],
      );
      assert.equal(idempotent.rows[0].candidate_status, "fetched");
      assert.equal(idempotent.rows[0].attempt_count, 1);
      assert.equal(idempotent.rows[0].should_fetch, false);
    });
  } finally {
    await pool.end();
  }
});
