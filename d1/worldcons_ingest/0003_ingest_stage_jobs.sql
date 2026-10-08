-- WorldCons D1 additive migration: worldcons_ingest 0003
-- Adds the staged ingestion pipeline's durable job tables, the D1 -> Queue
-- dispatch outbox and the ingest -> core bridge outbox. These are D1-native
-- tables (no Postgres origin), so they live only in this additive migration and
-- are never part of the Postgres-derived 0001 baseline. Nothing here drops or
-- rewrites an existing table, index, or row.
--
-- @d1-verify {"type":"table","name":"ingest_stage_jobs","sqlIncludes":["ingest_stage_jobs","idempotency_key text not null","stage text not null"]}
-- @d1-verify {"type":"index","name":"ingest_stage_jobs_idempotency_key_uidx","sqlIncludes":["unique index","ingest_stage_jobs","idempotency_key"]}
-- @d1-verify {"type":"index","name":"ingest_stage_jobs_claim_idx","sqlIncludes":["index","ingest_stage_jobs","stage","status","next_attempt_at"]}
-- @d1-verify {"type":"table","name":"ingest_stage_job_events","sqlIncludes":["ingest_stage_job_events","event_type text not null","job_id text not null"]}
-- @d1-verify {"type":"table","name":"ingest_stage_dispatch_outbox","sqlIncludes":["ingest_stage_dispatch_outbox","message_id text not null","queue_name text not null"]}
-- @d1-verify {"type":"index","name":"ingest_stage_dispatch_outbox_message_id_uidx","sqlIncludes":["unique index","ingest_stage_dispatch_outbox","message_id"]}
-- @d1-verify {"type":"table","name":"ingest_core_bridge_outbox","sqlIncludes":["ingest_core_bridge_outbox","bridge_key text not null","operation text not null"]}
-- @d1-verify {"type":"index","name":"ingest_core_bridge_outbox_bridge_key_uidx","sqlIncludes":["unique index","ingest_core_bridge_outbox","bridge_key"]}

create table if not exists ingest_stage_jobs (
  id text not null,
  idempotency_key text not null,
  stage text not null check (stage in ('discovery', 'crawl', 'normalize', 'translate', 'public-judgment', 'publish', 'search')),
  article_id text not null,
  source_key text,
  source_version text not null,
  content_hash text not null,
  status text not null default 'pending' check (status in ('pending', 'leased', 'succeeded', 'failed', 'dead_letter', 'cancelled')),
  priority integer not null default 0,
  attempt_count integer not null default 0,
  max_attempts integer not null default 8,
  next_attempt_at text,
  claimed_by text,
  claimed_attempt_id text,
  claimed_fencing_token text,
  lease_expires_at text,
  last_error_code text,
  last_error_summary text,
  payload_ref text,
  result_ref text,
  created_at text not null,
  updated_at text not null,
  completed_at text,
  primary key (id)
);
create unique index if not exists ingest_stage_jobs_idempotency_key_uidx
  on ingest_stage_jobs (idempotency_key);
create index if not exists ingest_stage_jobs_claim_idx
  on ingest_stage_jobs (stage, status, next_attempt_at, priority, created_at);
create index if not exists ingest_stage_jobs_lease_idx
  on ingest_stage_jobs (status, lease_expires_at);
create index if not exists ingest_stage_jobs_article_idx
  on ingest_stage_jobs (article_id, stage, created_at);

create table if not exists ingest_stage_job_events (
  id text not null,
  job_id text not null,
  attempt_id text,
  event_type text not null check (event_type in ('job_registered', 'job_leased', 'job_lease_expired', 'job_dispatched', 'job_stage_advanced', 'job_succeeded', 'job_failed', 'job_retry_scheduled', 'job_dead_lettered', 'job_cancelled', 'bridge_enqueued', 'bridge_applied')),
  stage text not null,
  fencing_token text,
  safe_details text not null default '{}',
  occurred_at text not null,
  primary key (id)
);
create index if not exists ingest_stage_job_events_job_idx
  on ingest_stage_job_events (job_id, occurred_at, id);

create table if not exists ingest_stage_dispatch_outbox (
  id text not null,
  job_id text not null,
  idempotency_key text not null,
  stage text not null,
  queue_name text not null,
  message_id text not null,
  payload text not null,
  status text not null default 'pending' check (status in ('pending', 'dispatched', 'failed')),
  attempt_count integer not null default 0,
  next_attempt_at text,
  lease_expires_at text,
  last_error_code text,
  last_error_summary text,
  created_at text not null,
  updated_at text not null,
  dispatched_at text,
  primary key (id)
);
create unique index if not exists ingest_stage_dispatch_outbox_message_id_uidx
  on ingest_stage_dispatch_outbox (message_id);
create index if not exists ingest_stage_dispatch_outbox_pending_idx
  on ingest_stage_dispatch_outbox (status, next_attempt_at, created_at);

create table if not exists ingest_core_bridge_outbox (
  id text not null,
  bridge_key text not null,
  job_id text not null,
  source_key text,
  article_id text not null,
  operation text not null,
  payload text not null default '{}',
  status text not null default 'pending' check (status in ('pending', 'applied', 'failed')),
  attempt_count integer not null default 0,
  next_attempt_at text,
  lease_expires_at text,
  fencing_token text,
  last_error_code text,
  last_error_summary text,
  created_at text not null,
  updated_at text not null,
  applied_at text,
  primary key (id)
);
create unique index if not exists ingest_core_bridge_outbox_bridge_key_uidx
  on ingest_core_bridge_outbox (bridge_key);
create index if not exists ingest_core_bridge_outbox_pending_idx
  on ingest_core_bridge_outbox (status, next_attempt_at, created_at);
