begin;

-- Additive France public-attribution validator/guard v2.
--
-- Publication remains disabled by the Catalog flags; this migration only makes
-- the sealed guard provenance-aware so a future, separately gated publication
-- stage can accept the exact E1 Conseil-provider item when, and only when, it is
-- bound to the v2 policy version. Strict DILA provenance keeps delegating to the
-- unchanged v1 validator, so existing v1 behavior and regressions are preserved.
create or replace function case_catalog_france_inventory_attribution_valid_v2(
  p_inventory jsonb,
  p_policy_version text
)
returns boolean
language plpgsql
immutable
set search_path = public, extensions, pg_temp
as $function$
declare
  v_conseil jsonb;
  v_dila_lookup jsonb;
  v_license jsonb;
begin
  if p_inventory is null
    or jsonb_typeof(p_inventory) <> 'object'
    or pg_column_size(p_inventory) > 32768
    or case_backfill_inventory_json_has_secret_v1(p_inventory)
  then return false; end if;

  if coalesce(p_inventory->>'provider', '') <> 'conseil' then
    return case_catalog_france_inventory_attribution_valid_v1(p_inventory);
  end if;

  if p_policy_version is distinct from 'france-dila-constit-2026-09-v2' then return false; end if;

  v_conseil := p_inventory->'conseil';
  v_dila_lookup := p_inventory->'dilaLookup';
  v_license := p_inventory->'license';
  if p_inventory ? 'dila'
    or p_inventory ? 'archiveMemberPath'
    or jsonb_typeof(v_conseil) <> 'object'
    or jsonb_typeof(v_dila_lookup) <> 'object'
    or jsonb_typeof(v_license) <> 'object'
    or p_inventory->>'provider' <> 'conseil'
    or p_inventory->>'reasonCode' <> 'dila_omission_verified_absent'
    or p_inventory->>'authorityUrl' <> 'https://www.conseil-constitutionnel.fr/decision/2022/2022847DC.htm'
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
    or jsonb_typeof(v_dila_lookup->'memberScanCount') <> 'number'
    or coalesce(v_dila_lookup->>'observedAt', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
  then return false; end if;
  return true;
exception when others then
  return false;
end;
$function$;

create or replace function case_catalog_france_public_attribution_guard_v2()
returns trigger
language plpgsql
set search_path = public, extensions, pg_temp
as $function$
declare
  v_version article_content_versions_p3%rowtype;
  v_source_key text;
  v_inventory jsonb;
  v_policy_version text;
begin
  if new.state <> 'published' then return new; end if;
  select a.source_key into v_source_key from articles a where a.id = new.article_id;
  if v_source_key <> 'fr-conseil-constitutionnel' then return new; end if;

  select v.* into v_version from article_content_versions_p3 v
  where v.id = new.source_anchor_version_id and v.article_id = new.article_id;
  v_inventory := v_version.case_metadata_snapshot #> '{sourceMetadata,sourceInventory}';
  select s.source_policy_version into v_policy_version
  from source_inventory_snapshots s
  where s.id = v_version.source_snapshot_id;

  if not found
    or v_version.version_role <> 'authoritative_source'
    or not case_catalog_france_inventory_attribution_valid_v2(v_inventory, v_policy_version)
    or v_version.source_snapshot_id is null
    or v_version.source_snapshot_hash is null
    or not exists(
      select 1
      from source_inventory_snapshots s
      join source_backfill_items i on i.snapshot_id = s.id
      where s.id = v_version.source_snapshot_id
        and s.source_key = 'fr-conseil-constitutionnel'
        and s.status = 'closed'
        and s.manifest_hash = v_version.source_snapshot_hash
        and i.inventory_metadata = v_inventory
        and i.discovered_url = v_version.canonical_url
        and exists(
          select 1 from case_identifiers_v1 ci
          where ci.article_id = new.article_id
            and ci.source_key = 'fr-conseil-constitutionnel'
            and ci.identifier_type = 'source_record_id'
            and ci.normalized_value = lower(regexp_replace(i.source_record_id,'[^[:alnum:]]','','g'))
        )
    )
  then
    raise exception using errcode = '23514', message = 'CASE_CATALOG_FRANCE_PUBLIC_ATTRIBUTION_UNSEALED';
  end if;
  return new;
end;
$function$;

drop trigger if exists case_catalog_france_public_attribution_guard_trigger on case_catalog_publications_v1;
create trigger case_catalog_france_public_attribution_guard_trigger
before insert or update of state, source_anchor_version_id on case_catalog_publications_v1
for each row execute function case_catalog_france_public_attribution_guard_v2();

revoke all on function case_catalog_france_inventory_attribution_valid_v2(jsonb, text) from public;
revoke all on function case_catalog_france_public_attribution_guard_v2() from public;

comment on function case_catalog_france_inventory_attribution_valid_v2(jsonb, text) is
  'Validates strict DILA provenance or the exact v2-bound E1 Conseil-omission provenance for public France Catalog representations.';
comment on trigger case_catalog_france_public_attribution_guard_trigger on case_catalog_publications_v1 is
  'Fail-closed guard binding a published France Catalog anchor to the exact immutable inventory provenance sealed into its closed snapshot.';

commit;
