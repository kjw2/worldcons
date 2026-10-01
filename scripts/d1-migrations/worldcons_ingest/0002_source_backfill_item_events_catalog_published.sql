CREATE TABLE source_backfill_item_events_v2 (
  id text not null,
  item_id text not null,
  attempt_id text,
  event_type text not null check (event_type in (
    'item_discovered',
    'item_claimed',
    'item_lease_extended',
    'fetch_recorded',
    'normalization_recorded',
    'item_completed',
    'item_failed',
    'claim_released',
    'verification_noop',
    'item_excluded',
    'catalog_published'
  )),
  phase text,
  safe_details text not null default '{}',
  occurred_at text not null,
  primary key (id)
);

INSERT INTO source_backfill_item_events_v2 (
  id,item_id,attempt_id,event_type,phase,safe_details,occurred_at
)
SELECT
  id,item_id,attempt_id,event_type,phase,safe_details,occurred_at
FROM source_backfill_item_events;

DROP INDEX source_backfill_item_events_item_idx;
DROP TABLE source_backfill_item_events;
ALTER TABLE source_backfill_item_events_v2 RENAME TO source_backfill_item_events;
CREATE INDEX source_backfill_item_events_item_idx
  ON source_backfill_item_events (item_id,occurred_at,id);
