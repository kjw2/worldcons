begin;

create table if not exists masterdash_sso_jtis (
  jti_hash text primary key,
  system_id text not null check (system_id = 'worldcons'),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists masterdash_sso_jtis_expires_at_idx on masterdash_sso_jtis (expires_at);

create table if not exists masterdash_control_requests (
  request_id uuid primary key,
  system_id text not null check (system_id = 'worldcons'),
  action text not null check (action in ('incremental_collect', 'pause_collection', 'resume_collection')),
  requested_at timestamptz not null,
  body_sha256 text not null,
  status text not null check (status in ('processing', 'succeeded', 'failed')),
  response_status integer,
  response_message text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists masterdash_control_requests_created_at_idx on masterdash_control_requests (created_at desc);

create table if not exists masterdash_collection_control (
  system_id text primary key check (system_id = 'worldcons'),
  paused boolean not null default false,
  updated_at timestamptz not null default now(),
  last_request_id uuid references masterdash_control_requests(request_id) on delete set null
);

insert into masterdash_collection_control (system_id, paused)
values ('worldcons', false)
on conflict (system_id) do nothing;

alter table masterdash_sso_jtis enable row level security;
alter table masterdash_control_requests enable row level security;
alter table masterdash_collection_control enable row level security;

revoke all on masterdash_sso_jtis, masterdash_control_requests, masterdash_collection_control from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on masterdash_sso_jtis, masterdash_control_requests, masterdash_collection_control from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on masterdash_sso_jtis, masterdash_control_requests, masterdash_collection_control from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, insert, update, delete on masterdash_sso_jtis, masterdash_control_requests, masterdash_collection_control to service_role;
  end if;
end;
$$;

commit;
