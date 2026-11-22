-- WorldCons D1 additive migration: worldcons_core 0014
-- Keep the materialized public-list publishability flag warm and bounded.
--
-- `articles.collection_publishable` is written by these triggers on insert and
-- whenever `source_metadata` changes, so newly ingested or corrected articles
-- are immediately visible to the public list predicate without a per-read JSON
-- parse. The two indexes back the public list candidate read and the published
-- P3 join. All statements are `if not exists`; this file is safe to replay.
--
-- @d1-verify {"type":"index","name":"articles_public_list_idx","sqlIncludes":["articles_public_list_idx","collection_publishable"]}
-- @d1-verify {"type":"index","name":"article_publications_p3_state_article_idx","sqlIncludes":["article_publications_p3_state_article_idx","state","article_id"]}
-- @d1-verify {"type":"trigger","name":"articles_collection_publishable_insert","sqlIncludes":["articles_collection_publishable_insert","collection_publishable","source_metadata"]}
-- @d1-verify {"type":"trigger","name":"articles_collection_publishable_update","sqlIncludes":["articles_collection_publishable_update","collection_publishable","source_metadata"]}

create trigger if not exists articles_collection_publishable_insert
after insert on articles
begin
  update articles set collection_publishable = case
      when json_valid(new.source_metadata)
        and (
          json_type(new.source_metadata, '$.collection.publishable') = 'true'
          or (
            json_type(new.source_metadata, '$.collection.publishable') = 'text'
            and json_extract(new.source_metadata, '$.collection.publishable') = 'true'
          )
        )
      then 1 else 0 end
    where id = new.id;
end;

create trigger if not exists articles_collection_publishable_update
after update of source_metadata on articles
begin
  update articles set collection_publishable = case
      when json_valid(new.source_metadata)
        and (
          json_type(new.source_metadata, '$.collection.publishable') = 'true'
          or (
            json_type(new.source_metadata, '$.collection.publishable') = 'text'
            and json_extract(new.source_metadata, '$.collection.publishable') = 'true'
          )
        )
      then 1 else 0 end
    where id = new.id;
end;

create index if not exists articles_public_list_idx
  on articles (status, catalog_ai_stale_v4, collection_publishable, original_published_at, id);

create index if not exists article_publications_p3_state_article_idx
  on article_publications_p3 (state, article_id, version_id);
