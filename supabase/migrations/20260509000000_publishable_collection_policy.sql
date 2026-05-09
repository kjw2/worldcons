alter table articles drop constraint if exists articles_status_check;

alter table articles
  add constraint articles_status_check check (
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
  );

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
