begin;

create or replace function case_backfill_inventory_json_has_secret_v1(p_value jsonb)
returns boolean
language plpgsql
immutable
set search_path = public, extensions, pg_temp
as $function$
declare
  v_key text;
  v_child jsonb;
  v_text text;
begin
  if p_value is null then return false; end if;
  if jsonb_typeof(p_value) = 'object' then
    for v_key, v_child in select key, value from jsonb_each(p_value) loop
      if v_key ~* '(authorization|cookie|credential|password|private.?key|secret|signature|token)'
        or case_backfill_inventory_json_has_secret_v1(v_child)
      then return true; end if;
    end loop;
  elsif jsonb_typeof(p_value) = 'array' then
    for v_child in select value from jsonb_array_elements(p_value) loop
      if case_backfill_inventory_json_has_secret_v1(v_child) then return true; end if;
    end loop;
  elsif jsonb_typeof(p_value) = 'string' then
    v_text := p_value #>> '{}';
    if v_text ~* '(^|[^a-z0-9])(bearer[[:space:]]+[a-z0-9._~-]{12,}|sk-[a-z0-9_-]{16,}|AIza[a-z0-9_-]{20,})'
    then return true; end if;
  end if;
  return false;
end;
$function$;

alter table source_backfill_items
  add column if not exists inventory_metadata jsonb not null default '{}'::jsonb;

alter table source_backfill_items
  drop constraint if exists source_backfill_items_inventory_metadata_check,
  add constraint source_backfill_items_inventory_metadata_check check (
    jsonb_typeof(inventory_metadata) = 'object'
    and pg_column_size(inventory_metadata) <= 32768
    and not case_backfill_inventory_json_has_secret_v1(inventory_metadata)
  );

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
      or new.inventory_metadata is distinct from old.inventory_metadata
      or new.first_seen_at is distinct from old.first_seen_at
      or new.last_seen_at is distinct from old.last_seen_at
    then
      raise exception using errcode = '55000', message = 'CASE_BACKFILL_MANIFEST_CLOSED';
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$function$;

create or replace function source_inventory_item_upsert_v2(
  p_snapshot_id uuid,
  p_stable_item_key text,
  p_source_record_id text,
  p_discovered_url text,
  p_document_type text,
  p_decision_date_hint date,
  p_inventory_metadata jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $function$
declare
  v_snapshot source_inventory_snapshots%rowtype;
  v_metadata jsonb := coalesce(p_inventory_metadata, '{}'::jsonb);
  v_dila jsonb;
  v_stock jsonb;
  v_license jsonb;
  v_id uuid;
begin
  select s.* into v_snapshot from source_inventory_snapshots s where s.id = p_snapshot_id for update;
  if not found then raise exception using errcode = 'P0001', message = 'CASE_BACKFILL_SNAPSHOT_NOT_FOUND'; end if;
  if v_snapshot.status <> 'open' then raise exception using errcode = '55000', message = 'CASE_BACKFILL_MANIFEST_CLOSED'; end if;
  if jsonb_typeof(v_metadata) <> 'object'
    or pg_column_size(v_metadata) > 32768
    or case_backfill_inventory_json_has_secret_v1(v_metadata)
  then raise exception using errcode = '22023', message = 'CASE_BACKFILL_INVALID_INVENTORY_METADATA'; end if;

  if v_snapshot.source_key = 'fr-conseil-constitutionnel' then
    v_dila := v_metadata->'dila';
    v_stock := v_metadata->'stock';
    v_license := v_metadata->'license';
    if jsonb_typeof(v_dila) <> 'object'
      or jsonb_typeof(v_stock) <> 'object'
      or jsonb_typeof(v_license) <> 'object'
      or coalesce(v_dila->>'id', '') !~ '^CONSTEXT[0-9]{12}$'
      or lower(trim(p_stable_item_key)) <> 'constit:' || lower(v_dila->>'id')
      or coalesce(v_dila->>'nature', '') not in ('QPC', 'DC')
      or upper(trim(p_document_type)) <> v_dila->>'nature'
      or length(coalesce(v_dila->>'decisionNumber', '')) not between 1 and 80
      or not (v_dila ? 'ecli')
      or coalesce(jsonb_typeof(v_dila->'ecli'), '') not in ('null', 'string')
      or (jsonb_typeof(v_dila->'ecli') = 'string' and coalesce(v_dila->>'ecli', '') !~ '^ECLI:FR:CC:')
      or not (v_dila ? 'qualifiedNature')
      or coalesce(jsonb_typeof(v_dila->'qualifiedNature'), '') not in ('null', 'string')
      or length(coalesce(v_dila->>'qualifiedNature', '')) > 80
      or coalesce(v_dila->>'archiveMemberPath', '') !~ '^constit/global/CONS/TEXT/[A-Za-z0-9_./-]+[.]xml$'
      or coalesce(v_dila->>'archiveMemberPath', '') ~ '(^|/)[.][.]?(/|$)'
      or right(coalesce(v_dila->>'archiveMemberPath', ''), length(v_dila->>'id') + 4) <> (v_dila->>'id') || '.xml'
      or coalesce(v_stock->>'filename', '') !~ '^Freemium_constit_global_[0-9]{8}-[0-9]{6}[.]tar[.]gz$'
      or v_stock->>'url' <> ('https://echanges.dila.gouv.fr/OPENDATA/CONSTIT/' || (v_stock->>'filename'))
      or coalesce(v_stock->>'extractedAt', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.]000Z$'
      or jsonb_typeof(v_stock->'contentLength') <> 'number'
      or (v_stock->>'contentLength')::bigint not between 1 and 33554432
      or coalesce(v_stock->>'sha256', '') !~ '^[0-9a-f]{64}$'
      or not (v_stock ? 'lastModified')
      or coalesce(jsonb_typeof(v_stock->'lastModified'), '') not in ('null', 'string')
      or not (v_stock ? 'etag')
      or coalesce(jsonb_typeof(v_stock->'etag'), '') not in ('null', 'string')
      or v_license->>'id' <> 'licence-ouverte-2.0'
      or v_license->>'url' <> 'https://www.data.gouv.fr/pages/legal/licences/etalab-2.0'
      or v_license->>'attribution' <> 'DILA'
      or p_decision_date_hint is null
      or p_source_record_id is null
      or p_source_record_id !~ '^[A-Za-z0-9_-]{1,120}$'
      or p_discovered_url not in (
        'https://www.conseil-constitutionnel.fr/decision/'
          || extract(year from p_decision_date_hint)::integer::text || '/' || p_source_record_id || '.htm',
        'https://www.conseil-constitutionnel.fr/decision/'
          || extract(year from p_decision_date_hint)::integer::text || '/' || p_source_record_id || '.html'
      )
    then
      raise exception using errcode = '22023', message = 'CASE_BACKFILL_FRANCE_DILA_PROVENANCE_INVALID';
    end if;
  end if;

  v_id := source_inventory_item_upsert_v1(
    p_snapshot_id, p_stable_item_key, p_source_record_id, p_discovered_url,
    p_document_type, p_decision_date_hint
  );
  update source_backfill_items i set inventory_metadata = v_metadata, updated_at = now() where i.id = v_id;
  return v_id;
end;
$function$;

create or replace function source_inventory_snapshot_close_v2(p_snapshot_id uuid)
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
        i.discovered_decision_date_hint, i.inventory_metadata
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

create or replace function source_backfill_items_claim_v2(
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
  item_lease_expires_at timestamptz,
  inventory_metadata jsonb
)
language sql
security definer
set search_path = public, extensions, pg_temp
as $function$
  select c.*, i.inventory_metadata
  from source_backfill_items_claim_v1(
    p_snapshot_id, p_phase, p_batch_limit, p_p1_attempt_id, p_p1_fencing_token,
    p_requested_lease_seconds, p_target_version
  ) c
  join source_backfill_items i on i.id = c.item_id
  order by i.first_seen_at, i.id;
$function$;

revoke all on function case_backfill_inventory_json_has_secret_v1(jsonb) from public;
revoke all on function source_inventory_item_upsert_v2(uuid, text, text, text, text, date, jsonb) from public;
revoke all on function source_inventory_snapshot_close_v2(uuid) from public;
revoke all on function source_backfill_items_claim_v2(uuid, text, integer, uuid, bigint, integer, text) from public;

do $permissions$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke execute on function source_inventory_item_upsert_v1(uuid, text, text, text, text, date) from service_role;
    revoke execute on function source_inventory_snapshot_close_v1(uuid) from service_role;
    revoke execute on function source_backfill_items_claim_v1(uuid, text, integer, uuid, bigint, integer, text) from service_role;
    grant execute on function source_inventory_item_upsert_v2(uuid, text, text, text, text, date, jsonb) to service_role;
    grant execute on function source_inventory_snapshot_close_v2(uuid) to service_role;
    grant execute on function source_backfill_items_claim_v2(uuid, text, integer, uuid, bigint, integer, text) to service_role;
  end if;
end;
$permissions$;

comment on column source_backfill_items.inventory_metadata is
  'Immutable, bounded, secret-free official inventory provenance included in the closed snapshot manifest hash.';
comment on function source_inventory_item_upsert_v2(uuid, text, text, text, text, date, jsonb) is
  'Writes inventory identity plus validated provenance; France requires exact DILA stock, record, and licence attribution.';

commit;
