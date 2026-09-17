begin;

-- The WorldCons owner directed continuation of the France Gate 5 historical
-- acquisition through 2010 on 2026-09-17 and approved the deterministic 2017
-- QPC DILA-omission resolution as the additive, immutable successor
-- `france-dila-constit-2026-09-v3`.
--
-- Evidence: the official Conseil 2017 QPC annual/type facet publishes 75
-- decisions, while the approved DILA CONSTIT base stock plus all 21 ordered
-- increments contain exactly 69 matching Conseil identities. Six official 2017
-- QPC decisions have no DILA counterpart at all: their Conseil record id and
-- their official ECLI are absent from every one of the 7,600 scanned XML
-- members. The official Conseil detail pages do not publish a JORF NOR, so the
-- frozen official ECLI is the deterministic secondary absence cross-check.
--
-- v3 keeps the exact v1/v2 scope (2010-2024 QPC/DC) and adds only these six
-- exact Conseil-provider omission tuples. No wildcard, year-wide, type-wide, or
-- general Conseil-only fallback is representable. `france-dila-constit-2026-09-v1`
-- and `...-v2` stay immutable and continue to bind their closed snapshots.
do $approval$
declare
  v_scope constant jsonb := $json$
  {
    "corpus": "official DILA CONSTIT open-data stock with Conseil constitutionnel identity cross-check",
    "snapshotUnit": "calendar_year_and_nature",
    "yearFrom": 2010,
    "yearTo": 2024,
    "natures": ["QPC", "DC"],
    "excludedNatures": "every non-QPC/DC Conseil NATURE is deferred to a later policy version",
    "qpc360": "excluded from this policy version and manifest",
    "identity": "exact META_COMMUN/NATURE; DILA ID is the stable inventory identity, ECLI and decision number are decision identifiers",
    "urlNormalization": "URL_CC normalized to HTTPS and validated against the allowlisted Conseil /decision/{year}/{record}.htm path",
    "stockSelection": "exactly one latest same-origin Freemium_constit_global_*.tar.gz; ordered increment archives applied after the global stock",
    "attribution": "Open Licence 2.0 with DILA attribution and non-endorsement; an E1 Conseil-provider item attributes the Conseil constitutionnel authority page instead of DILA stock provenance",
    "exceptions": {
      "e1ConseilProviderFallback": [
        {
          "sourceKey": "fr-conseil-constitutionnel",
          "year": 2022,
          "documentType": "DC",
          "sourceRecordId": "2022847DC",
          "provider": "conseil",
          "reasonCode": "dila_omission_verified_absent",
          "authorityUrl": "https://www.conseil-constitutionnel.fr/decision/2022/2022847DC.htm",
          "suggestedStableItemKey": "constit:conseil-omission:2022847dc"
        },
        {
          "sourceKey": "fr-conseil-constitutionnel",
          "year": 2017,
          "documentType": "QPC",
          "sourceRecordId": "2016613QPC",
          "provider": "conseil",
          "reasonCode": "dila_omission_verified_absent",
          "authorityUrl": "https://www.conseil-constitutionnel.fr/decision/2017/2016613QPC.htm",
          "suggestedStableItemKey": "constit:conseil-omission:2016613qpc"
        },
        {
          "sourceKey": "fr-conseil-constitutionnel",
          "year": 2017,
          "documentType": "QPC",
          "sourceRecordId": "2017663QPC",
          "provider": "conseil",
          "reasonCode": "dila_omission_verified_absent",
          "authorityUrl": "https://www.conseil-constitutionnel.fr/decision/2017/2017663QPC.htm",
          "suggestedStableItemKey": "constit:conseil-omission:2017663qpc"
        },
        {
          "sourceKey": "fr-conseil-constitutionnel",
          "year": 2017,
          "documentType": "QPC",
          "sourceRecordId": "2017664QPC",
          "provider": "conseil",
          "reasonCode": "dila_omission_verified_absent",
          "authorityUrl": "https://www.conseil-constitutionnel.fr/decision/2017/2017664QPC.htm",
          "suggestedStableItemKey": "constit:conseil-omission:2017664qpc"
        },
        {
          "sourceKey": "fr-conseil-constitutionnel",
          "year": 2017,
          "documentType": "QPC",
          "sourceRecordId": "2017665QPC",
          "provider": "conseil",
          "reasonCode": "dila_omission_verified_absent",
          "authorityUrl": "https://www.conseil-constitutionnel.fr/decision/2017/2017665QPC.htm",
          "suggestedStableItemKey": "constit:conseil-omission:2017665qpc"
        },
        {
          "sourceKey": "fr-conseil-constitutionnel",
          "year": 2017,
          "documentType": "QPC",
          "sourceRecordId": "2017666QPC",
          "provider": "conseil",
          "reasonCode": "dila_omission_verified_absent",
          "authorityUrl": "https://www.conseil-constitutionnel.fr/decision/2017/2017666QPC.htm",
          "suggestedStableItemKey": "constit:conseil-omission:2017666qpc"
        },
        {
          "sourceKey": "fr-conseil-constitutionnel",
          "year": 2017,
          "documentType": "QPC",
          "sourceRecordId": "2017670QPC",
          "provider": "conseil",
          "reasonCode": "dila_omission_verified_absent",
          "authorityUrl": "https://www.conseil-constitutionnel.fr/decision/2017/2017670QPC.htm",
          "suggestedStableItemKey": "constit:conseil-omission:2017670qpc"
        }
      ],
      "e2DilaCanonicalization": [
        {
          "conseilRecordId": "20225813AN_QPC",
          "canonicalDilaId": "CONSTEXT000047955984",
          "retiredDilaId": "CONSTEXT000046216504",
          "basis": "matches_current_conseil_title_and_ecli",
          "expectedConseilTitle": "A.N., Français établis hors de France (2ème circ.), M. Christian RODRIGUEZ [ ]",
          "expectedConseilEcli": "ECLI:FR:CC:2022:2022.5813.AN.QPC"
        }
      ]
    },
    "approval": {
      "approvalId": "france-dila-constit-approval-2026-09-17-v3",
      "mode": "explicit_owner_approval",
      "authority": "worldcons_owner",
      "directiveDate": "2026-09-17",
      "approvedScope": "france_conseil_2010_2024_qpc_dc",
      "supersedesApprovalId": "france-dila-constit-approval-2026-09-16-v2",
      "approvedExceptions": [
        "e1_conseil_provider_fallback",
        "e2_dila_canonicalization",
        "e1_conseil_2017_qpc_dila_omission"
      ],
      "boundedEvidenceRetentionDays": 90,
      "policyReviewIntervalDays": 180,
      "publicTextPosture": "full_after_separate_catalog_gate",
      "canaryVisibility": "private_shadow",
      "aiEgress": "denied"
    }
  }
  $json$::jsonb;
  v_existing source_corpus_policies%rowtype;
begin
  select p.* into v_existing
  from source_corpus_policies p
  where p.source_key = 'fr-conseil-constitutionnel'
    and p.policy_version = 'france-dila-constit-2026-09-v3';

  if found then
    if v_existing.scope_definition is distinct from v_scope
      or v_existing.official_scope_url is distinct from 'https://www.data.gouv.fr/datasets/constit-les-decisions-du-conseil-constitutionnel'
      or v_existing.discovery_methods is distinct from array[
        'official_dila_constit_latest_stock', 'official_conseil_annual_type_crosscheck'
      ]::text[]
      or v_existing.authority_hosts is distinct from array[
        'echanges.dila.gouv.fr', 'www.conseil-constitutionnel.fr'
      ]::text[]
      or v_existing.redirect_hosts is distinct from array[]::text[]
      or v_existing.external_index_hosts is distinct from array[]::text[]
      or v_existing.robots_url is distinct from 'https://echanges.dila.gouv.fr/robots.txt'
      or v_existing.robots_observed_at is distinct from '2026-09-03T14:07:08Z'::timestamptz
      or v_existing.robots_rules_hash is distinct from '80c3fe2ae1062abf56456f52518bd670f9ec3917b7f85e152b347ac6b6faf880'
      or v_existing.terms_url is distinct from 'https://www.data.gouv.fr/pages/legal/licences/etalab-2.0'
      or v_existing.terms_observed_at is distinct from '2026-09-03T14:07:08Z'::timestamptz
      or v_existing.license_basis is distinct from 'licence-ouverte-2.0'
      or v_existing.default_text_access_policy is distinct from 'full'
      or v_existing.allow_raw_snapshot is distinct from false
      or v_existing.normalize_replay_policy is distinct from 'bounded_evidence'
      or v_existing.bounded_replay_fields is distinct from array[
        'sourceKey', 'url', 'canonicalUrl', 'title',
        'publishedAt', 'contentType', 'text', 'metadata'
      ]::text[]
      or v_existing.retention_days is distinct from 90
      or v_existing.min_request_delay_ms is distinct from 3000
      or v_existing.max_concurrency is distinct from 1
      or v_existing.external_index_usage is not null
      or v_existing.reviewed_by is distinct from 'WorldCons owner via explicit approval'
      or v_existing.reviewed_at is distinct from '2026-09-17T00:00:00Z'::timestamptz
      or v_existing.review_due_at is distinct from '2027-03-15T00:00:00Z'::timestamptz
      or v_existing.supersedes_policy_version is distinct from 'france-dila-constit-2026-09-v2'
    then
      raise exception using
        errcode = '23505',
        message = 'FRANCE_CONSTIT_POLICY_V3_APPROVAL_CONFLICT';
    end if;
    return;
  end if;

  insert into source_corpus_policies(
    source_key,
    policy_version,
    scope_definition,
    official_scope_url,
    discovery_methods,
    authority_hosts,
    redirect_hosts,
    robots_url,
    robots_observed_at,
    robots_rules_hash,
    terms_url,
    terms_observed_at,
    license_basis,
    default_text_access_policy,
    allow_raw_snapshot,
    normalize_replay_policy,
    bounded_replay_fields,
    retention_days,
    min_request_delay_ms,
    max_concurrency,
    external_index_hosts,
    external_index_usage,
    reviewed_by,
    reviewed_at,
    review_due_at,
    supersedes_policy_version
  ) values (
    'fr-conseil-constitutionnel',
    'france-dila-constit-2026-09-v3',
    v_scope,
    'https://www.data.gouv.fr/datasets/constit-les-decisions-du-conseil-constitutionnel',
    array['official_dila_constit_latest_stock', 'official_conseil_annual_type_crosscheck'],
    array['echanges.dila.gouv.fr', 'www.conseil-constitutionnel.fr'],
    array[]::text[],
    'https://echanges.dila.gouv.fr/robots.txt',
    '2026-09-03T14:07:08Z',
    '80c3fe2ae1062abf56456f52518bd670f9ec3917b7f85e152b347ac6b6faf880',
    'https://www.data.gouv.fr/pages/legal/licences/etalab-2.0',
    '2026-09-03T14:07:08Z',
    'licence-ouverte-2.0',
    'full',
    false,
    'bounded_evidence',
    array['sourceKey', 'url', 'canonicalUrl', 'title', 'publishedAt', 'contentType', 'text', 'metadata'],
    90,
    3000,
    1,
    array[]::text[],
    null,
    'WorldCons owner via explicit approval',
    '2026-09-17T00:00:00Z',
    '2027-03-15T00:00:00Z',
    'france-dila-constit-2026-09-v2'
  );
end;
$approval$;

-- Exact, policy-version-gated Conseil omission tuples. v2 exposes only the 2022
-- DC tuple; v3 exposes the 2022 DC tuple plus exactly six 2017 QPC tuples.
create or replace function france_conseil_omission_exceptions_v1(p_policy_version text)
returns jsonb
language sql
immutable
set search_path = public, extensions, pg_temp
as $function$
  select case
    when p_policy_version = 'france-dila-constit-2026-09-v2' then $v2$[
      {
        "sourceRecordId": "2022847DC",
        "documentType": "DC",
        "decisionDate": "2022-12-29",
        "decisionNumber": "2022-847",
        "ecli": "ECLI:FR:CC:2022:2022.847.DC",
        "jorf": "JORF n°0303 du 31 décembre 2022, texte n° 2",
        "nor": "CSCL2237744S",
        "authorityUrl": "https://www.conseil-constitutionnel.fr/decision/2022/2022847DC.htm",
        "authorityTitle": "Décision n° 2022-847 DC du 29 décembre 2022",
        "authorityDescription": "Loi de finances pour 2023"
      }
    ]$v2$::jsonb
    when p_policy_version = 'france-dila-constit-2026-09-v3' then $v3$[
      {
        "sourceRecordId": "2022847DC",
        "documentType": "DC",
        "decisionDate": "2022-12-29",
        "decisionNumber": "2022-847",
        "ecli": "ECLI:FR:CC:2022:2022.847.DC",
        "jorf": "JORF n°0303 du 31 décembre 2022, texte n° 2",
        "nor": "CSCL2237744S",
        "authorityUrl": "https://www.conseil-constitutionnel.fr/decision/2022/2022847DC.htm",
        "authorityTitle": "Décision n° 2022-847 DC du 29 décembre 2022",
        "authorityDescription": "Loi de finances pour 2023"
      },
      {
        "sourceRecordId": "2016613QPC",
        "documentType": "QPC",
        "decisionDate": "2017-02-24",
        "decisionNumber": "2016-613",
        "ecli": "ECLI:FR:CC:2017:2016.613.QPC",
        "jorf": "JORF n°0048 du 25 février 2017 texte n° 122",
        "nor": null,
        "authorityUrl": "https://www.conseil-constitutionnel.fr/decision/2017/2016613QPC.htm",
        "authorityTitle": "Décision n° 2016-613 QPC du 24 février 2017",
        "authorityDescription": "Département d'Ille-et-Vilaine [Recours subrogatoire des départements servant des prestations sociales]"
      },
      {
        "sourceRecordId": "2017663QPC",
        "documentType": "QPC",
        "decisionDate": "2017-10-19",
        "decisionNumber": "2017-663",
        "ecli": "ECLI:FR:CC:2017:2017.663.QPC",
        "jorf": "JORF n° 2048 du 22 octobre 2017",
        "nor": null,
        "authorityUrl": "https://www.conseil-constitutionnel.fr/decision/2017/2017663QPC.htm",
        "authorityTitle": "Décision n° 2017-663 QPC du 19 octobre 2017",
        "authorityDescription": "Époux T. [Exonération d'impôt sur le revenu de l'indemnité compensatrice de cessation de mandat d'un agent général d'assurances II]"
      },
      {
        "sourceRecordId": "2017664QPC",
        "documentType": "QPC",
        "decisionDate": "2017-10-20",
        "decisionNumber": "2017-664",
        "ecli": "ECLI:FR:CC:2017:2017.664.QPC",
        "jorf": "JORF n°0248 du 22 octobre 2017, texte n° 33",
        "nor": null,
        "authorityUrl": "https://www.conseil-constitutionnel.fr/decision/2017/2017664QPC.htm",
        "authorityTitle": "Décision n° 2017-664 QPC du 20 octobre 2017",
        "authorityDescription": "Confédération générale du travail - Force ouvrière [Conditions d'organisation de la consultation des salariés sur un accord minoritaire d'entreprise ou d'établissement]"
      },
      {
        "sourceRecordId": "2017665QPC",
        "documentType": "QPC",
        "decisionDate": "2017-10-20",
        "decisionNumber": "2017-665",
        "ecli": "ECLI:FR:CC:2017:2017.665.QPC",
        "jorf": "JORF n°0248 du 22 octobre 2017, texte n° 34",
        "nor": null,
        "authorityUrl": "https://www.conseil-constitutionnel.fr/decision/2017/2017665QPC.htm",
        "authorityTitle": "Décision n° 2017-665 QPC du 20 octobre 2017",
        "authorityDescription": "Confédération générale du travail - Force ouvrière [Licenciement en cas de refus d'application d'un accord en vue de la préservation ou du développement de l'emploi]"
      },
      {
        "sourceRecordId": "2017666QPC",
        "documentType": "QPC",
        "decisionDate": "2017-10-20",
        "decisionNumber": "2017-666",
        "ecli": "ECLI:FR:CC:2017:2017.666.QPC",
        "jorf": "JORF n°0248 du 22 octobre 2017, texte n° 35",
        "nor": null,
        "authorityUrl": "https://www.conseil-constitutionnel.fr/decision/2017/2017666QPC.htm",
        "authorityTitle": "Décision n° 2017-666 QPC du 20 octobre 2017",
        "authorityDescription": "M. Jean-Marc L. [Compétence du vice-président du Conseil d'État pour établir la charte de déontologie de la juridiction administrative]"
      },
      {
        "sourceRecordId": "2017670QPC",
        "documentType": "QPC",
        "decisionDate": "2017-10-27",
        "decisionNumber": "2017-670",
        "ecli": "ECLI:FR:CC:2017:2017.670.QPC",
        "jorf": "JORF n°0254 du 29 octobre 2017 texte n° 38",
        "nor": null,
        "authorityUrl": "https://www.conseil-constitutionnel.fr/decision/2017/2017670QPC.htm",
        "authorityTitle": "Décision n° 2017-670 QPC du 27 octobre 2017",
        "authorityDescription": "M. Mikhail P. [Effacement anticipé des données à caractère personnel inscrites dans un fichier de traitement d'antécédents judiciaires]"
      }
    ]$v3$::jsonb
    else '[]'::jsonb
  end;
$function$;

revoke all on function france_conseil_omission_exceptions_v1(text) from public;

-- Metadata-only exact validation of a Conseil-provider omission item. The
-- candidate must match one of the exact permitted tuples for the policy version
-- and carry the full per-discover absence proof. Any other shape fails closed.
create or replace function france_conseil_omission_metadata_valid_v1(
  p_inventory jsonb,
  p_policy_version text
)
returns boolean
language plpgsql
immutable
set search_path = public, extensions, pg_temp
as $function$
declare
  v_allowed jsonb;
  v_conseil jsonb;
  v_dila_lookup jsonb;
  v_license jsonb;
  v_candidate jsonb;
  v_nor jsonb;
begin
  if p_inventory is null
    or jsonb_typeof(p_inventory) <> 'object'
    or pg_column_size(p_inventory) > 32768
    or case_backfill_inventory_json_has_secret_v1(p_inventory)
  then return false; end if;
  if coalesce(p_inventory->>'provider', '') <> 'conseil' then return false; end if;

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
    or jsonb_typeof(v_conseil->'nor') not in ('string', 'null')
    or jsonb_typeof(v_conseil->'authorityObservedAt') <> 'string'
    or jsonb_typeof(v_dila_lookup->'identityHits') <> 'number'
    or (v_dila_lookup->>'identityHits')::integer <> 0
    or jsonb_typeof(v_dila_lookup->'ecliHits') <> 'number'
    or (v_dila_lookup->>'ecliHits')::integer <> 0
    or v_dila_lookup->>'result' <> 'absent'
    or coalesce(v_dila_lookup->>'stockFilename', '') !~ '^Freemium_constit_global_[0-9]{8}-[0-9]{6}[.]tar[.]gz$'
    or coalesce(v_dila_lookup->>'stockSha256', '') !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(v_dila_lookup->'incrementsApplied') <> 'number'
    or (v_dila_lookup->>'incrementsApplied')::integer not between 0 and 512
    or jsonb_typeof(v_dila_lookup->'memberScanCount') <> 'number'
    or (v_dila_lookup->>'memberScanCount')::integer < 0
    or coalesce(v_dila_lookup->>'observedAt', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
    or coalesce(v_conseil->>'authorityObservedAt', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
    or v_dila_lookup->>'sourceRecordIdSearched' is distinct from v_conseil->>'sourceRecordId'
    or v_dila_lookup->>'ecliSearched' is distinct from v_conseil->>'ecli'
    or v_dila_lookup->>'norSearched' is distinct from v_conseil->>'nor'
    or v_license->>'id' <> 'conseil-official-decision'
    or v_license->>'url' is distinct from p_inventory->>'authorityUrl'
    or v_license->>'attribution' <> 'Conseil constitutionnel'
  then return false; end if;

  v_nor := v_conseil->'nor';
  if v_nor = 'null'::jsonb then
    if v_dila_lookup->'norHits' is distinct from 'null'::jsonb then return false; end if;
  else
    if jsonb_typeof(v_dila_lookup->'norHits') <> 'number'
      or (v_dila_lookup->>'norHits')::integer <> 0
    then return false; end if;
  end if;

  v_allowed := france_conseil_omission_exceptions_v1(p_policy_version);
  if jsonb_array_length(v_allowed) = 0 then return false; end if;
  v_candidate := jsonb_build_object(
    'sourceRecordId', v_conseil->>'sourceRecordId',
    'decisionDate', v_conseil->>'decisionDate',
    'decisionNumber', v_conseil->>'decisionNumber',
    'ecli', v_conseil->>'ecli',
    'jorf', v_conseil->>'jorf',
    'nor', v_conseil->'nor',
    'authorityUrl', p_inventory->>'authorityUrl',
    'authorityTitle', v_conseil->>'authorityTitle',
    'authorityDescription', v_conseil->>'authorityDescription'
  );
  if not (v_allowed @> jsonb_build_array(v_candidate)) then return false; end if;
  return true;
exception when others then
  return false;
end;
$function$;

revoke all on function france_conseil_omission_metadata_valid_v1(jsonb, text) from public;

-- Additive strict successor of the v2 upsert. Every prior France path stays
-- exactly as strict; the only conseil-provider branch accepts the exact
-- owner-approved v2/v3 omission tuples and never a wildcard.
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
  v_expected_type text;
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
    return source_inventory_item_upsert_v2(
      p_snapshot_id, p_stable_item_key, p_source_record_id, p_discovered_url,
      p_document_type, p_decision_date_hint, v_metadata
    );
  end if;

  if not france_conseil_omission_metadata_valid_v1(v_metadata, v_snapshot.source_policy_version) then
    raise exception using errcode = '22023', message = 'CASE_BACKFILL_FRANCE_DILA_PROVENANCE_INVALID';
  end if;

  v_conseil := v_metadata->'conseil';
  select e->>'documentType' into v_expected_type
  from jsonb_array_elements(france_conseil_omission_exceptions_v1(v_snapshot.source_policy_version)) e
  where lower(e->>'sourceRecordId') = lower(v_conseil->>'sourceRecordId')
  limit 1;

  if v_expected_type is null
    or v_conseil->>'sourceRecordId' is distinct from p_source_record_id
    or upper(trim(p_document_type)) <> v_expected_type
    or p_decision_date_hint is distinct from (v_conseil->>'decisionDate')::date
    or p_discovered_url is distinct from v_metadata->>'authorityUrl'
    or lower(trim(p_stable_item_key)) <> 'constit:conseil-omission:' || lower(v_conseil->>'sourceRecordId')
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
  'Additive strict inventory upsert; France requires exact DILA provenance or one exact owner-approved v2/v3 E1 Conseil-omission provenance tuple.';

-- Additive France public-attribution validator/guard v3. Publication remains
-- disabled by the Catalog flags; this only extends the sealed guard so a future
-- separately gated publication stage can accept the exact v3 omission items.
create or replace function case_catalog_france_inventory_attribution_valid_v3(
  p_inventory jsonb,
  p_policy_version text
)
returns boolean
language plpgsql
immutable
set search_path = public, extensions, pg_temp
as $function$
begin
  if p_inventory is null
    or jsonb_typeof(p_inventory) <> 'object'
    or pg_column_size(p_inventory) > 32768
    or case_backfill_inventory_json_has_secret_v1(p_inventory)
  then return false; end if;
  if coalesce(p_inventory->>'provider', '') <> 'conseil' then
    return case_catalog_france_inventory_attribution_valid_v1(p_inventory);
  end if;
  return france_conseil_omission_metadata_valid_v1(p_inventory, p_policy_version);
end;
$function$;

create or replace function case_catalog_france_public_attribution_guard_v3()
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
    or not case_catalog_france_inventory_attribution_valid_v3(v_inventory, v_policy_version)
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
for each row execute function case_catalog_france_public_attribution_guard_v3();

revoke all on function case_catalog_france_inventory_attribution_valid_v3(jsonb, text) from public;
revoke all on function case_catalog_france_public_attribution_guard_v3() from public;

comment on function case_catalog_france_inventory_attribution_valid_v3(jsonb, text) is
  'Validates strict DILA provenance or one exact v2/v3-bound E1 Conseil-omission provenance tuple for public France Catalog representations.';

commit;
