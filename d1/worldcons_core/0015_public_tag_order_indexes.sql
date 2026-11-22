-- WorldCons D1 additive migration: worldcons_core 0015
-- Public filter-bar tag ordering without a full tag-table scan.
--
-- `/list` and `/search` load the first 30 tags ordered by `article_count`
-- (`latest_article_at` on some surfaces). Without an index SQLite scans and
-- sorts the whole `tags` relation on every cold render (measured ~9.9k rows read
-- for a 30-row response). These indexes let the ordered read stop after the
-- requested page.
--
-- Additive index-only migration; no table or row is rewritten.
--
-- @d1-verify {"type":"index","name":"tags_article_count_idx","sqlIncludes":["tags_article_count_idx","article_count"]}
-- @d1-verify {"type":"index","name":"tags_latest_article_at_idx","sqlIncludes":["tags_latest_article_at_idx","latest_article_at"]}

create index if not exists tags_article_count_idx
  on tags (article_count, id);

create index if not exists tags_latest_article_at_idx
  on tags (latest_article_at, id);
