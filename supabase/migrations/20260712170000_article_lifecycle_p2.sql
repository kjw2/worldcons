alter table articles add column if not exists lifecycle_collection_state text;
alter table articles add column if not exists lifecycle_processing_state text;
alter table articles add column if not exists lifecycle_review_state text;
alter table articles add column if not exists lifecycle_attention_state text;
alter table articles add column if not exists lifecycle_attention_code text;
alter table articles add column if not exists lifecycle_attention_retryable boolean;
alter table articles add column if not exists lifecycle_attention_severity text;
alter table articles add column if not exists lifecycle_attention_source text;
alter table articles add column if not exists lifecycle_attention_raised_at timestamptz;
alter table articles add column if not exists lifecycle_attention_cleared_at timestamptz;
alter table articles add column if not exists lifecycle_revision bigint not null default 0;
alter table articles add column if not exists lifecycle_changed_at timestamptz;
alter table articles add column if not exists lifecycle_collection_changed_at timestamptz;
alter table articles add column if not exists lifecycle_processing_changed_at timestamptz;
alter table articles add column if not exists lifecycle_review_changed_at timestamptz;
alter table articles add column if not exists lifecycle_attention_changed_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'articles_lifecycle_states_p2_check') then
    alter table articles add constraint articles_lifecycle_states_p2_check check (
      (lifecycle_collection_state is null or lifecycle_collection_state in ('discovered', 'metadata_only', 'source_fetched', 'source_text_ready'))
      and (lifecycle_processing_state is null or lifecycle_processing_state in ('not_ready', 'ready', 'running', 'complete'))
      and (lifecycle_review_state is null or lifecycle_review_state in ('unreviewed', 'needs_review', 'approved_for_processing', 'approved', 'closed_private'))
      and (lifecycle_attention_state is null or lifecycle_attention_state in ('clear', 'active', 'anomaly'))
      and (lifecycle_attention_severity is null or lifecycle_attention_severity in ('low', 'medium', 'high'))
      and (lifecycle_attention_source is null or lifecycle_attention_source in ('collection', 'processing', 'review', 'backfill', 'system'))
      and lifecycle_revision >= 0
    ) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'articles_lifecycle_attention_p2_check') then
    alter table articles add constraint articles_lifecycle_attention_p2_check check (
      (
        lifecycle_attention_state is null
        and lifecycle_collection_state is null
        and lifecycle_processing_state is null
        and lifecycle_review_state is null
        and lifecycle_attention_code is null
        and lifecycle_attention_retryable is null
        and lifecycle_attention_severity is null
        and lifecycle_attention_source is null
        and lifecycle_changed_at is null
      )
      or (
        lifecycle_attention_state = 'clear'
        and lifecycle_collection_state is not null
        and lifecycle_processing_state is not null
        and lifecycle_review_state is not null
        and lifecycle_attention_code is null
        and lifecycle_attention_retryable is null
        and lifecycle_attention_severity is null
        and lifecycle_attention_source is null
      )
      or (
        lifecycle_attention_state in ('active', 'anomaly')
        and lifecycle_attention_code ~ '^[a-z][a-z0-9._-]{0,119}$'
        and lifecycle_attention_retryable is not null
        and lifecycle_attention_severity is not null
        and lifecycle_attention_source is not null
        and lifecycle_attention_raised_at is not null
        and lifecycle_attention_cleared_at is null
        and (
          lifecycle_attention_state = 'anomaly'
          or (
            lifecycle_collection_state is not null
            and lifecycle_processing_state is not null
            and lifecycle_review_state is not null
          )
        )
      )
    ) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'articles_lifecycle_cross_axis_p2_check') then
    alter table articles add constraint articles_lifecycle_cross_axis_p2_check check (
      lifecycle_attention_state = 'anomaly'
      or lifecycle_attention_state is null
      or (
        (lifecycle_processing_state = 'not_ready' or lifecycle_collection_state = 'source_text_ready')
        and (lifecycle_review_state not in ('approved_for_processing', 'approved') or lifecycle_collection_state = 'source_text_ready')
      )
    ) not valid;
  end if;
end;
$$;

alter table articles validate constraint articles_lifecycle_states_p2_check;
alter table articles validate constraint articles_lifecycle_attention_p2_check;
alter table articles validate constraint articles_lifecycle_cross_axis_p2_check;

create table if not exists article_lifecycle_events_p2 (
  id bigint generated by default as identity primary key,
  article_id uuid not null references articles(id) on delete restrict,
  idempotency_key text not null,
  from_revision bigint not null,
  to_revision bigint not null,
  actor_type text not null,
  actor_id text,
  transition_source text not null,
  reason_code text not null,
  applied boolean not null,
  collection_state text,
  processing_state text,
  review_state text,
  attention_state text,
  attention_code text,
  attention_retryable boolean,
  attention_severity text,
  attention_source text,
  occurred_at timestamptz not null default now(),
  constraint article_lifecycle_events_p2_idempotency_key_check check (length(idempotency_key) between 1 and 240),
  constraint article_lifecycle_events_p2_actor_type_check check (actor_type in ('ingestion', 'summary_worker', 'admin', 'candidate', 'backfill', 'system', 'compatibility')),
  constraint article_lifecycle_events_p2_actor_id_check check (actor_id is null or length(actor_id) <= 160),
  constraint article_lifecycle_events_p2_source_check check (transition_source ~ '^[a-z][a-z0-9._-]{0,119}$'),
  constraint article_lifecycle_events_p2_reason_check check (reason_code ~ '^[a-z][a-z0-9._-]{0,159}$'),
  constraint article_lifecycle_events_p2_revision_check check (from_revision >= 0 and to_revision >= from_revision),
  constraint article_lifecycle_events_p2_article_key_key unique (article_id, idempotency_key)
);

create table if not exists article_lifecycle_anomalies_p2 (
  article_id uuid primary key references articles(id) on delete restrict,
  legacy_status text not null,
  anomaly_code text not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  occurrence_count integer not null default 1,
  resolved_at timestamptz,
  constraint article_lifecycle_anomalies_p2_status_check check (length(legacy_status) between 1 and 80),
  constraint article_lifecycle_anomalies_p2_code_check check (anomaly_code ~ '^backfill\.[a-z0-9._-]{1,110}$'),
  constraint article_lifecycle_anomalies_p2_count_check check (occurrence_count > 0)
);

alter table article_lifecycle_events_p2 enable row level security;
alter table article_lifecycle_anomalies_p2 enable row level security;

create or replace function article_lifecycle_guard_p2()
returns trigger
language plpgsql
as $$
declare
  v_authorized boolean := coalesce(current_setting('app.article_lifecycle_transition_p2', true), '') = 'on';
begin
  if tg_op = 'INSERT' then
    if new.lifecycle_collection_state is not null
      or new.lifecycle_processing_state is not null
      or new.lifecycle_review_state is not null
      or new.lifecycle_attention_state is not null
      or new.lifecycle_revision <> 0
    then
      if not v_authorized then
        raise exception using errcode = '42501', message = 'ARTICLE_LIFECYCLE_DIRECT_WRITE_FORBIDDEN';
      end if;
    end if;
    return new;
  end if;

  if row(
      new.lifecycle_collection_state, new.lifecycle_processing_state, new.lifecycle_review_state,
      new.lifecycle_attention_state, new.lifecycle_attention_code, new.lifecycle_attention_retryable,
      new.lifecycle_attention_severity, new.lifecycle_attention_source, new.lifecycle_attention_raised_at,
      new.lifecycle_attention_cleared_at, new.lifecycle_revision, new.lifecycle_changed_at,
      new.lifecycle_collection_changed_at, new.lifecycle_processing_changed_at,
      new.lifecycle_review_changed_at, new.lifecycle_attention_changed_at
    ) is distinct from row(
      old.lifecycle_collection_state, old.lifecycle_processing_state, old.lifecycle_review_state,
      old.lifecycle_attention_state, old.lifecycle_attention_code, old.lifecycle_attention_retryable,
      old.lifecycle_attention_severity, old.lifecycle_attention_source, old.lifecycle_attention_raised_at,
      old.lifecycle_attention_cleared_at, old.lifecycle_revision, old.lifecycle_changed_at,
      old.lifecycle_collection_changed_at, old.lifecycle_processing_changed_at,
      old.lifecycle_review_changed_at, old.lifecycle_attention_changed_at
    ) and not v_authorized
  then
    raise exception using errcode = '42501', message = 'ARTICLE_LIFECYCLE_DIRECT_WRITE_FORBIDDEN';
  end if;
  return new;
end;
$$;

drop trigger if exists articles_lifecycle_guard_p2_trigger on articles;
create trigger articles_lifecycle_guard_p2_trigger
before insert or update on articles
for each row execute function article_lifecycle_guard_p2();

create or replace function article_lifecycle_immutable_p2()
returns trigger
language plpgsql
as $$
begin
  raise exception using errcode = '55000', message = 'ARTICLE_LIFECYCLE_EVENT_IMMUTABLE';
end;
$$;

drop trigger if exists article_lifecycle_events_p2_immutable_trigger on article_lifecycle_events_p2;
create trigger article_lifecycle_events_p2_immutable_trigger
before update or delete on article_lifecycle_events_p2
for each row execute function article_lifecycle_immutable_p2();

create or replace function article_lifecycle_axis_transition_allowed_p2(
  p_axis text,
  p_from text,
  p_to text,
  p_source text
)
returns boolean
language sql
immutable
as $$
  select case
    when p_to is null then false
    when p_from is null or p_from = p_to then true
    when p_source = 'backfill.reconcile' then true
    when p_axis = 'collection' then case p_from
      when 'discovered' then p_to in ('metadata_only', 'source_fetched', 'source_text_ready')
      when 'metadata_only' then p_to in ('source_fetched', 'source_text_ready')
      when 'source_fetched' then p_to in ('metadata_only', 'source_text_ready')
      when 'source_text_ready' then p_to = 'metadata_only' and p_source = 'ingestion.refresh'
      else false
    end
    when p_axis = 'processing' then case p_from
      when 'not_ready' then p_to in ('ready', 'complete')
      when 'ready' then p_to in ('not_ready', 'running', 'complete')
      when 'running' then p_to in ('ready', 'complete')
      when 'complete' then
        (p_to = 'ready' and p_source in ('ingestion.refresh', 'summary.resummary'))
        or (p_to = 'running' and p_source = 'summary.resummary')
      else false
    end
    when p_axis = 'review' then case p_from
      when 'unreviewed' then p_to in ('needs_review', 'approved_for_processing', 'approved', 'closed_private')
      when 'needs_review' then p_to in ('approved_for_processing', 'approved', 'closed_private')
      when 'approved_for_processing' then p_to in ('needs_review', 'approved', 'closed_private')
      when 'approved' then p_to in ('needs_review', 'closed_private')
      when 'closed_private' then p_to in ('needs_review', 'approved_for_processing', 'approved')
      else false
    end
    else false
  end;
$$;

create or replace function article_lifecycle_transition_p2(
  p_article_id uuid,
  p_expected_revision bigint,
  p_idempotency_key text,
  p_actor_type text,
  p_actor_id text,
  p_source text,
  p_reason_code text,
  p_collection_state text default null,
  p_processing_state text default null,
  p_review_state text default null,
  p_attention_operation text default 'keep',
  p_attention_code text default null,
  p_attention_retryable boolean default null,
  p_attention_severity text default null,
  p_attention_source text default null,
  p_resolves_attention_codes text[] default array[]::text[]
)
returns table(
  article_id uuid,
  revision bigint,
  collection_state text,
  processing_state text,
  review_state text,
  attention_state text,
  attention_code text,
  attention_retryable boolean,
  attention_severity text,
  attention_source text,
  applied boolean,
  idempotent boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_article articles%rowtype;
  v_event article_lifecycle_events_p2%rowtype;
  v_collection text;
  v_processing text;
  v_review text;
  v_attention_state text;
  v_attention_code text;
  v_attention_retryable boolean;
  v_attention_severity text;
  v_attention_source text;
  v_attention_raised_at timestamptz;
  v_attention_cleared_at timestamptz;
  v_applied boolean;
  v_revision bigint;
begin
  if p_article_id is null then
    raise exception using errcode = '22023', message = 'ARTICLE_LIFECYCLE_INVALID_ARTICLE_ID';
  end if;
  if p_expected_revision is null or p_expected_revision < 0 then
    raise exception using errcode = '22023', message = 'ARTICLE_LIFECYCLE_INVALID_EXPECTED_REVISION';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 240 then
    raise exception using errcode = '22023', message = 'ARTICLE_LIFECYCLE_INVALID_IDEMPOTENCY_KEY';
  end if;
  if p_actor_type not in ('ingestion', 'summary_worker', 'admin', 'candidate', 'backfill', 'system', 'compatibility')
    or (p_actor_id is not null and length(p_actor_id) > 160)
    or p_source is null or p_source !~ '^[a-z][a-z0-9._-]{0,119}$'
    or p_reason_code is null or p_reason_code !~ '^[a-z][a-z0-9._-]{0,159}$'
  then
    raise exception using errcode = '22023', message = 'ARTICLE_LIFECYCLE_INVALID_AUTHORITY';
  end if;
  if (p_source like 'ingestion.%' and p_actor_type <> 'ingestion')
    or (p_source like 'candidate.%' and p_actor_type <> 'candidate')
    or (p_source like 'summary.%' and p_actor_type <> 'summary_worker')
    or (p_source like 'admin.%' and p_actor_type <> 'admin')
    or (p_source like 'backfill.%' and p_actor_type <> 'backfill')
    or (p_source like 'system.%' and p_actor_type <> 'system')
    or (p_source like 'compatibility.%' and p_actor_type <> 'compatibility')
  then
    raise exception using errcode = '22023', message = 'ARTICLE_LIFECYCLE_ACTOR_SOURCE_MISMATCH';
  end if;
  if p_collection_state is not null and p_collection_state not in ('discovered', 'metadata_only', 'source_fetched', 'source_text_ready') then
    raise exception using errcode = '22023', message = 'ARTICLE_LIFECYCLE_INVALID_COLLECTION_STATE';
  end if;
  if p_processing_state is not null and p_processing_state not in ('not_ready', 'ready', 'running', 'complete') then
    raise exception using errcode = '22023', message = 'ARTICLE_LIFECYCLE_INVALID_PROCESSING_STATE';
  end if;
  if p_review_state is not null and p_review_state not in ('unreviewed', 'needs_review', 'approved_for_processing', 'approved', 'closed_private') then
    raise exception using errcode = '22023', message = 'ARTICLE_LIFECYCLE_INVALID_REVIEW_STATE';
  end if;
  if p_attention_operation not in ('keep', 'raise', 'clear', 'quarantine') then
    raise exception using errcode = '22023', message = 'ARTICLE_LIFECYCLE_INVALID_ATTENTION_OPERATION';
  end if;
  if cardinality(coalesce(p_resolves_attention_codes, array[]::text[])) > 16
    or exists (select 1 from unnest(coalesce(p_resolves_attention_codes, array[]::text[])) code where code !~ '^[a-z][a-z0-9._-]{0,119}$')
  then
    raise exception using errcode = '22023', message = 'ARTICLE_LIFECYCLE_INVALID_RESOLUTION_CODES';
  end if;
  if p_attention_operation in ('raise', 'quarantine') and (
    p_attention_code is null or p_attention_code !~ '^[a-z][a-z0-9._-]{0,119}$'
    or p_attention_retryable is null
    or p_attention_severity not in ('low', 'medium', 'high')
    or p_attention_source not in ('collection', 'processing', 'review', 'backfill', 'system')
  ) then
    raise exception using errcode = '22023', message = 'ARTICLE_LIFECYCLE_INVALID_ATTENTION';
  end if;

  select e.* into v_event
  from article_lifecycle_events_p2 e
  where e.article_id = p_article_id and e.idempotency_key = p_idempotency_key;
  if found then
    return query select
      v_event.article_id, v_event.to_revision, v_event.collection_state, v_event.processing_state,
      v_event.review_state, v_event.attention_state, v_event.attention_code,
      v_event.attention_retryable, v_event.attention_severity, v_event.attention_source,
      false, true;
    return;
  end if;

  select a.* into v_article from articles a where a.id = p_article_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'ARTICLE_LIFECYCLE_NOT_FOUND';
  end if;

  select e.* into v_event
  from article_lifecycle_events_p2 e
  where e.article_id = p_article_id and e.idempotency_key = p_idempotency_key;
  if found then
    return query select
      v_event.article_id, v_event.to_revision, v_event.collection_state, v_event.processing_state,
      v_event.review_state, v_event.attention_state, v_event.attention_code,
      v_event.attention_retryable, v_event.attention_severity, v_event.attention_source,
      false, true;
    return;
  end if;

  if v_article.lifecycle_revision <> p_expected_revision then
    raise exception using errcode = '40001', message = 'ARTICLE_LIFECYCLE_STALE_REVISION';
  end if;

  v_collection := coalesce(p_collection_state, v_article.lifecycle_collection_state);
  v_processing := coalesce(p_processing_state, v_article.lifecycle_processing_state);
  v_review := coalesce(p_review_state, v_article.lifecycle_review_state);
  v_attention_state := v_article.lifecycle_attention_state;
  v_attention_code := v_article.lifecycle_attention_code;
  v_attention_retryable := v_article.lifecycle_attention_retryable;
  v_attention_severity := v_article.lifecycle_attention_severity;
  v_attention_source := v_article.lifecycle_attention_source;
  v_attention_raised_at := v_article.lifecycle_attention_raised_at;
  v_attention_cleared_at := v_article.lifecycle_attention_cleared_at;

  if p_attention_operation in ('raise', 'quarantine') then
    v_attention_state := case when p_attention_operation = 'quarantine' then 'anomaly' else 'active' end;
    v_attention_code := p_attention_code;
    v_attention_retryable := p_attention_retryable;
    v_attention_severity := p_attention_severity;
    v_attention_source := p_attention_source;
    v_attention_raised_at := now();
    v_attention_cleared_at := null;
  elsif p_attention_operation = 'clear'
    and v_article.lifecycle_attention_state in ('active', 'anomaly')
    and v_article.lifecycle_attention_code = any(coalesce(p_resolves_attention_codes, array[]::text[]))
  then
    v_attention_state := 'clear';
    v_attention_code := null;
    v_attention_retryable := null;
    v_attention_severity := null;
    v_attention_source := null;
    v_attention_cleared_at := now();
  end if;

  if v_attention_state is null and v_collection is not null and v_processing is not null and v_review is not null then
    v_attention_state := 'clear';
  end if;

  if v_attention_state <> 'anomaly' then
    if v_collection is null or v_processing is null or v_review is null then
      raise exception using errcode = '23514', message = 'ARTICLE_LIFECYCLE_INCOMPLETE_AXES';
    end if;
    if not article_lifecycle_axis_transition_allowed_p2('collection', v_article.lifecycle_collection_state, v_collection, p_source)
      or not article_lifecycle_axis_transition_allowed_p2('processing', v_article.lifecycle_processing_state, v_processing, p_source)
      or not article_lifecycle_axis_transition_allowed_p2('review', v_article.lifecycle_review_state, v_review, p_source)
    then
      raise exception using errcode = '23514', message = 'ARTICLE_LIFECYCLE_ILLEGAL_TRANSITION';
    end if;
    if v_processing <> 'not_ready' and v_collection <> 'source_text_ready' then
      raise exception using errcode = '23514', message = 'ARTICLE_LIFECYCLE_PROCESSING_REQUIRES_TEXT';
    end if;
    if v_review in ('approved_for_processing', 'approved') and v_collection <> 'source_text_ready' then
      raise exception using errcode = '23514', message = 'ARTICLE_LIFECYCLE_REVIEW_REQUIRES_TEXT';
    end if;
  end if;

  v_applied := row(
    v_collection, v_processing, v_review, v_attention_state, v_attention_code,
    v_attention_retryable, v_attention_severity, v_attention_source
  ) is distinct from row(
    v_article.lifecycle_collection_state, v_article.lifecycle_processing_state,
    v_article.lifecycle_review_state, v_article.lifecycle_attention_state,
    v_article.lifecycle_attention_code, v_article.lifecycle_attention_retryable,
    v_article.lifecycle_attention_severity, v_article.lifecycle_attention_source
  );
  v_revision := v_article.lifecycle_revision + case when v_applied then 1 else 0 end;

  if v_applied then
    perform set_config('app.article_lifecycle_transition_p2', 'on', true);
    update articles set
      lifecycle_collection_state = v_collection,
      lifecycle_processing_state = v_processing,
      lifecycle_review_state = v_review,
      lifecycle_attention_state = v_attention_state,
      lifecycle_attention_code = v_attention_code,
      lifecycle_attention_retryable = v_attention_retryable,
      lifecycle_attention_severity = v_attention_severity,
      lifecycle_attention_source = v_attention_source,
      lifecycle_attention_raised_at = v_attention_raised_at,
      lifecycle_attention_cleared_at = v_attention_cleared_at,
      lifecycle_revision = v_revision,
      lifecycle_changed_at = now(),
      lifecycle_collection_changed_at = case when v_collection is distinct from v_article.lifecycle_collection_state then now() else lifecycle_collection_changed_at end,
      lifecycle_processing_changed_at = case when v_processing is distinct from v_article.lifecycle_processing_state then now() else lifecycle_processing_changed_at end,
      lifecycle_review_changed_at = case when v_review is distinct from v_article.lifecycle_review_state then now() else lifecycle_review_changed_at end,
      lifecycle_attention_changed_at = case when row(v_attention_state, v_attention_code) is distinct from row(v_article.lifecycle_attention_state, v_article.lifecycle_attention_code) then now() else lifecycle_attention_changed_at end
    where id = p_article_id;
  end if;

  insert into article_lifecycle_events_p2 (
    article_id, idempotency_key, from_revision, to_revision, actor_type, actor_id,
    transition_source, reason_code, applied, collection_state, processing_state,
    review_state, attention_state, attention_code, attention_retryable,
    attention_severity, attention_source
  ) values (
    p_article_id, p_idempotency_key, v_article.lifecycle_revision, v_revision, p_actor_type,
    left(nullif(trim(p_actor_id), ''), 160), p_source, p_reason_code, v_applied,
    v_collection, v_processing, v_review, v_attention_state, v_attention_code,
    v_attention_retryable, v_attention_severity, v_attention_source
  ) returning * into v_event;

  return query select
    p_article_id, v_revision, v_collection, v_processing, v_review, v_attention_state,
    v_attention_code, v_attention_retryable, v_attention_severity, v_attention_source,
    v_applied, false;
end;
$$;

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
  if p_review_state in ('needs_triage', 'retry_later') then
    v_decision := p_review_state;
  elsif v_current_decision in ('closed_private', 'published', 'approved', 'approved_for_summary', 'needs_review') then
    v_decision := v_current_decision;
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
    return jsonb_build_object('anomalyCode', v_anomaly);
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

  if v_decision = 'closed_private' then
    v_review := 'closed_private';
  elsif v_decision in ('published', 'approved') then
    v_review := 'approved';
  elsif v_decision = 'approved_for_summary' then
    v_review := 'approved_for_processing';
  elsif v_decision in ('needs_review', 'needs_triage', 'retry_later') or p_status = 'needs_review' then
    v_review := 'needs_review';
  end if;

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
        null, null, null, 'quarantine', v_map ->> 'anomalyCode', false, 'high', 'backfill', array[]::text[]
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

create or replace function article_lifecycle_evidence_p2()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with legacy_public as (
    select id from articles
    where status = 'summarized' and (source_metadata #>> '{collection,publishable}') = 'true'
  ),
  compatibility_public as (
    select id from articles
    where lifecycle_collection_state = 'source_text_ready'
      and lifecycle_processing_state = 'complete'
      and (source_metadata #>> '{collection,publishable}') = 'true'
  ),
  legacy_only as (select id from legacy_public except select id from compatibility_public),
  compatibility_only as (select id from compatibility_public except select id from legacy_public),
  anomaly_rollup as (
    select anomaly_code, legacy_status, count(*)::integer as count
    from article_lifecycle_anomalies_p2 where resolved_at is null
    group by anomaly_code, legacy_status
  )
  select jsonb_build_object(
    'legacyPublicCount', (select count(*) from legacy_public),
    'compatibilityPublicCount', (select count(*) from compatibility_public),
    'legacyOnlyCount', (select count(*) from legacy_only),
    'compatibilityOnlyCount', (select count(*) from compatibility_only),
    'legacyIdentityDigest', coalesce((select encode(extensions.digest(string_agg(id::text, ',' order by id), 'sha256'), 'hex') from legacy_public), encode(extensions.digest('', 'sha256'), 'hex')),
    'compatibilityIdentityDigest', coalesce((select encode(extensions.digest(string_agg(id::text, ',' order by id), 'sha256'), 'hex') from compatibility_public), encode(extensions.digest('', 'sha256'), 'hex')),
    'uninitializedCount', (select count(*) from articles where lifecycle_attention_state is null),
    'activeAttentionCount', (select count(*) from articles where lifecycle_attention_state = 'active'),
    'anomalyCount', (select count(*) from article_lifecycle_anomalies_p2 where resolved_at is null),
    'anomalies', coalesce((select jsonb_agg(jsonb_build_object('code', anomaly_code, 'legacyStatus', legacy_status, 'count', count) order by anomaly_code, legacy_status) from anomaly_rollup), '[]'::jsonb)
  );
$$;

revoke all on table article_lifecycle_events_p2 from public;
revoke all on table article_lifecycle_anomalies_p2 from public;
revoke all on function article_lifecycle_transition_p2(uuid, bigint, text, text, text, text, text, text, text, text, text, text, boolean, text, text, text[]) from public;
revoke all on function article_lifecycle_backfill_batch_p2(uuid, integer) from public;
revoke all on function article_lifecycle_evidence_p2() from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on table article_lifecycle_events_p2, article_lifecycle_anomalies_p2 from anon;
    revoke all on function article_lifecycle_transition_p2(uuid, bigint, text, text, text, text, text, text, text, text, text, text, boolean, text, text, text[]) from anon;
    revoke all on function article_lifecycle_backfill_batch_p2(uuid, integer) from anon;
    revoke all on function article_lifecycle_evidence_p2() from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on table article_lifecycle_events_p2, article_lifecycle_anomalies_p2 from authenticated;
    revoke all on function article_lifecycle_transition_p2(uuid, bigint, text, text, text, text, text, text, text, text, text, text, boolean, text, text, text[]) from authenticated;
    revoke all on function article_lifecycle_backfill_batch_p2(uuid, integer) from authenticated;
    revoke all on function article_lifecycle_evidence_p2() from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select on table article_lifecycle_events_p2, article_lifecycle_anomalies_p2 to service_role;
    grant execute on function article_lifecycle_transition_p2(uuid, bigint, text, text, text, text, text, text, text, text, text, text, boolean, text, text, text[]) to service_role;
    grant execute on function article_lifecycle_backfill_batch_p2(uuid, integer) to service_role;
    grant execute on function article_lifecycle_evidence_p2() to service_role;
  end if;
end;
$$;
