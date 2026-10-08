-- WorldCons D1 additive migration: worldcons_core 0003
-- Adds the core-side ledger for the ingest -> core bridge. The ingest DB owns
-- the bridge outbox and applies each entry here exactly once, keyed by the
-- stable `bridge_key` (a deterministic idempotency key). Because two physical
-- D1 databases cannot share a transaction, the ledger is the idempotent target
-- that makes a replayed bridge application a no-op. It is D1-native (no
-- Postgres origin) and additive only; nothing existing is dropped or rewritten.
--
-- @d1-verify {"type":"table","name":"ingest_core_bridge_ledger","sqlIncludes":["ingest_core_bridge_ledger","bridge_key text not null","operation text not null"]}
-- @d1-verify {"type":"index","name":"ingest_core_bridge_ledger_bridge_key_uidx","sqlIncludes":["unique index","ingest_core_bridge_ledger","bridge_key"]}

create table if not exists ingest_core_bridge_ledger (
  id text not null,
  bridge_key text not null,
  job_id text not null,
  source_key text,
  article_id text not null,
  operation text not null,
  payload_hash text not null,
  result_ref text,
  created_at text not null,
  primary key (id)
);
create unique index if not exists ingest_core_bridge_ledger_bridge_key_uidx
  on ingest_core_bridge_ledger (bridge_key);
create index if not exists ingest_core_bridge_ledger_article_idx
  on ingest_core_bridge_ledger (article_id, operation, created_at);
