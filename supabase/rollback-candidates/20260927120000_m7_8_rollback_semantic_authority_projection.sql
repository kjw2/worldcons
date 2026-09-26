begin;

-- M7.8-A STAGED ROLLBACK CANDIDATE — NOT APPLIED, NOT A MIGRATION.
--
-- This file is deliberately authored OUTSIDE supabase/migrations so it can never
-- be discovered by `supabase migration list`/`db push` and can never join the
-- pending migration set. It is a rollback-only artifact: it restores the gate2
-- `public.public_article_projection_p3` shape (bare `v.embedding`) after the
-- forward M7.7-A migration (20260926120000) has been applied.
--
-- It preserves the gate2 column list/order/types, the gate2 freshness/catalog
-- eligibility predicate, `security_barrier` and the anon/authenticated/
-- service_role SELECT grant semantics exactly, and it fails closed unless the
-- live view is currently in the forward artifact-backed state. Applying it is a
-- separate operator decision; M7.8-A only stages it.
--
-- The forward migration is never edited; rollback is this separate forward-only
-- artifact.

do $m78_rollback_preflight$
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
  v_viewdef text;
begin
  if not exists(
    select 1
    from pg_class c
    join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname='public_article_projection_p3' and c.relkind='v'
  ) then
    raise exception using errcode='P0001',message='M78_ROLLBACK_VIEW_MISSING';
  end if;
  select array_agg(a.attname order by a.attnum) into v_actual
  from pg_attribute a
  join pg_class c on c.oid=a.attrelid
  join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relname='public_article_projection_p3'
    and a.attnum>0 and not a.attisdropped;
  if v_actual is distinct from v_expected then
    raise exception using errcode='P0001',message='M78_ROLLBACK_VIEW_COLUMN_DRIFT',
      detail=format('expected %s, found %s',
        array_to_string(v_expected,','),array_to_string(v_actual,','));
  end if;
  select pg_get_viewdef('public.public_article_projection_p3'::regclass, true) into v_viewdef;
  if v_viewdef is null or position('article_embedding_artifacts' in v_viewdef)=0 then
    raise exception using errcode='P0001',message='M78_ROLLBACK_SOURCE_STATE_MISSING',
      detail='the live projection is not in the artifact-backed forward state; refuse to roll back';
  end if;
end;
$m78_rollback_preflight$;

create or replace view public_article_projection_p3
with (security_barrier = true)
as
select
  v.article_id as id,v.slug,v.source_key,v.jurisdiction,v.institution_name,v.content_type,
  v.original_url,v.canonical_url,v.original_language,v.original_title,v.korean_title,
  v.original_published_at,v.discovered_at,v.fetched_at,v.summarized_at,'summarized'::text as status,
  v.raw_text,v.cleaned_text,v.summary_json,v.source_metadata,v.error_metadata,v.content_hash,
  v.search_vector,v.embedding,p.id as publication_id,p.revision as publication_revision,
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
  'Gate2-eligible published P3 projection (rollback to the bare article_content_versions_p3.embedding authority).';

do $m78_rollback_grants$
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
$m78_rollback_grants$;

notify pgrst, 'reload schema';

commit;
