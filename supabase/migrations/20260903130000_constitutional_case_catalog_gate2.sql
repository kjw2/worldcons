begin;

-- Gate 2 extends the existing immutable P3 version chain. Existing rows remain
-- untouched and are identified by a null role; every new v4 row is explicitly
-- typed and anchored to an authoritative source revision from the same article.
alter table articles add constraint articles_id_source_key_v4_key unique (id, source_key);
alter table articles add column if not exists catalog_ai_stale_v4 boolean not null default false;

create or replace function article_catalog_stale_guard_v4()
returns trigger
language plpgsql
set search_path = public, extensions, pg_temp
as $function$
begin
  if new.catalog_ai_stale_v4 is distinct from old.catalog_ai_stale_v4
    and coalesce(current_setting('app.catalog_freshness_v4',true),'')<>'on'
  then raise exception using errcode='42501',message='ARTICLE_CATALOG_STALE_DIRECT_WRITE_FORBIDDEN'; end if;
  return new;
end;
$function$;

drop trigger if exists articles_catalog_stale_guard_v4_trigger on articles;
create trigger articles_catalog_stale_guard_v4_trigger
before update of catalog_ai_stale_v4 on articles
for each row execute function article_catalog_stale_guard_v4();

alter table article_content_versions_p3
  add column if not exists version_document_schema text not null default 'p3.article.v1',
  add column if not exists version_role text,
  add column if not exists case_metadata_snapshot jsonb,
  add column if not exists case_identifiers_snapshot jsonb,
  add column if not exists authority_evidence_hash text,
  add column if not exists source_snapshot_id uuid references source_inventory_snapshots(id) on delete restrict,
  add column if not exists source_snapshot_hash text,
  add column if not exists source_content_hash text,
  add column if not exists source_anchor_version_id uuid,
  add column if not exists enrichment_source_content_hash text;

alter table article_content_versions_p3
  add constraint article_content_versions_p3_id_article_v4_key unique (id, article_id),
  add constraint article_content_versions_p3_source_anchor_v4_fk
    foreign key (source_anchor_version_id, article_id)
    references article_content_versions_p3(id, article_id) on delete restrict,
  add constraint article_content_versions_p3_schema_v4_check check (
    version_document_schema in ('p3.article.v1', 'v4.article-case.v1')
  ),
  add constraint article_content_versions_p3_role_v4_check check (
    version_role is null or version_role in ('authoritative_source', 'enrichment_light', 'enrichment_full')
  ),
  add constraint article_content_versions_p3_hashes_v4_check check (
    (authority_evidence_hash is null or authority_evidence_hash ~ '^[0-9a-f]{64}$')
    and (source_snapshot_hash is null or source_snapshot_hash ~ '^[0-9a-f]{64}$')
    and (source_content_hash is null or source_content_hash ~ '^[0-9a-f]{64}$')
    and (enrichment_source_content_hash is null or enrichment_source_content_hash ~ '^[0-9a-f]{64}$')
  ),
  add constraint article_content_versions_p3_case_json_v4_check check (
    (case_metadata_snapshot is null or (
      jsonb_typeof(case_metadata_snapshot) = 'object' and pg_column_size(case_metadata_snapshot) <= 16384
    )) and (case_identifiers_snapshot is null or (
      jsonb_typeof(case_identifiers_snapshot) = 'array' and pg_column_size(case_identifiers_snapshot) <= 16384
    ))
  );

create table if not exists article_revision_heads_v4 (
  article_id uuid primary key references articles(id) on delete restrict,
  current_version_id uuid not null,
  current_revision bigint not null,
  updated_at timestamptz not null default now(),
  foreign key (current_version_id, article_id)
    references article_content_versions_p3(id, article_id) on delete restrict,
  constraint article_revision_heads_v4_revision_check check (current_revision > 0)
);

insert into article_revision_heads_v4(article_id, current_version_id, current_revision, updated_at)
select distinct on (v.article_id) v.article_id, v.id, v.revision, now()
from article_content_versions_p3 v
order by v.article_id, v.revision desc, v.id
on conflict (article_id) do nothing;

create or replace function article_version_validate_v4()
returns trigger
language plpgsql
set search_path = public, extensions, pg_temp
as $function$
declare
  v_anchor article_content_versions_p3%rowtype;
begin
  if new.version_document_schema = 'p3.article.v1' then
    if new.version_role is not null or new.source_anchor_version_id is not null then
      raise exception using errcode = '23514', message = 'ARTICLE_VERSION_LEGACY_ROLE_FORBIDDEN';
    end if;
    return new;
  end if;
  if new.version_document_schema <> 'v4.article-case.v1'
    or new.version_role is null
    or new.source_content_hash is null
    or new.case_metadata_snapshot is null
    or new.case_identifiers_snapshot is null
  then
    raise exception using errcode = '23514', message = 'ARTICLE_VERSION_V4_PROVENANCE_REQUIRED';
  end if;
  if article_publication_json_has_secret_p3(new.case_metadata_snapshot)
    or article_publication_json_has_secret_p3(jsonb_build_object('identifiers', new.case_identifiers_snapshot))
  then
    raise exception using errcode = '23514', message = 'ARTICLE_VERSION_V4_SECRET_METADATA';
  end if;
  if new.version_role = 'authoritative_source' then
    if new.source_anchor_version_id is distinct from new.id
      or new.enrichment_source_content_hash is not null
      or new.summary_json is not null
      or new.korean_title is not null
      or new.embedding is not null
    then
      raise exception using errcode = '23514', message = 'ARTICLE_VERSION_AUTHORITATIVE_SELF_ANCHOR_REQUIRED';
    end if;
  else
    select v.* into v_anchor
    from article_content_versions_p3 v
    where v.id = new.source_anchor_version_id and v.article_id = new.article_id;
    if not found or v_anchor.version_role <> 'authoritative_source'
      or v_anchor.source_anchor_version_id <> v_anchor.id
      or new.enrichment_source_content_hash is distinct from v_anchor.source_content_hash
    then
      raise exception using errcode = '23514', message = 'ARTICLE_VERSION_ENRICHMENT_ANCHOR_INVALID';
    end if;
    if new.version_role = 'enrichment_full' and new.summary_json is null then
      raise exception using errcode = '23514', message = 'ARTICLE_VERSION_FULL_SUMMARY_REQUIRED';
    end if;
  end if;
  return new;
end;
$function$;

drop trigger if exists article_content_versions_p3_validate_v4_trigger on article_content_versions_p3;
create trigger article_content_versions_p3_validate_v4_trigger
before insert on article_content_versions_p3
for each row execute function article_version_validate_v4();

-- This trigger makes the new head authoritative even for the legacy P3 capture
-- function. It prevents a Catalog revision and a later P3 capture from issuing
-- the same per-article revision number.
create or replace function article_version_allocate_global_revision_v4()
returns trigger
language plpgsql
set search_path = public, extensions, pg_temp
as $function$
declare
  v_head article_revision_heads_v4%rowtype;
begin
  select h.* into v_head from article_revision_heads_v4 h where h.article_id = new.article_id for update;
  if found then
    new.revision := v_head.current_revision + 1;
    new.parent_version_id := v_head.current_version_id;
  else
    perform pg_advisory_xact_lock(hashtextextended(new.article_id::text, 914));
    select h.* into v_head from article_revision_heads_v4 h where h.article_id = new.article_id for update;
    if found then
      new.revision := v_head.current_revision + 1;
      new.parent_version_id := v_head.current_version_id;
    else
      new.revision := 1;
      new.parent_version_id := null;
    end if;
  end if;
  return new;
end;
$function$;

create or replace function article_version_advance_global_head_v4()
returns trigger
language plpgsql
set search_path = public, extensions, pg_temp
as $function$
begin
  insert into article_revision_heads_v4(article_id, current_version_id, current_revision, updated_at)
  values (new.article_id, new.id, new.revision, now())
  on conflict (article_id) do update set
    current_version_id = excluded.current_version_id,
    current_revision = excluded.current_revision,
    updated_at = excluded.updated_at
  where article_revision_heads_v4.current_revision < excluded.current_revision;
  return new;
end;
$function$;

drop trigger if exists article_content_versions_p3_allocate_v4_trigger on article_content_versions_p3;
create trigger article_content_versions_p3_allocate_v4_trigger
before insert on article_content_versions_p3
for each row execute function article_version_allocate_global_revision_v4();
drop trigger if exists article_content_versions_p3_advance_v4_trigger on article_content_versions_p3;
create trigger article_content_versions_p3_advance_v4_trigger
after insert on article_content_versions_p3
for each row execute function article_version_advance_global_head_v4();

create table if not exists case_metadata_v1 (
  article_id uuid primary key references articles(id) on delete restrict,
  source_key text not null,
  authority_status text not null,
  authority_evidence jsonb not null default '{}'::jsonb,
  constitutional_relevance_status text,
  enrichment_status text not null default 'source_only',
  enrichment_freshness text,
  freshness_basis text,
  text_access_policy text not null default 'metadata_only',
  source_policy_version text not null,
  discovery_source text not null,
  authority_source text not null,
  source_last_modified_at timestamptz,
  source_etag text,
  source_snapshot_hash text,
  ai_priority integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (article_id, source_key) references articles(id, source_key) on delete restrict,
  foreign key (source_key, source_policy_version)
    references source_corpus_policies(source_key, policy_version) on delete restrict,
  constraint case_metadata_v1_authority_check check (authority_status in ('candidate','verified','rejected','withdrawn')),
  constraint case_metadata_v1_relevance_check check (
    constitutional_relevance_status is null or constitutional_relevance_status in ('candidate','verified','rejected','uncertain')
  ),
  constraint case_metadata_v1_enrichment_check check (enrichment_status in ('source_only','light','full')),
  constraint case_metadata_v1_freshness_check check (enrichment_freshness is null or enrichment_freshness in ('current','stale')),
  constraint case_metadata_v1_freshness_basis_check check (freshness_basis is null or freshness_basis in (
    'source_hash_match','legacy_same_version','source_hash_mismatch','unknown_fail_closed'
  )),
  constraint case_metadata_v1_enrichment_freshness_check check (
    (enrichment_status = 'source_only' and enrichment_freshness is null and freshness_basis is null)
    or (enrichment_status in ('light','full') and enrichment_freshness is not null and freshness_basis is not null)
  ),
  constraint case_metadata_v1_text_policy_check check (text_access_policy in ('metadata_only','index_only','excerpt','full')),
  constraint case_metadata_v1_evidence_check check (
    jsonb_typeof(authority_evidence) = 'object' and pg_column_size(authority_evidence) <= 16384
      and not article_publication_json_has_secret_p3(authority_evidence)
  ),
  constraint case_metadata_v1_snapshot_hash_check check (source_snapshot_hash is null or source_snapshot_hash ~ '^[0-9a-f]{64}$')
);

create table if not exists case_identifiers_v1 (
  id uuid primary key default gen_random_uuid(),
  article_id uuid not null references articles(id) on delete restrict,
  source_key text not null,
  identifier_type text not null,
  identifier_scope text not null,
  raw_value text not null,
  normalized_value text not null,
  normalization_version integer not null default 1,
  is_primary boolean not null default false,
  provenance_url text,
  created_at timestamptz not null default now(),
  foreign key (article_id, source_key) references articles(id, source_key) on delete restrict,
  constraint case_identifiers_v1_type_check check (identifier_type in (
    'source_record_id','ecli','docket','decision_number','reporter_citation','hj_id','case_key'
  )),
  constraint case_identifiers_v1_scope_check check (identifier_scope in ('decision','proceeding','lookup')),
  constraint case_identifiers_v1_value_check check (
    length(raw_value) between 1 and 500 and length(normalized_value) between 1 and 300
      and normalization_version > 0
  )
);

create unique index if not exists case_identifiers_v1_decision_unique_idx
  on case_identifiers_v1(source_key, identifier_type, normalized_value)
  where identifier_type in ('source_record_id','ecli','hj_id','reporter_citation');
create index if not exists case_identifiers_v1_proceeding_lookup_idx
  on case_identifiers_v1(source_key, identifier_type, normalized_value)
  where identifier_type in ('docket','decision_number','case_key');
create unique index if not exists case_identifiers_v1_one_primary_per_article_idx
  on case_identifiers_v1(article_id) where is_primary;

create table if not exists legacy_version_freshness_classifications_v4 (
  version_id uuid primary key references article_content_versions_p3(id) on delete restrict,
  article_id uuid not null references articles(id) on delete restrict,
  freshness text not null,
  freshness_basis text not null,
  source_anchor_version_id uuid,
  source_content_hash text,
  evidence jsonb not null default '{}'::jsonb,
  classified_at timestamptz not null default now(),
  classified_by text not null,
  foreign key (version_id, article_id) references article_content_versions_p3(id, article_id) on delete restrict,
  constraint legacy_version_freshness_v4_check check (freshness in ('current','stale')),
  constraint legacy_version_basis_v4_check check (freshness_basis in (
    'source_hash_match','legacy_same_version','source_hash_mismatch','unknown_fail_closed'
  )),
  constraint legacy_version_hash_v4_check check (source_content_hash is null or source_content_hash ~ '^[0-9a-f]{64}$'),
  constraint legacy_version_evidence_v4_check check (
    jsonb_typeof(evidence) = 'object' and pg_column_size(evidence) <= 8192
      and not article_publication_json_has_secret_p3(evidence)
  )
);

insert into legacy_version_freshness_classifications_v4(
  version_id, article_id, freshness, freshness_basis, source_content_hash, evidence, classified_by
)
select v.id, v.article_id, 'current', 'legacy_same_version', v.content_hash,
  jsonb_build_object('migration', '20260903130000', 'immutableCombinedSnapshot', true),
  'gate2-legacy-reconciliation'
from article_content_versions_p3 v
where v.version_role is null
on conflict (version_id) do nothing;

create table if not exists case_catalog_publications_v1 (
  id uuid primary key default gen_random_uuid(),
  article_id uuid not null unique references articles(id) on delete restrict,
  state text not null,
  source_anchor_version_id uuid not null,
  revision bigint not null,
  source_policy_version text not null,
  decided_by_type text not null,
  decided_by_id text,
  reason text not null,
  published_at timestamptz,
  withdrawn_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (source_anchor_version_id, article_id)
    references article_content_versions_p3(id, article_id) on delete restrict,
  constraint case_catalog_publications_v1_state_check check (state in ('published','withdrawn')),
  constraint case_catalog_publications_v1_revision_check check (revision > 0),
  constraint case_catalog_publications_v1_actor_check check (decided_by_type in ('human','backfill','system')),
  constraint case_catalog_publications_v1_reason_check check (length(reason) between 1 and 500),
  constraint case_catalog_publications_v1_timestamps_check check (
    (state <> 'published' or published_at is not null) and (state <> 'withdrawn' or withdrawn_at is not null)
  )
);

create table if not exists case_catalog_publication_events_v1 (
  id bigint generated by default as identity primary key,
  publication_id uuid not null references case_catalog_publications_v1(id) on delete restrict,
  article_id uuid not null references articles(id) on delete restrict,
  publication_revision bigint not null,
  from_state text,
  to_state text not null,
  previous_source_anchor_version_id uuid,
  next_source_anchor_version_id uuid not null,
  idempotency_key text not null,
  actor_type text not null,
  actor_id text,
  reason text not null,
  occurred_at timestamptz not null default now(),
  constraint case_catalog_publication_events_v1_state_check check (
    (from_state is null or from_state in ('published','withdrawn')) and to_state in ('published','withdrawn')
  ),
  constraint case_catalog_publication_events_v1_key_check check (length(idempotency_key) between 1 and 240),
  constraint case_catalog_publication_events_v1_revision_key unique (publication_id, publication_revision),
  constraint case_catalog_publication_events_v1_article_key unique (article_id, idempotency_key)
);

create table if not exists case_catalog_cache_outbox_v1 (
  id uuid primary key default gen_random_uuid(),
  event_key text not null unique,
  article_id uuid not null references articles(id) on delete restrict,
  publication_id uuid not null references case_catalog_publications_v1(id) on delete restrict,
  publication_revision bigint not null,
  source_anchor_version_id uuid not null references article_content_versions_p3(id) on delete restrict,
  article_slug text not null,
  created_at timestamptz not null default now(),
  constraint case_catalog_cache_outbox_v1_revision_key unique (publication_id, publication_revision)
);

alter table source_backfill_item_events drop constraint source_backfill_item_events_type_check;
alter table source_backfill_item_events add constraint source_backfill_item_events_type_check check (event_type in (
  'item_discovered','item_claimed','item_lease_extended','fetch_recorded','normalization_recorded',
  'item_completed','item_failed','claim_released','verification_noop','catalog_published'
));

create or replace function case_catalog_immutable_v1()
returns trigger language plpgsql as $function$
begin
  raise exception using errcode = '55000', message = 'CASE_CATALOG_IMMUTABLE_RECORD';
end;
$function$;

drop trigger if exists case_catalog_publication_events_v1_immutable_trigger on case_catalog_publication_events_v1;
create trigger case_catalog_publication_events_v1_immutable_trigger
before update or delete on case_catalog_publication_events_v1
for each row execute function case_catalog_immutable_v1();
drop trigger if exists legacy_version_freshness_v4_immutable_trigger on legacy_version_freshness_classifications_v4;
create trigger legacy_version_freshness_v4_immutable_trigger
before update or delete on legacy_version_freshness_classifications_v4
for each row execute function case_catalog_immutable_v1();

create or replace function article_version_capture_v4(
  p_article_id uuid,
  p_expected_global_revision bigint,
  p_version_role text,
  p_source_anchor_version_id uuid,
  p_source_content_hash text,
  p_enrichment_source_content_hash text,
  p_case_metadata_snapshot jsonb,
  p_case_identifiers_snapshot jsonb,
  p_authority_evidence_hash text,
  p_source_snapshot_id uuid,
  p_source_snapshot_hash text,
  p_provenance_actor_type text,
  p_provenance_actor_id text,
  p_model_ref text default null,
  p_prompt_ref text default null,
  p_content_snapshot jsonb default null
)
returns table(version_id uuid, version_revision bigint, version_created boolean)
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $function$
declare
  v_article articles%rowtype;
  v_head article_revision_heads_v4%rowtype;
  v_anchor article_content_versions_p3%rowtype;
  v_document jsonb;
  v_content_hash text;
  v_version_id uuid;
  v_version article_content_versions_p3%rowtype;
begin
  if p_version_role not in ('authoritative_source','enrichment_light','enrichment_full')
    or p_source_content_hash !~ '^[0-9a-f]{64}$'
    or p_case_metadata_snapshot is null or jsonb_typeof(p_case_metadata_snapshot) <> 'object'
    or p_case_identifiers_snapshot is null or jsonb_typeof(p_case_identifiers_snapshot) <> 'array'
    or p_provenance_actor_type not in ('human','llm','import')
    or (p_content_snapshot is not null and jsonb_typeof(p_content_snapshot)<>'object')
    or (p_version_role<>'authoritative_source' and p_content_snapshot is not null)
  then raise exception using errcode = '22023', message = 'ARTICLE_VERSION_V4_INVALID_INPUT'; end if;
  select a.* into v_article from articles a where a.id = p_article_id for update;
  if not found then raise exception using errcode = 'P0001', message = 'ARTICLE_NOT_FOUND'; end if;
  select h.* into v_head from article_revision_heads_v4 h where h.article_id = p_article_id for update;
  if coalesce(v_head.current_revision, 0) <> p_expected_global_revision then
    raise exception using errcode = '40001', message = 'ARTICLE_GLOBAL_HEAD_STALE_REVISION';
  end if;
  if p_version_role <> 'authoritative_source' then
    select v.* into v_anchor from article_content_versions_p3 v
    where v.id = p_source_anchor_version_id and v.article_id = p_article_id;
    if not found or v_anchor.version_role <> 'authoritative_source'
      or p_enrichment_source_content_hash is distinct from v_anchor.source_content_hash
    then raise exception using errcode = '23514', message = 'ARTICLE_VERSION_ENRICHMENT_ANCHOR_INVALID'; end if;
  end if;
  v_document := jsonb_build_object(
    'schema','v4.article-case.v1','articleId',p_article_id,'role',p_version_role,
    'sourceAnchorVersionId',case when p_version_role = 'authoritative_source' then 'SELF' else p_source_anchor_version_id::text end,
    'sourceContentHash',p_source_content_hash,'enrichmentSourceContentHash',p_enrichment_source_content_hash,
    'slug',v_article.slug,'sourceKey',v_article.source_key,
    'jurisdiction',coalesce(p_content_snapshot->>'jurisdiction',v_article.jurisdiction),
    'institutionName',coalesce(p_content_snapshot->>'institutionName',v_article.institution_name),
    'contentType',coalesce(p_content_snapshot->>'contentType',v_article.content_type),
    'originalUrl',coalesce(p_content_snapshot->>'originalUrl',v_article.original_url),
    'canonicalUrl',coalesce(p_content_snapshot->>'canonicalUrl',v_article.canonical_url),
    'originalLanguage',coalesce(p_content_snapshot->>'originalLanguage',v_article.original_language),
    'originalTitle',coalesce(p_content_snapshot->>'originalTitle',v_article.original_title),
    'koreanTitle',case when p_version_role = 'authoritative_source' then null else v_article.korean_title end,
    'originalPublishedAt',coalesce(nullif(p_content_snapshot->>'originalPublishedAt','')::timestamptz,v_article.original_published_at),
    'cleanedText',coalesce(p_content_snapshot->>'cleanedText',v_article.cleaned_text),
    'summary',case when p_version_role = 'authoritative_source' then null else v_article.summary_json end,
    'caseMetadata',p_case_metadata_snapshot,'caseIdentifiers',p_case_identifiers_snapshot,
    'authorityEvidenceHash',p_authority_evidence_hash,'sourceSnapshotId',p_source_snapshot_id,
    'sourceSnapshotHash',p_source_snapshot_hash
  );
  v_content_hash := encode(extensions.digest(convert_to(v_document::text,'UTF8'),'sha256'),'hex');
  v_version_id := article_publication_version_id_p3(p_article_id, v_content_hash);
  select v.* into v_version from article_content_versions_p3 v
  where v.article_id = p_article_id and v.content_hash = v_content_hash;
  if found then
    return query select v_version.id, v_version.revision, false;
    return;
  end if;
  insert into article_content_versions_p3(
    id,article_id,revision,parent_version_id,content_hash,provenance_actor_type,provenance_actor_id,
    model_ref,prompt_ref,slug,source_key,jurisdiction,institution_name,content_type,original_url,
    canonical_url,original_language,original_title,korean_title,original_published_at,discovered_at,
    fetched_at,summarized_at,raw_text,cleaned_text,summary_json,source_metadata,error_metadata,
    search_vector,embedding,version_document_schema,version_role,case_metadata_snapshot,
    case_identifiers_snapshot,authority_evidence_hash,source_snapshot_id,source_snapshot_hash,
    source_content_hash,source_anchor_version_id,enrichment_source_content_hash
  ) values (
    v_version_id,p_article_id,coalesce(v_head.current_revision,0)+1,v_head.current_version_id,v_content_hash,
    p_provenance_actor_type,left(nullif(trim(p_provenance_actor_id),''),160),left(nullif(trim(p_model_ref),''),200),
    left(nullif(trim(p_prompt_ref),''),200),v_article.slug,v_article.source_key,
    coalesce(p_content_snapshot->>'jurisdiction',v_article.jurisdiction),
    coalesce(p_content_snapshot->>'institutionName',v_article.institution_name),
    coalesce(p_content_snapshot->>'contentType',v_article.content_type),
    coalesce(p_content_snapshot->>'originalUrl',v_article.original_url),
    coalesce(p_content_snapshot->>'canonicalUrl',v_article.canonical_url),
    coalesce(p_content_snapshot->>'originalLanguage',v_article.original_language),
    coalesce(p_content_snapshot->>'originalTitle',v_article.original_title),
    case when p_version_role='authoritative_source' then null else v_article.korean_title end,
    coalesce(nullif(p_content_snapshot->>'originalPublishedAt','')::timestamptz,v_article.original_published_at),
    v_article.discovered_at,v_article.fetched_at,
    case when p_version_role='authoritative_source' then null else v_article.summarized_at end,
    null,coalesce(p_content_snapshot->>'cleanedText',v_article.cleaned_text),
    case when p_version_role='authoritative_source' then null else v_article.summary_json end,
    article_publication_safe_source_metadata_p3(case when p_version_role='authoritative_source'
      then coalesce(p_content_snapshot->'metadata','{}'::jsonb) else v_article.source_metadata end),null,
    setweight(to_tsvector('simple',coalesce(p_content_snapshot->>'originalTitle',v_article.original_title,'')),'A') ||
      setweight(to_tsvector('simple',coalesce(p_content_snapshot->>'cleanedText',v_article.cleaned_text,'')),'B'),
    case when p_version_role='authoritative_source' then null else v_article.embedding end,
    'v4.article-case.v1',p_version_role,p_case_metadata_snapshot,p_case_identifiers_snapshot,
    p_authority_evidence_hash,p_source_snapshot_id,p_source_snapshot_hash,p_source_content_hash,
    case when p_version_role='authoritative_source' then v_version_id else p_source_anchor_version_id end,
    case when p_version_role='authoritative_source' then null else p_enrichment_source_content_hash end
  ) returning * into v_version;
  return query select v_version.id, v_version.revision, true;
end;
$function$;

create or replace function case_catalog_publication_transition_v1(
  p_article_id uuid,
  p_source_anchor_version_id uuid,
  p_expected_publication_revision bigint,
  p_idempotency_key text,
  p_target_state text,
  p_actor_type text,
  p_actor_id text,
  p_reason text
)
returns table(publication_id uuid, publication_revision bigint, publication_state text, source_anchor_version_id uuid, applied boolean, idempotent boolean)
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $function$
declare
  v_version article_content_versions_p3%rowtype;
  v_case case_metadata_v1%rowtype;
  v_policy source_corpus_policies%rowtype;
  v_publication case_catalog_publications_v1%rowtype;
  v_existing case_catalog_publication_events_v1%rowtype;
  v_old_state text;
  v_old_anchor uuid;
  v_applied boolean;
begin
  if length(trim(coalesce(p_idempotency_key,''))) not between 1 and 240
    or p_target_state not in ('published','withdrawn')
    or p_actor_type not in ('human','backfill','system')
    or length(trim(coalesce(p_reason,''))) not between 1 and 500
  then raise exception using errcode = '22023', message = 'CASE_CATALOG_INVALID_TRANSITION'; end if;
  select e.* into v_existing from case_catalog_publication_events_v1 e
  where e.article_id = p_article_id and e.idempotency_key = p_idempotency_key;
  if found then
    select p.* into v_publication from case_catalog_publications_v1 p where p.id = v_existing.publication_id;
    return query select v_publication.id,v_publication.revision,v_publication.state,v_publication.source_anchor_version_id,false,true;
    return;
  end if;
  select v.* into v_version from article_content_versions_p3 v
  where v.id = p_source_anchor_version_id and v.article_id = p_article_id;
  if not found or v_version.version_role <> 'authoritative_source'
    or v_version.source_anchor_version_id <> v_version.id
  then raise exception using errcode = '23514', message = 'CASE_CATALOG_AUTHORITATIVE_ANCHOR_REQUIRED'; end if;
  select c.* into v_case from case_metadata_v1 c where c.article_id = p_article_id;
  if not found or v_case.authority_status <> 'verified'
    or v_case.constitutional_relevance_status <> 'verified'
  then raise exception using errcode = '23514', message = 'CASE_CATALOG_CASE_NOT_VERIFIED'; end if;
  select p.* into v_policy from source_corpus_policies p
  where p.source_key = v_case.source_key and p.policy_version = v_case.source_policy_version;
  if not found or v_policy.review_due_at <= now() then
    raise exception using errcode = '55000', message = 'SOURCE_POLICY_REVIEW_OVERDUE';
  end if;
  select p.* into v_publication from case_catalog_publications_v1 p where p.article_id = p_article_id for update;
  if coalesce(v_publication.revision,0) <> p_expected_publication_revision then
    raise exception using errcode = '40001', message = 'CASE_CATALOG_STALE_REVISION';
  end if;
  v_old_state := v_publication.state;
  v_old_anchor := v_publication.source_anchor_version_id;
  if p_target_state = 'withdrawn' and (v_publication.id is null or v_publication.state <> 'published') then
    raise exception using errcode = '23514', message = 'CASE_CATALOG_ILLEGAL_TRANSITION';
  end if;
  if p_target_state = 'withdrawn' and p_source_anchor_version_id is distinct from v_publication.source_anchor_version_id then
    raise exception using errcode = '23514', message = 'CASE_CATALOG_WITHDRAW_ANCHOR_CHANGED';
  end if;
  v_applied := v_publication.id is null or v_publication.state is distinct from p_target_state
    or v_publication.source_anchor_version_id is distinct from p_source_anchor_version_id;
  if v_publication.id is null then
    insert into case_catalog_publications_v1(
      article_id,state,source_anchor_version_id,revision,source_policy_version,decided_by_type,
      decided_by_id,reason,published_at,withdrawn_at
    ) values (
      p_article_id,p_target_state,p_source_anchor_version_id,1,v_case.source_policy_version,p_actor_type,
      left(nullif(trim(p_actor_id),''),160),p_reason,
      case when p_target_state='published' then now() else null end,
      case when p_target_state='withdrawn' then now() else null end
    ) returning * into v_publication;
  elsif v_applied then
    update case_catalog_publications_v1 set
      state=p_target_state,source_anchor_version_id=p_source_anchor_version_id,revision=revision+1,
      source_policy_version=v_case.source_policy_version,decided_by_type=p_actor_type,
      decided_by_id=left(nullif(trim(p_actor_id),''),160),reason=p_reason,
      published_at=case when p_target_state='published' then coalesce(published_at,now()) else published_at end,
      withdrawn_at=case when p_target_state='withdrawn' then now() else null end,updated_at=now()
    where id=v_publication.id returning * into v_publication;
  end if;
  if v_applied then
    insert into case_catalog_publication_events_v1(
      publication_id,article_id,publication_revision,from_state,to_state,
      previous_source_anchor_version_id,next_source_anchor_version_id,idempotency_key,
      actor_type,actor_id,reason
    ) values (
      v_publication.id,p_article_id,v_publication.revision,v_old_state,p_target_state,
      v_old_anchor,p_source_anchor_version_id,p_idempotency_key,p_actor_type,
      left(nullif(trim(p_actor_id),''),160),p_reason
    );
    insert into case_catalog_cache_outbox_v1(
      event_key,article_id,publication_id,publication_revision,source_anchor_version_id,article_slug
    ) values (
      'case-catalog:'||v_publication.id::text||':'||v_publication.revision::text,p_article_id,
      v_publication.id,v_publication.revision,p_source_anchor_version_id,v_version.slug
    ) on conflict on constraint case_catalog_cache_outbox_v1_revision_key do nothing;
  end if;
  if p_target_state='published' then
    perform set_config('app.catalog_freshness_v4','on',true);
    update articles a set catalog_ai_stale_v4=(
      a.summary_json is not null
      or exists(select 1 from article_publications_p3 p where p.article_id=a.id and p.state='published')
    ) and not exists(
      select 1 from article_publications_p3 p
      join article_content_versions_p3 full_version on full_version.id=p.version_id
      where p.article_id=a.id and p.state='published'
        and full_version.version_role='enrichment_full'
        and full_version.source_anchor_version_id=v_publication.source_anchor_version_id
        and full_version.enrichment_source_content_hash=v_version.source_content_hash
    ) where a.id=p_article_id;
  end if;
  return query select v_publication.id,v_publication.revision,v_publication.state,
    v_publication.source_anchor_version_id,v_applied,false;
end;
$function$;

create or replace function article_p3_candidate_select_v4(
  p_article_id uuid,
  p_version_id uuid,
  p_expected_candidate_revision bigint
)
returns table(article_id uuid, version_id uuid, version_revision bigint)
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $function$
declare
  v_version article_content_versions_p3%rowtype;
  v_head article_version_heads_p3%rowtype;
begin
  select v.* into v_version from article_content_versions_p3 v
  where v.id=p_version_id and v.article_id=p_article_id;
  if not found or v_version.version_role<>'enrichment_full' or not exists(
    select 1 from case_catalog_publications_v1 c
    join article_content_versions_p3 anchor on anchor.id=c.source_anchor_version_id
    where c.article_id=p_article_id and c.state='published'
      and c.source_anchor_version_id=v_version.source_anchor_version_id
      and anchor.source_content_hash=v_version.enrichment_source_content_hash
  ) then raise exception using errcode='23514',message='ARTICLE_P3_FULL_CURRENT_VERSION_REQUIRED'; end if;
  select h.* into v_head from article_version_heads_p3 h where h.article_id=p_article_id for update;
  if coalesce(v_head.current_revision,0)<>p_expected_candidate_revision then
    raise exception using errcode='40001',message='ARTICLE_P3_CANDIDATE_STALE_REVISION';
  end if;
  insert into article_version_heads_p3(article_id,current_version_id,current_revision,updated_at)
  values(p_article_id,v_version.id,v_version.revision,now())
  on conflict on constraint article_version_heads_p3_pkey do update set current_version_id=excluded.current_version_id,
    current_revision=excluded.current_revision,updated_at=excluded.updated_at;
  return query select p_article_id,v_version.id,v_version.revision;
end;
$function$;

create or replace function article_p3_publication_guard_v4()
returns trigger
language plpgsql
set search_path = public, extensions, pg_temp
as $function$
declare
  v_version article_content_versions_p3%rowtype;
begin
  if tg_op='UPDATE' and new.state='withdrawn' and old.state='published'
    and new.version_id is distinct from old.version_id
  then raise exception using errcode='23514',message='ARTICLE_P3_WITHDRAW_VERSION_CHANGED'; end if;
  if new.state='published' then
    select v.* into v_version from article_content_versions_p3 v
    where v.id=new.version_id and v.article_id=new.article_id;
    if not found then raise exception using errcode='23514',message='ARTICLE_P3_VERSION_INVALID'; end if;
    if v_version.version_document_schema='v4.article-case.v1' and (
      v_version.version_role<>'enrichment_full'
      or not exists(
        select 1 from case_catalog_publications_v1 c
        join article_content_versions_p3 anchor on anchor.id=c.source_anchor_version_id
        where c.article_id=new.article_id and c.state='published'
          and c.source_anchor_version_id=v_version.source_anchor_version_id
          and anchor.source_content_hash=v_version.enrichment_source_content_hash
      )
    ) then raise exception using errcode='23514',message='ARTICLE_P3_FULL_CURRENT_VERSION_REQUIRED'; end if;
    if v_version.version_role is null and not exists(
      select 1 from legacy_version_freshness_classifications_v4 l
      where l.version_id=v_version.id and l.freshness='current'
    ) then raise exception using errcode='23514',message='ARTICLE_P3_FRESHNESS_UNKNOWN'; end if;
  end if;
  return new;
end;
$function$;

create or replace function article_p3_publication_freshness_v4()
returns trigger
language plpgsql
set search_path = public, extensions, pg_temp
as $function$
declare
  v_current boolean;
begin
  if exists(select 1 from case_catalog_publications_v1 c where c.article_id=new.article_id and c.state='published') then
    v_current:=new.state='published' and exists(
      select 1 from article_content_versions_p3 full_version
      join case_catalog_publications_v1 c on c.article_id=new.article_id and c.state='published'
      join article_content_versions_p3 anchor on anchor.id=c.source_anchor_version_id
      where full_version.id=new.version_id and full_version.version_role='enrichment_full'
        and full_version.source_anchor_version_id=c.source_anchor_version_id
        and full_version.enrichment_source_content_hash=anchor.source_content_hash
    );
    perform set_config('app.catalog_freshness_v4','on',true);
    update articles set catalog_ai_stale_v4=not v_current where id=new.article_id;
  end if;
  return new;
end;
$function$;

drop trigger if exists article_publications_p3_guard_v4_trigger on article_publications_p3;
create trigger article_publications_p3_guard_v4_trigger
before insert or update on article_publications_p3
for each row execute function article_p3_publication_guard_v4();
drop trigger if exists article_publications_p3_freshness_v4_trigger on article_publications_p3;
create trigger article_publications_p3_freshness_v4_trigger
after insert or update on article_publications_p3
for each row execute function article_p3_publication_freshness_v4();

-- Existing legacy rows remain visible only while classified current and while no
-- Catalog anchor has superseded them. New full rows must match both anchor ID and hash.
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

create or replace view public_case_catalog_projection_v1
with (security_barrier = true)
as
select
  v.article_id as id,v.slug,v.source_key,v.jurisdiction,v.institution_name,v.content_type,
  v.original_url,v.canonical_url,v.original_language,v.original_title,null::text as korean_title,
  v.original_published_at,v.discovered_at,v.fetched_at,null::timestamptz as summarized_at,
  case when m.text_access_policy in ('excerpt','full') and length(coalesce(v.cleaned_text,''))>0 then 'cleaned'::text else 'metadata_only'::text end as status,
  null::text as raw_text,
  case m.text_access_policy when 'full' then v.cleaned_text when 'excerpt' then left(v.cleaned_text,2000) else null end as cleaned_text,
  null::jsonb as summary_json,
  coalesce(v.case_metadata_snapshot->'sourceMetadata','{}'::jsonb) || jsonb_build_object(
    'collection',jsonb_build_object(
      'publishable',true,
      'sourceTextAvailable',m.text_access_policy in ('excerpt','full') and length(coalesce(v.cleaned_text,''))>0,
      'sourceUrlVerified',true,
      'robotsDisallowed',false,
      'strategy','catalog'
    ),
    'catalog',jsonb_build_object(
      'sourceOnly',true,'authorityVerified',true,'sourceAnchorVersionId',c.source_anchor_version_id
    )
  ) as source_metadata,
  null::jsonb as error_metadata,v.content_hash,v.search_vector,null::extensions.vector(1536) as embedding,
  c.id as publication_id,c.revision as publication_revision,v.id as article_version_id,
  v.revision as article_version_revision,'[]'::jsonb as article_tags,v.case_key,c.source_anchor_version_id,
  'authoritative_source'::text as version_role,'source_only'::text as enrichment_status,
  null::text as enrichment_freshness,
  case when a.catalog_ai_stale_v4 or exists(select 1 from article_publications_p3 p where p.article_id=v.article_id and p.state='published')
    then 'reprocessing'::text else 'pending'::text end as summary_status,
  false as summary_available
from case_catalog_publications_v1 c
join article_content_versions_p3 v on v.id=c.source_anchor_version_id and v.article_id=c.article_id
join case_metadata_v1 m on m.article_id=c.article_id
join articles a on a.id=c.article_id
where c.state='published' and v.version_role='authoritative_source'
  and v.source_anchor_version_id=v.id and m.authority_status='verified'
  and m.constitutional_relevance_status='verified';

create or replace view public_article_detail_v4
with (security_barrier = true)
as
select p.* from public_article_projection_p3 p
union all
select c.* from public_case_catalog_projection_v1 c
where not exists(select 1 from public_article_projection_p3 p where p.id=c.id);

create or replace function case_catalog_publish_backfill_item_v1(
  p_item_id uuid,
  p_p1_attempt_id uuid,
  p_p1_fencing_token bigint,
  p_actor_id text default 'case-backfill-worker'
)
returns table(article_id uuid, version_id uuid, version_revision bigint, publication_revision bigint, article_slug text)
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $function$
declare
  v_item source_backfill_items%rowtype;
  v_snapshot source_inventory_snapshots%rowtype;
  v_normalization source_normalization_artifacts%rowtype;
  v_policy source_corpus_policies%rowtype;
  v_output jsonb;
  v_article articles%rowtype;
  v_source_id uuid;
  v_slug text;
  v_record_id text;
  v_normalized_id text;
  v_global_revision bigint;
  v_catalog_revision bigint;
  v_version record;
  v_publication record;
  v_case_snapshot jsonb;
  v_identifier_snapshot jsonb;
  v_authority_evidence jsonb;
  v_authority_hash text;
begin
  select i.* into v_item from source_backfill_items i where i.id=p_item_id for update;
  if not found then raise exception using errcode='P0001',message='CASE_BACKFILL_ITEM_NOT_FOUND'; end if;
  perform source_backfill_assert_attempt_v1(p_p1_attempt_id,p_p1_fencing_token,v_item.snapshot_id,'publish');
  if v_item.claimed_attempt_id<>p_p1_attempt_id or v_item.claimed_fencing_token<>p_p1_fencing_token
    or v_item.claimed_phase<>'publish' or v_item.lease_expires_at<=now()
  then raise exception using errcode='40001',message='CASE_BACKFILL_ITEM_LEASE_LOST'; end if;
  if v_item.verified_normalization_artifact_id is null then
    raise exception using errcode='23514',message='CASE_CATALOG_VERIFIED_NORMALIZATION_REQUIRED'; end if;
  select n.* into v_normalization from source_normalization_artifacts n
  where n.id=v_item.verified_normalization_artifact_id and n.item_id=v_item.id and n.validation_status='valid';
  if not found then raise exception using errcode='23514',message='CASE_CATALOG_VERIFIED_NORMALIZATION_REQUIRED'; end if;
  select s.* into v_snapshot from source_inventory_snapshots s where s.id=v_item.snapshot_id;
  select p.* into v_policy from source_corpus_policies p
  where p.source_key=v_snapshot.source_key and p.policy_version=v_snapshot.source_policy_version;
  if not found or v_policy.review_due_at<=now() then raise exception using errcode='55000',message='SOURCE_POLICY_REVIEW_OVERDUE'; end if;
  if v_snapshot.status<>'closed' or v_snapshot.manifest_hash is null then
    raise exception using errcode='23514',message='CASE_CATALOG_CLOSED_MANIFEST_REQUIRED'; end if;
  v_output:=v_normalization.normalized_output;
  if v_output->>'sourceKey' is distinct from v_snapshot.source_key
    or coalesce(v_output->>'canonicalUrl','')='' or coalesce(v_output->>'originalUrl','')=''
    or coalesce(v_output->>'jurisdiction','')='' or coalesce(v_output->>'institutionName','')=''
    or coalesce(v_output->>'originalLanguage','')='' or coalesce(v_output->>'originalTitle','')=''
  then raise exception using errcode='23514',message='CASE_CATALOG_NORMALIZED_OUTPUT_INVALID'; end if;
  v_record_id:=coalesce(v_item.source_record_id,v_item.stable_item_key);
  v_normalized_id:=lower(regexp_replace(v_record_id,'[^[:alnum:]]','','g'));
  if v_normalized_id='' then raise exception using errcode='23514',message='CASE_CATALOG_IDENTIFIER_INVALID'; end if;
  select a.* into v_article
  from case_identifiers_v1 ci join articles a on a.id=ci.article_id
  where ci.source_key=v_snapshot.source_key and ci.identifier_type='source_record_id'
    and ci.normalized_value=v_normalized_id;
  if not found then
    select a.* into v_article from articles a where a.canonical_url=v_output->>'canonicalUrl';
  end if;
  if not found then
    select s.id into v_source_id from sources s where s.source_key=v_snapshot.source_key;
    v_slug:=case when v_snapshot.source_key='es-tribunal-constitucional' then 'es-tc-' else regexp_replace(v_snapshot.source_key,'[^a-z0-9]+','-','g')||'-' end
      ||lower(regexp_replace(v_record_id,'[^[:alnum:]]+','-','g'));
    insert into articles(
      source_id,source_key,jurisdiction,institution_name,content_type,original_url,canonical_url,
      original_language,original_title,original_published_at,discovered_at,fetched_at,status,slug,
      raw_text,cleaned_text,summary_json,source_metadata,error_metadata
    ) values (
      v_source_id,v_snapshot.source_key,v_output->>'jurisdiction',v_output->>'institutionName',
      coalesce(v_output->>'contentType','decision'),v_output->>'originalUrl',v_output->>'canonicalUrl',
      v_output->>'originalLanguage',v_output->>'originalTitle',nullif(v_output->>'originalPublishedAt','')::timestamptz,
      now(),now(),case when coalesce(v_output->>'cleanedText','')='' then 'metadata_only' else 'cleaned' end,
      v_slug,null,nullif(v_output->>'cleanedText',''),null,
      jsonb_build_object('catalog',jsonb_build_object('sourceOnly',true),'case',coalesce(v_output->'metadata','{}'::jsonb)),null
    ) returning * into v_article;
  else
    if v_article.source_key<>v_snapshot.source_key then raise exception using errcode='23505',message='CASE_CATALOG_IDENTITY_CONFLICT'; end if;
  end if;
  insert into case_identifiers_v1(
    article_id,source_key,identifier_type,identifier_scope,raw_value,normalized_value,is_primary,provenance_url
  ) values (
    v_article.id,v_snapshot.source_key,'source_record_id','decision',v_record_id,v_normalized_id,
    not exists(select 1 from case_identifiers_v1 existing where existing.article_id=v_article.id and existing.is_primary),
    v_output->>'canonicalUrl'
  )
  on conflict (source_key,identifier_type,normalized_value) where identifier_type in ('source_record_id','ecli','hj_id','reporter_citation')
  do nothing;
  if not exists(select 1 from case_identifiers_v1 ci where ci.article_id=v_article.id and ci.identifier_type='source_record_id' and ci.normalized_value=v_normalized_id) then
    raise exception using errcode='23505',message='CASE_CATALOG_IDENTIFIER_CONFLICT';
  end if;
  v_authority_evidence:=jsonb_build_object(
    'authorityUrl',v_output->>'canonicalUrl','snapshotId',v_snapshot.id,
    'manifestHash',v_snapshot.manifest_hash,'normalizationArtifactId',v_normalization.id
  );
  v_authority_hash:=encode(extensions.digest(convert_to(v_authority_evidence::text,'UTF8'),'sha256'),'hex');
  insert into case_metadata_v1(
    article_id,source_key,authority_status,authority_evidence,constitutional_relevance_status,
    enrichment_status,enrichment_freshness,freshness_basis,text_access_policy,source_policy_version,
    discovery_source,authority_source,source_last_modified_at,source_etag,source_snapshot_hash
  ) values (
    v_article.id,v_snapshot.source_key,'verified',v_authority_evidence,'verified','source_only',null,null,
    v_policy.default_text_access_policy,v_snapshot.source_policy_version,v_snapshot.discovery_method,
    v_output->>'canonicalUrl',v_item.source_last_modified_at,v_item.source_etag,v_snapshot.manifest_hash
  ) on conflict on constraint case_metadata_v1_pkey do update set
    authority_status='verified',authority_evidence=excluded.authority_evidence,
    constitutional_relevance_status='verified',enrichment_status='source_only',
    enrichment_freshness=null,freshness_basis=null,text_access_policy=excluded.text_access_policy,
    source_policy_version=excluded.source_policy_version,discovery_source=excluded.discovery_source,
    authority_source=excluded.authority_source,source_last_modified_at=excluded.source_last_modified_at,
    source_etag=excluded.source_etag,source_snapshot_hash=excluded.source_snapshot_hash,updated_at=now();
  select coalesce(max(h.current_revision),0) into v_global_revision from article_revision_heads_v4 h where h.article_id=v_article.id;
  select coalesce(jsonb_agg(jsonb_build_object(
    'type',ci.identifier_type,'scope',ci.identifier_scope,'value',ci.raw_value,
    'normalizedValue',ci.normalized_value,'normalizationVersion',ci.normalization_version,'primary',ci.is_primary
  ) order by ci.identifier_type,ci.normalized_value),'[]'::jsonb)
  into v_identifier_snapshot from case_identifiers_v1 ci where ci.article_id=v_article.id;
  v_case_snapshot:=jsonb_build_object(
    'authorityStatus','verified','constitutionalRelevanceStatus','verified',
    'textAccessPolicy',v_policy.default_text_access_policy,
    'sourcePolicyVersion',v_snapshot.source_policy_version,
    'sourceMetadata',coalesce(v_output->'metadata','{}'::jsonb)
  );
  select * into v_version from article_version_capture_v4(
    v_article.id,v_global_revision,'authoritative_source',null,v_normalization.normalized_output_hash,null,
    v_case_snapshot,v_identifier_snapshot,v_authority_hash,v_snapshot.id,v_snapshot.manifest_hash,
    'import',p_actor_id,null,null,v_output
  );
  select coalesce(c.revision,0) into v_catalog_revision from case_catalog_publications_v1 c where c.article_id=v_article.id;
  select * into v_publication from case_catalog_publication_transition_v1(
    v_article.id,v_version.version_id,v_catalog_revision,
    'case-backfill:'||v_item.id::text||':'||v_normalization.id::text,
    'published','backfill',p_actor_id,'Verified constitutional case Catalog publication.'
  );
  update source_backfill_items set
    article_id=v_article.id,status='published',published_normalization_artifact_id=v_normalization.id,
    claimed_attempt_id=null,claimed_fencing_token=null,claimed_phase=null,lease_expires_at=null,
    next_attempt_at=null,retry_phase=null,error_code=null,error_summary=null,updated_at=now()
  where id=v_item.id;
  insert into source_backfill_item_events(item_id,attempt_id,event_type,phase,safe_details)
  values(v_item.id,p_p1_attempt_id,'catalog_published','publish',jsonb_build_object(
    'articleId',v_article.id,'versionId',v_version.version_id,'publicationRevision',v_publication.publication_revision
  ));
  return query select v_article.id,v_version.version_id,v_version.version_revision,
    v_publication.publication_revision,v_article.slug;
end;
$function$;

alter table article_revision_heads_v4 enable row level security;
alter table case_metadata_v1 enable row level security;
alter table case_identifiers_v1 enable row level security;
alter table legacy_version_freshness_classifications_v4 enable row level security;
alter table case_catalog_publications_v1 enable row level security;
alter table case_catalog_publication_events_v1 enable row level security;
alter table case_catalog_cache_outbox_v1 enable row level security;

revoke all on table article_revision_heads_v4,case_metadata_v1,case_identifiers_v1,
  legacy_version_freshness_classifications_v4,case_catalog_publications_v1,
  case_catalog_publication_events_v1,case_catalog_cache_outbox_v1 from public;
revoke all on public_case_catalog_projection_v1,public_article_detail_v4 from public;
revoke all on function article_version_capture_v4(uuid,bigint,text,uuid,text,text,jsonb,jsonb,text,uuid,text,text,text,text,text,jsonb) from public;
revoke all on function case_catalog_publication_transition_v1(uuid,uuid,bigint,text,text,text,text,text) from public;
revoke all on function article_p3_candidate_select_v4(uuid,uuid,bigint) from public;
revoke all on function case_catalog_publish_backfill_item_v1(uuid,uuid,bigint,text) from public;

do $permissions$
begin
  if exists(select 1 from pg_roles where rolname='anon') then
    grant select on public_case_catalog_projection_v1,public_article_detail_v4 to anon;
  end if;
  if exists(select 1 from pg_roles where rolname='authenticated') then
    grant select on public_case_catalog_projection_v1,public_article_detail_v4 to authenticated;
  end if;
  if exists(select 1 from pg_roles where rolname='service_role') then
    grant select on table article_revision_heads_v4,case_metadata_v1,case_identifiers_v1,
      legacy_version_freshness_classifications_v4,case_catalog_publications_v1,
      case_catalog_publication_events_v1,case_catalog_cache_outbox_v1 to service_role;
    grant select on public_case_catalog_projection_v1,public_article_detail_v4 to service_role;
    grant execute on function article_version_capture_v4(uuid,bigint,text,uuid,text,text,jsonb,jsonb,text,uuid,text,text,text,text,text,jsonb) to service_role;
    grant execute on function case_catalog_publication_transition_v1(uuid,uuid,bigint,text,text,text,text,text) to service_role;
    grant execute on function article_p3_candidate_select_v4(uuid,uuid,bigint) to service_role;
    grant execute on function case_catalog_publish_backfill_item_v1(uuid,uuid,bigint,text) to service_role;
  end if;
end;
$permissions$;

comment on table article_revision_heads_v4 is 'Global immutable article revision head; distinct from the P3 enrichment candidate head.';
comment on table case_catalog_publications_v1 is 'Catalog publication pointer restricted to authoritative self-anchored source revisions.';
comment on view public_article_detail_v4 is 'Progressive public detail: current full P3 when anchor/hash match, otherwise safe source-only Catalog data.';

commit;
