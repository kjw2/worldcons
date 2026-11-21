-- WorldCons D1 additive migration: worldcons_ingest 0007
-- Two additive durability fixes for the staged ingestion pipeline:
--
-- 1. `ingest_stage_jobs.last_failure_retryable` records whether the *last*
--    failure was a transient/retryable outcome (1) or an explicit terminal
--    policy/source block (0). A re-observation can then resume only work that
--    was classified retryable, instead of either abandoning a transient
--    downstream dead letter forever or blindly retrying a fail-closed block.
--    Older rows keep NULL; NULL is never auto-recovered (operator action only).
--
-- 2. The dispatch and ingest->core bridge outboxes gain a bounded attempt
--    budget and a durable `dead_lettered_at` terminal marker. Before this,
--    `failed` rows were re-selected forever with no cap and no human-visible
--    terminal state. A dead-lettered row is excluded from the pending scan and
--    can only be re-armed by the audited operator redrive helper.
--
-- Additive only: it never drops/rewrites a table, index or row. Existing rows
-- receive the safe defaults (NULL retryable, 8 attempts, not dead-lettered).
--
-- @d1-verify {"type":"table","name":"ingest_stage_jobs","sqlIncludes":["last_failure_retryable integer"]}
-- @d1-verify {"type":"table","name":"ingest_stage_dispatch_outbox","sqlIncludes":["max_attempts integer not null default 8","dead_lettered_at text"]}
-- @d1-verify {"type":"table","name":"ingest_core_bridge_outbox","sqlIncludes":["max_attempts integer not null default 8","dead_lettered_at text"]}

alter table ingest_stage_jobs add column last_failure_retryable integer;

alter table ingest_stage_dispatch_outbox add column max_attempts integer not null default 8;
alter table ingest_stage_dispatch_outbox add column dead_lettered_at text;

alter table ingest_core_bridge_outbox add column max_attempts integer not null default 8;
alter table ingest_core_bridge_outbox add column dead_lettered_at text;
