create or replace function refresh_tag_counts()
returns void as $$
begin
  with counts as (
    select
      at.tag_id,
      count(*)::integer as article_count,
      max(a.original_published_at) as latest_article_at
    from article_tags at
    join articles a on a.id = at.article_id
    where a.status = 'summarized'
      and (a.source_metadata #>> '{collection,publishable}') = 'true'
    group by at.tag_id
  )
  update tags
  set
    article_count = counts.article_count,
    latest_article_at = counts.latest_article_at,
    updated_at = now()
  from counts
  where tags.id = counts.tag_id
    and (
      tags.article_count is distinct from counts.article_count
      or tags.latest_article_at is distinct from counts.latest_article_at
    );

  update tags
  set
    article_count = 0,
    latest_article_at = null,
    updated_at = now()
  where (tags.article_count <> 0 or tags.latest_article_at is not null)
    and not exists (
      select 1
      from article_tags at
      join articles a on a.id = at.article_id
      where at.tag_id = tags.id
        and a.status = 'summarized'
        and (a.source_metadata #>> '{collection,publishable}') = 'true'
    );
end;
$$ language plpgsql;
