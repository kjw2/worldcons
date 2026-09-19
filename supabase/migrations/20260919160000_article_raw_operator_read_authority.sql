begin;

-- M6D-A article raw operator read authority.
--
-- service_role direct SELECT on public.article_content_versions_p3 is deliberately
-- column-restricted (20260903175000_constitutional_case_catalog_view_security.sql)
-- and excludes raw_text plus the M6A raw-text Blob metadata columns, so the M6B and
-- M6C candidate listings cannot read their required columns through a table grant.
-- This migration adds one narrow, read-only security-definer RPC that returns the
-- bounded article raw-text candidate projection for both public.articles and
-- public.article_content_versions_p3 to service_role alone. It never widens a table
-- SELECT grant and grants no API role any direct table access.
--
-- The returned projection is exactly what the M6B/M6C listings consume: the row id,
-- the article id, the source key, the inline raw_text, and the five M6A raw-text
-- Blob metadata columns. Reads are bounded (limit 1..100), filtered to non-null
-- inline raw_text, optionally narrowed by an exact source key, and keyset paginated
-- on the ascending row id, so every batch is bounded and stable across reruns. This
-- function reads only: it performs no write of any kind.

create or replace function article_raw_operator_candidates_v1(
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
  raw_text text,
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
    raise exception using errcode = '22023', message = 'ARTICLE_RAW_OPERATOR_TABLE_INVALID';
  end if;
  -- Bounded batch: a missing or out-of-range limit is refused, never silently
  -- widened, so an operator can never request an unbounded read.
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception using errcode = '22023', message = 'ARTICLE_RAW_OPERATOR_LIMIT_INVALID';
  end if;
  v_limit := p_limit;
  -- Optional exact source filter; any malformed key is refused before the read.
  if p_source_key is not null and p_source_key !~ '^[a-z][a-z0-9._-]{0,79}$' then
    raise exception using errcode = '22023', message = 'ARTICLE_RAW_OPERATOR_SOURCE_KEY_INVALID';
  end if;

  if p_article_table = 'articles' then
    return query
      select
        'articles'::text,
        a.id,
        a.id,
        a.source_key,
        a.raw_text,
        a.raw_text_storage_ref,
        a.raw_text_blob_hash,
        a.raw_text_blob_size,
        a.raw_text_externalized_at,
        a.raw_text_blob_contract_version
      from articles a
      where a.raw_text is not null
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
        v.raw_text,
        v.raw_text_storage_ref,
        v.raw_text_blob_hash,
        v.raw_text_blob_size,
        v.raw_text_externalized_at,
        v.raw_text_blob_contract_version
      from article_content_versions_p3 v
      where v.raw_text is not null
        and (p_source_key is null or v.source_key = p_source_key)
        and (p_after_row_id is null or v.id > p_after_row_id)
      order by v.id asc
      limit v_limit;
  end if;
end;
$function$;

revoke all on function article_raw_operator_candidates_v1(text, text, uuid, integer) from public;

do $permissions$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function article_raw_operator_candidates_v1(text, text, uuid, integer) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function article_raw_operator_candidates_v1(text, text, uuid, integer) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function article_raw_operator_candidates_v1(text, text, uuid, integer) to service_role;
  end if;
end;
$permissions$;

comment on function article_raw_operator_candidates_v1(text, text, uuid, integer) is
  'M6D-A read-only operator read authority: returns the bounded article raw-text candidate projection (row id, article id, source key, inline raw_text, and the five M6A raw-text Blob metadata columns) for articles or article_content_versions_p3 to service_role alone, so the M6B and M6C candidate listings never need a direct raw-column table grant.';

commit;
