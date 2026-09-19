begin;

-- M6D-B article raw-text readiness observability (hardened, aggregate-only).
--
-- This migration replaces the earlier per-row readiness projection with exactly one
-- read-only, service_role-only aggregate function. article_raw_readiness_v1 returns a
-- single row of counts for one article raw_text carrier (public.articles or
-- public.article_content_versions_p3), optionally narrowed by an exact source key. It
-- never returns payload content, never returns a per-row projection, never returns a
-- storage ref/hash/size, performs no DML, changes no existing object, and stores no
-- data. The optional bounded Blob verification remains in application code.
--
-- A row's externalization metadata is the five M6A columns (storage ref, hash, size,
-- externalized_at, contract version). metadata_absent means all five are null.
-- metadata_complete requires all five to be coherent: the exact supported contract
-- version, a 64-hex hash, a size within 0..4194304, a non-null externalized_at, and a
-- content-addressed ref that is exactly
-- artifacts/article_raw/{source_key}/{hash}.json. Any other mix is
-- metadata_inconsistent. A row is clearable only when it is inline-present,
-- metadata_complete, and exactly backed by the append-only M6B ledger; the exact
-- ledger match mirrors the M6C clear gate (article table, row id, article id, content
-- kind raw_text, storage ref, hash, size, and contract version). exact_ledger_covered
-- is that exact-match count. ledger_missing_or_conflicting counts only the
-- metadata_complete rows that lack an exact ledger match, so metadata-absent or
-- metadata-inconsistent rows (for example inline-only rows with no externalization
-- metadata) are never reported as a ledger gap.
--
-- inline_blob_bytes_estimated sums octet_length(to_json(raw_text)::text) over the
-- non-null inline values: that is exactly the M6A JSON-string document size, so it
-- estimates the externalized Blob bytes without ever reading a Blob object.

-- The prior per-row projection is removed so the aggregate function is the only
-- remaining readiness authority.
drop function if exists article_raw_readiness_rows_v1(text, text, integer, uuid);

create or replace function article_raw_readiness_v1(
  p_article_table text,
  p_source_key text default null
)
returns table (
  total_rows bigint,
  inline_present bigint,
  inline_missing bigint,
  metadata_absent bigint,
  metadata_complete bigint,
  metadata_inconsistent bigint,
  dual_copy bigint,
  blob_only bigint,
  inline_only bigint,
  exact_ledger_covered bigint,
  ledger_missing_or_conflicting bigint,
  clearable_rows bigint,
  inline_blob_bytes_estimated bigint
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
begin
  -- Accept exactly the two article raw-text carriers.
  if p_article_table is null
    or p_article_table not in ('articles', 'article_content_versions_p3')
  then
    raise exception using errcode = '22023', message = 'ARTICLE_RAW_READINESS_TABLE_INVALID';
  end if;
  -- Optional exact source filter; any malformed key is refused before the read.
  if p_source_key is not null and p_source_key !~ '^[a-z][a-z0-9._-]{0,79}$' then
    raise exception using errcode = '22023', message = 'ARTICLE_RAW_READINESS_SOURCE_KEY_INVALID';
  end if;

  if p_article_table = 'articles' then
    return query
      with classified as (
        select
          (a.raw_text is not null) as row_inline_present,
          (
            a.raw_text_storage_ref is null
            and a.raw_text_blob_hash is null
            and a.raw_text_blob_size is null
            and a.raw_text_externalized_at is null
            and a.raw_text_blob_contract_version is null
          ) as row_metadata_absent,
          coalesce(
            a.raw_text_blob_contract_version = 'worldcons-article-raw-blob-v1'
            and a.raw_text_blob_hash ~ '^[0-9a-f]{64}$'
            and a.raw_text_blob_size between 0 and 4194304
            and a.raw_text_externalized_at is not null
            and a.raw_text_storage_ref
              = 'artifacts/article_raw/' || a.source_key || '/' || a.raw_text_blob_hash || '.json',
            false
          ) as row_metadata_complete,
          exists (
            select 1
            from article_raw_externalization_ledger l
            where l.article_table = 'articles'
              and l.article_row_id = a.id
              and l.article_id = a.id
              and l.content_kind = 'raw_text'
              and l.storage_ref = a.raw_text_storage_ref
              and l.content_hash = a.raw_text_blob_hash
              and l.content_size is not distinct from a.raw_text_blob_size
              and l.externalization_contract_version = a.raw_text_blob_contract_version
          ) as row_exact_ledger_covered,
          case
            when a.raw_text is not null then octet_length(to_json(a.raw_text)::text)
            else null
          end as row_inline_bytes
        from articles a
        where p_source_key is null or a.source_key = p_source_key
      )
      select
        count(*) as total_rows,
        count(*) filter (where row_inline_present) as inline_present,
        count(*) filter (where not row_inline_present) as inline_missing,
        count(*) filter (where row_metadata_absent) as metadata_absent,
        count(*) filter (where row_metadata_complete) as metadata_complete,
        count(*) filter (where not row_metadata_absent and not row_metadata_complete)
          as metadata_inconsistent,
        count(*) filter (where row_inline_present and row_metadata_complete) as dual_copy,
        count(*) filter (where not row_inline_present and row_metadata_complete) as blob_only,
        count(*) filter (where row_inline_present and row_metadata_absent) as inline_only,
        count(*) filter (where row_exact_ledger_covered) as exact_ledger_covered,
        count(*) filter (where row_metadata_complete and not row_exact_ledger_covered)
          as ledger_missing_or_conflicting,
        count(*) filter (where row_inline_present and row_metadata_complete and row_exact_ledger_covered)
          as clearable_rows,
        coalesce(sum(row_inline_bytes), 0)::bigint as inline_blob_bytes_estimated
      from classified;
    return;
  end if;

  return query
    with classified as (
      select
        (v.raw_text is not null) as row_inline_present,
        (
          v.raw_text_storage_ref is null
          and v.raw_text_blob_hash is null
          and v.raw_text_blob_size is null
          and v.raw_text_externalized_at is null
          and v.raw_text_blob_contract_version is null
        ) as row_metadata_absent,
        coalesce(
          v.raw_text_blob_contract_version = 'worldcons-article-raw-blob-v1'
          and v.raw_text_blob_hash ~ '^[0-9a-f]{64}$'
          and v.raw_text_blob_size between 0 and 4194304
          and v.raw_text_externalized_at is not null
          and v.raw_text_storage_ref
            = 'artifacts/article_raw/' || v.source_key || '/' || v.raw_text_blob_hash || '.json',
          false
        ) as row_metadata_complete,
        exists (
          select 1
          from article_raw_externalization_ledger l
          where l.article_table = 'article_content_versions_p3'
            and l.article_row_id = v.id
            and l.article_id = v.article_id
            and l.content_kind = 'raw_text'
            and l.storage_ref = v.raw_text_storage_ref
            and l.content_hash = v.raw_text_blob_hash
            and l.content_size is not distinct from v.raw_text_blob_size
            and l.externalization_contract_version = v.raw_text_blob_contract_version
        ) as row_exact_ledger_covered,
        case
          when v.raw_text is not null then octet_length(to_json(v.raw_text)::text)
          else null
        end as row_inline_bytes
      from article_content_versions_p3 v
      where p_source_key is null or v.source_key = p_source_key
    )
    select
      count(*) as total_rows,
      count(*) filter (where row_inline_present) as inline_present,
      count(*) filter (where not row_inline_present) as inline_missing,
      count(*) filter (where row_metadata_absent) as metadata_absent,
      count(*) filter (where row_metadata_complete) as metadata_complete,
      count(*) filter (where not row_metadata_absent and not row_metadata_complete)
        as metadata_inconsistent,
      count(*) filter (where row_inline_present and row_metadata_complete) as dual_copy,
      count(*) filter (where not row_inline_present and row_metadata_complete) as blob_only,
      count(*) filter (where row_inline_present and row_metadata_absent) as inline_only,
      count(*) filter (where row_exact_ledger_covered) as exact_ledger_covered,
      count(*) filter (where row_metadata_complete and not row_exact_ledger_covered)
        as ledger_missing_or_conflicting,
      count(*) filter (where row_inline_present and row_metadata_complete and row_exact_ledger_covered)
        as clearable_rows,
      coalesce(sum(row_inline_bytes), 0)::bigint as inline_blob_bytes_estimated
    from classified;
end;
$function$;

revoke all on function article_raw_readiness_v1(text, text) from public;

do $permissions$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function article_raw_readiness_v1(text, text) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function article_raw_readiness_v1(text, text) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function article_raw_readiness_v1(text, text) to service_role;
  end if;
end;
$permissions$;

comment on function article_raw_readiness_v1(text, text) is
  'M6D-B read-only aggregate readiness: one row of presence, metadata, ledger, and clearable counts for the raw_text rows of articles or article_content_versions_p3, optionally narrowed by an exact source key. Returns no payload content, no storage ref, no hash, and no per-row projection, and performs no DML.';

commit;
