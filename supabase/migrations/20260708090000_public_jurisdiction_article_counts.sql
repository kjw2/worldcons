create index if not exists articles_public_range_jurisdiction_count_idx
on articles (original_published_at desc nulls last, jurisdiction)
where status = 'summarized'
  and (source_metadata -> 'collection' ->> 'publishable') = 'true';

create or replace function public_jurisdiction_article_counts(range_start timestamptz default null)
returns table (jurisdiction text, article_count bigint)
language sql
stable
as $$
  select
    a.jurisdiction,
    count(*)::bigint as article_count
  from articles a
  where a.status = 'summarized'
    and (a.source_metadata -> 'collection' ->> 'publishable') = 'true'
    and (range_start is null or a.original_published_at >= range_start)
  group by a.jurisdiction;
$$;
