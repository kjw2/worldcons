create extension if not exists pgcrypto;
create extension if not exists vector;
create extension if not exists pg_trgm;

create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create table if not exists sources (
  id uuid primary key default gen_random_uuid(),
  source_key text unique not null,
  name text not null,
  jurisdiction text not null,
  base_url text not null,
  language text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists articles (
  id uuid primary key default gen_random_uuid(),
  source_id uuid references sources(id),
  source_key text not null,
  jurisdiction text not null,
  institution_name text not null,
  content_type text not null,
  original_url text not null,
  canonical_url text not null,
  original_language text not null,
  original_title text,
  korean_title text,
  original_published_at timestamptz,
  discovered_at timestamptz not null default now(),
  fetched_at timestamptz,
  summarized_at timestamptz,
  status text not null default 'discovered',
  slug text unique not null,
  raw_text text,
  cleaned_text text,
  summary_json jsonb,
  search_vector tsvector,
  embedding vector(1536),
  content_hash text,
  source_metadata jsonb,
  error_metadata jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint articles_status_check check (
    status in (
      'discovered',
      'metadata_only',
      'robots_disallowed',
      'blocked',
      'timeout',
      'fetched',
      'cleaned',
      'summarizing',
      'summarized',
      'failed_fetch',
      'failed_summary',
      'needs_review'
    )
  ),
  constraint articles_content_type_check check (
    content_type in ('news', 'press_release', 'decision', 'opinion', 'order', 'other')
  )
);

create unique index if not exists articles_canonical_url_key on articles (canonical_url);

create table if not exists tags (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  name text not null,
  normalized_name text not null,
  type text not null,
  description text,
  article_count integer not null default 0,
  latest_article_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists article_tags (
  article_id uuid references articles(id) on delete cascade,
  tag_id uuid references tags(id) on delete cascade,
  confidence numeric,
  created_at timestamptz not null default now(),
  primary key (article_id, tag_id)
);

create table if not exists ingestion_runs (
  id uuid primary key default gen_random_uuid(),
  source_key text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null,
  discovered_count integer not null default 0,
  fetched_count integer not null default 0,
  summarized_count integer not null default 0,
  failed_count integer not null default 0,
  error_message text,
  metadata jsonb
);

create table if not exists source_url_candidates (
  id uuid primary key default gen_random_uuid(),
  source_key text not null,
  url text not null,
  candidate_type text not null,
  discovered_by text not null,
  status text not null default 'pending',
  last_attempt_at timestamptz,
  attempt_count integer not null default 0,
  last_error_code text,
  last_error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(source_key, url),
  constraint source_url_candidates_status_check check (
    status in ('pending', 'retrying', 'fetched', 'failed', 'ignored')
  )
);

create table if not exists glossary_terms (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  term text not null,
  korean_term text,
  definition text,
  jurisdiction text,
  related_tags text[],
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists articles_slug_idx on articles (slug);
create index if not exists articles_source_key_idx on articles (source_key);
create index if not exists articles_jurisdiction_idx on articles (jurisdiction);
create index if not exists articles_content_type_idx on articles (content_type);
create index if not exists articles_original_published_at_idx on articles (original_published_at desc nulls last);
create index if not exists articles_status_idx on articles (status);
create index if not exists articles_search_vector_idx on articles using gin (search_vector);
create index if not exists articles_korean_title_trgm_idx on articles using gin (korean_title gin_trgm_ops);
create index if not exists articles_original_title_trgm_idx on articles using gin (original_title gin_trgm_ops);
create index if not exists articles_embedding_idx on articles using ivfflat (embedding vector_cosine_ops) with (lists = 100);
create index if not exists tags_slug_idx on tags (slug);
create index if not exists tags_type_idx on tags (type);
create index if not exists tags_article_count_idx on tags (article_count desc);
create index if not exists article_tags_article_id_idx on article_tags (article_id);
create index if not exists article_tags_tag_id_idx on article_tags (tag_id);
create index if not exists ingestion_runs_started_at_idx on ingestion_runs (started_at desc);
create index if not exists source_url_candidates_source_status_idx on source_url_candidates (source_key, status, created_at desc);

create or replace function articles_search_vector_update()
returns trigger as $$
begin
  new.search_vector :=
    setweight(to_tsvector('simple', coalesce(new.korean_title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(new.original_title, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(new.cleaned_text, '')), 'C') ||
    setweight(to_tsvector('simple', coalesce(new.summary_json::text, '')), 'D');
  return new;
end;
$$ language plpgsql;

drop trigger if exists articles_search_vector_trigger on articles;
create trigger articles_search_vector_trigger
before insert or update of korean_title, original_title, cleaned_text, summary_json
on articles
for each row execute function articles_search_vector_update();

drop trigger if exists sources_updated_at_trigger on sources;
create trigger sources_updated_at_trigger
before update on sources
for each row execute function set_updated_at();

drop trigger if exists articles_updated_at_trigger on articles;
create trigger articles_updated_at_trigger
before update on articles
for each row execute function set_updated_at();

drop trigger if exists tags_updated_at_trigger on tags;
create trigger tags_updated_at_trigger
before update on tags
for each row execute function set_updated_at();

drop trigger if exists glossary_terms_updated_at_trigger on glossary_terms;
create trigger glossary_terms_updated_at_trigger
before update on glossary_terms
for each row execute function set_updated_at();

drop trigger if exists source_url_candidates_updated_at_trigger on source_url_candidates;
create trigger source_url_candidates_updated_at_trigger
before update on source_url_candidates
for each row execute function set_updated_at();

create or replace function refresh_tag_counts()
returns void as $$
begin
  update tags
  set
    article_count = counts.article_count,
    latest_article_at = counts.latest_article_at,
    updated_at = now()
  from (
    select
      at.tag_id,
      count(*)::integer as article_count,
      max(a.original_published_at) as latest_article_at
    from article_tags at
    join articles a on a.id = at.article_id
    where a.status = 'summarized'
      and (a.source_metadata #>> '{collection,publishable}') = 'true'
    group by at.tag_id
  ) counts
  where tags.id = counts.tag_id;

  update tags
  set article_count = 0, latest_article_at = null, updated_at = now()
  where not exists (
    select 1
    from article_tags at
    join articles a on a.id = at.article_id
    where at.tag_id = tags.id
      and a.status = 'summarized'
      and (a.source_metadata #>> '{collection,publishable}') = 'true'
  );
end;
$$ language plpgsql;

insert into sources (
  source_key,
  name,
  jurisdiction,
  base_url,
  language,
  is_active
) values
(
  'de-bverfg',
  'Federal Constitutional Court of Germany',
  'Germany',
  'https://www.bundesverfassungsgericht.de',
  'de',
  true
),
(
  'us-scotus',
  'Supreme Court of the United States',
  'United States',
  'https://www.supremecourt.gov',
  'en',
  true
),
(
  'fr-conseil-constitutionnel',
  'Conseil constitutionnel',
  'France',
  'https://www.conseil-constitutionnel.fr',
  'fr',
  true
)
on conflict (source_key) do nothing;
