create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create table if not exists admin_jobs (
  id uuid primary key default gen_random_uuid(),
  job_type text not null,
  status text not null default 'queued',
  priority integer not null default 0,
  source_key text,
  article_id uuid,
  article_slug text,
  idempotency_key text not null unique,
  requested_by text,
  requested_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  lease_until timestamptz,
  worker_id text,
  progress_current integer not null default 0,
  progress_total integer,
  result_summary jsonb not null default '{}'::jsonb,
  error_class text,
  error_message text,
  cancel_requested_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text,
  parent_job_id uuid references admin_jobs(id) on delete set null,
  options jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists admin_job_events (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references admin_jobs(id) on delete cascade,
  occurred_at timestamptz not null default now(),
  event_type text not null,
  message text,
  error_class text,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists admin_jobs_status_priority_requested_at_idx
  on admin_jobs (status, priority desc, requested_at);

create index if not exists admin_jobs_source_key_status_idx
  on admin_jobs (source_key, status);

create index if not exists admin_jobs_idempotency_key_idx
  on admin_jobs (idempotency_key);

create index if not exists admin_jobs_lease_until_idx
  on admin_jobs (lease_until);

create index if not exists admin_job_events_job_id_occurred_at_idx
  on admin_job_events (job_id, occurred_at desc);

drop trigger if exists admin_jobs_updated_at_trigger on admin_jobs;
create trigger admin_jobs_updated_at_trigger
before update on admin_jobs
for each row execute function set_updated_at();

create or replace function claim_admin_job(worker_id text, job_types text[], lease_seconds integer default 60)
returns setof admin_jobs
language plpgsql
as $$
<<fn>>
begin
  return query
  with candidate as (
    select j.id
    from admin_jobs j
    where (
        fn.job_types is null
        or cardinality(fn.job_types) = 0
        or j.job_type = any(fn.job_types)
      )
      and (
        j.status = 'queued'
        or (j.status = 'running' and j.lease_until < now())
      )
    order by
      case when j.status = 'running' then 0 else 1 end,
      j.priority desc,
      j.requested_at asc
    for update skip locked
    limit 1
  )
  update admin_jobs j
  set
    status = 'running',
    started_at = coalesce(j.started_at, now()),
    lease_until = now() + make_interval(secs => greatest(coalesce(fn.lease_seconds, 60), 1)),
    worker_id = fn.worker_id,
    updated_at = now()
  from candidate
  where j.id = candidate.id
  returning j.*;
end;
$$;

create or replace function append_admin_job_event(
  job_id uuid,
  event_type text,
  message text default null,
  error_class text default null,
  metadata jsonb default '{}'::jsonb
)
returns admin_job_events
language plpgsql
as $$
<<fn>>
declare
  inserted admin_job_events;
begin
  insert into admin_job_events (job_id, event_type, message, error_class, metadata)
  values (fn.job_id, fn.event_type, fn.message, fn.error_class, coalesce(fn.metadata, '{}'::jsonb))
  returning * into inserted;

  return inserted;
end;
$$;
