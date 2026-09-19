begin;

-- Gate 1 blob externalization backfill (M4A): attach an already verified private
-- Blob storage ref to an existing inline fetch/normalization artifact while
-- preserving the inline payload. This migration adds:
--   1. a one-time permit table that no API role can read or write;
--   2. a replacement immutability guard for the two artifact tables that allows
--      exactly one externalization transition, and only while a matching permit
--      exists;
--   3. a service_role security-definer RPC that mints the permit, performs the
--      single permitted UPDATE, and appends the externalization ledger row.
-- It never edits an existing migration, never clears inline content, and leaves
-- no generic bypass: direct updates/deletes stay blocked because service_role
-- holds no table UPDATE/DELETE privilege and cannot mint a permit.

create table if not exists source_artifact_externalization_permits (
  artifact_table text not null,
  artifact_id uuid not null,
  content_kind text not null,
  storage_ref text not null,
  content_hash text not null,
  content_size bigint not null,
  externalization_contract_version text not null,
  created_at timestamptz not null default now(),
  primary key (artifact_table, artifact_id),
  constraint source_artifact_externalization_permits_table_check check (
    artifact_table in ('source_fetch_artifacts', 'source_normalization_artifacts')
  ),
  constraint source_artifact_externalization_permits_kind_check check (
    (artifact_table = 'source_fetch_artifacts' and content_kind = 'bounded_replay_payload')
    or (artifact_table = 'source_normalization_artifacts' and content_kind = 'normalized_output')
  ),
  constraint source_artifact_externalization_permits_hash_check check (
    content_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint source_artifact_externalization_permits_size_check check (
    content_size between 0 and 4194304
  ),
  constraint source_artifact_externalization_permits_contract_check check (
    length(externalization_contract_version) between 1 and 120
  ),
  constraint source_artifact_externalization_permits_ref_check check (
    (
      (content_kind = 'bounded_replay_payload'
        and storage_ref ~ '^artifacts/fetch/[a-z][a-z0-9._-]{0,79}/[0-9a-f]{64}\.json$')
      or (content_kind = 'normalized_output'
        and storage_ref ~ '^artifacts/normalization/[a-z][a-z0-9._-]{0,79}/[0-9a-f]{64}\.json$')
    )
    and length(storage_ref) between 1 and 500
    and storage_ref !~* '(token|secret|signature|credential)'
  )
);

alter table source_artifact_externalization_permits enable row level security;

-- Replace the blanket immutability trigger on the two artifact tables with a
-- guard that permits exactly one externalization transition (absent -> present on
-- the ref/externalization columns only) while a matching one-time permit exists.
create or replace function case_backfill_artifact_externalization_guard_v1()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $function$
declare
  v_allowed text[];
  v_ref_column text;
  v_hash_column text;
  v_size_column text;
  v_old_ref text;
  v_new_ref text;
  v_new_hash text;
  v_new_size bigint;
  v_old_version text;
  v_new_version text;
  v_old_externalized_at timestamptz;
  v_new_externalized_at timestamptz;
  v_permit source_artifact_externalization_permits%rowtype;
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '55000', message = 'CASE_BACKFILL_IMMUTABLE';
  end if;

  if tg_table_name = 'source_fetch_artifacts' then
    v_allowed := array['bounded_replay_storage_ref', 'externalized_at', 'externalization_contract_version'];
    v_ref_column := 'bounded_replay_storage_ref';
    v_hash_column := 'payload_hash';
    v_size_column := 'payload_size';
  elsif tg_table_name = 'source_normalization_artifacts' then
    v_allowed := array['normalized_output_storage_ref', 'normalized_output_size', 'externalized_at', 'externalization_contract_version'];
    v_ref_column := 'normalized_output_storage_ref';
    v_hash_column := 'normalized_output_hash';
    v_size_column := 'normalized_output_size';
  else
    raise exception using errcode = '55000', message = 'CASE_BACKFILL_IMMUTABLE';
  end if;

  -- Any change to a column outside the externalization metadata set stays blocked.
  if (to_jsonb(old) - v_allowed) is distinct from (to_jsonb(new) - v_allowed) then
    raise exception using errcode = '55000', message = 'CASE_BACKFILL_IMMUTABLE';
  end if;

  v_old_ref := (to_jsonb(old) ->> v_ref_column);
  v_new_ref := (to_jsonb(new) ->> v_ref_column);
  v_new_hash := (to_jsonb(new) ->> v_hash_column);
  v_new_size := nullif(to_jsonb(new) ->> v_size_column, '')::bigint;
  v_old_version := (to_jsonb(old) ->> 'externalization_contract_version');
  v_new_version := (to_jsonb(new) ->> 'externalization_contract_version');
  v_old_externalized_at := nullif(to_jsonb(old) ->> 'externalized_at', '')::timestamptz;
  v_new_externalized_at := nullif(to_jsonb(new) ->> 'externalized_at', '')::timestamptz;

  -- Attach-once only: an already externalized row must never be rewritten, and the
  -- transition must add (not remove, not re-point) the externalization metadata.
  if v_old_ref is not null or v_old_version is not null or v_old_externalized_at is not null then
    raise exception using errcode = '55000', message = 'CASE_BACKFILL_IMMUTABLE';
  end if;
  if v_new_ref is null or v_new_version is null or v_new_externalized_at is null then
    raise exception using errcode = '55000', message = 'CASE_BACKFILL_IMMUTABLE';
  end if;

  select p.* into v_permit
  from source_artifact_externalization_permits p
  where p.artifact_table = tg_table_name and p.artifact_id = new.id
  for update;
  if not found then
    raise exception using errcode = '55000', message = 'CASE_BACKFILL_IMMUTABLE';
  end if;
  if v_permit.storage_ref <> v_new_ref
    or v_permit.content_hash <> v_new_hash
    or v_permit.content_size is distinct from v_new_size
    or v_permit.externalization_contract_version <> v_new_version
  then
    raise exception using errcode = '55000', message = 'CASE_BACKFILL_IMMUTABLE';
  end if;

  delete from source_artifact_externalization_permits
  where artifact_table = tg_table_name and artifact_id = new.id;
  return new;
end;
$function$;

drop trigger if exists source_fetch_artifacts_immutable_trigger on source_fetch_artifacts;
create trigger source_fetch_artifacts_immutable_trigger
before update or delete on source_fetch_artifacts
for each row execute function case_backfill_artifact_externalization_guard_v1();

drop trigger if exists source_normalization_artifacts_immutable_trigger on source_normalization_artifacts;
create trigger source_normalization_artifacts_immutable_trigger
before update or delete on source_normalization_artifacts
for each row execute function case_backfill_artifact_externalization_guard_v1();

create or replace function source_backfill_artifact_externalize_v1(
  p_artifact_table text,
  p_artifact_id uuid,
  p_storage_ref text,
  p_content_hash text,
  p_content_size bigint,
  p_externalization_contract_version text,
  p_actor_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $function$
declare
  v_item_id uuid;
  v_existing_ref text;
  v_existing_version text;
  v_existing_externalized_at timestamptz;
  v_stored_hash text;
  v_stored_size bigint;
  v_inline_present boolean;
  v_kind text;
  v_ref text;
  v_source_key text;
  v_expected_ref text;
  v_actor text;
begin
  if p_artifact_table not in ('source_fetch_artifacts', 'source_normalization_artifacts') then
    raise exception using errcode = '22023', message = 'CASE_BACKFILL_EXTERNALIZATION_TABLE_INVALID';
  end if;

  v_ref := nullif(trim(coalesce(p_storage_ref, '')), '');
  if v_ref is null or v_ref <> p_storage_ref then
    raise exception using errcode = '22023', message = 'CASE_BACKFILL_EXTERNALIZATION_REF_INVALID';
  end if;
  if p_content_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'CASE_BACKFILL_EXTERNALIZATION_HASH_INVALID';
  end if;
  if p_content_size is null or p_content_size < 0 or p_content_size > 4194304 then
    raise exception using errcode = '22023', message = 'CASE_BACKFILL_EXTERNALIZATION_SIZE_INVALID';
  end if;
  -- Accept only the one supported externalization contract version: any missing
  -- or different value is refused before a permit is read, minted, or consumed.
  if p_externalization_contract_version is distinct from 'worldcons-artifact-blob-v1' then
    raise exception using errcode = '22023', message = 'CASE_BACKFILL_EXTERNALIZATION_CONTRACT_VERSION_INVALID';
  end if;

  if p_artifact_table = 'source_fetch_artifacts' then
    v_kind := 'bounded_replay_payload';
    if v_ref !~ '^artifacts/fetch/[a-z][a-z0-9._-]{0,79}/[0-9a-f]{64}\.json$' then
      raise exception using errcode = '22023', message = 'CASE_BACKFILL_EXTERNALIZATION_REF_INVALID';
    end if;
    select f.item_id, f.bounded_replay_storage_ref, f.externalization_contract_version,
           f.externalized_at, f.payload_hash, f.payload_size,
           (f.bounded_replay_payload is not null)
    into v_item_id, v_existing_ref, v_existing_version, v_existing_externalized_at,
         v_stored_hash, v_stored_size, v_inline_present
    from source_fetch_artifacts f where f.id = p_artifact_id for update;
  else
    v_kind := 'normalized_output';
    if v_ref !~ '^artifacts/normalization/[a-z][a-z0-9._-]{0,79}/[0-9a-f]{64}\.json$' then
      raise exception using errcode = '22023', message = 'CASE_BACKFILL_EXTERNALIZATION_REF_INVALID';
    end if;
    select n.item_id, n.normalized_output_storage_ref, n.externalization_contract_version,
           n.externalized_at, n.normalized_output_hash, n.normalized_output_size,
           (n.normalized_output is not null)
    into v_item_id, v_existing_ref, v_existing_version, v_existing_externalized_at,
         v_stored_hash, v_stored_size, v_inline_present
    from source_normalization_artifacts n where n.id = p_artifact_id for update;
  end if;
  if not found then
    raise exception using errcode = 'P0001', message = 'CASE_BACKFILL_ARTIFACT_NOT_FOUND';
  end if;

  -- Reruns are idempotent: an identical externalization request returns without
  -- touching the row, and any differing re-point of an externalized row is refused.
  if v_existing_ref is not null or v_existing_version is not null or v_existing_externalized_at is not null then
    if v_existing_ref = v_ref
      and v_existing_version = p_externalization_contract_version
      and v_stored_hash = p_content_hash
    then
      return jsonb_build_object('artifactId', p_artifact_id, 'idempotent', true);
    end if;
    raise exception using errcode = 'P0001', message = 'CASE_BACKFILL_EXTERNALIZATION_CONFLICT';
  end if;

  -- Bind the ref to this artifact's own source key and content hash so the stored
  -- object key can never point at another source or another payload.
  select s.source_key into v_source_key
  from source_backfill_items i
  join source_inventory_snapshots s on s.id = i.snapshot_id
  where i.id = v_item_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'CASE_BACKFILL_ARTIFACT_NOT_FOUND';
  end if;
  v_expected_ref := 'artifacts/'
    || (case when p_artifact_table = 'source_fetch_artifacts' then 'fetch' else 'normalization' end)
    || '/' || v_source_key || '/' || p_content_hash || '.json';
  if v_ref <> v_expected_ref then
    raise exception using errcode = '22023', message = 'CASE_BACKFILL_EXTERNALIZATION_REF_INVALID';
  end if;

  if not v_inline_present then
    raise exception using errcode = 'P0001', message = 'CASE_BACKFILL_EXTERNALIZATION_INLINE_REQUIRED';
  end if;
  if v_stored_hash <> p_content_hash then
    raise exception using errcode = 'P0001', message = 'CASE_BACKFILL_EXTERNALIZATION_HASH_MISMATCH';
  end if;
  if p_artifact_table = 'source_fetch_artifacts' then
    if v_stored_size is distinct from p_content_size then
      raise exception using errcode = 'P0001', message = 'CASE_BACKFILL_EXTERNALIZATION_SIZE_MISMATCH';
    end if;
  elsif v_stored_size is not null and v_stored_size <> p_content_size then
    raise exception using errcode = 'P0001', message = 'CASE_BACKFILL_EXTERNALIZATION_SIZE_MISMATCH';
  end if;

  v_actor := nullif(trim(coalesce(p_actor_id, '')), '');
  if v_actor is not null and length(v_actor) > 160 then
    raise exception using errcode = '22023', message = 'CASE_BACKFILL_EXTERNALIZATION_ACTOR_INVALID';
  end if;

  insert into source_artifact_externalization_permits(
    artifact_table, artifact_id, content_kind, storage_ref, content_hash, content_size,
    externalization_contract_version
  ) values (
    p_artifact_table, p_artifact_id, v_kind, v_ref, p_content_hash, p_content_size,
    p_externalization_contract_version
  )
  on conflict (artifact_table, artifact_id) do update
    set content_kind = excluded.content_kind,
        storage_ref = excluded.storage_ref,
        content_hash = excluded.content_hash,
        content_size = excluded.content_size,
        externalization_contract_version = excluded.externalization_contract_version,
        created_at = now();

  if p_artifact_table = 'source_fetch_artifacts' then
    update source_fetch_artifacts
      set bounded_replay_storage_ref = v_ref,
          externalized_at = now(),
          externalization_contract_version = p_externalization_contract_version
      where id = p_artifact_id;
  else
    update source_normalization_artifacts
      set normalized_output_storage_ref = v_ref,
          normalized_output_size = p_content_size,
          externalized_at = now(),
          externalization_contract_version = p_externalization_contract_version
      where id = p_artifact_id;
  end if;

  insert into source_artifact_externalization_ledger(
    artifact_table, artifact_id, item_id, content_kind, storage_ref, content_hash,
    content_size, externalization_contract_version, actor_type, actor_id
  ) values (
    p_artifact_table, p_artifact_id, v_item_id, v_kind, v_ref, p_content_hash,
    p_content_size, p_externalization_contract_version, 'operator', v_actor
  )
  on conflict (artifact_table, artifact_id, externalization_contract_version) do nothing;

  return jsonb_build_object('artifactId', p_artifact_id, 'idempotent', false);
end;
$function$;

revoke all on table source_artifact_externalization_permits from public;
revoke all on function case_backfill_artifact_externalization_guard_v1() from public;
revoke all on function source_backfill_artifact_externalize_v1(text, uuid, text, text, bigint, text, text) from public;

do $permissions$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on table source_artifact_externalization_permits from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on table source_artifact_externalization_permits from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    -- The permit table stays invisible to every API role; only the security-definer
    -- RPC (owned by the migration role) may mint or consume a permit.
    revoke all on table source_artifact_externalization_permits from service_role;
    revoke all on function case_backfill_artifact_externalization_guard_v1() from service_role;
    grant execute on function source_backfill_artifact_externalize_v1(text, uuid, text, text, bigint, text, text) to service_role;
  end if;
end;
$permissions$;

comment on table source_artifact_externalization_permits is
  'One-time internal permits consumed by the artifact externalization guard; no API role may read or write them.';
comment on function case_backfill_artifact_externalization_guard_v1() is
  'Immutable-guard for fetch/normalization artifacts: permits exactly one externalization attach transition while a matching one-time permit exists; every other update and all deletes stay blocked.';
comment on function source_backfill_artifact_externalize_v1(text, uuid, text, text, bigint, text, text) is
  'M4A externalization RPC: attaches a verified private Blob ref to an inline artifact, preserves inline content, appends the ledger row, and is idempotent for an identical rerun.';

commit;
