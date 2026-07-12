create or replace view admin_operational_health_core_p5
with (security_barrier = true)
as
with legacy_public as (
  select id from articles
  where status = 'summarized' and source_metadata #>> '{collection,publishable}' = 'true'
), explicit_public as (
  select id from public_article_projection_p3
), publication_identity as (
  select
    (select count(*) from legacy_public)::bigint as legacy_count,
    (select count(*) from explicit_public)::bigint as explicit_count,
    (select count(*) from (
      (select id from legacy_public except select id from explicit_public)
      union all
      (select id from explicit_public except select id from legacy_public)
    ) mismatch)::bigint as mismatch_count,
    (select md5(count(*)::text || ':' || coalesce(sum(hashtextextended(id::text, 0)::numeric), 0)::text) from legacy_public) as legacy_digest,
    (select md5(count(*)::text || ':' || coalesce(sum(hashtextextended(id::text, 0)::numeric), 0)::text) from explicit_public) as explicit_digest
), queue_states as (
  select coalesce(jsonb_object_agg(status, state_count), '{}'::jsonb) as states
  from (select status, count(*)::bigint as state_count from admin_command_runs group by status) grouped
)
select jsonb_build_object(
  'queue', jsonb_build_object(
    'states', (select states from queue_states),
    'oldestQueuedAgeSeconds', (select extract(epoch from now() - min(created_at))::bigint from admin_command_runs where status = 'queued'),
    'staleLeaseCount', (select count(*)::bigint from admin_command_attempts where status = 'running' and lease_expires_at < now()),
    'oldestHeartbeatAgeSeconds', (select extract(epoch from now() - min(heartbeat_at))::bigint from admin_command_attempts where status = 'running'),
    'abortPendingCount', (select count(*)::bigint from admin_command_runs where abort_requested_at is not null and finished_at is null),
    'oldestAbortAgeSeconds', (select extract(epoch from now() - min(abort_requested_at))::bigint from admin_command_runs where abort_requested_at is not null and finished_at is null),
    'retryWaitingCount', (select count(*)::bigint from admin_command_runs where status = 'retry_wait'),
    'oldestRetryAgeSeconds', (select extract(epoch from now() - min(created_at))::bigint from admin_command_runs where status = 'retry_wait')
  ),
  'lifecycle', jsonb_build_object(
    'backlogCount', (select count(*)::bigint from articles where lifecycle_attention_state in ('active', 'anomaly') or lifecycle_review_state = 'needs_review'),
    'oldestReviewAgeSeconds', (select extract(epoch from now() - min(coalesce(lifecycle_attention_raised_at, lifecycle_review_changed_at)))::bigint from articles where lifecycle_attention_state in ('active', 'anomaly') or lifecycle_review_state = 'needs_review'),
    'unresolvedAnomalyCount', (select count(*)::bigint from article_lifecycle_anomalies_p2 where resolved_at is null)
  ),
  'publication', jsonb_build_object(
    'legacyPublicCount', (select legacy_count from publication_identity),
    'explicitPublicCount', (select explicit_count from publication_identity),
    'parityMismatchCount', (select mismatch_count from publication_identity),
    'quarantineCount', (
      select count(*)::bigint
      from article_publication_quarantine_p3 q
      where not exists (
        select 1
        from article_publication_quarantine_resolutions_p3 r
        where r.article_id = q.article_id and r.anomaly_code = q.anomaly_code
      )
    ),
    'legacyIdentityDigest', (select legacy_digest from publication_identity),
    'explicitIdentityDigest', (select explicit_digest from publication_identity)
  ),
  'outbox', jsonb_build_object(
    'pendingCount', (select count(*)::bigint from article_cache_outbox_p3 where status = 'pending'),
    'processingCount', (select count(*)::bigint from article_cache_outbox_p3 where status = 'processing'),
    'deadLetterCount', (select count(*)::bigint from article_cache_outbox_p3 where status = 'dead_letter'),
    'oldestUndeliveredAgeSeconds', (select extract(epoch from now() - min(created_at))::bigint from article_cache_outbox_p3 where status in ('pending', 'processing'))
  ),
  'inFlight', jsonb_build_object(
    'legacyCount', (select count(*)::bigint from admin_jobs where status in ('queued', 'running', 'cancel_requested')),
    'newCount', (select count(*)::bigint from admin_command_runs where status in ('queued', 'running', 'retry_wait')),
    'conflict', (select exists(select 1 from admin_jobs where status in ('queued', 'running', 'cancel_requested'))) and (select exists(select 1 from admin_command_runs where status in ('queued', 'running', 'retry_wait')))
  )
) as evidence;
