import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { Client, Pool } from "pg";

const sql = fs.readFileSync(path.join(process.cwd(), "supabase/migrations/20260712230000_admin_governance_p5.sql"), "utf8");
const indexSql = fs.readFileSync(path.join(process.cwd(), "supabase/migrations/20260712231000_admin_governance_p5_indexes.sql"), "utf8");
const correctiveSql = fs.readFileSync(path.join(process.cwd(), "supabase/migrations/20260712233000_admin_governance_p5_acceptance_corrections.sql"), "utf8");
const databaseUrl = process.env.P5_TEST_DATABASE_URL;
const p5Indexes = [
  "admin_compat_obs_p5_window_idx", "admin_governance_evidence_p5_current_idx",
  "admin_governance_evidence_p5_digest_idx", "admin_retention_holds_p5_active_idx",
  "ingestion_runs_source_started_p5_idx", "admin_command_runs_abort_p5_idx",
  "admin_command_runs_retry_p5_idx", "admin_command_attempts_finished_p5_idx",
  "admin_command_events_occurred_p5_idx", "articles_lifecycle_review_age_p5_idx",
  "article_lifecycle_events_occurred_p5_idx", "article_publication_history_occurred_p5_idx",
  "article_content_versions_created_p5_idx", "article_cache_outbox_delivered_p5_idx",
] as const;

test("P5 migration is additive, aggregate-only, secure, indexed, and rerunnable", () => {
  assert.match(sql, /create table if not exists admin_compatibility_observations_p5/);
  assert.match(sql, /create or replace view admin_operational_health_core_p5[\s\S]*security_barrier = true/);
  assert.match(sql, /create or replace function admin_operational_health_p5/);
  assert.match(sql, /create or replace function admin_record_backup_restore_evidence_p5[\s\S]*ADMIN_P5_INVALID_BACKUP_EVIDENCE/);
  assert.match(sql, /security definer[\s\S]*set search_path = public, pg_temp/g);
  assert.match(sql, /enable row level security/g);
  assert.match(sql, /revoke all on table admin_compatibility_observations_p5/);
  assert.match(sql, /grant execute on function admin_operational_health_p5[\s\S]*to service_role/);
  assert.doesNotMatch(sql, /create index/i);
  for (const index of ["admin_compat_obs_p5_window_idx", "ingestion_runs_source_started_p5_idx", "admin_command_runs_abort_p5_idx", "articles_lifecycle_review_age_p5_idx", "article_cache_outbox_delivered_p5_idx", "admin_governance_evidence_p5_digest_idx"]) {
    assert.match(indexSql, new RegExp(`create index concurrently if not exists ${index}`));
  }
  const health = sql.slice(sql.indexOf("create or replace function admin_operational_health_p5"), sql.indexOf("create or replace function admin_apply_retention_p5"));
  assert.doesNotMatch(health, /original_url|canonical_url|raw_text|cleaned_text|payload_ref|base_url|credential|secret/i);
  assert.match(health, /left join lateral \([\s\S]*limit 1/);
  assert.match(health, /p_observation_end - p_observation_start > interval '90 days'/);
});

test("P5 corrective migration binds approvals to digest and distinct actors", () => {
  assert.match(correctiveSql, /create or replace function admin_record_owner_approval_p5_v2/);
  assert.match(correctiveSql, /note_code = 'retirement\.readiness\.v2'/);
  assert.match(correctiveSql, /p_evidence_digest is distinct from p_current_evidence_digest[\s\S]*ADMIN_P5_STALE_EVIDENCE_DIGEST/);
  assert.match(correctiveSql, /pg_advisory_xact_lock\(hashtextextended\('admin-p5-approval:' \|\| p_evidence_digest, 0\)\)/);
  assert.match(correctiveSql, /actor_hash = p_actor_hash[\s\S]*role_key <> p_role_key[\s\S]*ADMIN_P5_DUPLICATE_ACTOR_ROLE/);
  assert.match(correctiveSql, /role_key = p_role_key[\s\S]*actor_hash <> p_actor_hash[\s\S]*ADMIN_P5_ROLE_ALREADY_APPROVED/);
  assert.match(correctiveSql, /revoke all on function admin_record_owner_approval_p5\(text, text, text, timestamptz\) from service_role/);
  assert.match(correctiveSql, /'approvalSets', admin_governance_approval_sets_p5\(\)/);
  assert.match(correctiveSql, /count\(distinct actor_hash\) filter/);
  assert.match(indexSql, /create index concurrently if not exists admin_governance_evidence_p5_digest_idx/);
  assert.doesNotMatch(correctiveSql.slice(correctiveSql.indexOf("create or replace function admin_governance_approval_sets_p5")), /jsonb_build_object\([\s\S]{0,800}'actorHash'|'actor_hash', grouped/);
});

const fixtureSql = `
create table sources (source_key text primary key, is_active boolean not null default true);
create table ingestion_runs (
  id uuid primary key default gen_random_uuid(), source_key text not null, status text not null default 'completed',
  started_at timestamptz not null default now()
);
create table admin_jobs (id uuid primary key default gen_random_uuid(), status text not null default 'completed');
create table source_url_candidates (
  id uuid primary key default gen_random_uuid(), source_key text not null, url text not null,
  candidate_type text not null, discovered_by text not null, status text not null default 'pending',
  last_attempt_at timestamptz, attempt_count integer not null default 0, last_error_code text,
  last_error_message text, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table articles (
  id uuid primary key default gen_random_uuid(), source_id uuid, source_key text not null default 'test-source',
  jurisdiction text not null default 'Test', institution_name text not null default 'Test Court',
  content_type text not null default 'decision', original_url text not null default 'https://example.test/a',
  canonical_url text not null unique default ('https://example.test/' || gen_random_uuid()::text),
  original_language text not null default 'en', original_title text, korean_title text,
  original_published_at timestamptz, discovered_at timestamptz default now(), fetched_at timestamptz,
  summarized_at timestamptz, status text not null default 'cleaned', slug text not null unique default ('article-' || gen_random_uuid()::text),
  raw_text text, cleaned_text text, summary_json jsonb, search_vector tsvector, embedding double precision[],
  content_hash text, source_metadata jsonb, error_metadata jsonb, review_state text, error_class text,
  error_context jsonb, created_at timestamptz default now(), updated_at timestamptz default now()
);
create table tags (
  id uuid primary key default gen_random_uuid(), slug text unique not null, name text not null,
  normalized_name text not null, type text not null, description text, article_count integer default 0,
  latest_article_at timestamptz, created_at timestamptz default now(), updated_at timestamptz default now()
);
create table article_tags (
  article_id uuid references articles(id), tag_id uuid references tags(id), confidence numeric,
  primary key(article_id, tag_id)
);
create function public.p5_test_array_distance(double precision[], double precision[])
returns double precision language sql immutable as 'select 0::double precision';
create operator public.<=> (
  leftarg = double precision[], rightarg = double precision[], function = public.p5_test_array_distance
);
`;

function migration(name: string) {
  return fs.readFileSync(path.join(process.cwd(), "supabase", "migrations", name), "utf8");
}

async function applyTwice(client: Client, migrationSql: string) {
  await client.query(migrationSql);
  await client.query(migrationSql);
}

async function applyStatementsTwice(client: Client, migrationSql: string, skip?: (statement: string) => boolean) {
  const statements = migrationSql.split(";").map((value) => value.replace(/^\s*--.*$/gm, "").trim()).filter(Boolean);
  for (const statement of statements) {
    if (skip?.(statement)) continue;
    await client.query(statement);
    await client.query(statement);
  }
}

test("P5 PostgreSQL full migration chain, ACL, approvals, and fail-closed governance", { skip: !databaseUrl }, async (t) => {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const database = await client.query<{ current_database: string }>("select current_database()");
    assert.match(database.rows[0].current_database, /(?:^|_)p5(?:_|$)/i, "P5 tests refuse to reset a database whose name does not contain p5");
    await client.query("drop schema public cascade; create schema public");
    await client.query("create extension if not exists pgcrypto");
    await client.query(fixtureSql);

    await applyTwice(client, migration("20260712090000_admin_command_control_plane.sql"));
    await applyTwice(client, migration("20260712130000_admin_command_worker_p1.sql"));
    await applyTwice(client, migration("20260712170000_article_lifecycle_p2.sql"));
    await applyStatementsTwice(client, migration("20260712171000_article_lifecycle_p2_indexes.sql"));
    await applyTwice(client, migration("20260712172000_article_lifecycle_p2_evidence_reconciliation.sql"));
    await applyTwice(client, migration("20260712200000_article_publication_p3.sql").replaceAll("vector(1536)", "double precision[]"));
    await applyStatementsTwice(client, migration("20260712201000_article_publication_p3_indexes.sql"), (statement) => statement.includes("vector_cosine_ops"));
    await applyTwice(client, migration("20260712202000_article_publication_p3_reconciliation.sql"));
    await applyTwice(client, migration("20260712203000_article_publication_p3_authority_correction.sql").replaceAll("vector(1536)", "double precision[]"));
    await applyTwice(client, sql);
    await applyStatementsTwice(client, indexSql);
    await applyTwice(client, correctiveSql);
  } finally {
    await client.end();
  }

  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  try {
    await t.test("concurrent indexes are valid and governance tables enforce RLS", async () => {
      const indexes = await pool.query<{ count: number }>(`select count(*)::integer as count
        from pg_index i join pg_class c on c.oid = i.indexrelid
        where c.relname = any($1) and i.indisvalid and i.indisready`, [p5Indexes]);
      assert.equal(indexes.rows[0].count, p5Indexes.length);
      const rls = await pool.query<{ count: number }>(`select count(*)::integer as count from pg_class
        where relname in ('admin_compatibility_observations_p5','admin_governance_evidence_p5','admin_retention_holds_p5') and relrowsecurity`);
      assert.equal(rls.rows[0].count, 3);
      const publicExecute = await pool.query<{ public_execute: boolean }>(`select coalesce(bool_or(acl.grantee = 0 and acl.privilege_type = 'EXECUTE'), false) as public_execute
        from pg_proc p left join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl on true
        where p.proname in ('admin_record_owner_approval_p5','admin_record_owner_approval_p5_v2')`);
      assert.equal(publicExecute.rows[0].public_execute, false);
    });

    await t.test("digest-scoped approvals require distinct actors and are idempotent", async () => {
      const digest = "d".repeat(64);
      const expiry = new Date(Date.now() + 86_400_000);
      await assert.rejects(pool.query("select admin_record_owner_approval_p5_v2($1,$2,$3,$4,$5)", ["operations", "a".repeat(64), digest, "e".repeat(64), expiry]), /ADMIN_P5_STALE_EVIDENCE_DIGEST/);
      const first = await pool.query<{ id: string }>("select admin_record_owner_approval_p5_v2($1,$2,$3,$4,$5)::text as id", ["operations", "a".repeat(64), digest, digest, expiry]);
      const replay = await pool.query<{ id: string }>("select admin_record_owner_approval_p5_v2($1,$2,$3,$4,$5)::text as id", ["operations", "a".repeat(64), digest, digest, expiry]);
      assert.equal(replay.rows[0].id, first.rows[0].id);
      await assert.rejects(pool.query("select admin_record_owner_approval_p5_v2($1,$2,$3,$4,$5)", ["data", "a".repeat(64), digest, digest, expiry]), /ADMIN_P5_DUPLICATE_ACTOR_ROLE/);
      await assert.rejects(pool.query("select admin_record_owner_approval_p5_v2($1,$2,$3,$4,$5)", ["operations", "b".repeat(64), digest, digest, expiry]), /ADMIN_P5_ROLE_ALREADY_APPROVED/);
      await pool.query("select admin_record_owner_approval_p5_v2($1,$2,$3,$4,$5)", ["data", "b".repeat(64), digest, digest, expiry]);
      await pool.query("select admin_record_owner_approval_p5_v2($1,$2,$3,$4,$5)", ["security", "c".repeat(64), digest, digest, expiry]);
      const sets = await pool.query<{ approval_sets: Array<{ evidenceDigest: string; distinctActorCount: number; roles: string[] }> }>("select admin_governance_approval_sets_p5() as approval_sets");
      const current = sets.rows[0].approval_sets.find((value) => value.evidenceDigest === digest);
      assert.deepEqual(current?.roles, ["data", "operations", "security"]);
      assert.equal(current?.distinctActorCount, 3);
    });

    await t.test("health stays aggregate-only and retention fails closed", async () => {
      await assert.rejects(pool.query("select admin_apply_retention_p5(now() - interval '400 days', now() - interval '200 days', 10, 'wrong')"), /ADMIN_P5_CONFIRMATION_REQUIRED/);
      await pool.query("insert into admin_retention_holds_p5(domain,reason_code,evidence_digest) values ('all','test.legal_hold',$1)", ["f".repeat(64)]);
      await assert.rejects(pool.query("select admin_apply_retention_p5(now() - interval '400 days', now() - interval '200 days', 10, 'APPLY P5 RETENTION')"), /ADMIN_P5_LEGAL_HOLD/);
      const health = await pool.query<{ evidence: Record<string, unknown> }>(`select admin_operational_health_p5(
        now() - interval '1 day', now(), now() - interval '180 days', now() - interval '365 days',
        now() - interval '2555 days', now() - interval '400 days', now() - interval '180 days', now() - interval '730 days'
      ) as evidence`);
      const serialized = JSON.stringify(health.rows[0].evidence);
      assert.equal(health.rows[0].evidence.available, true);
      assert.doesNotMatch(serialized, /original_url|canonical_url|raw_text|cleaned_text|payload_ref|actor_hash|credential|secret/i);
    });
  } finally {
    await pool.end();
  }
});

test("P5 corrective health evidence uses compatibility presence and last-seen", () => {
  assert.match(correctiveSql, /'legacyReadObserved'/);
  assert.match(correctiveSql, /'legacyWriteObserved'/);
  assert.match(correctiveSql, /'unexplainedLegacyObserved'/);
  assert.match(correctiveSql, /'legacyLastSeenAt'/);
  assert.match(correctiveSql, /'newLastSeenAt'/);
});

test("P5 immutable and retention SQL preserves authoritative history", () => {
  assert.match(sql, /admin_governance_evidence_p5_immutable_trigger before update or delete/);
  assert.match(sql, /publication', 'retain_immutable_authority'/);
  assert.match(sql, /lifecycle', 'retain_immutable_archive'/);
  assert.match(sql, /commands', 'archive_partition'/);
  assert.match(sql, /deadLetterOutbox', 'archive_only'/);
  assert.match(sql, /delete from admin_compatibility_observations_p5/);
  assert.match(sql, /delete from article_cache_outbox_p3[\s\S]*status = 'delivered'/);
});
