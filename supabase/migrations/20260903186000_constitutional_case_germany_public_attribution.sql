begin;

create or replace function case_catalog_bverfg_official_url_valid_v1(p_url text, p_decision_date date)
returns boolean
language sql
immutable
set search_path = public, extensions, pg_temp
as $function$
  select coalesce(
    p_url ~ (
      '^https://www[.]bundesverfassungsgericht[.]de/SharedDocs/Entscheidungen/DE/'
      || to_char(p_decision_date,'YYYY') || '/' || to_char(p_decision_date,'MM')
      || '/(rk|rs)' || to_char(p_decision_date,'YYYYMMDD') || '_[a-z0-9]+[.]html$'
    ),
    false
  );
$function$;

create or replace function case_catalog_germany_inventory_attribution_valid_v1(
  p_inventory jsonb,
  p_authority_url text
)
returns boolean
language plpgsql
immutable
set search_path = public, extensions, pg_temp
as $function$
declare
  v_decision_date date;
  v_docket text;
  v_page integer;
  v_listing_url text;
  v_expected_listing_url text;
  v_candidates jsonb;
begin
  if p_inventory is null
    or jsonb_typeof(p_inventory) <> 'object'
    or pg_column_size(p_inventory) > 32768
    or case_backfill_inventory_json_has_secret_v1(p_inventory)
  then return false; end if;

  v_decision_date := (p_inventory->>'decisionDate')::date;
  v_docket := trim(coalesce(p_inventory->>'docket',''));
  v_page := (p_inventory->>'discoveryIndexPage')::integer;
  v_listing_url := p_inventory->>'discoveryIndexUrl';
  v_expected_listing_url := case when v_page=1
    then 'https://dejure.org/dienste/rechtsprechung?gericht=BVerfG'
    else 'https://dejure.org/dienste/rechtsprechung?gericht=BVerfG&seite=' || v_page::text end;
  v_candidates := p_inventory->'officialUrlCandidates';
  if p_inventory->>'discoveryIndex' <> 'dejure.org'
    or v_page < 1
    or v_listing_url <> v_expected_listing_url
    or coalesce(p_inventory->>'discoveryRecordUrl','')
      !~ '^https://dejure[.]org/dienste/vernetzung/rechtsprechung[?]'
    or length(v_docket) not between 1 and 100
    or p_inventory->>'docketKey' <> lower(regexp_replace(v_docket,'[^[:alnum:]]','','g'))
    or coalesce(p_inventory->>'officialUrlResolverVersion','') <> '2'
    or p_inventory->'officialUrlResolved' <> 'true'::jsonb
    or p_inventory->'sourceUrlVerified' <> 'false'::jsonb
    or p_inventory->'authorityVerificationRequired' <> 'true'::jsonb
    or jsonb_typeof(v_candidates) <> 'array'
    or jsonb_array_length(v_candidates) not between 1 and 4
    or not case_catalog_bverfg_official_url_valid_v1(p_authority_url,v_decision_date)
    or not exists(
      select 1 from jsonb_array_elements_text(v_candidates) candidate(url)
      where candidate.url=p_authority_url
    )
    or exists(
      select 1 from jsonb_array_elements_text(v_candidates) candidate(url)
      where not case_catalog_bverfg_official_url_valid_v1(candidate.url,v_decision_date)
    )
  then return false; end if;
  return true;
exception when others then
  return false;
end;
$function$;

create or replace function case_catalog_germany_public_attribution_guard_v1()
returns trigger
language plpgsql
set search_path = public, extensions, pg_temp
as $function$
declare
  v_version article_content_versions_p3%rowtype;
  v_source_key text;
  v_inventory jsonb;
begin
  if new.state <> 'published' then return new; end if;
  select a.source_key into v_source_key from articles a where a.id=new.article_id;
  if v_source_key <> 'de-bverfg' then return new; end if;

  select v.* into v_version from article_content_versions_p3 v
  where v.id=new.source_anchor_version_id and v.article_id=new.article_id;
  v_inventory := v_version.case_metadata_snapshot #> '{sourceMetadata,sourceInventory}';
  if not found
    or v_version.version_role <> 'authoritative_source'
    or not case_catalog_germany_inventory_attribution_valid_v1(v_inventory,v_version.canonical_url)
    or v_version.source_snapshot_id is null
    or v_version.source_snapshot_hash is null
    or not exists(
      select 1
      from source_inventory_snapshots s
      join source_backfill_items i on i.snapshot_id=s.id
      where s.id=v_version.source_snapshot_id
        and s.source_key='de-bverfg'
        and s.status='closed'
        and s.coverage_assurance='external_index_assisted'
        and s.manifest_hash=v_version.source_snapshot_hash
        and s.enumeration_manifest_hash ~ '^[0-9a-f]{64}$'
        and i.inventory_metadata=v_inventory
        and i.discovered_decision_date_hint=(v_inventory->>'decisionDate')::date
        and exists(
          select 1 from source_inventory_enumeration_artifacts e
          where e.snapshot_id=s.id and e.provider_key='dejure.org' and e.artifact_kind='page'
        )
        and exists(
          select 1 from source_inventory_enumeration_artifacts e
          where e.snapshot_id=s.id and e.provider_key='dejure.org' and e.artifact_kind='boundary_probe'
        )
        and exists(
          select 1 from case_identifiers_v1 ci
          where ci.article_id=new.article_id
            and ci.source_key='de-bverfg'
            and ci.identifier_type='source_record_id'
            and ci.normalized_value=lower(regexp_replace(coalesce(i.source_record_id,i.stable_item_key),'[^[:alnum:]]','','g'))
        )
    )
  then
    raise exception using errcode='23514',message='CASE_CATALOG_GERMANY_PUBLIC_ATTRIBUTION_UNSEALED';
  end if;
  return new;
end;
$function$;

do $existing_publication_guard$
begin
  if exists(
    select 1
    from case_catalog_publications_v1 c
    join articles a on a.id=c.article_id
    join article_content_versions_p3 v on v.id=c.source_anchor_version_id and v.article_id=c.article_id
    where c.state='published'
      and a.source_key='de-bverfg'
      and (
        not case_catalog_germany_inventory_attribution_valid_v1(
          v.case_metadata_snapshot #> '{sourceMetadata,sourceInventory}',v.canonical_url
        )
        or v.source_snapshot_id is null
        or v.source_snapshot_hash is null
        or not exists(
          select 1
          from source_inventory_snapshots s
          join source_backfill_items i on i.snapshot_id=s.id
          where s.id=v.source_snapshot_id
            and s.source_key='de-bverfg'
            and s.status='closed'
            and s.coverage_assurance='external_index_assisted'
            and s.manifest_hash=v.source_snapshot_hash
            and s.enumeration_manifest_hash ~ '^[0-9a-f]{64}$'
            and i.inventory_metadata=v.case_metadata_snapshot #> '{sourceMetadata,sourceInventory}'
            and exists(
              select 1 from source_inventory_enumeration_artifacts e
              where e.snapshot_id=s.id and e.provider_key='dejure.org' and e.artifact_kind='page'
            )
            and exists(
              select 1 from source_inventory_enumeration_artifacts e
              where e.snapshot_id=s.id and e.provider_key='dejure.org' and e.artifact_kind='boundary_probe'
            )
            and exists(
              select 1 from case_identifiers_v1 ci
              where ci.article_id=c.article_id
                and ci.source_key='de-bverfg'
                and ci.identifier_type='source_record_id'
                and ci.normalized_value=lower(regexp_replace(coalesce(i.source_record_id,i.stable_item_key),'[^[:alnum:]]','','g'))
            )
        )
      )
  ) then
    raise exception using errcode='23514',message='CASE_CATALOG_GERMANY_EXISTING_ATTRIBUTION_UNSEALED';
  end if;
end;
$existing_publication_guard$;

drop trigger if exists case_catalog_germany_public_attribution_guard_trigger on case_catalog_publications_v1;
create trigger case_catalog_germany_public_attribution_guard_trigger
before insert or update of state,source_anchor_version_id on case_catalog_publications_v1
for each row execute function case_catalog_germany_public_attribution_guard_v1();

revoke all on function case_catalog_bverfg_official_url_valid_v1(text,date) from public;
revoke all on function case_catalog_germany_inventory_attribution_valid_v1(jsonb,text) from public;
revoke all on function case_catalog_germany_public_attribution_guard_v1() from public;

comment on function case_catalog_germany_inventory_attribution_valid_v1(jsonb,text) is
  'Validates sealed BVerfG authority identity and discover-only dejure provenance without treating the external index as authority.';
comment on trigger case_catalog_germany_public_attribution_guard_trigger on case_catalog_publications_v1 is
  'Fail-closed guard requiring Germany Catalog publication to retain exact BVerfG authority and external-index-assisted inventory evidence.';

commit;
