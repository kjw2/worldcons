alter table articles add column if not exists error_class text;
alter table articles add column if not exists error_context jsonb;
alter table articles add column if not exists review_state text;

create index if not exists articles_error_class_updated_at_idx
  on articles (error_class, updated_at desc);

create index if not exists articles_review_state_updated_at_idx
  on articles (review_state, updated_at desc);

create index if not exists articles_source_key_review_state_updated_at_idx
  on articles (source_key, review_state, updated_at desc);

create or replace view admin_source_health_v as
with latest_runs as (
  select distinct on (ir.source_key)
    ir.source_key,
    ir.status as latest_run_status,
    ir.started_at as latest_run_started_at
  from ingestion_runs ir
  order by ir.source_key, ir.started_at desc
),
article_rollup as (
  select
    a.source_key,
    count(*)::integer as total_count,
    count(*) filter (
      where a.status = 'summarized'
        and (a.source_metadata -> 'collection' ->> 'publishable') = 'true'
    )::integer as public_count,
    count(*) filter (
      where a.status = 'cleaned'
        or a.status = 'failed_summary'
        or a.review_state in ('approved_for_summary', 'retry_later')
        or (
          a.status = 'summarizing'
          and a.updated_at < now() - make_interval(mins => coalesce(nullif(current_setting('app.stale_summarizing_minutes', true), '')::integer, 30))
        )
    )::integer as pending_summary_count,
    count(*) filter (
      where a.status in ('blocked', 'timeout', 'failed_fetch', 'failed_summary')
    )::integer as failed_count,
    count(*) filter (
      where (
        a.review_state in ('needs_triage', 'retry_later')
        or a.error_class is not null
        or a.status in ('metadata_only', 'robots_disallowed', 'blocked', 'timeout', 'failed_fetch', 'failed_summary', 'needs_review')
        or (
          a.status = 'summarizing'
          and a.updated_at < now() - make_interval(mins => coalesce(nullif(current_setting('app.stale_summarizing_minutes', true), '')::integer, 30))
        )
      )
      and coalesce(a.review_state, '') <> 'closed_private'
      and coalesce(a.source_metadata -> 'review' ->> 'decision', '') <> 'closed_private'
    )::integer as attention_count,
    max(a.original_published_at) as latest_published_at,
    max(a.fetched_at) as latest_fetched_at
  from articles a
  group by a.source_key
)
select
  s.source_key,
  s.name,
  s.jurisdiction,
  s.base_url,
  s.language,
  s.is_active,
  coalesce(ar.total_count, 0)::integer as total_count,
  coalesce(ar.public_count, 0)::integer as public_count,
  coalesce(ar.pending_summary_count, 0)::integer as pending_summary_count,
  coalesce(ar.attention_count, 0)::integer as attention_count,
  coalesce(ar.failed_count, 0)::integer as failed_count,
  ar.latest_published_at,
  ar.latest_fetched_at,
  lr.latest_run_status,
  lr.latest_run_started_at
from sources s
left join article_rollup ar on ar.source_key = s.source_key
left join latest_runs lr on lr.source_key = s.source_key
union all
select
  ar.source_key,
  ar.source_key as name,
  'Unknown' as jurisdiction,
  '' as base_url,
  '-' as language,
  true as is_active,
  ar.total_count,
  ar.public_count,
  ar.pending_summary_count,
  ar.attention_count,
  ar.failed_count,
  ar.latest_published_at,
  ar.latest_fetched_at,
  lr.latest_run_status,
  lr.latest_run_started_at
from article_rollup ar
left join sources s on s.source_key = ar.source_key
left join latest_runs lr on lr.source_key = ar.source_key
where s.source_key is null;

create or replace view admin_attention_articles_v as
select
  a.id,
  coalesce(a.slug, a.id::text, a.source_key) as slug,
  a.source_key,
  coalesce(a.jurisdiction, 'Unknown') as jurisdiction,
  coalesce(a.institution_name, a.source_key) as institution_name,
  coalesce(a.original_url, '') as original_url,
  coalesce(a.korean_title, a.original_title, '제목 미상') as title,
  a.original_published_at,
  a.status,
  case
    when a.status = 'summarizing'
      and a.updated_at < now() - make_interval(mins => coalesce(nullif(current_setting('app.stale_summarizing_minutes', true), '')::integer, 30))
      then '요약 작업이 중단된 오래된 summarizing 상태입니다. 재요약 또는 비공개 결정을 내려야 합니다.'
    else coalesce(a.error_context ->> 'message', a.error_metadata ->> 'message', a.error_class)
  end as error_message,
  a.updated_at,
  a.fetched_at,
  a.error_class,
  a.review_state
from articles a
where (
    a.review_state in ('needs_triage', 'retry_later')
    or a.error_class is not null
    or a.status in ('metadata_only', 'robots_disallowed', 'blocked', 'timeout', 'failed_fetch', 'failed_summary', 'needs_review')
    or (
      a.status = 'summarizing'
      and a.updated_at < now() - make_interval(mins => coalesce(nullif(current_setting('app.stale_summarizing_minutes', true), '')::integer, 30))
    )
  )
  and coalesce(a.review_state, '') <> 'closed_private'
  and coalesce(a.source_metadata -> 'review' ->> 'decision', '') <> 'closed_private';

create or replace function rpc_admin_dashboard_snapshot()
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'statusCounts',
    coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'sourceKey', source_key,
          'status', status,
          'count', count,
          'latestUpdatedAt', latest_updated_at
        )
        order by source_key, status
      )
      from admin_article_status_summary_v
    ), '[]'::jsonb),
    'sourceSummaries',
    coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'sourceKey', source_key,
          'name', name,
          'jurisdiction', jurisdiction,
          'baseUrl', base_url,
          'language', language,
          'isActive', is_active,
          'totalCount', total_count,
          'publicCount', public_count,
          'pendingSummaryCount', pending_summary_count,
          'attentionCount', attention_count,
          'failedCount', failed_count,
          'latestPublishedAt', latest_published_at,
          'latestFetchedAt', latest_fetched_at,
          'latestRunStatus', latest_run_status,
          'latestRunStartedAt', latest_run_started_at
        )
        order by source_key
      )
      from admin_source_health_v
    ), '[]'::jsonb),
    'candidateSummaries',
    coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'sourceKey', source_key,
          'pendingCount', pending_count,
          'retryingCount', retrying_count,
          'fetchedCount', fetched_count,
          'failedCount', failed_count,
          'ignoredCount', ignored_count,
          'latestCreatedAt', latest_created_at,
          'latestAttemptAt', latest_attempt_at
        )
        order by source_key
      )
      from admin_candidate_summary_v
    ), '[]'::jsonb),
    'attentionArticles',
    coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', id,
          'slug', slug,
          'sourceKey', source_key,
          'jurisdiction', jurisdiction,
          'institutionName', institution_name,
          'originalUrl', original_url,
          'title', title,
          'originalPublishedAt', original_published_at,
          'status', status,
          'errorMessage', error_message,
          'errorClass', error_class,
          'reviewState', review_state
        )
        order by coalesce(updated_at, fetched_at, original_published_at) desc nulls last
      )
      from (
        select *
        from admin_attention_articles_v
        order by coalesce(updated_at, fetched_at, original_published_at) desc nulls last
        limit 8
      ) attention
    ), '[]'::jsonb),
    'totals',
    jsonb_build_object(
      'articles', coalesce((select sum(total_count) from admin_source_health_v), 0),
      'publicArticles', coalesce((select sum(public_count) from admin_source_health_v), 0),
      'pendingSummaries', coalesce((select sum(pending_summary_count) from admin_source_health_v), 0),
      'failedArticles', coalesce((select sum(failed_count) from admin_source_health_v), 0),
      'attentionArticles', coalesce((select sum(attention_count) from admin_source_health_v), 0),
      'candidates', coalesce((select sum(pending_count + retrying_count + fetched_count + failed_count + ignored_count) from admin_candidate_summary_v), 0),
      'sources', coalesce((select count(*) from admin_source_health_v), 0),
      'tags', coalesce((select count(*) from tags), 0)
    )
  );
$$;
