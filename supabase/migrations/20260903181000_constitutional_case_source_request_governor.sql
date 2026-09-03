begin;

create table if not exists source_request_governor_states (
  source_key text primary key,
  last_request_started_at timestamptz,
  next_request_not_before timestamptz not null default '-infinity'::timestamptz,
  updated_at timestamptz not null default now(),
  constraint source_request_governor_states_source_key_check
    check (source_key ~ '^[a-z][a-z0-9._-]{0,79}$')
);

create table if not exists source_request_permits (
  id uuid primary key default gen_random_uuid(),
  source_key text not null,
  source_policy_version text not null,
  snapshot_id uuid not null references source_inventory_snapshots(id) on delete restrict,
  phase text not null,
  p1_attempt_id uuid not null references admin_command_attempts(id) on delete restrict,
  p1_fencing_token bigint not null,
  request_origin text not null,
  acquired_at timestamptz not null default now(),
  lease_expires_at timestamptz not null,
  released_at timestamptz,
  constraint source_request_permits_policy_fkey
    foreign key (source_key, source_policy_version)
    references source_corpus_policies(source_key, policy_version) on delete restrict,
  constraint source_request_permits_phase_check check (phase in ('discover', 'fetch')),
  constraint source_request_permits_origin_check check (
    request_origin ~ '^https://[a-z0-9.-]+(:[0-9]{1,5})?$'
    and length(request_origin) <= 300
  ),
  constraint source_request_permits_lease_check check (lease_expires_at > acquired_at),
  constraint source_request_permits_release_check check (released_at is null or released_at >= acquired_at)
);

create index if not exists source_request_permits_active_idx
  on source_request_permits(source_key, lease_expires_at)
  where released_at is null;
create index if not exists source_request_permits_attempt_idx
  on source_request_permits(p1_attempt_id, acquired_at desc);

create or replace function source_backfill_request_permit_acquire_v1(
  p_snapshot_id uuid,
  p_phase text,
  p_p1_attempt_id uuid,
  p_p1_fencing_token bigint,
  p_request_origin text,
  p_requested_lease_seconds integer default 90
)
returns table(
  granted boolean,
  permit_id uuid,
  retry_after_ms integer,
  permit_lease_expires_at timestamptz
)
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $function$
declare
  v_attempt_lease timestamptz;
  v_snapshot source_inventory_snapshots%rowtype;
  v_policy source_corpus_policies%rowtype;
  v_state source_request_governor_states%rowtype;
  v_request_origin text;
  v_request_host text;
  v_now timestamptz;
  v_not_before timestamptz;
  v_active_count integer;
  v_active_lease_min timestamptz;
  v_active_policy_limit integer;
  v_effective_limit integer;
  v_retry_at timestamptz;
  v_retry_ms integer;
  v_permit_id uuid;
  v_permit_lease timestamptz;
begin
  if p_phase not in ('discover', 'fetch')
    or p_request_origin is null
    or lower(trim(p_request_origin)) !~ '^https://[a-z0-9.-]+(:[0-9]{1,5})?$'
    or length(trim(p_request_origin)) > 300
    or p_requested_lease_seconds not between 5 and 300
  then
    raise exception using errcode = '22023', message = 'CASE_BACKFILL_REQUEST_PERMIT_INVALID';
  end if;

  select a.attempt_lease_expires_at into v_attempt_lease
  from source_backfill_assert_attempt_v1(
    p_p1_attempt_id, p_p1_fencing_token, p_snapshot_id, p_phase
  ) a;

  select s.* into v_snapshot
  from source_inventory_snapshots s
  where s.id = p_snapshot_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'CASE_BACKFILL_SNAPSHOT_NOT_FOUND';
  end if;

  select p.* into v_policy
  from source_corpus_policies p
  where p.source_key = v_snapshot.source_key
    and p.policy_version = v_snapshot.source_policy_version;
  if not found then
    raise exception using errcode = '23503', message = 'CASE_BACKFILL_POLICY_NOT_FOUND';
  end if;
  if v_policy.review_due_at <= clock_timestamp() then
    raise exception using errcode = '55000', message = 'SOURCE_POLICY_REVIEW_OVERDUE';
  end if;

  v_request_origin := lower(trim(p_request_origin));
  v_request_host := split_part(split_part(v_request_origin, '://', 2), ':', 1);
  if not exists (
    select 1
    from unnest(v_policy.authority_hosts || v_policy.redirect_hosts) allowed_host
    where lower(trim(allowed_host)) = v_request_host
  ) then
    raise exception using errcode = '42501', message = 'CASE_BACKFILL_REQUEST_HOST_NOT_ALLOWED';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('source-request:' || v_snapshot.source_key, 0));
  insert into source_request_governor_states(source_key)
  values (v_snapshot.source_key)
  on conflict (source_key) do nothing;
  select s.* into v_state
  from source_request_governor_states s
  where s.source_key = v_snapshot.source_key
  for update;

  v_now := clock_timestamp();
  select count(*)::integer, min(r.lease_expires_at), min(p.max_concurrency)
    into v_active_count, v_active_lease_min, v_active_policy_limit
  from source_request_permits r
  join source_corpus_policies p
    on p.source_key = r.source_key and p.policy_version = r.source_policy_version
  where r.source_key = v_snapshot.source_key
    and r.released_at is null
    and r.lease_expires_at > v_now;

  v_effective_limit := least(v_policy.max_concurrency, coalesce(v_active_policy_limit, v_policy.max_concurrency));
  v_not_before := greatest(
    v_state.next_request_not_before,
    coalesce(v_state.last_request_started_at, '-infinity'::timestamptz)
      + v_policy.min_request_delay_ms * interval '1 millisecond'
  );

  if v_active_count >= v_effective_limit or v_now < v_not_before then
    v_retry_at := case
      when v_active_count >= v_effective_limit and v_now < v_not_before
        then greatest(v_active_lease_min, v_not_before)
      when v_active_count >= v_effective_limit then v_active_lease_min
      else v_not_before
    end;
    v_retry_ms := greatest(
      25,
      least(2147483647, ceil(extract(epoch from (v_retry_at - v_now)) * 1000)::integer)
    );
    return query select false, null::uuid, v_retry_ms, null::timestamptz;
    return;
  end if;

  v_permit_lease := least(
    v_attempt_lease,
    v_now + make_interval(secs => p_requested_lease_seconds)
  );
  if v_permit_lease <= v_now then
    raise exception using errcode = '40001', message = 'CASE_BACKFILL_LEASE_LOST';
  end if;

  insert into source_request_permits(
    source_key, source_policy_version, snapshot_id, phase,
    p1_attempt_id, p1_fencing_token, request_origin, acquired_at, lease_expires_at
  ) values (
    v_snapshot.source_key, v_snapshot.source_policy_version, v_snapshot.id, p_phase,
    p_p1_attempt_id, p_p1_fencing_token, v_request_origin, v_now, v_permit_lease
  ) returning id into v_permit_id;

  update source_request_governor_states s set
    last_request_started_at = v_now,
    next_request_not_before = v_now + v_policy.min_request_delay_ms * interval '1 millisecond',
    updated_at = v_now
  where s.source_key = v_snapshot.source_key;

  return query select true, v_permit_id, 0, v_permit_lease;
end;
$function$;

create or replace function source_backfill_request_permit_release_v1(
  p_permit_id uuid,
  p_p1_attempt_id uuid,
  p_p1_fencing_token bigint
)
returns boolean
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $function$
declare
  v_permit source_request_permits%rowtype;
begin
  select p.* into v_permit
  from source_request_permits p
  where p.id = p_permit_id
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'CASE_BACKFILL_REQUEST_PERMIT_NOT_FOUND';
  end if;
  if v_permit.p1_attempt_id <> p_p1_attempt_id
    or v_permit.p1_fencing_token <> p_p1_fencing_token
  then
    raise exception using errcode = '40001', message = 'CASE_BACKFILL_REQUEST_PERMIT_FENCE_LOST';
  end if;
  if v_permit.released_at is not null then return true; end if;

  perform source_backfill_assert_attempt_v1(
    p_p1_attempt_id, p_p1_fencing_token, v_permit.snapshot_id, v_permit.phase
  );
  update source_request_permits p
  set released_at = clock_timestamp()
  where p.id = v_permit.id and p.released_at is null;
  return true;
end;
$function$;

create or replace function source_backfill_release_request_permits_on_attempt_terminal_v1()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $function$
begin
  if old.status = 'running' and new.status <> 'running' then
    update source_request_permits p
    set released_at = greatest(p.acquired_at, clock_timestamp())
    where p.p1_attempt_id = old.id and p.released_at is null;
  end if;
  return new;
end;
$function$;

drop trigger if exists admin_command_attempts_source_request_permit_release_trigger on admin_command_attempts;
create trigger admin_command_attempts_source_request_permit_release_trigger
after update of status on admin_command_attempts
for each row execute function source_backfill_release_request_permits_on_attempt_terminal_v1();

alter table source_request_governor_states enable row level security;
alter table source_request_permits enable row level security;

revoke all on table source_request_governor_states, source_request_permits from public;
revoke all on function source_backfill_request_permit_acquire_v1(uuid, text, uuid, bigint, text, integer) from public;
revoke all on function source_backfill_request_permit_release_v1(uuid, uuid, bigint) from public;

do $permissions$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on table source_request_governor_states, source_request_permits from anon;
    revoke all on function source_backfill_request_permit_acquire_v1(uuid, text, uuid, bigint, text, integer) from anon;
    revoke all on function source_backfill_request_permit_release_v1(uuid, uuid, bigint) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on table source_request_governor_states, source_request_permits from authenticated;
    revoke all on function source_backfill_request_permit_acquire_v1(uuid, text, uuid, bigint, text, integer) from authenticated;
    revoke all on function source_backfill_request_permit_release_v1(uuid, uuid, bigint) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select on table source_request_governor_states, source_request_permits to service_role;
    grant execute on function source_backfill_request_permit_acquire_v1(uuid, text, uuid, bigint, text, integer) to service_role;
    grant execute on function source_backfill_request_permit_release_v1(uuid, uuid, bigint) to service_role;
  end if;
end;
$permissions$;

comment on table source_request_governor_states is
  'Mutable per-source request clock used to enforce immutable policy delay across distributed workers.';
comment on table source_request_permits is
  'Auditable leased source-network permits bounded by the owning P1 attempt lease.';
comment on function source_backfill_request_permit_acquire_v1(uuid, text, uuid, bigint, text, integer) is
  'Atomically enforces source policy host, review date, minimum request interval, concurrency, and P1 fencing.';

commit;
