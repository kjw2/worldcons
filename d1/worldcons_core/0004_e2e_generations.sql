-- E2E-P0/M1: additive Core-only identity ledger. Existing P3 hashes are unchanged.
-- No Search consumer, completion validator or production cohort activation in M1.
-- @d1-verify {"type":"table","name":"e2e_generations_v1","sqlIncludes":["generation_seq integer not null","approval_snapshot_hash text not null"]}
-- @d1-verify {"type":"table","name":"e2e_generation_heads_v1","sqlIncludes":["generation_id text not null"]}
-- @d1-verify {"type":"table","name":"e2e_generation_progress_v1","sqlIncludes":["publication_committed","completed_verified"]}
-- @d1-verify {"type":"table","name":"e2e_generation_requests_v1","sqlIncludes":["idempotency_key text not null"]}
-- @d1-verify {"type":"table","name":"e2e_commit_guards_v1","sqlIncludes":["e2e_commit_snapshot_match"]}

create table if not exists e2e_generations_v1 (
  generation_id text primary key not null,
  article_id text not null,
  generation_seq integer not null check (typeof(generation_seq)='integer' and generation_seq>0),
  source_key text not null,
  source_content_hash text not null,
  approval_key text not null,
  approval_snapshot_hash text not null,
  approval_hash_schema text not null,
  projection_input_hash text not null,
  projection_input_schema text not null,
  expected_version_id text not null,
  expected_version_revision integer not null,
  expected_publication_id text not null,
  expected_publication_revision integer not null,
  expected_publication_state text not null check (expected_publication_state in ('draft','in_review','published','withdrawn')),
  approval_mode text not null check (approval_mode in ('human','automatic')),
  policy_version text not null,
  approval_evidence_ref text not null,
  source_evidence_ref text not null,
  pipeline_run_id text,
  discovery_candidate_id text,
  created_at text not null,
  unique (article_id,generation_seq),
  unique (article_id,generation_id)
);
create table if not exists e2e_generation_heads_v1 (
  article_id text primary key not null,
  generation_id text not null,
  generation_seq integer not null,
  updated_at text not null,
  foreign key (article_id,generation_id) references e2e_generations_v1(article_id,generation_id)
);
-- Mutable processing state is separate from immutable identity/evidence history.
create table if not exists e2e_generation_progress_v1 (
  generation_id text primary key not null references e2e_generations_v1(generation_id),
  state text not null check (state in ('processing','publication_committed','search_pending','retry_wait','review_required','blocked','completed_verified','dead_letter','superseded')),
  last_error_code text,
  expected_search_fingerprint text,
  expected_fts_fingerprint text,
  verified_at text,
  verification_evidence_ref text,
  updated_at text not null,
  check (state<>'completed_verified' or (verified_at is not null and verification_evidence_ref is not null))
);
create table if not exists e2e_generation_requests_v1 (
  article_id text not null,
  idempotency_key text not null,
  generation_id text not null references e2e_generations_v1(generation_id),
  context_hash text not null,
  context_document text not null,
  generation_created integer not null check (generation_created in (0,1)),
  primary key (article_id,idempotency_key)
);
-- A zero-row UPDATE does not abort a D1 batch. A violated CHECK does.
-- Insert the observed snapshot assertion FIRST; delete it LAST in the same batch.
create table if not exists e2e_commit_guards_v1 (
  token text primary key not null,
  assertion integer not null constraint e2e_commit_snapshot_match check (assertion=1)
);
