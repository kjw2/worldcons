-- @d1-verify {"type":"table","name":"e2e_approval_evidence_v1","sqlIncludes":["approval_key text primary key","source_artifact_hash text not null"]}
-- @d1-verify {"type":"table","name":"e2e_verification_jobs_v1","sqlIncludes":["verification_fence integer","applied_fence integer","dead_letter"]}
-- @d1-verify {"type":"table","name":"e2e_verification_evidence_v1","sqlIncludes":["withdrawal_verified","completed_verified","evidence_document text not null"]}
create table if not exists e2e_approval_evidence_v1 (
  approval_key text primary key not null,
  article_id text not null,
  approval_snapshot_hash text not null,
  source_content_hash text not null,
  policy_version text not null,
  evidence_ref text unique not null,
  source_artifact_ref text not null,
  source_artifact_hash text not null,
  discovery_candidate_id text not null,
  pipeline_run_id text not null,
  evidence_document text not null check(json_valid(evidence_document)),
  created_at text not null
);
-- Verification ownership is independent of the Search apply fence/budget.
create table if not exists e2e_verification_jobs_v1 (
  generation_id text primary key not null references e2e_generations_v1(generation_id),
  status text not null default 'pending' check(status in ('pending','leased','retry_wait','verified','dead_letter','superseded','blocked')),
  verification_fence integer not null default 0,
  applied_fence integer,
  attempt_count integer not null default 0,
  max_attempts integer not null default 8,
  next_attempt_at text not null,
  first_failure_at text,
  claimed_by text,
  lease_expires_at text,
  last_error_code text,
  updated_at text not null
);
create table if not exists e2e_verification_evidence_v1 (
  evidence_id text primary key not null,
  generation_id text unique not null references e2e_generations_v1(generation_id),
  result text not null check(result in ('completed_verified','withdrawal_verified')),
  verification_fence integer not null,
  applied_fence integer not null,
  document_fingerprint text not null,
  fts_fingerprint text not null,
  evidence_document text not null check(json_valid(evidence_document)),
  verified_at text not null
);
