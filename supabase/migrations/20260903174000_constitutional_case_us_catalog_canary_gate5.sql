begin;

-- One read-only, transaction-consistent evidence document for the operational
-- U.S. Catalog canary. It intentionally exposes IDs and bounded state only to
-- service_role; it does not return holding text or mutable article payloads.
create or replace function us_conan_candidate_catalog_canary_v1(p_candidate_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, extensions, pg_temp
set statement_timeout = '5s'
as $function$
  select coalesce((
    select jsonb_build_object(
      'candidateFound', true,
      'candidateId', c.id,
      'citation', c.citation,
      'candidateSnapshotStatus', s.status,
      'candidateManifestHash', s.manifest_hash,
      'candidatePolicyVersion', s.source_policy_version,
      'candidatePolicyReviewDueAt', candidate_policy.review_due_at,
      'currentReviewId', review.id,
      'currentReviewRevision', coalesce(review.revision, 0),
      'currentReviewStatus', coalesce(review.status, 'candidate'),
      'currentReviewAuthorityArtifactId', review.authority_artifact_id,
      'currentAuthorityArtifactId', authority.id,
      'currentAuthorityStatus', authority.status,
      'currentAuthorityPayloadHash', authority.payload_hash,
      'eventId', event.id,
      'eventReviewId', event.review_id,
      'eventReviewRevision', event.review_revision,
      'eventAuthorityArtifactId', event.authority_artifact_id,
      'eventCandidateManifestHash', event.candidate_manifest_hash,
      'eventSourcePolicyVersion', event.source_policy_version,
      'eventCreatedAt', event.created_at
    ) || jsonb_build_object(
      'articleId', article.id,
      'articleSlug', article.slug,
      'articleSourceKey', article.source_key,
      'catalogPublicationId', catalog.id,
      'catalogPublicationState', catalog.state,
      'catalogPublicationRevision', catalog.revision,
      'catalogSourceAnchorVersionId', catalog.source_anchor_version_id,
      'catalogSourcePolicyVersion', catalog.source_policy_version,
      'publicationPolicyReviewDueAt', publication_policy.review_due_at,
      'sourceAnchorVersionId', anchor.id,
      'sourceAnchorRevision', anchor.revision,
      'sourceAnchorRole', anchor.version_role,
      'sourceAnchorSelfId', anchor.source_anchor_version_id,
      'sourceAnchorContentHash', anchor.source_content_hash,
      'sourceAnchorSnapshotHash', anchor.source_snapshot_hash,
      'sourceAnchorSummaryPresent', anchor.summary_json is not null,
      'sourceAnchorEmbeddingPresent', anchor.embedding is not null,
      'caseAuthorityStatus', metadata.authority_status,
      'caseConstitutionalStatus', metadata.constitutional_relevance_status,
      'caseEnrichmentStatus', metadata.enrichment_status,
      'caseTextAccessPolicy', metadata.text_access_policy,
      'caseSourcePolicyVersion', metadata.source_policy_version,
      'publicDetailArticleId', detail.id,
      'publicDetailVersionId', detail.article_version_id,
      'publicDetailVersionRole', detail.version_role,
      'publicDetailEnrichmentStatus', detail.enrichment_status,
      'publicDetailSummaryAvailable', detail.summary_available,
      'publicDetailSummaryPresent', detail.summary_json is not null,
      'p3PublicationState', p3.state,
      'p3PublicationVersionId', p3.version_id
    )
    from us_conan_case_candidates_v1 c
    join us_conan_candidate_snapshots_v1 s on s.id = c.snapshot_id
    left join source_corpus_policies candidate_policy
      on candidate_policy.source_key = s.source_key
      and candidate_policy.policy_version = s.source_policy_version
    left join lateral (
      select r.* from us_conan_candidate_reviews_v1 r
      where r.candidate_id = c.id order by r.revision desc limit 1
    ) review on true
    left join us_conan_candidate_authority_current_v1 authority on authority.candidate_id = c.id
    left join lateral (
      select e.* from us_conan_candidate_catalog_events_v1 e
      where e.candidate_id = c.id order by e.created_at desc, e.id desc limit 1
    ) event on true
    left join articles article on article.id = event.article_id
    left join case_catalog_publications_v1 catalog on catalog.id = event.catalog_publication_id
    left join source_corpus_policies publication_policy
      on publication_policy.source_key = event.publication_source_key
      and publication_policy.policy_version = event.source_policy_version
    left join article_content_versions_p3 anchor on anchor.id = event.source_anchor_version_id
    left join case_metadata_v1 metadata on metadata.article_id = event.article_id
    left join public_article_detail_v4 detail on detail.id = event.article_id
    left join article_publications_p3 p3 on p3.article_id = event.article_id
    where c.id = p_candidate_id
  ), jsonb_build_object('candidateFound', false, 'candidateId', p_candidate_id));
$function$;

revoke all on function us_conan_candidate_catalog_canary_v1(uuid) from public;

do $permissions$
begin
  if exists(select 1 from pg_roles where rolname = 'anon') then
    revoke all on function us_conan_candidate_catalog_canary_v1(uuid) from anon;
  end if;
  if exists(select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function us_conan_candidate_catalog_canary_v1(uuid) from authenticated;
  end if;
  if exists(select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function us_conan_candidate_catalog_canary_v1(uuid) to service_role;
  end if;
end;
$permissions$;

comment on function us_conan_candidate_catalog_canary_v1(uuid)
  is 'Read-only service-role evidence for an evidence-bound U.S. Catalog publication canary.';

commit;
