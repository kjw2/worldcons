begin;

-- Additive strict successor of source_inventory_item_upsert_v2.
--
-- Every prior France path stays exactly as strict as v2 (exact DILA stock,
-- record identity, and Open Licence attribution). The only new branch accepts
-- the single owner-approved E1 non-DILA Conseil-provider item, and only when the
-- snapshot is bound to the exact v2 policy version. Any other conseil-provider
-- item, any fabricated DILA id/archiveMemberPath, and any policy-version
-- mismatch fail closed. The v2 function itself is left byte-for-byte intact.
create or replace function source_inventory_item_upsert_v3(
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
  v_conseil jsonb;
  v_dila_lookup jsonb;
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

  if v_snapshot.source_key <> 'fr-conseil-constitutionnel'
    or coalesce(v_metadata->>'provider', '') <> 'conseil'
  then
    -- Non-France sources and the strict DILA path delegate to the unchanged v2
    -- contract, which itself raises CASE_BACKFILL_FRANCE_DILA_PROVENANCE_INVALID
    -- for any malformed France metadata.
    return source_inventory_item_upsert_v2(
      p_snapshot_id, p_stable_item_key, p_source_record_id, p_discovered_url,
      p_document_type, p_decision_date_hint, v_metadata
    );
  end if;

  -- E1 Conseil-provider omission fallback: exact tuple only, v2 policy only.
  v_conseil := v_metadata->'conseil';
  v_dila_lookup := v_metadata->'dilaLookup';
  v_license := v_metadata->'license';
  if v_snapshot.source_policy_version <> 'france-dila-constit-2026-09-v2' then
    raise exception using errcode = '22023', message = 'CASE_BACKFILL_FRANCE_CONSEIL_OMISSION_POLICY_MISMATCH';
  end if;
  if v_metadata ? 'dila'
    or v_metadata ? 'archiveMemberPath'
    or jsonb_typeof(v_conseil) <> 'object'
    or jsonb_typeof(v_dila_lookup) <> 'object'
    or jsonb_typeof(v_license) <> 'object'
    or v_metadata->>'provider' <> 'conseil'
    or v_metadata->>'reasonCode' <> 'dila_omission_verified_absent'
    or v_metadata->>'authorityUrl' <> 'https://www.conseil-constitutionnel.fr/decision/2022/2022847DC.htm'
    or v_conseil->>'sourceRecordId' <> '2022847DC'
    or v_conseil->>'canonicalUrl' <> 'https://www.conseil-constitutionnel.fr/decision/2022/2022847DC.htm'
    or v_conseil->>'ecli' <> 'ECLI:FR:CC:2022:2022.847.DC'
    or v_conseil->>'decisionNumber' <> '2022-847'
    or v_conseil->>'decisionDate' <> '2022-12-29'
    or v_conseil->>'jorf' <> 'JORF n°0303 du 31 décembre 2022, texte n° 2'
    or v_conseil->>'nor' <> 'CSCL2237744S'
    or v_conseil->>'authorityTitle' <> 'Décision n° 2022-847 DC du 29 décembre 2022'
    or v_conseil->>'authorityDescription' <> 'Loi de finances pour 2023'
    or coalesce(v_conseil->>'authorityObservedAt', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
    or v_license->>'id' <> 'conseil-official-decision'
    or v_license->>'url' <> 'https://www.conseil-constitutionnel.fr/decision/2022/2022847DC.htm'
    or v_license->>'attribution' <> 'Conseil constitutionnel'
    or v_dila_lookup->>'sourceRecordIdSearched' <> '2022847DC'
    or v_dila_lookup->>'norSearched' <> 'CSCL2237744S'
    or jsonb_typeof(v_dila_lookup->'identityHits') <> 'number'
    or (v_dila_lookup->>'identityHits')::integer <> 0
    or jsonb_typeof(v_dila_lookup->'norHits') <> 'number'
    or (v_dila_lookup->>'norHits')::integer <> 0
    or v_dila_lookup->>'result' <> 'absent'
    or coalesce(v_dila_lookup->>'stockFilename', '') !~ '^Freemium_constit_global_[0-9]{8}-[0-9]{6}[.]tar[.]gz$'
    or coalesce(v_dila_lookup->>'stockSha256', '') !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(v_dila_lookup->'incrementsApplied') <> 'number'
    or (v_dila_lookup->>'incrementsApplied')::integer < 0
    or (v_dila_lookup->>'incrementsApplied')::integer > 512
    or jsonb_typeof(v_dila_lookup->'memberScanCount') <> 'number'
    or (v_dila_lookup->>'memberScanCount')::integer < 0
    or coalesce(v_dila_lookup->>'observedAt', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
    or lower(trim(p_stable_item_key)) <> 'constit:conseil-omission:2022847dc'
    or p_source_record_id is distinct from '2022847DC'
    or upper(trim(p_document_type)) <> 'DC'
    or p_decision_date_hint is distinct from '2022-12-29'::date
    or p_discovered_url is distinct from 'https://www.conseil-constitutionnel.fr/decision/2022/2022847DC.htm'
  then
    raise exception using errcode = '22023', message = 'CASE_BACKFILL_FRANCE_DILA_PROVENANCE_INVALID';
  end if;

  v_id := source_inventory_item_upsert_v1(
    p_snapshot_id, p_stable_item_key, p_source_record_id, p_discovered_url,
    p_document_type, p_decision_date_hint
  );
  update source_backfill_items i set inventory_metadata = v_metadata, updated_at = now() where i.id = v_id;
  return v_id;
end;
$function$;

revoke all on function source_inventory_item_upsert_v3(uuid, text, text, text, text, date, jsonb) from public;

do $permissions$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke execute on function source_inventory_item_upsert_v2(uuid, text, text, text, text, date, jsonb) from service_role;
    grant execute on function source_inventory_item_upsert_v3(uuid, text, text, text, text, date, jsonb) to service_role;
  end if;
end;
$permissions$;

comment on function source_inventory_item_upsert_v3(uuid, text, text, text, text, date, jsonb) is
  'Additive strict inventory upsert; France requires exact DILA provenance or the single v2-bound E1 Conseil-omission provenance.';
comment on column source_backfill_items.inventory_metadata is
  'Immutable, bounded, secret-free official inventory provenance included in the closed snapshot manifest hash.';

commit;
