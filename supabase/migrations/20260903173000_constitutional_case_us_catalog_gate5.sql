begin;

-- US Track A publication keeps candidate review provenance outside the source
-- version document. Re-reviewing unchanged official material must not advance
-- the authoritative source anchor or make current AI enrichment stale.

alter table us_conan_case_candidates_v1
  add constraint us_conan_case_candidates_id_snapshot_key unique (id, snapshot_id);
alter table us_conan_candidate_reviews_v1
  add constraint us_conan_candidate_reviews_id_candidate_revision_key unique (id, candidate_id, revision);
alter table us_conan_candidate_authority_artifacts_v1
  add constraint us_conan_candidate_authority_id_candidate_key unique (id, candidate_id);
alter table article_content_versions_p3
  add constraint article_content_versions_p3_id_article_revision_us_key unique (id, article_id, revision);

create table us_conan_candidate_catalog_events_v1 (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null,
  candidate_snapshot_id uuid not null,
  candidate_manifest_hash text not null,
  review_id uuid not null,
  review_revision integer not null,
  authority_artifact_id uuid not null,
  publication_source_key text not null default 'us-scotus',
  source_policy_version text not null,
  article_id uuid not null references articles(id) on delete restrict,
  source_anchor_version_id uuid not null,
  version_revision bigint not null,
  catalog_publication_id uuid not null references case_catalog_publications_v1(id) on delete restrict,
  publication_revision bigint not null,
  idempotency_key text not null unique,
  actor_id text not null,
  created_at timestamptz not null default now(),
  foreign key (candidate_id, candidate_snapshot_id)
    references us_conan_case_candidates_v1(id, snapshot_id) on delete restrict,
  foreign key (review_id, candidate_id, review_revision)
    references us_conan_candidate_reviews_v1(id, candidate_id, revision) on delete restrict,
  foreign key (authority_artifact_id, candidate_id)
    references us_conan_candidate_authority_artifacts_v1(id, candidate_id) on delete restrict,
  foreign key (publication_source_key, source_policy_version)
    references source_corpus_policies(source_key, policy_version) on delete restrict,
  foreign key (source_anchor_version_id, article_id)
    references article_content_versions_p3(id, article_id) on delete restrict,
  foreign key (source_anchor_version_id, article_id, version_revision)
    references article_content_versions_p3(id, article_id, revision) on delete restrict,
  foreign key (catalog_publication_id, publication_revision)
    references case_catalog_publication_events_v1(publication_id, publication_revision) on delete restrict,
  constraint us_conan_candidate_catalog_source_check check (publication_source_key = 'us-scotus'),
  constraint us_conan_candidate_catalog_hash_check check (candidate_manifest_hash ~ '^[0-9a-f]{64}$'),
  constraint us_conan_candidate_catalog_revision_check check (
    review_revision > 0 and version_revision > 0 and publication_revision > 0
  ),
  constraint us_conan_candidate_catalog_text_check check (
    idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,239}$'
    and length(actor_id) between 1 and 160
  )
);

drop trigger if exists us_conan_candidate_catalog_events_immutable_trigger on us_conan_candidate_catalog_events_v1;
create trigger us_conan_candidate_catalog_events_immutable_trigger
before update or delete on us_conan_candidate_catalog_events_v1
for each row execute function case_catalog_immutable_v1();

create or replace function us_conan_candidate_publish_catalog_v1(
  p_candidate_id uuid,
  p_expected_review_revision integer,
  p_source_policy_version text,
  p_expected_catalog_revision bigint,
  p_idempotency_key text,
  p_actor_id text
)
returns table(
  event_id uuid,
  article_id uuid,
  version_id uuid,
  version_revision bigint,
  publication_revision bigint,
  article_slug text,
  applied boolean,
  idempotent boolean
)
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $function$
declare
  v_existing us_conan_candidate_catalog_events_v1%rowtype;
  v_candidate us_conan_case_candidates_v1%rowtype;
  v_candidate_snapshot us_conan_candidate_snapshots_v1%rowtype;
  v_candidate_policy source_corpus_policies%rowtype;
  v_policy source_corpus_policies%rowtype;
  v_review us_conan_candidate_reviews_v1%rowtype;
  v_authority us_conan_candidate_authority_artifacts_v1%rowtype;
  v_source_id uuid;
  v_article articles%rowtype;
  v_canonical_article_id uuid;
  v_parts text[];
  v_granule_id text;
  v_normalized_reporter text;
  v_normalized_source_record text;
  v_slug text;
  v_essay_public jsonb;
  v_public_metadata jsonb;
  v_authority_evidence jsonb;
  v_authority_hash text;
  v_identifier_snapshot jsonb;
  v_case_snapshot jsonb;
  v_content_snapshot jsonb;
  v_global_revision bigint;
  v_version record;
  v_publication record;
  v_event us_conan_candidate_catalog_events_v1%rowtype;
begin
  if p_expected_review_revision < 1 or p_expected_catalog_revision < 0
    or length(trim(coalesce(p_source_policy_version, ''))) not between 1 and 80
    or coalesce(p_idempotency_key, '') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,239}$'
    or length(trim(coalesce(p_actor_id, ''))) not between 1 and 160
  then raise exception using errcode = '22023', message = 'US_CONAN_CATALOG_INVALID_INPUT'; end if;

  perform pg_advisory_xact_lock(hashtextextended(p_candidate_id::text, 1730));
  select e.* into v_existing from us_conan_candidate_catalog_events_v1 e
  where e.idempotency_key = p_idempotency_key;
  if found then
    if v_existing.candidate_id <> p_candidate_id
      or v_existing.review_revision <> p_expected_review_revision
      or v_existing.source_policy_version <> trim(p_source_policy_version)
    then raise exception using errcode = '23505', message = 'US_CONAN_CATALOG_IDEMPOTENCY_CONFLICT'; end if;
    return query select v_existing.id,v_existing.article_id,v_existing.source_anchor_version_id,
      v_existing.version_revision,v_existing.publication_revision,
      (select a.slug from articles a where a.id = v_existing.article_id),false,true;
    return;
  end if;

  select c.* into v_candidate from us_conan_case_candidates_v1 c where c.id = p_candidate_id;
  if not found or v_candidate.court_classification <> 'scotus_candidate' then
    raise exception using errcode = '23514', message = 'US_CONAN_CATALOG_SCOTUS_CANDIDATE_REQUIRED';
  end if;
  select s.* into v_candidate_snapshot from us_conan_candidate_snapshots_v1 s
  where s.id = v_candidate.snapshot_id and s.status = 'closed';
  if not found or v_candidate_snapshot.manifest_hash is null then
    raise exception using errcode = '23514', message = 'US_CONAN_CATALOG_CLOSED_MANIFEST_REQUIRED';
  end if;
  select p.* into v_candidate_policy from source_corpus_policies p
  where p.source_key = v_candidate_snapshot.source_key and p.policy_version = v_candidate_snapshot.source_policy_version;
  if not found or v_candidate_policy.review_due_at <= now() then
    raise exception using errcode = '55000', message = 'SOURCE_POLICY_REVIEW_OVERDUE';
  end if;

  select r.* into v_review from us_conan_candidate_reviews_v1 r
  where r.candidate_id = p_candidate_id order by r.revision desc limit 1;
  if not found or v_review.revision <> p_expected_review_revision then
    raise exception using errcode = '40001', message = 'US_CONAN_CATALOG_REVIEW_STALE';
  end if;
  if v_review.status <> 'verified' or not v_review.official_scotus_identity_verified
    or not v_review.constitutional_essay_context_verified or not v_review.official_authority_verified
    or not v_review.constitutional_holding_verified or v_review.authority_artifact_id is null
    or cardinality(v_review.essay_evidence_ids) = 0 or jsonb_array_length(v_review.holding_evidence) = 0
  then raise exception using errcode = '23514', message = 'US_CONAN_CATALOG_VERIFIED_REVIEW_REQUIRED'; end if;

  select a.* into v_authority from us_conan_candidate_authority_current_v1 a
  where a.candidate_id = p_candidate_id;
  if not found or v_authority.id <> v_review.authority_artifact_id or v_authority.status <> 'verified'
    or v_authority.payload_hash is null or v_authority.pdf_url is null
    or v_review.official_authority_url <> v_authority.details_url
  then raise exception using errcode = '23514', message = 'US_CONAN_CATALOG_CURRENT_AUTHORITY_REQUIRED'; end if;
  if cardinality(v_review.essay_evidence_ids) <> (
    select count(distinct e.id)::integer from us_conan_candidate_essay_evidence_v1 e
    where e.candidate_id = p_candidate_id and e.id = any(v_review.essay_evidence_ids)
  ) then raise exception using errcode = '23514', message = 'US_CONAN_CATALOG_ESSAY_EVIDENCE_INVALID'; end if;

  select p.* into v_policy from source_corpus_policies p
  where p.source_key = 'us-scotus' and p.policy_version = trim(p_source_policy_version);
  if not found then raise exception using errcode = '23503', message = 'US_CONAN_CATALOG_SOURCE_POLICY_REQUIRED'; end if;
  if v_policy.review_due_at <= now() then raise exception using errcode = '55000', message = 'SOURCE_POLICY_REVIEW_OVERDUE'; end if;
  if not ('www.govinfo.gov' = any(v_policy.authority_hosts))
    or v_policy.default_text_access_policy not in ('metadata_only', 'index_only')
  then raise exception using errcode = '23514', message = 'US_CONAN_CATALOG_SOURCE_POLICY_INVALID'; end if;

  v_parts := regexp_match(v_authority.details_url, '/USREPORTS-([0-9]+)/USREPORTS-[0-9]+-([0-9]+)$');
  if v_parts is null then raise exception using errcode = '23514', message = 'US_CONAN_CATALOG_AUTHORITY_IDENTITY_INVALID'; end if;
  v_granule_id := format('USREPORTS-%s-%s', v_parts[1], v_parts[2]);
  v_normalized_reporter := lower(regexp_replace(v_candidate.normalized_citation, '[^[:alnum:]]', '', 'g'));
  v_normalized_source_record := lower(format('usreports%s%s', v_parts[1], v_parts[2]));
  v_slug := lower(format('us-scotus-%s-us-%s', v_parts[1], v_parts[2]));

  select a.* into v_article from case_identifiers_v1 ci join articles a on a.id = ci.article_id
  where ci.source_key = 'us-scotus' and ci.identifier_type = 'reporter_citation'
    and ci.normalized_value = v_normalized_reporter;
  select a.id into v_canonical_article_id from articles a where a.canonical_url = v_authority.details_url;
  if v_article.id is not null and v_canonical_article_id is not null and v_canonical_article_id <> v_article.id then
    raise exception using errcode = '23505', message = 'US_CONAN_CATALOG_IDENTITY_CONFLICT';
  end if;
  if v_article.id is null and v_canonical_article_id is not null then
    select a.* into v_article from articles a where a.id = v_canonical_article_id;
  end if;
  if v_article.id is null then
    select s.id into v_source_id from sources s where s.source_key = 'us-scotus';
    if v_source_id is null then raise exception using errcode = '23503', message = 'US_CONAN_CATALOG_SOURCE_NOT_FOUND'; end if;
    insert into articles(
      source_id,source_key,jurisdiction,institution_name,content_type,original_url,canonical_url,
      original_language,original_title,original_published_at,discovered_at,fetched_at,status,slug,
      raw_text,cleaned_text,summary_json,source_metadata,error_metadata
    ) values (
      v_source_id,'us-scotus','United States','Supreme Court of the United States','opinion',
      v_authority.details_url,v_authority.details_url,'en',v_authority.official_case_name,null,
      now(),v_authority.observed_at,'metadata_only',v_slug,null,null,null,
      jsonb_build_object('collection',jsonb_build_object('publishable',false,'strategy','catalog-private-shadow')),
      null
    ) returning * into v_article;
  elsif v_article.source_key <> 'us-scotus' then
    raise exception using errcode = '23505', message = 'US_CONAN_CATALOG_IDENTITY_CONFLICT';
  end if;

  insert into case_identifiers_v1(
    article_id,source_key,identifier_type,identifier_scope,raw_value,normalized_value,is_primary,provenance_url
  ) values (
    v_article.id,'us-scotus','reporter_citation','decision',v_candidate.citation,v_normalized_reporter,
    not exists(select 1 from case_identifiers_v1 existing where existing.article_id = v_article.id and existing.is_primary),
    v_authority.details_url
  ) on conflict (source_key,identifier_type,normalized_value)
    where identifier_type in ('source_record_id','ecli','hj_id','reporter_citation') do nothing;
  if not exists(select 1 from case_identifiers_v1 ci where ci.article_id = v_article.id
    and ci.source_key = 'us-scotus' and ci.identifier_type = 'reporter_citation'
    and ci.normalized_value = v_normalized_reporter)
  then raise exception using errcode = '23505', message = 'US_CONAN_CATALOG_IDENTIFIER_CONFLICT'; end if;
  insert into case_identifiers_v1(
    article_id,source_key,identifier_type,identifier_scope,raw_value,normalized_value,is_primary,provenance_url
  ) values (
    v_article.id,'us-scotus','source_record_id','decision',v_granule_id,v_normalized_source_record,false,v_authority.details_url
  ) on conflict (source_key,identifier_type,normalized_value)
    where identifier_type in ('source_record_id','ecli','hj_id','reporter_citation') do nothing;
  if not exists(select 1 from case_identifiers_v1 ci where ci.article_id = v_article.id
    and ci.source_key = 'us-scotus' and ci.identifier_type = 'source_record_id'
    and ci.normalized_value = v_normalized_source_record)
  then raise exception using errcode = '23505', message = 'US_CONAN_CATALOG_IDENTIFIER_CONFLICT'; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'essayId',e.essay_id,'title',e.essay_title,'url',e.essay_url
  ) order by e.essay_id), '[]'::jsonb) into v_essay_public
  from us_conan_candidate_essay_evidence_v1 e
  where e.candidate_id = p_candidate_id and e.id = any(v_review.essay_evidence_ids);
  v_public_metadata := jsonb_build_object(
    'reporterCitation',v_candidate.citation,
    'officialPdfUrl',v_authority.pdf_url,
    'constitutionAnnotated',jsonb_build_object('sourceUrl',v_candidate_snapshot.source_url,'essays',v_essay_public),
    'decisionDate',case when v_article.original_published_at is null
      then jsonb_build_object('status','unknown','reason','not_present_in_verified_govinfo_metadata')
      else jsonb_build_object('status','existing_official_article','value',v_article.original_published_at) end
  );
  v_authority_evidence := jsonb_build_object(
    'candidateSnapshotId',v_candidate_snapshot.id,'candidateManifestHash',v_candidate_snapshot.manifest_hash,
    'candidateSourcePolicyVersion',v_candidate_snapshot.source_policy_version,
    'authorityArtifactId',v_authority.id,'authorityPayloadHash',v_authority.payload_hash,
    'authorityObservedAt',v_authority.observed_at,'detailsUrl',v_authority.details_url,'pdfUrl',v_authority.pdf_url,
    'essayEvidenceIds',v_review.essay_evidence_ids
  );
  v_authority_hash := encode(extensions.digest(convert_to(v_authority_evidence::text, 'UTF8'), 'sha256'), 'hex');

  insert into case_metadata_v1(
    article_id,source_key,authority_status,authority_evidence,constitutional_relevance_status,
    enrichment_status,enrichment_freshness,freshness_basis,text_access_policy,source_policy_version,
    discovery_source,authority_source,source_snapshot_hash,ai_priority
  ) values (
    v_article.id,'us-scotus','verified',v_authority_evidence,'verified','source_only',null,null,
    v_policy.default_text_access_policy,v_policy.policy_version,'constitution_annotated_table_citation',
    v_authority.details_url,v_candidate_snapshot.manifest_hash,v_candidate.priority
  ) on conflict on constraint case_metadata_v1_pkey do update set
    authority_status = excluded.authority_status,authority_evidence = excluded.authority_evidence,
    constitutional_relevance_status = excluded.constitutional_relevance_status,
    enrichment_status = 'source_only',enrichment_freshness = null,freshness_basis = null,
    text_access_policy = excluded.text_access_policy,source_policy_version = excluded.source_policy_version,
    discovery_source = excluded.discovery_source,authority_source = excluded.authority_source,
    source_snapshot_hash = excluded.source_snapshot_hash,ai_priority = excluded.ai_priority,updated_at = now();
  select coalesce(jsonb_agg(jsonb_build_object(
    'type',ci.identifier_type,'scope',ci.identifier_scope,'value',ci.raw_value,
    'normalizedValue',ci.normalized_value,'normalizationVersion',ci.normalization_version,'primary',ci.is_primary
  ) order by ci.identifier_type,ci.normalized_value), '[]'::jsonb)
  into v_identifier_snapshot from case_identifiers_v1 ci where ci.article_id = v_article.id;
  v_case_snapshot := jsonb_build_object(
    'authorityStatus','verified','constitutionalRelevanceStatus','verified',
    'textAccessPolicy',v_policy.default_text_access_policy,'sourcePolicyVersion',v_policy.policy_version,
    'sourceMetadata',v_public_metadata
  );
  v_content_snapshot := jsonb_build_object(
    'jurisdiction','United States','institutionName','Supreme Court of the United States',
    'contentType','opinion','originalUrl',v_authority.details_url,'canonicalUrl',v_authority.details_url,
    'originalLanguage','en','originalTitle',v_authority.official_case_name,'cleanedText','',
    'metadata',v_public_metadata
  );
  select coalesce(h.current_revision, 0) into v_global_revision
  from article_revision_heads_v4 h where h.article_id = v_article.id;
  v_global_revision := coalesce(v_global_revision, 0);
  select * into v_version from article_version_capture_v4(
    v_article.id,v_global_revision,'authoritative_source',null,v_authority.payload_hash,null,
    v_case_snapshot,v_identifier_snapshot,v_authority_hash,null,v_candidate_snapshot.manifest_hash,
    'human',trim(p_actor_id),null,null,v_content_snapshot
  );
  select * into v_publication from case_catalog_publication_transition_v1(
    v_article.id,v_version.version_id,p_expected_catalog_revision,p_idempotency_key,
    'published','human',trim(p_actor_id),'Evidence-bound U.S. constitutional case Catalog publication.'
  );
  insert into us_conan_candidate_catalog_events_v1(
    candidate_id,candidate_snapshot_id,candidate_manifest_hash,review_id,review_revision,
    authority_artifact_id,source_policy_version,article_id,source_anchor_version_id,
    version_revision,catalog_publication_id,publication_revision,idempotency_key,actor_id
  ) values (
    v_candidate.id,v_candidate_snapshot.id,v_candidate_snapshot.manifest_hash,v_review.id,v_review.revision,
    v_authority.id,v_policy.policy_version,v_article.id,v_version.version_id,v_version.version_revision,
    v_publication.publication_id,v_publication.publication_revision,p_idempotency_key,trim(p_actor_id)
  ) returning * into v_event;
  return query select v_event.id,v_article.id,v_version.version_id,v_version.version_revision,
    v_publication.publication_revision,v_article.slug,v_publication.applied,false;
end;
$function$;

alter table us_conan_candidate_catalog_events_v1 enable row level security;
revoke all on table us_conan_candidate_catalog_events_v1 from public;
revoke all on function us_conan_candidate_publish_catalog_v1(uuid, integer, text, bigint, text, text) from public;

do $permissions$
begin
  if exists(select 1 from pg_roles where rolname = 'anon') then
    revoke all on table us_conan_candidate_catalog_events_v1 from anon;
  end if;
  if exists(select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on table us_conan_candidate_catalog_events_v1 from authenticated;
  end if;
  if exists(select 1 from pg_roles where rolname = 'service_role') then
    grant select on table us_conan_candidate_catalog_events_v1 to service_role;
    grant execute on function us_conan_candidate_publish_catalog_v1(uuid, integer, text, bigint, text, text) to service_role;
  end if;
end;
$permissions$;

comment on table us_conan_candidate_catalog_events_v1
  is 'Immutable evidence-bound bridge from a human-reviewed Constitution Annotated candidate to a Catalog source anchor.';

commit;
