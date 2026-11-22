-- WorldCons D1 additive migration: worldcons_core 0013
-- Public list read cost: materialize the textual publishability predicate.
--
-- Every public `/list` and `/search` candidate read used to evaluate
-- `json_type/json_extract(source_metadata, '$.collection.publishable')` once per
-- scanned article row. On a hot public list page that meant re-parsing the same
-- JSON for thousands of rows per request. This migration adds a stored INTEGER
-- column with the exact same predicate semantics (`true` boolean OR the string
-- "true", matching `isTextuallyPublishable`) and backfills it once. Triggers
-- that keep it in sync live in migration 0014.
--
-- Idempotency: the `articles` table verify directive is satisfied when the
-- column already exists (for example a fresh database created from the full
-- emitted DDL through `d1:apply-schema`), so this ALTER is never replayed
-- against a table that already has the column.
--
-- @d1-verify {"type":"table","name":"articles","sqlIncludes":["collection_publishable integer not null default 0"]}

alter table articles add column collection_publishable integer not null default 0;

update articles set collection_publishable = case
    when json_valid(source_metadata)
      and (
        json_type(source_metadata, '$.collection.publishable') = 'true'
        or (
          json_type(source_metadata, '$.collection.publishable') = 'text'
          and json_extract(source_metadata, '$.collection.publishable') = 'true'
        )
      )
    then 1 else 0 end;
