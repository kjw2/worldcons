begin;

create or replace function case_catalog_france_inventory_attribution_valid_v1(p_inventory jsonb)
returns boolean
language plpgsql
immutable
set search_path = public, extensions, pg_temp
as $function$
declare
  v_dila jsonb;
  v_stock jsonb;
  v_license jsonb;
begin
  if p_inventory is null
    or jsonb_typeof(p_inventory) <> 'object'
    or pg_column_size(p_inventory) > 32768
    or case_backfill_inventory_json_has_secret_v1(p_inventory)
  then return false; end if;

  v_dila := p_inventory->'dila';
  v_stock := p_inventory->'stock';
  v_license := p_inventory->'license';
  if jsonb_typeof(v_dila) <> 'object'
    or jsonb_typeof(v_stock) <> 'object'
    or jsonb_typeof(v_license) <> 'object'
    or coalesce(v_dila->>'id','') !~ '^CONSTEXT[0-9]{12}$'
    or coalesce(v_dila->>'nature','') not in ('QPC','DC')
    or length(coalesce(v_dila->>'decisionNumber','')) not between 1 and 80
    or not (v_dila ? 'ecli')
    or coalesce(jsonb_typeof(v_dila->'ecli'),'') not in ('null','string')
    or (jsonb_typeof(v_dila->'ecli')='string' and coalesce(v_dila->>'ecli','') !~ '^ECLI:FR:CC:')
    or coalesce(v_dila->>'archiveMemberPath','') !~ '^constit/global/CONS/TEXT/[A-Za-z0-9_./-]+[.]xml$'
    or coalesce(v_stock->>'filename','') !~ '^Freemium_constit_global_[0-9]{8}-[0-9]{6}[.]tar[.]gz$'
    or v_stock->>'url' <> 'https://echanges.dila.gouv.fr/OPENDATA/CONSTIT/' || (v_stock->>'filename')
    or coalesce(v_stock->>'extractedAt','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.]000Z$'
    or jsonb_typeof(v_stock->'contentLength') <> 'number'
    or (v_stock->>'contentLength')::bigint not between 1 and 33554432
    or coalesce(v_stock->>'sha256','') !~ '^[0-9a-f]{64}$'
    or not (v_stock ? 'lastModified')
    or coalesce(jsonb_typeof(v_stock->'lastModified'),'') not in ('null','string')
    or v_license->>'id' <> 'licence-ouverte-2.0'
    or v_license->>'url' <> 'https://www.data.gouv.fr/pages/legal/licences/etalab-2.0'
    or v_license->>'attribution' <> 'DILA'
  then return false; end if;
  return true;
exception when others then
  return false;
end;
$function$;

create or replace function case_catalog_france_public_attribution_guard_v1()
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
  select a.source_key into v_source_key from articles a where a.id = new.article_id;
  if v_source_key <> 'fr-conseil-constitutionnel' then return new; end if;

  select v.* into v_version from article_content_versions_p3 v
  where v.id = new.source_anchor_version_id and v.article_id = new.article_id;
  v_inventory := v_version.case_metadata_snapshot #> '{sourceMetadata,sourceInventory}';
  if not found
    or v_version.version_role <> 'authoritative_source'
    or not case_catalog_france_inventory_attribution_valid_v1(v_inventory)
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

do $existing_publication_guard$
begin
  if exists(
    select 1
    from case_catalog_publications_v1 c
    join articles a on a.id = c.article_id
    join article_content_versions_p3 v on v.id = c.source_anchor_version_id and v.article_id = c.article_id
    where c.state = 'published'
      and a.source_key = 'fr-conseil-constitutionnel'
      and (
        not case_catalog_france_inventory_attribution_valid_v1(v.case_metadata_snapshot #> '{sourceMetadata,sourceInventory}')
        or v.source_snapshot_id is null
        or v.source_snapshot_hash is null
        or not exists(
          select 1
          from source_inventory_snapshots s
          join source_backfill_items i on i.snapshot_id = s.id
          where s.id = v.source_snapshot_id
            and s.source_key = 'fr-conseil-constitutionnel'
            and s.status = 'closed'
            and s.manifest_hash = v.source_snapshot_hash
            and i.inventory_metadata = v.case_metadata_snapshot #> '{sourceMetadata,sourceInventory}'
            and i.discovered_url = v.canonical_url
            and exists(
              select 1 from case_identifiers_v1 ci
              where ci.article_id = c.article_id
                and ci.source_key = 'fr-conseil-constitutionnel'
                and ci.identifier_type = 'source_record_id'
                and ci.normalized_value = lower(regexp_replace(i.source_record_id,'[^[:alnum:]]','','g'))
            )
        )
      )
  ) then
    raise exception using errcode = '23514', message = 'CASE_CATALOG_FRANCE_EXISTING_ATTRIBUTION_UNSEALED';
  end if;
end;
$existing_publication_guard$;

drop trigger if exists case_catalog_france_public_attribution_guard_trigger on case_catalog_publications_v1;
create trigger case_catalog_france_public_attribution_guard_trigger
before insert or update of state, source_anchor_version_id on case_catalog_publications_v1
for each row execute function case_catalog_france_public_attribution_guard_v1();

revoke all on function case_catalog_france_inventory_attribution_valid_v1(jsonb) from public;
revoke all on function case_catalog_france_public_attribution_guard_v1() from public;

comment on function case_catalog_france_inventory_attribution_valid_v1(jsonb) is
  'Validates the DILA identity, stock update provenance, and Open Licence attribution required on every public France Catalog representation.';
comment on trigger case_catalog_france_public_attribution_guard_trigger on case_catalog_publications_v1 is
  'Fail-closed guard binding a published France Catalog anchor to the exact immutable inventory provenance sealed into its closed snapshot.';

commit;
