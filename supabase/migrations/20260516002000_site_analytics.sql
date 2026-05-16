create table if not exists site_events (
  id uuid primary key default gen_random_uuid(),
  occurred_at timestamptz not null default now(),
  event_type text not null,
  path text,
  article_id uuid references articles(id) on delete set null,
  article_slug text,
  article_title text,
  tag_slug text,
  tag_name text,
  source_key text,
  jurisdiction text,
  institution_name text,
  search_query text,
  search_mode text,
  result_count integer,
  referrer_host text,
  user_agent_family text,
  device_type text,
  metadata jsonb not null default '{}'::jsonb,
  constraint site_events_event_type_check check (
    event_type in (
      'page_view',
      'article_view',
      'search',
      'tag_click',
      'tag_view',
      'source_view',
      'article_click',
      'external_link_click',
      'admin_action',
      'admin_review_action'
    )
  )
);

create index if not exists site_events_occurred_at_idx on site_events (occurred_at desc);
create index if not exists site_events_event_type_idx on site_events (event_type);
create index if not exists site_events_article_slug_idx on site_events (article_slug);
create index if not exists site_events_tag_slug_idx on site_events (tag_slug);
create index if not exists site_events_source_key_idx on site_events (source_key);
create index if not exists site_events_jurisdiction_idx on site_events (jurisdiction);
create index if not exists site_events_search_query_idx on site_events (search_query);
