-- WorldCons D1 additive migration: worldcons_core 0016
-- Prevent repeated full scans of article_tags by tag_id and tags by name.
-- Applied to production 2026-11-24; EXPLAIN QUERY PLAN verified covering index searches.
-- @d1-verify {"type":"index","name":"article_tags_tag_article_idx","sqlIncludes":["article_tags_tag_article_idx","tag_id","article_id"]}
-- @d1-verify {"type":"index","name":"tags_name_id_idx","sqlIncludes":["tags_name_id_idx","name","id"]}

create index if not exists article_tags_tag_article_idx on article_tags (tag_id, article_id);
create index if not exists tags_name_id_idx on tags (name, id);
