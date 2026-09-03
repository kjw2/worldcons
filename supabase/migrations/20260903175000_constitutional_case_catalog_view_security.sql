begin;

-- Public HTTP reads are mediated by the Vercel server and its service-role
-- client. These views must therefore evaluate with the caller's permissions;
-- anon/authenticated must never inherit the migration owner's table access.
alter view public_case_catalog_projection_v1
  set (security_invoker = true);
alter view public_article_detail_v4
  set (security_invoker = true);
alter view public_case_search_documents_v1
  set (security_invoker = true);

revoke all on public_case_catalog_projection_v1,public_article_detail_v4,
  public_case_search_documents_v1 from public;

do $permissions$
begin
  if exists(select 1 from pg_roles where rolname='anon') then
    revoke all on public_case_catalog_projection_v1,public_article_detail_v4,
      public_case_search_documents_v1 from anon;
  end if;
  if exists(select 1 from pg_roles where rolname='authenticated') then
    revoke all on public_case_catalog_projection_v1,public_article_detail_v4,
      public_case_search_documents_v1 from authenticated;
  end if;
  if exists(select 1 from pg_roles where rolname='service_role') then
    grant usage on schema public to service_role;
    -- The invoker Catalog projection needs only these private source columns.
    -- Keep raw text, AI summaries, embeddings, and internal error metadata out
    -- of the service role's direct table grants.
    grant select(id,catalog_ai_stale_v4) on articles to service_role;
    grant select(
      id,article_id,revision,slug,source_key,jurisdiction,institution_name,
      content_type,original_url,canonical_url,original_language,original_title,
      original_published_at,discovered_at,fetched_at,cleaned_text,
      case_metadata_snapshot,content_hash,search_vector,case_key,
      source_anchor_version_id,version_role
    ) on article_content_versions_p3 to service_role;
    grant select(article_id,state) on article_publications_p3 to service_role;
    grant select on public_case_catalog_projection_v1,public_article_detail_v4,
      public_case_search_documents_v1 to service_role;
  end if;
end;
$permissions$;

comment on view public_case_catalog_projection_v1 is
  'Security-invoker authoritative Catalog projection; HTTP access is mediated by the Vercel service role.';
comment on view public_article_detail_v4 is
  'Security-invoker progressive detail projection; current P3 or safe authoritative Catalog fallback.';
comment on view public_case_search_documents_v1 is
  'Security-invoker search projection consumed only by bounded service-role search functions.';

notify pgrst,'reload schema';
commit;
