create table if not exists article_view_counts (
  article_slug text primary key,
  article_id uuid references articles(id) on delete set null,
  view_count bigint not null default 0,
  updated_at timestamptz not null default now()
);

create index if not exists article_view_counts_view_count_idx on article_view_counts (view_count desc);

insert into article_view_counts (article_slug, article_id, view_count, updated_at)
select
  article_slug,
  (array_agg(article_id) filter (where article_id is not null))[1] as article_id,
  count(*)::bigint as view_count,
  now() as updated_at
from site_events
where event_type = 'article_view'
  and article_slug is not null
  and article_slug <> ''
group by article_slug
on conflict (article_slug) do update
set
  article_id = coalesce(excluded.article_id, article_view_counts.article_id),
  view_count = excluded.view_count,
  updated_at = now();

create or replace function increment_article_view_count()
returns trigger
language plpgsql
as $$
begin
  if new.event_type = 'article_view' and new.article_slug is not null and new.article_slug <> '' then
    insert into article_view_counts (article_slug, article_id, view_count, updated_at)
    values (new.article_slug, new.article_id, 1, now())
    on conflict (article_slug) do update
    set
      article_id = coalesce(excluded.article_id, article_view_counts.article_id),
      view_count = article_view_counts.view_count + 1,
      updated_at = now();
  end if;

  return new;
end;
$$;

drop trigger if exists site_events_article_view_count_trigger on site_events;
create trigger site_events_article_view_count_trigger
after insert on site_events
for each row execute function increment_article_view_count();
