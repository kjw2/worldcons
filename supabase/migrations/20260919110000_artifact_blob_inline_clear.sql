begin;

-- Gate 1 blob inline clear (M4B): after M4A has proven an inline fetch/normalization
-- artifact is durably externalized to private Blob, clear the redundant inline
-- payload. This migration adds:
--   1. a second one-time operation-specific permit table that no API role can
--      read or write;
--   2. an extended immutability guard that now allows exactly two transitions:
--      the M4A externalization attach (absent -> present externalization metadata)
--      and the M4B inline clear (inline-present -> inline-null), the latter only
--      while a matching clear permit exists and every other column is unchanged;
--   3. a service_role security-definer RPC that locks the row, requires the exact
--      supported contract, requires a matching append-only externalization ledger
--      entry, requires inline content present, is idempotent on an identical
--      rerun, and refuses repoints/mismatches.
-- It never edits an existing migration, never deletes a Blob object, performs no
-- table rewrite or compaction, and leaves no generic bypass: direct
-- updates/deletes stay blocked because service_role holds no table UPDATE/DELETE
-- privilege and cannot mint a permit.

create table if not exists source_artifact_inline_clear_permits (
  artifact_table text not null,
  artifact_id uuid not null,
  content_kind text not null,
  storage_ref text not null,
  content_hash text not null,
  content_size bigint not null,
  externalization_contract_version text not null,
  created_at timestamptz not null default now(),
  primary key (artifact_table, artifact_id),
  constraint source_artifact_inline_clear_permits_table_check check (
    artifact_table in ('source_fetch_artifacts', 'source_normalization_artifacts')
  ),
  constraint source_artifact_inline_clear_permits_kind_check check (
    (artifact_table = 'source_fetch_artifacts' and content_kind = 'bounded_replay_payload')
    or (artifact_table = 'source_normalization_artifacts' and content_kind = 'normalized_output')
  ),
  constraint source_artifact_inline_clear_permits_hash_check check (
    content_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint source_artifact_inline_clear_permits_size_check check (
    content_size between 0 and 4194304
  ),
  constraint source_artifact_inline_clear_permits_contract_check check (
    externalization_contract_version = 'worldcons-artifact-blob-v1'
  ),
  constraint source_artifact_inline_clear_permits_ref_check check (
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

alter table source_artifact_inline_clear_permits enable row level security;

-- Extend the artifact immutability guard to a second, narrowly permitted
-- operation. The trigger bindings are unchanged; this replaces the function body
-- in place. Only two transitions may ever pass:
--   A. externalization attach (M4A): inline untouched, externalization metadata
--      absent -> present, with a matching externalization permit; or
--   B. inline clear (M4B): inline-present -> inline-null, with every other column
--      byte-identical and a matching clear permit plus externalization ledger row.
-- Everything else, including any delete, raises CASE_BACKFILL_IMMUTABLE.
create or replace function case_backfill_artifact_externalization_guard_v1()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $function$
declare
  v_ref_column text;
  v_hash_column text;
  v_size_column text;
  v_inline_column text;
  v_kind text;
  v_ext_allowed text[];
  v_old_inline_present boolean;
  v_new_inline_present boolean;
  v_old_ref text;
  v_new_ref text;
  v_new_hash text;
  v_new_size bigint;
  v_old_version text;
  v_new_version text;
  v_old_externalized_at timestamptz;
  v_new_externalized_at timestamptz;
  v_permit source_artifact_externalization_permits%rowtype;
  v_clear_permit source_artifact_inline_clear_permits%rowtype;
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '55000', message = 'CASE_BACKFILL_IMMUTABLE';
  end if;

  if tg_table_name = 'source_fetch_artifacts' then
    v_ref_column := 'bounded_replay_storage_ref';
    v_hash_column := 'payload_hash';
    v_size_column := 'payload_size';
    v_inline_column := 'bounded_replay_payload';
    v_kind := 'bounded_replay_payload';
    v_ext_allowed := array['bounded_replay_storage_ref', 'externalized_at', 'externalization_contract_version'];
  elsif tg_table_name = 'source_normalization_artifacts' then
    v_ref_column := 'normalized_output_storage_ref';
    v_hash_column := 'normalized_output_hash';
    v_size_column := 'normalized_output_size';
    v_inline_column := 'normalized_output';
    v_kind := 'normalized_output';
    v_ext_allowed := array['normalized_output_storage_ref', 'normalized_output_size', 'externalized_at', 'externalization_contract_version'];
  else
    raise exception using errcode = '55000', message = 'CASE_BACKFILL_IMMUTABLE';
  end if;

  v_old_inline_present := (to_jsonb(old) -> v_inline_column) is distinct from 'null'::jsonb;
  v_new_inline_present := (to_jsonb(new) -> v_inline_column) is distinct from 'null'::jsonb;

  -- Operation A (M4A): the inline column is untouched, so the only permitted
  -- change is absent -> present externalization metadata.
  if (to_jsonb(old) -> v_inline_column) is not distinct from (to_jsonb(new) -> v_inline_column) then
    if (to_jsonb(old) - v_ext_allowed) is distinct from (to_jsonb(new) - v_ext_allowed) then
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

    -- Attach-once only: an already externalized row must never be rewritten, and
    -- the transition must add (not remove, not re-point) the externalization
    -- metadata.
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
  end if;

  -- Operation B (M4B): the only permitted inline transition is present -> null,
  -- and now every other column, including all storage ref/hash/size/contract/
  -- externalized metadata, must be byte-identical.
  if not (v_old_inline_present and not v_new_inline_present) then
    raise exception using errcode = '55000', message = 'CASE_BACKFILL_IMMUTABLE';
  end if;
  if (to_jsonb(old) - v_inline_column) is distinct from (to_jsonb(new) - v_inline_column) then
    raise exception using errcode = '55000', message = 'CASE_BACKFILL_IMMUTABLE';
  end if;

  v_new_ref := (to_jsonb(new) ->> v_ref_column);
  v_new_hash := (to_jsonb(new) ->> v_hash_column);
  v_new_size := nullif(to_jsonb(new) ->> v_size_column, '')::bigint;
  v_new_version := (to_jsonb(new) ->> 'externalization_contract_version');
  v_new_externalized_at := nullif(to_jsonb(new) ->> 'externalized_at', '')::timestamptz;

  if v_new_ref is null or v_new_hash is null or v_new_size is null
    or v_new_externalized_at is null
    or v_new_version is distinct from 'worldcons-artifact-blob-v1'
  then
    raise exception using errcode = '55000', message = 'CASE_BACKFILL_IMMUTABLE';
  end if;

  select c.* into v_clear_permit
  from source_artifact_inline_clear_permits c
  where c.artifact_table = tg_table_name and c.artifact_id = new.id
  for update;
  if not found then
    raise exception using errcode = '55000', message = 'CASE_BACKFILL_IMMUTABLE';
  end if;
  if v_clear_permit.content_kind <> v_kind
    or v_clear_permit.storage_ref <> v_new_ref
    or v_clear_permit.content_hash <> v_new_hash
    or v_clear_permit.content_size is distinct from v_new_size
    or v_clear_permit.externalization_contract_version <> v_new_version
  then
    raise exception using errcode = '55000', message = 'CASE_BACKFILL_IMMUTABLE';
  end if;

  if not exists (
    select 1
    from source_artifact_externalization_ledger l
    where l.artifact_table = tg_table_name
      and l.artifact_id = new.id
      and l.externalization_contract_version = v_new_version
      and l.storage_ref = v_new_ref
      and l.content_hash = v_new_hash
      and l.content_size = v_new_size
  ) then
    raise exception using errcode = '55000', message = 'CASE_BACKFILL_IMMUTABLE';
  end if;

  delete from source_artifact_inline_clear_permits
  where artifact_table = tg_table_name and artifact_id = new.id;
  return new;
end;
$function$;

create or replace function source_backfill_artifact_inline_clear_v1(
  p_artifact_table text,
  p_artifact_id uuid,
  p_expected_storage_ref text,
  p_expected_content_hash text,
  p_expected_content_size bigint,
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
  v_kind text;
  v_expected_storage_ref text;
  v_stored_ref text;
  v_stored_hash text;
  v_stored_size bigint;
  v_stored_version text;
  v_stored_externalized_at timestamptz;
  v_inline_present boolean;
  v_source_key text;
  v_expected_ref text;
  v_actor text;
begin
  if p_artifact_table not in ('source_fetch_artifacts', 'source_normalization_artifacts') then
    raise exception using errcode = '22023', message = 'CASE_BACKFILL_INLINE_CLEAR_TABLE_INVALID';
  end if;

  -- Accept only the one supported externalization contract version: any missing or
  -- different value is refused before the row is locked, a permit is minted, or the
  -- inline content is cleared.
  if p_externalization_contract_version is distinct from 'worldcons-artifact-blob-v1' then
    raise exception using errcode = '22023', message = 'CASE_BACKFILL_INLINE_CLEAR_CONTRACT_VERSION_INVALID';
  end if;

  v_expected_storage_ref := nullif(trim(coalesce(p_expected_storage_ref, '')), '');
  if v_expected_storage_ref is null or v_expected_storage_ref <> p_expected_storage_ref then
    raise exception using errcode = '22023', message = 'CASE_BACKFILL_INLINE_CLEAR_REF_INVALID';
  end if;
  if p_expected_content_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'CASE_BACKFILL_INLINE_CLEAR_HASH_INVALID';
  end if;
  if p_expected_content_size is null or p_expected_content_size < 0 or p_expected_content_size > 4194304 then
    raise exception using errcode = '22023', message = 'CASE_BACKFILL_INLINE_CLEAR_SIZE_INVALID';
  end if;

  if p_artifact_table = 'source_fetch_artifacts' then
    v_kind := 'bounded_replay_payload';
    if v_expected_storage_ref !~ '^artifacts/fetch/[a-z][a-z0-9._-]{0,79}/[0-9a-f]{64}\.json$' then
      raise exception using errcode = '22023', message = 'CASE_BACKFILL_INLINE_CLEAR_REF_INVALID';
    end if;
    select f.item_id, f.bounded_replay_storage_ref, f.payload_hash, f.payload_size,
           f.externalization_contract_version, f.externalized_at,
           (f.bounded_replay_payload is not null)
    into v_item_id, v_stored_ref, v_stored_hash, v_stored_size,
         v_stored_version, v_stored_externalized_at, v_inline_present
    from source_fetch_artifacts f where f.id = p_artifact_id for update;
  else
    v_kind := 'normalized_output';
    if v_expected_storage_ref !~ '^artifacts/normalization/[a-z][a-z0-9._-]{0,79}/[0-9a-f]{64}\.json$' then
      raise exception using errcode = '22023', message = 'CASE_BACKFILL_INLINE_CLEAR_REF_INVALID';
    end if;
    select n.item_id, n.normalized_output_storage_ref, n.normalized_output_hash, n.normalized_output_size,
           n.externalization_contract_version, n.externalized_at,
           (n.normalized_output is not null)
    into v_item_id, v_stored_ref, v_stored_hash, v_stored_size,
         v_stored_version, v_stored_externalized_at, v_inline_present
    from source_normalization_artifacts n where n.id = p_artifact_id for update;
  end if;
  if not found then
    raise exception using errcode = 'P0001', message = 'CASE_BACKFILL_INLINE_CLEAR_ARTIFACT_NOT_FOUND';
  end if;

  -- Require the storage ref/metadata to already be present, exactly as claimed.
  if v_stored_ref is null or v_stored_version is null or v_stored_externalized_at is null then
    raise exception using errcode = 'P0001', message = 'CASE_BACKFILL_INLINE_CLEAR_NOT_EXTERNALIZED';
  end if;
  if v_stored_version <> p_externalization_contract_version then
    raise exception using errcode = 'P0001', message = 'CASE_BACKFILL_INLINE_CLEAR_CONFLICT';
  end if;
  if v_stored_ref is distinct from v_expected_storage_ref
    or v_stored_hash is distinct from p_expected_content_hash
    or v_stored_size is distinct from p_expected_content_size
  then
    raise exception using errcode = 'P0001', message = 'CASE_BACKFILL_INLINE_CLEAR_CONFLICT';
  end if;

  -- Bind the ref to this artifact's own source key and content hash so the stored
  -- object key can never point at another source or another payload.
  select s.source_key into v_source_key
  from source_backfill_items i
  join source_inventory_snapshots s on s.id = i.snapshot_id
  where i.id = v_item_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'CASE_BACKFILL_INLINE_CLEAR_ARTIFACT_NOT_FOUND';
  end if;
  v_expected_ref := 'artifacts/'
    || (case when p_artifact_table = 'source_fetch_artifacts' then 'fetch' else 'normalization' end)
    || '/' || v_source_key || '/' || v_stored_hash || '.json';
  if v_stored_ref <> v_expected_ref then
    raise exception using errcode = '22023', message = 'CASE_BACKFILL_INLINE_CLEAR_REF_INVALID';
  end if;

  -- Require the append-only externalization ledger entry for this exact
  -- ref/hash/size/version before the inline content may be dropped.
  if not exists (
    select 1
    from source_artifact_externalization_ledger l
    where l.artifact_table = p_artifact_table
      and l.artifact_id = p_artifact_id
      and l.externalization_contract_version = v_stored_version
      and l.storage_ref = v_stored_ref
      and l.content_hash = v_stored_hash
      and l.content_size = v_stored_size
  ) then
    raise exception using errcode = 'P0001', message = 'CASE_BACKFILL_INLINE_CLEAR_LEDGER_MISSING';
  end if;

  -- Idempotent: an already cleared row with identical metadata returns without a
  -- second update and without minting another permit.
  if not v_inline_present then
    return jsonb_build_object('artifactId', p_artifact_id, 'idempotent', true);
  end if;

  v_actor := nullif(trim(coalesce(p_actor_id, '')), '');
  if v_actor is not null and length(v_actor) > 160 then
    raise exception using errcode = '22023', message = 'CASE_BACKFILL_INLINE_CLEAR_ACTOR_INVALID';
  end if;

  insert into source_artifact_inline_clear_permits(
    artifact_table, artifact_id, content_kind, storage_ref, content_hash, content_size,
    externalization_contract_version
  ) values (
    p_artifact_table, p_artifact_id, v_kind, v_stored_ref, v_stored_hash, v_stored_size,
    v_stored_version
  )
  on conflict (artifact_table, artifact_id) do update
    set content_kind = excluded.content_kind,
        storage_ref = excluded.storage_ref,
        content_hash = excluded.content_hash,
        content_size = excluded.content_size,
        externalization_contract_version = excluded.externalization_contract_version,
        created_at = now();

  if p_artifact_table = 'source_fetch_artifacts' then
    update source_fetch_artifacts set bounded_replay_payload = null where id = p_artifact_id;
  else
    update source_normalization_artifacts set normalized_output = null where id = p_artifact_id;
  end if;

  return jsonb_build_object('artifactId', p_artifact_id, 'idempotent', false);
end;
$function$;

revoke all on table source_artifact_inline_clear_permits from public;
revoke all on function case_backfill_artifact_externalization_guard_v1() from public;
revoke all on function source_backfill_artifact_inline_clear_v1(text, uuid, text, text, bigint, text, text) from public;

do $permissions$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on table source_artifact_inline_clear_permits from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on table source_artifact_inline_clear_permits from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    -- The clear permit table stays invisible to every API role; only the
    -- security-definer RPC (owned by the migration role) may mint or consume a
    -- permit. No table UPDATE/DELETE grant is ever issued.
    revoke all on table source_artifact_inline_clear_permits from service_role;
    revoke all on function case_backfill_artifact_externalization_guard_v1() from service_role;
    grant execute on function source_backfill_artifact_inline_clear_v1(text, uuid, text, text, bigint, text, text) to service_role;
  end if;
end;
$permissions$;

comment on table source_artifact_inline_clear_permits is
  'One-time internal permits consumed by the artifact inline-clear guard; no API role may read or write them.';
comment on function source_backfill_artifact_inline_clear_v1(text, uuid, text, text, bigint, text, text) is
  'M4B inline-clear RPC: verifies the externalized ref/hash/size/version and ledger entry, then clears the redundant inline payload in a single permit-guarded transition; idempotent for an identical rerun.';

commit;
