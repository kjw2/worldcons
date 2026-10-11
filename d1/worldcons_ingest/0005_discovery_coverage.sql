-- Discovery snapshot and reservation journal: additive, no existing rows changed.
-- @d1-verify {"type":"table","name":"ingest_discovery_scans_v1","sqlIncludes":["manifest_hash text not null","reservation_fence integer","capturing"]}
-- @d1-verify {"type":"table","name":"ingest_discovery_items_v1","sqlIncludes":["candidate_id text not null","covered_existing","crawl_job_id"]}
-- @d1-verify {"type":"table","name":"ingest_discovery_commit_guards_v1","sqlIncludes":["check(assertion=1)"]}
create table if not exists ingest_discovery_scans_v1 (
  job_id text primary key not null references ingest_stage_jobs(id),
  source_key text not null,
  manifest_ref text not null,
  manifest_hash text not null,
  observed_count integer not null check(observed_count>=0),
  status text not null check(status in ('capturing','pending','leased','reserved')),
  reservation_fence integer not null default 0,
  reservation_owner text,
  lease_expires_at text,
  captured_at text not null,
  updated_at text not null
);
create index if not exists ingest_discovery_scans_due_v1 on ingest_discovery_scans_v1(status,captured_at);
create table if not exists ingest_discovery_items_v1 (
  job_id text not null references ingest_discovery_scans_v1(job_id),
  candidate_id text not null,
  snapshot_hash text not null,
  canonical_url text not null,
  artifact_ref text not null,
  source_version text not null,
  priority integer not null,
  status text not null check(status in ('pending','covered_existing','reserved')),
  existing_article_id text,
  crawl_job_id text references ingest_stage_jobs(id),
  updated_at text not null,
  primary key(job_id,candidate_id),
  check((status='covered_existing' and existing_article_id is not null) or status<>'covered_existing'),
  check((status='reserved' and crawl_job_id is not null) or status<>'reserved')
);
create index if not exists ingest_discovery_items_due_v1 on ingest_discovery_items_v1(job_id,status,priority,candidate_id);
create table if not exists ingest_discovery_commit_guards_v1 (
  token text primary key not null,
  assertion integer not null check(assertion=1)
);
