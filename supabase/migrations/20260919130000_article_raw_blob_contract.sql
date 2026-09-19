begin;

-- Article raw-text Blob contract (M6A): additive externalization columns on both
-- public.articles and public.article_content_versions_p3, transition-state
-- constraints, and an append-only externalization ledger. The contract section is
-- additive only: no backfill, no inline clear, and no mutation of existing rows.
-- The existing raw_text column is left exactly as-is (nullable text) and
-- cleaned_text, search_vector, and every search path are untouched, so search
-- behavior is unchanged.
--
-- The stored object contract is fixed to a single dedicated version literal,
-- 'worldcons-article-raw-blob-v1' (mirrored by ARTICLE_RAW_BLOB_CONTRACT_VERSION in
-- lib/article-raw/codec.ts). Storage refs must match
-- artifacts/article_raw/<source_key>/<sha256>.json and the ref hash must equal
-- raw_text_blob_hash.
--
-- This migration also adds the additive flag-on capture authority
-- article_publication_transition_p3_blob at the end. It is a deliberate sibling of
-- article_publication_transition_p3, which it neither modifies nor replaces, and is
-- reached only when the application Blob write flag is on; with the flag off,
-- publication transitions keep using the unchanged original RPC. Externalization
-- backfill and inline clear remain out of scope for this migration.

alter table articles
  add column if not exists raw_text_storage_ref text,
  add column if not exists raw_text_blob_hash text,
  add column if not exists raw_text_blob_size bigint,
  add column if not exists raw_text_externalized_at timestamptz,
  add column if not exists raw_text_blob_contract_version text;

alter table article_content_versions_p3
  add column if not exists raw_text_storage_ref text,
  add column if not exists raw_text_blob_hash text,
  add column if not exists raw_text_blob_size bigint,
  add column if not exists raw_text_externalized_at timestamptz,
  add column if not exists raw_text_blob_contract_version text;

alter table articles drop constraint if exists articles_raw_text_ref_check;
alter table articles add constraint articles_raw_text_ref_check check (
  raw_text_storage_ref is null
  or (
    length(raw_text_storage_ref) between 1 and 500
    and raw_text_storage_ref ~ '^artifacts/article_raw/[a-z][a-z0-9._-]{0,79}/[0-9a-f]{64}\.json$'
    and raw_text_storage_ref !~* '(token|secret|signature|credential)'
  )
);

alter table articles drop constraint if exists articles_raw_text_blob_hash_check;
alter table articles add constraint articles_raw_text_blob_hash_check check (
  raw_text_blob_hash is null or raw_text_blob_hash ~ '^[0-9a-f]{64}$'
);

alter table articles drop constraint if exists articles_raw_text_blob_size_check;
alter table articles add constraint articles_raw_text_blob_size_check check (
  raw_text_blob_size is null
  or (raw_text_blob_size between 0 and 4194304 and raw_text_storage_ref is not null)
);

alter table articles drop constraint if exists articles_raw_text_contract_version_check;
alter table articles add constraint articles_raw_text_contract_version_check check (
  raw_text_blob_contract_version is null
  or raw_text_blob_contract_version = 'worldcons-article-raw-blob-v1'
);

alter table articles drop constraint if exists articles_raw_text_ref_hash_check;
alter table articles add constraint articles_raw_text_ref_hash_check check (
  raw_text_storage_ref is null
  or (
    raw_text_blob_hash is not null
    and raw_text_storage_ref ~ ('^artifacts/article_raw/[a-z][a-z0-9._-]{0,79}/' || raw_text_blob_hash || '\.json$')
  )
);

alter table articles drop constraint if exists articles_raw_text_externalization_contract_check;
alter table articles add constraint articles_raw_text_externalization_contract_check check (
  (
    raw_text_externalized_at is null
    and raw_text_blob_contract_version is null
    and raw_text_storage_ref is null
    and raw_text_blob_hash is null
    and raw_text_blob_size is null
  )
  or (
    raw_text_externalized_at is not null
    and raw_text_blob_contract_version = 'worldcons-article-raw-blob-v1'
    and raw_text_storage_ref is not null
    and raw_text_blob_hash is not null
    and raw_text_blob_size is not null
  )
);

alter table article_content_versions_p3 drop constraint if exists article_content_versions_p3_raw_text_ref_check;
alter table article_content_versions_p3 add constraint article_content_versions_p3_raw_text_ref_check check (
  raw_text_storage_ref is null
  or (
    length(raw_text_storage_ref) between 1 and 500
    and raw_text_storage_ref ~ '^artifacts/article_raw/[a-z][a-z0-9._-]{0,79}/[0-9a-f]{64}\.json$'
    and raw_text_storage_ref !~* '(token|secret|signature|credential)'
  )
);

alter table article_content_versions_p3 drop constraint if exists article_content_versions_p3_raw_text_blob_hash_check;
alter table article_content_versions_p3 add constraint article_content_versions_p3_raw_text_blob_hash_check check (
  raw_text_blob_hash is null or raw_text_blob_hash ~ '^[0-9a-f]{64}$'
);

alter table article_content_versions_p3 drop constraint if exists article_content_versions_p3_raw_text_blob_size_check;
alter table article_content_versions_p3 add constraint article_content_versions_p3_raw_text_blob_size_check check (
  raw_text_blob_size is null
  or (raw_text_blob_size between 0 and 4194304 and raw_text_storage_ref is not null)
);

alter table article_content_versions_p3 drop constraint if exists article_content_versions_p3_raw_text_contract_version_check;
alter table article_content_versions_p3 add constraint article_content_versions_p3_raw_text_contract_version_check check (
  raw_text_blob_contract_version is null
  or raw_text_blob_contract_version = 'worldcons-article-raw-blob-v1'
);

alter table article_content_versions_p3 drop constraint if exists article_content_versions_p3_raw_text_ref_hash_check;
alter table article_content_versions_p3 add constraint article_content_versions_p3_raw_text_ref_hash_check check (
  raw_text_storage_ref is null
  or (
    raw_text_blob_hash is not null
    and raw_text_storage_ref ~ ('^artifacts/article_raw/[a-z][a-z0-9._-]{0,79}/' || raw_text_blob_hash || '\.json$')
  )
);

alter table article_content_versions_p3 drop constraint if exists article_content_versions_p3_raw_text_externalization_contract_check;
alter table article_content_versions_p3 add constraint article_content_versions_p3_raw_text_externalization_contract_check check (
  (
    raw_text_externalized_at is null
    and raw_text_blob_contract_version is null
    and raw_text_storage_ref is null
    and raw_text_blob_hash is null
    and raw_text_blob_size is null
  )
  or (
    raw_text_externalized_at is not null
    and raw_text_blob_contract_version = 'worldcons-article-raw-blob-v1'
    and raw_text_storage_ref is not null
    and raw_text_blob_hash is not null
    and raw_text_blob_size is not null
  )
);

create table if not exists article_raw_externalization_ledger (
  id bigint generated by default as identity primary key,
  article_table text not null,
  article_row_id uuid not null,
  article_id uuid not null,
  content_kind text not null,
  storage_ref text not null,
  content_hash text not null,
  content_size bigint not null,
  externalization_contract_version text not null,
  actor_type text not null,
  actor_id text,
  externalized_at timestamptz not null default now(),
  constraint article_raw_externalization_ledger_table_check check (
    article_table in ('articles', 'article_content_versions_p3')
  ),
  constraint article_raw_externalization_ledger_row_check check (
    article_table <> 'articles' or article_row_id = article_id
  ),
  constraint article_raw_externalization_ledger_kind_check check (
    content_kind = 'raw_text'
  ),
  constraint article_raw_externalization_ledger_hash_check check (
    content_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint article_raw_externalization_ledger_size_check check (
    content_size between 0 and 4194304
  ),
  constraint article_raw_externalization_ledger_ref_check check (
    storage_ref ~ '^artifacts/article_raw/[a-z][a-z0-9._-]{0,79}/[0-9a-f]{64}\.json$'
    and length(storage_ref) between 1 and 500
    and storage_ref !~* '(token|secret|signature|credential)'
  ),
  constraint article_raw_externalization_ledger_ref_hash_check check (
    storage_ref ~ ('^artifacts/article_raw/[a-z][a-z0-9._-]{0,79}/' || content_hash || '\.json$')
  ),
  constraint article_raw_externalization_ledger_contract_check check (
    externalization_contract_version = 'worldcons-article-raw-blob-v1'
  ),
  constraint article_raw_externalization_ledger_actor_check check (
    actor_type in ('service', 'operator')
    and (actor_id is null or length(actor_id) between 1 and 160)
  )
);

create unique index if not exists article_raw_externalization_ledger_unique_idx
  on article_raw_externalization_ledger(article_table, article_row_id, externalization_contract_version);
create index if not exists article_raw_externalization_ledger_article_idx
  on article_raw_externalization_ledger(article_id, externalized_at desc);

drop trigger if exists article_raw_externalization_ledger_immutable_trigger on article_raw_externalization_ledger;
create trigger article_raw_externalization_ledger_immutable_trigger
before update or delete on article_raw_externalization_ledger
for each row execute function case_backfill_prevent_mutation_v1();

alter table article_raw_externalization_ledger enable row level security;

revoke all on table article_raw_externalization_ledger from public;

do $permissions$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on table article_raw_externalization_ledger from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on table article_raw_externalization_ledger from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select on table article_raw_externalization_ledger to service_role;
  end if;
end;
$permissions$;

comment on table article_raw_externalization_ledger is
  'Append-only audit ledger recording private Blob externalization of article raw_text for articles and article_content_versions_p3; stores stable object refs and SHA-256 only.';
comment on column articles.raw_text is
  'Original article source text; unchanged and nullable, and externalized to private Blob by the flag-on capture authority in this migration.';
comment on column articles.raw_text_storage_ref is
  'Content-addressed private Blob object key (artifacts/article_raw/<source_key>/<sha256>.json) for the externalized article raw_text.';
comment on column articles.raw_text_blob_hash is
  'SHA-256 of the externalized article raw_text Blob document; the ref trailing hash must equal this value.';
comment on column articles.raw_text_blob_size is
  'Exact UTF-8 byte size of the externalized article raw_text Blob document (<=4 MiB).';
comment on column articles.raw_text_externalized_at is
  'When the article raw_text was externalized to private Blob.';
comment on column articles.raw_text_blob_contract_version is
  'Fixed externalization contract version for the article raw_text Blob object (worldcons-article-raw-blob-v1).';
comment on column article_content_versions_p3.raw_text is
  'Original version source text; unchanged and nullable, and externalized to private Blob by the flag-on capture authority in this migration.';
comment on column article_content_versions_p3.raw_text_storage_ref is
  'Content-addressed private Blob object key (artifacts/article_raw/<source_key>/<sha256>.json) for the externalized version raw_text.';
comment on column article_content_versions_p3.raw_text_blob_hash is
  'SHA-256 of the externalized version raw_text Blob document; the ref trailing hash must equal this value.';
comment on column article_content_versions_p3.raw_text_blob_size is
  'Exact UTF-8 byte size of the externalized version raw_text Blob document (<=4 MiB).';
comment on column article_content_versions_p3.raw_text_externalized_at is
  'When the version raw_text was externalized to private Blob.';
comment on column article_content_versions_p3.raw_text_blob_contract_version is
  'Fixed externalization contract version for the version raw_text Blob object (worldcons-article-raw-blob-v1).';

-- Additive flag-on capture authority (M6A). This is a deliberate sibling of
-- article_publication_transition_p3, not a replacement: the original RPC is left
-- byte-for-byte unchanged so turning ARTICLE_RAW_BLOB_WRITE_ENABLED off rolls the
-- application back to the exact pre-M6A transition. This function accepts only the
-- capture path (no explicit version id) plus the four verified Blob metadata
-- values, and it inserts the captured version with raw_text NULL and the
-- content-addressed metadata attached.
--
-- Every other behavior mirrors the original: idempotency via
-- article_publication_requests_p3, expected version/publication revision checks,
-- the append-only audit ledger, publication history, and the cache outbox are
-- preserved, and no existing immutable trigger is weakened or replaced.
create or replace function article_publication_transition_p3_blob(
  p_article_id uuid,
  p_expected_version_revision bigint,
  p_expected_publication_revision bigint,
  p_idempotency_key text,
  p_target_state text,
  p_actor_type text,
  p_actor_id text,
  p_reason text,
  p_raw_text_storage_ref text,
  p_raw_text_blob_hash text,
  p_raw_text_blob_size bigint,
  p_raw_text_blob_contract_version text,
  p_request_id text default null,
  p_correlation_id text default null,
  p_provenance_actor_type text default 'human',
  p_provenance_actor_id text default null,
  p_model_ref text default null,
  p_prompt_ref text default null,
  p_safe_metadata jsonb default '{}'::jsonb,
  p_expected_legacy_updated_at timestamptz default null
)
returns table(
  article_id uuid,
  version_id uuid,
  version_revision bigint,
  publication_id uuid,
  publication_revision bigint,
  publication_state text,
  version_created boolean,
  publication_applied boolean,
  idempotent boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_article articles%rowtype;
  v_head article_version_heads_p3%rowtype;
  v_version article_content_versions_p3%rowtype;
  v_publication article_publications_p3%rowtype;
  v_request article_publication_requests_p3%rowtype;
  v_content_hash text;
  v_version_id uuid;
  v_version_revision bigint;
  v_version_created boolean := false;
  v_publication_applied boolean := false;
  v_publication_revision bigint;
  v_old_state text;
  v_old_version_id uuid;
  v_now timestamptz := clock_timestamp();
  v_metadata jsonb := coalesce(p_safe_metadata, '{}'::jsonb);
  v_ref text;
  v_expected_ref text;
begin
  if p_article_id is null
    or p_expected_version_revision is null or p_expected_version_revision < 0
    or p_expected_publication_revision is null or p_expected_publication_revision < 0
    or p_idempotency_key is null or length(p_idempotency_key) not between 1 and 240
    or p_target_state not in ('draft', 'in_review', 'published', 'withdrawn')
    or p_actor_type not in ('human', 'compatibility', 'backfill', 'system')
    or (p_actor_id is not null and length(p_actor_id) > 160)
    or p_reason is null or length(p_reason) not between 1 and 500
    or (p_request_id is not null and length(p_request_id) > 160)
    or (p_correlation_id is not null and length(p_correlation_id) > 160)
    or p_provenance_actor_type not in ('human', 'llm', 'import')
    or (p_provenance_actor_id is not null and length(p_provenance_actor_id) > 160)
    or (p_model_ref is not null and length(p_model_ref) > 200)
    or (p_prompt_ref is not null and length(p_prompt_ref) > 200)
    or pg_column_size(v_metadata) > 8192
    or article_publication_json_has_secret_p3(v_metadata)
  then
    raise exception using errcode = '22023', message = 'ARTICLE_PUBLICATION_INVALID_INPUT';
  end if;
  if p_target_state = 'published' and p_actor_type not in ('human', 'compatibility', 'backfill') then
    raise exception using errcode = '42501', message = 'ARTICLE_PUBLICATION_ACTOR_FORBIDDEN';
  end if;
  -- Accept only the one supported raw-text Blob contract, a well-formed hash, a
  -- bounded size, and a content-addressed ref whose trailing hash equals the
  -- declared hash. Any divergence is refused before a permit or version exists.
  if p_raw_text_blob_contract_version is distinct from 'worldcons-article-raw-blob-v1' then
    raise exception using errcode = '22023', message = 'ARTICLE_RAW_BLOB_CONTRACT_VERSION_INVALID';
  end if;
  if p_raw_text_blob_hash is null or p_raw_text_blob_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'ARTICLE_RAW_BLOB_HASH_INVALID';
  end if;
  if p_raw_text_blob_size is null or p_raw_text_blob_size < 0 or p_raw_text_blob_size > 4194304 then
    raise exception using errcode = '22023', message = 'ARTICLE_RAW_BLOB_SIZE_INVALID';
  end if;
  v_ref := nullif(trim(coalesce(p_raw_text_storage_ref, '')), '');
  if v_ref is null or v_ref <> p_raw_text_storage_ref then
    raise exception using errcode = '22023', message = 'ARTICLE_RAW_BLOB_REF_INVALID';
  end if;
  if v_ref !~ '^artifacts/article_raw/[a-z][a-z0-9._-]{0,79}/[0-9a-f]{64}\.json$'
    or v_ref !~ ('^artifacts/article_raw/[a-z][a-z0-9._-]{0,79}/' || p_raw_text_blob_hash || '\.json$')
  then
    raise exception using errcode = '22023', message = 'ARTICLE_RAW_BLOB_REF_INVALID';
  end if;

  select r.* into v_request from article_publication_requests_p3 r
  where r.article_id = p_article_id and r.idempotency_key = p_idempotency_key;
  if found then
    return query select v_request.article_id, v_request.version_id, v_request.version_revision,
      v_request.publication_id, v_request.publication_revision, v_request.state,
      v_request.version_created, v_request.publication_applied, true;
    return;
  end if;

  select a.* into v_article from articles a where a.id = p_article_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'ARTICLE_PUBLICATION_NOT_FOUND';
  end if;

  select r.* into v_request from article_publication_requests_p3 r
  where r.article_id = p_article_id and r.idempotency_key = p_idempotency_key;
  if found then
    return query select v_request.article_id, v_request.version_id, v_request.version_revision,
      v_request.publication_id, v_request.publication_revision, v_request.state,
      v_request.version_created, v_request.publication_applied, true;
    return;
  end if;
  if p_expected_legacy_updated_at is not null and v_article.updated_at is distinct from p_expected_legacy_updated_at then
    raise exception using errcode = '40001', message = 'ARTICLE_PUBLICATION_STALE_LEGACY_ROW';
  end if;

  -- Blob capture precondition: there must be inline raw_text to externalize, and
  -- the ref must be bound to this article's own source key and declared hash so the
  -- stored object key can never point at another source or another payload.
  if v_article.raw_text is null then
    raise exception using errcode = 'P0001', message = 'ARTICLE_RAW_BLOB_INLINE_REQUIRED';
  end if;
  if v_article.source_key is null or v_article.source_key !~ '^[a-z][a-z0-9._-]{0,79}$' then
    raise exception using errcode = 'P0001', message = 'ARTICLE_RAW_BLOB_SOURCE_KEY_INVALID';
  end if;
  v_expected_ref := 'artifacts/article_raw/' || v_article.source_key || '/' || p_raw_text_blob_hash || '.json';
  if v_ref <> v_expected_ref then
    raise exception using errcode = '22023', message = 'ARTICLE_RAW_BLOB_REF_INVALID';
  end if;

  select h.* into v_head from article_version_heads_p3 h where h.article_id = p_article_id for update;
  if coalesce(v_head.current_revision, 0) <> p_expected_version_revision then
    raise exception using errcode = '40001', message = 'ARTICLE_VERSION_STALE_REVISION';
  end if;

  if article_publication_json_has_secret_p3(coalesce(v_article.source_metadata, '{}'::jsonb))
    or article_publication_json_has_secret_p3(coalesce(v_article.error_metadata, '{}'::jsonb))
  then
    raise exception using errcode = '23514', message = 'ARTICLE_VERSION_SECRET_METADATA';
  end if;

  -- The content hash is computed from the legacy article row exactly as the
  -- original capture path does, so re-running a capture of unchanged content finds
  -- the same version (idempotent) instead of minting a duplicate.
  v_content_hash := article_publication_content_hash_p3(v_article);
  v_version_id := article_publication_version_id_p3(p_article_id, v_content_hash);
  select v.* into v_version from article_content_versions_p3 v
  where v.article_id = p_article_id and v.content_hash = v_content_hash;
  if not found then
    v_version_revision := coalesce(v_head.current_revision, 0) + 1;
    insert into article_content_versions_p3 (
      id, article_id, revision, parent_version_id, content_hash, provenance_actor_type,
      provenance_actor_id, model_ref, prompt_ref, slug, source_key, jurisdiction,
      institution_name, content_type, original_url, canonical_url, original_language,
      original_title, korean_title, original_published_at, discovered_at, fetched_at,
      summarized_at, raw_text, cleaned_text, summary_json, source_metadata, error_metadata,
      search_vector, embedding, raw_text_storage_ref, raw_text_blob_hash, raw_text_blob_size,
      raw_text_externalized_at, raw_text_blob_contract_version, created_at
    ) values (
      v_version_id, p_article_id, v_version_revision, v_head.current_version_id, v_content_hash,
      p_provenance_actor_type, left(nullif(trim(p_provenance_actor_id), ''), 160),
      left(nullif(trim(p_model_ref), ''), 200), left(nullif(trim(p_prompt_ref), ''), 200),
      v_article.slug, v_article.source_key, v_article.jurisdiction, v_article.institution_name,
      v_article.content_type, v_article.original_url, v_article.canonical_url,
      v_article.original_language, v_article.original_title, v_article.korean_title,
      v_article.original_published_at, v_article.discovered_at, v_article.fetched_at,
      v_article.summarized_at, null, v_article.cleaned_text, v_article.summary_json,
      article_publication_safe_source_metadata_p3(v_article.source_metadata),
      article_publication_safe_error_metadata_p3(v_article.error_metadata, v_article.error_class),
      v_article.search_vector, v_article.embedding, v_ref, p_raw_text_blob_hash,
      p_raw_text_blob_size, v_now, p_raw_text_blob_contract_version, v_now
    ) returning * into v_version;
    insert into article_version_heads_p3(article_id, current_version_id, current_revision, updated_at)
    values (p_article_id, v_version.id, v_version.revision, v_now)
    on conflict on constraint article_version_heads_p3_pkey do update set
      current_version_id = excluded.current_version_id,
      current_revision = excluded.current_revision,
      updated_at = excluded.updated_at;
    v_version_created := true;
    perform article_audit_append_p3(
      p_article_id, 'article.version.created', v_version.id, null, null,
      p_provenance_actor_type, p_provenance_actor_id, p_reason, p_request_id,
      p_correlation_id, jsonb_build_object('contentHash', v_content_hash, 'revision', v_version.revision)
    );
  end if;

  select p.* into v_publication from article_publications_p3 p where p.article_id = p_article_id for update;
  if coalesce(v_publication.revision, 0) <> p_expected_publication_revision then
    raise exception using errcode = '40001', message = 'ARTICLE_PUBLICATION_STALE_REVISION';
  end if;

  v_old_state := v_publication.state;
  v_old_version_id := v_publication.version_id;
  v_publication_applied := v_publication.id is null
    or p_target_state is distinct from v_publication.state
    or v_version.id is distinct from v_publication.version_id;

  if v_publication_applied and not article_publication_transition_allowed_p3(
    v_publication.state, p_target_state, p_actor_type, v_version.id is distinct from v_publication.version_id
  ) then
    raise exception using errcode = '23514', message = 'ARTICLE_PUBLICATION_ILLEGAL_TRANSITION';
  end if;
  if v_publication.state = 'withdrawn' and p_target_state = 'published' and length(trim(p_reason)) < 8 then
    raise exception using errcode = '23514', message = 'ARTICLE_PUBLICATION_REPUBLISH_REASON_REQUIRED';
  end if;
  if p_target_state = 'published' and not article_publication_eligible_p3(v_article, v_version) then
    raise exception using errcode = '23514', message = 'ARTICLE_PUBLICATION_INELIGIBLE';
  end if;

  if v_publication.id is null then
    insert into article_publications_p3 (
      article_id, state, version_id, revision, decided_by_type, decided_by_id, reason,
      published_at, withdrawn_at, created_at, updated_at
    ) values (
      p_article_id, p_target_state, v_version.id, 1, p_actor_type,
      left(nullif(trim(p_actor_id), ''), 160), p_reason,
      case when p_target_state = 'published' then v_now else null end,
      case when p_target_state = 'withdrawn' then v_now else null end,
      v_now, v_now
    ) returning * into v_publication;
  elsif v_publication_applied then
    update article_publications_p3 set
      state = p_target_state,
      version_id = v_version.id,
      revision = revision + 1,
      decided_by_type = p_actor_type,
      decided_by_id = left(nullif(trim(p_actor_id), ''), 160),
      reason = p_reason,
      published_at = case when p_target_state = 'published' then coalesce(published_at, v_now) else published_at end,
      withdrawn_at = case when p_target_state = 'withdrawn' then v_now when p_target_state = 'published' then null else withdrawn_at end,
      updated_at = v_now
    where id = v_publication.id
    returning * into v_publication;
  end if;
  v_publication_revision := v_publication.revision;

  if v_publication_applied then
    insert into article_publication_history_p3 (
      publication_id, article_id, publication_revision, from_state, to_state,
      from_version_id, to_version_id, idempotency_key, actor_type, actor_id, reason,
      request_id, correlation_id, occurred_at
    ) values (
      v_publication.id, p_article_id, v_publication.revision, v_old_state, p_target_state,
      v_old_version_id, v_version.id, p_idempotency_key, p_actor_type,
      left(nullif(trim(p_actor_id), ''), 160), p_reason,
      left(nullif(trim(p_request_id), ''), 160), left(nullif(trim(p_correlation_id), ''), 160), v_now
    );
    perform article_audit_append_p3(
      p_article_id,
      case p_target_state when 'published' then 'article.publication.published'
        when 'withdrawn' then 'article.publication.withdrawn'
        else 'article.publication.' || p_target_state end,
      v_version.id, v_publication.id, v_publication.revision, p_actor_type,
      p_actor_id, p_reason, p_request_id, p_correlation_id,
      v_metadata || jsonb_build_object('fromState', v_old_state, 'toState', p_target_state)
    );
    insert into article_cache_outbox_p3 (
      event_key, event_type, article_id, publication_id, publication_revision,
      version_id, publication_state, article_slug, available_at, created_at, updated_at
    ) values (
      'article-publication:' || v_publication.id::text || ':' || v_publication.revision::text,
      'publication.changed', p_article_id, v_publication.id, v_publication.revision,
      v_version.id, p_target_state, v_version.slug, v_now, v_now, v_now
    ) on conflict on constraint article_cache_outbox_p3_publication_revision_key do nothing;
  end if;

  if not v_version_created and not v_publication_applied then
    perform article_audit_append_p3(
      p_article_id, 'article.version.capture_noop', v_version.id, v_publication.id, v_publication.revision,
      p_provenance_actor_type, p_provenance_actor_id, p_reason, p_request_id, p_correlation_id, v_metadata
    );
  end if;

  insert into article_publication_requests_p3 (
    article_id, idempotency_key, publication_id, publication_revision, version_id,
    version_revision, state, version_created, publication_applied, created_at
  ) values (
    p_article_id, p_idempotency_key, v_publication.id, v_publication.revision,
    v_version.id, v_version.revision, v_publication.state, v_version_created,
    v_publication_applied, v_now
  ) returning * into v_request;

  return query select p_article_id, v_version.id, v_version.revision,
    v_publication.id, v_publication.revision, v_publication.state,
    v_version_created, v_publication_applied, false;
end;
$$;

revoke all on function article_publication_transition_p3_blob(uuid, bigint, bigint, text, text, text, text, text, text, text, bigint, text, text, text, text, text, text, text, jsonb, timestamptz) from public;

do $permissions$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function article_publication_transition_p3_blob(uuid, bigint, bigint, text, text, text, text, text, text, text, bigint, text, text, text, text, text, text, text, jsonb, timestamptz) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function article_publication_transition_p3_blob(uuid, bigint, bigint, text, text, text, text, text, text, text, bigint, text, text, text, text, text, text, text, jsonb, timestamptz) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function article_publication_transition_p3_blob(uuid, bigint, bigint, text, text, text, text, text, text, text, bigint, text, text, text, text, text, text, text, jsonb, timestamptz) to service_role;
  end if;
end;
$permissions$;

comment on function article_publication_transition_p3_blob(uuid, bigint, bigint, text, text, text, text, text, text, text, bigint, text, text, text, text, text, text, text, jsonb, timestamptz) is
  'M6A flag-on capture authority: identical transition/idempotency/audit/history/outbox semantics to article_publication_transition_p3, but the captured version stores raw_text NULL plus the verified content-addressed raw-text Blob metadata.';

commit;
