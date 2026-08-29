begin;

create table if not exists admin_ops_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null check (event_type in (
    'watchdog_ok',
    'watchdog_violation',
    'watchdog_compensation',
    'watchdog_issue_filed',
    'watchdog_issue_updated',
    'watchdog_issue_closed',
    'watchdog_error'
  )),
  severity text not null check (severity in ('info', 'warning', 'critical')),
  source_key text,
  summary text not null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists admin_ops_events_created_at_idx on admin_ops_events (created_at desc);
create index if not exists admin_ops_events_type_idx on admin_ops_events (event_type);
create index if not exists admin_ops_events_severity_idx on admin_ops_events (severity);

alter table admin_ops_events enable row level security;

revoke all on admin_ops_events from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on admin_ops_events from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on admin_ops_events from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, insert, update, delete on admin_ops_events to service_role;
  end if;
end;
$$;

commit;
