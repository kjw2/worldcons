create or replace function public_fulltext_ranked_ids_v1(
  p_query text,
  p_limit integer default 50,
  p_source text default null,
  p_jurisdiction text default null,
  p_content_type text default null,
  p_language text default null,
  p_range text default 'latest'
)
returns table (article_id uuid, relevance_score real)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
declare
  v_query_text text := btrim(coalesce(p_query, ''));
  v_query tsquery;
begin
  if length(v_query_text) = 0 or length(v_query_text) > 200 then
    raise exception using errcode = '22023', message = 'WORLDCONS_FULLTEXT_INVALID_QUERY';
  end if;
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception using errcode = '22023', message = 'WORLDCONS_FULLTEXT_INVALID_LIMIT';
  end if;
  if coalesce(p_range, 'latest') not in ('latest', 'today', 'week', 'month') then
    raise exception using errcode = '22023', message = 'WORLDCONS_FULLTEXT_INVALID_RANGE';
  end if;

  v_query := websearch_to_tsquery('simple', v_query_text);
  if numnode(v_query) = 0 then
    raise exception using errcode = '22023', message = 'WORLDCONS_FULLTEXT_EMPTY_QUERY';
  end if;

  return query
  select
    article.id,
    ts_rank_cd(article.search_vector, v_query, 32)::real as relevance_score
  from public_article_projection_p3 article
  where article.search_vector @@ v_query
    and (p_source is null or article.source_key = p_source)
    and (p_jurisdiction is null or article.jurisdiction = p_jurisdiction)
    and (p_content_type is null or article.content_type = p_content_type)
    and (p_language is null or article.original_language = p_language)
    and (
      coalesce(p_range, 'latest') = 'latest'
      or (p_range = 'today' and article.original_published_at >= current_date)
      or (p_range = 'week' and article.original_published_at >= current_date - interval '7 days')
      or (p_range = 'month' and article.original_published_at >= current_date - interval '30 days')
    )
  order by
    case
      when lower(btrim(coalesce(article.korean_title, ''))) = lower(v_query_text)
        or lower(btrim(coalesce(article.original_title, ''))) = lower(v_query_text)
      then 1
      else 0
    end desc,
    ts_rank_cd(article.search_vector, v_query, 32) desc,
    article.original_published_at desc nulls last,
    article.id asc
  limit p_limit;
end;
$function$;

comment on function public_fulltext_ranked_ids_v1(text, integer, text, text, text, text, text) is
  'Returns a bounded relevance-ranked ID window from the published WorldCons projection for internal hybrid retrieval.';

revoke all on function public_fulltext_ranked_ids_v1(text, integer, text, text, text, text, text) from public;

do $permissions$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public_fulltext_ranked_ids_v1(text, integer, text, text, text, text, text) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public_fulltext_ranked_ids_v1(text, integer, text, text, text, text, text) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public_fulltext_ranked_ids_v1(text, integer, text, text, text, text, text) to service_role;
  end if;
end;
$permissions$;

notify pgrst, 'reload schema';
