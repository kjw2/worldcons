create table if not exists source_url_candidates (
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
  updated_at timestamptz not null default now(),
  unique(source_key, url),
  constraint source_url_candidates_status_check check (
    status in ('pending', 'retrying', 'fetched', 'failed', 'ignored')
  )
);

create index if not exists source_url_candidates_source_status_idx on source_url_candidates (source_key, status, created_at desc);

drop trigger if exists source_url_candidates_updated_at_trigger on source_url_candidates;
create trigger source_url_candidates_updated_at_trigger
before update on source_url_candidates
for each row execute function set_updated_at();
