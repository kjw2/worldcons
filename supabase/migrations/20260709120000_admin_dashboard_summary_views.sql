create or replace view admin_article_status_summary_v as
select
  a.source_key,
  a.status,
  count(*)::integer as count,
  max(a.updated_at) as latest_updated_at
from articles a
group by a.source_key, a.status;

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
        a.status in ('metadata_only', 'robots_disallowed', 'blocked', 'timeout', 'failed_fetch', 'failed_summary', 'needs_review')
        or (
          a.status = 'summarizing'
          and a.updated_at < now() - make_interval(mins => coalesce(nullif(current_setting('app.stale_summarizing_minutes', true), '')::integer, 30))
        )
      )
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

create or replace view admin_candidate_summary_v as
select
  s.source_key,
  count(c.id) filter (where c.status = 'pending')::integer as pending_count,
  count(c.id) filter (where c.status = 'retrying')::integer as retrying_count,
  count(c.id) filter (where c.status = 'fetched')::integer as fetched_count,
  count(c.id) filter (where c.status = 'failed')::integer as failed_count,
  count(c.id) filter (where c.status = 'ignored')::integer as ignored_count,
  max(c.created_at) as latest_created_at,
  max(c.last_attempt_at) as latest_attempt_at
from sources s
left join source_url_candidates c on c.source_key = s.source_key
group by s.source_key
union all
select
  c.source_key,
  count(*) filter (where c.status = 'pending')::integer as pending_count,
  count(*) filter (where c.status = 'retrying')::integer as retrying_count,
  count(*) filter (where c.status = 'fetched')::integer as fetched_count,
  count(*) filter (where c.status = 'failed')::integer as failed_count,
  count(*) filter (where c.status = 'ignored')::integer as ignored_count,
  max(c.created_at) as latest_created_at,
  max(c.last_attempt_at) as latest_attempt_at
from source_url_candidates c
left join sources s on s.source_key = c.source_key
where s.source_key is null
group by c.source_key;

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
    else a.error_metadata ->> 'message'
  end as error_message,
  a.updated_at,
  a.fetched_at
from articles a
where (
    a.status in ('metadata_only', 'robots_disallowed', 'blocked', 'timeout', 'failed_fetch', 'failed_summary', 'needs_review')
    or (
      a.status = 'summarizing'
      and a.updated_at < now() - make_interval(mins => coalesce(nullif(current_setting('app.stale_summarizing_minutes', true), '')::integer, 30))
    )
  )
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
          'errorMessage', error_message
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

create or replace function rpc_admin_analytics_health_snapshot(days integer default 30)
returns jsonb
language sql
stable
as $$
  with bounds as (
    select now() - make_interval(days => least(greatest(coalesce(days, 30), 1), 180)) as since_at
  ),
  collection_health as (
    select
      ir.source_key,
      count(*)::integer as runs,
      count(*) filter (where ir.status = 'completed')::integer as completed_runs,
      count(*) filter (where ir.status = 'failed')::integer as failed_runs,
      coalesce(sum(ir.discovered_count), 0)::integer as discovered,
      coalesce(sum(ir.fetched_count), 0)::integer as fetched,
      coalesce(sum(ir.failed_count), 0)::integer as failed_items,
      coalesce(sum(ir.summarized_count), 0)::integer as summarized
    from ingestion_runs ir, bounds b
    where ir.started_at >= b.since_at
    group by ir.source_key
  ),
  summary_success as (
    select
      coalesce(a.summary_json -> 'aiMetadata' ->> 'provider',
        case
          when a.summary_json -> 'aiMetadata' ->> 'model' ~* '^(gpt-|o[0-9]|chatgpt-)' then 'openai'
          when a.summary_json -> 'aiMetadata' ->> 'model' ilike '%gemini%' then 'gemini'
          when a.summary_json -> 'aiMetadata' ->> 'model' ilike 'claude-%' then 'anthropic'
          else 'unknown'
        end
      ) as provider,
      coalesce(a.summary_json -> 'aiMetadata' ->> 'model', 'unknown') as model,
      count(*)::integer as successes,
      0::integer as failures
    from articles a
    where a.status = 'summarized'
      and a.summary_json -> 'aiMetadata' ->> 'model' is not null
    group by 1, 2
  ),
  summary_failure as (
    select
      coalesce(a.error_metadata ->> 'requestedProvider', 'unknown') as provider,
      coalesce(a.error_metadata ->> 'requestedModel', 'unknown') as model,
      0::integer as successes,
      count(*)::integer as failures
    from articles a
    where a.status = 'failed_summary'
    group by 1, 2
  ),
  model_health as (
    select
      provider,
      model,
      sum(successes)::integer as successes,
      sum(failures)::integer as failures,
      sum(successes + failures)::integer as total
    from (
      select * from summary_success
      union all
      select * from summary_failure
    ) rows
    group by provider, model
  )
  select jsonb_build_object(
    'collectionHealth',
    coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'sourceKey', source_key,
          'runs', runs,
          'completedRuns', completed_runs,
          'failedRuns', failed_runs,
          'discovered', discovered,
          'fetched', fetched,
          'failedItems', failed_items,
          'summarized', summarized,
          'fetchRate', case when discovered > 0 then round((fetched::numeric / discovered::numeric) * 100)::integer else 0 end
        )
        order by case when discovered > 0 then round((fetched::numeric / discovered::numeric) * 100)::integer else 0 end asc,
          runs desc,
          source_key
      )
      from collection_health
    ), '[]'::jsonb),
    'modelHealth',
    coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'provider', provider,
          'model', model,
          'successes', successes,
          'failures', failures,
          'total', total,
          'failureRate', case when total > 0 then round((failures::numeric / total::numeric) * 100)::integer else 0 end
        )
        order by total desc,
          case when total > 0 then round((failures::numeric / total::numeric) * 100)::integer else 0 end desc,
          model
      )
      from model_health
    ), '[]'::jsonb)
  );
$$;
