begin;

-- Article raw-text externalization guard corrective (M6F): exclude generated columns
-- from whole-row identity comparisons.
--
-- Root cause: article_content_versions_p3.case_key is GENERATED ALWAYS STORED
-- (20260826400000_case_keys_and_ranked_pagination.sql). The M6E guard
-- (20260919180000_article_raw_blob_restore.sql) compared whole rows with
-- to_jsonb(old)/to_jsonb(new) in a BEFORE UPDATE trigger. A generated column is not
-- a valid OLD/NEW identity operand in a BEFORE UPDATE trigger, so including case_key
-- in the whole-row comparisons produced false ARTICLE_RAW_EXTERNALIZATION_IMMUTABLE
-- failures for otherwise valid attach, inline-clear, and inline-restore transitions.
--
-- This migration is a pure forward corrective: it CREATE OR REPLACEs only
-- article_raw_externalization_guard_v1, derives the generated columns dynamically
-- from pg_attribute for tg_relid (attgenerated <> ''), and excludes them from all
-- three whole-row identity checks. It edits no earlier migration, recreates no
-- trigger (the existing binding stays in place), changes no grant or ACL, performs no
-- DML, and performs no table rewrite or compaction. Deriving from pg_attribute keeps
-- the guard correct for any generated column added later, with no hardcoded names.
--
-- Every other M6E guard rule is preserved byte-for-byte in semantics:
--   A. attach (M6B): externalization metadata absent -> present, inline raw_text
--      present and unchanged, every unrelated column byte-identical, matching
--      externalization permit;
--   B. inline clear (M6C): inline raw_text present -> null, every other column
--      byte-identical, matching clear permit and M6B ledger row;
--   C. inline restore (M6E): inline raw_text null -> present, every other column
--      byte-identical, matching restore permit, M6B ledger row, and a restored
--      JSON-string document whose size and SHA-256 equal the recorded Blob.
-- The function signature, SECURITY DEFINER, fixed search_path, and existing ACLs are
-- all preserved by CREATE OR REPLACE.
create or replace function article_raw_externalization_guard_v1()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_meta_columns constant text[] := array[
    'raw_text_storage_ref',
    'raw_text_blob_hash',
    'raw_text_blob_size',
    'raw_text_externalized_at',
    'raw_text_blob_contract_version'
  ];
  v_generated_columns text[];
  v_old_meta jsonb;
  v_new_meta jsonb;
  v_old_raw text;
  v_new_raw text;
  v_new_ref text;
  v_new_hash text;
  v_new_size bigint;
  v_new_version text;
  v_new_externalized_at timestamptz;
  v_permit article_raw_externalization_permits%rowtype;
  v_clear_permit article_raw_inline_clear_permits%rowtype;
  v_restore_permit article_raw_inline_restore_permits%rowtype;
begin
  -- This guard is installed only on article_content_versions_p3; any other target is
  -- refused so a stray attachment can never weaken an unrelated table.
  if tg_table_name <> 'article_content_versions_p3' then
    raise exception using errcode = '55000', message = 'ARTICLE_RAW_EXTERNALIZATION_IMMUTABLE';
  end if;

  if tg_op = 'DELETE' then
    -- Article content versions are append-only.
    raise exception using errcode = '55000', message = 'ARTICLE_RAW_EXTERNALIZATION_IMMUTABLE';
  end if;

  -- Generated columns (for example article_content_versions_p3.case_key,
  -- GENERATED ALWAYS STORED) are not valid OLD/NEW identity operands in a BEFORE
  -- UPDATE trigger, so they are derived for this trigger's own relation and
  -- excluded from every whole-row comparison below.
  select coalesce(array_agg(a.attname order by a.attnum), array[]::text[])
  into v_generated_columns
  from pg_attribute a
  where a.attrelid = tg_relid
    and a.attnum > 0
    and not a.attisdropped
    and a.attgenerated <> '';

  v_old_meta := jsonb_build_object(
    'raw_text_storage_ref', to_jsonb(old) -> 'raw_text_storage_ref',
    'raw_text_blob_hash', to_jsonb(old) -> 'raw_text_blob_hash',
    'raw_text_blob_size', to_jsonb(old) -> 'raw_text_blob_size',
    'raw_text_externalized_at', to_jsonb(old) -> 'raw_text_externalized_at',
    'raw_text_blob_contract_version', to_jsonb(old) -> 'raw_text_blob_contract_version'
  );
  v_new_meta := jsonb_build_object(
    'raw_text_storage_ref', to_jsonb(new) -> 'raw_text_storage_ref',
    'raw_text_blob_hash', to_jsonb(new) -> 'raw_text_blob_hash',
    'raw_text_blob_size', to_jsonb(new) -> 'raw_text_blob_size',
    'raw_text_externalized_at', to_jsonb(new) -> 'raw_text_externalized_at',
    'raw_text_blob_contract_version', to_jsonb(new) -> 'raw_text_blob_contract_version'
  );
  v_old_raw := to_jsonb(old) ->> 'raw_text';
  v_new_raw := to_jsonb(new) ->> 'raw_text';
  -- Operation B (M6C inline clear): the only permitted inline transition is
  -- present -> null, and every other column, including all externalization metadata,
  -- must stay byte-identical. The clear requires a matching one-time permit plus the
  -- M6B append-only ledger row for the exact ref/hash/size/version.
  if v_old_raw is not null and v_new_raw is null then
    if v_old_meta is distinct from v_new_meta then
      raise exception using errcode = '55000', message = 'ARTICLE_RAW_EXTERNALIZATION_IMMUTABLE';
    end if;
    if (to_jsonb(old) - 'raw_text' - v_generated_columns)
      is distinct from (to_jsonb(new) - 'raw_text' - v_generated_columns)
    then
      raise exception using errcode = '55000', message = 'ARTICLE_RAW_EXTERNALIZATION_IMMUTABLE';
    end if;

    v_new_ref := to_jsonb(new) ->> 'raw_text_storage_ref';
    v_new_hash := to_jsonb(new) ->> 'raw_text_blob_hash';
    v_new_size := nullif(to_jsonb(new) ->> 'raw_text_blob_size', '')::bigint;
    v_new_version := to_jsonb(new) ->> 'raw_text_blob_contract_version';
    v_new_externalized_at := nullif(to_jsonb(new) ->> 'raw_text_externalized_at', '')::timestamptz;
    if v_new_ref is null or v_new_hash is null or v_new_size is null
      or v_new_externalized_at is null
      or v_new_version is distinct from 'worldcons-article-raw-blob-v1'
    then
      raise exception using errcode = '55000', message = 'ARTICLE_RAW_EXTERNALIZATION_IMMUTABLE';
    end if;

    select c.* into v_clear_permit
    from article_raw_inline_clear_permits c
    where c.article_table = tg_table_name and c.article_row_id = new.id
    for update;
    if not found then
      raise exception using errcode = '55000', message = 'ARTICLE_RAW_EXTERNALIZATION_IMMUTABLE';
    end if;
    if v_clear_permit.content_kind <> 'raw_text'
      or v_clear_permit.storage_ref <> v_new_ref
      or v_clear_permit.content_hash <> v_new_hash
      or v_clear_permit.content_size is distinct from v_new_size
      or v_clear_permit.externalization_contract_version <> v_new_version
    then
      raise exception using errcode = '55000', message = 'ARTICLE_RAW_EXTERNALIZATION_IMMUTABLE';
    end if;
    if not exists (
      select 1
      from article_raw_externalization_ledger l
      where l.article_table = tg_table_name
        and l.article_row_id = new.id
        and l.content_kind = 'raw_text'
        and l.article_id = new.article_id
        and l.externalization_contract_version = v_new_version
        and l.storage_ref = v_new_ref
        and l.content_hash = v_new_hash
        and l.content_size = v_new_size
    ) then
      raise exception using errcode = '55000', message = 'ARTICLE_RAW_EXTERNALIZATION_IMMUTABLE';
    end if;

    delete from article_raw_inline_clear_permits
    where article_table = tg_table_name and article_row_id = new.id;
    return new;
  end if;

  -- Operation C (M6E inline restore): the only permitted inline transition is
  -- null -> present, and every other column, including all externalization metadata,
  -- must stay byte-identical. The restore requires a matching one-time permit, the
  -- M6B append-only ledger row for the exact ref/hash/size/version, and a restored
  -- value whose JSON-string document size and SHA-256 equal the recorded Blob
  -- size/hash.
  if v_old_raw is null and v_new_raw is not null then
    if v_old_meta is distinct from v_new_meta then
      raise exception using errcode = '55000', message = 'ARTICLE_RAW_EXTERNALIZATION_IMMUTABLE';
    end if;
    if (to_jsonb(old) - 'raw_text' - v_generated_columns)
      is distinct from (to_jsonb(new) - 'raw_text' - v_generated_columns)
    then
      raise exception using errcode = '55000', message = 'ARTICLE_RAW_EXTERNALIZATION_IMMUTABLE';
    end if;

    v_new_ref := to_jsonb(new) ->> 'raw_text_storage_ref';
    v_new_hash := to_jsonb(new) ->> 'raw_text_blob_hash';
    v_new_size := nullif(to_jsonb(new) ->> 'raw_text_blob_size', '')::bigint;
    v_new_version := to_jsonb(new) ->> 'raw_text_blob_contract_version';
    v_new_externalized_at := nullif(to_jsonb(new) ->> 'raw_text_externalized_at', '')::timestamptz;
    if v_new_ref is null or v_new_hash is null or v_new_size is null
      or v_new_externalized_at is null
      or v_new_version is distinct from 'worldcons-article-raw-blob-v1'
    then
      raise exception using errcode = '55000', message = 'ARTICLE_RAW_EXTERNALIZATION_IMMUTABLE';
    end if;
    -- The restored value must reproduce the recorded Blob document: the JSON-string
    -- document size and its SHA-256 must both match the stored size/hash, so a
    -- mismatched or truncated inline copy can never be written back.
    if v_new_size is distinct from octet_length(to_json(v_new_raw)::text)
      or v_new_hash is distinct from
        encode(extensions.digest(convert_to(to_json(v_new_raw)::text, 'UTF8'), 'sha256'), 'hex')
    then
      raise exception using errcode = '55000', message = 'ARTICLE_RAW_EXTERNALIZATION_IMMUTABLE';
    end if;

    select r.* into v_restore_permit
    from article_raw_inline_restore_permits r
    where r.article_table = tg_table_name and r.article_row_id = new.id
    for update;
    if not found then
      raise exception using errcode = '55000', message = 'ARTICLE_RAW_EXTERNALIZATION_IMMUTABLE';
    end if;
    if v_restore_permit.content_kind <> 'raw_text'
      or v_restore_permit.storage_ref <> v_new_ref
      or v_restore_permit.content_hash <> v_new_hash
      or v_restore_permit.content_size is distinct from v_new_size
      or v_restore_permit.externalization_contract_version <> v_new_version
    then
      raise exception using errcode = '55000', message = 'ARTICLE_RAW_EXTERNALIZATION_IMMUTABLE';
    end if;
    if not exists (
      select 1
      from article_raw_externalization_ledger l
      where l.article_table = tg_table_name
        and l.article_row_id = new.id
        and l.content_kind = 'raw_text'
        and l.article_id = new.article_id
        and l.externalization_contract_version = v_new_version
        and l.storage_ref = v_new_ref
        and l.content_hash = v_new_hash
        and l.content_size = v_new_size
    ) then
      raise exception using errcode = '55000', message = 'ARTICLE_RAW_EXTERNALIZATION_IMMUTABLE';
    end if;

    delete from article_raw_inline_restore_permits
    where article_table = tg_table_name and article_row_id = new.id;
    return new;
  end if;

  -- Operation A (M6B attach): metadata changed, so this must be a pure attach with
  -- every non-metadata column byte-identical. Version rows are immutable unless the
  -- externalization metadata changed.
  if v_old_meta is not distinct from v_new_meta then
    raise exception using errcode = '55000', message = 'ARTICLE_RAW_EXTERNALIZATION_IMMUTABLE';
  end if;
  if (to_jsonb(old) - v_meta_columns - v_generated_columns)
    is distinct from (to_jsonb(new) - v_meta_columns - v_generated_columns)
  then
    raise exception using errcode = '55000', message = 'ARTICLE_RAW_EXTERNALIZATION_IMMUTABLE';
  end if;

  -- Inline raw_text is preserved: it must be present before and unchanged by the
  -- attach, so a stray metadata write can never drop or rewrite the inline copy.
  if v_old_raw is null or v_old_raw is distinct from v_new_raw then
    raise exception using errcode = '55000', message = 'ARTICLE_RAW_EXTERNALIZATION_IMMUTABLE';
  end if;
  -- Attach-once only: every externalization column must be absent before, so an
  -- already externalized row can never be re-pointed or cleared.
  if (to_jsonb(old) -> 'raw_text_storage_ref') is distinct from 'null'::jsonb
    or (to_jsonb(old) -> 'raw_text_blob_hash') is distinct from 'null'::jsonb
    or (to_jsonb(old) -> 'raw_text_blob_size') is distinct from 'null'::jsonb
    or (to_jsonb(old) -> 'raw_text_externalized_at') is distinct from 'null'::jsonb
    or (to_jsonb(old) -> 'raw_text_blob_contract_version') is distinct from 'null'::jsonb
  then
    raise exception using errcode = '55000', message = 'ARTICLE_RAW_EXTERNALIZATION_IMMUTABLE';
  end if;

  -- Every externalization column must be fully present after, with the one
  -- supported contract version, so no partial metadata set can ever be stored.
  v_new_ref := to_jsonb(new) ->> 'raw_text_storage_ref';
  v_new_hash := to_jsonb(new) ->> 'raw_text_blob_hash';
  v_new_size := nullif(to_jsonb(new) ->> 'raw_text_blob_size', '')::bigint;
  v_new_version := to_jsonb(new) ->> 'raw_text_blob_contract_version';
  v_new_externalized_at := nullif(to_jsonb(new) ->> 'raw_text_externalized_at', '')::timestamptz;
  if v_new_ref is null or v_new_hash is null or v_new_size is null
    or v_new_version is null or v_new_externalized_at is null
    or v_new_version <> 'worldcons-article-raw-blob-v1'
  then
    raise exception using errcode = '55000', message = 'ARTICLE_RAW_EXTERNALIZATION_IMMUTABLE';
  end if;
  select p.* into v_permit
  from article_raw_externalization_permits p
  where p.article_table = tg_table_name and p.article_row_id = new.id
  for update;
  if not found then
    raise exception using errcode = '55000', message = 'ARTICLE_RAW_EXTERNALIZATION_IMMUTABLE';
  end if;
  if v_permit.content_kind <> 'raw_text'
    or v_permit.storage_ref <> v_new_ref
    or v_permit.content_hash <> v_new_hash
    or v_permit.content_size is distinct from v_new_size
    or v_permit.externalization_contract_version <> v_new_version
  then
    raise exception using errcode = '55000', message = 'ARTICLE_RAW_EXTERNALIZATION_IMMUTABLE';
  end if;

  delete from article_raw_externalization_permits
  where article_table = tg_table_name and article_row_id = new.id;
  return new;
end;
$function$;

commit;
