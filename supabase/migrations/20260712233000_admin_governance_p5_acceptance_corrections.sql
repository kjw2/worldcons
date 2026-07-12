-- P5 acceptance corrections: digest-scoped approvals and presence-based observations.
-- Rerunnable; no authority data or compatibility path is removed.

revoke all on function admin_record_owner_approval_p5(text, text, text, timestamptz) from public;

do $$
begin
  if exists(select 1 from pg_roles where rolname = 'anon') then
    revoke all on function admin_record_owner_approval_p5(text, text, text, timestamptz) from anon;
  end if;
  if exists(select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function admin_record_owner_approval_p5(text, text, text, timestamptz) from authenticated;
  end if;
  if exists(select 1 from pg_roles where rolname = 'service_role') then
    revoke all on function admin_record_owner_approval_p5(text, text, text, timestamptz) from service_role;
  end if;
end;
$$;

create or replace function admin_record_owner_approval_p5_v2(
  p_role_key text,
  p_actor_hash text,
  p_evidence_digest text,
  p_current_evidence_digest text,
  p_expires_at timestamptz
)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id bigint;
begin
  if p_evidence_digest is distinct from p_current_evidence_digest then
    raise exception 'ADMIN_P5_STALE_EVIDENCE_DIGEST';
  end if;
  if p_role_key not in ('operations', 'data', 'security')
    or p_actor_hash !~ '^[0-9a-f]{64}$'
    or p_evidence_digest !~ '^[0-9a-f]{64}$'
    or p_expires_at <= now()
    or p_expires_at > now() + interval '180 days' then
    raise exception 'ADMIN_P5_INVALID_APPROVAL';
  end if;

  -- Serialize approvals for one digest so concurrent role claims cannot bypass
  -- the distinct-actor and single-actor-per-role checks below.
  perform pg_advisory_xact_lock(hashtextextended('admin-p5-approval:' || p_evidence_digest, 0));

  if exists(
    select 1 from admin_governance_evidence_p5
    where evidence_type = 'owner_approval'
      and note_code = 'retirement.readiness.v2'
      and evidence_digest = p_evidence_digest
      and actor_hash = p_actor_hash
      and role_key <> p_role_key
      and expires_at > now()
  ) then
    raise exception 'ADMIN_P5_DUPLICATE_ACTOR_ROLE';
  end if;
  if exists(
    select 1 from admin_governance_evidence_p5
    where evidence_type = 'owner_approval'
      and note_code = 'retirement.readiness.v2'
      and evidence_digest = p_evidence_digest
      and role_key = p_role_key
      and actor_hash <> p_actor_hash
      and expires_at > now()
  ) then
    raise exception 'ADMIN_P5_ROLE_ALREADY_APPROVED';
  end if;
  select id into v_id from admin_governance_evidence_p5
  where evidence_type = 'owner_approval'
    and note_code = 'retirement.readiness.v2'
    and evidence_digest = p_evidence_digest
    and role_key = p_role_key
    and actor_hash = p_actor_hash
    and expires_at > now()
  order by evidence_at desc limit 1;
  if v_id is not null then return v_id; end if;

  insert into admin_governance_evidence_p5 (
    evidence_type, role_key, outcome, actor_hash, expires_at, evidence_digest, note_code
  ) values ('owner_approval', p_role_key, 'approved', p_actor_hash, p_expires_at, p_evidence_digest, 'retirement.readiness.v2')
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function admin_governance_approval_sets_p5()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'evidenceDigest', grouped.evidence_digest,
    'roles', grouped.active_roles,
    'distinctActorCount', grouped.active_actor_count,
    'expiresAt', grouped.active_expires_at,
    'status', case when grouped.active_actor_count > 0 then 'active' else 'expired' end
  ) order by grouped.latest_evidence_at desc), '[]'::jsonb)
  from (
    select
      evidence_digest,
      to_jsonb(coalesce(array_agg(distinct role_key order by role_key) filter (where expires_at > now()), array[]::text[])) as active_roles,
      count(distinct actor_hash) filter (where expires_at > now()) as active_actor_count,
      min(expires_at) filter (where expires_at > now()) as active_expires_at,
      max(evidence_at) as latest_evidence_at
    from admin_governance_evidence_p5
    where evidence_type = 'owner_approval'
      and outcome = 'approved'
      and note_code = 'retirement.readiness.v2'
    group by evidence_digest
    order by max(evidence_at) desc
    limit 50
  ) grouped;
$$;

create or replace function admin_operational_health_p5(
  p_observation_start timestamptz,
  p_observation_end timestamptz,
  p_command_before timestamptz,
  p_lifecycle_before timestamptz,
  p_publication_before timestamptz,
  p_observation_before timestamptz,
  p_delivered_outbox_before timestamptz,
  p_dead_letter_outbox_before timestamptz
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_core jsonb;
  v_compat jsonb;
  v_sources jsonb;
  v_governance jsonb;
  v_retention jsonb;
begin
  if p_observation_start is null or p_observation_end is null
    or p_observation_start >= p_observation_end
    or p_observation_end > now() + interval '5 minutes'
    or p_observation_end - p_observation_start > interval '90 days' then
    raise exception 'ADMIN_P5_INVALID_WINDOW';
  end if;

  select evidence into v_core from admin_operational_health_core_p5;
  select jsonb_build_object(
    'totalCount', coalesce(sum(observation_count), 0)::bigint,
    'legacyReadCount', coalesce(sum(observation_count) filter (where authority = 'legacy' and direction = 'read'), 0)::bigint,
    'legacyWriteCount', coalesce(sum(observation_count) filter (where authority = 'legacy' and direction = 'write'), 0)::bigint,
    'newReadCount', coalesce(sum(observation_count) filter (where authority = 'new' and direction = 'read'), 0)::bigint,
    'newWriteCount', coalesce(sum(observation_count) filter (where authority = 'new' and direction = 'write'), 0)::bigint,
    'fallbackCount', coalesce(sum(observation_count) filter (where authority = 'fallback'), 0)::bigint,
    'unexplainedLegacyCount', coalesce(sum(unexplained_count), 0)::bigint,
    'legacyReadObserved', coalesce(bool_or(authority = 'legacy' and direction = 'read'), false),
    'legacyWriteObserved', coalesce(bool_or(authority = 'legacy' and direction = 'write'), false),
    'newReadObserved', coalesce(bool_or(authority = 'new' and direction = 'read'), false),
    'newWriteObserved', coalesce(bool_or(authority = 'new' and direction = 'write'), false),
    'fallbackObserved', coalesce(bool_or(authority = 'fallback'), false),
    'unexplainedLegacyObserved', coalesce(bool_or(unexplained_count > 0), false),
    'firstObservedAt', min(first_observed_at),
    'lastObservedAt', max(last_observed_at),
    'legacyLastSeenAt', max(last_observed_at) filter (where authority in ('legacy', 'fallback')),
    'newLastSeenAt', max(last_observed_at) filter (where authority = 'new'),
    'bucketCount', count(*)::bigint
  ) into v_compat
  from admin_compatibility_observations_p5
  where bucket_started_at >= date_trunc('hour', p_observation_start)
    and bucket_started_at <= date_trunc('hour', p_observation_end);

  select coalesce(jsonb_agg(jsonb_build_object(
    'sourceKey', s.source_key,
    'active', s.is_active,
    'latestRunAt', latest.started_at,
    'freshnessAgeSeconds', case when latest.started_at is null then null else extract(epoch from now() - latest.started_at)::bigint end
  ) order by s.source_key), '[]'::jsonb) into v_sources
  from sources s
  left join lateral (
    select r.started_at from ingestion_runs r where r.source_key = s.source_key order by r.started_at desc limit 1
  ) latest on true;

  select jsonb_build_object(
    'backupRestoreAt', (select evidence_at from admin_governance_evidence_p5 where evidence_type = 'backup_restore' and outcome = 'successful' order by evidence_at desc limit 1),
    'backupRestoreExpiresAt', (select expires_at from admin_governance_evidence_p5 where evidence_type = 'backup_restore' and outcome = 'successful' order by evidence_at desc limit 1),
    'approvalSets', admin_governance_approval_sets_p5()
  ) into v_governance;

  v_retention := admin_retention_plan_p5(p_command_before, p_lifecycle_before, p_publication_before, p_observation_before, p_delivered_outbox_before, p_dead_letter_outbox_before);
  return jsonb_build_object(
    'schemaVersion', 1,
    'generatedAt', now(),
    'available', true,
    'observationWindow', jsonb_build_object('start', p_observation_start, 'end', p_observation_end),
    'queue', v_core->'queue',
    'lifecycle', v_core->'lifecycle',
    'publication', v_core->'publication',
    'outbox', v_core->'outbox',
    'sources', v_sources,
    'compatibility', v_compat,
    'inFlight', v_core->'inFlight',
    'governance', v_governance,
    'retention', v_retention - 'recommendations'
  );
end;
$$;

revoke all on function admin_record_owner_approval_p5_v2(text, text, text, text, timestamptz) from public;
revoke all on function admin_governance_approval_sets_p5() from public;

do $$
begin
  if exists(select 1 from pg_roles where rolname = 'anon') then
    revoke all on function admin_record_owner_approval_p5_v2(text, text, text, text, timestamptz) from anon;
    revoke all on function admin_governance_approval_sets_p5() from anon;
  end if;
  if exists(select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function admin_record_owner_approval_p5_v2(text, text, text, text, timestamptz) from authenticated;
    revoke all on function admin_governance_approval_sets_p5() from authenticated;
  end if;
  if exists(select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function admin_record_owner_approval_p5_v2(text, text, text, text, timestamptz) to service_role;
  end if;
end;
$$;
