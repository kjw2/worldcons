begin;

-- The base Gate 1 event ledger predates the exclusion transition; extend the
-- allowed event type with the new audit event before the RPC emits it.
alter table source_backfill_item_events
  drop constraint if exists source_backfill_item_events_type_check;
alter table source_backfill_item_events
  add constraint source_backfill_item_events_type_check check (event_type in (
    'item_discovered', 'item_claimed', 'item_lease_extended', 'fetch_recorded',
    'normalization_recorded', 'item_completed', 'item_failed', 'claim_released',
    'verification_noop', 'item_excluded'
  ));

-- Additive completion path for the M3 private-shadow gate.
--
-- The approved BVerfG policy classifies an official detail that still cannot be
-- fetched or replayed after every sealed inventory URL candidate was attempted
-- (for example an official 404 page) as an explicit exclusion. The base Gate 1
-- schema already reserves `status='excluded'` and `exclusion_code`, but no fenced
-- transition wrote them. This function adds only that transition, reusing the
-- existing P1 attempt/fencing/lease assertions so no caller can bypass the
-- control plane or mutate a closed manifest field.
create or replace function source_backfill_item_exclude_v1(
  p_item_id uuid,
  p_phase text,
  p_p1_attempt_id uuid,
  p_p1_fencing_token bigint,
  p_exclusion_code text
)
returns table(item_id uuid, resolution_status text, exclusion_code text)
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $function$
declare
  v_item source_backfill_items%rowtype;
begin
  if p_phase not in ('normalize', 'verify') then
    raise exception using errcode = '22023', message = 'CASE_BACKFILL_INVALID_EXCLUSION_PHASE';
  end if;
  if p_exclusion_code is null or p_exclusion_code !~ '^[a-z][a-z0-9._-]{2,79}$' then
    raise exception using errcode = '22023', message = 'CASE_BACKFILL_INVALID_EXCLUSION_CODE';
  end if;
  select i.* into v_item from source_backfill_items i where i.id = p_item_id for update;
  if not found then raise exception using errcode = 'P0001', message = 'CASE_BACKFILL_ITEM_NOT_FOUND'; end if;
  perform source_backfill_assert_attempt_v1(p_p1_attempt_id, p_p1_fencing_token, v_item.snapshot_id, p_phase);
  if v_item.claimed_attempt_id <> p_p1_attempt_id or v_item.claimed_fencing_token <> p_p1_fencing_token
    or v_item.claimed_phase <> p_phase or v_item.lease_expires_at <= now()
  then raise exception using errcode = '40001', message = 'CASE_BACKFILL_ITEM_LEASE_LOST'; end if;
  if v_item.status not in ('fetched', 'normalized', 'retry_wait') or v_item.current_fetch_artifact_id is null then
    raise exception using errcode = '22023', message = 'CASE_BACKFILL_INVALID_EXCLUSION_TRANSITION'; end if;

  update source_backfill_items i set
    status = 'excluded',
    exclusion_code = left(trim(p_exclusion_code), 80),
    claimed_attempt_id = null, claimed_fencing_token = null, claimed_phase = null, lease_expires_at = null,
    next_attempt_at = null, retry_phase = null, error_code = null, error_summary = null,
    updated_at = now()
  where i.id = v_item.id returning i.* into v_item;

  insert into source_backfill_item_events(item_id, attempt_id, event_type, phase, safe_details)
  values (v_item.id, p_p1_attempt_id, 'item_excluded', p_phase,
    jsonb_build_object('status', v_item.status, 'exclusionCode', v_item.exclusion_code,
      'fetchArtifactId', v_item.current_fetch_artifact_id));
  return query select v_item.id, v_item.status, v_item.exclusion_code;
end;
$function$;

revoke all on function source_backfill_item_exclude_v1(uuid, text, uuid, bigint, text) from public;

do $permissions$
begin
  if exists(select 1 from pg_roles where rolname='anon') then
    revoke execute on function source_backfill_item_exclude_v1(uuid, text, uuid, bigint, text) from anon;
  end if;
  if exists(select 1 from pg_roles where rolname='authenticated') then
    revoke execute on function source_backfill_item_exclude_v1(uuid, text, uuid, bigint, text) from authenticated;
  end if;
  if exists(select 1 from pg_roles where rolname='service_role') then
    grant execute on function source_backfill_item_exclude_v1(uuid, text, uuid, bigint, text) to service_role;
  end if;
end;
$permissions$;

comment on function source_backfill_item_exclude_v1(uuid, text, uuid, bigint, text) is
  'Fenced explicit-exclusion transition for private-shadow backfill items whose official source could not be fetched or replayed. Reuses P1 attempt/fencing/lease assertions and records an item_excluded audit event.';

commit;
