create or replace function article_publication_json_has_secret_p3(p_value jsonb)
returns boolean
language sql
immutable
parallel safe
as $$
  select case jsonb_typeof(p_value)
    when 'object' then exists (
      select 1
      from jsonb_each(p_value) entry(key, value)
      where lower(entry.key) ~ '(secret|password|authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key|cookie)'
        or article_publication_json_has_secret_p3(entry.value)
    )
    when 'array' then exists (
      select 1 from jsonb_array_elements(p_value) item(value)
      where article_publication_json_has_secret_p3(item.value)
    )
    else false
  end;
$$;

create or replace function article_publication_safe_source_metadata_p3(p_metadata jsonb)
returns jsonb
language sql
immutable
as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'resolutionType', p_metadata -> 'resolutionType',
    'caseNumber', p_metadata -> 'caseNumber',
    'boeUsedForFiltering', p_metadata -> 'boeUsedForFiltering',
    'boePublishedAt', p_metadata -> 'boePublishedAt',
    'referenceBoe', p_metadata -> 'referenceBoe',
    'boeNumber', p_metadata -> 'boeNumber',
    'boeUrl', p_metadata -> 'boeUrl',
    'collection', jsonb_strip_nulls(jsonb_build_object(
      'strategy', p_metadata #> '{collection,strategy}',
      'confidence', p_metadata #> '{collection,confidence}',
      'sourceUrlVerified', p_metadata #> '{collection,sourceUrlVerified}',
      'publishable', p_metadata #> '{collection,publishable}',
      'sourceTextAvailable', p_metadata #> '{collection,sourceTextAvailable}',
      'strictSourceTextAvailable', p_metadata #> '{collection,strictSourceTextAvailable}',
      'sourceTextPolicy', p_metadata #> '{collection,sourceTextPolicy}',
      'robotsDisallowed', p_metadata #> '{collection,robotsDisallowed}'
    ))
  ));
$$;

create or replace function article_publication_safe_error_metadata_p3(p_metadata jsonb, p_error_class text)
returns jsonb
language sql
immutable
as $$
  select nullif(jsonb_strip_nulls(jsonb_build_object(
    'errorClass', case when p_error_class ~ '^[a-z][a-z0-9._-]{0,119}$' then to_jsonb(p_error_class) else null end,
    'retryable', case when jsonb_typeof(p_metadata -> 'retryable') = 'boolean' then p_metadata -> 'retryable' else null end,
    'requestedProvider', case when length(p_metadata ->> 'requestedProvider') <= 80 then p_metadata -> 'requestedProvider' else null end,
    'requestedModel', case when length(p_metadata ->> 'requestedModel') <= 200 then p_metadata -> 'requestedModel' else null end
  )), '{}'::jsonb);
$$;

create or replace function article_publication_version_document_p3(p_article articles)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'slug', p_article.slug,
    'sourceKey', p_article.source_key,
    'jurisdiction', p_article.jurisdiction,
    'institutionName', p_article.institution_name,
    'contentType', p_article.content_type,
    'originalUrl', p_article.original_url,
    'canonicalUrl', p_article.canonical_url,
    'originalLanguage', p_article.original_language,
    'originalTitle', p_article.original_title,
    'koreanTitle', p_article.korean_title,
    'originalPublishedAt', p_article.original_published_at,
    'discoveredAt', p_article.discovered_at,
    'fetchedAt', p_article.fetched_at,
    'summarizedAt', p_article.summarized_at,
    'rawText', p_article.raw_text,
    'cleanedText', p_article.cleaned_text,
    'summaryJson', p_article.summary_json,
    'sourceMetadata', article_publication_safe_source_metadata_p3(p_article.source_metadata),
    'errorMetadata', article_publication_safe_error_metadata_p3(p_article.error_metadata, p_article.error_class)
  );
$$;

create or replace function article_publication_content_hash_p3(p_article articles)
returns text
language sql
immutable
as $$
  select encode(digest(convert_to(article_publication_version_document_p3(p_article)::text, 'UTF8'), 'sha256'), 'hex');
$$;

create or replace function article_publication_version_id_p3(p_article_id uuid, p_content_hash text)
returns uuid
language sql
immutable
strict
as $$
  select (
    substr(v.hash, 1, 8) || '-' || substr(v.hash, 9, 4) || '-5' || substr(v.hash, 14, 3) ||
    '-a' || substr(v.hash, 18, 3) || '-' || substr(v.hash, 21, 12)
  )::uuid
  from (select encode(digest(convert_to(p_article_id::text || ':' || p_content_hash, 'UTF8'), 'sha256'), 'hex') hash) v;
$$;

create table if not exists article_content_versions_p3 (
  id uuid primary key,
  article_id uuid not null references articles(id) on delete restrict,
  revision bigint not null,
  parent_version_id uuid references article_content_versions_p3(id) on delete restrict,
  content_hash text not null,
  provenance_actor_type text not null,
  provenance_actor_id text,
  model_ref text,
  prompt_ref text,
  slug text not null,
  source_key text not null,
  jurisdiction text not null,
  institution_name text not null,
  content_type text not null,
  original_url text not null,
  canonical_url text not null,
  original_language text not null,
  original_title text,
  korean_title text,
  original_published_at timestamptz,
  discovered_at timestamptz,
  fetched_at timestamptz,
  summarized_at timestamptz,
  raw_text text,
  cleaned_text text,
  summary_json jsonb,
  source_metadata jsonb,
  error_metadata jsonb,
  search_vector tsvector,
  embedding vector(1536),
  created_at timestamptz not null default now(),
  constraint article_content_versions_p3_revision_check check (revision > 0),
  constraint article_content_versions_p3_hash_check check (content_hash ~ '^[0-9a-f]{64}$'),
  constraint article_content_versions_p3_actor_check check (provenance_actor_type in ('human', 'llm', 'import')),
  constraint article_content_versions_p3_actor_id_check check (provenance_actor_id is null or length(provenance_actor_id) <= 160),
  constraint article_content_versions_p3_model_ref_check check (model_ref is null or length(model_ref) <= 200),
  constraint article_content_versions_p3_prompt_ref_check check (prompt_ref is null or length(prompt_ref) <= 200),
  constraint article_content_versions_p3_content_type_check check (content_type in ('news', 'press_release', 'decision', 'opinion', 'order', 'other')),
  constraint article_content_versions_p3_no_secret_metadata_check check (
    not article_publication_json_has_secret_p3(coalesce(source_metadata, '{}'::jsonb))
    and not article_publication_json_has_secret_p3(coalesce(error_metadata, '{}'::jsonb))
  ),
  constraint article_content_versions_p3_article_revision_key unique (article_id, revision),
  constraint article_content_versions_p3_article_hash_key unique (article_id, content_hash),
  constraint article_content_versions_p3_parent_check check (parent_version_id is null or parent_version_id <> id)
);

create table if not exists article_version_heads_p3 (
  article_id uuid primary key references articles(id) on delete restrict,
  current_version_id uuid not null references article_content_versions_p3(id) on delete restrict,
  current_revision bigint not null,
  updated_at timestamptz not null default now(),
  constraint article_version_heads_p3_revision_check check (current_revision > 0)
);

create table if not exists article_publications_p3 (
  id uuid primary key default gen_random_uuid(),
  article_id uuid not null unique references articles(id) on delete restrict,
  state text not null,
  version_id uuid not null references article_content_versions_p3(id) on delete restrict,
  revision bigint not null,
  decided_by_type text not null,
  decided_by_id text,
  reason text not null,
  published_at timestamptz,
  withdrawn_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint article_publications_p3_state_check check (state in ('draft', 'in_review', 'published', 'withdrawn')),
  constraint article_publications_p3_revision_check check (revision > 0),
  constraint article_publications_p3_actor_check check (decided_by_type in ('human', 'compatibility', 'backfill', 'system')),
  constraint article_publications_p3_actor_id_check check (decided_by_id is null or length(decided_by_id) <= 160),
  constraint article_publications_p3_reason_check check (length(reason) between 1 and 500),
  constraint article_publications_p3_timestamps_check check (
    (state <> 'published' or published_at is not null)
    and (state <> 'withdrawn' or withdrawn_at is not null)
  )
);

create table if not exists article_publication_history_p3 (
  id bigint generated by default as identity primary key,
  publication_id uuid not null references article_publications_p3(id) on delete restrict,
  article_id uuid not null references articles(id) on delete restrict,
  publication_revision bigint not null,
  from_state text,
  to_state text not null,
  from_version_id uuid references article_content_versions_p3(id) on delete restrict,
  to_version_id uuid not null references article_content_versions_p3(id) on delete restrict,
  idempotency_key text not null,
  actor_type text not null,
  actor_id text,
  reason text not null,
  request_id text,
  correlation_id text,
  occurred_at timestamptz not null default now(),
  constraint article_publication_history_p3_state_check check (
    (from_state is null or from_state in ('draft', 'in_review', 'published', 'withdrawn'))
    and to_state in ('draft', 'in_review', 'published', 'withdrawn')
  ),
  constraint article_publication_history_p3_idempotency_check check (length(idempotency_key) between 1 and 240),
  constraint article_publication_history_p3_actor_check check (actor_type in ('human', 'compatibility', 'backfill', 'system')),
  constraint article_publication_history_p3_reason_check check (length(reason) between 1 and 500),
  constraint article_publication_history_p3_request_check check (
    (request_id is null or length(request_id) <= 160)
    and (correlation_id is null or length(correlation_id) <= 160)
  ),
  constraint article_publication_history_p3_revision_key unique (publication_id, publication_revision),
  constraint article_publication_history_p3_article_key unique (article_id, idempotency_key)
);

create table if not exists article_audit_ledger_p3 (
  id bigint generated by default as identity primary key,
  article_id uuid not null references articles(id) on delete restrict,
  ledger_revision bigint not null,
  event_type text not null,
  article_version_id uuid references article_content_versions_p3(id) on delete restrict,
  publication_id uuid references article_publications_p3(id) on delete restrict,
  publication_revision bigint,
  actor_type text not null,
  actor_id text,
  reason text not null,
  request_id text,
  correlation_id text,
  safe_metadata jsonb not null default '{}'::jsonb,
  previous_entry_hash text,
  entry_hash text not null,
  occurred_at timestamptz not null default now(),
  constraint article_audit_ledger_p3_event_check check (event_type ~ '^[a-z][a-z0-9._-]{0,119}$'),
  constraint article_audit_ledger_p3_actor_check check (actor_type in ('human', 'llm', 'import', 'compatibility', 'backfill', 'system')),
  constraint article_audit_ledger_p3_actor_id_check check (actor_id is null or length(actor_id) <= 160),
  constraint article_audit_ledger_p3_reason_check check (length(reason) between 1 and 500),
  constraint article_audit_ledger_p3_request_check check (
    (request_id is null or length(request_id) <= 160)
    and (correlation_id is null or length(correlation_id) <= 160)
  ),
  constraint article_audit_ledger_p3_safe_metadata_check check (
    pg_column_size(safe_metadata) <= 8192
    and not article_publication_json_has_secret_p3(safe_metadata)
  ),
  constraint article_audit_ledger_p3_hash_check check (
    entry_hash ~ '^[0-9a-f]{64}$'
    and (previous_entry_hash is null or previous_entry_hash ~ '^[0-9a-f]{64}$')
  ),
  constraint article_audit_ledger_p3_article_revision_key unique (article_id, ledger_revision),
  constraint article_audit_ledger_p3_entry_hash_key unique (entry_hash)
);

create table if not exists article_publication_requests_p3 (
  id bigint generated by default as identity primary key,
  article_id uuid not null references articles(id) on delete restrict,
  idempotency_key text not null,
  publication_id uuid not null references article_publications_p3(id) on delete restrict,
  publication_revision bigint not null,
  version_id uuid not null references article_content_versions_p3(id) on delete restrict,
  version_revision bigint not null,
  state text not null,
  version_created boolean not null,
  publication_applied boolean not null,
  created_at timestamptz not null default now(),
  constraint article_publication_requests_p3_key_check check (length(idempotency_key) between 1 and 240),
  constraint article_publication_requests_p3_state_check check (state in ('draft', 'in_review', 'published', 'withdrawn')),
  constraint article_publication_requests_p3_article_key unique (article_id, idempotency_key)
);

create table if not exists article_publication_quarantine_p3 (
  id bigint generated by default as identity primary key,
  article_id uuid not null references articles(id) on delete restrict,
  anomaly_code text not null,
  legacy_public boolean not null,
  detected_at timestamptz not null default now(),
  constraint article_publication_quarantine_p3_code_check check (anomaly_code ~ '^backfill\.[a-z0-9._-]{1,110}$'),
  constraint article_publication_quarantine_p3_article_code_key unique (article_id, anomaly_code)
);

create table if not exists article_cache_outbox_p3 (
  id uuid primary key default gen_random_uuid(),
  event_key text not null unique,
  event_type text not null,
  article_id uuid not null references articles(id) on delete restrict,
  publication_id uuid not null references article_publications_p3(id) on delete restrict,
  publication_revision bigint not null,
  version_id uuid not null references article_content_versions_p3(id) on delete restrict,
  publication_state text not null,
  article_slug text not null,
  status text not null default 'pending',
  attempt_count integer not null default 0,
  max_attempts integer not null default 12,
  available_at timestamptz not null default now(),
  lease_owner text,
  lease_token uuid,
  lease_expires_at timestamptz,
  last_error_code text,
  delivered_at timestamptz,
  dead_lettered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint article_cache_outbox_p3_event_key_check check (length(event_key) between 1 and 240),
  constraint article_cache_outbox_p3_event_type_check check (event_type = 'publication.changed'),
  constraint article_cache_outbox_p3_publication_state_check check (publication_state in ('draft', 'in_review', 'published', 'withdrawn')),
  constraint article_cache_outbox_p3_status_check check (status in ('pending', 'processing', 'delivered', 'dead_letter')),
  constraint article_cache_outbox_p3_attempt_check check (attempt_count >= 0 and max_attempts between 1 and 100),
  constraint article_cache_outbox_p3_owner_check check (lease_owner is null or length(lease_owner) <= 160),
  constraint article_cache_outbox_p3_error_check check (last_error_code is null or last_error_code ~ '^[a-z][a-z0-9._-]{0,119}$'),
  constraint article_cache_outbox_p3_lease_check check (
    (status = 'processing' and lease_owner is not null and lease_token is not null and lease_expires_at is not null)
    or (status <> 'processing' and lease_owner is null and lease_token is null and lease_expires_at is null)
  ),
  constraint article_cache_outbox_p3_terminal_check check (
    (status <> 'delivered' or delivered_at is not null)
    and (status <> 'dead_letter' or dead_lettered_at is not null)
  ),
  constraint article_cache_outbox_p3_publication_revision_key unique (publication_id, publication_revision)
);

alter table article_content_versions_p3 enable row level security;
alter table article_version_heads_p3 enable row level security;
alter table article_publications_p3 enable row level security;
alter table article_publication_history_p3 enable row level security;
alter table article_audit_ledger_p3 enable row level security;
alter table article_publication_requests_p3 enable row level security;
alter table article_publication_quarantine_p3 enable row level security;
alter table article_cache_outbox_p3 enable row level security;

create or replace function article_publication_immutable_p3()
returns trigger
language plpgsql
as $$
begin
  raise exception using errcode = '55000', message = 'ARTICLE_PUBLICATION_IMMUTABLE_RECORD';
end;
$$;

drop trigger if exists article_content_versions_p3_immutable_trigger on article_content_versions_p3;
create trigger article_content_versions_p3_immutable_trigger before update or delete on article_content_versions_p3
for each row execute function article_publication_immutable_p3();
drop trigger if exists article_publication_history_p3_immutable_trigger on article_publication_history_p3;
create trigger article_publication_history_p3_immutable_trigger before update or delete on article_publication_history_p3
for each row execute function article_publication_immutable_p3();
drop trigger if exists article_audit_ledger_p3_immutable_trigger on article_audit_ledger_p3;
create trigger article_audit_ledger_p3_immutable_trigger before update or delete on article_audit_ledger_p3
for each row execute function article_publication_immutable_p3();
drop trigger if exists article_publication_requests_p3_immutable_trigger on article_publication_requests_p3;
create trigger article_publication_requests_p3_immutable_trigger before update or delete on article_publication_requests_p3
for each row execute function article_publication_immutable_p3();
drop trigger if exists article_publication_quarantine_p3_immutable_trigger on article_publication_quarantine_p3;
create trigger article_publication_quarantine_p3_immutable_trigger before update or delete on article_publication_quarantine_p3
for each row execute function article_publication_immutable_p3();

create or replace function article_publication_transition_allowed_p3(
  p_from_state text,
  p_to_state text,
  p_actor_type text,
  p_version_changed boolean
)
returns boolean
language sql
immutable
as $$
  select case
    when p_from_state is null then
      p_to_state in ('draft', 'in_review') or (p_to_state = 'published' and p_actor_type in ('compatibility', 'backfill'))
    when p_from_state = p_to_state then p_version_changed
    when p_from_state = 'draft' then
      p_to_state = 'in_review' or (p_to_state = 'published' and p_actor_type in ('compatibility', 'backfill'))
    when p_from_state = 'in_review' then p_to_state in ('draft', 'published', 'withdrawn')
    when p_from_state = 'published' then p_to_state = 'withdrawn'
    when p_from_state = 'withdrawn' then
      p_to_state = 'in_review' or (p_to_state = 'published' and p_actor_type in ('human', 'compatibility', 'backfill'))
    else false
  end;
$$;

create or replace function article_publication_eligible_p3(p_article articles, p_version article_content_versions_p3)
returns boolean
language sql
stable
as $$
  select
    p_article.lifecycle_collection_state = 'source_text_ready'
    and p_article.lifecycle_processing_state = 'complete'
    and p_article.lifecycle_review_state in ('unreviewed', 'approved')
    and p_article.lifecycle_attention_state = 'clear'
    and length(trim(coalesce(p_version.slug, ''))) > 0
    and length(trim(coalesce(p_version.source_key, ''))) > 0
    and length(trim(coalesce(p_version.jurisdiction, ''))) > 0
    and length(trim(coalesce(p_version.institution_name, ''))) > 0
    and length(trim(coalesce(p_version.original_url, ''))) > 0
    and length(trim(coalesce(p_version.canonical_url, ''))) > 0
    and length(trim(coalesce(p_version.original_language, ''))) > 0
    and length(trim(coalesce(p_version.korean_title, p_version.original_title, ''))) > 0
    and p_version.summary_json is not null
    and length(trim(coalesce(p_version.cleaned_text, ''))) >= 500
    and p_version.source_metadata #>> '{collection,publishable}' = 'true'
    and p_version.source_metadata #>> '{collection,sourceTextAvailable}' = 'true'
    and p_version.source_metadata #>> '{collection,sourceUrlVerified}' = 'true'
    and coalesce(p_version.source_metadata #>> '{collection,robotsDisallowed}', 'false') <> 'true'
    and coalesce(p_version.source_metadata #>> '{collection,strategy}', '') <> 'seed';
$$;

create or replace function article_audit_append_p3(
  p_article_id uuid,
  p_event_type text,
  p_version_id uuid,
  p_publication_id uuid,
  p_publication_revision bigint,
  p_actor_type text,
  p_actor_id text,
  p_reason text,
  p_request_id text,
  p_correlation_id text,
  p_safe_metadata jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_previous article_audit_ledger_p3%rowtype;
  v_revision bigint;
  v_occurred_at timestamptz := clock_timestamp();
  v_metadata jsonb := coalesce(p_safe_metadata, '{}'::jsonb);
  v_hash text;
begin
  if p_event_type is null or p_event_type !~ '^[a-z][a-z0-9._-]{0,119}$'
    or p_actor_type not in ('human', 'llm', 'import', 'compatibility', 'backfill', 'system')
    or p_reason is null or length(p_reason) not between 1 and 500
    or pg_column_size(v_metadata) > 8192
    or article_publication_json_has_secret_p3(v_metadata)
  then
    raise exception using errcode = '22023', message = 'ARTICLE_AUDIT_INVALID_EVENT';
  end if;

  select l.* into v_previous
  from article_audit_ledger_p3 l
  where l.article_id = p_article_id
  order by l.ledger_revision desc
  limit 1;
  v_revision := coalesce(v_previous.ledger_revision, 0) + 1;
  v_hash := encode(digest(convert_to(concat_ws('|',
    p_article_id::text, v_revision::text, p_event_type, coalesce(p_version_id::text, ''),
    coalesce(p_publication_id::text, ''), coalesce(p_publication_revision::text, ''), p_actor_type,
    coalesce(p_actor_id, ''), p_reason, coalesce(p_request_id, ''), coalesce(p_correlation_id, ''),
    v_metadata::text, coalesce(v_previous.entry_hash, ''), v_occurred_at::text
  ), 'UTF8'), 'sha256'), 'hex');

  insert into article_audit_ledger_p3 (
    article_id, ledger_revision, event_type, article_version_id, publication_id,
    publication_revision, actor_type, actor_id, reason, request_id, correlation_id,
    safe_metadata, previous_entry_hash, entry_hash, occurred_at
  ) values (
    p_article_id, v_revision, p_event_type, p_version_id, p_publication_id,
    p_publication_revision, p_actor_type, left(nullif(trim(p_actor_id), ''), 160), p_reason,
    left(nullif(trim(p_request_id), ''), 160), left(nullif(trim(p_correlation_id), ''), 160),
    v_metadata, v_previous.entry_hash, v_hash, v_occurred_at
  );
end;
$$;

create or replace function article_publication_transition_p3(
  p_article_id uuid,
  p_expected_version_revision bigint,
  p_expected_publication_revision bigint,
  p_idempotency_key text,
  p_target_state text,
  p_version_id uuid,
  p_capture_legacy boolean,
  p_actor_type text,
  p_actor_id text,
  p_reason text,
  p_request_id text default null,
  p_correlation_id text default null,
  p_provenance_actor_type text default 'human',
  p_provenance_actor_id text default null,
  p_model_ref text default null,
  p_prompt_ref text default null,
  p_safe_metadata jsonb default '{}'::jsonb,
  p_expected_legacy_updated_at timestamptz default null
)
returns table(
  article_id uuid,
  version_id uuid,
  version_revision bigint,
  publication_id uuid,
  publication_revision bigint,
  publication_state text,
  version_created boolean,
  publication_applied boolean,
  idempotent boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_article articles%rowtype;
  v_head article_version_heads_p3%rowtype;
  v_version article_content_versions_p3%rowtype;
  v_publication article_publications_p3%rowtype;
  v_request article_publication_requests_p3%rowtype;
  v_content_hash text;
  v_version_id uuid;
  v_version_revision bigint;
  v_version_created boolean := false;
  v_publication_applied boolean := false;
  v_publication_revision bigint;
  v_old_state text;
  v_old_version_id uuid;
  v_now timestamptz := clock_timestamp();
  v_metadata jsonb := coalesce(p_safe_metadata, '{}'::jsonb);
begin
  if p_article_id is null
    or p_expected_version_revision is null or p_expected_version_revision < 0
    or p_expected_publication_revision is null or p_expected_publication_revision < 0
    or p_idempotency_key is null or length(p_idempotency_key) not between 1 and 240
    or p_target_state not in ('draft', 'in_review', 'published', 'withdrawn')
    or p_actor_type not in ('human', 'compatibility', 'backfill', 'system')
    or (p_actor_id is not null and length(p_actor_id) > 160)
    or p_reason is null or length(p_reason) not between 1 and 500
    or (p_request_id is not null and length(p_request_id) > 160)
    or (p_correlation_id is not null and length(p_correlation_id) > 160)
    or p_provenance_actor_type not in ('human', 'llm', 'import')
    or (p_provenance_actor_id is not null and length(p_provenance_actor_id) > 160)
    or (p_model_ref is not null and length(p_model_ref) > 200)
    or (p_prompt_ref is not null and length(p_prompt_ref) > 200)
    or pg_column_size(v_metadata) > 8192
    or article_publication_json_has_secret_p3(v_metadata)
  then
    raise exception using errcode = '22023', message = 'ARTICLE_PUBLICATION_INVALID_INPUT';
  end if;
  if p_capture_legacy and p_version_id is not null then
    raise exception using errcode = '22023', message = 'ARTICLE_PUBLICATION_AMBIGUOUS_VERSION_INPUT';
  end if;
  if not p_capture_legacy and p_version_id is null then
    raise exception using errcode = '22023', message = 'ARTICLE_PUBLICATION_VERSION_REQUIRED';
  end if;
  if p_target_state = 'published' and p_actor_type not in ('human', 'compatibility', 'backfill') then
    raise exception using errcode = '42501', message = 'ARTICLE_PUBLICATION_ACTOR_FORBIDDEN';
  end if;

  select r.* into v_request from article_publication_requests_p3 r
  where r.article_id = p_article_id and r.idempotency_key = p_idempotency_key;
  if found then
    return query select v_request.article_id, v_request.version_id, v_request.version_revision,
      v_request.publication_id, v_request.publication_revision, v_request.state,
      v_request.version_created, v_request.publication_applied, true;
    return;
  end if;

  select a.* into v_article from articles a where a.id = p_article_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'ARTICLE_PUBLICATION_NOT_FOUND';
  end if;

  select r.* into v_request from article_publication_requests_p3 r
  where r.article_id = p_article_id and r.idempotency_key = p_idempotency_key;
  if found then
    return query select v_request.article_id, v_request.version_id, v_request.version_revision,
      v_request.publication_id, v_request.publication_revision, v_request.state,
      v_request.version_created, v_request.publication_applied, true;
    return;
  end if;
  if p_expected_legacy_updated_at is not null and v_article.updated_at is distinct from p_expected_legacy_updated_at then
    raise exception using errcode = '40001', message = 'ARTICLE_PUBLICATION_STALE_LEGACY_ROW';
  end if;

  select h.* into v_head from article_version_heads_p3 h where h.article_id = p_article_id for update;
  if coalesce(v_head.current_revision, 0) <> p_expected_version_revision then
    raise exception using errcode = '40001', message = 'ARTICLE_VERSION_STALE_REVISION';
  end if;

  if p_capture_legacy then
    if article_publication_json_has_secret_p3(coalesce(v_article.source_metadata, '{}'::jsonb))
      or article_publication_json_has_secret_p3(coalesce(v_article.error_metadata, '{}'::jsonb))
    then
      raise exception using errcode = '23514', message = 'ARTICLE_VERSION_SECRET_METADATA';
    end if;
    v_content_hash := article_publication_content_hash_p3(v_article);
    v_version_id := article_publication_version_id_p3(p_article_id, v_content_hash);
    select v.* into v_version from article_content_versions_p3 v
    where v.article_id = p_article_id and v.content_hash = v_content_hash;
    if not found then
      v_version_revision := coalesce(v_head.current_revision, 0) + 1;
      insert into article_content_versions_p3 (
        id, article_id, revision, parent_version_id, content_hash, provenance_actor_type,
        provenance_actor_id, model_ref, prompt_ref, slug, source_key, jurisdiction,
        institution_name, content_type, original_url, canonical_url, original_language,
        original_title, korean_title, original_published_at, discovered_at, fetched_at,
        summarized_at, raw_text, cleaned_text, summary_json, source_metadata, error_metadata,
        search_vector, embedding, created_at
      ) values (
        v_version_id, p_article_id, v_version_revision, v_head.current_version_id, v_content_hash,
        p_provenance_actor_type, left(nullif(trim(p_provenance_actor_id), ''), 160),
        left(nullif(trim(p_model_ref), ''), 200), left(nullif(trim(p_prompt_ref), ''), 200),
        v_article.slug, v_article.source_key, v_article.jurisdiction, v_article.institution_name,
        v_article.content_type, v_article.original_url, v_article.canonical_url,
        v_article.original_language, v_article.original_title, v_article.korean_title,
        v_article.original_published_at, v_article.discovered_at, v_article.fetched_at,
        v_article.summarized_at, v_article.raw_text, v_article.cleaned_text, v_article.summary_json,
        article_publication_safe_source_metadata_p3(v_article.source_metadata),
        article_publication_safe_error_metadata_p3(v_article.error_metadata, v_article.error_class),
        v_article.search_vector,
        v_article.embedding, v_now
      ) returning * into v_version;
      insert into article_version_heads_p3(article_id, current_version_id, current_revision, updated_at)
      values (p_article_id, v_version.id, v_version.revision, v_now)
      on conflict on constraint article_version_heads_p3_pkey do update set
        current_version_id = excluded.current_version_id,
        current_revision = excluded.current_revision,
        updated_at = excluded.updated_at;
      v_version_created := true;
      perform article_audit_append_p3(
        p_article_id, 'article.version.created', v_version.id, null, null,
        p_provenance_actor_type, p_provenance_actor_id, p_reason, p_request_id,
        p_correlation_id, jsonb_build_object('contentHash', v_content_hash, 'revision', v_version.revision)
      );
    end if;
  else
    select v.* into v_version from article_content_versions_p3 v
    where v.id = p_version_id and v.article_id = p_article_id;
    if not found then
      raise exception using errcode = 'P0002', message = 'ARTICLE_VERSION_NOT_FOUND';
    end if;
  end if;

  select p.* into v_publication from article_publications_p3 p where p.article_id = p_article_id for update;
  if coalesce(v_publication.revision, 0) <> p_expected_publication_revision then
    raise exception using errcode = '40001', message = 'ARTICLE_PUBLICATION_STALE_REVISION';
  end if;

  v_old_state := v_publication.state;
  v_old_version_id := v_publication.version_id;
  v_publication_applied := v_publication.id is null
    or p_target_state is distinct from v_publication.state
    or v_version.id is distinct from v_publication.version_id;

  if v_publication_applied and not article_publication_transition_allowed_p3(
    v_publication.state, p_target_state, p_actor_type, v_version.id is distinct from v_publication.version_id
  ) then
    raise exception using errcode = '23514', message = 'ARTICLE_PUBLICATION_ILLEGAL_TRANSITION';
  end if;
  if v_publication.state = 'withdrawn' and p_target_state = 'published' and length(trim(p_reason)) < 8 then
    raise exception using errcode = '23514', message = 'ARTICLE_PUBLICATION_REPUBLISH_REASON_REQUIRED';
  end if;
  if p_target_state = 'published' and not article_publication_eligible_p3(v_article, v_version) then
    raise exception using errcode = '23514', message = 'ARTICLE_PUBLICATION_INELIGIBLE';
  end if;

  if v_publication.id is null then
    insert into article_publications_p3 (
      article_id, state, version_id, revision, decided_by_type, decided_by_id, reason,
      published_at, withdrawn_at, created_at, updated_at
    ) values (
      p_article_id, p_target_state, v_version.id, 1, p_actor_type,
      left(nullif(trim(p_actor_id), ''), 160), p_reason,
      case when p_target_state = 'published' then v_now else null end,
      case when p_target_state = 'withdrawn' then v_now else null end,
      v_now, v_now
    ) returning * into v_publication;
  elsif v_publication_applied then
    update article_publications_p3 set
      state = p_target_state,
      version_id = v_version.id,
      revision = revision + 1,
      decided_by_type = p_actor_type,
      decided_by_id = left(nullif(trim(p_actor_id), ''), 160),
      reason = p_reason,
      published_at = case when p_target_state = 'published' then coalesce(published_at, v_now) else published_at end,
      withdrawn_at = case when p_target_state = 'withdrawn' then v_now when p_target_state = 'published' then null else withdrawn_at end,
      updated_at = v_now
    where id = v_publication.id
    returning * into v_publication;
  end if;
  v_publication_revision := v_publication.revision;

  if v_publication_applied then
    insert into article_publication_history_p3 (
      publication_id, article_id, publication_revision, from_state, to_state,
      from_version_id, to_version_id, idempotency_key, actor_type, actor_id, reason,
      request_id, correlation_id, occurred_at
    ) values (
      v_publication.id, p_article_id, v_publication.revision, v_old_state, p_target_state,
      v_old_version_id, v_version.id, p_idempotency_key, p_actor_type,
      left(nullif(trim(p_actor_id), ''), 160), p_reason,
      left(nullif(trim(p_request_id), ''), 160), left(nullif(trim(p_correlation_id), ''), 160), v_now
    );
    perform article_audit_append_p3(
      p_article_id,
      case p_target_state when 'published' then 'article.publication.published'
        when 'withdrawn' then 'article.publication.withdrawn'
        else 'article.publication.' || p_target_state end,
      v_version.id, v_publication.id, v_publication.revision, p_actor_type,
      p_actor_id, p_reason, p_request_id, p_correlation_id,
      v_metadata || jsonb_build_object('fromState', v_old_state, 'toState', p_target_state)
    );
    insert into article_cache_outbox_p3 (
      event_key, event_type, article_id, publication_id, publication_revision,
      version_id, publication_state, article_slug, available_at, created_at, updated_at
    ) values (
      'article-publication:' || v_publication.id::text || ':' || v_publication.revision::text,
      'publication.changed', p_article_id, v_publication.id, v_publication.revision,
      v_version.id, p_target_state, v_version.slug, v_now, v_now, v_now
    ) on conflict on constraint article_cache_outbox_p3_publication_revision_key do nothing;
  end if;

  if not v_version_created and not v_publication_applied then
    perform article_audit_append_p3(
      p_article_id,
      case when p_capture_legacy then 'article.version.capture_noop' else 'article.publication.noop' end,
      v_version.id, v_publication.id, v_publication.revision,
      case when p_capture_legacy then p_provenance_actor_type else p_actor_type end,
      case when p_capture_legacy then p_provenance_actor_id else p_actor_id end,
      p_reason, p_request_id, p_correlation_id, v_metadata
    );
  end if;

  insert into article_publication_requests_p3 (
    article_id, idempotency_key, publication_id, publication_revision, version_id,
    version_revision, state, version_created, publication_applied, created_at
  ) values (
    p_article_id, p_idempotency_key, v_publication.id, v_publication.revision,
    v_version.id, v_version.revision, v_publication.state, v_version_created,
    v_publication_applied, v_now
  ) returning * into v_request;

  return query select p_article_id, v_version.id, v_version.revision,
    v_publication.id, v_publication.revision, v_publication.state,
    v_version_created, v_publication_applied, false;
end;
$$;

create or replace view public_article_projection_p3
with (security_barrier = true)
as
select
  v.article_id as id,
  v.slug,
  v.source_key,
  v.jurisdiction,
  v.institution_name,
  v.content_type,
  v.original_url,
  v.canonical_url,
  v.original_language,
  v.original_title,
  v.korean_title,
  v.original_published_at,
  v.discovered_at,
  v.fetched_at,
  v.summarized_at,
  'summarized'::text as status,
  v.raw_text,
  v.cleaned_text,
  v.summary_json,
  v.source_metadata,
  v.error_metadata,
  v.content_hash,
  v.search_vector,
  v.embedding,
  p.id as publication_id,
  p.revision as publication_revision,
  v.id as article_version_id,
  v.revision as article_version_revision,
  coalesce((
    select jsonb_agg(jsonb_build_object(
      'confidence', at.confidence,
      'tags', jsonb_build_object(
        'id', t.id, 'slug', t.slug, 'name', t.name, 'normalized_name', t.normalized_name,
        'type', t.type, 'description', t.description, 'article_count', t.article_count,
        'latest_article_at', t.latest_article_at
      )
    ) order by t.slug)
    from article_tags at
    join tags t on t.id = at.tag_id
    where at.article_id = v.article_id
  ), '[]'::jsonb) as article_tags
from article_publications_p3 p
join article_content_versions_p3 v on v.id = p.version_id and v.article_id = p.article_id
join articles a on a.id = p.article_id
where p.state = 'published'
  and article_publication_eligible_p3(a, v);

create or replace view public_tag_projection_p3
with (security_barrier = true)
as
select
  t.id, t.slug, t.name, t.normalized_name, t.type, t.description,
  count(p.id)::integer as article_count,
  max(p.original_published_at) as latest_article_at,
  t.created_at, t.updated_at
from tags t
left join article_tags at on at.tag_id = t.id
left join public_article_projection_p3 p on p.id = at.article_id
group by t.id, t.slug, t.name, t.normalized_name, t.type, t.description, t.created_at, t.updated_at;

create or replace function public_jurisdiction_article_counts_p3(range_start timestamptz default null)
returns table (jurisdiction text, article_count bigint)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.jurisdiction, count(*)::bigint
  from public_article_projection_p3 p
  where range_start is null or p.original_published_at >= range_start
  group by p.jurisdiction;
$$;

create or replace function article_publication_snapshot_p3(p_article_id uuid)
returns table(
  article_id uuid,
  version_revision bigint,
  publication_revision bigint,
  publication_state text,
  legacy_updated_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select a.id, coalesce(h.current_revision, 0), coalesce(p.revision, 0), p.state, a.updated_at
  from articles a
  left join article_version_heads_p3 h on h.article_id = a.id
  left join article_publications_p3 p on p.article_id = a.id
  where a.id = p_article_id;
$$;

create or replace function match_public_article_versions_p3(
  query_embedding vector(1536),
  match_count integer default 20,
  source_filter text default null,
  jurisdiction_filter text default null,
  content_type_filter text default null,
  language_filter text default null
)
returns table (article_id uuid, similarity double precision)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.id, 1 - (p.embedding <=> query_embedding) as similarity
  from public_article_projection_p3 p
  where p.embedding is not null
    and (source_filter is null or p.source_key = source_filter)
    and (jurisdiction_filter is null or p.jurisdiction = jurisdiction_filter)
    and (content_type_filter is null or p.content_type = content_type_filter)
    and (language_filter is null or p.original_language = language_filter)
  order by p.embedding <=> query_embedding
  limit least(greatest(coalesce(match_count, 20), 1), 200);
$$;

create or replace function article_cache_outbox_claim_p3(
  p_worker_id text,
  p_limit integer default 20,
  p_lease_seconds integer default 120
)
returns table(
  event_id uuid,
  event_key text,
  article_id uuid,
  publication_id uuid,
  publication_revision bigint,
  version_id uuid,
  publication_state text,
  article_slug text,
  lease_token uuid,
  lease_expires_at timestamptz,
  attempt_count integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_worker_id is null or length(trim(p_worker_id)) not between 1 and 160
    or p_limit not between 1 and 100
    or p_lease_seconds not between 15 and 900
  then
    raise exception using errcode = '22023', message = 'ARTICLE_OUTBOX_INVALID_CLAIM';
  end if;

  update article_cache_outbox_p3 o set
    status = case when o.attempt_count >= o.max_attempts then 'dead_letter' else 'pending' end,
    available_at = case when o.attempt_count >= o.max_attempts then o.available_at else now() end,
    dead_lettered_at = case when o.attempt_count >= o.max_attempts then now() else null end,
    last_error_code = 'lease.expired',
    lease_owner = null,
    lease_token = null,
    lease_expires_at = null,
    updated_at = now()
  where o.status = 'processing' and o.lease_expires_at <= now();

  return query
  with candidates as (
    select o.id
    from article_cache_outbox_p3 o
    where o.status = 'pending' and o.available_at <= now()
    order by o.available_at, o.created_at, o.id
    for update skip locked
    limit p_limit
  ), claimed as (
    update article_cache_outbox_p3 o set
      status = 'processing',
      attempt_count = o.attempt_count + 1,
      lease_owner = trim(p_worker_id),
      lease_token = gen_random_uuid(),
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      updated_at = now()
    from candidates c
    where o.id = c.id
    returning o.*
  )
  select c.id, c.event_key, c.article_id, c.publication_id, c.publication_revision,
    c.version_id, c.publication_state, c.article_slug, c.lease_token,
    c.lease_expires_at, c.attempt_count
  from claimed c
  order by c.created_at, c.id;
end;
$$;

create or replace function article_cache_outbox_deliver_p3(
  p_event_id uuid,
  p_worker_id text,
  p_lease_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_updated integer;
begin
  update article_cache_outbox_p3 set
    status = 'delivered', delivered_at = now(), lease_owner = null,
    lease_token = null, lease_expires_at = null, last_error_code = null, updated_at = now()
  where id = p_event_id and status = 'processing' and lease_owner = p_worker_id
    and lease_token = p_lease_token and lease_expires_at > now();
  get diagnostics v_updated = row_count;
  if v_updated <> 1 then
    raise exception using errcode = '40001', message = 'ARTICLE_OUTBOX_STALE_LEASE';
  end if;
  return true;
end;
$$;

create or replace function article_cache_outbox_fail_p3(
  p_event_id uuid,
  p_worker_id text,
  p_lease_token uuid,
  p_error_code text
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_event article_cache_outbox_p3%rowtype;
  v_status text;
begin
  if p_error_code is null or p_error_code !~ '^[a-z][a-z0-9._-]{0,119}$' then
    raise exception using errcode = '22023', message = 'ARTICLE_OUTBOX_INVALID_ERROR';
  end if;
  select o.* into v_event from article_cache_outbox_p3 o where o.id = p_event_id for update;
  if not found or v_event.status <> 'processing' or v_event.lease_owner <> p_worker_id
    or v_event.lease_token <> p_lease_token or v_event.lease_expires_at <= now()
  then
    raise exception using errcode = '40001', message = 'ARTICLE_OUTBOX_STALE_LEASE';
  end if;
  v_status := case when v_event.attempt_count >= v_event.max_attempts then 'dead_letter' else 'pending' end;
  update article_cache_outbox_p3 set
    status = v_status,
    available_at = case when v_status = 'pending' then now() + make_interval(secs => least(3600, 5 * power(2, least(attempt_count, 9))::integer)) else available_at end,
    dead_lettered_at = case when v_status = 'dead_letter' then now() else null end,
    last_error_code = p_error_code,
    lease_owner = null, lease_token = null, lease_expires_at = null, updated_at = now()
  where id = p_event_id;
  return v_status;
end;
$$;

revoke all on table article_content_versions_p3, article_version_heads_p3, article_publications_p3,
  article_publication_history_p3, article_audit_ledger_p3, article_publication_requests_p3,
  article_publication_quarantine_p3, article_cache_outbox_p3 from public;
revoke all on function article_audit_append_p3(uuid, text, uuid, uuid, bigint, text, text, text, text, text, jsonb) from public;
revoke all on function article_publication_transition_p3(uuid, bigint, bigint, text, text, uuid, boolean, text, text, text, text, text, text, text, text, text, jsonb, timestamptz) from public;
revoke all on function article_cache_outbox_claim_p3(text, integer, integer) from public;
revoke all on function article_cache_outbox_deliver_p3(uuid, text, uuid) from public;
revoke all on function article_cache_outbox_fail_p3(uuid, text, uuid, text) from public;
revoke all on function article_publication_snapshot_p3(uuid) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on table article_content_versions_p3, article_version_heads_p3, article_publications_p3,
      article_publication_history_p3, article_audit_ledger_p3, article_publication_requests_p3,
      article_publication_quarantine_p3, article_cache_outbox_p3 from anon;
    grant select on public_article_projection_p3, public_tag_projection_p3 to anon;
    grant execute on function public_jurisdiction_article_counts_p3(timestamptz) to anon;
    grant execute on function match_public_article_versions_p3(vector, integer, text, text, text, text) to anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on table article_content_versions_p3, article_version_heads_p3, article_publications_p3,
      article_publication_history_p3, article_audit_ledger_p3, article_publication_requests_p3,
      article_publication_quarantine_p3, article_cache_outbox_p3 from authenticated;
    grant select on public_article_projection_p3, public_tag_projection_p3 to authenticated;
    grant execute on function public_jurisdiction_article_counts_p3(timestamptz) to authenticated;
    grant execute on function match_public_article_versions_p3(vector, integer, text, text, text, text) to authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on table article_content_versions_p3, article_version_heads_p3, article_publications_p3,
      article_publication_history_p3, article_audit_ledger_p3, article_publication_requests_p3,
      article_publication_quarantine_p3, article_cache_outbox_p3 from service_role;
    grant select on public_article_projection_p3, public_tag_projection_p3 to service_role;
    grant execute on function public_jurisdiction_article_counts_p3(timestamptz) to service_role;
    grant execute on function match_public_article_versions_p3(vector, integer, text, text, text, text) to service_role;
    grant execute on function article_publication_transition_p3(uuid, bigint, bigint, text, text, uuid, boolean, text, text, text, text, text, text, text, text, text, jsonb, timestamptz) to service_role;
    grant execute on function article_cache_outbox_claim_p3(text, integer, integer) to service_role;
    grant execute on function article_cache_outbox_deliver_p3(uuid, text, uuid) to service_role;
    grant execute on function article_cache_outbox_fail_p3(uuid, text, uuid, text) to service_role;
    grant execute on function article_publication_snapshot_p3(uuid) to service_role;
  end if;
end;
$$;
