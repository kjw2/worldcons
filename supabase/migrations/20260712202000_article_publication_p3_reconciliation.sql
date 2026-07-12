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
      and p_article.lifecycle_review_state not in ('unreviewed', 'approved')
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

create or replace function article_publication_backfill_batch_p3(
  p_after_id uuid default null,
  p_limit integer default 500
)
returns table(
  selected_count integer,
  mapped_count integer,
  quarantined_count integer,
  unchanged_count integer,
  next_after_id uuid,
  batch_complete boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_article articles%rowtype;
  v_head article_version_heads_p3%rowtype;
  v_publication article_publications_p3%rowtype;
  v_result record;
  v_legacy_public boolean;
  v_desired_state text;
  v_anomaly text;
  v_selected integer := 0;
  v_mapped integer := 0;
  v_quarantined integer := 0;
  v_unchanged integer := 0;
  v_next uuid;
begin
  if p_limit is null or p_limit not between 1 and 2000 then
    raise exception using errcode = '22023', message = 'ARTICLE_PUBLICATION_INVALID_BACKFILL_LIMIT';
  end if;

  for v_article in
    select a.* from articles a
    where p_after_id is null or a.id > p_after_id
    order by a.id
    limit p_limit
  loop
    v_selected := v_selected + 1;
    v_next := v_article.id;
    v_legacy_public := v_article.status = 'summarized'
      and v_article.source_metadata #>> '{collection,publishable}' = 'true';
    v_anomaly := article_publication_backfill_anomaly_p3(v_article);
    v_desired_state := case when v_legacy_public and v_anomaly is null then 'published' else 'draft' end;

    select h.* into v_head from article_version_heads_p3 h where h.article_id = v_article.id;
    select p.* into v_publication from article_publications_p3 p where p.article_id = v_article.id;

    if v_publication.id is not null and v_publication.state is distinct from v_desired_state then
      v_anomaly := coalesce(v_anomaly, 'backfill.existing_state_conflict');
    else
      begin
        select * into v_result from article_publication_transition_p3(
          v_article.id,
          coalesce(v_head.current_revision, 0),
          coalesce(v_publication.revision, 0),
          'p3-backfill:' || article_publication_content_hash_p3(v_article) || ':' || v_desired_state,
          v_desired_state,
          null,
          true,
          'backfill',
          'p3-reconciliation',
          case when v_legacy_public then 'Backfill exact legacy public outcome.' else 'Backfill exact legacy private outcome.' end,
          null,
          'p3-backfill',
          case when v_article.summary_json is null then 'import' else 'llm' end,
          'legacy-backfill',
          left(nullif(v_article.summary_json #>> '{aiMetadata,model}', ''), 200),
          null,
          jsonb_build_object('mode', 'legacy-reconciliation'),
          v_article.updated_at
        );
        if not coalesce(v_result.idempotent, false)
          and (coalesce(v_result.version_created, false) or coalesce(v_result.publication_applied, false))
        then
          v_mapped := v_mapped + 1;
        else
          v_unchanged := v_unchanged + 1;
        end if;
      exception
        when others then
          v_anomaly := coalesce(v_anomaly, 'backfill.authority_rejected');
      end;
    end if;

    if v_anomaly is not null then
      insert into article_publication_quarantine_p3(article_id, anomaly_code, legacy_public)
      values (v_article.id, v_anomaly, v_legacy_public)
      on conflict (article_id, anomaly_code) do nothing;
      v_quarantined := v_quarantined + 1;
    end if;
  end loop;

  return query select
    v_selected,
    v_mapped,
    v_quarantined,
    v_unchanged,
    v_next,
    v_selected < p_limit;
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
  ), digests as (
    select
      encode(digest(convert_to(coalesce((select string_agg(id::text, ',' order by id) from legacy_public), ''), 'UTF8'), 'sha256'), 'hex') legacy_digest,
      encode(digest(convert_to(coalesce((select string_agg(id::text, ',' order by id) from projected_public), ''), 'UTF8'), 'sha256'), 'hex') projection_digest,
      encode(digest(convert_to(coalesce((select string_agg(id::text, ',' order by id) from legacy_only), ''), 'UTF8'), 'sha256'), 'hex') legacy_only_digest,
      encode(digest(convert_to(coalesce((select string_agg(id::text, ',' order by id) from projection_only), ''), 'UTF8'), 'sha256'), 'hex') projection_only_digest
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
    'quarantineCount', (select count(*) from article_publication_quarantine_p3),
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

revoke all on function article_publication_backfill_batch_p3(uuid, integer) from public;
revoke all on function article_publication_evidence_p3() from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function article_publication_backfill_batch_p3(uuid, integer) from anon;
    revoke all on function article_publication_evidence_p3() from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function article_publication_backfill_batch_p3(uuid, integer) from authenticated;
    revoke all on function article_publication_evidence_p3() from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function article_publication_backfill_batch_p3(uuid, integer) to service_role;
    grant execute on function article_publication_evidence_p3() to service_role;
  end if;
end;
$$;
