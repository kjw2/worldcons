begin;

-- worldcons_provider_search_v4 previously passed the complete security-barrier
-- projection row into provider_search_v3_item. That composite includes full raw
-- text, cleaned text, and a 1536-dimensional vector, even though provider search
-- returns only a bounded excerpt. Materialize only the requested scalar fields
-- after ranking so a ten-item response does not detoast unrelated payloads.
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
set search_path = public, extensions, pg_temp
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
    from jsonb_array_elements(coalesce(v_page -> 'entries', '[]'::jsonb))
      with ordinality as entry(value, ordinality)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', version.article_id,
    'slug', version.slug,
    'source_key', version.source_key,
    'jurisdiction', version.jurisdiction,
    'institution_name', version.institution_name,
    'content_type', version.content_type,
    'original_url', version.original_url,
    'canonical_url', version.canonical_url,
    'original_language', version.original_language,
    'original_title', version.original_title,
    'korean_title', version.korean_title,
    'original_published_at', version.original_published_at,
    'discovered_at', version.discovered_at,
    'fetched_at', version.fetched_at,
    'summarized_at', version.summarized_at,
    'summary_json', version.summary_json,
    'source_metadata', version.source_metadata,
    'article_tags', coalesce((
      select jsonb_agg(jsonb_build_object(
        'confidence', article_tag.confidence,
        'tags', jsonb_build_object(
          'id', tag.id,
          'slug', tag.slug,
          'name', tag.name,
          'normalized_name', tag.normalized_name,
          'type', tag.type,
          'description', tag.description,
          'article_count', tag.article_count,
          'latest_article_at', tag.latest_article_at
        )
      ) order by tag.slug)
      from article_tags article_tag
      join tags tag on tag.id = article_tag.tag_id
      where article_tag.article_id = version.article_id
    ), '[]'::jsonb),
    'case_number', coalesce(
      version.source_metadata ->> 'caseNumber',
      version.source_metadata ->> 'case_number',
      version.source_metadata ->> 'docketNumber',
      version.source_metadata ->> 'docket_number'
    ),
    'body_excerpt', left(version.cleaned_text, 4000),
    'content_hash', version.content_hash,
    'relevance_score', nullif(requested.value ->> 'score', '')::double precision,
    'lexical_rank', nullif(requested.value ->> 'lexicalRank', '')::integer,
    'semantic_rank', nullif(requested.value ->> 'semanticRank', '')::integer,
    'semantic_similarity', nullif(requested.value ->> 'semanticSimilarity', '')::double precision
  ) order by requested.ordinality), '[]'::jsonb)
  into v_items
  from requested
  join article_publications_p3 publication
    on publication.article_id = requested.id and publication.state = 'published'
  join article_content_versions_p3 version
    on version.id = publication.version_id and version.article_id = publication.article_id;

  return jsonb_build_object(
    'items', v_items,
    'retrievalMode', v_page ->> 'retrievalMode',
    'total', coalesce((v_page ->> 'total')::bigint, 0),
    'hasMore', coalesce((v_page ->> 'hasMore')::boolean, false),
    'totalIsExact', coalesce((v_page ->> 'totalIsExact')::boolean, false)
  );
end;
$function$;

revoke all on function worldcons_provider_search_v4(text, text, extensions.vector, integer, integer, text, text, text, text) from public;

do $permissions$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function worldcons_provider_search_v4(text, text, extensions.vector, integer, integer, text, text, text, text) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function worldcons_provider_search_v4(text, text, extensions.vector, integer, integer, text, text, text, text) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function worldcons_provider_search_v4(text, text, extensions.vector, integer, integer, text, text, text, text) to service_role;
  end if;
end;
$permissions$;

comment on function worldcons_provider_search_v4(text, text, extensions.vector, integer, integer, text, text, text, text) is
  'Provider search contract with bounded scalar result materialization that never passes full source text or embeddings through a composite projection row.';

notify pgrst, 'reload schema';

commit;
