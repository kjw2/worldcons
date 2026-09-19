begin;

-- M5 artifact Blob readiness observability. This migration adds exactly one
-- read-only, service_role-only function used by the operational readiness CLI:
-- it returns one bounded, keyset-paginated page of fetch/normalization artifacts
-- reduced to presence and externalization/ledger metadata. It never returns
-- payload content, performs no DML, changes no existing object, and stores no
-- data. The optional bounded Blob verification remains in application code.
--
-- Ledger coverage is computed here as "a matching append-only externalization
-- ledger row exists for this artifact" so the caller does not need to transfer
-- refs or join client-side.

create or replace function source_backfill_artifact_readiness_rows_v1(
  p_kind text,
  p_source_key text,
  p_limit integer,
  p_after_artifact_id uuid
)
returns table (
  artifact_table text,
  artifact_id uuid,
  item_id uuid,
  source_key text,
  kind text,
  replayability text,
  inline_present boolean,
  storage_ref text,
  stored_hash text,
  stored_size bigint,
  externalization_contract_version text,
  externalized_at_present boolean,
  ledger_covered boolean
)
language plpgsql
stable
security definer
set search_path = public, extensions, pg_temp
as $function$
declare
  v_kind text;
  v_source_key text;
begin
  v_kind := nullif(trim(coalesce(p_kind, '')), '');
  if v_kind not in ('fetch', 'normalization') then
    raise exception using errcode = '22023', message = 'ARTIFACT_READINESS_KIND_INVALID';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception using errcode = '22023', message = 'ARTIFACT_READINESS_LIMIT_INVALID';
  end if;
  v_source_key := nullif(trim(coalesce(p_source_key, '')), '');

  if v_kind = 'fetch' then
    return query
    select
      'source_fetch_artifacts'::text,
      f.id,
      f.item_id,
      s.source_key,
      'fetch'::text,
      f.replayability,
      (f.bounded_replay_payload is not null),
      f.bounded_replay_storage_ref,
      f.payload_hash,
      f.payload_size,
      f.externalization_contract_version,
      (f.externalized_at is not null),
      exists (
        select 1
        from source_artifact_externalization_ledger l
        where l.artifact_table = 'source_fetch_artifacts'
          and l.artifact_id = f.id
          and l.storage_ref = f.bounded_replay_storage_ref
          and l.content_hash = f.payload_hash
          and l.content_size is not distinct from f.payload_size
          and l.externalization_contract_version = f.externalization_contract_version
      )
    from source_fetch_artifacts f
    join source_backfill_items i on i.id = f.item_id
    join source_inventory_snapshots s on s.id = i.snapshot_id
    where (p_after_artifact_id is null or f.id > p_after_artifact_id)
      and (v_source_key is null or s.source_key = v_source_key)
    order by f.id
    limit p_limit;
    return;
  end if;

  return query
  select
    'source_normalization_artifacts'::text,
    n.id,
    n.item_id,
    s.source_key,
    'normalization'::text,
    null::text,
    (n.normalized_output is not null),
    n.normalized_output_storage_ref,
    n.normalized_output_hash,
    n.normalized_output_size,
    n.externalization_contract_version,
    (n.externalized_at is not null),
    exists (
      select 1
      from source_artifact_externalization_ledger l
      where l.artifact_table = 'source_normalization_artifacts'
        and l.artifact_id = n.id
        and l.storage_ref = n.normalized_output_storage_ref
        and l.content_hash = n.normalized_output_hash
        and l.content_size is not distinct from n.normalized_output_size
        and l.externalization_contract_version = n.externalization_contract_version
    )
  from source_normalization_artifacts n
  join source_backfill_items i on i.id = n.item_id
  join source_inventory_snapshots s on s.id = i.snapshot_id
  where (p_after_artifact_id is null or n.id > p_after_artifact_id)
    and (v_source_key is null or s.source_key = v_source_key)
  order by n.id
  limit p_limit;
end;
$function$;

revoke all on function source_backfill_artifact_readiness_rows_v1(text, text, integer, uuid) from public;

do $permissions$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function source_backfill_artifact_readiness_rows_v1(text, text, integer, uuid) to service_role;
  end if;
end;
$permissions$;

comment on function source_backfill_artifact_readiness_rows_v1(text, text, integer, uuid) is
  'M5 read-only readiness: bounded, keyset-paginated artifact presence/externalization/ledger metadata for fetch and normalization artifacts. Returns no payload content and performs no DML.';

commit;
