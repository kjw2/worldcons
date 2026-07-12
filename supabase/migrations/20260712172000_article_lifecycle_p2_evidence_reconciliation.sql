create or replace function article_lifecycle_map_legacy_p2(
  p_status text,
  p_source_metadata jsonb default null,
  p_review_state text default null,
  p_error_class text default null,
  p_error_context jsonb default null,
  p_summary_json jsonb default null
)
returns jsonb
language plpgsql
immutable
as $$
declare
  v_text_signal text := p_source_metadata #>> '{collection,sourceTextAvailable}';
  v_publishable_signal text := p_source_metadata #>> '{collection,publishable}';
  v_current_decision text := p_source_metadata #>> '{review,decision}';
  v_decision text;
  v_history jsonb := case when jsonb_typeof(p_source_metadata -> 'reviewHistory') = 'array' then p_source_metadata -> 'reviewHistory' else '[]'::jsonb end;
  v_collection text;
  v_processing text;
  v_review text := 'unreviewed';
  v_attention_state text := 'clear';
  v_attention_code text;
  v_attention_retryable boolean;
  v_attention_severity text;
  v_attention_source text;
  v_anomaly text;
begin
  if v_current_decision in ('closed_private', 'published', 'approved', 'approved_for_summary', 'needs_review') then
    v_decision := v_current_decision;
  elsif p_review_state in ('needs_triage', 'retry_later') then
    v_decision := p_review_state;
  elsif p_review_state in ('closed_private', 'published', 'approved', 'approved_for_summary', 'needs_review') then
    v_decision := p_review_state;
  else
    select entry ->> 'decision' into v_decision
    from jsonb_array_elements(v_history) with ordinality history(entry, ordinal)
    where entry ->> 'decision' in ('closed_private', 'published', 'approved', 'approved_for_summary', 'needs_review')
    order by ordinal desc
    limit 1;
    v_decision := coalesce(v_decision, p_review_state);
  end if;

  if v_decision = 'closed_private' then
    v_review := 'closed_private';
  elsif v_decision in ('published', 'approved') then
    v_review := 'approved';
  elsif v_decision = 'approved_for_summary' then
    v_review := 'approved_for_processing';
  elsif v_decision in ('needs_review', 'needs_triage', 'retry_later') or p_status = 'needs_review' then
    v_review := 'needs_review';
  end if;

  if p_status is null or p_status not in (
    'discovered', 'metadata_only', 'robots_disallowed', 'blocked', 'timeout', 'fetched',
    'cleaned', 'summarizing', 'summarized', 'failed_fetch', 'failed_summary', 'needs_review'
  ) then
    v_anomaly := 'backfill.unknown_legacy_status';
  elsif v_text_signal is not null and v_text_signal not in ('true', 'false') then
    v_anomaly := 'backfill.invalid_source_text_signal';
  elsif p_status in ('discovered', 'metadata_only', 'robots_disallowed', 'blocked', 'timeout', 'failed_fetch') and v_text_signal = 'true' then
    v_anomaly := 'backfill.status_text_conflict';
  elsif p_status in ('cleaned', 'summarizing', 'summarized', 'failed_summary') and v_text_signal = 'false' then
    v_anomaly := 'backfill.status_text_conflict';
  elsif p_status = 'summarized' and p_summary_json is null then
    v_anomaly := 'backfill.summarized_without_summary';
  elsif p_status = 'needs_review' and v_text_signal is null then
    v_anomaly := 'backfill.needs_review_text_ambiguous';
  elsif p_status = 'needs_review' and v_text_signal = 'false' and p_summary_json is not null then
    v_anomaly := 'backfill.review_summary_text_conflict';
  elsif v_decision in ('published', 'approved') and v_publishable_signal is distinct from 'true' then
    v_anomaly := 'backfill.approval_publishable_conflict';
  elsif p_error_class is not null and p_error_class !~ '^[a-z][a-z0-9._-]{0,119}$' then
    v_anomaly := 'backfill.invalid_error_class';
  end if;

  if v_anomaly is not null then
    return jsonb_build_object('anomalyCode', v_anomaly, 'reviewState', v_review);
  end if;

  v_collection := case
    when p_status = 'discovered' then 'discovered'
    when p_status in ('metadata_only', 'robots_disallowed', 'blocked', 'timeout', 'failed_fetch') then 'metadata_only'
    when p_status = 'fetched' then 'source_fetched'
    when p_status in ('cleaned', 'summarizing', 'summarized', 'failed_summary') then 'source_text_ready'
    when p_status = 'needs_review' and v_text_signal = 'true' then 'source_text_ready'
    else 'metadata_only'
  end;

  v_processing := case
    when p_status = 'cleaned' then 'ready'
    when p_status = 'summarizing' then 'running'
    when p_status = 'summarized' then 'complete'
    when p_status = 'failed_summary' then 'ready'
    when p_status = 'needs_review' and p_summary_json is not null then 'complete'
    when p_status = 'needs_review' and v_collection = 'source_text_ready' then 'ready'
    else 'not_ready'
  end;

  v_attention_code := p_error_class;
  if v_attention_code is null then
    v_attention_code := case p_status
      when 'metadata_only' then 'collection.metadata_only'
      when 'robots_disallowed' then 'crawl.robots_disallowed'
      when 'blocked' then 'crawl.blocked'
      when 'timeout' then 'crawl.timeout'
      when 'failed_fetch' then 'crawl.fetch_failed'
      when 'failed_summary' then 'summary.failed'
      else null
    end;
  end if;

  if v_attention_code is not null then
    v_attention_state := 'active';
    v_attention_retryable := case
      when jsonb_typeof(p_error_context -> 'retryable') = 'boolean' then (p_error_context ->> 'retryable')::boolean
      when v_attention_code in ('crawl.robots_disallowed', 'llm.key_missing') then false
      else true
    end;
    v_attention_severity := case
      when v_attention_code in ('crawl.robots_disallowed', 'collection.metadata_only') then 'low'
      when v_attention_code like 'summary.%' or v_attention_code like 'llm.%' or v_attention_code = 'job.stale_running' then 'high'
      else 'medium'
    end;
    v_attention_source := case
      when v_attention_code like 'summary.%' or v_attention_code like 'llm.%' or v_attention_code like 'job.%' then 'processing'
      else 'collection'
    end;
  end if;

  return jsonb_strip_nulls(jsonb_build_object(
    'collectionState', v_collection,
    'processingState', v_processing,
    'reviewState', v_review,
    'attentionState', v_attention_state,
    'attentionCode', v_attention_code,
    'attentionRetryable', v_attention_retryable,
    'attentionSeverity', v_attention_severity,
    'attentionSource', v_attention_source
  ));
end;
$$;

create or replace function article_lifecycle_backfill_batch_p2(
  p_after_id uuid default null,
  p_limit integer default 500
)
returns table(
  selected_count integer,
  mapped_count integer,
  anomaly_count integer,
  unchanged_count integer,
  next_after_id uuid,
  batch_complete boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_article articles%rowtype;
  v_map jsonb;
  v_selected integer := 0;
  v_mapped integer := 0;
  v_anomalies integer := 0;
  v_unchanged integer := 0;
  v_last uuid;
  v_key text;
  v_result record;
  v_resolution_codes text[];
begin
  if p_limit is null or p_limit not between 1 and 2000 then
    raise exception using errcode = '22023', message = 'ARTICLE_LIFECYCLE_INVALID_BATCH_LIMIT';
  end if;

  for v_article in
    select a.* from articles a
    where p_after_id is null or a.id > p_after_id
    order by a.id
    limit p_limit
    for update skip locked
  loop
    v_selected := v_selected + 1;
    v_last := v_article.id;
    v_map := article_lifecycle_map_legacy_p2(
      v_article.status, v_article.source_metadata, v_article.review_state,
      v_article.error_class, v_article.error_context, v_article.summary_json
    );
    v_key := left('p2-backfill:' || encode(extensions.digest(
      v_article.id::text || ':' || v_article.lifecycle_revision::text || ':' || v_article.status || ':' || v_map::text,
      'sha256'
    ), 'hex'), 240);

    if v_map ? 'anomalyCode' then
      insert into article_lifecycle_anomalies_p2 (article_id, legacy_status, anomaly_code)
      values (v_article.id, left(coalesce(v_article.status, '<null>'), 80), v_map ->> 'anomalyCode')
      on conflict (article_id) do update set
        legacy_status = excluded.legacy_status,
        anomaly_code = excluded.anomaly_code,
        last_seen_at = now(),
        occurrence_count = article_lifecycle_anomalies_p2.occurrence_count + 1,
        resolved_at = null;

      select * into v_result from article_lifecycle_transition_p2(
        v_article.id, v_article.lifecycle_revision, v_key, 'backfill', 'p2-backfill',
        'backfill.reconcile', 'backfill.ambiguous_legacy_state',
        null, null, v_map ->> 'reviewState', 'quarantine', v_map ->> 'anomalyCode', false, 'high', 'backfill', array[]::text[]
      );
      v_anomalies := v_anomalies + 1;
    else
      v_resolution_codes := case v_article.status
        when 'summarized' then array[
          'collection.metadata_only', 'crawl.robots_disallowed', 'crawl.blocked', 'crawl.timeout',
          'crawl.fetch_failed', 'extract.empty_text', 'summary.failed', 'summary.model_error',
          'summary.retryable_quota', 'llm.key_missing', 'job.stale_running'
        ]::text[]
        when 'cleaned' then array[
          'collection.metadata_only', 'crawl.robots_disallowed', 'crawl.blocked', 'crawl.timeout',
          'crawl.fetch_failed', 'extract.empty_text'
        ]::text[]
        else array[]::text[]
      end;
      if v_article.lifecycle_attention_state = 'anomaly' and v_article.lifecycle_attention_code like 'backfill.%' then
        v_resolution_codes := array_append(v_resolution_codes, v_article.lifecycle_attention_code);
      end if;

      select * into v_result from article_lifecycle_transition_p2(
        v_article.id, v_article.lifecycle_revision, v_key, 'backfill', 'p2-backfill',
        'backfill.reconcile', 'backfill.legacy_mapping',
        v_map ->> 'collectionState', v_map ->> 'processingState', v_map ->> 'reviewState',
        case when v_map ->> 'attentionState' = 'active' then 'raise' when cardinality(v_resolution_codes) > 0 then 'clear' else 'keep' end,
        v_map ->> 'attentionCode',
        case when v_map ? 'attentionRetryable' then (v_map ->> 'attentionRetryable')::boolean else null end,
        v_map ->> 'attentionSeverity', v_map ->> 'attentionSource', v_resolution_codes
      );

      update article_lifecycle_anomalies_p2 set resolved_at = now(), last_seen_at = now()
      where article_id = v_article.id and resolved_at is null;
      if v_result.applied then v_mapped := v_mapped + 1; else v_unchanged := v_unchanged + 1; end if;
    end if;
  end loop;

  return query select v_selected, v_mapped, v_anomalies, v_unchanged, v_last, v_selected < p_limit;
end;
$$;
