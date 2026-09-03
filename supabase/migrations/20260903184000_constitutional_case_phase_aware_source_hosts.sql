begin;

create or replace function source_policy_hosts_valid_v1(
  p_authority_hosts text[],
  p_redirect_hosts text[],
  p_external_index_hosts text[]
)
returns boolean
language sql
immutable
strict
set search_path = public, pg_temp
as $function$
  select
    not exists (
      select 1
      from unnest(p_authority_hosts || p_redirect_hosts || p_external_index_hosts) as host(value)
      where host.value is null
        or host.value <> lower(trim(host.value))
        or host.value !~ '^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$'
        or host.value like '%..%'
        or host.value like '%.%.'
    )
    and not exists (
      select 1
      from unnest(p_external_index_hosts) as external_host(value)
      join unnest(p_authority_hosts || p_redirect_hosts) as official_host(value)
        on external_host.value = official_host.value
    );
$function$;

do $preflight$
begin
  if exists (
    select 1
    from source_corpus_policies p
    where not source_policy_hosts_valid_v1(
      p.authority_hosts,
      p.redirect_hosts,
      p.external_index_hosts
    )
  ) then
    raise exception using
      errcode = '23514',
      message = 'SOURCE_POLICY_HOST_CLASSIFICATION_INVALID';
  end if;
end;
$preflight$;

alter table source_corpus_policies
  drop constraint if exists source_corpus_policies_host_classification_check;
alter table source_corpus_policies
  add constraint source_corpus_policies_host_classification_check check (
    source_policy_hosts_valid_v1(authority_hosts, redirect_hosts, external_index_hosts)
  );

create or replace function source_policy_request_host_allowed_v1(
  p_authority_hosts text[],
  p_redirect_hosts text[],
  p_external_index_hosts text[],
  p_phase text,
  p_request_host text
)
returns boolean
language sql
immutable
strict
set search_path = public, pg_temp
as $function$
  select case
    when p_phase = 'discover' then p_request_host = any (
      p_authority_hosts || p_redirect_hosts || p_external_index_hosts
    )
    when p_phase = 'fetch' then p_request_host = any (
      p_authority_hosts || p_redirect_hosts
    )
    else false
  end;
$function$;

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
  if not source_policy_request_host_allowed_v1(
    v_policy.authority_hosts,
    v_policy.redirect_hosts,
    v_policy.external_index_hosts,
    p_phase,
    v_request_host
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

revoke all on function source_policy_hosts_valid_v1(text[], text[], text[]) from public;
revoke all on function source_policy_request_host_allowed_v1(text[], text[], text[], text, text) from public;
revoke all on function source_backfill_request_permit_acquire_v1(uuid, text, uuid, bigint, text, integer) from public;

do $permissions$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function source_policy_hosts_valid_v1(text[], text[], text[]) from anon;
    revoke all on function source_policy_request_host_allowed_v1(text[], text[], text[], text, text) from anon;
    revoke all on function source_backfill_request_permit_acquire_v1(uuid, text, uuid, bigint, text, integer) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function source_policy_hosts_valid_v1(text[], text[], text[]) from authenticated;
    revoke all on function source_policy_request_host_allowed_v1(text[], text[], text[], text, text) from authenticated;
    revoke all on function source_backfill_request_permit_acquire_v1(uuid, text, uuid, bigint, text, integer) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function source_backfill_request_permit_acquire_v1(uuid, text, uuid, bigint, text, integer) to service_role;
  end if;
end;
$permissions$;

comment on constraint source_corpus_policies_host_classification_check on source_corpus_policies is
  'Requires normalized host names and keeps external discovery indexes disjoint from official authority and redirect hosts.';
comment on function source_backfill_request_permit_acquire_v1(uuid, text, uuid, bigint, text, integer) is
  'Atomically enforces phase-aware source hosts, policy review date, minimum request interval, concurrency, and P1 fencing. External indexes are discover-only.';

commit;
