begin;

-- The WorldCons owner explicitly approved the France 2022 source-policy-v2
-- proposal on 2026-09-16, including BOTH separately presented exceptions:
--   E1 - one Conseil-provider omission fallback for 2022 DC 2022847DC
--   E2 - one DILA canonicalization pair for 2022 QPC 20225813AN_QPC
-- The v2 row is an additive, immutable successor of
-- `france-dila-constit-2026-09-v1`; it never updates or deletes the v1 row and
-- keeps the exact v1 scope (2010-2024 QPC/DC, no L/LP/OTHER widening). A rerun
-- may only observe the exact same decision, never replace it silently.
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
    "attribution": "Open Licence 2.0 with DILA attribution and non-endorsement; the single E1 Conseil-provider item attributes the Conseil constitutionnel authority page instead of DILA stock provenance",
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
      "approvalId": "france-dila-constit-approval-2026-09-16-v2",
      "mode": "explicit_owner_approval",
      "authority": "worldcons_owner",
      "directiveDate": "2026-09-16",
      "approvedScope": "france_conseil_2010_2024_qpc_dc",
      "supersedesApprovalId": "france-dila-constit-approval-2026-09-16",
      "approvedExceptions": ["e1_conseil_provider_fallback", "e2_dila_canonicalization"],
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
    and p.policy_version = 'france-dila-constit-2026-09-v2';

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
      or v_existing.reviewed_at is distinct from '2026-09-16T00:00:00Z'::timestamptz
      or v_existing.review_due_at is distinct from '2027-03-15T00:00:00Z'::timestamptz
      or v_existing.supersedes_policy_version is distinct from 'france-dila-constit-2026-09-v1'
    then
      raise exception using
        errcode = '23505',
        message = 'FRANCE_CONSTIT_POLICY_V2_APPROVAL_CONFLICT';
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
    'france-dila-constit-2026-09-v2',
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
    '2026-09-16T00:00:00Z',
    '2027-03-15T00:00:00Z',
    'france-dila-constit-2026-09-v1'
  );
end;
$approval$;

commit;
