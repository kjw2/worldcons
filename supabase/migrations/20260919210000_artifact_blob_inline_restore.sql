begin;

-- Gate 1 blob inline restore (rollback for M4B, forward-only). Once M4B has cleared
-- the redundant inline fetch/normalization payload, the only remaining copy is the
-- private, content-addressed Blob object plus the append-only M4A ledger row. This
-- migration adds the single, narrowly scoped way to put that verified inline copy
-- back:
--   1. a third one-time, operation-specific permit table that no API role can read
--      or write;
--   2. an extended artifact immutability guard that now allows exactly three
--      transitions: the M4A externalization attach (externalization metadata
--      absent -> present, inline untouched), the M4B inline clear (inline-present
--      -> inline-null), and the inline restore (inline-null -> inline-present), the
--      latter only while every other column is byte-identical, a matching restore
--      permit exists, and an M4A ledger row for the exact ref/hash/size/version is
--      present;
--   3. a service_role security-definer RPC that locks the row, requires the exact
--      supported contract and the recorded externalization metadata, requires the
--      inline copy to be absent (so only a genuinely cleared row can be restored),
--      requires the caller's parsed inline payload object to be non-null and an
--      object and to equal exactly what the caller's canonical JSON document parses
--      to, independently verifies that document by recomputing its byte length and
--      SHA-256 over the same UTF-8 bytes in the database and requiring them to equal
--      the recorded Blob size/hash, is idempotent on an identical rerun, and refuses
--      repoints and mismatches. The RPC is DRY-RUN BY DEFAULT (p_dry_run boolean
--      default true): with the default it validates every gate and reports what it
--      would restore without minting a permit or mutating a row, and only an
--      explicit p_dry_run = false performs the single permit-guarded restore.
--
-- Restore writes only the redundant inline payload back from a Blob copy that the
-- application has already head/get verified, SHA-256 checked, decoded to its exact
-- canonical JSON document, and re-serialized to the recorded ref/hash/size before
-- the RPC is called. This migration never edits an existing migration, never
-- deletes or writes a Blob object, performs no table rewrite or compaction,
-- retains the M4A attach and M4B clear transitions intact, and leaves no generic
-- bypass: direct updates/deletes stay blocked because service_role holds no table
-- UPDATE/DELETE privilege and cannot mint a permit.

create table if not exists source_artifact_inline_restore_permits (
  artifact_table text not null,
  artifact_id uuid not null,
  content_kind text not null,
  storage_ref text not null,
  content_hash text not null,
  content_size bigint not null,
  externalization_contract_version text not null,
  created_at timestamptz not null default now(),
  primary key (artifact_table, artifact_id),
  constraint source_artifact_inline_restore_permits_table_check check (
    artifact_table in ('source_fetch_artifacts', 'source_normalization_artifacts')
  ),
  constraint source_artifact_inline_restore_permits_kind_check check (
    (artifact_table = 'source_fetch_artifacts' and content_kind = 'bounded_replay_payload')
    or (artifact_table = 'source_normalization_artifacts' and content_kind = 'normalized_output')
  ),
  constraint source_artifact_inline_restore_permits_hash_check check (
    content_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint source_artifact_inline_restore_permits_size_check check (
    content_size between 0 and 4194304
  ),
  constraint source_artifact_inline_restore_permits_contract_check check (
    externalization_contract_version = 'worldcons-artifact-blob-v1'
  ),
  constraint source_artifact_inline_restore_permits_ref_check check (
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

alter table source_artifact_inline_restore_permits enable row level security;

-- Extend the artifact immutability guard to a third, narrowly permitted
-- operation. The trigger bindings are unchanged; this replaces the function body
-- in place. Only three transitions may ever pass:
--   A. externalization attach (M4A): inline untouched, externalization metadata
--      absent -> present, with a matching externalization permit; or
--   B. inline clear (M4B): inline-present -> inline-null, with every other column
--      byte-identical, a matching clear permit, and a matching M4A ledger row; or
--   C. inline restore: inline-null -> inline-present, with every other column
--      byte-identical, a matching restore permit, and a matching M4A ledger row.
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
  v_generated_columns text[];
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
  v_restore_permit source_artifact_inline_restore_permits%rowtype;
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

  -- Generated columns (if any) are not valid OLD/NEW identity operands in a BEFORE
  -- UPDATE trigger, so they are derived for this trigger's own relation and
  -- excluded from every whole-row comparison below.
  select coalesce(array_agg(a.attname order by a.attnum), array[]::text[])
  into v_generated_columns
  from pg_attribute a
  where a.attrelid = tg_relid
    and a.attnum > 0
    and not a.attisdropped
    and a.attgenerated <> '';

  v_old_inline_present := (to_jsonb(old) -> v_inline_column) is distinct from 'null'::jsonb;
  v_new_inline_present := (to_jsonb(new) -> v_inline_column) is distinct from 'null'::jsonb;

  -- Operation A (M4A): the inline column is untouched, so the only permitted
  -- change is absent -> present externalization metadata.
  if (to_jsonb(old) -> v_inline_column) is not distinct from (to_jsonb(new) -> v_inline_column) then
    if (to_jsonb(old) - v_ext_allowed - v_generated_columns)
      is distinct from (to_jsonb(new) - v_ext_allowed - v_generated_columns)
    then
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

  -- Operation C (inline restore): the only permitted inline transition here is
  -- null -> present, with every other column, including all storage ref/hash/size/
  -- contract/externalized metadata, byte-identical. The restore requires a matching
  -- one-time restore permit plus the M4A append-only ledger row for the exact
  -- ref/hash/size/version. The restored document's content is verified against the
  -- recorded Blob size/hash inside the restore RPC before the permit is minted.
  if not v_old_inline_present and v_new_inline_present then
    if (to_jsonb(old) - v_inline_column - v_generated_columns)
      is distinct from (to_jsonb(new) - v_inline_column - v_generated_columns)
    then
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

    select r.* into v_restore_permit
    from source_artifact_inline_restore_permits r
    where r.artifact_table = tg_table_name and r.artifact_id = new.id
    for update;
    if not found then
      raise exception using errcode = '55000', message = 'CASE_BACKFILL_IMMUTABLE';
    end if;
    if v_restore_permit.content_kind <> v_kind
      or v_restore_permit.storage_ref <> v_new_ref
      or v_restore_permit.content_hash <> v_new_hash
      or v_restore_permit.content_size is distinct from v_new_size
      or v_restore_permit.externalization_contract_version <> v_new_version
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

    delete from source_artifact_inline_restore_permits
    where artifact_table = tg_table_name and artifact_id = new.id;
    return new;
  end if;

  -- Operation B (M4B): the only permitted inline transition is present -> null,
  -- and now every other column, including all storage ref/hash/size/contract/
  -- externalized metadata, must be byte-identical.
  if not (v_old_inline_present and not v_new_inline_present) then
    raise exception using errcode = '55000', message = 'CASE_BACKFILL_IMMUTABLE';
  end if;
  if (to_jsonb(old) - v_inline_column - v_generated_columns)
    is distinct from (to_jsonb(new) - v_inline_column - v_generated_columns)
  then
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

-- DRY-RUN-BY-DEFAULT inline restore RPC. It locks the row, requires the M4A
-- metadata and the M4A ledger entry for the exact ref/hash/size/version, requires
-- the caller's parsed inline payload object to be a non-null object and to equal
-- exactly what the caller's canonical JSON document parses to, and recomputes the
-- byte length and SHA-256 of that document over the same UTF-8 bytes, requiring them
-- to equal the recorded Blob size/hash before any row is written. With the default
-- p_dry_run = true it only reports the plan; the inline restore happens solely on an
-- explicit p_dry_run = false, where the one-time restore permit is minted and
-- consumed by the immutable guard.
create or replace function source_backfill_artifact_inline_restore_v1(
  p_artifact_table text,
  p_artifact_id uuid,
  p_inline_payload jsonb,
  p_document text,
  p_storage_ref text,
  p_content_hash text,
  p_content_size bigint,
  p_externalization_contract_version text,
  p_actor_id text,
  p_dry_run boolean default true
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
  v_stored_payload jsonb;
  v_inline_present boolean;
  v_stored_replayability text;
  v_source_key text;
  v_expected_ref text;
  v_actor text;
  v_dry_run boolean := coalesce(p_dry_run, true);
  v_document text;
  v_document_size bigint;
  v_document_hash text;
  v_payload jsonb;
begin
  if p_artifact_table not in ('source_fetch_artifacts', 'source_normalization_artifacts') then
    raise exception using errcode = '22023', message = 'CASE_BACKFILL_INLINE_RESTORE_TABLE_INVALID';
  end if;

  -- Accept only the one supported externalization contract version: any missing or
  -- different value is refused before the row is locked, a permit is minted, or the
  -- inline content is restored.
  if p_externalization_contract_version is distinct from 'worldcons-artifact-blob-v1' then
    raise exception using errcode = '22023', message = 'CASE_BACKFILL_INLINE_RESTORE_CONTRACT_VERSION_INVALID';
  end if;

  v_expected_storage_ref := nullif(trim(coalesce(p_storage_ref, '')), '');
  if v_expected_storage_ref is null or v_expected_storage_ref <> p_storage_ref then
    raise exception using errcode = '22023', message = 'CASE_BACKFILL_INLINE_RESTORE_REF_INVALID';
  end if;
  if p_content_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'CASE_BACKFILL_INLINE_RESTORE_HASH_INVALID';
  end if;
  if p_content_size is null or p_content_size < 0 or p_content_size > 4194304 then
    raise exception using errcode = '22023', message = 'CASE_BACKFILL_INLINE_RESTORE_SIZE_INVALID';
  end if;

  if p_artifact_table = 'source_fetch_artifacts' then
    v_kind := 'bounded_replay_payload';
    if v_expected_storage_ref !~ '^artifacts/fetch/[a-z][a-z0-9._-]{0,79}/[0-9a-f]{64}\.json$' then
      raise exception using errcode = '22023', message = 'CASE_BACKFILL_INLINE_RESTORE_REF_INVALID';
    end if;
  else
    v_kind := 'normalized_output';
    if v_expected_storage_ref !~ '^artifacts/normalization/[a-z][a-z0-9._-]{0,79}/[0-9a-f]{64}\.json$' then
      raise exception using errcode = '22023', message = 'CASE_BACKFILL_INLINE_RESTORE_REF_INVALID';
    end if;
  end if;
  -- The ref must be content-addressed and its trailing hash must already equal the
  -- declared hash, before the row is locked.
  if v_expected_storage_ref !~ ('^artifacts/(fetch|normalization)/[a-z][a-z0-9._-]{0,79}/' || p_content_hash || '\.json$') then
    raise exception using errcode = '22023', message = 'CASE_BACKFILL_INLINE_RESTORE_REF_INVALID';
  end if;

  -- The caller must declare the parsed inline payload object explicitly. A restore
  -- always writes a concrete object; a null or non-object payload is refused before
  -- the row is locked, so a restore can never write a null, scalar, or array value.
  if p_inline_payload is null or jsonb_typeof(p_inline_payload) <> 'object' then
    raise exception using errcode = '22023', message = 'CASE_BACKFILL_INLINE_RESTORE_PAYLOAD_REQUIRED';
  end if;

  -- DB-side document verification. The byte length and SHA-256 are recomputed over
  -- the exact UTF-8 bytes of the caller's canonical JSON document and must equal the
  -- caller's declared size/hash (and therefore the recorded Blob size/hash) before
  -- any row is locked or written. A null document is never a restore.
  v_document := p_document;
  if v_document is null then
    raise exception using errcode = '22023', message = 'CASE_BACKFILL_INLINE_RESTORE_DOCUMENT_REQUIRED';
  end if;
  v_document_size := octet_length(convert_to(v_document, 'UTF8'));
  v_document_hash := encode(extensions.digest(convert_to(v_document, 'UTF8'), 'sha256'), 'hex');
  if v_document_size <> p_content_size or v_document_hash <> p_content_hash then
    raise exception using errcode = '22023', message = 'CASE_BACKFILL_INLINE_RESTORE_CONTENT_MISMATCH';
  end if;
  begin
    v_payload := v_document::jsonb;
  exception
    when others then
      raise exception using errcode = '22023', message = 'CASE_BACKFILL_INLINE_RESTORE_DOCUMENT_INVALID';
  end;
  if v_payload is null or jsonb_typeof(v_payload) <> 'object' then
    raise exception using errcode = '22023', message = 'CASE_BACKFILL_INLINE_RESTORE_DOCUMENT_INVALID';
  end if;

  -- The document must parse to exactly the parsed payload the caller declared, so
  -- the bytes that are measured and hashed can never disagree with the object that
  -- is written back into the inline column.
  if v_payload is distinct from p_inline_payload then
    raise exception using errcode = '22023', message = 'CASE_BACKFILL_INLINE_RESTORE_PAYLOAD_MISMATCH';
  end if;

  v_actor := nullif(trim(coalesce(p_actor_id, '')), '');
  if v_actor is not null and length(v_actor) > 160 then
    raise exception using errcode = '22023', message = 'CASE_BACKFILL_INLINE_RESTORE_ACTOR_INVALID';
  end if;

  if p_artifact_table = 'source_fetch_artifacts' then
    select f.item_id, f.bounded_replay_storage_ref, f.payload_hash, f.payload_size,
           f.externalization_contract_version, f.externalized_at, f.bounded_replay_payload,
           (f.bounded_replay_payload is not null), f.replayability
    into v_item_id, v_stored_ref, v_stored_hash, v_stored_size,
         v_stored_version, v_stored_externalized_at, v_stored_payload, v_inline_present,
         v_stored_replayability
    from source_fetch_artifacts f where f.id = p_artifact_id for update;
  else
    select n.item_id, n.normalized_output_storage_ref, n.normalized_output_hash, n.normalized_output_size,
           n.externalization_contract_version, n.externalized_at, n.normalized_output,
           (n.normalized_output is not null)
    into v_item_id, v_stored_ref, v_stored_hash, v_stored_size,
         v_stored_version, v_stored_externalized_at, v_stored_payload, v_inline_present
    from source_normalization_artifacts n where n.id = p_artifact_id for update;
  end if;
  if not found then
    raise exception using errcode = 'P0001', message = 'CASE_BACKFILL_INLINE_RESTORE_ARTIFACT_NOT_FOUND';
  end if;

  -- A fetch artifact may only be restored while it is still bounded-evidence
  -- replayable. The value is read under the same row lock as the rest of the
  -- artifact, and any other or missing replayability fails closed before the
  -- idempotent, dry-run, permit, and update paths.
  if p_artifact_table = 'source_fetch_artifacts'
    and v_stored_replayability is distinct from 'bounded_evidence'
  then
    raise exception using errcode = 'P0001', message = 'CASE_BACKFILL_INLINE_RESTORE_REPLAYABILITY_INVALID';
  end if;

  -- Require the storage ref/metadata to already be present, exactly as claimed.
  if v_stored_ref is null or v_stored_version is null or v_stored_externalized_at is null then
    raise exception using errcode = 'P0001', message = 'CASE_BACKFILL_INLINE_RESTORE_NOT_EXTERNALIZED';
  end if;
  if v_stored_version <> p_externalization_contract_version then
    raise exception using errcode = 'P0001', message = 'CASE_BACKFILL_INLINE_RESTORE_CONFLICT';
  end if;
  if v_stored_ref is distinct from v_expected_storage_ref
    or v_stored_hash is distinct from p_content_hash
    or v_stored_size is distinct from p_content_size
  then
    raise exception using errcode = 'P0001', message = 'CASE_BACKFILL_INLINE_RESTORE_CONFLICT';
  end if;

  -- Bind the ref to this artifact's own source key and stored hash so the object
  -- key can never point at another source or another payload.
  select s.source_key into v_source_key
  from source_backfill_items i
  join source_inventory_snapshots s on s.id = i.snapshot_id
  where i.id = v_item_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'CASE_BACKFILL_INLINE_RESTORE_ARTIFACT_NOT_FOUND';
  end if;
  v_expected_ref := 'artifacts/'
    || (case when p_artifact_table = 'source_fetch_artifacts' then 'fetch' else 'normalization' end)
    || '/' || v_source_key || '/' || v_stored_hash || '.json';
  if v_stored_ref <> v_expected_ref then
    raise exception using errcode = '22023', message = 'CASE_BACKFILL_INLINE_RESTORE_REF_INVALID';
  end if;

  -- Require the append-only externalization ledger entry for this exact
  -- ref/hash/size/version before the inline content may be restored.
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
    raise exception using errcode = 'P0001', message = 'CASE_BACKFILL_INLINE_RESTORE_LEDGER_MISSING';
  end if;

  -- Idempotent: a row that already carries the identical inline value with exact
  -- metadata, ledger, and DB-verified document returns without a second update and
  -- without minting another permit, in either mode. A conflicting inline value
  -- fails closed rather than being overwritten.
  if v_inline_present then
    if v_stored_payload is not distinct from p_inline_payload then
      return jsonb_build_object(
        'artifactId', p_artifact_id,
        'dryRun', v_dry_run,
        'idempotent', true,
        'restored', false
      );
    end if;
    raise exception using errcode = 'P0001', message = 'CASE_BACKFILL_INLINE_RESTORE_CONFLICT';
  end if;

  -- Dry run (the default): every gate above has passed, so report exactly what an
  -- execute would restore without minting a permit or mutating a single row.
  if v_dry_run then
    return jsonb_build_object(
      'artifactId', p_artifact_id,
      'dryRun', true,
      'idempotent', false,
      'wouldRestore', true
    );
  end if;

  insert into source_artifact_inline_restore_permits(
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

  -- Restore only the redundant inline payload, writing the exact parsed payload the
  -- caller declared (which the document above was required to match); no
  -- externalization metadata is repointed. The guard consumes the permit and requires
  -- every other column to be byte-identical.
  if p_artifact_table = 'source_fetch_artifacts' then
    update source_fetch_artifacts set bounded_replay_payload = p_inline_payload where id = p_artifact_id;
  else
    update source_normalization_artifacts set normalized_output = p_inline_payload where id = p_artifact_id;
  end if;

  return jsonb_build_object(
    'artifactId', p_artifact_id,
    'dryRun', false,
    'idempotent', false,
    'restored', true
  );
end;
$function$;

revoke all on table source_artifact_inline_restore_permits from public;
revoke all on function case_backfill_artifact_externalization_guard_v1() from public;
revoke all on function source_backfill_artifact_inline_restore_v1(text, uuid, jsonb, text, text, text, bigint, text, text, boolean) from public;

do $permissions$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on table source_artifact_inline_restore_permits from anon;
    revoke all on function source_backfill_artifact_inline_restore_v1(text, uuid, jsonb, text, text, text, bigint, text, text, boolean) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on table source_artifact_inline_restore_permits from authenticated;
    revoke all on function source_backfill_artifact_inline_restore_v1(text, uuid, jsonb, text, text, text, bigint, text, text, boolean) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    -- The restore permit table stays invisible to every API role; only the
    -- security-definer RPC (owned by the migration role) may mint or consume a
    -- permit. No table UPDATE/DELETE grant is ever issued.
    revoke all on table source_artifact_inline_restore_permits from service_role;
    revoke all on function case_backfill_artifact_externalization_guard_v1() from service_role;
    grant execute on function source_backfill_artifact_inline_restore_v1(text, uuid, jsonb, text, text, text, bigint, text, text, boolean) to service_role;
  end if;
end;
$permissions$;

comment on table source_artifact_inline_restore_permits is
  'One-time internal permits consumed by the artifact inline-restore guard; no API role may read or write them.';
comment on function case_backfill_artifact_externalization_guard_v1() is
  'Attach/clear/restore guard for fetch/normalization artifacts: permits exactly one M4A externalization attach while inline content is preserved, exactly one M4B inline clear while every other column is byte-identical, and exactly one inline restore (inline-null -> present) while every other column is byte-identical and a matching restore permit and M4A ledger row exist; every other update and all deletes stay blocked.';
comment on function source_backfill_artifact_inline_restore_v1(text, uuid, jsonb, text, text, text, bigint, text, text, boolean) is
  'Inline-restore RPC: requires a non-null object payload that exactly equals what the canonical JSON document parses to, verifies the recorded externalized ref/hash/size/version, the M4A ledger entry, and the database-recomputed byte length and SHA-256 of that document over its UTF-8 bytes, then restores the redundant inline payload in a single permit-guarded transition; p_dry_run defaults to true so nothing is restored without an explicit p_dry_run = false, an identical rerun is idempotent, and conflicting inline content fails closed.';

commit;
