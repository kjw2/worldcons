-- WorldCons D1 additive migration: worldcons_ops 0002
-- Corrects admin_command_runs_active_dedupe_key_uidx to the Postgres partial
-- unique predicate. The historical 0001_init.sql created this index
-- unconditionally, which rejects valid historical rows that share a dedupe_key
-- in a non-active status and so blocks the M5.2c data copy. This migration
-- removes and recreates ONLY that one index; no table or row is changed.
-- Additive and idempotent: the index name and the partial predicate are the
-- verification marker, so a rerun after the index matches is a no-op.
-- @d1-verify {"type":"index","name":"admin_command_runs_active_dedupe_key_uidx","sqlIncludes":["unique index","on admin_command_runs","(dedupe_key)","where status in ('queued', 'running', 'retry_wait')"]}

drop index if exists admin_command_runs_active_dedupe_key_uidx;
create unique index if not exists admin_command_runs_active_dedupe_key_uidx
  on admin_command_runs (dedupe_key)
  where status in ('queued', 'running', 'retry_wait');
