create index if not exists articles_public_feed_idx
on articles (original_published_at desc nulls last, id asc)
where status = 'summarized'
  and (source_metadata -> 'collection' ->> 'publishable') = 'true';

create index if not exists articles_public_source_feed_idx
on articles (source_key, original_published_at desc nulls last, id asc)
where status = 'summarized'
  and (source_metadata -> 'collection' ->> 'publishable') = 'true';

create index if not exists articles_public_jurisdiction_feed_idx
on articles (jurisdiction, original_published_at desc nulls last, id asc)
where status = 'summarized'
  and (source_metadata -> 'collection' ->> 'publishable') = 'true';

create index if not exists articles_public_content_type_feed_idx
on articles (content_type, original_published_at desc nulls last, id asc)
where status = 'summarized'
  and (source_metadata -> 'collection' ->> 'publishable') = 'true';

create index if not exists articles_public_language_feed_idx
on articles (original_language, original_published_at desc nulls last, id asc)
where status = 'summarized'
  and (source_metadata -> 'collection' ->> 'publishable') = 'true';

create index if not exists article_tags_tag_article_idx
on article_tags (tag_id, article_id);

create index if not exists tags_name_idx
on tags (name);
