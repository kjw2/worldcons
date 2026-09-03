begin;

create or replace function case_backfill_bverfg_shadow_canary_v1(p_snapshot_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions, pg_temp
as $function$
declare
  v_snapshot source_inventory_snapshots%rowtype;
  v_policy source_corpus_policies%rowtype;
  v_enumeration_hash text;
begin
  select s.* into v_snapshot from source_inventory_snapshots s where s.id=p_snapshot_id;
  if not found then
    return jsonb_build_object('snapshotFound',false,'snapshotId',p_snapshot_id);
  end if;
  select p.* into v_policy from source_corpus_policies p
  where p.source_key=v_snapshot.source_key and p.policy_version=v_snapshot.source_policy_version;
  select case when count(*)=0 then null else encode(extensions.digest(convert_to(string_agg(
    jsonb_build_array(
      a.provider_key,a.artifact_kind,a.sequence_no,a.request_url,
      a.response_hash,a.record_manifest_hash,a.record_count,
      a.newest_decision_date,a.oldest_decision_date,a.observed_last_page,a.safe_details
    )::text,E'\n' order by a.provider_key,a.artifact_kind,a.sequence_no
  ),'UTF8'),'sha256'),'hex') end
  into v_enumeration_hash
  from source_inventory_enumeration_artifacts a where a.snapshot_id=v_snapshot.id;

  return jsonb_build_object(
    'snapshotFound',true,
    'snapshotId',v_snapshot.id,
    'sourceKey',v_snapshot.source_key,
    'scopeFrom',v_snapshot.scope_from,
    'scopeTo',v_snapshot.scope_to,
    'documentType',v_snapshot.document_type,
    'snapshotStatus',v_snapshot.status,
    'coverageAssurance',v_snapshot.coverage_assurance,
    'coverageEvidence',v_snapshot.coverage_evidence,
    'discoveredCount',v_snapshot.discovered_count,
    'manifestHash',v_snapshot.manifest_hash,
    'enumerationManifestHash',v_snapshot.enumeration_manifest_hash,
    'recomputedEnumerationManifestHash',v_enumeration_hash,
    'sourcePolicyFound',v_policy.source_key is not null,
    'sourcePolicyVersion',v_snapshot.source_policy_version,
    'sourcePolicyReviewDueAt',v_policy.review_due_at,
    'enumerationArtifactCount',(select count(*) from source_inventory_enumeration_artifacts e where e.snapshot_id=v_snapshot.id),
    'pageArtifactCount',(select count(*) from source_inventory_enumeration_artifacts e where e.snapshot_id=v_snapshot.id and e.provider_key='dejure.org' and e.artifact_kind='page'),
    'boundaryProbeCount',(select count(*) from source_inventory_enumeration_artifacts e where e.snapshot_id=v_snapshot.id and e.provider_key='dejure.org' and e.artifact_kind='boundary_probe'),
    'pageSequenceContiguous',coalesce((select min(e.sequence_no)=1 and max(e.sequence_no)=count(*) and count(distinct e.sequence_no)=count(*)
      from source_inventory_enumeration_artifacts e
      where e.snapshot_id=v_snapshot.id and e.provider_key='dejure.org' and e.artifact_kind='page'),false),
    'externalTextEvidenceCount',(select count(*) from source_inventory_enumeration_artifacts e
      where e.snapshot_id=v_snapshot.id and e.safe_details->>'storesExternalText' is distinct from 'false'),
    'itemCount',(select count(*) from source_backfill_items i where i.snapshot_id=v_snapshot.id),
    'resolvedOfficialUrlCount',(select count(*) from source_backfill_items i where i.snapshot_id=v_snapshot.id and i.inventory_metadata->'officialUrlResolved'='true'::jsonb),
    'unresolvedActionableCount',(select count(*) from source_backfill_items i where i.snapshot_id=v_snapshot.id
      and i.inventory_metadata->'officialUrlResolved' is distinct from 'true'::jsonb
      and i.status not in ('excluded','duplicate','waived_failure','withdrawn')),
    'invalidInventoryCount',(select count(*) from source_backfill_items i where i.snapshot_id=v_snapshot.id
      and i.inventory_metadata->'officialUrlResolved'='true'::jsonb
      and not case_catalog_germany_inventory_attribution_valid_v1(
        i.inventory_metadata,i.inventory_metadata->'officialUrlCandidates'->>0
      )),
    'verifiedCount',(select count(*) from source_backfill_items i where i.snapshot_id=v_snapshot.id and i.verified_normalization_artifact_id is not null),
    'invalidVerifiedAuthorityCount',(select count(*) from source_backfill_items i where i.snapshot_id=v_snapshot.id
      and i.verified_normalization_artifact_id is not null
      and not case_catalog_germany_inventory_attribution_valid_v1(i.inventory_metadata,i.authority_url)),
    'excludedCount',(select count(*) from source_backfill_items i where i.snapshot_id=v_snapshot.id and i.status in ('excluded','duplicate','waived_failure','withdrawn')),
    'terminalFailureCount',(select count(*) from source_backfill_items i where i.snapshot_id=v_snapshot.id and i.status='terminal_failure'),
    'retryWaitCount',(select count(*) from source_backfill_items i where i.snapshot_id=v_snapshot.id and i.status='retry_wait'),
    'activeClaimCount',(select count(*) from source_backfill_items i where i.snapshot_id=v_snapshot.id and i.claimed_attempt_id is not null),
    'publishedItemCount',(select count(*) from source_backfill_items i where i.snapshot_id=v_snapshot.id and i.status='published'),
    'articleLinkedCount',(select count(*) from source_backfill_items i where i.snapshot_id=v_snapshot.id and i.article_id is not null),
    'catalogPublicationCount',(select count(*) from article_content_versions_p3 v
      join case_catalog_publications_v1 c on c.source_anchor_version_id=v.id and c.state='published'
      where v.source_snapshot_id=v_snapshot.id),
    'aiPayloadCount',(
      (select count(*) from source_normalization_artifacts n
        join source_backfill_items i on i.id=n.item_id
        where i.snapshot_id=v_snapshot.id and (
          n.normalized_output ? 'summaryJson' or n.normalized_output ? 'koreanTitle'
          or n.normalized_output ? 'embedding' or n.normalized_output ? 'ai'
        ))
      +
      (select count(*) from article_content_versions_p3 v where v.source_snapshot_id=v_snapshot.id
        and (v.summary_json is not null or v.embedding is not null))
    )
  );
end;
$function$;

revoke all on function case_backfill_bverfg_shadow_canary_v1(uuid) from public;

do $permissions$
begin
  if exists(select 1 from pg_roles where rolname='anon') then
    revoke execute on function case_backfill_bverfg_shadow_canary_v1(uuid) from anon;
  end if;
  if exists(select 1 from pg_roles where rolname='authenticated') then
    revoke execute on function case_backfill_bverfg_shadow_canary_v1(uuid) from authenticated;
  end if;
  if exists(select 1 from pg_roles where rolname='service_role') then
    grant execute on function case_backfill_bverfg_shadow_canary_v1(uuid) to service_role;
  end if;
end;
$permissions$;

comment on function case_backfill_bverfg_shadow_canary_v1(uuid) is
  'Read-only evidence bundle for the BVerfG private-shadow completion gate; reports enumeration integrity, authority verification, publication leakage, and AI payload leakage.';

commit;
