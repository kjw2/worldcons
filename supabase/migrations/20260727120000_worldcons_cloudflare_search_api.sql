create or replace function worldcons_provider_search_v1(
  p_query text default '',
  p_limit integer default 10,
  p_offset integer default 0,
  p_source text default null,
  p_jurisdiction text default null,
  p_range text default 'latest'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_query_text text := trim(coalesce(p_query, ''));
  v_tsquery tsquery;
  v_exact_case text;
  v_compact_case text;
  v_items jsonb;
begin
  if p_limit is null or p_limit not between 1 and 20 then
    raise exception using errcode = '22023', message = 'WORLDCONS_PROVIDER_INVALID_LIMIT';
  end if;
  if p_offset is null or p_offset not between 0 and 10000 then
    raise exception using errcode = '22023', message = 'WORLDCONS_PROVIDER_INVALID_OFFSET';
  end if;
  if length(v_query_text) > 200 then
    raise exception using errcode = '22023', message = 'WORLDCONS_PROVIDER_INVALID_QUERY';
  end if;
  if coalesce(p_range, 'latest') not in ('latest', 'today', 'week', 'month') then
    raise exception using errcode = '22023', message = 'WORLDCONS_PROVIDER_INVALID_RANGE';
  end if;

  v_exact_case := substring(v_query_text from '(?i)([12][[:space:]]+Bv[A-Za-z]+[[:space:]]+[0-9]+/[0-9]{2,4})');
  if v_query_text ~* '\m(neubauer|klimabeschluss)\M' then
    v_exact_case := '1 BvR 2656/18';
  end if;
  v_compact_case := regexp_replace(lower(coalesce(v_exact_case, '')), '[^a-z0-9]', '', 'g');
  if v_query_text <> '' then
    v_tsquery := websearch_to_tsquery('simple', v_query_text);
  end if;

  with ranked as (
    select
      article.*,
      case
        when v_exact_case is not null
          and (
            article.source_metadata ->> 'caseNumber' ilike '%' || v_exact_case || '%'
            or position(v_compact_case in regexp_replace(lower(coalesce(article.original_url, '')), '[^a-z0-9]', '', 'g')) > 0
          )
          then 1000::real
        when v_query_text = '' then 0::real
        else ts_rank_cd(article.search_vector, v_tsquery, 32)
      end as relevance_score
    from public_article_projection_p3 article
    where (p_source is null or article.source_key = p_source)
      and (p_jurisdiction is null or article.jurisdiction = p_jurisdiction)
      and (
        coalesce(p_range, 'latest') = 'latest'
        or (p_range = 'today' and article.original_published_at >= current_date)
        or (p_range = 'week' and article.original_published_at >= current_date - interval '7 days')
        or (p_range = 'month' and article.original_published_at >= current_date - interval '30 days')
      )
      and (
        v_query_text = ''
        or (
          v_exact_case is not null
          and article.source_key = 'de-bverfg'
          and (
            article.source_metadata ->> 'caseNumber' ilike '%' || v_exact_case || '%'
            or position(v_compact_case in regexp_replace(lower(coalesce(article.original_url, '')), '[^a-z0-9]', '', 'g')) > 0
          )
        )
        or (
          v_exact_case is null
          and v_tsquery is not null
          and article.search_vector @@ v_tsquery
        )
      )
  ), page as (
    select *
    from ranked
    order by relevance_score desc, original_published_at desc nulls last, id
    limit p_limit + 1
    offset p_offset
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', page.id,
        'slug', page.slug,
        'source_key', page.source_key,
        'jurisdiction', page.jurisdiction,
        'institution_name', page.institution_name,
        'content_type', page.content_type,
        'original_url', page.original_url,
        'canonical_url', page.canonical_url,
        'original_language', page.original_language,
        'original_title', page.original_title,
        'korean_title', page.korean_title,
        'original_published_at', page.original_published_at,
        'discovered_at', page.discovered_at,
        'fetched_at', page.fetched_at,
        'summarized_at', page.summarized_at,
        'summary_json', page.summary_json,
        'source_metadata', page.source_metadata,
        'article_tags', page.article_tags,
        'case_number', page.source_metadata ->> 'caseNumber',
        'relevance_score', page.relevance_score
      )
      order by page.relevance_score desc, page.original_published_at desc nulls last, page.id
    ),
    '[]'::jsonb
  )
  into v_items
  from page;

  return jsonb_build_object('items', v_items);
end;
$$;

create or replace function worldcons_provider_sources_v1()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'sourceKey', source.source_key,
        'name', source.name,
        'jurisdiction', source.jurisdiction,
        'baseUrl', source.base_url,
        'language', source.language,
        'isActive', source.is_active
      )
      order by source.source_key
    ),
    '[]'::jsonb
  )
  from sources source
  where source.is_active = true;
$$;

create or replace function worldcons_provider_article_v1(p_slug text)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id', article.id,
    'slug', article.slug,
    'source_key', article.source_key,
    'jurisdiction', article.jurisdiction,
    'institution_name', article.institution_name,
    'content_type', article.content_type,
    'original_url', article.original_url,
    'canonical_url', article.canonical_url,
    'original_language', article.original_language,
    'original_title', article.original_title,
    'korean_title', article.korean_title,
    'original_published_at', article.original_published_at,
    'discovered_at', article.discovered_at,
    'fetched_at', article.fetched_at,
    'summarized_at', article.summarized_at,
    'summary_json', article.summary_json,
    'source_metadata', article.source_metadata,
    'article_tags', article.article_tags,
    'case_number', article.source_metadata ->> 'caseNumber',
    'cleaned_text', article.cleaned_text,
    'content_hash', article.content_hash,
    'relevance_score', null
  )
  from public_article_projection_p3 article
  where article.slug = p_slug
  limit 1;
$$;

revoke all on function worldcons_provider_search_v1(text, integer, integer, text, text, text) from public;
revoke all on function worldcons_provider_sources_v1() from public;
revoke all on function worldcons_provider_article_v1(text) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function worldcons_provider_search_v1(text, integer, integer, text, text, text) from anon;
    revoke all on function worldcons_provider_sources_v1() from anon;
    revoke all on function worldcons_provider_article_v1(text) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function worldcons_provider_search_v1(text, integer, integer, text, text, text) from authenticated;
    revoke all on function worldcons_provider_sources_v1() from authenticated;
    revoke all on function worldcons_provider_article_v1(text) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function worldcons_provider_search_v1(text, integer, integer, text, text, text) to service_role;
    grant execute on function worldcons_provider_sources_v1() to service_role;
    grant execute on function worldcons_provider_article_v1(text) to service_role;
  end if;
end;
$$;

notify pgrst, 'reload schema';
