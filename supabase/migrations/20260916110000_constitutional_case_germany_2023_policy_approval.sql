begin;

-- The WorldCons owner explicitly authorized continuing the Germany historical
-- backfill under the existing reviewed 2024 source-policy assumptions on
-- 2026-09-16. Live read-only re-verification confirmed that the source, robots
-- hash, authority host/prefix, inventory method, external-index-assisted
-- coverage limitation, fetch/verify semantics, and public attribution
-- assumptions are unchanged from `bverfg-unattended-canary-v1`, so the exact
-- reviewed assumptions are extended to the NEXT SINGLE YEAR, 2023 only.
--
-- This migration records an additive, immutable successor policy row. It never
-- updates or deletes the v1 row, never widens document type, hosts, robots or
-- terms, discovery method, coverage assurance, text posture, or AI/public
-- posture, and 2022 and older remain blocked by the existing expansion guard.
-- Reapplying the exact policy is a no-op; finding the same
-- (source_key, policy_version) with any different value raises
-- BVERFG_2023_POLICY_APPROVAL_CONFLICT.
do $approval$
declare
  v_scope constant jsonb := $json$
  {
    "corpus": "official BVerfG website decision publications",
    "snapshotUnit": "calendar_year",
    "firstCanaryYear": 2024,
    "approvedYears": [2024, 2023],
    "olderDecisions": "included_when_published_on_the_official_website",
    "officialCompletenessClaimed": false,
    "approval": {
      "approvalId": "bverfg-unattended-approval-2026-09-16-2023",
      "mode": "explicit_owner_approval",
      "authority": "worldcons_owner",
      "directiveDate": "2026-09-16",
      "extendsApprovalId": "bverfg-unattended-approval-2026-09-04",
      "supersedesPolicyVersion": "bverfg-unattended-canary-v1",
      "approvedAdditionalYear": 2023,
      "basis": "unchanged_reviewed_source_policy_assumptions",
      "boundedEvidenceRetentionDays": 90,
      "policyReviewIntervalDays": 180,
      "externalIndexAccess": "dejure_listing_discovery_only",
      "openLegalDataUse": "excluded_from_first_canary",
      "publicTextPosture": "metadata_only",
      "publicIntegrityNotice": "bverfg-korean-integrity-v1",
      "coverageLabel": "external_index_assisted_no_complete_corpus_claim",
      "canaryVisibility": "private_shadow",
      "geminiEgress": "denied"
    }
  }
  $json$::jsonb;
  v_existing source_corpus_policies%rowtype;
begin
  select p.* into v_existing
  from source_corpus_policies p
  where p.source_key = 'de-bverfg'
    and p.policy_version = 'bverfg-unattended-canary-v2';

  if found then
    if v_existing.scope_definition is distinct from v_scope
      or v_existing.official_scope_url is distinct from 'https://www.bundesverfassungsgericht.de/DE/Entscheidungen/entscheidungen_node.html'
      or v_existing.discovery_methods is distinct from array['external_index_dejure_paged_listing']::text[]
      or v_existing.authority_hosts is distinct from array['www.bundesverfassungsgericht.de']::text[]
      or v_existing.redirect_hosts is distinct from array['www.bverfg.de']::text[]
      or v_existing.external_index_hosts is distinct from array['dejure.org']::text[]
      or v_existing.robots_url is distinct from 'https://www.bundesverfassungsgericht.de/robots.txt'
      or v_existing.robots_observed_at is distinct from '2026-09-03T21:20:31Z'::timestamptz
      or v_existing.robots_rules_hash is distinct from '7565360aa0562e6f2a86d90f58566885b8bf9106e6e493453f1fc9079837e17f'
      or v_existing.terms_url is distinct from 'https://www.bundesverfassungsgericht.de/DE/Service/Impressum/impressum_node.html'
      or v_existing.terms_observed_at is distinct from '2026-09-03T21:20:31Z'::timestamptz
      or v_existing.license_basis is distinct from 'official-public-record'
      or v_existing.default_text_access_policy is distinct from 'metadata_only'
      or v_existing.allow_raw_snapshot is distinct from false
      or v_existing.normalize_replay_policy is distinct from 'bounded_evidence'
      or v_existing.bounded_replay_fields is distinct from array[
        'sourceKey', 'url', 'canonicalUrl', 'title',
        'publishedAt', 'contentType', 'text', 'metadata'
      ]::text[]
      or v_existing.retention_days is distinct from 90
      or v_existing.min_request_delay_ms is distinct from 30000
      or v_existing.max_concurrency is distinct from 1
      or v_existing.external_index_usage is distinct from 'Discovery identity only; never public or AI authority text.'
      or v_existing.reviewed_by is distinct from 'WorldCons owner via explicit approval'
      or v_existing.reviewed_at is distinct from '2026-09-16T00:00:00Z'::timestamptz
      or v_existing.review_due_at is distinct from '2027-03-15T00:00:00Z'::timestamptz
      or v_existing.supersedes_policy_version is distinct from 'bverfg-unattended-canary-v1'
    then
      raise exception using
        errcode = '23505',
        message = 'BVERFG_2023_POLICY_APPROVAL_CONFLICT';
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
    'de-bverfg',
    'bverfg-unattended-canary-v2',
    v_scope,
    'https://www.bundesverfassungsgericht.de/DE/Entscheidungen/entscheidungen_node.html',
    array['external_index_dejure_paged_listing'],
    array['www.bundesverfassungsgericht.de'],
    array['www.bverfg.de'],
    'https://www.bundesverfassungsgericht.de/robots.txt',
    '2026-09-03T21:20:31Z',
    '7565360aa0562e6f2a86d90f58566885b8bf9106e6e493453f1fc9079837e17f',
    'https://www.bundesverfassungsgericht.de/DE/Service/Impressum/impressum_node.html',
    '2026-09-03T21:20:31Z',
    'official-public-record',
    'metadata_only',
    false,
    'bounded_evidence',
    array['sourceKey', 'url', 'canonicalUrl', 'title', 'publishedAt', 'contentType', 'text', 'metadata'],
    90,
    30000,
    1,
    array['dejure.org'],
    'Discovery identity only; never public or AI authority text.',
    'WorldCons owner via explicit approval',
    '2026-09-16T00:00:00Z',
    '2027-03-15T00:00:00Z',
    'bverfg-unattended-canary-v1'
  );
end;
$approval$;

commit;
