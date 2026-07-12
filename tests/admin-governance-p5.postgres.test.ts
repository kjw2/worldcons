import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const sql = fs.readFileSync(path.join(process.cwd(), "supabase/migrations/20260712230000_admin_governance_p5.sql"), "utf8");
const correctiveSql = fs.readFileSync(path.join(process.cwd(), "supabase/migrations/20260712233000_admin_governance_p5_acceptance_corrections.sql"), "utf8");

test("P5 migration is additive, aggregate-only, secure, indexed, and rerunnable", () => {
  assert.match(sql, /create table if not exists admin_compatibility_observations_p5/);
  assert.match(sql, /create or replace view admin_operational_health_core_p5[\s\S]*security_barrier = true/);
  assert.match(sql, /create or replace function admin_operational_health_p5/);
  assert.match(sql, /create or replace function admin_record_backup_restore_evidence_p5[\s\S]*ADMIN_P5_INVALID_BACKUP_EVIDENCE/);
  assert.match(sql, /security definer[\s\S]*set search_path = public, pg_temp/g);
  assert.match(sql, /enable row level security/g);
  assert.match(sql, /revoke all on table admin_compatibility_observations_p5/);
  assert.match(sql, /grant execute on function admin_operational_health_p5[\s\S]*to service_role/);
  for (const index of ["admin_compat_obs_p5_window_idx", "ingestion_runs_source_started_p5_idx", "admin_command_runs_abort_p5_idx", "articles_lifecycle_review_age_p5_idx", "article_cache_outbox_delivered_p5_idx"]) {
    assert.match(sql, new RegExp(`create index if not exists ${index}`));
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
  assert.match(correctiveSql, /create index if not exists admin_governance_evidence_p5_digest_idx/);
  assert.doesNotMatch(correctiveSql.slice(correctiveSql.indexOf("create or replace function admin_governance_approval_sets_p5")), /jsonb_build_object\([\s\S]{0,800}'actorHash'|'actor_hash', grouped/);
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
