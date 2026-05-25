create table if not exists glossary_candidates (
  id uuid primary key default gen_random_uuid(),
  tag_slug text unique not null,
  tag_name text not null,
  tag_type text not null,
  article_count integer not null default 0,
  suggested_slug text not null,
  source_languages text[] not null default array[]::text[],
  status text not null default 'pending',
  generated_at timestamptz not null default now(),
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint glossary_candidates_status_check check (status in ('pending', 'approved', 'ignored'))
);

create index if not exists glossary_candidates_status_count_idx on glossary_candidates (status, article_count desc);

drop trigger if exists glossary_candidates_updated_at_trigger on glossary_candidates;
create trigger glossary_candidates_updated_at_trigger
before update on glossary_candidates
for each row execute function set_updated_at();
