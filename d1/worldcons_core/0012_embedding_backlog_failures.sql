-- WorldCons D1 additive migration: worldcons_core 0012
-- Persistent backoff/terminal state for the embedding backlog.
--
-- The embedding backlog previously re-selected the same permanently failing
-- article on every run. Because the per-run stop budget is counted in
-- consecutive failures, one poisoned row could consume that budget forever and
-- starve every other missing embedding. This ledger keeps a bounded failure
-- count and next-attempt time per article, and marks a row `exhausted_at` once
-- the retry budget is spent. An exhausted row is excluded from automatic
-- selection until an operator clears it (see docs/operations/incremental-collection-invariants.md).
--
-- Additive only: creates one new table and its index. It neither alters nor
-- rewrites any existing table, index or row.
--
-- @d1-verify {"type":"table","name":"embedding_backlog_failures_v1","sqlIncludes":["embedding_backlog_failures_v1","article_id text not null","attempt_count integer not null","last_error_code text"]}
-- @d1-verify {"type":"index","name":"embedding_backlog_failures_v1_due_idx","sqlIncludes":["index","embedding_backlog_failures_v1","next_attempt_at"]}

create table if not exists embedding_backlog_failures_v1 (
  article_id text not null,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_attempt_at text,
  last_error_code text,
  last_error_summary text,
  exhausted_at text,
  updated_at text not null,
  primary key (article_id)
);
create index if not exists embedding_backlog_failures_v1_due_idx
  on embedding_backlog_failures_v1 (next_attempt_at, article_id);
