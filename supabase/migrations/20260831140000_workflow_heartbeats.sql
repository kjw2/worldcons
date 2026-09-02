begin;

create table if not exists ops_workflow_heartbeats (
  workflow_key text primary key,
  last_started_at timestamptz not null,
  last_completed_at timestamptz,
  last_status text not null,
  run_id text,
  detail jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  constraint ops_workflow_heartbeats_key_check check (workflow_key ~ '^[a-z][a-z0-9._-]{0,79}$'),
  constraint ops_workflow_heartbeats_status_check check (last_status in ('running', 'success', 'failed', 'deferred')),
  constraint ops_workflow_heartbeats_run_id_check check (run_id is null or length(run_id) <= 160),
  constraint ops_workflow_heartbeats_detail_check check (pg_column_size(detail) <= 8192)
);

alter table ops_workflow_heartbeats enable row level security;

create or replace function ops_workflow_heartbeat_v1(
  p_workflow_key text,
  p_status text,
  p_run_id text default null,
  p_detail jsonb default '{}'::jsonb,
  p_observed_at timestamptz default now()
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
begin
  if p_workflow_key is null
    or p_workflow_key !~ '^[a-z][a-z0-9._-]{0,79}$'
    or p_status not in ('running', 'success', 'failed', 'deferred')
    or (p_run_id is not null and length(p_run_id) > 160)
    or p_observed_at is null
    or pg_column_size(coalesce(p_detail, '{}'::jsonb)) > 8192
  then
    raise exception using errcode = '22023', message = 'OPS_WORKFLOW_HEARTBEAT_INVALID_INPUT';
  end if;

  insert into ops_workflow_heartbeats(
    workflow_key, last_started_at, last_completed_at, last_status, run_id, detail, updated_at
  ) values (
    p_workflow_key,
    p_observed_at,
    case when p_status = 'running' then null else p_observed_at end,
    p_status,
    nullif(trim(p_run_id), ''),
    coalesce(p_detail, '{}'::jsonb),
    p_observed_at
  )
  on conflict (workflow_key) do update set
    last_started_at = case
      when excluded.last_status = 'running' then excluded.last_started_at
      else ops_workflow_heartbeats.last_started_at
    end,
    last_completed_at = case
      when excluded.last_status = 'running' then ops_workflow_heartbeats.last_completed_at
      else excluded.last_completed_at
    end,
    last_status = excluded.last_status,
    run_id = excluded.run_id,
    detail = excluded.detail,
    updated_at = excluded.updated_at;

  return true;
end;
$function$;

comment on table ops_workflow_heartbeats is
  'Last observed execution state for scheduled collection, summary, embedding, and watchdog workflows.';

revoke all on table ops_workflow_heartbeats from public;
revoke all on function ops_workflow_heartbeat_v1(text, text, text, jsonb, timestamptz) from public;

do $permissions$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on table ops_workflow_heartbeats from anon;
    revoke all on function ops_workflow_heartbeat_v1(text, text, text, jsonb, timestamptz) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on table ops_workflow_heartbeats from authenticated;
    revoke all on function ops_workflow_heartbeat_v1(text, text, text, jsonb, timestamptz) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on table ops_workflow_heartbeats from service_role;
    grant select on table ops_workflow_heartbeats to service_role;
    grant execute on function ops_workflow_heartbeat_v1(text, text, text, jsonb, timestamptz) to service_role;
  end if;
end;
$permissions$;

commit;
