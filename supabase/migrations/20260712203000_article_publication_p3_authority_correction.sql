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
  ), '[]'::jsonb) as article_tags
from article_publications_p3 p
join article_content_versions_p3 v on v.id = p.version_id and v.article_id = p.article_id
where p.state = 'published';

create or replace view public_tag_projection_p3
with (security_barrier = true)
as
select
  t.id, t.slug, t.name, t.normalized_name, t.type, t.description,
  count(p.id)::integer as article_count,
  max(p.original_published_at) as latest_article_at,
  t.created_at, t.updated_at
from tags t
left join article_tags at on at.tag_id = t.id
left join public_article_projection_p3 p on p.id = at.article_id
group by t.id, t.slug, t.name, t.normalized_name, t.type, t.description, t.created_at, t.updated_at;

create or replace function public_jurisdiction_article_counts_p3(range_start timestamptz default null)
returns table (jurisdiction text, article_count bigint)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.jurisdiction, count(*)::bigint
  from public_article_projection_p3 p
  where range_start is null or p.original_published_at >= range_start
  group by p.jurisdiction;
$$;

create or replace function match_public_article_versions_p3(
  query_embedding extensions.vector(1536),
  match_count integer default 20,
  source_filter text default null,
  jurisdiction_filter text default null,
  content_type_filter text default null,
  language_filter text default null
)
returns table (article_id uuid, similarity double precision)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.id, 1 - (p.embedding OPERATOR(extensions.<=>) query_embedding) as similarity
  from public_article_projection_p3 p
  where p.embedding is not null
    and (source_filter is null or p.source_key = source_filter)
    and (jurisdiction_filter is null or p.jurisdiction = jurisdiction_filter)
    and (content_type_filter is null or p.content_type = content_type_filter)
    and (language_filter is null or p.original_language = language_filter)
  order by p.embedding OPERATOR(extensions.<=>) query_embedding
  limit least(greatest(coalesce(match_count, 20), 1), 200);
$$;
