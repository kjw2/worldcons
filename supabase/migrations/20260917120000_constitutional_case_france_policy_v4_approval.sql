begin;

-- The WorldCons owner directed continuation of the France Gate 5 historical
-- acquisition through 2010 on 2026-09-17. The 2013 QPC frontier then exposed a
-- deterministic exact authority-URL case canonicalization: DILA
-- `CONSTEXT000027147071` carries the uppercase Conseil record id
-- `2012293_294_295_296QPC` in `URL_CC`, but the official Conseil site and the
-- official 2013 QPC annual/type facet publish the decision only under the
-- lowercase canonical `2012293_294_295_296qpc`, and the uppercase form returns
-- an HTTP 301 that the fail-closed governed France fetch refuses to follow.
--
-- `france-dila-constit-2026-09-v4` is the additive, immutable successor of v3.
-- It keeps the exact v1/v2/v3 scope (2010-2024 QPC/DC), recognizes the v2
-- 2022 E1/E2 and v3 2017 QPC E1 exceptions, and adds exactly one E3
-- canonicalization tuple. No wildcard, case-wide, or general redirect-tolerance
-- rule is representable. v1/v2/v3 stay immutable.
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
      ],
      "e3AuthorityUrlCanonicalization": [
        {
          "year": 2013,
          "documentType": "QPC",
          "dilaId": "CONSTEXT000027147071",
          "dilaRecordId": "2012293_294_295_296QPC",
          "officialRecordId": "2012293_294_295_296qpc",
          "officialUrl": "https://www.conseil-constitutionnel.fr/decision/2013/2012293_294_295_296qpc.htm",
          "reasonCode": "official_facet_lowercase_canonical_redirects_from_dila_uppercase"
        }
      ]
    },
    "approval": {
      "approvalId": "france-dila-constit-approval-2026-09-17-v4",
      "mode": "explicit_owner_approval",
      "authority": "worldcons_owner",
      "directiveDate": "2026-09-17",
      "approvedScope": "france_conseil_2010_2024_qpc_dc",
      "supersedesApprovalId": "france-dila-constit-approval-2026-09-17-v3",
      "approvedExceptions": [
        "e1_conseil_provider_fallback",
        "e2_dila_canonicalization",
        "e1_conseil_2017_qpc_dila_omission",
        "e3_authority_url_canonicalization"
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
    and p.policy_version = 'france-dila-constit-2026-09-v4';

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
      or v_existing.supersedes_policy_version is distinct from 'france-dila-constit-2026-09-v3'
    then
      raise exception using
        errcode = '23505',
        message = 'FRANCE_CONSTIT_POLICY_V4_APPROVAL_CONFLICT';
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
    'france-dila-constit-2026-09-v4',
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
    'france-dila-constit-2026-09-v3'
  );
end;
$approval$;

-- v4 recognizes the exact v3 omission tuple set so a future re-run of any
-- already-approved year under v4 stays consistent with the sealed upsert guard.
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
    when p_policy_version in ('france-dila-constit-2026-09-v3', 'france-dila-constit-2026-09-v4') then $v3$[
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

-- Exact, policy-version-gated E3 authority-URL canonicalization tuples.
create or replace function france_conseil_authority_url_canonicalizations_v1(p_policy_version text)
returns jsonb
language sql
immutable
set search_path = public, extensions, pg_temp
as $function$
  select case
    when p_policy_version = 'france-dila-constit-2026-09-v4' then $e3$[
      {
        "year": 2013,
        "documentType": "QPC",
        "dilaId": "CONSTEXT000027147071",
        "dilaRecordId": "2012293_294_295_296QPC",
        "officialRecordId": "2012293_294_295_296qpc",
        "officialUrl": "https://www.conseil-constitutionnel.fr/decision/2013/2012293_294_295_296qpc.htm",
        "reasonCode": "official_facet_lowercase_canonical_redirects_from_dila_uppercase"
      }
    ]$e3$::jsonb
    else '[]'::jsonb
  end;
$function$;

revoke all on function france_conseil_authority_url_canonicalizations_v1(text) from public;

comment on function france_conseil_authority_url_canonicalizations_v1(text) is
  'Exact policy-version-gated E3 authority-URL case canonicalization tuples for the France Conseil corpus.';

commit;
