begin;

create table if not exists source_inventory_enumeration_artifacts (
  id uuid primary key default gen_random_uuid(),
  snapshot_id uuid not null references source_inventory_snapshots(id) on delete restrict,
  source_key text not null,
  provider_key text not null,
  artifact_kind text not null,
  sequence_no integer not null,
  request_url text not null,
  response_hash text not null,
  record_manifest_hash text not null,
  record_count integer not null,
  newest_decision_date date,
  oldest_decision_date date,
  observed_last_page integer,
  safe_details jsonb not null default '{}'::jsonb,
  observed_at timestamptz not null default now(),
  unique (snapshot_id, provider_key, artifact_kind, sequence_no),
  constraint source_inventory_enumeration_artifacts_provider_check check (
    provider_key = lower(trim(provider_key))
    and provider_key ~ '^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$'
    and provider_key not like '%..%'
  ),
  constraint source_inventory_enumeration_artifacts_kind_check check (
    artifact_kind in ('page', 'boundary_probe', 'crosscheck')
  ),
  constraint source_inventory_enumeration_artifacts_sequence_check check (sequence_no between 1 and 2147483647),
  constraint source_inventory_enumeration_artifacts_url_check check (
    request_url ~ '^https://[a-z0-9.-]+(?::[0-9]{1,5})?(?:/|$)'
    and length(request_url) <= 1000
  ),
  constraint source_inventory_enumeration_artifacts_hash_check check (
    response_hash ~ '^[0-9a-f]{64}$' and record_manifest_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint source_inventory_enumeration_artifacts_count_check check (
    record_count between 0 and 100000
    and (observed_last_page is null or observed_last_page between 1 and 100000)
  ),
  constraint source_inventory_enumeration_artifacts_date_check check (
    oldest_decision_date is null or newest_decision_date is null or oldest_decision_date <= newest_decision_date
  ),
  constraint source_inventory_enumeration_artifacts_details_check check (
    jsonb_typeof(safe_details) = 'object'
    and pg_column_size(safe_details) <= 16384
    and not case_backfill_inventory_json_has_secret_v1(safe_details)
  )
);

alter table source_inventory_snapshots
  add column if not exists enumeration_manifest_hash text;

alter table source_inventory_snapshots
  drop constraint if exists source_inventory_snapshots_enumeration_manifest_hash_check;
alter table source_inventory_snapshots
  add constraint source_inventory_snapshots_enumeration_manifest_hash_check check (
    enumeration_manifest_hash is null or enumeration_manifest_hash ~ '^[0-9a-f]{64}$'
  );

create or replace function source_inventory_enumeration_artifact_guard_v1()
returns trigger
language plpgsql
set search_path = public, extensions, pg_temp
as $function$
declare
  v_status text;
begin
  if tg_op <> 'INSERT' then
    raise exception using errcode = '55000', message = 'CASE_BACKFILL_ENUMERATION_ARTIFACT_IMMUTABLE';
  end if;
  select s.status into v_status from source_inventory_snapshots s where s.id = new.snapshot_id;
  if not found then raise exception using errcode = '23503', message = 'CASE_BACKFILL_SNAPSHOT_NOT_FOUND'; end if;
  if v_status <> 'open' then
    raise exception using errcode = '55000', message = 'CASE_BACKFILL_MANIFEST_CLOSED';
  end if;
  return new;
end;
$function$;

drop trigger if exists source_inventory_enumeration_artifact_guard_trigger
  on source_inventory_enumeration_artifacts;
create trigger source_inventory_enumeration_artifact_guard_trigger
before insert or update or delete on source_inventory_enumeration_artifacts
for each row execute function source_inventory_enumeration_artifact_guard_v1();

create or replace function source_inventory_enumeration_artifact_record_v1(
  p_snapshot_id uuid,
  p_p1_attempt_id uuid,
  p_p1_fencing_token bigint,
  p_provider_key text,
  p_artifact_kind text,
  p_sequence_no integer,
  p_request_url text,
  p_response_hash text,
  p_record_manifest_hash text,
  p_record_count integer,
  p_newest_decision_date date,
  p_oldest_decision_date date,
  p_observed_last_page integer,
  p_safe_details jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $function$
declare
  v_snapshot source_inventory_snapshots%rowtype;
  v_policy source_corpus_policies%rowtype;
  v_request_host text;
  v_id uuid;
  v_existing source_inventory_enumeration_artifacts%rowtype;
begin
  perform source_backfill_assert_attempt_v1(
    p_p1_attempt_id, p_p1_fencing_token, p_snapshot_id, 'discover'
  );
  select s.* into v_snapshot from source_inventory_snapshots s where s.id = p_snapshot_id for update;
  if not found then raise exception using errcode = 'P0001', message = 'CASE_BACKFILL_SNAPSHOT_NOT_FOUND'; end if;
  if v_snapshot.status <> 'open' then
    raise exception using errcode = '55000', message = 'CASE_BACKFILL_MANIFEST_CLOSED';
  end if;
  select p.* into v_policy from source_corpus_policies p
  where p.source_key = v_snapshot.source_key and p.policy_version = v_snapshot.source_policy_version;
  if not found then raise exception using errcode = '23503', message = 'CASE_BACKFILL_POLICY_NOT_FOUND'; end if;

  v_request_host := split_part(split_part(lower(trim(p_request_url)), '://', 2), '/', 1);
  v_request_host := split_part(v_request_host, ':', 1);
  if lower(trim(p_provider_key)) is distinct from v_request_host
    or not source_policy_request_host_allowed_v1(
      v_policy.authority_hosts,
      v_policy.redirect_hosts,
      v_policy.external_index_hosts,
      'discover',
      v_request_host
    )
  then
    raise exception using errcode = '42501', message = 'CASE_BACKFILL_ENUMERATION_HOST_NOT_ALLOWED';
  end if;

  insert into source_inventory_enumeration_artifacts(
    snapshot_id, source_key, provider_key, artifact_kind, sequence_no,
    request_url, response_hash, record_manifest_hash, record_count,
    newest_decision_date, oldest_decision_date, observed_last_page, safe_details
  ) values (
    v_snapshot.id, v_snapshot.source_key, lower(trim(p_provider_key)), p_artifact_kind, p_sequence_no,
    trim(p_request_url), p_response_hash, p_record_manifest_hash, p_record_count,
    p_newest_decision_date, p_oldest_decision_date, p_observed_last_page,
    coalesce(p_safe_details, '{}'::jsonb)
  )
  on conflict (snapshot_id, provider_key, artifact_kind, sequence_no) do nothing
  returning id into v_id;

  if v_id is null then
    select a.* into v_existing from source_inventory_enumeration_artifacts a
    where a.snapshot_id = v_snapshot.id
      and a.provider_key = lower(trim(p_provider_key))
      and a.artifact_kind = p_artifact_kind
      and a.sequence_no = p_sequence_no;
    if v_existing.request_url is distinct from trim(p_request_url)
      or v_existing.response_hash is distinct from p_response_hash
      or v_existing.record_manifest_hash is distinct from p_record_manifest_hash
      or v_existing.record_count is distinct from p_record_count
      or v_existing.newest_decision_date is distinct from p_newest_decision_date
      or v_existing.oldest_decision_date is distinct from p_oldest_decision_date
      or v_existing.observed_last_page is distinct from p_observed_last_page
      or v_existing.safe_details is distinct from coalesce(p_safe_details, '{}'::jsonb)
    then
      raise exception using errcode = '23505', message = 'CASE_BACKFILL_ENUMERATION_ARTIFACT_CONFLICT';
    end if;
    v_id := v_existing.id;
  end if;
  return v_id;
end;
$function$;

create or replace function source_inventory_snapshot_close_v3(p_snapshot_id uuid)
returns table(
  snapshot_id uuid,
  discovered_count integer,
  expected_count integer,
  manifest_hash text,
  enumeration_manifest_hash text,
  coverage_assurance text
)
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $function$
declare
  v_snapshot source_inventory_snapshots%rowtype;
  v_count integer;
  v_item_hash text;
  v_enumeration_count integer;
  v_enumeration_hash text;
  v_hash text;
begin
  select s.* into v_snapshot from source_inventory_snapshots s where s.id = p_snapshot_id for update;
  if not found then raise exception using errcode = 'P0001', message = 'CASE_BACKFILL_SNAPSHOT_NOT_FOUND'; end if;
  if v_snapshot.status = 'closed' then
    return query select
      v_snapshot.id, v_snapshot.discovered_count, v_snapshot.expected_count,
      v_snapshot.manifest_hash, v_snapshot.enumeration_manifest_hash, v_snapshot.coverage_assurance;
    return;
  end if;
  if v_snapshot.status <> 'open' then raise exception using errcode = '55000', message = 'CASE_BACKFILL_SNAPSHOT_NOT_OPEN'; end if;

  select count(*)::integer,
    encode(extensions.digest(convert_to(coalesce(string_agg(
      jsonb_build_array(
        i.stable_item_key, i.source_record_id, i.discovered_url, i.document_type,
        i.discovered_decision_date_hint, i.inventory_metadata
      )::text, E'\n' order by i.stable_item_key
    ), ''), 'UTF8'), 'sha256'), 'hex')
  into v_count, v_item_hash
  from source_backfill_items i where i.snapshot_id = v_snapshot.id;

  select count(*)::integer,
    case when count(*) = 0 then null else encode(extensions.digest(convert_to(string_agg(
      jsonb_build_array(
        a.provider_key, a.artifact_kind, a.sequence_no, a.request_url,
        a.response_hash, a.record_manifest_hash, a.record_count,
        a.newest_decision_date, a.oldest_decision_date, a.observed_last_page, a.safe_details
      )::text, E'\n' order by a.provider_key, a.artifact_kind, a.sequence_no
    ), 'UTF8'), 'sha256'), 'hex') end
  into v_enumeration_count, v_enumeration_hash
  from source_inventory_enumeration_artifacts a where a.snapshot_id = v_snapshot.id;

  if v_snapshot.expected_count is not null and v_snapshot.expected_count <> v_count then
    raise exception using errcode = '23514', message = 'CASE_BACKFILL_EXPECTED_COUNT_MISMATCH';
  end if;
  if v_snapshot.coverage_assurance in ('authoritative_enumerated', 'authoritative_counted', 'authoritative_crosschecked')
    and v_snapshot.coverage_evidence = '{}'::jsonb
  then
    raise exception using errcode = '23514', message = 'CASE_BACKFILL_COVERAGE_EVIDENCE_REQUIRED';
  end if;
  if v_snapshot.coverage_assurance = 'external_index_assisted' and v_enumeration_count = 0 then
    raise exception using errcode = '23514', message = 'CASE_BACKFILL_ENUMERATION_EVIDENCE_REQUIRED';
  end if;

  v_hash := encode(extensions.digest(convert_to(jsonb_build_object(
    'itemManifestHash', v_item_hash,
    'enumerationManifestHash', v_enumeration_hash
  )::text, 'UTF8'), 'sha256'), 'hex');

  update source_inventory_snapshots s set
    discovered_count = v_count,
    manifest_hash = v_hash,
    enumeration_manifest_hash = v_enumeration_hash,
    status = 'closed',
    closed_at = now()
  where s.id = v_snapshot.id
  returning s.* into v_snapshot;
  return query select
    v_snapshot.id, v_count, v_snapshot.expected_count,
    v_hash, v_enumeration_hash, v_snapshot.coverage_assurance;
end;
$function$;

alter table source_inventory_enumeration_artifacts enable row level security;

revoke all on table source_inventory_enumeration_artifacts from public;
revoke all on function source_inventory_enumeration_artifact_guard_v1() from public;
revoke all on function source_inventory_enumeration_artifact_record_v1(
  uuid, uuid, bigint, text, text, integer, text, text, text, integer, date, date, integer, jsonb
) from public;
revoke all on function source_inventory_snapshot_close_v3(uuid) from public;

do $permissions$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on table source_inventory_enumeration_artifacts from anon;
    revoke all on function source_inventory_enumeration_artifact_record_v1(
      uuid, uuid, bigint, text, text, integer, text, text, text, integer, date, date, integer, jsonb
    ) from anon;
    revoke all on function source_inventory_snapshot_close_v3(uuid) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on table source_inventory_enumeration_artifacts from authenticated;
    revoke all on function source_inventory_enumeration_artifact_record_v1(
      uuid, uuid, bigint, text, text, integer, text, text, text, integer, date, date, integer, jsonb
    ) from authenticated;
    revoke all on function source_inventory_snapshot_close_v3(uuid) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke execute on function source_inventory_snapshot_close_v2(uuid) from service_role;
    grant select on table source_inventory_enumeration_artifacts to service_role;
    grant execute on function source_inventory_enumeration_artifact_record_v1(
      uuid, uuid, bigint, text, text, integer, text, text, text, integer, date, date, integer, jsonb
    ) to service_role;
    grant execute on function source_inventory_snapshot_close_v3(uuid) to service_role;
  end if;
end;
$permissions$;

comment on table source_inventory_enumeration_artifacts is
  'Append-only, text-free evidence for every external or official inventory page and stability probe.';
comment on column source_inventory_snapshots.enumeration_manifest_hash is
  'Digest of the ordered enumeration evidence sealed into manifest_hash at snapshot close.';
comment on function source_inventory_enumeration_artifact_record_v1(
  uuid, uuid, bigint, text, text, integer, text, text, text, integer, date, date, integer, jsonb
) is 'Records idempotent discover-fenced enumeration evidence without retaining external page text.';

commit;
