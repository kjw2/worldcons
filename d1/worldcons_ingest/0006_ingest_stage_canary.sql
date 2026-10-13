-- WorldCons D1 additive migration: worldcons_ingest 0006
-- Append-only, immutable operator single-case canary audit ledger. Every canary
-- attempt (accepted or denied) is recorded here with non-sensitive metadata so a
-- controlled per-case exception is fully auditable without granting it any
-- publication authority. The `ingest_stage_jobs` row (and its fenced lease
-- ledger) remains the sole source of truth for the job; this table is an audit
-- of what was attempted and by which operator identity.
--
-- D1-native (no Postgres origin), additive only; it never drops or rewrites an
-- existing table, index or row and carries no authority of its own.
--
-- @d1-verify {"type":"table","name":"ingest_stage_canary_records_v1","sqlIncludes":["ingest_stage_canary_records_v1","canary_id text not null","outcome text not null"]}
-- @d1-verify {"type":"index","name":"ingest_stage_canary_records_v1_source_idx","sqlIncludes":["index","ingest_stage_canary_records_v1","source_key","created_at"]}
-- @d1-verify {"type":"index","name":"ingest_stage_canary_records_v1_canary_idx","sqlIncludes":["index","ingest_stage_canary_records_v1","canary_id","created_at"]}

create table if not exists ingest_stage_canary_records_v1 (
  id text not null,
  canary_id text not null,
  source_key text not null,
  candidate_id text not null,
  canonical_url text not null,
  identity_ecli text,
  identity_docket text,
  job_id text,
  outcome text not null check (outcome in (
    'seeded',
    'dispatched',
    'denied_source',
    'denied_official_host',
    'denied_identity',
    'denied_rate_limited',
    'denied_job_conflict'
  )),
  operator_id text not null,
  deployment_ref text,
  detail text,
  created_at text not null,
  primary key (id)
);
create index if not exists ingest_stage_canary_records_v1_source_idx
  on ingest_stage_canary_records_v1 (source_key, created_at, id);
create index if not exists ingest_stage_canary_records_v1_canary_idx
  on ingest_stage_canary_records_v1 (canary_id, created_at, id);
