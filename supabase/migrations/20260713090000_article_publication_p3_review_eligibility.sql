create table if not exists article_publication_quarantine_resolutions_p3 (
  article_id uuid not null,
  anomaly_code text not null,
  resolution_code text not null,
  resolved_at timestamptz not null default now(),
  primary key (article_id, anomaly_code),
  foreign key (article_id, anomaly_code)
    references article_publication_quarantine_p3(article_id, anomaly_code)
    on delete restrict,
  constraint article_publication_quarantine_resolution_code_check
    check (resolution_code ~ '^resolution\.[a-z0-9._-]{1,110}$')
);

alter table article_publication_quarantine_resolutions_p3 enable row level security;
revoke all on table article_publication_quarantine_resolutions_p3 from public;

drop trigger if exists article_publication_quarantine_resolutions_p3_immutable_trigger
  on article_publication_quarantine_resolutions_p3;
create trigger article_publication_quarantine_resolutions_p3_immutable_trigger
before update or delete on article_publication_quarantine_resolutions_p3
for each row execute function article_publication_immutable_p3();

create or replace function article_publication_eligible_p3(
  p_article articles,
  p_version article_content_versions_p3
)
returns boolean
language sql
stable
as $$
  select
    p_article.lifecycle_collection_state = 'source_text_ready'
    and p_article.lifecycle_processing_state = 'complete'
    and p_article.lifecycle_review_state in ('unreviewed', 'approved_for_processing', 'approved')
    and p_article.lifecycle_attention_state = 'clear'
    and length(trim(coalesce(p_version.slug, ''))) > 0
    and length(trim(coalesce(p_version.source_key, ''))) > 0
    and length(trim(coalesce(p_version.jurisdiction, ''))) > 0
    and length(trim(coalesce(p_version.institution_name, ''))) > 0
    and length(trim(coalesce(p_version.original_url, ''))) > 0
    and length(trim(coalesce(p_version.canonical_url, ''))) > 0
    and length(trim(coalesce(p_version.original_language, ''))) > 0
    and length(trim(coalesce(p_version.korean_title, p_version.original_title, ''))) > 0
    and p_version.summary_json is not null
    and length(trim(coalesce(p_version.cleaned_text, ''))) >= 500
    and p_version.source_metadata #>> '{collection,publishable}' = 'true'
    and p_version.source_metadata #>> '{collection,sourceTextAvailable}' = 'true'
    and p_version.source_metadata #>> '{collection,sourceUrlVerified}' = 'true'
    and coalesce(p_version.source_metadata #>> '{collection,robotsDisallowed}', 'false') <> 'true'
    and coalesce(p_version.source_metadata #>> '{collection,strategy}', '') <> 'seed';
$$;

create or replace function article_publication_backfill_anomaly_p3(p_article articles)
returns text
language sql
stable
as $$
  select case
    when p_article.lifecycle_collection_state is null
      or p_article.lifecycle_processing_state is null
      or p_article.lifecycle_review_state is null
      or p_article.lifecycle_attention_state is null
      then 'backfill.lifecycle_missing'
    when p_article.lifecycle_attention_state <> 'clear'
      then 'backfill.lifecycle_attention_not_clear'
    when p_article.status = 'summarized'
      and p_article.source_metadata #>> '{collection,publishable}' = 'true'
      and p_article.lifecycle_collection_state <> 'source_text_ready'
      then 'backfill.public_collection_ineligible'
    when p_article.status = 'summarized'
      and p_article.source_metadata #>> '{collection,publishable}' = 'true'
      and p_article.lifecycle_processing_state <> 'complete'
      then 'backfill.public_processing_ineligible'
    when p_article.status = 'summarized'
      and p_article.source_metadata #>> '{collection,publishable}' = 'true'
      and p_article.lifecycle_review_state not in ('unreviewed', 'approved_for_processing', 'approved')
      then 'backfill.public_review_ineligible'
    when p_article.status = 'summarized'
      and p_article.source_metadata #>> '{collection,publishable}' = 'true'
      and p_article.summary_json is null
      then 'backfill.public_summary_missing'
    when p_article.status = 'summarized'
      and p_article.source_metadata #>> '{collection,publishable}' = 'true'
      and length(trim(coalesce(p_article.cleaned_text, ''))) < 500
      then 'backfill.public_text_too_short'
    when p_article.status = 'summarized'
      and p_article.source_metadata #>> '{collection,publishable}' = 'true'
      and (
        p_article.source_metadata #>> '{collection,sourceTextAvailable}' is distinct from 'true'
        or p_article.source_metadata #>> '{collection,sourceUrlVerified}' is distinct from 'true'
        or coalesce(p_article.source_metadata #>> '{collection,robotsDisallowed}', 'false') = 'true'
        or coalesce(p_article.source_metadata #>> '{collection,strategy}', '') = 'seed'
      )
      then 'backfill.public_source_policy_invalid'
    when article_publication_json_has_secret_p3(coalesce(p_article.source_metadata, '{}'::jsonb))
      or article_publication_json_has_secret_p3(coalesce(p_article.error_metadata, '{}'::jsonb))
      then 'backfill.secret_like_metadata'
    else null
  end;
$$;

do $$
declare
  v_row record;
  v_result record;
begin
  for v_row in
    select
      q.article_id,
      h.current_version_id,
      h.current_revision as version_revision,
      p.revision as publication_revision
    from article_publication_quarantine_p3 q
    join articles a on a.id = q.article_id
    join article_version_heads_p3 h on h.article_id = q.article_id
    join article_content_versions_p3 v on v.id = h.current_version_id
    join article_publications_p3 p on p.article_id = q.article_id
    left join article_publication_quarantine_resolutions_p3 r
      on r.article_id = q.article_id and r.anomaly_code = q.anomaly_code
    where q.anomaly_code = 'backfill.public_review_ineligible'
      and q.legacy_public
      and r.article_id is null
      and p.state = 'draft'
      and a.lifecycle_review_state = 'approved_for_processing'
      and article_publication_eligible_p3(a, v)
  loop
    select * into v_result
    from article_publication_transition_p3(
      v_row.article_id,
      v_row.version_revision,
      v_row.publication_revision,
      'p3-correction:approved-for-processing:' || v_row.article_id::text,
      'published',
      v_row.current_version_id,
      false,
      'backfill',
      'p3-reconciliation',
      'Resolve legacy published article approved for completed processing.',
      null,
      'p3-review-eligibility-correction',
      'import',
      'legacy-backfill',
      null,
      null,
      jsonb_build_object('mode', 'review-eligibility-correction'),
      null
    );

    insert into article_publication_quarantine_resolutions_p3(
      article_id, anomaly_code, resolution_code
    ) values (
      v_row.article_id,
      'backfill.public_review_ineligible',
      'resolution.completed_processing_is_publishable'
    ) on conflict (article_id, anomaly_code) do nothing;
  end loop;
end;
$$;

create or replace function article_publication_evidence_p3()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with legacy_public as (
    select a.id from articles a
    where a.status = 'summarized'
      and a.source_metadata #>> '{collection,publishable}' = 'true'
  ), projected_public as (
    select p.id from public_article_projection_p3 p
  ), legacy_only as (
    select id from legacy_public except select id from projected_public
  ), projection_only as (
    select id from projected_public except select id from legacy_public
  ), unresolved_quarantine as (
    select q.article_id, q.anomaly_code
    from article_publication_quarantine_p3 q
    where not exists (
      select 1
      from article_publication_quarantine_resolutions_p3 r
      where r.article_id = q.article_id and r.anomaly_code = q.anomaly_code
    )
  ), digests as (
    select
      encode(extensions.digest(convert_to(coalesce((select string_agg(id::text, ',' order by id) from legacy_public), ''), 'UTF8'), 'sha256'), 'hex') legacy_digest,
      encode(extensions.digest(convert_to(coalesce((select string_agg(id::text, ',' order by id) from projected_public), ''), 'UTF8'), 'sha256'), 'hex') projection_digest,
      encode(extensions.digest(convert_to(coalesce((select string_agg(id::text, ',' order by id) from legacy_only), ''), 'UTF8'), 'sha256'), 'hex') legacy_only_digest,
      encode(extensions.digest(convert_to(coalesce((select string_agg(id::text, ',' order by id) from projection_only), ''), 'UTF8'), 'sha256'), 'hex') projection_only_digest
  )
  select jsonb_build_object(
    'articleCount', (select count(*) from articles),
    'versionedArticleCount', (select count(*) from article_version_heads_p3),
    'publicationCount', (select count(*) from article_publications_p3),
    'versionCount', (select count(*) from article_content_versions_p3),
    'historyCount', (select count(*) from article_publication_history_p3),
    'auditCount', (select count(*) from article_audit_ledger_p3),
    'outboxPendingCount', (select count(*) from article_cache_outbox_p3 where status = 'pending'),
    'outboxProcessingCount', (select count(*) from article_cache_outbox_p3 where status = 'processing'),
    'outboxDeadLetterCount', (select count(*) from article_cache_outbox_p3 where status = 'dead_letter'),
    'quarantineCount', (select count(*) from unresolved_quarantine),
    'quarantineResolvedCount', (select count(*) from article_publication_quarantine_resolutions_p3),
    'legacyPublicCount', (select count(*) from legacy_public),
    'projectionPublicCount', (select count(*) from projected_public),
    'legacyOnlyCount', (select count(*) from legacy_only),
    'projectionOnlyCount', (select count(*) from projection_only),
    'legacyIdentityDigest', digests.legacy_digest,
    'projectionIdentityDigest', digests.projection_digest,
    'legacyOnlyDigest', digests.legacy_only_digest,
    'projectionOnlyDigest', digests.projection_only_digest
  )
  from digests;
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on table article_publication_quarantine_resolutions_p3 from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on table article_publication_quarantine_resolutions_p3 from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on table article_publication_quarantine_resolutions_p3 from service_role;
  end if;
end;
$$;
