-- P0 administrator command control plane. This migration is additive: the
-- existing admin_jobs queue remains the execution authority until a later gate.

create sequence if not exists admin_command_fencing_token_seq as bigint;

create table if not exists admin_commands (
  id uuid primary key default gen_random_uuid(),
  command_type text not null,
  payload_ref jsonb not null default '{}'::jsonb,
  idempotency_key text not null,
  requested_by text,
  priority integer not null default 0,
  created_at timestamptz not null default now(),
  constraint admin_commands_command_type_check check (command_type ~ '^[a-z][a-z0-9._-]{0,119}$'),
  constraint admin_commands_idempotency_key_check check (length(idempotency_key) between 1 and 240),
  constraint admin_commands_requested_by_check check (requested_by is null or length(requested_by) <= 160),
  constraint admin_commands_payload_ref_object_check check (jsonb_typeof(payload_ref) = 'object'),
  constraint admin_commands_payload_ref_size_check check (octet_length(payload_ref::text) <= 16384),
  constraint admin_commands_command_type_idempotency_key_key unique (command_type, idempotency_key)
);

create table if not exists admin_command_runs (
  id uuid primary key default gen_random_uuid(),
  command_id uuid not null references admin_commands(id) on delete restrict,
  run_number integer not null,
  status text not null default 'queued',
  dedupe_key text not null,
  priority integer not null default 0,
  available_at timestamptz not null default now(),
  max_attempts integer not null default 3,
  retry_backoff_base_seconds integer not null default 15,
  retry_backoff_cap_seconds integer not null default 900,
  retry_count integer not null default 0,
  current_attempt_id uuid,
  abort_requested_at timestamptz,
  abort_requested_by text,
  abort_reason text,
  started_at timestamptz,
  finished_at timestamptz,
  terminal_error_code text,
  terminal_error_message text,
  result_summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint admin_command_runs_command_run_key unique (command_id, run_number),
  constraint admin_command_runs_status_check check (status in ('queued', 'running', 'retry_wait', 'succeeded', 'failed', 'aborted', 'shadowed')),
  constraint admin_command_runs_dedupe_key_check check (length(dedupe_key) between 1 and 240),
  constraint admin_command_runs_max_attempts_check check (max_attempts between 1 and 100),
  constraint admin_command_runs_retry_count_check check (retry_count >= 0),
  constraint admin_command_runs_backoff_check check (
    retry_backoff_base_seconds between 1 and 86400
    and retry_backoff_cap_seconds between retry_backoff_base_seconds and 604800
  ),
  constraint admin_command_runs_abort_requested_by_check check (abort_requested_by is null or length(abort_requested_by) <= 160),
  constraint admin_command_runs_abort_reason_check check (abort_reason is null or length(abort_reason) <= 500),
  constraint admin_command_runs_terminal_error_code_check check (terminal_error_code is null or length(terminal_error_code) <= 160),
  constraint admin_command_runs_terminal_error_message_check check (terminal_error_message is null or length(terminal_error_message) <= 500),
  constraint admin_command_runs_result_summary_object_check check (jsonb_typeof(result_summary) = 'object'),
  constraint admin_command_runs_result_summary_size_check check (octet_length(result_summary::text) <= 16384),
  constraint admin_command_runs_terminal_shape_check check (
    (status in ('succeeded', 'failed', 'aborted', 'shadowed') and finished_at is not null)
    or (status in ('queued', 'running', 'retry_wait') and finished_at is null)
  )
);

create table if not exists admin_command_attempts (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references admin_command_runs(id) on delete restrict,
  attempt_number integer not null,
  status text not null,
  worker_id text not null,
  fencing_token bigint not null default nextval('admin_command_fencing_token_seq'),
  lease_expires_at timestamptz not null,
  heartbeat_at timestamptz not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  failure_disposition text,
  error_code text,
  error_message text,
  result_summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint admin_command_attempts_run_attempt_key unique (run_id, attempt_number),
  constraint admin_command_attempts_fencing_token_key unique (fencing_token),
  constraint admin_command_attempts_attempt_number_check check (attempt_number > 0),
  constraint admin_command_attempts_status_check check (status in ('running', 'succeeded', 'failed', 'aborted', 'lease_expired')),
  constraint admin_command_attempts_worker_id_check check (length(worker_id) between 1 and 160),
  constraint admin_command_attempts_failure_disposition_check check (failure_disposition is null or failure_disposition in ('retryable', 'terminal', 'aborted', 'lease_expired')),
  constraint admin_command_attempts_error_code_check check (error_code is null or length(error_code) <= 160),
  constraint admin_command_attempts_error_message_check check (error_message is null or length(error_message) <= 500),
  constraint admin_command_attempts_result_summary_object_check check (jsonb_typeof(result_summary) = 'object'),
  constraint admin_command_attempts_result_summary_size_check check (octet_length(result_summary::text) <= 16384),
  constraint admin_command_attempts_terminal_shape_check check (
    (status = 'running' and finished_at is null)
    or (status in ('succeeded', 'failed', 'aborted', 'lease_expired') and finished_at is not null)
  )
);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'admin_command_runs_current_attempt_id_fkey'
  ) then
    alter table admin_command_runs
      add constraint admin_command_runs_current_attempt_id_fkey
      foreign key (current_attempt_id) references admin_command_attempts(id) on delete restrict;
  end if;
end;
$$;

create table if not exists admin_command_events (
  id bigint generated by default as identity primary key,
  command_id uuid not null references admin_commands(id) on delete restrict,
  run_id uuid references admin_command_runs(id) on delete restrict,
  attempt_id uuid references admin_command_attempts(id) on delete restrict,
  event_type text not null,
  actor_type text not null,
  actor_id text,
  safe_details jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  constraint admin_command_events_event_type_check check (event_type in (
    'command_accepted', 'command_deduplicated', 'run_queued', 'compatibility_shadowed',
    'attempt_claimed', 'lease_reclaimed', 'heartbeat', 'attempt_succeeded',
    'retry_scheduled', 'run_failed', 'abort_requested', 'run_aborted', 'manual_retry_queued'
  )),
  constraint admin_command_events_actor_type_check check (actor_type in ('admin', 'cron', 'worker', 'system', 'compatibility')),
  constraint admin_command_events_actor_id_check check (actor_id is null or length(actor_id) <= 160),
  constraint admin_command_events_safe_details_object_check check (jsonb_typeof(safe_details) = 'object'),
  constraint admin_command_events_safe_details_size_check check (octet_length(safe_details::text) <= 8192)
);

create unique index if not exists admin_command_runs_active_dedupe_key_uidx
  on admin_command_runs (dedupe_key)
  where status in ('queued', 'running', 'retry_wait');

create index if not exists admin_command_runs_claim_idx
  on admin_command_runs (status, available_at, priority desc, created_at)
  where status in ('queued', 'running', 'retry_wait');

create index if not exists admin_command_attempts_active_lease_idx
  on admin_command_attempts (lease_expires_at, run_id)
  where status = 'running';

create index if not exists admin_command_attempts_run_created_idx
  on admin_command_attempts (run_id, attempt_number desc);

create index if not exists admin_command_events_command_occurred_idx
  on admin_command_events (command_id, occurred_at, id);

create index if not exists admin_command_events_run_occurred_idx
  on admin_command_events (run_id, occurred_at, id);

create or replace function admin_queue_json_is_safe(p_value jsonb, p_max_bytes integer)
returns boolean
language plpgsql
immutable
as $$
declare
  v_key text;
  v_child jsonb;
begin
  if p_value is null or octet_length(p_value::text) > p_max_bytes then return false; end if;

  if jsonb_typeof(p_value) = 'object' then
    for v_key, v_child in select key, value from jsonb_each(p_value) loop
      if v_key ~* '(api[_-]?key|secret|token|password|authorization|cookie|csrf|bearer|session|x[_-]?cron[_-]?secret)' then
        return false;
      end if;
      if not admin_queue_json_is_safe(v_child, p_max_bytes) then return false; end if;
    end loop;
  elsif jsonb_typeof(p_value) = 'array' then
    for v_child in select value from jsonb_array_elements(p_value) loop
      if not admin_queue_json_is_safe(v_child, p_max_bytes) then return false; end if;
    end loop;
  end if;

  return true;
end;
$$;

create or replace function admin_queue_prevent_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception using errcode = 'P0001', message = 'ADMIN_QUEUE_IMMUTABLE_RECORD';
end;
$$;

drop trigger if exists admin_commands_immutable_trigger on admin_commands;
create trigger admin_commands_immutable_trigger
before update or delete on admin_commands
for each row execute function admin_queue_prevent_mutation();

drop trigger if exists admin_command_events_immutable_trigger on admin_command_events;
create trigger admin_command_events_immutable_trigger
before update or delete on admin_command_events
for each row execute function admin_queue_prevent_mutation();

create or replace function admin_submit_command_v3(
  p_command_type text,
  p_payload_ref jsonb,
  p_idempotency_key text,
  p_dedupe_key text,
  p_requested_by text default null,
  p_priority integer default 0,
  p_max_attempts integer default 3,
  p_retry_backoff_base_seconds integer default 15,
  p_retry_backoff_cap_seconds integer default 900,
  p_shadow_only boolean default false
)
returns table(command_id uuid, run_id uuid, run_status text, created boolean, deduplicated boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_command admin_commands%rowtype;
  v_run admin_command_runs%rowtype;
begin
  if p_command_type is null or p_command_type !~ '^[a-z][a-z0-9._-]{0,119}$' then
    raise exception using errcode = '22023', message = 'ADMIN_QUEUE_INVALID_COMMAND_TYPE';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 240 then
    raise exception using errcode = '22023', message = 'ADMIN_QUEUE_INVALID_IDEMPOTENCY_KEY';
  end if;
  if p_dedupe_key is null or length(p_dedupe_key) not between 1 and 240 then
    raise exception using errcode = '22023', message = 'ADMIN_QUEUE_INVALID_DEDUPE_KEY';
  end if;
  if jsonb_typeof(coalesce(p_payload_ref, '{}'::jsonb)) <> 'object'
     or not admin_queue_json_is_safe(coalesce(p_payload_ref, '{}'::jsonb), 16384) then
    raise exception using errcode = '22023', message = 'ADMIN_QUEUE_UNSAFE_PAYLOAD_REF';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('admin-command:' || p_command_type || ':' || p_idempotency_key, 0));
  perform pg_advisory_xact_lock(hashtextextended('admin-dedupe:' || p_dedupe_key, 0));

  select c.* into v_command
  from admin_commands c
  where c.command_type = p_command_type and c.idempotency_key = p_idempotency_key;

  if found then
    select r.* into v_run
    from admin_command_runs r
    where r.command_id = v_command.id
    order by r.run_number desc
    limit 1;

    insert into admin_command_events (command_id, run_id, event_type, actor_type, actor_id, safe_details)
    values (v_command.id, v_run.id, 'command_deduplicated', 'system', p_requested_by, jsonb_build_object('reason', 'idempotency'));
    return query select v_command.id, v_run.id, v_run.status, false, true;
    return;
  end if;

  if not p_shadow_only then
    select r.* into v_run
    from admin_command_runs r
    where r.dedupe_key = p_dedupe_key
      and r.status in ('queued', 'running', 'retry_wait')
    limit 1;

    if found then
      select c.* into v_command from admin_commands c where c.id = v_run.command_id;
      insert into admin_command_events (command_id, run_id, event_type, actor_type, actor_id, safe_details)
      values (v_command.id, v_run.id, 'command_deduplicated', 'system', p_requested_by, jsonb_build_object('reason', 'active_dedupe'));
      return query select v_command.id, v_run.id, v_run.status, false, true;
      return;
    end if;
  end if;

  insert into admin_commands (command_type, payload_ref, idempotency_key, requested_by, priority)
  values (
    p_command_type,
    coalesce(p_payload_ref, '{}'::jsonb),
    p_idempotency_key,
    left(nullif(trim(p_requested_by), ''), 160),
    p_priority
  )
  returning * into v_command;

  insert into admin_command_runs (
    command_id, run_number, status, dedupe_key, priority, available_at, max_attempts,
    retry_backoff_base_seconds, retry_backoff_cap_seconds, finished_at
  ) values (
    v_command.id, 1, case when p_shadow_only then 'shadowed' else 'queued' end,
    p_dedupe_key, p_priority, now(), greatest(1, least(p_max_attempts, 100)),
    greatest(1, least(p_retry_backoff_base_seconds, 86400)),
    greatest(
      greatest(1, least(p_retry_backoff_base_seconds, 86400)),
      least(p_retry_backoff_cap_seconds, 604800)
    ),
    case when p_shadow_only then now() else null end
  )
  returning * into v_run;

  insert into admin_command_events (command_id, run_id, event_type, actor_type, actor_id, safe_details)
  values (v_command.id, v_run.id, 'command_accepted', case when p_shadow_only then 'compatibility' else 'admin' end, p_requested_by, '{}'::jsonb);

  insert into admin_command_events (command_id, run_id, event_type, actor_type, actor_id, safe_details)
  values (
    v_command.id,
    v_run.id,
    case when p_shadow_only then 'compatibility_shadowed' else 'run_queued' end,
    case when p_shadow_only then 'compatibility' else 'system' end,
    p_requested_by,
    '{}'::jsonb
  );

  return query select v_command.id, v_run.id, v_run.status, true, false;
end;
$$;

create or replace function admin_claim_command_attempt_v3(
  p_worker_id text,
  p_command_types text[] default null,
  p_lease_seconds integer default 60
)
returns table(
  command_id uuid,
  run_id uuid,
  attempt_id uuid,
  command_type text,
  payload_ref jsonb,
  attempt_number integer,
  fencing_token text,
  lease_expires_at timestamptz,
  abort_requested_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_run admin_command_runs%rowtype;
  v_command admin_commands%rowtype;
  v_previous admin_command_attempts%rowtype;
  v_attempt admin_command_attempts%rowtype;
  v_attempt_number integer;
  v_reclaimed boolean;
  v_scan integer;
begin
  if p_worker_id is null or length(trim(p_worker_id)) not between 1 and 160 then
    raise exception using errcode = '22023', message = 'ADMIN_QUEUE_INVALID_WORKER_ID';
  end if;

  for v_scan in 1..10 loop
    v_reclaimed := false;
    select r.* into v_run
    from admin_command_runs r
    join admin_commands c on c.id = r.command_id
    left join admin_command_attempts a on a.id = r.current_attempt_id
    where (p_command_types is null or cardinality(p_command_types) = 0 or c.command_type = any(p_command_types))
      and r.abort_requested_at is null
      and (
        (r.status in ('queued', 'retry_wait') and r.available_at <= now())
        or (r.status = 'running' and a.status = 'running' and a.lease_expires_at <= now())
      )
    order by
      case when r.status = 'running' then 0 else 1 end,
      r.priority desc,
      r.available_at,
      r.created_at
    for update of r skip locked
    limit 1;

    if not found then return; end if;
    select c.* into v_command from admin_commands c where c.id = v_run.command_id;

    if v_run.status = 'running' then
      select a.* into v_previous
      from admin_command_attempts a
      where a.id = v_run.current_attempt_id
      for update;

      update admin_command_attempts
      set status = 'lease_expired', finished_at = now(), failure_disposition = 'lease_expired',
          error_code = 'lease_expired', error_message = 'Worker lease expired before terminalization.', updated_at = now()
      where id = v_previous.id;

      insert into admin_command_events (command_id, run_id, attempt_id, event_type, actor_type, safe_details)
      values (v_command.id, v_run.id, v_previous.id, 'lease_reclaimed', 'system', jsonb_build_object('attemptNumber', v_previous.attempt_number));

      if v_previous.attempt_number >= v_run.max_attempts then
        update admin_command_runs
        set status = 'failed', finished_at = now(), terminal_error_code = 'lease_attempts_exhausted',
            terminal_error_message = 'Maximum attempts exhausted after lease expiry.', updated_at = now()
        where id = v_run.id;
        insert into admin_command_events (command_id, run_id, event_type, actor_type, safe_details)
        values (v_command.id, v_run.id, 'run_failed', 'system', jsonb_build_object('errorCode', 'lease_attempts_exhausted'));
        continue;
      end if;
      v_reclaimed := true;
    end if;

    select coalesce(max(a.attempt_number), 0) + 1 into v_attempt_number
    from admin_command_attempts a where a.run_id = v_run.id;

    insert into admin_command_attempts (
      run_id, attempt_number, status, worker_id, lease_expires_at, heartbeat_at
    ) values (
      v_run.id,
      v_attempt_number,
      'running',
      left(trim(p_worker_id), 160),
      now() + make_interval(secs => greatest(1, least(coalesce(p_lease_seconds, 60), 86400))),
      now()
    ) returning * into v_attempt;

    update admin_command_runs
    set status = 'running', current_attempt_id = v_attempt.id,
        started_at = coalesce(started_at, now()), updated_at = now()
    where id = v_run.id;

    insert into admin_command_events (command_id, run_id, attempt_id, event_type, actor_type, actor_id, safe_details)
    values (
      v_command.id, v_run.id, v_attempt.id, 'attempt_claimed', 'worker', left(trim(p_worker_id), 160),
      jsonb_build_object('attemptNumber', v_attempt.attempt_number, 'reclaimed', v_reclaimed)
    );

    return query select
      v_command.id, v_run.id, v_attempt.id, v_command.command_type, v_command.payload_ref,
      v_attempt.attempt_number, v_attempt.fencing_token::text, v_attempt.lease_expires_at, v_run.abort_requested_at;
    return;
  end loop;
end;
$$;

create or replace function admin_heartbeat_command_attempt_v3(
  p_attempt_id uuid,
  p_fencing_token bigint,
  p_lease_seconds integer default 60
)
returns table(attempt_id uuid, run_id uuid, fencing_token text, heartbeat_at timestamptz, lease_expires_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_attempt admin_command_attempts%rowtype;
  v_run admin_command_runs%rowtype;
  v_run_id uuid;
begin
  select a.run_id into v_run_id from admin_command_attempts a where a.id = p_attempt_id;
  if not found then raise exception using errcode = 'P0001', message = 'ADMIN_QUEUE_ATTEMPT_NOT_FOUND'; end if;
  select r.* into v_run from admin_command_runs r where r.id = v_run_id for update;
  select a.* into v_attempt from admin_command_attempts a where a.id = p_attempt_id for update;

  if v_attempt.fencing_token <> p_fencing_token or v_run.current_attempt_id <> v_attempt.id then
    raise exception using errcode = 'P0001', message = 'ADMIN_QUEUE_STALE_FENCE';
  end if;
  if v_run.status <> 'running' or v_attempt.status <> 'running' or v_attempt.lease_expires_at <= now() then
    raise exception using errcode = 'P0001', message = 'ADMIN_QUEUE_LEASE_LOST';
  end if;
  if v_run.abort_requested_at is not null then
    raise exception using errcode = 'P0001', message = 'ADMIN_QUEUE_ABORTED';
  end if;

  update admin_command_attempts a
  set heartbeat_at = now(),
      lease_expires_at = now() + make_interval(secs => greatest(1, least(coalesce(p_lease_seconds, 60), 86400))),
      updated_at = now()
  where a.id = v_attempt.id
  returning a.* into v_attempt;

  insert into admin_command_events (command_id, run_id, attempt_id, event_type, actor_type, actor_id, safe_details)
  values (v_run.command_id, v_run.id, v_attempt.id, 'heartbeat', 'worker', v_attempt.worker_id, jsonb_build_object('attemptNumber', v_attempt.attempt_number));

  return query select v_attempt.id, v_attempt.run_id, v_attempt.fencing_token::text, v_attempt.heartbeat_at, v_attempt.lease_expires_at;
end;
$$;

create or replace function admin_complete_command_attempt_v3(
  p_attempt_id uuid,
  p_fencing_token bigint,
  p_result_summary jsonb default '{}'::jsonb
)
returns table(run_id uuid, run_status text, attempt_id uuid, attempt_status text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_attempt admin_command_attempts%rowtype;
  v_run admin_command_runs%rowtype;
  v_run_id uuid;
begin
  if jsonb_typeof(coalesce(p_result_summary, '{}'::jsonb)) <> 'object'
     or not admin_queue_json_is_safe(coalesce(p_result_summary, '{}'::jsonb), 16384) then
    raise exception using errcode = '22023', message = 'ADMIN_QUEUE_UNSAFE_RESULT';
  end if;
  select a.run_id into v_run_id from admin_command_attempts a where a.id = p_attempt_id;
  if not found then raise exception using errcode = 'P0001', message = 'ADMIN_QUEUE_ATTEMPT_NOT_FOUND'; end if;
  select r.* into v_run from admin_command_runs r where r.id = v_run_id for update;
  select a.* into v_attempt from admin_command_attempts a where a.id = p_attempt_id for update;

  if v_attempt.fencing_token <> p_fencing_token or v_run.current_attempt_id <> v_attempt.id then
    raise exception using errcode = 'P0001', message = 'ADMIN_QUEUE_STALE_FENCE';
  end if;
  if v_run.abort_requested_at is not null or v_run.status = 'aborted' then
    raise exception using errcode = 'P0001', message = 'ADMIN_QUEUE_ABORTED';
  end if;
  if v_run.status <> 'running' or v_attempt.status <> 'running' or v_attempt.lease_expires_at <= now() then
    raise exception using errcode = 'P0001', message = 'ADMIN_QUEUE_LEASE_LOST';
  end if;

  update admin_command_attempts
  set status = 'succeeded', finished_at = now(), result_summary = coalesce(p_result_summary, '{}'::jsonb), updated_at = now()
  where id = v_attempt.id;
  update admin_command_runs
  set status = 'succeeded', finished_at = now(), result_summary = coalesce(p_result_summary, '{}'::jsonb),
      terminal_error_code = null, terminal_error_message = null, updated_at = now()
  where id = v_run.id;
  insert into admin_command_events (command_id, run_id, attempt_id, event_type, actor_type, actor_id, safe_details)
  values (v_run.command_id, v_run.id, v_attempt.id, 'attempt_succeeded', 'worker', v_attempt.worker_id, jsonb_build_object('attemptNumber', v_attempt.attempt_number));

  return query select v_run.id, 'succeeded'::text, v_attempt.id, 'succeeded'::text;
end;
$$;

create or replace function admin_fail_command_attempt_v3(
  p_attempt_id uuid,
  p_fencing_token bigint,
  p_failure_disposition text,
  p_error_code text,
  p_error_message text default null,
  p_result_summary jsonb default '{}'::jsonb
)
returns table(run_id uuid, run_status text, attempt_id uuid, attempt_status text, retry_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_attempt admin_command_attempts%rowtype;
  v_run admin_command_runs%rowtype;
  v_run_id uuid;
  v_retry_at timestamptz;
  v_retryable boolean;
begin
  if p_failure_disposition not in ('retryable', 'terminal') then
    raise exception using errcode = '22023', message = 'ADMIN_QUEUE_INVALID_FAILURE_DISPOSITION';
  end if;
  if p_error_code is null or length(p_error_code) not between 1 and 160 then
    raise exception using errcode = '22023', message = 'ADMIN_QUEUE_INVALID_ERROR_CODE';
  end if;
  if jsonb_typeof(coalesce(p_result_summary, '{}'::jsonb)) <> 'object'
     or not admin_queue_json_is_safe(coalesce(p_result_summary, '{}'::jsonb), 16384) then
    raise exception using errcode = '22023', message = 'ADMIN_QUEUE_UNSAFE_RESULT';
  end if;

  select a.run_id into v_run_id from admin_command_attempts a where a.id = p_attempt_id;
  if not found then raise exception using errcode = 'P0001', message = 'ADMIN_QUEUE_ATTEMPT_NOT_FOUND'; end if;
  select r.* into v_run from admin_command_runs r where r.id = v_run_id for update;
  select a.* into v_attempt from admin_command_attempts a where a.id = p_attempt_id for update;

  if v_attempt.fencing_token <> p_fencing_token or v_run.current_attempt_id <> v_attempt.id then
    raise exception using errcode = 'P0001', message = 'ADMIN_QUEUE_STALE_FENCE';
  end if;
  if v_run.abort_requested_at is not null or v_run.status = 'aborted' then
    raise exception using errcode = 'P0001', message = 'ADMIN_QUEUE_ABORTED';
  end if;
  if v_run.status <> 'running' or v_attempt.status <> 'running' or v_attempt.lease_expires_at <= now() then
    raise exception using errcode = 'P0001', message = 'ADMIN_QUEUE_LEASE_LOST';
  end if;

  v_retryable := p_failure_disposition = 'retryable' and v_attempt.attempt_number < v_run.max_attempts;
  if v_retryable then
    v_retry_at := now() + make_interval(
      secs => least(
        v_run.retry_backoff_cap_seconds,
        v_run.retry_backoff_base_seconds::numeric * power(2::numeric, greatest(v_attempt.attempt_number - 1, 0))
      )::integer
    );
  end if;

  update admin_command_attempts
  set status = 'failed', finished_at = now(), failure_disposition = p_failure_disposition,
      error_code = left(p_error_code, 160), error_message = left(nullif(trim(p_error_message), ''), 500),
      result_summary = coalesce(p_result_summary, '{}'::jsonb), updated_at = now()
  where id = v_attempt.id;

  if v_retryable then
    update admin_command_runs
    set status = 'retry_wait', available_at = v_retry_at, retry_count = retry_count + 1,
        current_attempt_id = null, updated_at = now()
    where id = v_run.id;
    insert into admin_command_events (command_id, run_id, attempt_id, event_type, actor_type, actor_id, safe_details)
    values (
      v_run.command_id, v_run.id, v_attempt.id, 'retry_scheduled', 'worker', v_attempt.worker_id,
      jsonb_build_object('attemptNumber', v_attempt.attempt_number, 'errorCode', left(p_error_code, 160))
    );
    return query select v_run.id, 'retry_wait'::text, v_attempt.id, 'failed'::text, v_retry_at;
  else
    update admin_command_runs
    set status = 'failed', finished_at = now(), terminal_error_code = left(p_error_code, 160),
        terminal_error_message = left(nullif(trim(p_error_message), ''), 500),
        result_summary = coalesce(p_result_summary, '{}'::jsonb), updated_at = now()
    where id = v_run.id;
    insert into admin_command_events (command_id, run_id, attempt_id, event_type, actor_type, actor_id, safe_details)
    values (
      v_run.command_id, v_run.id, v_attempt.id, 'run_failed', 'worker', v_attempt.worker_id,
      jsonb_build_object('attemptNumber', v_attempt.attempt_number, 'errorCode', left(p_error_code, 160), 'disposition', p_failure_disposition)
    );
    return query select v_run.id, 'failed'::text, v_attempt.id, 'failed'::text, null::timestamptz;
  end if;
end;
$$;

create or replace function admin_abort_command_run_v3(
  p_run_id uuid,
  p_requested_by text,
  p_reason text default null
)
returns table(run_id uuid, run_status text, abort_requested_at timestamptz, finished_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_run admin_command_runs%rowtype;
begin
  select r.* into v_run from admin_command_runs r where r.id = p_run_id for update;
  if not found then raise exception using errcode = 'P0001', message = 'ADMIN_QUEUE_RUN_NOT_FOUND'; end if;

  if v_run.status in ('succeeded', 'failed', 'aborted', 'shadowed') then
    return query select v_run.id, v_run.status, v_run.abort_requested_at, v_run.finished_at;
    return;
  end if;

  update admin_command_runs as r
  set abort_requested_at = coalesce(r.abort_requested_at, now()),
      abort_requested_by = left(nullif(trim(p_requested_by), ''), 160),
      abort_reason = left(nullif(trim(p_reason), ''), 500),
      updated_at = now()
  where r.id = v_run.id
  returning r.* into v_run;

  insert into admin_command_events (command_id, run_id, attempt_id, event_type, actor_type, actor_id, safe_details)
  values (
    v_run.command_id, v_run.id, v_run.current_attempt_id, 'abort_requested', 'admin',
    left(nullif(trim(p_requested_by), ''), 160), jsonb_build_object('hadActiveAttempt', v_run.current_attempt_id is not null)
  );

  if v_run.current_attempt_id is not null then
    update admin_command_attempts
    set status = 'aborted', finished_at = now(), failure_disposition = 'aborted',
        error_code = 'aborted', error_message = 'Execution was aborted by an administrator.', updated_at = now()
    where id = v_run.current_attempt_id and status = 'running';
  end if;

  update admin_command_runs
  set status = 'aborted', finished_at = now(), terminal_error_code = 'aborted',
      terminal_error_message = 'Execution was aborted by an administrator.', updated_at = now()
  where id = v_run.id
  returning * into v_run;

  insert into admin_command_events (command_id, run_id, attempt_id, event_type, actor_type, actor_id, safe_details)
  values (
    v_run.command_id, v_run.id, v_run.current_attempt_id, 'run_aborted', 'system',
    left(nullif(trim(p_requested_by), ''), 160), '{}'::jsonb
  );

  return query select v_run.id, v_run.status, v_run.abort_requested_at, v_run.finished_at;
end;
$$;

create or replace function admin_retry_command_run_v3(
  p_run_id uuid,
  p_requested_by text,
  p_reason text default null
)
returns table(command_id uuid, run_id uuid, run_number integer, run_status text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_previous admin_command_runs%rowtype;
  v_run admin_command_runs%rowtype;
  v_next_number integer;
begin
  select r.* into v_previous from admin_command_runs r where r.id = p_run_id for update;
  if not found then raise exception using errcode = 'P0001', message = 'ADMIN_QUEUE_RUN_NOT_FOUND'; end if;
  if v_previous.status not in ('failed', 'aborted') then
    raise exception using errcode = 'P0001', message = 'ADMIN_QUEUE_RUN_NOT_RETRYABLE';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('admin-dedupe:' || v_previous.dedupe_key, 0));
  if exists (
    select 1 from admin_command_runs r
    where r.dedupe_key = v_previous.dedupe_key and r.status in ('queued', 'running', 'retry_wait')
  ) then
    raise exception using errcode = 'P0001', message = 'ADMIN_QUEUE_ACTIVE_DUPLICATE';
  end if;

  select max(r.run_number) + 1 into v_next_number
  from admin_command_runs r where r.command_id = v_previous.command_id;

  insert into admin_command_runs (
    command_id, run_number, status, dedupe_key, priority, available_at, max_attempts,
    retry_backoff_base_seconds, retry_backoff_cap_seconds
  ) values (
    v_previous.command_id, v_next_number, 'queued', v_previous.dedupe_key, v_previous.priority,
    now(), v_previous.max_attempts, v_previous.retry_backoff_base_seconds, v_previous.retry_backoff_cap_seconds
  ) returning * into v_run;

  insert into admin_command_events (command_id, run_id, event_type, actor_type, actor_id, safe_details)
  values (
    v_run.command_id, v_run.id, 'manual_retry_queued', 'admin', left(nullif(trim(p_requested_by), ''), 160),
    jsonb_build_object('previousRunId', v_previous.id, 'reasonPresent', nullif(trim(p_reason), '') is not null)
  );

  return query select v_run.command_id, v_run.id, v_run.run_number, v_run.status;
end;
$$;

do $$
begin
  revoke all on function admin_submit_command_v3(text, jsonb, text, text, text, integer, integer, integer, integer, boolean) from public;
  revoke all on function admin_claim_command_attempt_v3(text, text[], integer) from public;
  revoke all on function admin_heartbeat_command_attempt_v3(uuid, bigint, integer) from public;
  revoke all on function admin_complete_command_attempt_v3(uuid, bigint, jsonb) from public;
  revoke all on function admin_fail_command_attempt_v3(uuid, bigint, text, text, text, jsonb) from public;
  revoke all on function admin_abort_command_run_v3(uuid, text, text) from public;
  revoke all on function admin_retry_command_run_v3(uuid, text, text) from public;

  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on admin_commands, admin_command_runs, admin_command_attempts, admin_command_events from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on admin_commands, admin_command_runs, admin_command_attempts, admin_command_events from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select on admin_commands, admin_command_runs, admin_command_attempts, admin_command_events to service_role;
    grant usage, select on sequence admin_command_fencing_token_seq to service_role;
    grant execute on function admin_submit_command_v3(text, jsonb, text, text, text, integer, integer, integer, integer, boolean) to service_role;
    grant execute on function admin_claim_command_attempt_v3(text, text[], integer) to service_role;
    grant execute on function admin_heartbeat_command_attempt_v3(uuid, bigint, integer) to service_role;
    grant execute on function admin_complete_command_attempt_v3(uuid, bigint, jsonb) to service_role;
    grant execute on function admin_fail_command_attempt_v3(uuid, bigint, text, text, text, jsonb) to service_role;
    grant execute on function admin_abort_command_run_v3(uuid, text, text) to service_role;
    grant execute on function admin_retry_command_run_v3(uuid, text, text) to service_role;
  end if;
end;
$$;
