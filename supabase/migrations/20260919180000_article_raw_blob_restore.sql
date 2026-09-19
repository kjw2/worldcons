begin;

-- Article raw-text Blob restore (M6E): the safe rollback path for M6C. Once M6C has
-- cleared the inline raw_text, the only remaining copy is the private,
-- content-addressed Blob object plus the append-only M6B ledger row. This migration
-- adds the single, narrowly scoped way to put that verified inline copy back:
--   1. a third one-time, operation-specific permit table scoped to
--      article_content_versions_p3 that no API role can read or write;
--   2. an extended immutability guard for article_content_versions_p3 that now
--      allows exactly three transitions: the M6B attach (metadata absent -> present,
--      inline raw_text untouched), the M6C clear (inline-present -> inline-null), and
--      the M6E restore (inline-null -> inline-present), the latter only while every
--      other column is byte-identical, a matching restore permit exists, an M6B
--      ledger row for the exact ref/hash/size/version is present, and the restored
--      value's JSON-string document size and SHA-256 match the recorded Blob
--      size/hash;
--   3. a service_role security-definer RPC that locks the row, requires the exact
--      supported contract, requires the M6B ledger entry, requires the inline copy
--      to be absent (so only a genuinely cleared row can be restored), recomputes
--      the JSON-string document size and SHA-256 in the database and requires them
--      to equal the recorded Blob size/hash, is idempotent on an identical rerun,
--      and refuses repoints and mismatches. The RPC is DRY-RUN BY DEFAULT
--      (p_dry_run boolean default true): with the default it validates every gate
--      and reports what it would restore without minting a permit or mutating a
--      row, and only an explicit p_dry_run = false performs the single
--      permit-guarded restore;
--   4. a read-only, service_role-only RPC that returns the bounded blob-only
--      candidate projection (rows with no inline raw_text) for both carriers, so the
--      restore CLI can enumerate exactly the cleared rows without ever receiving a
--      direct raw-column table grant.
--
-- Restore writes only the redundant inline raw_text back from a Blob copy that the
-- application has already head/get verified, SHA-256 checked, decoded, and re-encoded
-- to the exact recorded ref/hash/size before the RPC is called. This migration never
-- edits an existing migration, never deletes or writes a Blob object, never touches
-- cleaned_text, search_vector, or any search path, performs no table rewrite or
-- compaction, and leaves no generic bypass: direct updates/deletes stay blocked
-- because service_role holds no table UPDATE/DELETE privilege on the version table
-- and cannot mint a permit. public.articles is mutable and deliberately carries no
-- trigger (exactly as in M6B/M6C), so its raw_text is restored only through this
-- narrow security-definer RPC, which requires the M6A contract and the M6B ledger
-- first.

create table if not exists article_raw_inline_restore_permits (
  article_table text not null,
  article_row_id uuid not null,
  content_kind text not null,
  storage_ref text not null,
  content_hash text not null,
  content_size bigint not null,
  externalization_contract_version text not null,
  created_at timestamptz not null default now(),
  primary key (article_table, article_row_id),
  constraint article_raw_inline_restore_permits_table_check check (
    article_table = 'article_content_versions_p3'
  ),
  constraint article_raw_inline_restore_permits_kind_check check (
    content_kind = 'raw_text'
  ),
  constraint article_raw_inline_restore_permits_hash_check check (
    content_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint article_raw_inline_restore_permits_size_check check (
    content_size between 0 and 4194304
  ),
  constraint article_raw_inline_restore_permits_contract_check check (
    externalization_contract_version = 'worldcons-article-raw-blob-v1'
  ),
  constraint article_raw_inline_restore_permits_ref_check check (
    storage_ref ~ '^artifacts/article_raw/[a-z][a-z0-9._-]{0,79}/[0-9a-f]{64}\.json$'
    and length(storage_ref) between 1 and 500
    and storage_ref !~* '(token|secret|signature|credential)'
  )
);

alter table article_raw_inline_restore_permits enable row level security;

-- Extend the M6B/M6C attach/clear guard to a third, narrowly permitted operation.
-- The trigger binding is unchanged; this replaces the function body in place. Only
-- three transitions may ever pass:
--   A. externalization attach (M6B): inline raw_text untouched, externalization
--      metadata absent -> present, with a matching externalization permit; or
--   B. inline clear (M6C): inline raw_text present -> null, with every other column
--      byte-identical, a matching clear permit, and a matching M6B ledger row; or
--   C. inline restore (M6E): inline raw_text null -> present, with every other column
--      byte-identical, a matching restore permit, a matching M6B ledger row, and a
--      restored value whose JSON-string document size and SHA-256 equal the recorded
--      Blob size/hash.
-- Everything else, including any delete, raises ARTICLE_RAW_EXTERNALIZATION_IMMUTABLE.
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
    if (to_jsonb(old) - 'raw_text') is distinct from (to_jsonb(new) - 'raw_text') then
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
    if (to_jsonb(old) - 'raw_text') is distinct from (to_jsonb(new) - 'raw_text') then
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
  if (to_jsonb(old) - v_meta_columns) is distinct from (to_jsonb(new) - v_meta_columns) then
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

-- DRY-RUN-BY-DEFAULT inline restore RPC. It locks the row, requires the M6A
-- metadata and the M6B ledger entry for the exact ref/hash/size/version, recomputes
-- the JSON-string document size and SHA-256 in the database, and requires them to
-- equal the recorded Blob size/hash. With the default p_dry_run = true it only
-- reports the plan; the inline restore happens solely on an explicit
-- p_dry_run = false, where article_content_versions_p3 mints and consumes the
-- one-time restore permit and public.articles is restored directly by this
-- security-definer RPC with no trigger involved.
create or replace function article_raw_restore_inline_v1(
  p_article_table text,
  p_article_row_id uuid,
  p_raw_text text,
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
set search_path = public, pg_temp
as $function$
declare
  v_ref text;
  v_expected_ref text;
  v_source_key text;
  v_article_id uuid;
  v_stored_raw text;
  v_stored_ref text;
  v_stored_hash text;
  v_stored_size bigint;
  v_stored_version text;
  v_stored_externalized_at timestamptz;
  v_inline_present boolean;
  v_actor text;
  v_dry_run boolean := coalesce(p_dry_run, true);
  v_document text;
  v_document_size bigint;
  v_document_hash text;
begin
  if p_article_table not in ('articles', 'article_content_versions_p3') then
    raise exception using errcode = '22023', message = 'ARTICLE_RAW_RESTORE_TABLE_INVALID';
  end if;
  -- A restore always writes a concrete inline value; a null payload is never a
  -- restore and is refused before the row is locked.
  if p_raw_text is null then
    raise exception using errcode = '22023', message = 'ARTICLE_RAW_RESTORE_CONTENT_REQUIRED';
  end if;
  -- Accept only the one supported externalization contract version: any missing or
  -- different value is refused before the row is locked, a permit is minted, or the
  -- inline content is restored.
  if p_externalization_contract_version is distinct from 'worldcons-article-raw-blob-v1' then
    raise exception using errcode = '22023', message = 'ARTICLE_RAW_RESTORE_CONTRACT_VERSION_INVALID';
  end if;

  v_ref := nullif(trim(coalesce(p_storage_ref, '')), '');
  if v_ref is null or v_ref <> p_storage_ref then
    raise exception using errcode = '22023', message = 'ARTICLE_RAW_RESTORE_REF_INVALID';
  end if;
  if p_content_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'ARTICLE_RAW_RESTORE_HASH_INVALID';
  end if;
  if p_content_size is null or p_content_size < 0 or p_content_size > 4194304 then
    raise exception using errcode = '22023', message = 'ARTICLE_RAW_RESTORE_SIZE_INVALID';
  end if;
  -- The ref must be content-addressed and its trailing hash must already equal the
  -- declared hash, before the row is locked.
  if v_ref !~ '^artifacts/article_raw/[a-z][a-z0-9._-]{0,79}/[0-9a-f]{64}\.json$'
    or v_ref !~ ('^artifacts/article_raw/[a-z][a-z0-9._-]{0,79}/' || p_content_hash || '\.json$')
  then
    raise exception using errcode = '22023', message = 'ARTICLE_RAW_RESTORE_REF_INVALID';
  end if;
  v_actor := nullif(trim(coalesce(p_actor_id, '')), '');
  if v_actor is not null and length(v_actor) > 160 then
    raise exception using errcode = '22023', message = 'ARTICLE_RAW_RESTORE_ACTOR_INVALID';
  end if;

  -- DB-side document verification: recompute the JSON-string document size and
  -- SHA-256 that the Blob object must hold for this exact raw_text and require them
  -- to equal the caller's declared size/hash before any row is locked or written.
  v_document := to_json(p_raw_text)::text;
  v_document_size := octet_length(v_document);
  v_document_hash := encode(extensions.digest(convert_to(v_document, 'UTF8'), 'sha256'), 'hex');
  if v_document_size <> p_content_size or v_document_hash <> p_content_hash then
    raise exception using errcode = '22023', message = 'ARTICLE_RAW_RESTORE_CONTENT_MISMATCH';
  end if;

  if p_article_table = 'articles' then
    select a.source_key, a.raw_text, a.raw_text_storage_ref, a.raw_text_blob_hash,
           a.raw_text_blob_size, a.raw_text_blob_contract_version,
           a.raw_text_externalized_at, (a.raw_text is not null), a.id
    into v_source_key, v_stored_raw, v_stored_ref, v_stored_hash,
         v_stored_size, v_stored_version, v_stored_externalized_at, v_inline_present, v_article_id
    from articles a where a.id = p_article_row_id for update;
  else
    select v.source_key, v.raw_text, v.raw_text_storage_ref, v.raw_text_blob_hash,
           v.raw_text_blob_size, v.raw_text_blob_contract_version,
           v.raw_text_externalized_at, (v.raw_text is not null), v.article_id
    into v_source_key, v_stored_raw, v_stored_ref, v_stored_hash,
         v_stored_size, v_stored_version, v_stored_externalized_at, v_inline_present, v_article_id
    from article_content_versions_p3 v where v.id = p_article_row_id for update;
  end if;
  if not found then
    raise exception using errcode = 'P0001', message = 'ARTICLE_RAW_RESTORE_ROW_NOT_FOUND';
  end if;
  -- Require the M6A externalization metadata to already be present, exactly as
  -- claimed, before any inline content may be restored.
  if v_stored_ref is null or v_stored_hash is null or v_stored_size is null
    or v_stored_version is null or v_stored_externalized_at is null
  then
    raise exception using errcode = 'P0001', message = 'ARTICLE_RAW_RESTORE_NOT_EXTERNALIZED';
  end if;
  if v_stored_version <> p_externalization_contract_version then
    raise exception using errcode = 'P0001', message = 'ARTICLE_RAW_RESTORE_CONFLICT';
  end if;
  if v_stored_ref is distinct from v_ref
    or v_stored_hash is distinct from p_content_hash
    or v_stored_size is distinct from p_content_size
  then
    raise exception using errcode = 'P0001', message = 'ARTICLE_RAW_RESTORE_CONFLICT';
  end if;
  -- Bind the ref to this row's own source key and stored hash so the object key can
  -- never point at another source or another payload.
  if v_source_key is null or v_source_key !~ '^[a-z][a-z0-9._-]{0,79}$' then
    raise exception using errcode = 'P0001', message = 'ARTICLE_RAW_RESTORE_REF_INVALID';
  end if;
  v_expected_ref := 'artifacts/article_raw/' || v_source_key || '/' || v_stored_hash || '.json';
  if v_stored_ref <> v_expected_ref then
    raise exception using errcode = '22023', message = 'ARTICLE_RAW_RESTORE_REF_INVALID';
  end if;

  -- Require the M6B append-only ledger entry for this exact ref/hash/size/version
  -- before the inline content may be restored.
  if not exists (
    select 1
    from article_raw_externalization_ledger l
    where l.article_table = p_article_table
      and l.article_row_id = p_article_row_id
      and l.content_kind = 'raw_text'
      and l.article_id = v_article_id
      and l.externalization_contract_version = v_stored_version
      and l.storage_ref = v_stored_ref
      and l.content_hash = v_stored_hash
      and l.content_size = v_stored_size
  ) then
    raise exception using errcode = 'P0001', message = 'ARTICLE_RAW_RESTORE_LEDGER_MISSING';
  end if;

  -- Idempotent: a row that already carries the identical inline value with exact
  -- metadata, ledger, and DB-recomputed size/hash returns without a second update
  -- and without minting another permit, in either mode. A conflicting inline value
  -- fails closed rather than being overwritten.
  if v_inline_present then
    if v_stored_raw is not distinct from p_raw_text then
      return jsonb_build_object(
        'articleTable', p_article_table,
        'articleRowId', p_article_row_id,
        'dryRun', v_dry_run,
        'idempotent', true,
        'restored', false
      );
    end if;
    raise exception using errcode = 'P0001', message = 'ARTICLE_RAW_RESTORE_CONFLICT';
  end if;

  -- Dry run (the default): every gate above has passed, so report exactly what an
  -- execute would restore without minting a permit or mutating a single row.
  if v_dry_run then
    return jsonb_build_object(
      'articleTable', p_article_table,
      'articleRowId', p_article_row_id,
      'dryRun', true,
      'idempotent', false,
      'wouldRestore', true
    );
  end if;
  -- Only article_content_versions_p3 mints a one-time permit consumed by the
  -- immutable guard; articles are restored directly by this security-definer RPC.
  if p_article_table = 'article_content_versions_p3' then
    insert into article_raw_inline_restore_permits(
      article_table, article_row_id, content_kind, storage_ref, content_hash, content_size,
      externalization_contract_version
    ) values (
      p_article_table, p_article_row_id, 'raw_text', v_stored_ref, v_stored_hash, v_stored_size,
      v_stored_version
    )
    on conflict (article_table, article_row_id) do update
      set content_kind = excluded.content_kind,
          storage_ref = excluded.storage_ref,
          content_hash = excluded.content_hash,
          content_size = excluded.content_size,
          externalization_contract_version = excluded.externalization_contract_version,
          created_at = now();
  end if;
  -- Restore only the redundant inline raw_text; no externalization metadata is
  -- repointed and cleaned_text/search_vector are never touched.
  if p_article_table = 'articles' then
    update articles set raw_text = p_raw_text where id = p_article_row_id;
  else
    update article_content_versions_p3 set raw_text = p_raw_text where id = p_article_row_id;
  end if;

  return jsonb_build_object(
    'articleTable', p_article_table,
    'articleRowId', p_article_row_id,
    'dryRun', false,
    'idempotent', false,
    'restored', true
  );
end;
$function$;

-- Read-only M6E candidate listing: bounded, deterministic id keyset over exactly the
-- two carriers, returning only rows with no inline raw_text (the blob-only rows a
-- restore could target) plus the five M6A metadata columns the application needs to
-- classify before any Blob read. It performs no write of any kind and never widens a
-- table SELECT grant.
create or replace function article_raw_restore_candidates_v1(
  p_article_table text,
  p_source_key text default null,
  p_after_row_id uuid default null,
  p_limit integer default 25
)
returns table(
  article_table text,
  article_row_id uuid,
  article_id uuid,
  source_key text,
  raw_text_storage_ref text,
  raw_text_blob_hash text,
  raw_text_blob_size bigint,
  raw_text_externalized_at timestamptz,
  raw_text_blob_contract_version text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
declare
  v_limit integer;
begin
  -- Accept exactly the two article raw-text carriers.
  if p_article_table is null
    or p_article_table not in ('articles', 'article_content_versions_p3')
  then
    raise exception using errcode = '22023', message = 'ARTICLE_RAW_RESTORE_TABLE_INVALID';
  end if;
  -- Bounded batch: a missing or out-of-range limit is refused, never silently
  -- widened, so an operator can never request an unbounded read.
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception using errcode = '22023', message = 'ARTICLE_RAW_RESTORE_LIMIT_INVALID';
  end if;
  v_limit := p_limit;
  -- Optional exact source filter; any malformed key is refused before the read.
  if p_source_key is not null and p_source_key !~ '^[a-z][a-z0-9._-]{0,79}$' then
    raise exception using errcode = '22023', message = 'ARTICLE_RAW_RESTORE_SOURCE_KEY_INVALID';
  end if;

  if p_article_table = 'articles' then
    return query
      select
        'articles'::text,
        a.id,
        a.id,
        a.source_key,
        a.raw_text_storage_ref,
        a.raw_text_blob_hash,
        a.raw_text_blob_size,
        a.raw_text_externalized_at,
        a.raw_text_blob_contract_version
      from articles a
      where a.raw_text is null
        and (p_source_key is null or a.source_key = p_source_key)
        and (p_after_row_id is null or a.id > p_after_row_id)
      order by a.id asc
      limit v_limit;
  else
    return query
      select
        'article_content_versions_p3'::text,
        v.id,
        v.article_id,
        v.source_key,
        v.raw_text_storage_ref,
        v.raw_text_blob_hash,
        v.raw_text_blob_size,
        v.raw_text_externalized_at,
        v.raw_text_blob_contract_version
      from article_content_versions_p3 v
      where v.raw_text is null
        and (p_source_key is null or v.source_key = p_source_key)
        and (p_after_row_id is null or v.id > p_after_row_id)
      order by v.id asc
      limit v_limit;
  end if;
end;
$function$;

revoke all on table article_raw_inline_restore_permits from public;
revoke all on function article_raw_externalization_guard_v1() from public;
revoke all on function article_raw_restore_inline_v1(text, uuid, text, text, text, bigint, text, text, boolean) from public;
revoke all on function article_raw_restore_candidates_v1(text, text, uuid, integer) from public;

do $permissions$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on table article_raw_inline_restore_permits from anon;
    revoke all on function article_raw_restore_inline_v1(text, uuid, text, text, text, bigint, text, text, boolean) from anon;
    revoke all on function article_raw_restore_candidates_v1(text, text, uuid, integer) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on table article_raw_inline_restore_permits from authenticated;
    revoke all on function article_raw_restore_inline_v1(text, uuid, text, text, text, bigint, text, text, boolean) from authenticated;
    revoke all on function article_raw_restore_candidates_v1(text, text, uuid, integer) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    -- The restore permit table stays invisible to every API role; only the
    -- security-definer RPC (owned by the migration role) may mint or consume a
    -- permit. No table UPDATE/DELETE grant and no articles grant is ever issued.
    revoke all on table article_raw_inline_restore_permits from service_role;
    revoke all on function article_raw_externalization_guard_v1() from service_role;
    grant execute on function article_raw_restore_inline_v1(text, uuid, text, text, text, bigint, text, text, boolean) to service_role;
    grant execute on function article_raw_restore_candidates_v1(text, text, uuid, integer) to service_role;
  end if;
end;
$permissions$;

comment on table article_raw_inline_restore_permits is
  'One-time internal permits scoped to article_content_versions_p3 and consumed by the article raw-text inline-restore guard; no API role may read or write them.';
comment on function article_raw_externalization_guard_v1() is
  'Attach/clear/restore guard for article_content_versions_p3 raw_text Blob metadata: permits exactly one absent -> present M6B attach while inline raw_text is preserved, exactly one present -> null M6C clear while every other column is byte-identical, and exactly one null -> present M6E restore while every other column is byte-identical and the restored JSON-string document size and SHA-256 equal the recorded Blob size/hash, each with a matching one-time permit and M6B ledger row; blocks every re-point, partial write, and version delete.';
comment on function article_raw_restore_inline_v1(text, uuid, text, text, text, bigint, text, text, boolean) is
  'M6E dry-run-default inline-restore RPC: verifies the M6A externalized ref/hash/size/version, the M6B ledger entry, and the database-recomputed JSON-string document size and SHA-256, then restores the redundant inline raw_text in a single permit-guarded transition; p_dry_run defaults to true so nothing is restored without an explicit p_dry_run = false, an identical rerun is idempotent, and conflicting inline content fails closed.';
comment on function article_raw_restore_candidates_v1(text, text, uuid, integer) is
  'M6E read-only candidate authority: returns the bounded blob-only projection (rows with no inline raw_text) for articles or article_content_versions_p3, with the row id, article id, source key, and the five M6A raw-text Blob metadata columns, to service_role alone, so the restore listing never needs a direct raw-column table grant.';

commit;
