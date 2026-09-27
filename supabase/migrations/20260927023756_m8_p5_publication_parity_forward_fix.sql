begin;

-- Gate 2 classified every legacy P3 version that existed on 2026-09-03, but
-- later p3.article.v1 captures had no runtime classifier. The v4 publication
-- guard correctly fails closed for those versions, which left otherwise
-- eligible legacy-public articles in draft. Restore the invariant for future
-- captures without weakening ARTICLE_P3_FRESHNESS_UNKNOWN.
create or replace function article_legacy_version_classify_current_v4()
returns trigger
language plpgsql
set search_path = public, extensions, pg_temp
as $function$
begin
  if new.version_document_schema = 'p3.article.v1'
    and new.version_role is null
  then
    insert into legacy_version_freshness_classifications_v4(
      version_id,
      article_id,
      freshness,
      freshness_basis,
      source_content_hash,
      evidence,
      classified_by
    ) values (
      new.id,
      new.article_id,
      'current',
      'legacy_same_version',
      new.content_hash,
      jsonb_build_object(
        'mode', 'runtime-legacy-capture',
        'contract', 'p3.article.v1'
      ),
      'p3-runtime-legacy-classifier'
    )
    on conflict (version_id) do nothing;
  end if;
  return new;
end;
$function$;

drop trigger if exists article_content_versions_p3_legacy_freshness_v4_trigger
  on article_content_versions_p3;
create trigger article_content_versions_p3_legacy_freshness_v4_trigger
after insert on article_content_versions_p3
for each row execute function article_legacy_version_classify_current_v4();

revoke all on function article_legacy_version_classify_current_v4() from public;
do $permissions$
begin
  if exists(select 1 from pg_roles where rolname = 'anon') then
    revoke all on function article_legacy_version_classify_current_v4() from anon;
  end if;
  if exists(select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function article_legacy_version_classify_current_v4() from authenticated;
  end if;
  if exists(select 1 from pg_roles where rolname = 'service_role') then
    revoke all on function article_legacy_version_classify_current_v4() from service_role;
  end if;
end;
$permissions$;

-- Catch up immutable legacy versions created after Gate 2. This is the same
-- classification used by the original Gate 2 reconciliation: a p3.article.v1
-- row is the combined immutable snapshot captured from the legacy article.
insert into legacy_version_freshness_classifications_v4(
  version_id,
  article_id,
  freshness,
  freshness_basis,
  source_content_hash,
  evidence,
  classified_by
)
select
  v.id,
  v.article_id,
  'current',
  'legacy_same_version',
  v.content_hash,
  jsonb_build_object(
    'mode', 'forward-fix-existing-legacy',
    'contract', 'p3.article.v1'
  ),
  'm8-p5-forward-fix'
from article_content_versions_p3 v
where v.version_document_schema = 'p3.article.v1'
  and v.version_role is null
  and not exists (
    select 1
    from legacy_version_freshness_classifications_v4 f
    where f.version_id = v.id
  )
on conflict (version_id) do nothing;

-- Repair only legacy-public articles that are still absent from the P3 public
-- projection, whose current publication is draft, and whose present legacy row
-- has no P3 backfill anomaly. Capture the CURRENT article as a new immutable P3
-- version rather than publishing the stale draft version; the trigger above
-- classifies the new version before the publication guard evaluates it.
do $parity_repair$
declare
  v_row record;
  v_result record;
begin
  for v_row in
    select
      a.id,
      a.updated_at,
      h.current_revision,
      p.revision as publication_revision
    from articles a
    join article_version_heads_p3 h on h.article_id = a.id
    join article_publications_p3 p on p.article_id = a.id
    where a.status = 'summarized'
      and a.source_metadata #>> '{collection,publishable}' = 'true'
      and p.state = 'draft'
      and article_publication_backfill_anomaly_p3(a) is null
      and not exists (
        select 1 from public_article_projection_p3 projected
        where projected.id = a.id
      )
    order by a.id
  loop
    select * into v_result
    from article_publication_transition_p3(
      v_row.id,
      v_row.current_revision,
      v_row.publication_revision,
      'm8-p5-parity-repair:' || v_row.id::text,
      'published',
      null,
      true,
      'backfill',
      'm8-p5-forward-fix',
      'Capture current eligible legacy article and repair P3 publication parity.',
      null,
      'm8-p5-forward-fix',
      'import',
      'm8-p5-forward-fix',
      null,
      null,
      jsonb_build_object('mode', 'm8-p5-parity-repair'),
      v_row.updated_at
    );
  end loop;

  if exists (
    select 1
    from articles a
    join article_publications_p3 p on p.article_id = a.id
    where a.status = 'summarized'
      and a.source_metadata #>> '{collection,publishable}' = 'true'
      and p.state = 'draft'
      and article_publication_backfill_anomaly_p3(a) is null
      and not exists (
        select 1 from public_article_projection_p3 projected
        where projected.id = a.id
      )
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'M8_P5_PARITY_REPAIR_INCOMPLETE';
  end if;
end;
$parity_repair$;

-- A lifecycle-attention quarantine is stale once the article's current
-- attention is clear AND that same article is already in the public projection.
-- Both conditions are machine-verifiable, so this does not invent a semantic
-- disposition or bypass a publication/lifecycle guard.
insert into article_publication_quarantine_resolutions_p3(
  article_id,
  anomaly_code,
  resolution_code
)
select
  q.article_id,
  q.anomaly_code,
  'resolution.lifecycle_attention_cleared_and_projected'
from article_publication_quarantine_p3 q
join articles a on a.id = q.article_id
where q.anomaly_code = 'backfill.lifecycle_attention_not_clear'
  and a.lifecycle_attention_state = 'clear'
  and exists (
    select 1 from public_article_projection_p3 p
    where p.id = q.article_id
  )
  and not exists (
    select 1
    from article_publication_quarantine_resolutions_p3 r
    where r.article_id = q.article_id
      and r.anomaly_code = q.anomaly_code
  )
on conflict (article_id, anomaly_code) do nothing;

-- Fail the migration atomically if any machine-resolvable stale quarantine
-- remains after the insert.
do $quarantine_check$
begin
  if exists (
    select 1
    from article_publication_quarantine_p3 q
    join articles a on a.id = q.article_id
    where q.anomaly_code = 'backfill.lifecycle_attention_not_clear'
      and a.lifecycle_attention_state = 'clear'
      and exists (
        select 1 from public_article_projection_p3 p
        where p.id = q.article_id
      )
      and not exists (
        select 1
        from article_publication_quarantine_resolutions_p3 r
        where r.article_id = q.article_id
          and r.anomaly_code = q.anomaly_code
      )
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'M8_P5_QUARANTINE_RESOLUTION_INCOMPLETE';
  end if;
end;
$quarantine_check$;

commit;

