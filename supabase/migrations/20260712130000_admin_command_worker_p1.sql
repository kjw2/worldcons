-- P1 direct-worker additions. The P0 claim RPC and the legacy admin_jobs queue remain unchanged.

create or replace function admin_claim_command_attempt_p1(
  p_worker_id text,
  p_command_types text[],
  p_cohorts text[],
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
  if p_command_types is null or cardinality(p_command_types) not between 1 and 20 then
    raise exception using errcode = '22023', message = 'ADMIN_QUEUE_INVALID_COMMAND_ALLOWLIST';
  end if;
  if p_cohorts is null or cardinality(p_cohorts) not between 1 and 20 then
    raise exception using errcode = '22023', message = 'ADMIN_QUEUE_INVALID_COHORT_ALLOWLIST';
  end if;

  for v_scan in 1..10 loop
    v_reclaimed := false;
    select r.* into v_run
    from admin_command_runs r
    join admin_commands c on c.id = r.command_id
    left join admin_command_attempts a on a.id = r.current_attempt_id
    where c.command_type = any(p_command_types)
      and c.payload_ref->>'cohort' = any(p_cohorts)
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

create or replace function admin_begin_source_url_candidate_retry_p1(p_candidate_id uuid)
returns table(
  candidate_id uuid,
  source_key text,
  candidate_url text,
  candidate_type text,
  candidate_status text,
  attempt_count integer,
  should_fetch boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_candidate source_url_candidates%rowtype;
  v_should_fetch boolean;
begin
  select c.* into v_candidate from source_url_candidates c where c.id = p_candidate_id for update;
  if not found then raise exception using errcode = 'P0001', message = 'ADMIN_QUEUE_CANDIDATE_NOT_FOUND'; end if;

  v_should_fetch := v_candidate.status not in ('fetched', 'ignored');
  if v_should_fetch then
    update source_url_candidates
    set status = 'retrying', last_attempt_at = now(), attempt_count = source_url_candidates.attempt_count + 1
    where id = v_candidate.id
    returning * into v_candidate;
  end if;

  return query select
    v_candidate.id, v_candidate.source_key, v_candidate.url, v_candidate.candidate_type,
    v_candidate.status, v_candidate.attempt_count, v_should_fetch;
end;
$$;

create or replace function admin_finish_source_url_candidate_retry_p1(
  p_candidate_id uuid,
  p_attempt_count integer,
  p_status text,
  p_error_code text default null,
  p_error_message text default null
)
returns table(candidate_id uuid, candidate_status text, attempt_count integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_candidate source_url_candidates%rowtype;
begin
  if p_status not in ('fetched', 'failed') then
    raise exception using errcode = '22023', message = 'ADMIN_QUEUE_INVALID_CANDIDATE_STATUS';
  end if;
  if p_error_code is not null and length(p_error_code) > 160 then
    raise exception using errcode = '22023', message = 'ADMIN_QUEUE_INVALID_CANDIDATE_ERROR';
  end if;

  select c.* into v_candidate from source_url_candidates c where c.id = p_candidate_id for update;
  if not found then raise exception using errcode = 'P0001', message = 'ADMIN_QUEUE_CANDIDATE_NOT_FOUND'; end if;

  if v_candidate.attempt_count <> p_attempt_count then
    raise exception using errcode = 'P0001', message = 'ADMIN_QUEUE_STALE_CANDIDATE_ATTEMPT';
  end if;
  if v_candidate.status = p_status then
    return query select v_candidate.id, v_candidate.status, v_candidate.attempt_count;
    return;
  end if;
  if v_candidate.status <> 'retrying' then
    raise exception using errcode = 'P0001', message = 'ADMIN_QUEUE_CANDIDATE_STATE_CONFLICT';
  end if;

  update source_url_candidates
  set status = p_status,
      last_error_code = case when p_status = 'fetched' then null else left(nullif(trim(p_error_code), ''), 160) end,
      last_error_message = case when p_status = 'fetched' then null else left(nullif(trim(p_error_message), ''), 500) end
  where id = v_candidate.id
  returning * into v_candidate;

  return query select v_candidate.id, v_candidate.status, v_candidate.attempt_count;
end;
$$;

do $$
begin
  revoke all on function admin_claim_command_attempt_p1(text, text[], text[], integer) from public;
  revoke all on function admin_begin_source_url_candidate_retry_p1(uuid) from public;
  revoke all on function admin_finish_source_url_candidate_retry_p1(uuid, integer, text, text, text) from public;

  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function admin_claim_command_attempt_p1(text, text[], text[], integer) to service_role;
    grant execute on function admin_begin_source_url_candidate_retry_p1(uuid) to service_role;
    grant execute on function admin_finish_source_url_candidate_retry_p1(uuid, integer, text, text, text) to service_role;
  end if;
end;
$$;
