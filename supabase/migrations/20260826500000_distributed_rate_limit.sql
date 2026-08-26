create table if not exists security_rate_limit_buckets_v1 (
  profile text not null,
  identifier_hash text not null,
  request_count integer not null default 0,
  reset_at timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (profile, identifier_hash),
  constraint security_rate_limit_buckets_v1_profile_check check (length(profile) between 1 and 80),
  constraint security_rate_limit_buckets_v1_identifier_check check (identifier_hash ~ '^[A-Za-z0-9:_-]{8,200}$'),
  constraint security_rate_limit_buckets_v1_count_check check (request_count >= 0)
);

alter table security_rate_limit_buckets_v1 enable row level security;

create index if not exists security_rate_limit_buckets_v1_reset_idx
  on security_rate_limit_buckets_v1 (reset_at);

create or replace function worldcons_consume_rate_limit_v1(
  p_profile text,
  p_identifier_hash text,
  p_limit integer,
  p_window_ms integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_reset_at timestamptz;
  v_count integer;
  v_limited boolean;
  v_remaining integer;
  v_retry_after integer;
begin
  if p_profile is null or length(btrim(p_profile)) not between 1 and 80 then
    raise exception using errcode = '22023', message = 'WORLDCONS_RATE_LIMIT_INVALID_PROFILE';
  end if;
  if p_identifier_hash is null or p_identifier_hash !~ '^[A-Za-z0-9:_-]{8,200}$' then
    raise exception using errcode = '22023', message = 'WORLDCONS_RATE_LIMIT_INVALID_IDENTIFIER';
  end if;
  if p_limit is null or p_limit not between 1 and 100000 then
    raise exception using errcode = '22023', message = 'WORLDCONS_RATE_LIMIT_INVALID_LIMIT';
  end if;
  if p_window_ms is null or p_window_ms not between 1000 and 86400000 then
    raise exception using errcode = '22023', message = 'WORLDCONS_RATE_LIMIT_INVALID_WINDOW';
  end if;

  insert into security_rate_limit_buckets_v1 (
    profile,
    identifier_hash,
    request_count,
    reset_at,
    updated_at
  ) values (
    btrim(p_profile),
    p_identifier_hash,
    1,
    v_now + make_interval(secs => p_window_ms::double precision / 1000.0),
    v_now
  )
  on conflict (profile, identifier_hash) do update
  set
    request_count = case
      when security_rate_limit_buckets_v1.reset_at <= v_now then 1
      else security_rate_limit_buckets_v1.request_count + 1
    end,
    reset_at = case
      when security_rate_limit_buckets_v1.reset_at <= v_now
        then v_now + make_interval(secs => p_window_ms::double precision / 1000.0)
      else security_rate_limit_buckets_v1.reset_at
    end,
    updated_at = v_now
  returning request_count, reset_at
  into v_count, v_reset_at;

  v_limited := v_count > p_limit;
  v_remaining := greatest(0, p_limit - v_count);
  v_retry_after := case
    when v_limited then greatest(1, ceil(extract(epoch from (v_reset_at - v_now)))::integer)
    else 0
  end;

  if random() < 0.01 then
    delete from security_rate_limit_buckets_v1
    where reset_at < v_now - interval '1 day';
  end if;

  return jsonb_build_object(
    'limited', v_limited,
    'limit', p_limit,
    'remaining', v_remaining,
    'resetAt', floor(extract(epoch from v_reset_at) * 1000)::bigint,
    'retryAfterSeconds', v_retry_after
  );
end;
$function$;

comment on function worldcons_consume_rate_limit_v1(text, text, integer, integer) is
  'Atomically consumes one server-side rate-limit bucket shared across stateless application instances.';

revoke all on table security_rate_limit_buckets_v1 from public, anon, authenticated;
revoke all on function worldcons_consume_rate_limit_v1(text, text, integer, integer) from public;

do $permissions$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function worldcons_consume_rate_limit_v1(text, text, integer, integer) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function worldcons_consume_rate_limit_v1(text, text, integer, integer) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function worldcons_consume_rate_limit_v1(text, text, integer, integer) to service_role;
  end if;
end;
$permissions$;

notify pgrst, 'reload schema';
