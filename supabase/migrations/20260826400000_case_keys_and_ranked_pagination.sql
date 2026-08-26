create or replace function worldcons_case_key_v1(
  p_source_key text,
  p_case_number text default null,
  p_title text default null,
  p_url text default null
)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $function$
declare
  v_value text := concat_ws(' ', coalesce(p_case_number, ''), coalesce(p_title, ''), coalesce(p_url, ''));
  v_match text[];
  v_year text;
begin
  if p_source_key = 'de-bverfg' then
    v_match := regexp_match(v_value, '(?i)\m([12])[[:space:]]+Bv([A-Za-z]+)[[:space:]]+([0-9]+)[[:space:]]*/[[:space:]]*([0-9]{2,4})\M');
    if v_match is not null then
      v_year := case when length(v_match[4]) = 4 then right(v_match[4], 2) else lpad(v_match[4], 2, '0') end;
      return lower(v_match[1] || 'bv' || v_match[2] || (v_match[3]::bigint)::text || v_year);
    end if;
    v_match := regexp_match(lower(v_value), '([12])bv([a-z]+)([0-9]{4})([0-9]{2})(?:\.html)?');
    if v_match is not null then
      return lower(v_match[1] || 'bv' || v_match[2] || (v_match[3]::bigint)::text || v_match[4]);
    end if;
    return null;
  end if;

  if p_source_key = 'fr-conseil-constitutionnel' then
    v_match := regexp_match(v_value, '(?i)\m([0-9]{4}-[0-9]+(?:[/_-][0-9]+)*(?:[[:space:]]+(?:QPC|DC|AN|SEN))?)\M');
    if v_match is not null then
      return regexp_replace(lower(v_match[1]), '[^a-z0-9]', '', 'g');
    end if;
    return null;
  end if;

  if p_source_key = 'es-tribunal-constitucional' then
    v_match := regexp_match(v_value, '\m([0-9]{1,4})[[:space:]]*/[[:space:]]*([0-9]{4})\M');
    if v_match is not null then
      return (v_match[1]::bigint)::text || v_match[2];
    end if;
    return null;
  end if;

  if p_source_key = 'us-scotus' then
    v_match := regexp_match(v_value, '(?i)\m(?:No\.[[:space:]]*)?([0-9]{2,3})[[:space:]]*-[[:space:]]*([0-9]+)\M');
    if v_match is not null then
      return (v_match[1]::bigint)::text || (v_match[2]::bigint)::text;
    end if;
    return null;
  end if;

  return null;
end;
$function$;

create or replace function worldcons_query_case_reference_v1(p_query text)
returns jsonb
language plpgsql
immutable
set search_path = public, pg_temp
as $function$
declare
  v_query text := trim(coalesce(p_query, ''));
  v_match text[];
  v_case text;
  v_key text;
begin
  if v_query ~* '\m(neubauer|klimabeschluss)\M' then
    return jsonb_build_object('sourceKey', 'de-bverfg', 'caseNumber', '1 BvR 2656/18', 'caseKey', '1bvr265618');
  end if;

  v_match := regexp_match(v_query, '(?i)\m([12][[:space:]]+Bv[A-Za-z]+[[:space:]]+[0-9]+[[:space:]]*/[[:space:]]*[0-9]{2,4})\M');
  if v_match is not null then
    v_case := v_match[1];
    v_key := worldcons_case_key_v1('de-bverfg', v_case, null, null);
    return jsonb_build_object('sourceKey', 'de-bverfg', 'caseNumber', v_case, 'caseKey', v_key);
  end if;

  v_match := regexp_match(v_query, '(?i)\m([0-9]{4}-[0-9]+(?:[/_-][0-9]+)*(?:[[:space:]]+(?:QPC|DC|AN|SEN))?)\M');
  if v_match is not null then
    v_case := v_match[1];
    v_key := worldcons_case_key_v1('fr-conseil-constitutionnel', v_case, null, null);
    return jsonb_build_object('sourceKey', 'fr-conseil-constitutionnel', 'caseNumber', v_case, 'caseKey', v_key);
  end if;

  v_match := regexp_match(v_query, '\m([0-9]{1,4}[[:space:]]*/[[:space:]]*[0-9]{4})\M');
  if v_match is not null then
    v_case := v_match[1];
    v_key := worldcons_case_key_v1('es-tribunal-constitucional', v_case, null, null);
    return jsonb_build_object('sourceKey', 'es-tribunal-constitucional', 'caseNumber', v_case, 'caseKey', v_key);
  end if;

  v_match := regexp_match(v_query, '(?i)\m(?:No\.[[:space:]]*)?([0-9]{2,3}[[:space:]]*-[[:space:]]*[0-9]+)\M');
  if v_match is not null then
    v_case := v_match[1];
    v_key := worldcons_case_key_v1('us-scotus', v_case, null, null);
    return jsonb_build_object('sourceKey', 'us-scotus', 'caseNumber', v_case, 'caseKey', v_key);
  end if;

  return null;
end;
$function$;

alter table articles
  add column if not exists case_key text generated always as (
    worldcons_case_key_v1(
      source_key,
      coalesce(
        source_metadata ->> 'caseNumber',
        source_metadata ->> 'case_number',
        source_metadata ->> 'docketNumber',
        source_metadata ->> 'docket_number',
        source_metadata ->> 'docket',
        source_metadata ->> 'decisionNumber',
        source_metadata ->> 'resolutionNumber'
      ),
      original_title,
      original_url
    )
  ) stored;

alter table article_content_versions_p3
  add column if not exists case_key text generated always as (
    worldcons_case_key_v1(
      source_key,
      coalesce(
        source_metadata ->> 'caseNumber',
        source_metadata ->> 'case_number',
        source_metadata ->> 'docketNumber',
        source_metadata ->> 'docket_number',
        source_metadata ->> 'docket',
        source_metadata ->> 'decisionNumber',
        source_metadata ->> 'resolutionNumber'
      ),
      original_title,
      original_url
    )
  ) stored;

create index if not exists articles_source_case_key_idx
  on articles (source_key, case_key)
  where case_key is not null;

create index if not exists article_content_versions_p3_source_case_key_idx
  on article_content_versions_p3 (source_key, case_key)
  where case_key is not null;

create or replace view public_article_projection_p3
with (security_barrier = true)
as
select
  v.article_id as id,
  v.slug,
  v.source_key,
  v.jurisdiction,
  v.institution_name,
  v.content_type,
  v.original_url,
  v.canonical_url,
  v.original_language,
  v.original_title,
  v.korean_title,
  v.original_published_at,
  v.discovered_at,
  v.fetched_at,
  v.summarized_at,
  'summarized'::text as status,
  v.raw_text,
  v.cleaned_text,
  v.summary_json,
  v.source_metadata,
  v.error_metadata,
  v.content_hash,
  v.search_vector,
  v.embedding,
  p.id as publication_id,
  p.revision as publication_revision,
  v.id as article_version_id,
  v.revision as article_version_revision,
  coalesce((
    select jsonb_agg(jsonb_build_object(
      'confidence', at.confidence,
      'tags', jsonb_build_object(
        'id', t.id, 'slug', t.slug, 'name', t.name, 'normalized_name', t.normalized_name,
        'type', t.type, 'description', t.description, 'article_count', t.article_count,
        'latest_article_at', t.latest_article_at
      )
    ) order by t.slug)
    from article_tags at
    join tags t on t.id = at.tag_id
    where at.article_id = v.article_id
  ), '[]'::jsonb) as article_tags,
  v.case_key
from article_publications_p3 p
join article_content_versions_p3 v on v.id = p.version_id and v.article_id = p.article_id
where p.state = 'published';

create or replace function worldcons_ranked_search_page_v1(
  p_query text default '',
  p_mode text default 'hybrid',
  p_query_embedding extensions.vector(1536) default null,
  p_limit integer default 20,
  p_offset integer default 0,
  p_source text default null,
  p_jurisdiction text default null,
  p_content_type text default null,
  p_language text default null,
  p_tag text default null,
  p_range text default 'latest',
  p_count text default 'none'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
declare
  v_query_text text := trim(coalesce(p_query, ''));
  v_mode text := lower(trim(coalesce(p_mode, 'hybrid')));
  v_count_mode text := lower(trim(coalesce(p_count, 'none')));
  v_tsquery tsquery;
  v_exact jsonb := worldcons_query_case_reference_v1(p_query);
  v_exact_source text := v_exact ->> 'sourceKey';
  v_exact_key text := v_exact ->> 'caseKey';
  v_candidate_limit integer := least(greatest((coalesce(p_offset, 0) + coalesce(p_limit, 20) + 1) * 3, 100), 30063);
  v_entries jsonb := '[]'::jsonb;
  v_page_count integer := 0;
  v_total bigint;
  v_total_is_exact boolean := false;
  v_has_more boolean := false;
  v_retrieval_mode text;
begin
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception using errcode = '22023', message = 'WORLDCONS_SEARCH_INVALID_LIMIT';
  end if;
  if p_offset is null or p_offset not between 0 and 10000 then
    raise exception using errcode = '22023', message = 'WORLDCONS_SEARCH_INVALID_OFFSET';
  end if;
  if length(v_query_text) > 200 then
    raise exception using errcode = '22023', message = 'WORLDCONS_SEARCH_INVALID_QUERY';
  end if;
  if v_mode not in ('fulltext', 'semantic', 'hybrid') then
    raise exception using errcode = '22023', message = 'WORLDCONS_SEARCH_INVALID_MODE';
  end if;
  if v_count_mode not in ('exact', 'planned', 'estimated', 'none') then
    raise exception using errcode = '22023', message = 'WORLDCONS_SEARCH_INVALID_COUNT';
  end if;
  if coalesce(p_range, 'latest') not in ('latest', 'today', 'week', 'month') then
    raise exception using errcode = '22023', message = 'WORLDCONS_SEARCH_INVALID_RANGE';
  end if;
  if v_query_text <> '' then
    v_tsquery := websearch_to_tsquery('simple', v_query_text);
  end if;
  if v_exact is null and v_mode in ('semantic', 'hybrid') and v_query_text <> '' and p_query_embedding is null then
    raise exception using errcode = '22023', message = 'WORLDCONS_SEARCH_EMBEDDING_REQUIRED';
  end if;
  if v_exact is not null and p_source is not null and p_source <> v_exact_source then
    return jsonb_build_object(
      'entries', '[]'::jsonb,
      'retrievalMode', 'exact-case',
      'total', 0,
      'hasMore', false,
      'totalIsExact', v_count_mode = 'exact'
    );
  end if;

  if v_exact is not null then
    v_retrieval_mode := 'exact-case';
    with filtered as (
      select article.*
      from public_article_projection_p3 article
      where article.source_key = v_exact_source
        and article.case_key = v_exact_key
        and (p_source is null or article.source_key = p_source)
        and (p_jurisdiction is null or article.jurisdiction = p_jurisdiction)
        and (p_content_type is null or article.content_type = p_content_type)
        and (p_language is null or article.original_language = p_language)
        and (p_tag is null or exists (
          select 1 from jsonb_array_elements(coalesce(article.article_tags, '[]'::jsonb)) item
          where item -> 'tags' ->> 'slug' = p_tag or item -> 'tags' ->> 'name' = p_tag
        ))
        and (
          coalesce(p_range, 'latest') = 'latest'
          or (p_range = 'today' and article.original_published_at >= current_date)
          or (p_range = 'week' and article.original_published_at >= current_date - interval '7 days')
          or (p_range = 'month' and article.original_published_at >= current_date - interval '30 days')
        )
    ), page as (
      select id, original_published_at
      from filtered
      order by original_published_at desc nulls last, id
      limit p_limit + 1 offset p_offset
    )
    select coalesce(jsonb_agg(jsonb_build_object('id', page.id) order by page.original_published_at desc nulls last, page.id), '[]'::jsonb), count(*)::integer
      into v_entries, v_page_count
    from page;

    if v_count_mode = 'exact' then
      select count(*)::bigint into v_total
      from public_article_projection_p3 article
      where article.source_key = v_exact_source
        and article.case_key = v_exact_key
        and (p_source is null or article.source_key = p_source)
        and (p_jurisdiction is null or article.jurisdiction = p_jurisdiction)
        and (p_content_type is null or article.content_type = p_content_type)
        and (p_language is null or article.original_language = p_language)
        and (p_tag is null or exists (
          select 1 from jsonb_array_elements(coalesce(article.article_tags, '[]'::jsonb)) item
          where item -> 'tags' ->> 'slug' = p_tag or item -> 'tags' ->> 'name' = p_tag
        ))
        and (
          coalesce(p_range, 'latest') = 'latest'
          or (p_range = 'today' and article.original_published_at >= current_date)
          or (p_range = 'week' and article.original_published_at >= current_date - interval '7 days')
          or (p_range = 'month' and article.original_published_at >= current_date - interval '30 days')
        );
      v_total_is_exact := true;
    end if;

  elsif v_query_text = '' then
    v_retrieval_mode := 'latest';
    with filtered as (
      select article.*
      from public_article_projection_p3 article
      where (p_source is null or article.source_key = p_source)
        and (p_jurisdiction is null or article.jurisdiction = p_jurisdiction)
        and (p_content_type is null or article.content_type = p_content_type)
        and (p_language is null or article.original_language = p_language)
        and (p_tag is null or exists (
          select 1 from jsonb_array_elements(coalesce(article.article_tags, '[]'::jsonb)) item
          where item -> 'tags' ->> 'slug' = p_tag or item -> 'tags' ->> 'name' = p_tag
        ))
        and (
          coalesce(p_range, 'latest') = 'latest'
          or (p_range = 'today' and article.original_published_at >= current_date)
          or (p_range = 'week' and article.original_published_at >= current_date - interval '7 days')
          or (p_range = 'month' and article.original_published_at >= current_date - interval '30 days')
        )
    ), page as (
      select id, original_published_at
      from filtered
      order by original_published_at desc nulls last, id
      limit p_limit + 1 offset p_offset
    )
    select coalesce(jsonb_agg(jsonb_build_object('id', page.id) order by page.original_published_at desc nulls last, page.id), '[]'::jsonb), count(*)::integer
      into v_entries, v_page_count
    from page;

    if v_count_mode = 'exact' then
      select count(*)::bigint into v_total
      from public_article_projection_p3 article
      where (p_source is null or article.source_key = p_source)
        and (p_jurisdiction is null or article.jurisdiction = p_jurisdiction)
        and (p_content_type is null or article.content_type = p_content_type)
        and (p_language is null or article.original_language = p_language)
        and (p_tag is null or exists (
          select 1 from jsonb_array_elements(coalesce(article.article_tags, '[]'::jsonb)) item
          where item -> 'tags' ->> 'slug' = p_tag or item -> 'tags' ->> 'name' = p_tag
        ))
        and (
          coalesce(p_range, 'latest') = 'latest'
          or (p_range = 'today' and article.original_published_at >= current_date)
          or (p_range = 'week' and article.original_published_at >= current_date - interval '7 days')
          or (p_range = 'month' and article.original_published_at >= current_date - interval '30 days')
        );
      v_total_is_exact := true;
    end if;

  elsif v_mode = 'fulltext' then
    v_retrieval_mode := 'fulltext';
    with ranked as (
      select
        article.id,
        ts_rank_cd(article.search_vector, v_tsquery, 32)::double precision as score,
        article.original_published_at,
        case when lower(regexp_replace(trim(coalesce(article.korean_title, '')), '[[:space:]]+', ' ', 'g')) = lower(regexp_replace(v_query_text, '[[:space:]]+', ' ', 'g'))
               or lower(regexp_replace(trim(coalesce(article.original_title, '')), '[[:space:]]+', ' ', 'g')) = lower(regexp_replace(v_query_text, '[[:space:]]+', ' ', 'g')) then true else false end as exact_title
      from public_article_projection_p3 article
      where article.search_vector @@ v_tsquery
        and (p_source is null or article.source_key = p_source)
        and (p_jurisdiction is null or article.jurisdiction = p_jurisdiction)
        and (p_content_type is null or article.content_type = p_content_type)
        and (p_language is null or article.original_language = p_language)
        and (p_tag is null or exists (
          select 1 from jsonb_array_elements(coalesce(article.article_tags, '[]'::jsonb)) item
          where item -> 'tags' ->> 'slug' = p_tag or item -> 'tags' ->> 'name' = p_tag
        ))
        and (
          coalesce(p_range, 'latest') = 'latest'
          or (p_range = 'today' and article.original_published_at >= current_date)
          or (p_range = 'week' and article.original_published_at >= current_date - interval '7 days')
          or (p_range = 'month' and article.original_published_at >= current_date - interval '30 days')
        )
    ), page as (
      select * from ranked
      order by exact_title desc, score desc, original_published_at desc nulls last, id
      limit p_limit + 1 offset p_offset
    )
    select coalesce(jsonb_agg(jsonb_build_object('id', page.id, 'score', page.score) order by page.exact_title desc, page.score desc, page.original_published_at desc nulls last, page.id), '[]'::jsonb), count(*)::integer
      into v_entries, v_page_count
    from page;

    if v_count_mode = 'exact' then
      select count(*)::bigint into v_total
      from public_article_projection_p3 article
      where article.search_vector @@ v_tsquery
        and (p_source is null or article.source_key = p_source)
        and (p_jurisdiction is null or article.jurisdiction = p_jurisdiction)
        and (p_content_type is null or article.content_type = p_content_type)
        and (p_language is null or article.original_language = p_language)
        and (p_tag is null or exists (
          select 1 from jsonb_array_elements(coalesce(article.article_tags, '[]'::jsonb)) item
          where item -> 'tags' ->> 'slug' = p_tag or item -> 'tags' ->> 'name' = p_tag
        ))
        and (
          coalesce(p_range, 'latest') = 'latest'
          or (p_range = 'today' and article.original_published_at >= current_date)
          or (p_range = 'week' and article.original_published_at >= current_date - interval '7 days')
          or (p_range = 'month' and article.original_published_at >= current_date - interval '30 days')
        );
      v_total_is_exact := true;
    end if;

  elsif v_mode = 'semantic' then
    v_retrieval_mode := 'semantic';
    with ranked as (
      select
        article.id,
        (1 - (article.embedding OPERATOR(extensions.<=>) p_query_embedding))::double precision as similarity,
        article.original_published_at
      from public_article_projection_p3 article
      where article.embedding is not null
        and (p_source is null or article.source_key = p_source)
        and (p_jurisdiction is null or article.jurisdiction = p_jurisdiction)
        and (p_content_type is null or article.content_type = p_content_type)
        and (p_language is null or article.original_language = p_language)
        and (p_tag is null or exists (
          select 1 from jsonb_array_elements(coalesce(article.article_tags, '[]'::jsonb)) item
          where item -> 'tags' ->> 'slug' = p_tag or item -> 'tags' ->> 'name' = p_tag
        ))
        and (
          coalesce(p_range, 'latest') = 'latest'
          or (p_range = 'today' and article.original_published_at >= current_date)
          or (p_range = 'week' and article.original_published_at >= current_date - interval '7 days')
          or (p_range = 'month' and article.original_published_at >= current_date - interval '30 days')
        )
      order by article.embedding OPERATOR(extensions.<=>) p_query_embedding,
        article.original_published_at desc nulls last, article.id
      limit p_offset + p_limit + 1
    ), page as (
      select * from ranked
      order by similarity desc, original_published_at desc nulls last, id
      offset p_offset limit p_limit + 1
    )
    select coalesce(jsonb_agg(jsonb_build_object('id', page.id, 'score', page.similarity, 'semanticSimilarity', page.similarity) order by page.similarity desc, page.original_published_at desc nulls last, page.id), '[]'::jsonb), count(*)::integer
      into v_entries, v_page_count
    from page;

    if v_count_mode = 'exact' then
      select count(*)::bigint into v_total
      from public_article_projection_p3 article
      where article.embedding is not null
        and (p_source is null or article.source_key = p_source)
        and (p_jurisdiction is null or article.jurisdiction = p_jurisdiction)
        and (p_content_type is null or article.content_type = p_content_type)
        and (p_language is null or article.original_language = p_language)
        and (p_tag is null or exists (
          select 1 from jsonb_array_elements(coalesce(article.article_tags, '[]'::jsonb)) item
          where item -> 'tags' ->> 'slug' = p_tag or item -> 'tags' ->> 'name' = p_tag
        ))
        and (
          coalesce(p_range, 'latest') = 'latest'
          or (p_range = 'today' and article.original_published_at >= current_date)
          or (p_range = 'week' and article.original_published_at >= current_date - interval '7 days')
          or (p_range = 'month' and article.original_published_at >= current_date - interval '30 days')
        );
      v_total_is_exact := true;
    end if;

  else
    v_retrieval_mode := 'hybrid';
    with filtered as (
      select article.*,
        case when lower(regexp_replace(trim(coalesce(article.korean_title, '')), '[[:space:]]+', ' ', 'g')) = lower(regexp_replace(v_query_text, '[[:space:]]+', ' ', 'g'))
               or lower(regexp_replace(trim(coalesce(article.original_title, '')), '[[:space:]]+', ' ', 'g')) = lower(regexp_replace(v_query_text, '[[:space:]]+', ' ', 'g')) then true else false end as exact_title
      from public_article_projection_p3 article
      where (p_source is null or article.source_key = p_source)
        and (p_jurisdiction is null or article.jurisdiction = p_jurisdiction)
        and (p_content_type is null or article.content_type = p_content_type)
        and (p_language is null or article.original_language = p_language)
        and (p_tag is null or exists (
          select 1 from jsonb_array_elements(coalesce(article.article_tags, '[]'::jsonb)) item
          where item -> 'tags' ->> 'slug' = p_tag or item -> 'tags' ->> 'name' = p_tag
        ))
        and (
          coalesce(p_range, 'latest') = 'latest'
          or (p_range = 'today' and article.original_published_at >= current_date)
          or (p_range = 'week' and article.original_published_at >= current_date - interval '7 days')
          or (p_range = 'month' and article.original_published_at >= current_date - interval '30 days')
        )
    ), lexical_ordered as (
      select filtered.id, filtered.exact_title, filtered.original_published_at,
        ts_rank_cd(filtered.search_vector, v_tsquery, 32)::double precision as lexical_score
      from filtered
      where filtered.search_vector @@ v_tsquery
      order by filtered.exact_title desc, lexical_score desc,
        filtered.original_published_at desc nulls last, filtered.id
      limit v_candidate_limit
    ), lexical as (
      select lexical_ordered.id, lexical_ordered.exact_title, lexical_ordered.original_published_at,
        row_number() over (
          order by lexical_ordered.exact_title desc, lexical_ordered.lexical_score desc,
            lexical_ordered.original_published_at desc nulls last, lexical_ordered.id
        )::integer as lexical_rank
      from lexical_ordered
    ), semantic_ordered as (
      select filtered.id, filtered.exact_title, filtered.original_published_at,
        (1 - (filtered.embedding OPERATOR(extensions.<=>) p_query_embedding))::double precision as semantic_similarity
      from filtered
      where filtered.embedding is not null
      order by filtered.embedding OPERATOR(extensions.<=>) p_query_embedding,
        filtered.original_published_at desc nulls last, filtered.id
      limit v_candidate_limit
    ), semantic as (
      select semantic_ordered.id, semantic_ordered.exact_title, semantic_ordered.original_published_at,
        row_number() over (
          order by semantic_ordered.semantic_similarity desc,
            semantic_ordered.original_published_at desc nulls last, semantic_ordered.id
        )::integer as semantic_rank,
        semantic_ordered.semantic_similarity
      from semantic_ordered
    ), candidates as (
      select
        coalesce(lexical.id, semantic.id) as id,
        coalesce(lexical.exact_title, semantic.exact_title, false) as exact_title,
        coalesce(lexical.original_published_at, semantic.original_published_at) as original_published_at,
        lexical.lexical_rank,
        semantic.semantic_rank,
        semantic.semantic_similarity,
        (case when lexical.lexical_rank is null then 0 else 1.0 / (60 + lexical.lexical_rank) end)
          + (case when semantic.semantic_rank is null then 0 else 1.0 / (60 + semantic.semantic_rank) end) as score
      from lexical
      full outer join semantic on semantic.id = lexical.id
    ), page as (
      select * from candidates
      order by exact_title desc, score desc, original_published_at desc nulls last, id
      offset p_offset limit p_limit + 1
    )
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', page.id,
      'score', page.score,
      'lexicalRank', page.lexical_rank,
      'semanticRank', page.semantic_rank,
      'semanticSimilarity', page.semantic_similarity
    ) order by page.exact_title desc, page.score desc, page.original_published_at desc nulls last, page.id), '[]'::jsonb), count(*)::integer
      into v_entries, v_page_count
    from page;

    if v_count_mode = 'exact' then
      select count(*)::bigint into v_total
      from public_article_projection_p3 article
      where (article.search_vector @@ v_tsquery or article.embedding is not null)
        and (p_source is null or article.source_key = p_source)
        and (p_jurisdiction is null or article.jurisdiction = p_jurisdiction)
        and (p_content_type is null or article.content_type = p_content_type)
        and (p_language is null or article.original_language = p_language)
        and (p_tag is null or exists (
          select 1 from jsonb_array_elements(coalesce(article.article_tags, '[]'::jsonb)) item
          where item -> 'tags' ->> 'slug' = p_tag or item -> 'tags' ->> 'name' = p_tag
        ))
        and (
          coalesce(p_range, 'latest') = 'latest'
          or (p_range = 'today' and article.original_published_at >= current_date)
          or (p_range = 'week' and article.original_published_at >= current_date - interval '7 days')
          or (p_range = 'month' and article.original_published_at >= current_date - interval '30 days')
        );
      v_total_is_exact := true;
    end if;
  end if;

  v_has_more := v_page_count > p_limit;
  if v_page_count > p_limit then
    v_entries := coalesce((
      select jsonb_agg(value order by ordinality)
      from jsonb_array_elements(v_entries) with ordinality as item(value, ordinality)
      where ordinality <= p_limit
    ), '[]'::jsonb);
  end if;

  if not v_total_is_exact then
    v_total := p_offset + least(v_page_count, p_limit) + case when v_has_more then 1 else 0 end;
  end if;

  return jsonb_build_object(
    'entries', v_entries,
    'retrievalMode', v_retrieval_mode,
    'total', coalesce(v_total, 0),
    'hasMore', v_has_more,
    'totalIsExact', v_total_is_exact
  );
end;
$function$;

create or replace function worldcons_provider_search_v4(
  p_query text default '',
  p_mode text default 'hybrid',
  p_query_embedding extensions.vector(1536) default null,
  p_limit integer default 10,
  p_offset integer default 0,
  p_source text default null,
  p_jurisdiction text default null,
  p_range text default 'latest',
  p_count text default 'none'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
declare
  v_page jsonb;
  v_items jsonb;
begin
  v_page := worldcons_ranked_search_page_v1(
    p_query,
    p_mode,
    p_query_embedding,
    p_limit,
    p_offset,
    p_source,
    p_jurisdiction,
    null,
    null,
    null,
    p_range,
    p_count
  );

  with requested as (
    select
      (entry.value ->> 'id')::uuid as id,
      entry.value,
      entry.ordinality
    from jsonb_array_elements(coalesce(v_page -> 'entries', '[]'::jsonb)) with ordinality as entry(value, ordinality)
  )
  select coalesce(jsonb_agg(
    provider_search_v3_item(
      article,
      nullif(requested.value ->> 'score', '')::double precision,
      nullif(requested.value ->> 'lexicalRank', '')::integer,
      nullif(requested.value ->> 'semanticRank', '')::integer,
      nullif(requested.value ->> 'semanticSimilarity', '')::double precision
    ) order by requested.ordinality
  ), '[]'::jsonb)
  into v_items
  from requested
  join public_article_projection_p3 article on article.id = requested.id;

  return jsonb_build_object(
    'items', v_items,
    'retrievalMode', v_page ->> 'retrievalMode',
    'total', coalesce((v_page ->> 'total')::bigint, 0),
    'hasMore', coalesce((v_page ->> 'hasMore')::boolean, false),
    'totalIsExact', coalesce((v_page ->> 'totalIsExact')::boolean, false)
  );
end;
$function$;

comment on function worldcons_case_key_v1(text, text, text, text) is
  'Returns a source-aware canonical constitutional case key for Germany, France, Spain, or the US.';
comment on function worldcons_ranked_search_page_v1(text, text, extensions.vector, integer, integer, text, text, text, text, text, text, text) is
  'Provides indexed exact-case and DB-native fulltext/semantic/hybrid pagination for published WorldCons records.';
comment on function worldcons_provider_search_v4(text, text, extensions.vector, integer, integer, text, text, text, text) is
  'Provider search contract with canonical case keys, DB-native pagination, explicit count semantics, and bounded hybrid RRF.';

revoke all on function worldcons_ranked_search_page_v1(text, text, extensions.vector, integer, integer, text, text, text, text, text, text, text) from public;
revoke all on function worldcons_provider_search_v4(text, text, extensions.vector, integer, integer, text, text, text, text) from public;

do $permissions$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function worldcons_ranked_search_page_v1(text, text, extensions.vector, integer, integer, text, text, text, text, text, text, text) from anon;
    revoke all on function worldcons_provider_search_v4(text, text, extensions.vector, integer, integer, text, text, text, text) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function worldcons_ranked_search_page_v1(text, text, extensions.vector, integer, integer, text, text, text, text, text, text, text) from authenticated;
    revoke all on function worldcons_provider_search_v4(text, text, extensions.vector, integer, integer, text, text, text, text) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function worldcons_ranked_search_page_v1(text, text, extensions.vector, integer, integer, text, text, text, text, text, text, text) to service_role;
    grant execute on function worldcons_provider_search_v4(text, text, extensions.vector, integer, integer, text, text, text, text) to service_role;
  end if;
end;
$permissions$;

notify pgrst, 'reload schema';
