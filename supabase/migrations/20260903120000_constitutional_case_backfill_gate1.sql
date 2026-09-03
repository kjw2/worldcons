begin;

-- Gate 1: durable constitutional-case inventory and replayable processing ledger.
-- Public Catalog reads and article publication remain disabled until Gate 2.

create or replace function case_backfill_prevent_mutation_v1()
returns trigger
language plpgsql
set search_path = public, extensions, pg_temp
as $function$
begin
  raise exception using errcode = '55000', message = 'CASE_BACKFILL_IMMUTABLE';
end;
$function$;

create table if not exists source_corpus_policies (
  source_key text not null,
  policy_version text not null,
  scope_definition jsonb not null,
  official_scope_url text not null,
  discovery_methods text[] not null,
  authority_hosts text[] not null,
  redirect_hosts text[] not null default '{}',
  robots_url text not null,
  robots_observed_at timestamptz not null,
  robots_rules_hash text not null,
  terms_url text,
  terms_observed_at timestamptz,
  license_basis text not null,
  default_text_access_policy text not null,
  allow_raw_snapshot boolean not null default false,
  normalize_replay_policy text not null,
  bounded_replay_fields text[] not null default '{}',
  retention_days integer,
  min_request_delay_ms integer not null,
  max_concurrency integer not null,
  external_index_hosts text[] not null default '{}',
  external_index_usage text,
  reviewed_by text not null,
  reviewed_at timestamptz not null,
  review_due_at timestamptz not null,
  supersedes_policy_version text,
  created_at timestamptz not null default now(),
  primary key (source_key, policy_version),
  constraint source_corpus_policies_source_key_check check (source_key ~ '^[a-z][a-z0-9._-]{0,79}$'),
  constraint source_corpus_policies_policy_version_check check (policy_version ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$'),
  constraint source_corpus_policies_scope_check check (
    jsonb_typeof(scope_definition) = 'object' and pg_column_size(scope_definition) <= 16384
  ),
  constraint source_corpus_policies_https_check check (
    official_scope_url ~ '^https://' and robots_url ~ '^https://' and (terms_url is null or terms_url ~ '^https://')
  ),
  constraint source_corpus_policies_arrays_check check (
    cardinality(discovery_methods) between 1 and 20
    and cardinality(authority_hosts) between 1 and 20
    and cardinality(redirect_hosts) <= 20
    and cardinality(bounded_replay_fields) <= 100
    and cardinality(external_index_hosts) <= 20
  ),
  constraint source_corpus_policies_text_policy_check check (
    default_text_access_policy in ('metadata_only', 'index_only', 'excerpt', 'full')
  ),
  constraint source_corpus_policies_replay_check check (
    normalize_replay_policy in ('full_snapshot', 'bounded_evidence', 'non_replayable')
    and (normalize_replay_policy <> 'full_snapshot' or allow_raw_snapshot)
    and (normalize_replay_policy <> 'bounded_evidence' or cardinality(bounded_replay_fields) > 0)
  ),
  constraint source_corpus_policies_limits_check check (
    (retention_days is null or retention_days between 1 and 36500)
    and min_request_delay_ms between 0 and 3600000
    and max_concurrency between 1 and 32
  ),
  constraint source_corpus_policies_review_check check (
    length(reviewed_by) between 1 and 160 and review_due_at > reviewed_at
  ),
  constraint source_corpus_policies_supersedes_fkey foreign key (source_key, supersedes_policy_version)
    references source_corpus_policies(source_key, policy_version) on delete restrict
);

create table if not exists source_inventory_snapshots (
  id uuid primary key default gen_random_uuid(),
  source_key text not null,
  scope_from date,
  scope_to date,
  document_type text not null,
  discovery_method text not null,
  parser_version text not null,
  source_policy_version text not null,
  coverage_assurance text not null,
  expected_count integer,
  expected_count_basis text,
  coverage_evidence jsonb not null default '{}'::jsonb,
  discovered_count integer not null default 0,
  manifest_hash text,
  status text not null default 'open',
  exclusions jsonb not null default '[]'::jsonb,
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  created_by text not null,
  constraint source_inventory_snapshots_policy_fkey foreign key (source_key, source_policy_version)
    references source_corpus_policies(source_key, policy_version) on delete restrict,
  constraint source_inventory_snapshots_status_check check (status in ('open', 'closed', 'superseded', 'failed')),
  constraint source_inventory_snapshots_coverage_check check (coverage_assurance in (
    'authoritative_enumerated', 'authoritative_counted', 'authoritative_crosschecked',
    'external_index_assisted', 'best_effort'
  )),
  constraint source_inventory_snapshots_expected_check check (
    expected_count is null or (expected_count >= 0 and expected_count_basis is not null)
  ),
  constraint source_inventory_snapshots_authoritative_count_check check (
    coverage_assurance not in ('authoritative_counted', 'authoritative_crosschecked') or expected_count is not null
  ),
  constraint source_inventory_snapshots_evidence_check check (
    jsonb_typeof(coverage_evidence) = 'object' and pg_column_size(coverage_evidence) <= 16384
  ),
  constraint source_inventory_snapshots_exclusions_check check (
    jsonb_typeof(exclusions) = 'array' and pg_column_size(exclusions) <= 16384
  ),
  constraint source_inventory_snapshots_manifest_check check (
    (status = 'open' and manifest_hash is null and closed_at is null)
    or (status in ('closed', 'superseded') and manifest_hash ~ '^[0-9a-f]{64}$' and closed_at is not null)
    or (status = 'failed' and closed_at is not null)
  ),
  constraint source_inventory_snapshots_scope_check check (scope_to is null or scope_from is null or scope_to >= scope_from),
  constraint source_inventory_snapshots_text_check check (
    length(document_type) between 1 and 80
    and length(discovery_method) between 1 and 120
    and length(parser_version) between 1 and 120
    and length(created_by) between 1 and 160
  )
);

create table if not exists source_backfill_runs (
  id uuid primary key default gen_random_uuid(),
  snapshot_id uuid not null references source_inventory_snapshots(id) on delete restrict,
  command_run_id uuid references admin_command_runs(id) on delete set null,
  p1_attempt_id uuid references admin_command_attempts(id) on delete restrict,
  p1_fencing_token bigint,
  phase text not null,
  pass_number integer not null,
  status text not null,
  claimed_count integer not null default 0,
  succeeded_count integer not null default 0,
  retryable_failed_count integer not null default 0,
  terminal_failed_count integer not null default 0,
  cursor_in jsonb,
  cursor_out jsonb,
  page_manifest_hash text,
  heartbeat_at timestamptz,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  last_error_code text,
  last_error_summary text,
  unique (snapshot_id, phase, pass_number),
  constraint source_backfill_runs_pass_check check (pass_number > 0),
  constraint source_backfill_runs_counts_check check (
    claimed_count >= 0 and succeeded_count >= 0 and retryable_failed_count >= 0 and terminal_failed_count >= 0
  ),
  constraint source_backfill_runs_attempt_shape_check check (
    (status = 'queued' and p1_attempt_id is null and p1_fencing_token is null)
    or (status <> 'queued' and p1_attempt_id is not null and p1_fencing_token is not null)
  ),
  constraint source_backfill_runs_json_check check (
    (cursor_in is null or (jsonb_typeof(cursor_in) = 'object' and pg_column_size(cursor_in) <= 16384))
    and (cursor_out is null or (jsonb_typeof(cursor_out) = 'object' and pg_column_size(cursor_out) <= 16384))
  ),
  constraint source_backfill_runs_phase_check check (phase in ('discover', 'fetch', 'normalize', 'verify', 'publish', 'reconcile')),
  constraint source_backfill_runs_status_check check (status in ('queued', 'running', 'deferred', 'succeeded', 'degraded', 'failed', 'aborted')),
  constraint source_backfill_runs_terminal_check check (
    (status in ('succeeded', 'degraded', 'failed', 'aborted') and completed_at is not null)
    or (status in ('queued', 'running', 'deferred') and completed_at is null)
  )
);

create table if not exists source_backfill_items (
  id uuid primary key default gen_random_uuid(),
  snapshot_id uuid not null references source_inventory_snapshots(id) on delete restrict,
  source_key text not null,
  stable_item_key text not null,
  source_record_id text,
  discovered_url text not null,
  authority_url text,
  document_type text,
  discovered_decision_date_hint date,
  status text not null default 'discovered',
  attempt_count integer not null default 0,
  next_attempt_at timestamptz,
  retry_phase text,
  claimed_attempt_id uuid references admin_command_attempts(id) on delete restrict,
  claimed_fencing_token bigint,
  claimed_phase text,
  lease_expires_at timestamptz,
  http_status integer,
  source_etag text,
  source_last_modified_at timestamptz,
  payload_hash text,
  parser_version text,
  current_fetch_artifact_id uuid,
  current_normalization_artifact_id uuid,
  verified_normalization_artifact_id uuid,
  published_normalization_artifact_id uuid,
  article_id uuid references articles(id) on delete restrict,
  duplicate_of_item_id uuid references source_backfill_items(id) on delete restrict,
  exclusion_code text,
  error_code text,
  error_summary text,
  waived_by text,
  waived_at timestamptz,
  waiver_reason text,
  waiver_expires_at timestamptz,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (snapshot_id, stable_item_key),
  constraint source_backfill_items_source_snapshot_key unique (id, snapshot_id),
  constraint source_backfill_items_status_check check (status in (
    'discovered', 'queued', 'fetching', 'fetched', 'normalized', 'verified',
    'published', 'retry_wait', 'terminal_failure', 'waived_failure',
    'excluded', 'duplicate', 'withdrawn'
  )),
  constraint source_backfill_items_attempt_check check (attempt_count >= 0),
  constraint source_backfill_items_phase_check check (claimed_phase is null or claimed_phase in ('fetch', 'normalize', 'verify', 'publish')),
  constraint source_backfill_items_retry_phase_check check (retry_phase is null or retry_phase in ('fetch', 'normalize', 'verify', 'publish')),
  constraint source_backfill_items_claim_shape_check check (
    (claimed_attempt_id is null and claimed_fencing_token is null and claimed_phase is null and lease_expires_at is null)
    or (claimed_attempt_id is not null and claimed_fencing_token is not null and claimed_phase is not null and lease_expires_at is not null)
  ),
  constraint source_backfill_items_waiver_check check (
    status <> 'waived_failure' or (waived_by is not null and waived_at is not null and waiver_reason is not null)
  ),
  constraint source_backfill_items_duplicate_check check (
    (status = 'duplicate' and duplicate_of_item_id is not null) or (status <> 'duplicate' and duplicate_of_item_id is null)
  ),
  constraint source_backfill_items_url_check check (
    discovered_url ~ '^https://' and (authority_url is null or authority_url ~ '^https://')
  ),
  constraint source_backfill_items_text_check check (
    length(stable_item_key) between 1 and 300
    and (source_record_id is null or length(source_record_id) <= 300)
    and (document_type is null or length(document_type) <= 80)
    and (error_code is null or length(error_code) <= 160)
    and (error_summary is null or length(error_summary) <= 500)
  ),
  constraint source_backfill_items_hash_check check (payload_hash is null or payload_hash ~ '^[0-9a-f]{64}$')
);

create table if not exists source_fetch_artifacts (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references source_backfill_items(id) on delete restrict,
  source_policy_version text not null,
  authority_url text not null,
  http_status integer not null,
  response_headers_allowlist jsonb not null default '{}'::jsonb,
  source_etag text,
  source_last_modified_at timestamptz,
  payload_hash text not null,
  payload_size bigint not null,
  replayability text not null,
  immutable_storage_ref text,
  bounded_replay_payload jsonb,
  fetched_at timestamptz not null default now(),
  fetch_contract_version text not null,
  created_at timestamptz not null default now(),
  unique (item_id, payload_hash, fetch_contract_version),
  constraint source_fetch_artifacts_item_key unique (id, item_id),
  constraint source_fetch_artifacts_status_check check (http_status between 100 and 599),
  constraint source_fetch_artifacts_hash_check check (payload_hash ~ '^[0-9a-f]{64}$'),
  constraint source_fetch_artifacts_size_check check (payload_size between 0 and 67108864),
  constraint source_fetch_artifacts_headers_check check (
    jsonb_typeof(response_headers_allowlist) = 'object' and pg_column_size(response_headers_allowlist) <= 8192
  ),
  constraint source_fetch_artifacts_replay_check check (
    (replayability = 'full_snapshot' and immutable_storage_ref is not null and bounded_replay_payload is null)
    or (replayability = 'bounded_evidence' and immutable_storage_ref is null and bounded_replay_payload is not null
      and pg_column_size(bounded_replay_payload) <= 4194304)
    or (replayability = 'non_replayable' and immutable_storage_ref is null and bounded_replay_payload is null)
  ),
  constraint source_fetch_artifacts_text_check check (
    authority_url ~ '^https://'
    and length(fetch_contract_version) between 1 and 120
    and (immutable_storage_ref is null or (length(immutable_storage_ref) between 1 and 500 and immutable_storage_ref !~* '(token|secret|signature|credential)'))
  )
);

create table if not exists source_normalization_artifacts (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references source_backfill_items(id) on delete restrict,
  fetch_artifact_id uuid not null,
  parser_version text not null,
  normalization_contract_version text not null,
  normalized_output jsonb not null,
  normalized_output_hash text not null,
  validation_status text not null,
  validation_errors jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  unique (fetch_artifact_id, parser_version, normalization_contract_version),
  constraint source_normalization_artifacts_item_key unique (id, item_id),
  constraint source_normalization_artifacts_fetch_fkey foreign key (fetch_artifact_id, item_id)
    references source_fetch_artifacts(id, item_id) on delete restrict,
  constraint source_normalization_artifacts_hash_check check (normalized_output_hash ~ '^[0-9a-f]{64}$'),
  constraint source_normalization_artifacts_status_check check (validation_status in ('valid', 'invalid')),
  constraint source_normalization_artifacts_json_check check (
    jsonb_typeof(normalized_output) = 'object' and pg_column_size(normalized_output) <= 4194304
    and jsonb_typeof(validation_errors) = 'array' and pg_column_size(validation_errors) <= 32768
  ),
  constraint source_normalization_artifacts_text_check check (
    length(parser_version) between 1 and 120 and length(normalization_contract_version) between 1 and 120
  )
);

alter table source_backfill_items
  add constraint source_backfill_items_current_fetch_fkey foreign key (current_fetch_artifact_id, id)
    references source_fetch_artifacts(id, item_id) on delete restrict,
  add constraint source_backfill_items_current_normalization_fkey foreign key (current_normalization_artifact_id, id)
    references source_normalization_artifacts(id, item_id) on delete restrict,
  add constraint source_backfill_items_verified_normalization_fkey foreign key (verified_normalization_artifact_id, id)
    references source_normalization_artifacts(id, item_id) on delete restrict,
  add constraint source_backfill_items_published_normalization_fkey foreign key (published_normalization_artifact_id, id)
    references source_normalization_artifacts(id, item_id) on delete restrict;

create table if not exists source_backfill_item_events (
  id bigint generated by default as identity primary key,
  item_id uuid not null references source_backfill_items(id) on delete restrict,
  attempt_id uuid references admin_command_attempts(id) on delete restrict,
  event_type text not null,
  phase text,
  safe_details jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  constraint source_backfill_item_events_type_check check (event_type in (
    'item_discovered', 'item_claimed', 'item_lease_extended', 'fetch_recorded',
    'normalization_recorded', 'item_completed', 'item_failed', 'claim_released',
    'verification_noop'
  )),
  constraint source_backfill_item_events_phase_check check (phase is null or phase in ('discover', 'fetch', 'normalize', 'verify', 'publish', 'reconcile')),
  constraint source_backfill_item_events_detail_check check (
    jsonb_typeof(safe_details) = 'object' and pg_column_size(safe_details) <= 8192
  )
);

create index if not exists source_inventory_snapshots_scope_idx
  on source_inventory_snapshots(source_key, document_type, scope_from, scope_to, opened_at desc);
create index if not exists source_backfill_runs_snapshot_phase_idx
  on source_backfill_runs(snapshot_id, phase, pass_number desc);
create index if not exists source_backfill_items_claim_idx
  on source_backfill_items(snapshot_id, status, next_attempt_at, first_seen_at)
  where claimed_attempt_id is null;
create index if not exists source_backfill_items_claim_lease_idx
  on source_backfill_items(lease_expires_at, claimed_attempt_id)
  where claimed_attempt_id is not null;
create index if not exists source_fetch_artifacts_item_created_idx
  on source_fetch_artifacts(item_id, created_at desc);
create index if not exists source_normalization_artifacts_item_created_idx
  on source_normalization_artifacts(item_id, created_at desc);
create index if not exists source_backfill_item_events_item_idx
  on source_backfill_item_events(item_id, occurred_at, id);

drop trigger if exists source_corpus_policies_immutable_trigger on source_corpus_policies;
create trigger source_corpus_policies_immutable_trigger
before update or delete on source_corpus_policies
for each row execute function case_backfill_prevent_mutation_v1();

drop trigger if exists source_fetch_artifacts_immutable_trigger on source_fetch_artifacts;
create trigger source_fetch_artifacts_immutable_trigger
before update or delete on source_fetch_artifacts
for each row execute function case_backfill_prevent_mutation_v1();

drop trigger if exists source_normalization_artifacts_immutable_trigger on source_normalization_artifacts;
create trigger source_normalization_artifacts_immutable_trigger
before update or delete on source_normalization_artifacts
for each row execute function case_backfill_prevent_mutation_v1();

drop trigger if exists source_backfill_item_events_immutable_trigger on source_backfill_item_events;
create trigger source_backfill_item_events_immutable_trigger
before update or delete on source_backfill_item_events
for each row execute function case_backfill_prevent_mutation_v1();

create or replace function source_backfill_validate_fetch_policy_v1()
returns trigger
language plpgsql
set search_path = public, extensions, pg_temp
as $function$
declare
  v_source_key text;
  v_snapshot_policy_version text;
  v_policy source_corpus_policies%rowtype;
begin
  select i.source_key, s.source_policy_version into v_source_key, v_snapshot_policy_version
  from source_backfill_items i
  join source_inventory_snapshots s on s.id = i.snapshot_id
  where i.id = new.item_id;
  select p.* into v_policy from source_corpus_policies p
  where p.source_key = v_source_key and p.policy_version = new.source_policy_version;
  if not found then
    raise exception using errcode = '23503', message = 'CASE_BACKFILL_POLICY_NOT_FOUND';
  end if;
  if new.replayability <> v_policy.normalize_replay_policy then
    raise exception using errcode = '22023', message = 'CASE_BACKFILL_REPLAY_POLICY_MISMATCH';
  end if;
  if new.source_policy_version <> v_snapshot_policy_version then
    raise exception using errcode = '22023', message = 'CASE_BACKFILL_SNAPSHOT_POLICY_MISMATCH';
  end if;
  if v_policy.review_due_at <= now() then
    raise exception using errcode = '55000', message = 'SOURCE_POLICY_REVIEW_OVERDUE';
  end if;
  if new.replayability = 'full_snapshot' and not v_policy.allow_raw_snapshot then
    raise exception using errcode = '22023', message = 'CASE_BACKFILL_RAW_SNAPSHOT_FORBIDDEN';
  end if;
  return new;
end;
$function$;

drop trigger if exists source_fetch_artifacts_policy_trigger on source_fetch_artifacts;
create trigger source_fetch_artifacts_policy_trigger
before insert on source_fetch_artifacts
for each row execute function source_backfill_validate_fetch_policy_v1();

create or replace function source_backfill_guard_manifest_v1()
returns trigger
language plpgsql
set search_path = public, extensions, pg_temp
as $function$
declare
  v_snapshot_id uuid;
  v_status text;
begin
  v_snapshot_id := case when tg_op = 'DELETE' then old.snapshot_id else new.snapshot_id end;
  select s.status into v_status from source_inventory_snapshots s where s.id = v_snapshot_id;
  if not found then raise exception using errcode = '23503', message = 'CASE_BACKFILL_SNAPSHOT_NOT_FOUND'; end if;

  if v_status <> 'open' then
    if tg_op in ('INSERT', 'DELETE') then
      raise exception using errcode = '55000', message = 'CASE_BACKFILL_MANIFEST_CLOSED';
    end if;
    if new.snapshot_id is distinct from old.snapshot_id
      or new.source_key is distinct from old.source_key
      or new.stable_item_key is distinct from old.stable_item_key
      or new.source_record_id is distinct from old.source_record_id
      or new.discovered_url is distinct from old.discovered_url
      or new.document_type is distinct from old.document_type
      or new.discovered_decision_date_hint is distinct from old.discovered_decision_date_hint
      or new.first_seen_at is distinct from old.first_seen_at
      or new.last_seen_at is distinct from old.last_seen_at
    then
      raise exception using errcode = '55000', message = 'CASE_BACKFILL_MANIFEST_CLOSED';
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$function$;

drop trigger if exists source_backfill_items_manifest_guard_trigger on source_backfill_items;
create trigger source_backfill_items_manifest_guard_trigger
before insert or update or delete on source_backfill_items
for each row execute function source_backfill_guard_manifest_v1();

create or replace function source_inventory_snapshot_open_v1(
  p_source_key text,
  p_scope_from date,
  p_scope_to date,
  p_document_type text,
  p_discovery_method text,
  p_parser_version text,
  p_source_policy_version text,
  p_coverage_assurance text,
  p_expected_count integer,
  p_expected_count_basis text,
  p_coverage_evidence jsonb,
  p_exclusions jsonb,
  p_created_by text
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $function$
declare
  v_id uuid;
  v_policy source_corpus_policies%rowtype;
begin
  if p_source_key is null or p_source_key !~ '^[a-z][a-z0-9._-]{0,79}$'
    or p_document_type is null or length(trim(p_document_type)) not between 1 and 80
    or p_discovery_method is null or length(trim(p_discovery_method)) not between 1 and 120
    or p_parser_version is null or length(trim(p_parser_version)) not between 1 and 120
    or p_created_by is null or length(trim(p_created_by)) not between 1 and 160
  then
    raise exception using errcode = '22023', message = 'CASE_BACKFILL_INVALID_SNAPSHOT';
  end if;

  select p.* into v_policy from source_corpus_policies p
  where p.source_key = p_source_key and p.policy_version = p_source_policy_version;
  if not found then raise exception using errcode = '23503', message = 'CASE_BACKFILL_POLICY_NOT_FOUND'; end if;
  if v_policy.review_due_at <= now() then
    raise exception using errcode = '55000', message = 'SOURCE_POLICY_REVIEW_OVERDUE';
  end if;

  insert into source_inventory_snapshots(
    source_key, scope_from, scope_to, document_type, discovery_method, parser_version,
    source_policy_version, coverage_assurance, expected_count, expected_count_basis,
    coverage_evidence, exclusions, created_by
  ) values (
    p_source_key, p_scope_from, p_scope_to, trim(p_document_type), trim(p_discovery_method), trim(p_parser_version),
    p_source_policy_version, p_coverage_assurance, p_expected_count, nullif(trim(p_expected_count_basis), ''),
    coalesce(p_coverage_evidence, '{}'::jsonb), coalesce(p_exclusions, '[]'::jsonb), left(trim(p_created_by), 160)
  ) returning id into v_id;
  return v_id;
end;
$function$;

create or replace function source_inventory_item_upsert_v1(
  p_snapshot_id uuid,
  p_stable_item_key text,
  p_source_record_id text,
  p_discovered_url text,
  p_document_type text,
  p_decision_date_hint date
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $function$
declare
  v_snapshot source_inventory_snapshots%rowtype;
  v_id uuid;
begin
  select s.* into v_snapshot from source_inventory_snapshots s where s.id = p_snapshot_id for update;
  if not found then raise exception using errcode = 'P0001', message = 'CASE_BACKFILL_SNAPSHOT_NOT_FOUND'; end if;
  if v_snapshot.status <> 'open' then raise exception using errcode = '55000', message = 'CASE_BACKFILL_MANIFEST_CLOSED'; end if;
  if p_stable_item_key is null or length(trim(p_stable_item_key)) not between 1 and 300
    or p_discovered_url is null or p_discovered_url !~ '^https://'
    or p_document_type is null or length(trim(p_document_type)) not between 1 and 80
  then
    raise exception using errcode = '22023', message = 'CASE_BACKFILL_INVALID_ITEM';
  end if;

  insert into source_backfill_items(
    snapshot_id, source_key, stable_item_key, source_record_id, discovered_url,
    document_type, discovered_decision_date_hint
  ) values (
    v_snapshot.id, v_snapshot.source_key, trim(p_stable_item_key), nullif(trim(p_source_record_id), ''),
    p_discovered_url, trim(p_document_type), p_decision_date_hint
  )
  on conflict (snapshot_id, stable_item_key) do update set
    source_record_id = excluded.source_record_id,
    discovered_url = excluded.discovered_url,
    document_type = excluded.document_type,
    discovered_decision_date_hint = excluded.discovered_decision_date_hint,
    last_seen_at = now(),
    updated_at = now()
  returning id into v_id;

  insert into source_backfill_item_events(item_id, event_type, phase, safe_details)
  values (v_id, 'item_discovered', 'discover', jsonb_build_object('snapshotId', v_snapshot.id));
  return v_id;
end;
$function$;

create or replace function source_inventory_snapshot_close_v1(p_snapshot_id uuid)
returns table(snapshot_id uuid, discovered_count integer, expected_count integer, manifest_hash text, coverage_assurance text)
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $function$
declare
  v_snapshot source_inventory_snapshots%rowtype;
  v_count integer;
  v_hash text;
begin
  select s.* into v_snapshot from source_inventory_snapshots s where s.id = p_snapshot_id for update;
  if not found then raise exception using errcode = 'P0001', message = 'CASE_BACKFILL_SNAPSHOT_NOT_FOUND'; end if;
  if v_snapshot.status = 'closed' then
    return query select v_snapshot.id, v_snapshot.discovered_count, v_snapshot.expected_count, v_snapshot.manifest_hash, v_snapshot.coverage_assurance;
    return;
  end if;
  if v_snapshot.status <> 'open' then raise exception using errcode = '55000', message = 'CASE_BACKFILL_SNAPSHOT_NOT_OPEN'; end if;

  select count(*)::integer,
    encode(extensions.digest(convert_to(coalesce(string_agg(
      jsonb_build_array(
        i.stable_item_key, i.source_record_id, i.discovered_url, i.document_type,
        i.discovered_decision_date_hint
      )::text, E'\n' order by i.stable_item_key
    ), ''), 'UTF8'), 'sha256'), 'hex')
  into v_count, v_hash
  from source_backfill_items i where i.snapshot_id = v_snapshot.id;

  if v_snapshot.expected_count is not null and v_snapshot.expected_count <> v_count then
    raise exception using errcode = '23514', message = 'CASE_BACKFILL_EXPECTED_COUNT_MISMATCH';
  end if;
  if v_snapshot.coverage_assurance in ('authoritative_enumerated', 'authoritative_counted', 'authoritative_crosschecked')
    and v_snapshot.coverage_evidence = '{}'::jsonb
  then
    raise exception using errcode = '23514', message = 'CASE_BACKFILL_COVERAGE_EVIDENCE_REQUIRED';
  end if;

  update source_inventory_snapshots s set
    discovered_count = v_count, manifest_hash = v_hash, status = 'closed', closed_at = now()
  where s.id = v_snapshot.id
  returning s.* into v_snapshot;

  return query select v_snapshot.id, v_count, v_snapshot.expected_count, v_hash, v_snapshot.coverage_assurance;
end;
$function$;

create or replace function source_inventory_snapshot_evidence_v1(
  p_snapshot_id uuid,
  p_coverage_evidence jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $function$
begin
  if jsonb_typeof(coalesce(p_coverage_evidence, '{}'::jsonb)) <> 'object'
    or pg_column_size(coalesce(p_coverage_evidence, '{}'::jsonb)) > 16384
  then raise exception using errcode = '22023', message = 'CASE_BACKFILL_INVALID_COVERAGE_EVIDENCE'; end if;
  update source_inventory_snapshots s set coverage_evidence = p_coverage_evidence
  where s.id = p_snapshot_id and s.status = 'open';
  if not found then raise exception using errcode = '55000', message = 'CASE_BACKFILL_SNAPSHOT_NOT_OPEN'; end if;
  return true;
end;
$function$;

create or replace function source_backfill_assert_attempt_v1(
  p_attempt_id uuid,
  p_fencing_token bigint,
  p_snapshot_id uuid,
  p_phase text
)
returns table(attempt_lease_expires_at timestamptz, command_run_id uuid, command_payload jsonb)
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $function$
declare
  v_attempt admin_command_attempts%rowtype;
  v_run admin_command_runs%rowtype;
  v_command admin_commands%rowtype;
begin
  select a.* into v_attempt from admin_command_attempts a where a.id = p_attempt_id for update;
  if not found then raise exception using errcode = 'P0001', message = 'CASE_BACKFILL_ATTEMPT_NOT_FOUND'; end if;
  select r.* into v_run from admin_command_runs r where r.id = v_attempt.run_id for update;
  select c.* into v_command from admin_commands c where c.id = v_run.command_id;

  if v_attempt.fencing_token <> p_fencing_token or v_run.current_attempt_id <> v_attempt.id then
    raise exception using errcode = '40001', message = 'CASE_BACKFILL_STALE_FENCE';
  end if;
  if v_attempt.status <> 'running' or v_run.status <> 'running' or v_attempt.lease_expires_at <= now() then
    raise exception using errcode = '40001', message = 'CASE_BACKFILL_LEASE_LOST';
  end if;
  if v_run.abort_requested_at is not null then raise exception using errcode = '40001', message = 'CASE_BACKFILL_ABORTED'; end if;
  if p_phase not in ('discover', 'fetch', 'normalize', 'verify', 'publish', 'reconcile')
    or v_command.command_type <> 'p1.case-backfill.' || p_phase
    or v_command.payload_ref->>'cohort' <> 'catalog-backfill'
    or v_command.payload_ref->>'snapshotId' is distinct from p_snapshot_id::text
  then
    raise exception using errcode = '42501', message = 'CASE_BACKFILL_ATTEMPT_SCOPE_MISMATCH';
  end if;

  return query select v_attempt.lease_expires_at, v_run.id, v_command.payload_ref;
end;
$function$;

create or replace function source_backfill_run_begin_v1(
  p_snapshot_id uuid,
  p_phase text,
  p_pass_number integer,
  p_attempt_id uuid,
  p_fencing_token bigint
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $function$
declare
  v_command_run_id uuid;
  v_command_payload jsonb;
  v_id uuid;
begin
  if p_pass_number is null or p_pass_number not between 1 and 2147483647 then
    raise exception using errcode = '22023', message = 'CASE_BACKFILL_INVALID_PASS';
  end if;
  select a.command_run_id, a.command_payload into v_command_run_id, v_command_payload
  from source_backfill_assert_attempt_v1(p_attempt_id, p_fencing_token, p_snapshot_id, p_phase) a;
  if v_command_payload->>'passNumber' is distinct from p_pass_number::text then
    raise exception using errcode = '42501', message = 'CASE_BACKFILL_PASS_SCOPE_MISMATCH';
  end if;
  insert into source_backfill_runs(
    snapshot_id, command_run_id, p1_attempt_id, p1_fencing_token,
    phase, pass_number, status, heartbeat_at
  )
  values (
    p_snapshot_id, v_command_run_id, p_attempt_id, p_fencing_token,
    p_phase, p_pass_number, 'running', now()
  )
  on conflict (snapshot_id, phase, pass_number) do update set
    command_run_id = excluded.command_run_id,
    p1_attempt_id = excluded.p1_attempt_id,
    p1_fencing_token = excluded.p1_fencing_token,
    status = 'running',
    claimed_count = 0,
    succeeded_count = 0,
    retryable_failed_count = 0,
    terminal_failed_count = 0,
    heartbeat_at = now(),
    completed_at = null,
    last_error_code = null,
    last_error_summary = null
  returning id into v_id;
  return v_id;
end;
$function$;

create or replace function source_backfill_pass_allocate_v1(p_snapshot_id uuid, p_phase text)
returns integer
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $function$
declare
  v_pass integer;
  v_snapshot_status text;
begin
  if p_phase not in ('discover', 'fetch', 'normalize', 'verify', 'publish', 'reconcile') then
    raise exception using errcode = '22023', message = 'CASE_BACKFILL_INVALID_PHASE';
  end if;
  select s.status into v_snapshot_status from source_inventory_snapshots s where s.id = p_snapshot_id;
  if not found then raise exception using errcode = 'P0001', message = 'CASE_BACKFILL_SNAPSHOT_NOT_FOUND'; end if;
  if (p_phase = 'discover' and v_snapshot_status <> 'open')
    or (p_phase <> 'discover' and v_snapshot_status <> 'closed')
  then raise exception using errcode = '55000', message = 'CASE_BACKFILL_SNAPSHOT_PHASE_MISMATCH'; end if;

  perform pg_advisory_xact_lock(hashtextextended(p_snapshot_id::text || ':' || p_phase, 0));
  select coalesce(max(r.pass_number), 0) + 1 into v_pass
  from source_backfill_runs r where r.snapshot_id = p_snapshot_id and r.phase = p_phase;
  insert into source_backfill_runs(snapshot_id, phase, pass_number, status)
  values (p_snapshot_id, p_phase, v_pass, 'queued');
  return v_pass;
end;
$function$;

create or replace function source_backfill_items_claim_v1(
  p_snapshot_id uuid,
  p_phase text,
  p_batch_limit integer,
  p_p1_attempt_id uuid,
  p_p1_fencing_token bigint,
  p_requested_lease_seconds integer default 60,
  p_target_version text default null
)
returns table(
  item_id uuid,
  stable_item_key text,
  source_record_id text,
  discovered_url text,
  authority_url text,
  document_type text,
  decision_date_hint date,
  resolution_status text,
  current_fetch_artifact_id uuid,
  current_normalization_artifact_id uuid,
  verified_normalization_artifact_id uuid,
  published_normalization_artifact_id uuid,
  item_lease_expires_at timestamptz
)
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $function$
declare
  v_attempt_lease timestamptz;
  v_command_payload jsonb;
  v_item_lease timestamptz;
  v_snapshot_status text;
begin
  if p_phase not in ('fetch', 'normalize', 'verify', 'publish')
    or p_batch_limit not between 1 and 100
    or p_requested_lease_seconds not between 1 and 86400
  then
    raise exception using errcode = '22023', message = 'CASE_BACKFILL_INVALID_CLAIM';
  end if;
  select a.attempt_lease_expires_at, a.command_payload into v_attempt_lease, v_command_payload
  from source_backfill_assert_attempt_v1(p_p1_attempt_id, p_p1_fencing_token, p_snapshot_id, p_phase) a;
  if p_batch_limit > coalesce((v_command_payload->>'batchLimit')::integer, 50)
    or (p_phase = 'fetch' and coalesce(v_command_payload->>'fetchContractVersion', 'spain-hj-fetch-v1') is distinct from p_target_version)
    or (p_phase = 'normalize' and (
      coalesce(v_command_payload->>'parserVersion', 'spain-hj-normalize-v1') || ':'
      || coalesce(v_command_payload->>'normalizationContractVersion', 'case-normalized-v1')
    ) is distinct from p_target_version)
    or (p_phase in ('verify', 'publish') and p_target_version is not null)
  then
    raise exception using errcode = '42501', message = 'CASE_BACKFILL_ITEM_SCOPE_MISMATCH';
  end if;
  if not exists(
    select 1 from source_backfill_runs r
    where r.snapshot_id = p_snapshot_id
      and r.phase = p_phase
      and r.p1_attempt_id = p_p1_attempt_id
      and r.p1_fencing_token = p_p1_fencing_token
      and r.status = 'running'
  ) then
    raise exception using errcode = '55000', message = 'CASE_BACKFILL_RUN_NOT_ACTIVE';
  end if;
  select s.status into v_snapshot_status from source_inventory_snapshots s where s.id = p_snapshot_id;
  if v_snapshot_status <> 'closed' then
    raise exception using errcode = '55000', message = 'CASE_BACKFILL_SNAPSHOT_NOT_CLOSED';
  end if;
  v_item_lease := least(v_attempt_lease, now() + make_interval(secs => p_requested_lease_seconds));

  return query
  with eligible as (
    select i.id
    from source_backfill_items i
    left join source_fetch_artifacts f on f.id = i.current_fetch_artifact_id
    left join source_normalization_artifacts n on n.id = i.current_normalization_artifact_id
    where i.snapshot_id = p_snapshot_id
      and (i.claimed_attempt_id is null or i.lease_expires_at <= now())
      and (i.next_attempt_at is null or i.next_attempt_at <= now())
      and (
        (p_phase = 'fetch' and (
          i.status in ('discovered', 'queued')
          or (i.status = 'retry_wait' and i.retry_phase = 'fetch')
          or (i.status = 'published' and p_target_version is not null and f.fetch_contract_version is distinct from p_target_version)
        ))
        or (p_phase = 'normalize' and (
          i.status = 'fetched'
          or (i.status = 'retry_wait' and i.retry_phase = 'normalize')
          or (i.status = 'published' and i.current_fetch_artifact_id is not null
            and (
              n.fetch_artifact_id is null
              or n.fetch_artifact_id <> i.current_fetch_artifact_id
              or (p_target_version is not null and n.parser_version || ':' || n.normalization_contract_version is distinct from p_target_version)
            ))
        ))
        or (p_phase = 'verify' and (
          i.status = 'normalized'
          or (i.status = 'retry_wait' and i.retry_phase = 'verify')
          or (i.status = 'published' and i.current_normalization_artifact_id is not null
            and i.current_normalization_artifact_id is distinct from i.verified_normalization_artifact_id)
        ))
        or (p_phase = 'publish' and (
          i.status = 'verified'
          or (i.status = 'retry_wait' and i.retry_phase = 'publish')
          or (i.status = 'published' and i.verified_normalization_artifact_id is not null
            and i.verified_normalization_artifact_id is distinct from i.published_normalization_artifact_id)
        ))
      )
    order by i.first_seen_at, i.id
    for update of i skip locked
    limit p_batch_limit
  ), updated as (
    update source_backfill_items i set
      status = case when p_phase = 'fetch' and i.status <> 'published' then 'fetching' else i.status end,
      attempt_count = i.attempt_count + 1,
      claimed_attempt_id = p_p1_attempt_id,
      claimed_fencing_token = p_p1_fencing_token,
      claimed_phase = p_phase,
      lease_expires_at = v_item_lease,
      retry_phase = null,
      error_code = null,
      error_summary = null,
      updated_at = now()
    from eligible e where i.id = e.id
    returning i.*
  ), events as (
    insert into source_backfill_item_events(item_id, attempt_id, event_type, phase, safe_details)
    select u.id, p_p1_attempt_id, 'item_claimed', p_phase,
      jsonb_build_object('leaseExpiresAt', v_item_lease, 'fencingToken', p_p1_fencing_token::text)
    from updated u
  )
  select
    u.id, u.stable_item_key, u.source_record_id, u.discovered_url, u.authority_url,
    u.document_type, u.discovered_decision_date_hint, u.status,
    u.current_fetch_artifact_id, u.current_normalization_artifact_id,
    u.verified_normalization_artifact_id, u.published_normalization_artifact_id,
    u.lease_expires_at
  from updated u order by u.first_seen_at, u.id;
end;
$function$;

create or replace function source_backfill_items_extend_v1(
  p_item_ids uuid[],
  p_phase text,
  p_p1_attempt_id uuid,
  p_p1_fencing_token bigint,
  p_requested_lease_seconds integer default 60
)
returns integer
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $function$
declare
  v_snapshot_id uuid;
  v_attempt_lease timestamptz;
  v_item_lease timestamptz;
  v_count integer;
begin
  if p_item_ids is null or cardinality(p_item_ids) not between 1 and 100
    or p_phase not in ('fetch', 'normalize', 'verify', 'publish')
    or p_requested_lease_seconds not between 1 and 86400
  then raise exception using errcode = '22023', message = 'CASE_BACKFILL_INVALID_EXTEND'; end if;
  if (select count(distinct i.snapshot_id) from source_backfill_items i where i.id = any(p_item_ids)) <> 1
    or (select count(*) from source_backfill_items i where i.id = any(p_item_ids)) <> cardinality(p_item_ids)
  then raise exception using errcode = '22023', message = 'CASE_BACKFILL_ITEM_SCOPE_MISMATCH'; end if;
  select i.snapshot_id into v_snapshot_id from source_backfill_items i where i.id = p_item_ids[1];
  select a.attempt_lease_expires_at into v_attempt_lease
  from source_backfill_assert_attempt_v1(p_p1_attempt_id, p_p1_fencing_token, v_snapshot_id, p_phase) a;
  v_item_lease := least(v_attempt_lease, now() + make_interval(secs => p_requested_lease_seconds));

  update source_backfill_items i set lease_expires_at = v_item_lease, updated_at = now()
  where i.id = any(p_item_ids)
    and i.claimed_attempt_id = p_p1_attempt_id
    and i.claimed_fencing_token = p_p1_fencing_token
    and i.claimed_phase = p_phase
    and i.lease_expires_at > now();
  get diagnostics v_count = row_count;
  if v_count <> cardinality(p_item_ids) then
    raise exception using errcode = '40001', message = 'CASE_BACKFILL_ITEM_LEASE_LOST';
  end if;
  insert into source_backfill_item_events(item_id, attempt_id, event_type, phase, safe_details)
  select unnest(p_item_ids), p_p1_attempt_id, 'item_lease_extended', p_phase, jsonb_build_object('leaseExpiresAt', v_item_lease);
  return v_count;
end;
$function$;

create or replace function source_backfill_fetch_artifact_record_v1(
  p_item_id uuid,
  p_p1_attempt_id uuid,
  p_p1_fencing_token bigint,
  p_source_policy_version text,
  p_authority_url text,
  p_http_status integer,
  p_response_headers jsonb,
  p_source_etag text,
  p_source_last_modified_at timestamptz,
  p_payload_hash text,
  p_payload_size bigint,
  p_replayability text,
  p_immutable_storage_ref text,
  p_bounded_replay_payload jsonb,
  p_fetch_contract_version text
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $function$
declare
  v_item source_backfill_items%rowtype;
  v_id uuid;
begin
  select i.* into v_item from source_backfill_items i where i.id = p_item_id for update;
  if not found then raise exception using errcode = 'P0001', message = 'CASE_BACKFILL_ITEM_NOT_FOUND'; end if;
  perform source_backfill_assert_attempt_v1(p_p1_attempt_id, p_p1_fencing_token, v_item.snapshot_id, 'fetch');
  if v_item.claimed_attempt_id <> p_p1_attempt_id or v_item.claimed_fencing_token <> p_p1_fencing_token
    or v_item.claimed_phase <> 'fetch' or v_item.lease_expires_at <= now()
  then raise exception using errcode = '40001', message = 'CASE_BACKFILL_ITEM_LEASE_LOST'; end if;

  insert into source_fetch_artifacts(
    item_id, source_policy_version, authority_url, http_status, response_headers_allowlist,
    source_etag, source_last_modified_at, payload_hash, payload_size, replayability,
    immutable_storage_ref, bounded_replay_payload, fetch_contract_version
  ) values (
    v_item.id, p_source_policy_version, p_authority_url, p_http_status, coalesce(p_response_headers, '{}'::jsonb),
    nullif(trim(p_source_etag), ''), p_source_last_modified_at, p_payload_hash, p_payload_size, p_replayability,
    nullif(trim(p_immutable_storage_ref), ''), p_bounded_replay_payload, p_fetch_contract_version
  )
  on conflict (item_id, payload_hash, fetch_contract_version) do nothing
  returning id into v_id;
  if v_id is null then
    select f.id into v_id from source_fetch_artifacts f
    where f.item_id = v_item.id and f.payload_hash = p_payload_hash and f.fetch_contract_version = p_fetch_contract_version;
  end if;

  insert into source_backfill_item_events(item_id, attempt_id, event_type, phase, safe_details)
  values (v_item.id, p_p1_attempt_id, 'fetch_recorded', 'fetch', jsonb_build_object('artifactId', v_id, 'payloadHash', p_payload_hash));
  return v_id;
end;
$function$;

create or replace function source_backfill_normalization_artifact_record_v1(
  p_item_id uuid,
  p_p1_attempt_id uuid,
  p_p1_fencing_token bigint,
  p_fetch_artifact_id uuid,
  p_parser_version text,
  p_normalization_contract_version text,
  p_normalized_output jsonb,
  p_normalized_output_hash text,
  p_validation_status text,
  p_validation_errors jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $function$
declare
  v_item source_backfill_items%rowtype;
  v_id uuid;
begin
  select i.* into v_item from source_backfill_items i where i.id = p_item_id for update;
  if not found then raise exception using errcode = 'P0001', message = 'CASE_BACKFILL_ITEM_NOT_FOUND'; end if;
  perform source_backfill_assert_attempt_v1(p_p1_attempt_id, p_p1_fencing_token, v_item.snapshot_id, 'normalize');
  if v_item.claimed_attempt_id <> p_p1_attempt_id or v_item.claimed_fencing_token <> p_p1_fencing_token
    or v_item.claimed_phase <> 'normalize' or v_item.lease_expires_at <= now()
    or v_item.current_fetch_artifact_id is distinct from p_fetch_artifact_id
  then raise exception using errcode = '40001', message = 'CASE_BACKFILL_ITEM_LEASE_LOST'; end if;

  insert into source_normalization_artifacts(
    item_id, fetch_artifact_id, parser_version, normalization_contract_version,
    normalized_output, normalized_output_hash, validation_status, validation_errors
  ) values (
    v_item.id, p_fetch_artifact_id, p_parser_version, p_normalization_contract_version,
    p_normalized_output, p_normalized_output_hash, p_validation_status, coalesce(p_validation_errors, '[]'::jsonb)
  )
  on conflict (fetch_artifact_id, parser_version, normalization_contract_version) do nothing
  returning id into v_id;
  if v_id is null then
    select n.id into v_id from source_normalization_artifacts n
    where n.fetch_artifact_id = p_fetch_artifact_id and n.parser_version = p_parser_version
      and n.normalization_contract_version = p_normalization_contract_version;
  end if;

  insert into source_backfill_item_events(item_id, attempt_id, event_type, phase, safe_details)
  values (v_item.id, p_p1_attempt_id, 'normalization_recorded', 'normalize',
    jsonb_build_object('artifactId', v_id, 'normalizedOutputHash', p_normalized_output_hash, 'validationStatus', p_validation_status));
  return v_id;
end;
$function$;

create or replace function source_backfill_item_complete_v1(
  p_item_id uuid,
  p_phase text,
  p_p1_attempt_id uuid,
  p_p1_fencing_token bigint,
  p_next_status text,
  p_result_metadata jsonb default '{}'::jsonb
)
returns table(item_id uuid, resolution_status text, work_state text)
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $function$
declare
  v_item source_backfill_items%rowtype;
  v_artifact_id uuid;
  v_noop boolean;
  v_work_state text;
begin
  if jsonb_typeof(coalesce(p_result_metadata, '{}'::jsonb)) <> 'object'
    or pg_column_size(coalesce(p_result_metadata, '{}'::jsonb)) > 16384
  then raise exception using errcode = '22023', message = 'CASE_BACKFILL_INVALID_RESULT'; end if;
  select i.* into v_item from source_backfill_items i where i.id = p_item_id for update;
  if not found then raise exception using errcode = 'P0001', message = 'CASE_BACKFILL_ITEM_NOT_FOUND'; end if;
  perform source_backfill_assert_attempt_v1(p_p1_attempt_id, p_p1_fencing_token, v_item.snapshot_id, p_phase);
  if v_item.claimed_attempt_id <> p_p1_attempt_id or v_item.claimed_fencing_token <> p_p1_fencing_token
    or v_item.claimed_phase <> p_phase or v_item.lease_expires_at <= now()
  then raise exception using errcode = '40001', message = 'CASE_BACKFILL_ITEM_LEASE_LOST'; end if;

  begin v_artifact_id := nullif(p_result_metadata->>'artifactId', '')::uuid;
  exception when invalid_text_representation then
    raise exception using errcode = '22023', message = 'CASE_BACKFILL_INVALID_ARTIFACT';
  end;
  v_noop := case p_result_metadata->>'noop' when 'true' then true when 'false' then false else false end;

  if p_phase = 'fetch' then
    if v_artifact_id is null or not exists(select 1 from source_fetch_artifacts f where f.id = v_artifact_id and f.item_id = v_item.id)
      or p_next_status <> (case when v_item.status = 'published' then 'published' else 'fetched' end)
    then raise exception using errcode = '22023', message = 'CASE_BACKFILL_INVALID_FETCH_TRANSITION'; end if;
    update source_backfill_items i set
      status = p_next_status, current_fetch_artifact_id = v_artifact_id,
      http_status = (select f.http_status from source_fetch_artifacts f where f.id = v_artifact_id),
      source_etag = (select f.source_etag from source_fetch_artifacts f where f.id = v_artifact_id),
      source_last_modified_at = (select f.source_last_modified_at from source_fetch_artifacts f where f.id = v_artifact_id),
      payload_hash = (select f.payload_hash from source_fetch_artifacts f where f.id = v_artifact_id),
      authority_url = (select f.authority_url from source_fetch_artifacts f where f.id = v_artifact_id)
    where i.id = v_item.id;
  elsif p_phase = 'normalize' then
    if v_artifact_id is null or not exists(
      select 1 from source_normalization_artifacts n
      where n.id = v_artifact_id and n.item_id = v_item.id and n.validation_status = 'valid'
    ) or p_next_status <> (case when v_item.status = 'published' then 'published' else 'normalized' end)
    then raise exception using errcode = '22023', message = 'CASE_BACKFILL_INVALID_NORMALIZE_TRANSITION'; end if;
    update source_backfill_items i set
      status = p_next_status, current_normalization_artifact_id = v_artifact_id,
      parser_version = (select n.parser_version from source_normalization_artifacts n where n.id = v_artifact_id)
    where i.id = v_item.id;
  elsif p_phase = 'verify' then
    if v_artifact_id is null or v_artifact_id is distinct from v_item.current_normalization_artifact_id
      or p_next_status <> (case when v_item.status = 'published' then 'published' else 'verified' end)
    then raise exception using errcode = '22023', message = 'CASE_BACKFILL_INVALID_VERIFY_TRANSITION'; end if;
    if v_noop and (
      v_item.status <> 'published'
      or v_item.published_normalization_artifact_id is null
      or not exists (
        select 1
        from source_normalization_artifacts current_artifact
        join source_normalization_artifacts published_artifact
          on published_artifact.id = v_item.published_normalization_artifact_id
        where current_artifact.id = v_artifact_id
          and current_artifact.item_id = v_item.id
          and published_artifact.item_id = v_item.id
          and current_artifact.normalized_output_hash = published_artifact.normalized_output_hash
      )
    ) then
      raise exception using errcode = '22023', message = 'CASE_BACKFILL_INVALID_VERIFICATION_NOOP';
    end if;
    update source_backfill_items i set
      status = p_next_status,
      verified_normalization_artifact_id = v_artifact_id,
      published_normalization_artifact_id = case when v_item.status = 'published' and v_noop then v_artifact_id else i.published_normalization_artifact_id end
    where i.id = v_item.id;
    if v_item.status = 'published' and v_noop then
      insert into source_backfill_item_events(item_id, attempt_id, event_type, phase, safe_details)
      values (v_item.id, p_p1_attempt_id, 'verification_noop', 'verify', jsonb_build_object('artifactId', v_artifact_id));
    end if;
  elsif p_phase = 'publish' then
    if v_artifact_id is null or v_artifact_id is distinct from v_item.verified_normalization_artifact_id
      or p_next_status <> 'published'
    then raise exception using errcode = '22023', message = 'CASE_BACKFILL_INVALID_PUBLISH_TRANSITION'; end if;
    update source_backfill_items i set status = 'published', published_normalization_artifact_id = v_artifact_id where i.id = v_item.id;
  else
    raise exception using errcode = '22023', message = 'CASE_BACKFILL_INVALID_PHASE';
  end if;

  update source_backfill_items i set
    claimed_attempt_id = null, claimed_fencing_token = null, claimed_phase = null, lease_expires_at = null,
    next_attempt_at = null, retry_phase = null, error_code = null, error_summary = null, updated_at = now()
  where i.id = v_item.id returning i.* into v_item;

  v_work_state := case
    when v_item.current_fetch_artifact_id is not null and (
      v_item.current_normalization_artifact_id is null or not exists(
        select 1 from source_normalization_artifacts n
        where n.id = v_item.current_normalization_artifact_id and n.fetch_artifact_id = v_item.current_fetch_artifact_id
      )
    ) then 'needs_normalize'
    when v_item.current_normalization_artifact_id is not null
      and v_item.current_normalization_artifact_id is distinct from v_item.verified_normalization_artifact_id then 'needs_reverify'
    when v_item.status = 'published' and v_item.verified_normalization_artifact_id is not null
      and v_item.verified_normalization_artifact_id is distinct from v_item.published_normalization_artifact_id then 'needs_republish'
    when v_item.status in ('terminal_failure', 'waived_failure') then 'failed'
    else 'idle'
  end;
  insert into source_backfill_item_events(item_id, attempt_id, event_type, phase, safe_details)
  values (v_item.id, p_p1_attempt_id, 'item_completed', p_phase,
    jsonb_build_object('status', v_item.status, 'workState', v_work_state));
  return query select v_item.id, v_item.status, v_work_state;
end;
$function$;

create or replace function source_backfill_item_fail_v1(
  p_item_id uuid,
  p_phase text,
  p_p1_attempt_id uuid,
  p_p1_fencing_token bigint,
  p_disposition text,
  p_error_code text,
  p_error_summary text,
  p_retry_at timestamptz default null
)
returns table(item_id uuid, resolution_status text, next_attempt_at timestamptz)
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $function$
declare
  v_item source_backfill_items%rowtype;
begin
  if p_disposition not in ('retryable', 'terminal') or p_error_code is null
    or length(trim(p_error_code)) not between 1 and 160
    or (p_disposition = 'retryable' and p_retry_at is null)
  then raise exception using errcode = '22023', message = 'CASE_BACKFILL_INVALID_FAILURE'; end if;
  select i.* into v_item from source_backfill_items i where i.id = p_item_id for update;
  if not found then raise exception using errcode = 'P0001', message = 'CASE_BACKFILL_ITEM_NOT_FOUND'; end if;
  perform source_backfill_assert_attempt_v1(p_p1_attempt_id, p_p1_fencing_token, v_item.snapshot_id, p_phase);
  if v_item.claimed_attempt_id <> p_p1_attempt_id or v_item.claimed_fencing_token <> p_p1_fencing_token
    or v_item.claimed_phase <> p_phase or v_item.lease_expires_at <= now()
  then raise exception using errcode = '40001', message = 'CASE_BACKFILL_ITEM_LEASE_LOST'; end if;

  update source_backfill_items i set
    status = case
      when i.status = 'published' then 'published'
      when p_disposition = 'retryable' then 'retry_wait'
      else 'terminal_failure'
    end,
    next_attempt_at = case when p_disposition = 'retryable' then p_retry_at else null end,
    retry_phase = case when p_disposition = 'retryable' then p_phase else null end,
    error_code = left(trim(p_error_code), 160),
    error_summary = left(nullif(trim(p_error_summary), ''), 500),
    claimed_attempt_id = null, claimed_fencing_token = null, claimed_phase = null, lease_expires_at = null,
    updated_at = now()
  where i.id = v_item.id returning i.* into v_item;

  insert into source_backfill_item_events(item_id, attempt_id, event_type, phase, safe_details)
  values (v_item.id, p_p1_attempt_id, 'item_failed', p_phase,
    jsonb_build_object('disposition', p_disposition, 'errorCode', p_error_code));
  return query select v_item.id, v_item.status, v_item.next_attempt_at;
end;
$function$;

create or replace function source_backfill_phase_backlog_count_v1(
  p_snapshot_id uuid,
  p_phase text,
  p_target_version text default null
)
returns bigint
language sql
stable
security definer
set search_path = public, extensions, pg_temp
as $function$
  select count(*)
  from source_backfill_items i
  left join source_fetch_artifacts f on f.id = i.current_fetch_artifact_id
  left join source_normalization_artifacts n on n.id = i.current_normalization_artifact_id
  where i.snapshot_id = p_snapshot_id
    and (i.next_attempt_at is null or i.next_attempt_at <= now())
    and (
      (p_phase = 'fetch' and (
        i.status in ('discovered', 'queued')
        or (i.status = 'retry_wait' and i.retry_phase = 'fetch')
        or (i.status = 'published' and p_target_version is not null and f.fetch_contract_version is distinct from p_target_version)
      ))
      or (p_phase = 'normalize' and (
        i.status = 'fetched'
        or (i.status = 'retry_wait' and i.retry_phase = 'normalize')
        or (i.status = 'published' and i.current_fetch_artifact_id is not null
          and (
            n.fetch_artifact_id is null
            or n.fetch_artifact_id <> i.current_fetch_artifact_id
            or (p_target_version is not null and n.parser_version || ':' || n.normalization_contract_version is distinct from p_target_version)
          ))
      ))
      or (p_phase = 'verify' and (
        i.status = 'normalized'
        or (i.status = 'retry_wait' and i.retry_phase = 'verify')
        or (i.status = 'published' and i.current_normalization_artifact_id is not null
          and i.current_normalization_artifact_id is distinct from i.verified_normalization_artifact_id)
      ))
      or (p_phase = 'publish' and (
        i.status = 'verified'
        or (i.status = 'retry_wait' and i.retry_phase = 'publish')
        or (i.status = 'published' and i.verified_normalization_artifact_id is not null
          and i.verified_normalization_artifact_id is distinct from i.published_normalization_artifact_id)
      ))
    );
$function$;

create or replace function source_backfill_run_finish_v1(
  p_run_id uuid,
  p_p1_attempt_id uuid,
  p_p1_fencing_token bigint,
  p_status text,
  p_claimed_count integer,
  p_succeeded_count integer,
  p_retryable_failed_count integer,
  p_terminal_failed_count integer,
  p_last_error_code text default null,
  p_last_error_summary text default null
)
returns boolean
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $function$
declare
  v_run source_backfill_runs%rowtype;
begin
  if p_status not in ('succeeded', 'degraded', 'failed', 'aborted')
    or least(p_claimed_count, p_succeeded_count, p_retryable_failed_count, p_terminal_failed_count) < 0
    or p_claimed_count <> p_succeeded_count + p_retryable_failed_count + p_terminal_failed_count
  then raise exception using errcode = '22023', message = 'CASE_BACKFILL_INVALID_RUN_RESULT'; end if;
  select r.* into v_run from source_backfill_runs r where r.id = p_run_id for update;
  if not found then raise exception using errcode = 'P0001', message = 'CASE_BACKFILL_RUN_NOT_FOUND'; end if;
  if v_run.p1_attempt_id is distinct from p_p1_attempt_id
    or v_run.p1_fencing_token is distinct from p_p1_fencing_token
    or v_run.status <> 'running'
  then raise exception using errcode = '40001', message = 'CASE_BACKFILL_RUN_FENCE_LOST'; end if;
  perform source_backfill_assert_attempt_v1(
    p_p1_attempt_id, p_p1_fencing_token, v_run.snapshot_id, v_run.phase
  );
  if exists(select 1 from source_backfill_items i where i.claimed_attempt_id = p_p1_attempt_id) then
    raise exception using errcode = '55000', message = 'CASE_BACKFILL_ACTIVE_ITEM_CLAIMS';
  end if;
  update source_backfill_runs r set
    status = p_status,
    claimed_count = p_claimed_count,
    succeeded_count = p_succeeded_count,
    retryable_failed_count = p_retryable_failed_count,
    terminal_failed_count = p_terminal_failed_count,
    heartbeat_at = now(),
    completed_at = now(),
    last_error_code = left(nullif(trim(p_last_error_code), ''), 160),
    last_error_summary = left(nullif(trim(p_last_error_summary), ''), 500)
  where r.id = v_run.id;
  return true;
end;
$function$;

create or replace function source_backfill_release_claims_on_attempt_terminal_v1()
returns trigger
language plpgsql
set search_path = public, extensions, pg_temp
as $function$
declare
  v_claim_count integer;
begin
  if old.status = 'running' and new.status <> 'running' then
    select count(*)::integer into v_claim_count from source_backfill_items i where i.claimed_attempt_id = old.id;
    if new.status = 'succeeded' and v_claim_count > 0 then
      raise exception using errcode = '55000', message = 'CASE_BACKFILL_ACTIVE_ITEM_CLAIMS';
    end if;
    if new.status = 'succeeded' and exists(
      select 1 from source_backfill_runs r where r.p1_attempt_id = old.id and r.status = 'running'
    ) then
      raise exception using errcode = '55000', message = 'CASE_BACKFILL_ACTIVE_RUN';
    end if;
    if new.status in ('failed', 'aborted', 'lease_expired') and v_claim_count > 0 then
      insert into source_backfill_item_events(item_id, attempt_id, event_type, phase, safe_details)
      select i.id, old.id, 'claim_released', i.claimed_phase,
        jsonb_build_object('attemptStatus', new.status, 'errorCode', coalesce(new.error_code, new.status))
      from source_backfill_items i where i.claimed_attempt_id = old.id;
      update source_backfill_items i set
        status = case when i.status in ('published', 'excluded', 'duplicate', 'withdrawn', 'waived_failure') then i.status else 'retry_wait' end,
        next_attempt_at = case when i.status in ('published', 'excluded', 'duplicate', 'withdrawn', 'waived_failure') then i.next_attempt_at else now() end,
        retry_phase = case when i.status in ('published', 'excluded', 'duplicate', 'withdrawn', 'waived_failure') then i.retry_phase else i.claimed_phase end,
        error_code = coalesce(new.error_code, 'attempt.' || new.status),
        error_summary = left(coalesce(new.error_message, 'P1 attempt ended before item terminalization.'), 500),
        claimed_attempt_id = null, claimed_fencing_token = null, claimed_phase = null, lease_expires_at = null,
        updated_at = now()
      where i.claimed_attempt_id = old.id;
    end if;
    if new.status in ('failed', 'aborted', 'lease_expired') then
      update source_backfill_runs r set
        status = case when new.status = 'aborted' then 'aborted' else 'failed' end,
        heartbeat_at = now(),
        completed_at = now(),
        last_error_code = left(coalesce(new.error_code, 'attempt.' || new.status), 160),
        last_error_summary = left(coalesce(new.error_message, 'P1 attempt ended before backfill run terminalization.'), 500)
      where r.p1_attempt_id = old.id and r.status = 'running';
    end if;
  end if;
  return new;
end;
$function$;

drop trigger if exists admin_command_attempts_case_backfill_release_trigger on admin_command_attempts;
create trigger admin_command_attempts_case_backfill_release_trigger
before update of status on admin_command_attempts
for each row execute function source_backfill_release_claims_on_attempt_terminal_v1();

create or replace view source_backfill_item_work_v1
with (security_barrier = true)
as
select
  i.*,
  (i.current_fetch_artifact_id is not null and (
    i.current_normalization_artifact_id is null or n.fetch_artifact_id is distinct from i.current_fetch_artifact_id
  )) as needs_renormalize,
  (i.current_normalization_artifact_id is not null
    and i.current_normalization_artifact_id is distinct from i.verified_normalization_artifact_id) as needs_reverify,
  (i.status = 'published' and i.verified_normalization_artifact_id is not null
    and i.verified_normalization_artifact_id is distinct from i.published_normalization_artifact_id) as needs_republish,
  case
    when i.claimed_attempt_id is not null and i.lease_expires_at > now() then 'claimed'
    when i.status = 'retry_wait' or (i.retry_phase is not null and i.next_attempt_at is not null) then 'retry_wait'
    when i.current_fetch_artifact_id is not null and (
      i.current_normalization_artifact_id is null or n.fetch_artifact_id is distinct from i.current_fetch_artifact_id
    ) then 'needs_normalize'
    when i.current_normalization_artifact_id is not null
      and i.current_normalization_artifact_id is distinct from i.verified_normalization_artifact_id then 'needs_reverify'
    when i.status = 'published' and i.verified_normalization_artifact_id is not null
      and i.verified_normalization_artifact_id is distinct from i.published_normalization_artifact_id then 'needs_republish'
    when i.status in ('terminal_failure', 'waived_failure') then 'failed'
    else 'idle'
  end as work_state
from source_backfill_items i
left join source_normalization_artifacts n on n.id = i.current_normalization_artifact_id;

create or replace function source_backfill_snapshot_status_v1(p_snapshot_id uuid)
returns table(
  snapshot_id uuid,
  source_key text,
  snapshot_status text,
  discovered_total bigint,
  terminal_total bigint,
  processing_completion numeric,
  expected_count integer,
  coverage_assurance text,
  corpus_coverage numeric,
  claimed bigint,
  retry_wait bigint,
  needs_normalize bigint,
  needs_reverify bigint,
  needs_republish bigint,
  failed bigint,
  current_conformant bigint,
  current_conformance numeric,
  manifest_hash text
)
language sql
stable
security definer
set search_path = public, extensions, pg_temp
as $function$
  select
    s.id,
    s.source_key,
    s.status,
    count(w.id),
    count(w.id) filter (where w.status in ('published', 'excluded', 'duplicate', 'withdrawn', 'waived_failure')),
    case when count(w.id) = 0 then 0 else
      round((count(w.id) filter (where w.status in ('published', 'excluded', 'duplicate', 'withdrawn', 'waived_failure')))::numeric / count(w.id), 6)
    end,
    s.expected_count,
    s.coverage_assurance,
    case when s.expected_count is null or s.expected_count = 0 then null else round(count(w.id)::numeric / s.expected_count, 6) end,
    count(w.id) filter (where w.work_state = 'claimed'),
    count(w.id) filter (where w.work_state = 'retry_wait'),
    count(w.id) filter (where w.work_state = 'needs_normalize'),
    count(w.id) filter (where w.work_state = 'needs_reverify'),
    count(w.id) filter (where w.work_state = 'needs_republish'),
    count(w.id) filter (where w.work_state = 'failed'),
    count(w.id) filter (
      where w.status in ('published', 'excluded', 'duplicate', 'withdrawn', 'waived_failure')
        and not w.needs_renormalize and not w.needs_reverify and not w.needs_republish
        and (w.status <> 'published' or (
          n.parser_version = s.parser_version and f.source_policy_version = s.source_policy_version
        ))
    ),
    case when count(w.id) filter (where w.status in ('published', 'excluded', 'duplicate', 'withdrawn', 'waived_failure')) = 0 then 0
      else round(
        (count(w.id) filter (
          where w.status in ('published', 'excluded', 'duplicate', 'withdrawn', 'waived_failure')
            and not w.needs_renormalize and not w.needs_reverify and not w.needs_republish
            and (w.status <> 'published' or (
              n.parser_version = s.parser_version and f.source_policy_version = s.source_policy_version
            ))
        ))::numeric
        / (count(w.id) filter (where w.status in ('published', 'excluded', 'duplicate', 'withdrawn', 'waived_failure'))),
        6
      )
    end,
    s.manifest_hash
  from source_inventory_snapshots s
  left join source_backfill_item_work_v1 w on w.snapshot_id = s.id
  left join source_normalization_artifacts n on n.id = w.published_normalization_artifact_id
  left join source_fetch_artifacts f on f.id = n.fetch_artifact_id
  where s.id = p_snapshot_id
  group by s.id;
$function$;

alter table source_corpus_policies enable row level security;
alter table source_inventory_snapshots enable row level security;
alter table source_backfill_runs enable row level security;
alter table source_backfill_items enable row level security;
alter table source_fetch_artifacts enable row level security;
alter table source_normalization_artifacts enable row level security;
alter table source_backfill_item_events enable row level security;

revoke all on table source_corpus_policies, source_inventory_snapshots, source_backfill_runs,
  source_backfill_items, source_fetch_artifacts, source_normalization_artifacts, source_backfill_item_events from public;
revoke all on source_backfill_item_work_v1 from public;
revoke all on function source_inventory_snapshot_open_v1(text, date, date, text, text, text, text, text, integer, text, jsonb, jsonb, text) from public;
revoke all on function source_inventory_item_upsert_v1(uuid, text, text, text, text, date) from public;
revoke all on function source_inventory_snapshot_close_v1(uuid) from public;
revoke all on function source_inventory_snapshot_evidence_v1(uuid, jsonb) from public;
revoke all on function source_backfill_assert_attempt_v1(uuid, bigint, uuid, text) from public;
revoke all on function source_backfill_run_begin_v1(uuid, text, integer, uuid, bigint) from public;
revoke all on function source_backfill_pass_allocate_v1(uuid, text) from public;
revoke all on function source_backfill_items_claim_v1(uuid, text, integer, uuid, bigint, integer, text) from public;
revoke all on function source_backfill_items_extend_v1(uuid[], text, uuid, bigint, integer) from public;
revoke all on function source_backfill_fetch_artifact_record_v1(uuid, uuid, bigint, text, text, integer, jsonb, text, timestamptz, text, bigint, text, text, jsonb, text) from public;
revoke all on function source_backfill_normalization_artifact_record_v1(uuid, uuid, bigint, uuid, text, text, jsonb, text, text, jsonb) from public;
revoke all on function source_backfill_item_complete_v1(uuid, text, uuid, bigint, text, jsonb) from public;
revoke all on function source_backfill_item_fail_v1(uuid, text, uuid, bigint, text, text, text, timestamptz) from public;
revoke all on function source_backfill_phase_backlog_count_v1(uuid, text, text) from public;
revoke all on function source_backfill_run_finish_v1(uuid, uuid, bigint, text, integer, integer, integer, integer, text, text) from public;
revoke all on function source_backfill_snapshot_status_v1(uuid) from public;

do $permissions$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on table source_corpus_policies, source_inventory_snapshots, source_backfill_runs,
      source_backfill_items, source_fetch_artifacts, source_normalization_artifacts, source_backfill_item_events from anon;
    revoke all on source_backfill_item_work_v1 from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on table source_corpus_policies, source_inventory_snapshots, source_backfill_runs,
      source_backfill_items, source_fetch_artifacts, source_normalization_artifacts, source_backfill_item_events from authenticated;
    revoke all on source_backfill_item_work_v1 from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, insert on table source_corpus_policies to service_role;
    grant select on table source_inventory_snapshots, source_backfill_runs, source_backfill_items,
      source_fetch_artifacts, source_normalization_artifacts, source_backfill_item_events to service_role;
    grant select on source_backfill_item_work_v1 to service_role;
    grant execute on function source_inventory_snapshot_open_v1(text, date, date, text, text, text, text, text, integer, text, jsonb, jsonb, text) to service_role;
    grant execute on function source_inventory_item_upsert_v1(uuid, text, text, text, text, date) to service_role;
    grant execute on function source_inventory_snapshot_close_v1(uuid) to service_role;
    grant execute on function source_inventory_snapshot_evidence_v1(uuid, jsonb) to service_role;
    grant execute on function source_backfill_run_begin_v1(uuid, text, integer, uuid, bigint) to service_role;
    grant execute on function source_backfill_pass_allocate_v1(uuid, text) to service_role;
    grant execute on function source_backfill_items_claim_v1(uuid, text, integer, uuid, bigint, integer, text) to service_role;
    grant execute on function source_backfill_items_extend_v1(uuid[], text, uuid, bigint, integer) to service_role;
    grant execute on function source_backfill_fetch_artifact_record_v1(uuid, uuid, bigint, text, text, integer, jsonb, text, timestamptz, text, bigint, text, text, jsonb, text) to service_role;
    grant execute on function source_backfill_normalization_artifact_record_v1(uuid, uuid, bigint, uuid, text, text, jsonb, text, text, jsonb) to service_role;
    grant execute on function source_backfill_item_complete_v1(uuid, text, uuid, bigint, text, jsonb) to service_role;
    grant execute on function source_backfill_item_fail_v1(uuid, text, uuid, bigint, text, text, text, timestamptz) to service_role;
    grant execute on function source_backfill_phase_backlog_count_v1(uuid, text, text) to service_role;
    grant execute on function source_backfill_run_finish_v1(uuid, uuid, bigint, text, integer, integer, integer, integer, text, text) to service_role;
    grant execute on function source_backfill_snapshot_status_v1(uuid) to service_role;
  end if;
end;
$permissions$;

comment on table source_corpus_policies is 'Immutable reviewed source policy versions for constitutional-case corpus collection.';
comment on table source_inventory_snapshots is 'Closed, hash-addressed official source inventories; processing state is stored separately on items.';
comment on table source_backfill_items is 'Durable item ledger whose publication outcome survives maintenance reprocessing.';
comment on table source_fetch_artifacts is 'Append-only policy-bounded fetch evidence for network-free replay when permitted.';
comment on table source_normalization_artifacts is 'Append-only parser outputs tied to an exact fetch artifact and parser contract.';
commit;
