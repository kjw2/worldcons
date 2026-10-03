-- WorldCons D1 additive migration: worldcons_ingest 0002
-- Restores the two idempotency constraints used by the historical discovery
-- contract before D1-native snapshot discovery is enabled.
-- @d1-verify {"type":"index","name":"source_backfill_items_snapshot_stable_key_uidx","sqlIncludes":["unique index","on source_backfill_items","(snapshot_id, stable_item_key)"]}
-- @d1-verify {"type":"index","name":"source_inventory_enumeration_artifacts_identity_uidx","sqlIncludes":["unique index","on source_inventory_enumeration_artifacts","(snapshot_id, provider_key, artifact_kind, sequence_no)"]}

create unique index if not exists source_backfill_items_snapshot_stable_key_uidx
  on source_backfill_items (snapshot_id, stable_item_key);

create unique index if not exists source_inventory_enumeration_artifacts_identity_uidx
  on source_inventory_enumeration_artifacts (snapshot_id, provider_key, artifact_kind, sequence_no);
