begin;

-- A metadata-only row is terminal (rather than a retry backlog) when the
-- authoritative adapter explicitly records that source text is not available,
-- the row is intentionally non-public, the official URL was verified, and no
-- human review was requested. This keeps ordinary fetch failures/retryable
-- metadata-only rows unchanged.
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
  v_history jsonb := case when jsonb_typeof(p_source_metadata -> 'reviewHistory') = 'array'
    then p_source_metadata -> 'reviewHistory' else '[]'::jsonb end;
  v_collection text;
  v_processing text;
  v_review text := 'unreviewed';
  v_attention_state text := 'clear';
  v_attention_code text;
  v_attention_retryable boolean;
  v_attention_severity text;
  v_attention_source text;
  v_anomaly text;
  v_expected_terminal_metadata_only boolean := (
    p_status = 'metadata_only'
    and p_error_class is null
    and p_source_metadata #>> '{collection,sourceTextAvailable}' = 'false'
    and p_source_metadata #>> '{collection,publishable}' = 'false'
    and p_source_metadata #>> '{collection,sourceUrlVerified}' = 'true'
    and coalesce(p_source_metadata #>> '{collection,strategy}', '') <> 'seed'
    and p_source_metadata #>> '{sourceTextStatus}' = 'not_available'
    and coalesce(p_source_metadata #>> '{review,required}', 'false') <> 'true'
  );
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
  elsif p_status in ('discovered', 'metadata_only', 'robots_disallowed', 'blocked', 'timeout', 'failed_fetch')
    and v_text_signal = 'true' then
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

  if not v_expected_terminal_metadata_only then
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
      when v_attention_code like 'summary.%' or v_attention_code like 'llm.%'
        or v_attention_code = 'job.stale_running' then 'high'
      else 'medium'
    end;
    v_attention_source := case
      when v_attention_code like 'summary.%' or v_attention_code like 'llm.%'
        or v_attention_code like 'job.%' then 'processing'
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

-- Reconcile only already-active metadata-only attention rows that satisfy the
-- same terminal evidence predicate. Bound the migration so unexpected scope
-- expansion fails closed rather than clearing a broad backlog.
do $reconcile$
declare
  v_target_count integer;
  v_row record;
  v_result record;
begin
  select count(*) into v_target_count
  from articles a
  where a.lifecycle_attention_state = 'active'
    and a.lifecycle_attention_code = 'collection.metadata_only'
    and a.status = 'metadata_only'
    and a.error_class is null
    and a.source_metadata #>> '{collection,sourceTextAvailable}' = 'false'
    and a.source_metadata #>> '{collection,publishable}' = 'false'
    and a.source_metadata #>> '{collection,sourceUrlVerified}' = 'true'
    and coalesce(a.source_metadata #>> '{collection,strategy}', '') <> 'seed'
    and a.source_metadata #>> '{sourceTextStatus}' = 'not_available'
    and coalesce(a.source_metadata #>> '{review,required}', 'false') <> 'true';

  if v_target_count > 100 then
    raise exception using
      errcode = 'P0001',
      message = 'M8_P5_TERMINAL_METADATA_SCOPE_EXCEEDED';
  end if;

  for v_row in
    select a.id, a.lifecycle_revision
    from articles a
    where a.lifecycle_attention_state = 'active'
      and a.lifecycle_attention_code = 'collection.metadata_only'
      and a.status = 'metadata_only'
      and a.error_class is null
      and a.source_metadata #>> '{collection,sourceTextAvailable}' = 'false'
      and a.source_metadata #>> '{collection,publishable}' = 'false'
      and a.source_metadata #>> '{collection,sourceUrlVerified}' = 'true'
      and coalesce(a.source_metadata #>> '{collection,strategy}', '') <> 'seed'
      and a.source_metadata #>> '{sourceTextStatus}' = 'not_available'
      and coalesce(a.source_metadata #>> '{review,required}', 'false') <> 'true'
    order by a.id
  loop
    select * into v_result
    from article_lifecycle_transition_p2(
      v_row.id,
      v_row.lifecycle_revision,
      'm8-p5-terminal-metadata:' || v_row.id::text || ':' || v_row.lifecycle_revision::text,
      'backfill',
      'm8-p5-forward-fix',
      'backfill.reconcile',
      'backfill.expected_metadata_only_terminal',
      null,
      null,
      null,
      'clear',
      null,
      null,
      null,
      null,
      array['collection.metadata_only']::text[]
    );
  end loop;

  if exists (
    select 1
    from articles a
    where a.lifecycle_attention_state = 'active'
      and a.lifecycle_attention_code = 'collection.metadata_only'
      and a.status = 'metadata_only'
      and a.error_class is null
      and a.source_metadata #>> '{collection,sourceTextAvailable}' = 'false'
      and a.source_metadata #>> '{collection,publishable}' = 'false'
      and a.source_metadata #>> '{collection,sourceUrlVerified}' = 'true'
      and coalesce(a.source_metadata #>> '{collection,strategy}', '') <> 'seed'
      and a.source_metadata #>> '{sourceTextStatus}' = 'not_available'
      and coalesce(a.source_metadata #>> '{review,required}', 'false') <> 'true'
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'M8_P5_TERMINAL_METADATA_RECONCILIATION_INCOMPLETE';
  end if;
end;
$reconcile$;

commit;

