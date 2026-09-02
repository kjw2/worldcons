begin;

alter table articles
  add column if not exists embedding_provider text,
  add column if not exists embedding_model text,
  add column if not exists embedding_dimensions integer,
  add column if not exists embedding_input_hash text,
  add column if not exists embedding_generated_at timestamptz;

do $constraints$
begin
  if not exists (select 1 from pg_constraint where conname = 'articles_embedding_provider_check') then
    alter table articles add constraint articles_embedding_provider_check
      check (embedding_provider is null or embedding_provider = 'gemini');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'articles_embedding_model_check') then
    alter table articles add constraint articles_embedding_model_check
      check (embedding_model is null or embedding_model = 'gemini-embedding-001');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'articles_embedding_dimensions_check') then
    alter table articles add constraint articles_embedding_dimensions_check
      check (embedding_dimensions is null or embedding_dimensions = 1536);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'articles_embedding_input_hash_check') then
    alter table articles add constraint articles_embedding_input_hash_check
      check (embedding_input_hash is null or embedding_input_hash ~ '^[0-9a-f]{64}$');
  end if;
end;
$constraints$;

create table if not exists article_embedding_artifacts (
  article_version_id uuid primary key references article_content_versions_p3(id) on delete cascade,
  article_id uuid not null references articles(id) on delete cascade,
  content_hash text not null,
  provider text not null,
  model text not null,
  dimensions integer not null,
  input_hash text not null,
  embedding extensions.vector(1536) not null,
  generated_at timestamptz not null,
  updated_at timestamptz not null default now(),
  constraint article_embedding_artifacts_provider_check check (provider = 'gemini'),
  constraint article_embedding_artifacts_model_check check (model = 'gemini-embedding-001'),
  constraint article_embedding_artifacts_dimensions_check check (dimensions = 1536),
  constraint article_embedding_artifacts_content_hash_check check (content_hash ~ '^[0-9a-f]{64}$'),
  constraint article_embedding_artifacts_input_hash_check check (input_hash ~ '^[0-9a-f]{64}$'),
  constraint article_embedding_artifacts_article_version_key unique (article_id, article_version_id)
);

create index if not exists article_embedding_artifacts_article_idx
  on article_embedding_artifacts(article_id, generated_at desc);

alter table article_embedding_artifacts enable row level security;

create or replace function article_embedding_write_v1(
  p_article_id uuid,
  p_provider text,
  p_model text,
  p_dimensions integer,
  p_embedding extensions.vector(1536),
  p_input_hash text,
  p_generated_at timestamptz default now()
)
returns boolean
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $function$
declare
  v_article articles%rowtype;
  v_version article_content_versions_p3%rowtype;
begin
  if p_article_id is null
    or p_provider <> 'gemini'
    or p_model <> 'gemini-embedding-001'
    or p_dimensions <> 1536
    or p_embedding is null
    or p_input_hash is null
    or p_input_hash !~ '^[0-9a-f]{64}$'
    or p_generated_at is null
  then
    raise exception using errcode = '22023', message = 'ARTICLE_EMBEDDING_INVALID_INPUT';
  end if;

  update articles set
    embedding = p_embedding,
    embedding_provider = p_provider,
    embedding_model = p_model,
    embedding_dimensions = p_dimensions,
    embedding_input_hash = p_input_hash,
    embedding_generated_at = p_generated_at
  where id = p_article_id
  returning * into v_article;

  if not found then
    raise exception using errcode = 'P0002', message = 'ARTICLE_EMBEDDING_ARTICLE_NOT_FOUND';
  end if;

  -- P3 content versions are immutable. Store the vector as a derived artifact
  -- only when the currently published snapshot still has the same summary.
  select v.* into v_version
  from article_publications_p3 p
  join article_content_versions_p3 v on v.id = p.version_id and v.article_id = p.article_id
  where p.article_id = p_article_id
    and p.state = 'published'
    and v.summary_json is not distinct from v_article.summary_json;

  if found then
    insert into article_embedding_artifacts(
      article_version_id, article_id, content_hash, provider, model, dimensions,
      input_hash, embedding, generated_at, updated_at
    ) values (
      v_version.id, p_article_id, v_version.content_hash, p_provider, p_model,
      p_dimensions, p_input_hash, p_embedding, p_generated_at, now()
    )
    on conflict (article_version_id) do update set
      content_hash = excluded.content_hash,
      provider = excluded.provider,
      model = excluded.model,
      dimensions = excluded.dimensions,
      input_hash = excluded.input_hash,
      embedding = excluded.embedding,
      generated_at = excluded.generated_at,
      updated_at = now();
  end if;

  return true;
end;
$function$;

create or replace function article_embedding_readiness_v1()
returns jsonb
language sql
stable
security definer
set search_path = public, extensions, pg_temp
as $function$
  select jsonb_build_object(
    'missingArticleCount', (
      select count(*)::bigint
      from articles a
      where a.status = 'summarized'
        and (
          a.embedding is null
          or a.embedding_provider is distinct from 'gemini'
          or a.embedding_model is distinct from 'gemini-embedding-001'
          or a.embedding_dimensions is distinct from 1536
          or a.embedding_input_hash is null
        )
    ),
    'publishedVersionCount', (
      select count(*)::bigint
      from article_publications_p3 p
      where p.state = 'published'
    ),
    'missingPublishedArtifactCount', (
      select count(*)::bigint
      from article_publications_p3 p
      join article_content_versions_p3 v on v.id = p.version_id and v.article_id = p.article_id
      where p.state = 'published'
        and not exists (
          select 1
          from article_embedding_artifacts e
          where e.article_version_id = v.id
            and e.article_id = v.article_id
            and e.content_hash = v.content_hash
            and e.provider = 'gemini'
            and e.model = 'gemini-embedding-001'
            and e.dimensions = 1536
        )
    )
  );
$function$;

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
  coalesce(e.embedding, v.embedding) as embedding,
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
left join article_embedding_artifacts e
  on e.article_version_id = v.id and e.article_id = v.article_id and e.content_hash = v.content_hash
where p.state = 'published';

comment on table article_embedding_artifacts is
  'Mutable derived Gemini vectors for immutable P3 article versions; content snapshots remain unchanged.';
comment on function article_embedding_write_v1(uuid, text, text, integer, extensions.vector, text, timestamptz) is
  'Writes a provenance-locked Gemini vector to the legacy article and, when summaries match, its published P3 derived artifact.';
comment on function article_embedding_readiness_v1() is
  'Returns aggregate Gemini corpus and current published artifact coverage without article identifiers or content.';

revoke all on table article_embedding_artifacts from public;
revoke all on function article_embedding_write_v1(uuid, text, text, integer, extensions.vector, text, timestamptz) from public;
revoke all on function article_embedding_readiness_v1() from public;

do $permissions$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on table article_embedding_artifacts from anon;
    revoke all on function article_embedding_write_v1(uuid, text, text, integer, extensions.vector, text, timestamptz) from anon;
    revoke all on function article_embedding_readiness_v1() from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on table article_embedding_artifacts from authenticated;
    revoke all on function article_embedding_write_v1(uuid, text, text, integer, extensions.vector, text, timestamptz) from authenticated;
    revoke all on function article_embedding_readiness_v1() from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on table article_embedding_artifacts from service_role;
    grant execute on function article_embedding_write_v1(uuid, text, text, integer, extensions.vector, text, timestamptz) to service_role;
    grant execute on function article_embedding_readiness_v1() to service_role;
  end if;
end;
$permissions$;

commit;
