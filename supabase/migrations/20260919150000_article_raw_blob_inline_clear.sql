begin;

-- Article raw-text Blob inline clear (M6C): after M6A has attached the verified
-- content-addressed raw-text Blob contract and M6B has recorded the append-only
-- externalization ledger entry, drop the now-redundant inline raw_text copy. This
-- mirrors the M4B artifact inline clear and builds directly on the M6A/M6B article
-- contract. It adds:
--   1. a second one-time, operation-specific permit table scoped to
--      article_content_versions_p3 that no API role can read or write;
--   2. an extended immutability guard for article_content_versions_p3 that now
--      allows exactly two transitions: the M6B attach (metadata absent -> present,
--      inline raw_text untouched) and the M6C clear (inline-present -> inline-null),
--      the latter only while every other column is byte-identical, a matching clear
--      permit exists, and an M6B ledger row for the exact ref/hash/size/version is
--      present;
--   3. a service_role security-definer RPC that locks the row, requires the exact
--      supported contract, requires the M6B ledger entry, requires inline raw_text
--      present, is idempotent on an identical rerun, and refuses repoints and
--      mismatches. The RPC is DRY-RUN BY DEFAULT (p_dry_run boolean default true):
--      with the default it validates every gate and reports what it would clear
--      without minting a permit or mutating a row, and only an explicit
--      p_dry_run = false performs the single permit-guarded clear.
--
-- Only the redundant inline raw_text is ever cleared. This migration never edits an
-- existing migration, never deletes a Blob object, never touches cleaned_text,
-- search_vector, or any search path, performs no table rewrite or compaction, and
-- leaves no generic bypass: direct updates/deletes stay blocked because
-- service_role holds no table UPDATE/DELETE privilege on the version table and
-- cannot mint a permit. public.articles is mutable and deliberately carries no
-- trigger (exactly as in M6B), so its raw_text is cleared only through this narrow
-- security-definer RPC, which requires the M6A contract and the M6B ledger first.

create table if not exists article_raw_inline_clear_permits (
  article_table text not null,
  article_row_id uuid not null,
  content_kind text not null,
  storage_ref text not null,
  content_hash text not null,
  content_size bigint not null,
  externalization_contract_version text not null,
  created_at timestamptz not null default now(),
  primary key (article_table, article_row_id),
  constraint article_raw_inline_clear_permits_table_check check (
    article_table = 'article_content_versions_p3'
  ),
  constraint article_raw_inline_clear_permits_kind_check check (
    content_kind = 'raw_text'
  ),
  constraint article_raw_inline_clear_permits_hash_check check (
    content_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint article_raw_inline_clear_permits_size_check check (
    content_size between 0 and 4194304
  ),
  constraint article_raw_inline_clear_permits_contract_check check (
    externalization_contract_version = 'worldcons-article-raw-blob-v1'
  ),
  constraint article_raw_inline_clear_permits_ref_check check (
    storage_ref ~ '^artifacts/article_raw/[a-z][a-z0-9._-]{0,79}/[0-9a-f]{64}\.json$'
    and length(storage_ref) between 1 and 500
    and storage_ref !~* '(token|secret|signature|credential)'
  )
);

alter table article_raw_inline_clear_permits enable row level security;

-- Extend the M6B attach-once guard to a second, narrowly permitted operation. The
-- trigger binding is unchanged; this replaces the function body in place. Only two
-- transitions may ever pass:
--   A. externalization attach (M6B): inline raw_text untouched, externalization
--      metadata absent -> present, with a matching externalization permit; or
--   B. inline clear (M6C): inline raw_text present -> null, with every other column
--      byte-identical, a matching clear permit, and a matching M6B ledger row.
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
-- DRY-RUN-BY-DEFAULT inline clear RPC. It locks the row, requires the M6A contract
-- and the M6B ledger entry for the exact ref/hash/size/version, and requires inline
-- raw_text to be present. With the default p_dry_run = true it only reports the
-- plan; the inline clear happens solely on an explicit p_dry_run = false, where
-- article_content_versions_p3 mints and consumes the one-time clear permit and
-- public.articles is cleared directly by this security-definer RPC.
create or replace function article_raw_inline_clear_v1(
  p_article_table text,
  p_article_row_id uuid,
  p_expected_storage_ref text,
  p_expected_content_hash text,
  p_expected_content_size bigint,
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
  v_stored_ref text;
  v_stored_hash text;
  v_stored_size bigint;
  v_stored_version text;
  v_stored_externalized_at timestamptz;
  v_inline_present boolean;
  v_actor text;
  v_dry_run boolean := coalesce(p_dry_run, true);
begin
  if p_article_table not in ('articles', 'article_content_versions_p3') then
    raise exception using errcode = '22023', message = 'ARTICLE_RAW_INLINE_CLEAR_TABLE_INVALID';
  end if;

  -- Accept only the one supported externalization contract version: any missing or
  -- different value is refused before the row is locked, a permit is minted, or the
  -- inline content is cleared.
  if p_externalization_contract_version is distinct from 'worldcons-article-raw-blob-v1' then
    raise exception using errcode = '22023', message = 'ARTICLE_RAW_INLINE_CLEAR_CONTRACT_VERSION_INVALID';
  end if;

  v_ref := nullif(trim(coalesce(p_expected_storage_ref, '')), '');
  if v_ref is null or v_ref <> p_expected_storage_ref then
    raise exception using errcode = '22023', message = 'ARTICLE_RAW_INLINE_CLEAR_REF_INVALID';
  end if;
  if p_expected_content_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'ARTICLE_RAW_INLINE_CLEAR_HASH_INVALID';
  end if;
  if p_expected_content_size is null or p_expected_content_size < 0 or p_expected_content_size > 4194304 then
    raise exception using errcode = '22023', message = 'ARTICLE_RAW_INLINE_CLEAR_SIZE_INVALID';
  end if;
  -- The ref must be content-addressed and its trailing hash must already equal the
  -- declared hash, before the row is locked.
  if v_ref !~ '^artifacts/article_raw/[a-z][a-z0-9._-]{0,79}/[0-9a-f]{64}\.json$'
    or v_ref !~ ('^artifacts/article_raw/[a-z][a-z0-9._-]{0,79}/' || p_expected_content_hash || '\.json$')
  then
    raise exception using errcode = '22023', message = 'ARTICLE_RAW_INLINE_CLEAR_REF_INVALID';
  end if;
  v_actor := nullif(trim(coalesce(p_actor_id, '')), '');
  if v_actor is not null and length(v_actor) > 160 then
    raise exception using errcode = '22023', message = 'ARTICLE_RAW_INLINE_CLEAR_ACTOR_INVALID';
  end if;

  if p_article_table = 'articles' then
    select a.source_key, a.raw_text_storage_ref, a.raw_text_blob_hash, a.raw_text_blob_size,
           a.raw_text_blob_contract_version, a.raw_text_externalized_at,
           (a.raw_text is not null), a.id
    into v_source_key, v_stored_ref, v_stored_hash, v_stored_size,
         v_stored_version, v_stored_externalized_at, v_inline_present, v_article_id
    from articles a where a.id = p_article_row_id for update;
  else
    select v.source_key, v.raw_text_storage_ref, v.raw_text_blob_hash, v.raw_text_blob_size,
           v.raw_text_blob_contract_version, v.raw_text_externalized_at,
           (v.raw_text is not null), v.article_id
    into v_source_key, v_stored_ref, v_stored_hash, v_stored_size,
         v_stored_version, v_stored_externalized_at, v_inline_present, v_article_id
    from article_content_versions_p3 v where v.id = p_article_row_id for update;
  end if;
  if not found then
    raise exception using errcode = 'P0001', message = 'ARTICLE_RAW_INLINE_CLEAR_ROW_NOT_FOUND';
  end if;
  -- Require the M6A externalization metadata to already be present, exactly as
  -- claimed, before any inline content may be dropped.
  if v_stored_ref is null or v_stored_version is null or v_stored_externalized_at is null then
    raise exception using errcode = 'P0001', message = 'ARTICLE_RAW_INLINE_CLEAR_NOT_EXTERNALIZED';
  end if;
  if v_stored_version <> p_externalization_contract_version then
    raise exception using errcode = 'P0001', message = 'ARTICLE_RAW_INLINE_CLEAR_CONFLICT';
  end if;
  if v_stored_ref is distinct from v_ref
    or v_stored_hash is distinct from p_expected_content_hash
    or v_stored_size is distinct from p_expected_content_size
  then
    raise exception using errcode = 'P0001', message = 'ARTICLE_RAW_INLINE_CLEAR_CONFLICT';
  end if;
  -- Bind the ref to this row's own source key and stored hash so the object key can
  -- never point at another source or another payload.
  if v_source_key is null or v_source_key !~ '^[a-z][a-z0-9._-]{0,79}$' then
    raise exception using errcode = 'P0001', message = 'ARTICLE_RAW_INLINE_CLEAR_REF_INVALID';
  end if;
  v_expected_ref := 'artifacts/article_raw/' || v_source_key || '/' || v_stored_hash || '.json';
  if v_stored_ref <> v_expected_ref then
    raise exception using errcode = '22023', message = 'ARTICLE_RAW_INLINE_CLEAR_REF_INVALID';
  end if;

  -- Require the M6B append-only ledger entry for this exact ref/hash/size/version
  -- before the inline content may be dropped.
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
    raise exception using errcode = 'P0001', message = 'ARTICLE_RAW_INLINE_CLEAR_LEDGER_MISSING';
  end if;
  -- Idempotent: an already cleared row with identical metadata returns without a
  -- second update and without minting another permit, in either mode.
  if not v_inline_present then
    return jsonb_build_object(
      'articleTable', p_article_table,
      'articleRowId', p_article_row_id,
      'dryRun', v_dry_run,
      'idempotent', true
    );
  end if;

  -- Dry run (the default): every gate above has passed, so report exactly what an
  -- execute would clear without minting a permit or mutating a single row.
  if v_dry_run then
    return jsonb_build_object(
      'articleTable', p_article_table,
      'articleRowId', p_article_row_id,
      'dryRun', true,
      'idempotent', false,
      'wouldClear', true
    );
  end if;
  -- Only article_content_versions_p3 mints a one-time permit consumed by the
  -- immutable guard; articles are cleared directly by this security-definer RPC.
  if p_article_table = 'article_content_versions_p3' then
    insert into article_raw_inline_clear_permits(
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
  -- Clear only the redundant inline raw_text; no externalization metadata is
  -- repointed and cleaned_text/search_vector are never touched.
  if p_article_table = 'articles' then
    update articles set raw_text = null where id = p_article_row_id;
  else
    update article_content_versions_p3 set raw_text = null where id = p_article_row_id;
  end if;

  return jsonb_build_object(
    'articleTable', p_article_table,
    'articleRowId', p_article_row_id,
    'dryRun', false,
    'idempotent', false,
    'cleared', true
  );
end;
$function$;
revoke all on table article_raw_inline_clear_permits from public;
revoke all on function article_raw_externalization_guard_v1() from public;
revoke all on function article_raw_inline_clear_v1(text, uuid, text, text, bigint, text, text, boolean) from public;

do $permissions$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on table article_raw_inline_clear_permits from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on table article_raw_inline_clear_permits from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    -- The clear permit table stays invisible to every API role; only the
    -- security-definer RPC (owned by the migration role) may mint or consume a
    -- permit. No table UPDATE/DELETE grant and no articles grant is ever issued.
    revoke all on table article_raw_inline_clear_permits from service_role;
    revoke all on function article_raw_externalization_guard_v1() from service_role;
    grant execute on function article_raw_inline_clear_v1(text, uuid, text, text, bigint, text, text, boolean) to service_role;
  end if;
end;
$permissions$;
comment on table article_raw_inline_clear_permits is
  'One-time internal permits scoped to article_content_versions_p3 and consumed by the article raw-text inline-clear guard; no API role may read or write them.';
comment on function article_raw_externalization_guard_v1() is
  'Attach-once/clear-once guard for article_content_versions_p3 raw_text Blob metadata: permits exactly one absent -> present M6B attach while inline raw_text is preserved, and exactly one present -> null M6C clear while every other column is byte-identical, a matching clear permit exists, and an M6B ledger row is present; blocks every re-point, partial write, and version delete.';
comment on function article_raw_inline_clear_v1(text, uuid, text, text, bigint, text, text, boolean) is
  'M6C dry-run-default inline-clear RPC: verifies the M6A externalized ref/hash/size/version and the M6B ledger entry, then clears the redundant inline raw_text in a single permit-guarded transition; p_dry_run defaults to true so nothing is cleared without an explicit p_dry_run = false, and an identical rerun is idempotent.';

commit;
