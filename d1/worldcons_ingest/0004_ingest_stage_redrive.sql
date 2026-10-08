-- WorldCons D1 additive migration: worldcons_ingest 0004
-- Adds the operator dead-letter redrive transition ledger for the staged
-- ingestion pipeline. The `ingest_stage_jobs` table's `ingest_stage_job_events`
-- CHECK constraint already enumerates every legal job event, and SQLite cannot
-- widen a CHECK additively, so an operator redrive transition (a state change
-- from `dead_letter` back to `pending` plus every denied attempt) is recorded in
-- its own append-only ledger table instead of mutating the existing event enum.
--
-- This table is D1-native (no Postgres origin), additive only, and never drops or
-- rewrites an existing table, index or row. It carries no authority of its own:
-- the redrive decision is always arbitrated by the conditional UPDATE on
-- `ingest_stage_jobs`; this ledger is the audit of what was attempted.
--
-- @d1-verify {"type":"table","name":"ingest_stage_redrive_records","sqlIncludes":["ingest_stage_redrive_records","job_id text not null","outcome text not null"]}
-- @d1-verify {"type":"index","name":"ingest_stage_redrive_records_stage_idx","sqlIncludes":["index","ingest_stage_redrive_records","stage","created_at"]}
-- @d1-verify {"type":"index","name":"ingest_stage_redrive_records_operator_idx","sqlIncludes":["index","ingest_stage_redrive_records","operator_id","created_at"]}

create table if not exists ingest_stage_redrive_records (
  id text not null,
  job_id text not null,
  stage text not null check (stage in ('discovery', 'crawl', 'normalize', 'translate', 'public-judgment', 'publish', 'search')),
  idempotency_key text,
  operator_id text not null,
  reason text,
  outcome text not null check (outcome in (
    'redriven',
    'denied_not_found',
    'denied_stage_mismatch',
    'denied_nonterminal',
    'denied_fencing_mismatch',
    'denied_missing_reason',
    'denied_rate_limited'
  )),
  previous_status text,
  previous_attempt_count integer,
  previous_fencing_token text,
  previous_error_code text,
  created_at text not null,
  primary key (id)
);
create index if not exists ingest_stage_redrive_records_stage_idx
  on ingest_stage_redrive_records (stage, created_at, id);
create index if not exists ingest_stage_redrive_records_operator_idx
  on ingest_stage_redrive_records (operator_id, created_at, id);
create index if not exists ingest_stage_redrive_records_job_idx
  on ingest_stage_redrive_records (job_id, created_at, id);
