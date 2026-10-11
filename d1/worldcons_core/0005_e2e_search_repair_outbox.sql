-- E2E-P0/M2: Search intent lives in the SAME Core transaction as P3/generation.
-- Transport acknowledgement is not Consumer success or completed_verified.
-- @d1-verify {"type":"table","name":"e2e_search_repair_outbox_v1","sqlIncludes":["unique (article_id,generation_id,operation)","dispatch_fence integer","fencing_token integer"]}
-- @d1-verify {"type":"index","name":"e2e_search_repair_dispatch_idx","sqlIncludes":["next_dispatch_at","status"]}
create table if not exists e2e_search_repair_outbox_v1 (
  outbox_id text primary key not null,
  article_id text not null,
  generation_id text not null,
  generation_seq integer not null check (generation_seq>0),
  operation text not null check (operation in ('project','remove')),
  expected_version_id text not null,
  expected_version_revision integer not null,
  expected_publication_id text not null,
  expected_publication_revision integer not null,
  expected_publication_state text not null,
  policy_version text not null,
  projection_input_hash text not null,
  payload_evidence_ref text not null,
  status text not null default 'pending' check (status in ('pending','leased','retry_wait','verified','superseded','dead_letter')),
  attempt_count integer not null default 0 check (attempt_count>=0),
  max_attempts integer not null default 8,
  next_attempt_at text not null,
  first_failure_at text,
  claimed_by text,
  lease_expires_at text,
  fencing_token integer not null default 0,
  -- Dispatch has its own lease/fence and budget. Duplicate Queue delivery must
  -- not consume the processing attempt budget owned by the M3 Consumer.
  dispatch_owner text,
  dispatch_token text,
  dispatch_lease_expires_at text,
  dispatch_fence integer not null default 0,
  dispatch_count integer not null default 0,
  dispatch_failure_count integer not null default 0,
  first_dispatch_failure_at text,
  next_dispatch_at text not null,
  dispatched_at text,
  last_dispatch_error_code text,
  last_error_code text,
  verified_at text,
  evidence_ref text,
  created_at text not null,
  updated_at text not null,
  unique (article_id,generation_id,operation),
  foreign key (article_id,generation_id) references e2e_generations_v1(article_id,generation_id),
  check (status<>'verified' or (verified_at is not null and evidence_ref is not null))
);
create index if not exists e2e_search_repair_dispatch_idx
  on e2e_search_repair_outbox_v1 (status,next_dispatch_at,created_at,outbox_id);
