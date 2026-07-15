create or replace function cclmetasearch_search_v1(
  p_query text,
  p_limit integer default 10,
  p_offset integer default 0,
  p_sort text default 'relevance'
)
returns table (items jsonb, total bigint)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
declare
  v_query tsquery;
  v_total bigint;
begin
  if p_query is null or length(btrim(p_query)) = 0 or length(btrim(p_query)) > 200 then
    raise exception using errcode = '22023', message = 'p_query must contain between 1 and 200 characters';
  end if;

  if p_limit is null or p_limit < 1 or p_limit > 20 then
    raise exception using errcode = '22023', message = 'p_limit must be between 1 and 20';
  end if;

  if p_offset is null or p_offset < 0 or p_offset > 10000 then
    raise exception using errcode = '22023', message = 'p_offset must be between 0 and 10000';
  end if;

  if p_sort is null or p_sort not in ('relevance', 'latest') then
    raise exception using errcode = '22023', message = 'p_sort must be relevance or latest';
  end if;

  v_query := websearch_to_tsquery('simple', btrim(p_query));
  if numnode(v_query) = 0 then
    raise exception using errcode = '22023', message = 'p_query must contain a searchable term';
  end if;

  select count(*)::bigint
  into v_total
  from public_article_projection_p3 article
  where article.search_vector @@ v_query;

  return query
  with page_rows as (
    select
      article.id,
      article.slug,
      article.source_key,
      article.jurisdiction,
      article.institution_name,
      article.original_url,
      article.canonical_url,
      article.original_language,
      article.original_title,
      article.korean_title,
      article.original_published_at,
      article.discovered_at,
      article.fetched_at,
      article.summarized_at,
      article.summary_json,
      article.source_metadata,
      article.article_tags,
      ts_rank_cd(article.search_vector, v_query, 32) as relevance_score
    from public_article_projection_p3 article
    where article.search_vector @@ v_query
    order by
      case when p_sort = 'relevance' then ts_rank_cd(article.search_vector, v_query, 32) end desc nulls last,
      case when p_sort = 'latest' then article.original_published_at end desc nulls last,
      case when p_sort = 'latest' then ts_rank_cd(article.search_vector, v_query, 32) end desc nulls last,
      article.original_published_at desc nulls last,
      article.id asc
    limit p_limit
    offset p_offset
  )
  select
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', page.id,
          'slug', page.slug,
          'source_key', page.source_key,
          'jurisdiction', page.jurisdiction,
          'institution_name', page.institution_name,
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
          'relevance_score', page.relevance_score
        )
        order by
          case when p_sort = 'relevance' then page.relevance_score end desc nulls last,
          case when p_sort = 'latest' then page.original_published_at end desc nulls last,
          case when p_sort = 'latest' then page.relevance_score end desc nulls last,
          page.original_published_at desc nulls last,
          page.id asc
      ),
      '[]'::jsonb
    ),
    v_total
  from page_rows page;
end;
$function$;

comment on function cclmetasearch_search_v1(text, integer, integer, text) is
  'Searches only the published WorldCons projection and returns one bounded page plus an exact total.';

revoke all on function cclmetasearch_search_v1(text, integer, integer, text) from public;

do $permissions$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function cclmetasearch_search_v1(text, integer, integer, text) from anon;
  end if;

  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function cclmetasearch_search_v1(text, integer, integer, text) from authenticated;
  end if;

  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function cclmetasearch_search_v1(text, integer, integer, text) to service_role;
  end if;
end;
$permissions$;
