begin;

-- Article raw-text Blob externalization backfill (M6B): attach an already verified
-- private Blob ref to an existing inline article raw_text row on public.articles and
-- public.article_content_versions_p3 while preserving the inline payload. This
-- reuses the M6A article raw-text Blob contract and mirrors the M4A artifact
-- externalization safety pattern. It adds:
--   1. a one-time permit table that no API role can read or write and that is
--      scoped to article_content_versions_p3 only;
--   2. an attach-once immutability guard for article_content_versions_p3 that
--      allows exactly one externalization transition (metadata absent -> present,
--      inline raw_text and every unrelated column untouched) and only while a
--      matching permit exists; the mutable public.articles table gets no new
--      trigger at all;
--   3. a service_role security-definer RPC that locks the row, validates the ref,
--      hash, size, and contract, requires inline raw_text, updates the five raw
--      blob metadata columns on articles directly, mints and consumes the
--      one-time permit for article_content_versions_p3, reconciles the M6A ledger
--      before any idempotent return, and appends the ledger row on a fresh attach.
-- It never edits an existing migration, never clears inline raw_text, never touches
-- cleaned_text/search_vector or any search path, performs no table rewrite or
-- compaction, and leaves no generic bypass: the permit table is invisible to every
-- API role and only the security-definer RPC (owned by the migration role) may mint
-- or consume a permit.

create table if not exists article_raw_externalization_permits (
  article_table text not null,
  article_row_id uuid not null,
  content_kind text not null,
  storage_ref text not null,
  content_hash text not null,
  content_size bigint not null,
  externalization_contract_version text not null,
  created_at timestamptz not null default now(),
  primary key (article_table, article_row_id),
  constraint article_raw_externalization_permits_table_check check (
    article_table = 'article_content_versions_p3'
  ),
  constraint article_raw_externalization_permits_kind_check check (
    content_kind = 'raw_text'
  ),
  constraint article_raw_externalization_permits_hash_check check (
    content_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint article_raw_externalization_permits_size_check check (
    content_size between 0 and 4194304
  ),
  constraint article_raw_externalization_permits_contract_check check (
    externalization_contract_version = 'worldcons-article-raw-blob-v1'
  ),
  constraint article_raw_externalization_permits_ref_check check (
    storage_ref ~ '^artifacts/article_raw/[a-z][a-z0-9._-]{0,79}/[0-9a-f]{64}\.json$'
    and length(storage_ref) between 1 and 500
    and storage_ref !~* '(token|secret|signature|credential)'
  )
);

alter table article_raw_externalization_permits enable row level security;

-- Attach-once guard for article_content_versions_p3 only. The mutable public.articles
-- table deliberately has no trigger here: it carries many unrelated mutable columns,
-- and its five raw blob metadata columns are written directly by the narrow
-- security-definer RPC below with no generic table grant. Version rows are
-- append-only, so any change other than the one permitted attach is refused. The
-- only allowed metadata transition is the one-way attach: inline raw_text present
-- and unchanged, every non-metadata column byte-identical, all five metadata columns
-- absent before and fully present after, contract version exactly
-- worldcons-article-raw-blob-v1, and a matching one-time permit present.
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

  -- Version rows are immutable unless the externalization metadata changed.
  if v_old_meta is not distinct from v_new_meta then
    raise exception using errcode = '55000', message = 'ARTICLE_RAW_EXTERNALIZATION_IMMUTABLE';
  end if;
  -- Externalization metadata changed, so this must be a pure attach: every
  -- non-metadata column must stay byte-identical.
  if (to_jsonb(old) - v_meta_columns) is distinct from (to_jsonb(new) - v_meta_columns) then
    raise exception using errcode = '55000', message = 'ARTICLE_RAW_EXTERNALIZATION_IMMUTABLE';
  end if;

  -- Inline raw_text is preserved: it must be present before and unchanged by the
  -- attach, so a stray metadata write can never drop or rewrite the inline copy.
  v_old_raw := to_jsonb(old) ->> 'raw_text';
  v_new_raw := to_jsonb(new) ->> 'raw_text';
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

-- The content-version trigger replaces the blanket immutable trigger in place and
-- keeps both update and delete blocked except for the one permitted attach. No
-- trigger is created on articles: the RPC owns those five columns directly.
drop trigger if exists article_content_versions_p3_immutable_trigger on article_content_versions_p3;
create trigger article_content_versions_p3_immutable_trigger
before update or delete on article_content_versions_p3
for each row execute function article_raw_externalization_guard_v1();
create or replace function article_raw_externalize_v1(
  p_article_table text,
  p_article_row_id uuid,
  p_storage_ref text,
  p_content_hash text,
  p_content_size bigint,
  p_externalization_contract_version text,
  p_actor_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_source_key text;
  v_raw_text text;
  v_article_id uuid;
  v_existing_ref text;
  v_existing_hash text;
  v_existing_size bigint;
  v_existing_version text;
  v_existing_externalized_at timestamptz;
  v_ledger_kind text;
  v_ledger_ref text;
  v_ledger_hash text;
  v_ledger_size bigint;
  v_ledger_article_id uuid;
  v_ref text;
  v_expected_ref text;
  v_actor text;
begin
  if p_article_table not in ('articles', 'article_content_versions_p3') then
    raise exception using errcode = '22023', message = 'ARTICLE_RAW_EXTERNALIZATION_TABLE_INVALID';
  end if;

  v_ref := nullif(trim(coalesce(p_storage_ref, '')), '');
  if v_ref is null or v_ref <> p_storage_ref then
    raise exception using errcode = '22023', message = 'ARTICLE_RAW_EXTERNALIZATION_REF_INVALID';
  end if;
  if p_content_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'ARTICLE_RAW_EXTERNALIZATION_HASH_INVALID';
  end if;
  if p_content_size is null or p_content_size < 0 or p_content_size > 4194304 then
    raise exception using errcode = '22023', message = 'ARTICLE_RAW_EXTERNALIZATION_SIZE_INVALID';
  end if;
  -- Accept only the one supported contract version, refused before any permit work.
  if p_externalization_contract_version is distinct from 'worldcons-article-raw-blob-v1' then
    raise exception using errcode = '22023', message = 'ARTICLE_RAW_EXTERNALIZATION_CONTRACT_VERSION_INVALID';
  end if;
  -- The ref must be content-addressed and its trailing hash must already equal the
  -- declared hash, before the row is locked.
  if v_ref !~ '^artifacts/article_raw/[a-z][a-z0-9._-]{0,79}/[0-9a-f]{64}\.json$'
    or v_ref !~ ('^artifacts/article_raw/[a-z][a-z0-9._-]{0,79}/' || p_content_hash || '\.json$')
  then
    raise exception using errcode = '22023', message = 'ARTICLE_RAW_EXTERNALIZATION_REF_INVALID';
  end if;
  v_actor := nullif(trim(coalesce(p_actor_id, '')), '');
  if v_actor is not null and length(v_actor) > 160 then
    raise exception using errcode = '22023', message = 'ARTICLE_RAW_EXTERNALIZATION_ACTOR_INVALID';
  end if;

  if p_article_table = 'articles' then
    select a.source_key, a.raw_text, a.raw_text_storage_ref, a.raw_text_blob_hash,
           a.raw_text_blob_size, a.raw_text_blob_contract_version,
           a.raw_text_externalized_at, a.id
    into v_source_key, v_raw_text, v_existing_ref, v_existing_hash,
         v_existing_size, v_existing_version, v_existing_externalized_at, v_article_id
    from articles a where a.id = p_article_row_id for update;
  else
    select v.source_key, v.raw_text, v.raw_text_storage_ref, v.raw_text_blob_hash,
           v.raw_text_blob_size, v.raw_text_blob_contract_version,
           v.raw_text_externalized_at, v.article_id
    into v_source_key, v_raw_text, v_existing_ref, v_existing_hash,
         v_existing_size, v_existing_version, v_existing_externalized_at, v_article_id
    from article_content_versions_p3 v where v.id = p_article_row_id for update;
  end if;
  if not found then
    raise exception using errcode = 'P0001', message = 'ARTICLE_RAW_EXTERNALIZATION_ROW_NOT_FOUND';
  end if;

  -- Reruns are handled before any fresh attach. Any present current metadata means
  -- the row is no longer a pending attach: only a fully complete set of all five
  -- fields with an exact ref, hash, size, contract, and non-null externalized_at is
  -- idempotent. A partial set or any conflicting value fails closed.
  if v_existing_ref is not null
    or v_existing_hash is not null
    or v_existing_size is not null
    or v_existing_version is not null
    or v_existing_externalized_at is not null
  then
    if v_existing_ref = v_ref
      and v_existing_hash = p_content_hash
      and v_existing_size is not distinct from p_content_size
      and v_existing_version = p_externalization_contract_version
      and v_existing_externalized_at is not null
    then
      -- The append-only ledger is reconciled before any idempotent return: a matching
      -- ledger row is required, a missing one is backfilled with the exact matching
      -- values, and a conflicting one fails closed.
      select l.content_kind, l.storage_ref, l.content_hash, l.content_size, l.article_id
      into v_ledger_kind, v_ledger_ref, v_ledger_hash, v_ledger_size, v_ledger_article_id
      from article_raw_externalization_ledger l
      where l.article_table = p_article_table
        and l.article_row_id = p_article_row_id
        and l.externalization_contract_version = p_externalization_contract_version;
      if found then
        if v_ledger_kind <> 'raw_text'
          or v_ledger_ref <> v_ref
          or v_ledger_hash <> p_content_hash
          or v_ledger_size is distinct from p_content_size
          or v_ledger_article_id is distinct from v_article_id
        then
          raise exception using errcode = 'P0001', message = 'ARTICLE_RAW_EXTERNALIZATION_LEDGER_CONFLICT';
        end if;
      else
        insert into article_raw_externalization_ledger(
          article_table, article_row_id, article_id, content_kind, storage_ref, content_hash,
          content_size, externalization_contract_version, actor_type, actor_id
        ) values (
          p_article_table, p_article_row_id, v_article_id, 'raw_text', v_ref, p_content_hash,
          p_content_size, p_externalization_contract_version, 'operator', v_actor
        )
        on conflict (article_table, article_row_id, externalization_contract_version) do nothing;
      end if;
      return jsonb_build_object('artifactId', p_article_row_id, 'idempotent', true);
    end if;
    raise exception using errcode = 'P0001', message = 'ARTICLE_RAW_EXTERNALIZATION_CONFLICT';
  end if;

  -- There must be inline raw_text to externalize, and the ref must be bound to this
  -- row's own source key and declared hash so the stored object key can never point
  -- at another source or another payload.
  if v_raw_text is null then
    raise exception using errcode = 'P0001', message = 'ARTICLE_RAW_EXTERNALIZATION_INLINE_REQUIRED';
  end if;
  if v_source_key is null or v_source_key !~ '^[a-z][a-z0-9._-]{0,79}$' then
    raise exception using errcode = 'P0001', message = 'ARTICLE_RAW_EXTERNALIZATION_SOURCE_KEY_INVALID';
  end if;
  v_expected_ref := 'artifacts/article_raw/' || v_source_key || '/' || p_content_hash || '.json';
  if v_ref <> v_expected_ref then
    raise exception using errcode = '22023', message = 'ARTICLE_RAW_EXTERNALIZATION_REF_INVALID';
  end if;

  -- Only article_content_versions_p3 mints a one-time permit consumed by the
  -- immutable trigger; articles are updated directly by this security-definer RPC.
  if p_article_table = 'article_content_versions_p3' then
    insert into article_raw_externalization_permits(
      article_table, article_row_id, content_kind, storage_ref, content_hash, content_size,
      externalization_contract_version
    ) values (
      p_article_table, p_article_row_id, 'raw_text', v_ref, p_content_hash, p_content_size,
      p_externalization_contract_version
    )
    on conflict (article_table, article_row_id) do update
      set content_kind = excluded.content_kind,
          storage_ref = excluded.storage_ref,
          content_hash = excluded.content_hash,
          content_size = excluded.content_size,
          externalization_contract_version = excluded.externalization_contract_version,
          created_at = now();
  end if;

  -- Attach the externalization metadata only; inline raw_text is preserved.
  if p_article_table = 'articles' then
    update articles
      set raw_text_storage_ref = v_ref,
          raw_text_blob_hash = p_content_hash,
          raw_text_blob_size = p_content_size,
          raw_text_externalized_at = now(),
          raw_text_blob_contract_version = p_externalization_contract_version
      where id = p_article_row_id;
  else
    update article_content_versions_p3
      set raw_text_storage_ref = v_ref,
          raw_text_blob_hash = p_content_hash,
          raw_text_blob_size = p_content_size,
          raw_text_externalized_at = now(),
          raw_text_blob_contract_version = p_externalization_contract_version
      where id = p_article_row_id;
  end if;
  insert into article_raw_externalization_ledger(
    article_table, article_row_id, article_id, content_kind, storage_ref, content_hash,
    content_size, externalization_contract_version, actor_type, actor_id
  ) values (
    p_article_table, p_article_row_id, v_article_id, 'raw_text', v_ref, p_content_hash,
    p_content_size, p_externalization_contract_version, 'operator', v_actor
  )
  on conflict (article_table, article_row_id, externalization_contract_version) do nothing;

  return jsonb_build_object('artifactId', p_article_row_id, 'idempotent', false);
end;
$function$;

revoke all on table article_raw_externalization_permits from public;
revoke all on function article_raw_externalization_guard_v1() from public;
revoke all on function article_raw_externalize_v1(text, uuid, text, text, bigint, text, text) from public;
do $permissions$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on table article_raw_externalization_permits from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on table article_raw_externalization_permits from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    -- The permit table stays invisible to every API role; only the security-definer
    -- RPC (owned by the migration role) may mint or consume a permit. No table
    -- UPDATE/DELETE grant and no generic articles grant is ever issued.
    revoke all on table article_raw_externalization_permits from service_role;
    revoke all on function article_raw_externalization_guard_v1() from service_role;
    grant execute on function article_raw_externalize_v1(text, uuid, text, text, bigint, text, text) to service_role;
  end if;
end;
$permissions$;
comment on table article_raw_externalization_permits is
  'One-time internal permits scoped to article_content_versions_p3 and consumed by the article raw-text externalization guard; no API role may read or write them.';
comment on function article_raw_externalization_guard_v1() is
  'Attach-once guard for article_content_versions_p3 raw_text Blob metadata: permits exactly one absent -> present externalization transition while a matching one-time permit exists, preserves inline raw_text and every unrelated column, and blocks every re-point, clear, partial write, and version delete.';
comment on function article_raw_externalize_v1(text, uuid, text, text, bigint, text, text) is
  'M6B article raw-text externalization RPC: attaches a verified private Blob ref to an inline article or article_content_versions_p3 raw_text, preserves inline content, updates articles directly while version rows mint and consume the one-time permit, reconciles the M6A ledger on an idempotent rerun, and appends the ledger row on a fresh attach.';

commit;
