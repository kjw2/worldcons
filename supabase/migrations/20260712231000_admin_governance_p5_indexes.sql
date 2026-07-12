-- P5 indexes on both new governance tables and existing operational tables.
-- Apply outside a transaction. Every statement is independently rerunnable.

create index concurrently if not exists admin_compat_obs_p5_window_idx
  on admin_compatibility_observations_p5 (bucket_started_at, authority, direction);
create index concurrently if not exists admin_governance_evidence_p5_current_idx
  on admin_governance_evidence_p5 (evidence_type, role_key, expires_at desc, evidence_at desc);
create index concurrently if not exists admin_governance_evidence_p5_digest_idx
  on admin_governance_evidence_p5 (evidence_type, evidence_digest, evidence_at desc);
create index concurrently if not exists admin_retention_holds_p5_active_idx
  on admin_retention_holds_p5 (domain, starts_at, expires_at) where released_at is null;
create index concurrently if not exists ingestion_runs_source_started_p5_idx on ingestion_runs (source_key, started_at desc);
create index concurrently if not exists admin_command_runs_abort_p5_idx on admin_command_runs (abort_requested_at, finished_at) where abort_requested_at is not null;
create index concurrently if not exists admin_command_runs_retry_p5_idx on admin_command_runs (available_at, created_at) where status = 'retry_wait';
create index concurrently if not exists admin_command_attempts_finished_p5_idx on admin_command_attempts (finished_at, id) where status <> 'running';
create index concurrently if not exists admin_command_events_occurred_p5_idx on admin_command_events (occurred_at, id);
create index concurrently if not exists articles_lifecycle_review_age_p5_idx on articles (lifecycle_attention_raised_at, id) where lifecycle_attention_state in ('active', 'anomaly');
create index concurrently if not exists article_lifecycle_events_occurred_p5_idx on article_lifecycle_events_p2 (occurred_at, id);
create index concurrently if not exists article_publication_history_occurred_p5_idx on article_publication_history_p3 (occurred_at, id);
create index concurrently if not exists article_content_versions_created_p5_idx on article_content_versions_p3 (created_at, id);
create index concurrently if not exists article_cache_outbox_delivered_p5_idx on article_cache_outbox_p3 (delivered_at, id) where status = 'delivered';
