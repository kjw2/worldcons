begin;

-- M7.7-A: repair the semantic embedding-authority drift in the public P3 view.
--
-- 20260831130000_gemini_embedding_provenance.sql re-created
-- public.public_article_projection_p3 with a provenance-locked embedding join
-- (`coalesce(e.embedding, v.embedding)`), so a published P3 version whose
-- `article_content_versions_p3.embedding` is NULL could still expose the current
-- `article_embedding_artifacts.embedding`.
--
-- The later 20260903130000_constitutional_case_catalog_gate2.sql re-created the
-- same view with the latest gate2 column list/order and eligibility predicate, but
-- its input query used bare `v.embedding`, silently reverting the artifact
-- authority. Artifact-backed published rows then projected `embedding = NULL`,
-- which is the semantic authority drift recorded as `oracleDrift` in M7.5/M7.6.
--
-- This migration restores the artifact authority WITHOUT changing anything else:
--   * the gate2 column names/order/types are preserved exactly (only the
--     embedding expression changes);
--   * the gate2 freshness/catalog eligibility predicate is preserved exactly;
--   * `security_barrier` and the existing anon/authenticated/service_role
--     SELECT grant semantics are retained.
--
-- It is authored but deliberately NOT applied remotely by M7.7-A. It is a new
-- timestamp migration; no existing migration is edited. Rollback is a future new
-- migration that re-creates the view without the artifact join (never an edit of
-- this file). A fail-closed preflight refuses to replace a view whose current
-- column names/order do not match the expected gate2 shape.

do $m77a_preflight$
declare
  v_expected text[] := array[
    'id','slug','source_key','jurisdiction','institution_name','content_type',
    'original_url','canonical_url','original_language','original_title','korean_title',
    'original_published_at','discovered_at','fetched_at','summarized_at','status',
    'raw_text','cleaned_text','summary_json','source_metadata','error_metadata',
    'content_hash','search_vector','embedding','publication_id','publication_revision',
    'article_version_id','article_version_revision','article_tags','case_key',
    'source_anchor_version_id','version_role','enrichment_status','enrichment_freshness',
    'summary_status','summary_available'
  ];
  v_actual text[];
begin
  if not exists(
    select 1
    from pg_class c
    join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname='public_article_projection_p3' and c.relkind='v'
  ) then
    raise exception using errcode='P0001',message='M77A_PROJECTION_VIEW_MISSING';
  end if;
  select array_agg(a.attname order by a.attnum) into v_actual
  from pg_attribute a
  join pg_class c on c.oid=a.attrelid
  join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relname='public_article_projection_p3'
    and a.attnum>0 and not a.attisdropped;
  if v_actual is distinct from v_expected then
    raise exception using errcode='P0001',message='M77A_PROJECTION_VIEW_COLUMN_DRIFT',
      detail=format('expected %s, found %s',
        array_to_string(v_expected,','),array_to_string(v_actual,','));
  end if;
end;
$m77a_preflight$;

create or replace view public_article_projection_p3
with (security_barrier = true)
as
select
  v.article_id as id,v.slug,v.source_key,v.jurisdiction,v.institution_name,v.content_type,
  v.original_url,v.canonical_url,v.original_language,v.original_title,v.korean_title,
  v.original_published_at,v.discovered_at,v.fetched_at,v.summarized_at,'summarized'::text as status,
  v.raw_text,v.cleaned_text,v.summary_json,v.source_metadata,v.error_metadata,v.content_hash,
  v.search_vector,coalesce(e.embedding,v.embedding) as embedding,
  p.id as publication_id,p.revision as publication_revision,
  v.id as article_version_id,v.revision as article_version_revision,
  coalesce((select jsonb_agg(jsonb_build_object(
    'confidence',at.confidence,'tags',jsonb_build_object(
      'id',t.id,'slug',t.slug,'name',t.name,'normalized_name',t.normalized_name,
      'type',t.type,'description',t.description,'article_count',t.article_count,'latest_article_at',t.latest_article_at
    )) order by t.slug) from article_tags at join tags t on t.id=at.tag_id where at.article_id=v.article_id),'[]'::jsonb) as article_tags,
  v.case_key,v.source_anchor_version_id,v.version_role,'full'::text as enrichment_status,
  'current'::text as enrichment_freshness,'available'::text as summary_status,true as summary_available
from article_publications_p3 p
join article_content_versions_p3 v on v.id=p.version_id and v.article_id=p.article_id
left join article_embedding_artifacts e
  on e.article_version_id=v.id
 and e.article_id=v.article_id
 and e.content_hash=v.content_hash
 and e.provider='gemini'
 and e.model='gemini-embedding-001'
 and e.dimensions=1536
where p.state='published' and (
  (v.version_role is null and exists(
    select 1 from legacy_version_freshness_classifications_v4 l
    where l.version_id=v.id and l.freshness='current'
  ) and not exists(select 1 from case_catalog_publications_v1 c where c.article_id=v.article_id and c.state='published'))
  or (v.version_role='enrichment_full' and exists(
    select 1 from case_catalog_publications_v1 c
    join article_content_versions_p3 anchor on anchor.id=c.source_anchor_version_id
    where c.article_id=v.article_id and c.state='published'
      and c.source_anchor_version_id=v.source_anchor_version_id
      and anchor.source_content_hash=v.enrichment_source_content_hash
  ))
);

comment on view public_article_projection_p3 is
  'Gate2-eligible published P3 projection with provenance-locked Gemini embedding authority: the current article_embedding_artifacts vector (gemini/gemini-embedding-001/1536, version+article+content_hash locked) coalesces over the legacy version embedding.';

-- `create or replace view` preserves existing privileges, but the grant is
-- restated fail-soft so the anon/authenticated/service_role SELECT semantics are
-- explicit and idempotent. Nothing is granted to PUBLIC.
do $m77a_grants$
begin
  if exists (select 1 from pg_roles where rolname='anon') then
    grant select on public_article_projection_p3 to anon;
  end if;
  if exists (select 1 from pg_roles where rolname='authenticated') then
    grant select on public_article_projection_p3 to authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname='service_role') then
    grant select on public_article_projection_p3 to service_role;
  end if;
end;
$m77a_grants$;

notify pgrst, 'reload schema';

commit;
