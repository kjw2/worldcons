create or replace function provider_search_v3_item(
  p_article public_article_projection_p3,
  p_relevance_score double precision,
  p_lexical_rank integer default null,
  p_semantic_rank integer default null,
  p_semantic_similarity double precision default null
)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id', (p_article).id,
    'slug', (p_article).slug,
    'source_key', (p_article).source_key,
    'jurisdiction', (p_article).jurisdiction,
    'institution_name', (p_article).institution_name,
    'content_type', (p_article).content_type,
    'original_url', (p_article).original_url,
    'canonical_url', (p_article).canonical_url,
    'original_language', (p_article).original_language,
    'original_title', (p_article).original_title,
    'korean_title', (p_article).korean_title,
    'original_published_at', (p_article).original_published_at,
    'discovered_at', (p_article).discovered_at,
    'fetched_at', (p_article).fetched_at,
    'summarized_at', (p_article).summarized_at,
    'summary_json', (p_article).summary_json,
    'source_metadata', (p_article).source_metadata,
    'article_tags', (p_article).article_tags,
    'case_number', coalesce(
      (p_article).source_metadata ->> 'caseNumber',
      (p_article).source_metadata ->> 'case_number',
      (p_article).source_metadata ->> 'docketNumber',
      (p_article).source_metadata ->> 'docket_number'
    ),
    'body_excerpt', left((p_article).cleaned_text, 6000),
    'content_hash', (p_article).content_hash,
    'relevance_score', p_relevance_score,
    'lexical_rank', p_lexical_rank,
    'semantic_rank', p_semantic_rank,
    'semantic_similarity', p_semantic_similarity
  );
$$;

create or replace function worldcons_provider_search_v3(
  p_query text default '',
  p_mode text default 'hybrid',
  p_query_embedding extensions.vector(1536) default null,
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
  v_mode text := lower(trim(coalesce(p_mode, 'hybrid')));
  v_tsquery tsquery;
  v_exact_case text;
  v_compact_case text;
  v_items jsonb;
  v_candidate_limit integer := least(greatest(coalesce(p_offset, 0) + coalesce(p_limit, 10) + 1, 50), 10021);
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
  if v_mode not in ('fulltext', 'semantic', 'hybrid') then
    raise exception using errcode = '22023', message = 'WORLDCONS_PROVIDER_INVALID_MODE';
  end if;
  if coalesce(p_range, 'latest') not in ('latest', 'today', 'week', 'month') then
    raise exception using errcode = '22023', message = 'WORLDCONS_PROVIDER_INVALID_RANGE';
  end if;
  v_exact_case := substring(v_query_text from '(?i)([12][[:space:]]+Bv[A-Za-z]+[[:space:]]+[0-9]+/[0-9]{2,4})');
  if v_query_text ~* '\m(neubauer|klimabeschluss)\M' then
    v_exact_case := '1 BvR 2656/18';
  end if;
  v_compact_case := regexp_replace(lower(coalesce(v_exact_case, '')), '[^a-z0-9]', '', 'g');
  if v_mode in ('semantic', 'hybrid')
    and v_query_text <> ''
    and v_exact_case is null
    and p_query_embedding is null then
    raise exception using errcode = '22023', message = 'WORLDCONS_PROVIDER_EMBEDDING_REQUIRED';
  end if;
  if v_query_text <> '' then
    v_tsquery := websearch_to_tsquery('simple', v_query_text);
  end if;

  if v_exact_case is not null then
    with page as (
      select article
      from public_article_projection_p3 article
      where (p_source is null or article.source_key = p_source)
        and (p_jurisdiction is null or article.jurisdiction = p_jurisdiction)
        and (
          coalesce(p_range, 'latest') = 'latest'
          or (p_range = 'today' and article.original_published_at >= current_date)
          or (p_range = 'week' and article.original_published_at >= current_date - interval '7 days')
          or (p_range = 'month' and article.original_published_at >= current_date - interval '30 days')
        )
        and article.source_key = 'de-bverfg'
        and (
          article.source_metadata ->> 'caseNumber' ilike '%' || v_exact_case || '%'
          or position(v_compact_case in regexp_replace(lower(coalesce(article.original_url, '')), '[^a-z0-9]', '', 'g')) > 0
        )
      order by article.original_published_at desc nulls last, article.id
      limit p_limit + 1
      offset p_offset
    )
    select coalesce(
      jsonb_agg(provider_search_v3_item(page.article, 1000::double precision)
        order by (page.article).original_published_at desc nulls last, (page.article).id),
      '[]'::jsonb
    )
    into v_items
    from page;

    return jsonb_build_object('items', v_items, 'retrievalMode', 'exact-case');
  end if;

  if v_query_text = '' then
    with page as (
      select article
      from public_article_projection_p3 article
      where (p_source is null or article.source_key = p_source)
        and (p_jurisdiction is null or article.jurisdiction = p_jurisdiction)
        and (
          coalesce(p_range, 'latest') = 'latest'
          or (p_range = 'today' and article.original_published_at >= current_date)
          or (p_range = 'week' and article.original_published_at >= current_date - interval '7 days')
          or (p_range = 'month' and article.original_published_at >= current_date - interval '30 days')
        )
      order by article.original_published_at desc nulls last, article.id
      limit p_limit + 1
      offset p_offset
    )
    select coalesce(
      jsonb_agg(provider_search_v3_item(page.article, 0::double precision)
        order by (page.article).original_published_at desc nulls last, (page.article).id),
      '[]'::jsonb
    )
    into v_items
    from page;

    return jsonb_build_object('items', v_items, 'retrievalMode', 'latest');
  end if;

  with filtered as (
    select article
    from public_article_projection_p3 article
    where (p_source is null or article.source_key = p_source)
      and (p_jurisdiction is null or article.jurisdiction = p_jurisdiction)
      and (
        coalesce(p_range, 'latest') = 'latest'
        or (p_range = 'today' and article.original_published_at >= current_date)
        or (p_range = 'week' and article.original_published_at >= current_date - interval '7 days')
        or (p_range = 'month' and article.original_published_at >= current_date - interval '30 days')
      )
  ), lexical as (
    select ranked.id, ranked.lexical_rank, ranked.lexical_score
    from (
      select
        (filtered.article).id as id,
        row_number() over (
          order by ts_rank_cd((filtered.article).search_vector, v_tsquery, 32) desc,
            (filtered.article).original_published_at desc nulls last,
            (filtered.article).id
        )::integer as lexical_rank,
        ts_rank_cd((filtered.article).search_vector, v_tsquery, 32)::double precision as lexical_score
      from filtered
      where v_mode in ('fulltext', 'hybrid')
        and v_tsquery is not null
        and (filtered.article).search_vector @@ v_tsquery
    ) ranked
    where ranked.lexical_rank <= v_candidate_limit
  ), semantic as (
    select ranked.id, ranked.semantic_rank, ranked.semantic_similarity
    from (
      select
        (filtered.article).id as id,
        row_number() over (
          order by (filtered.article).embedding OPERATOR(extensions.<=>) p_query_embedding,
            (filtered.article).original_published_at desc nulls last,
            (filtered.article).id
        )::integer as semantic_rank,
        (1 - ((filtered.article).embedding OPERATOR(extensions.<=>) p_query_embedding))::double precision as semantic_similarity
      from filtered
      where v_mode in ('semantic', 'hybrid')
        and p_query_embedding is not null
        and (filtered.article).embedding is not null
    ) ranked
    where ranked.semantic_rank <= v_candidate_limit
  ), candidates as (
    select
      coalesce(lexical.id, semantic.id) as id,
      lexical.lexical_rank,
      lexical.lexical_score,
      semantic.semantic_rank,
      semantic.semantic_similarity
    from lexical
    full outer join semantic using (id)
  ), ranked as (
    select
      filtered.article,
      candidates.lexical_rank,
      candidates.semantic_rank,
      candidates.semantic_similarity,
      case
        when v_mode = 'fulltext' then coalesce(candidates.lexical_score, 0)
        when v_mode = 'semantic' then coalesce(candidates.semantic_similarity, 0)
        else coalesce(1.0 / (60 + candidates.lexical_rank), 0)
           + coalesce(1.0 / (60 + candidates.semantic_rank), 0)
      end::double precision as relevance_score,
      case
        when lower(regexp_replace(trim(coalesce((filtered.article).korean_title, '')), '[[:space:]]+', ' ', 'g'))
             = lower(regexp_replace(v_query_text, '[[:space:]]+', ' ', 'g')) then true
        when lower(regexp_replace(trim(coalesce((filtered.article).original_title, '')), '[[:space:]]+', ' ', 'g'))
             = lower(regexp_replace(v_query_text, '[[:space:]]+', ' ', 'g')) then true
        else false
      end as exact_title
    from candidates
    join filtered on (filtered.article).id = candidates.id
  ), page as (
    select *
    from ranked
    order by
      exact_title desc,
      relevance_score desc,
      (article).original_published_at desc nulls last,
      (article).id
    limit p_limit + 1
    offset p_offset
  )
  select coalesce(
    jsonb_agg(
      provider_search_v3_item(page.article, page.relevance_score, page.lexical_rank, page.semantic_rank, page.semantic_similarity)
      order by page.exact_title desc, page.relevance_score desc, (page.article).original_published_at desc nulls last, (page.article).id
    ),
    '[]'::jsonb
  )
  into v_items
  from page;

  return jsonb_build_object('items', v_items, 'retrievalMode', v_mode);
end;
$$;

revoke all on function provider_search_v3_item(public_article_projection_p3, double precision, integer, integer, double precision) from public;
revoke all on function worldcons_provider_search_v3(text, text, extensions.vector, integer, integer, text, text, text) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function provider_search_v3_item(public_article_projection_p3, double precision, integer, integer, double precision) from anon;
    revoke all on function worldcons_provider_search_v3(text, text, extensions.vector, integer, integer, text, text, text) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function provider_search_v3_item(public_article_projection_p3, double precision, integer, integer, double precision) from authenticated;
    revoke all on function worldcons_provider_search_v3(text, text, extensions.vector, integer, integer, text, text, text) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function worldcons_provider_search_v3(text, text, extensions.vector, integer, integer, text, text, text) to service_role;
  end if;
end;
$$;

notify pgrst, 'reload schema';
