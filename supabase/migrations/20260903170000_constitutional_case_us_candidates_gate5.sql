begin;

-- Gate 5 US Track A: private Constitution Annotated candidate/evidence graph.
-- Citations are not Catalog publications and cannot become verified without a separate review event.

create table if not exists us_conan_candidate_snapshots_v1 (
  id uuid primary key default gen_random_uuid(),
  source_key text not null default 'us-constitution-annotated',
  source_url text not null,
  source_policy_version text not null,
  payload_hash text not null,
  parser_version text not null,
  capture_mode text not null,
  citation_coverage_assurance text not null,
  status text not null default 'open',
  candidate_count integer not null default 0,
  manifest_hash text,
  observed_at timestamptz not null,
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  created_by text not null,
  constraint us_conan_candidate_snapshots_policy_fkey foreign key (source_key, source_policy_version)
    references source_corpus_policies(source_key, policy_version) on delete restrict,
  constraint us_conan_candidate_snapshots_source_check check (
    source_key = 'us-constitution-annotated'
    and source_url = 'https://constitution.congress.gov/resources/cases-cited/'
  ),
  constraint us_conan_candidate_snapshots_hash_check check (
    payload_hash ~ '^[0-9a-f]{64}$' and (manifest_hash is null or manifest_hash ~ '^[0-9a-f]{64}$')
  ),
  constraint us_conan_candidate_snapshots_capture_check check (
    capture_mode in ('official_live', 'reviewed_fixture')
    and citation_coverage_assurance in ('authoritative_enumerated', 'best_effort')
    and (capture_mode <> 'reviewed_fixture' or citation_coverage_assurance = 'best_effort')
  ),
  constraint us_conan_candidate_snapshots_status_check check (
    (status = 'open' and candidate_count = 0 and manifest_hash is null and closed_at is null)
    or (status = 'closed' and candidate_count > 0 and manifest_hash is not null and closed_at is not null)
  ),
  constraint us_conan_candidate_snapshots_text_check check (
    length(parser_version) between 1 and 120 and length(created_by) between 1 and 160
  ),
  unique (payload_hash, parser_version, capture_mode, source_policy_version)
);

create table if not exists us_conan_case_candidates_v1 (
  id uuid primary key default gen_random_uuid(),
  snapshot_id uuid not null references us_conan_candidate_snapshots_v1(id) on delete restrict,
  stable_candidate_key text not null,
  case_name text not null,
  citation text not null,
  normalized_citation text not null,
  court_classification text not null,
  candidate_basis text not null default 'constitution_annotated_table_citation',
  priority integer not null default 0,
  priority_reasons text[] not null default '{}',
  created_at timestamptz not null default now(),
  constraint us_conan_case_candidates_key unique (snapshot_id, stable_candidate_key),
  constraint us_conan_case_candidates_citation unique (snapshot_id, normalized_citation),
  constraint us_conan_case_candidates_classification_check check (
    court_classification in ('scotus_candidate', 'lower_federal', 'state_or_other', 'unknown')
  ),
  constraint us_conan_case_candidates_basis_check check (
    candidate_basis = 'constitution_annotated_table_citation'
  ),
  constraint us_conan_case_candidates_priority_check check (
    priority between 0 and 100 and cardinality(priority_reasons) <= 20
  ),
  constraint us_conan_case_candidates_text_check check (
    length(stable_candidate_key) between 1 and 80
    and length(case_name) between 1 and 500
    and length(citation) between 1 and 300
    and length(normalized_citation) between 1 and 300
  )
);

create table if not exists us_conan_candidate_essay_evidence_v1 (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references us_conan_case_candidates_v1(id) on delete restrict,
  essay_id text not null,
  essay_title text not null,
  essay_url text not null,
  created_at timestamptz not null default now(),
  unique (candidate_id, essay_id),
  constraint us_conan_candidate_essay_evidence_url_check check (
    essay_url ~ '^https://constitution\.congress\.gov/browse/essay/[^/]+/ALDE_[A-Za-z0-9_]+/$'
  ),
  constraint us_conan_candidate_essay_evidence_text_check check (
    essay_id ~ '^ALDE_[A-Z0-9_]+$' and length(essay_title) between 1 and 500
  )
);

create table if not exists us_conan_candidate_reviews_v1 (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references us_conan_case_candidates_v1(id) on delete restrict,
  revision integer not null,
  status text not null,
  official_scotus_identity_verified boolean not null,
  constitutional_essay_context_verified boolean not null,
  official_authority_verified boolean not null,
  constitutional_holding_verified boolean not null,
  official_authority_url text,
  safe_evidence jsonb not null default '{}'::jsonb,
  reviewed_by text not null,
  review_reason text not null,
  reviewed_at timestamptz not null default now(),
  unique (candidate_id, revision),
  constraint us_conan_candidate_reviews_revision_check check (revision > 0),
  constraint us_conan_candidate_reviews_status_check check (status in ('verified', 'uncertain', 'rejected')),
  constraint us_conan_candidate_reviews_verified_shape_check check (
    status <> 'verified' or (
      official_scotus_identity_verified
      and constitutional_essay_context_verified
      and official_authority_verified
      and constitutional_holding_verified
      and official_authority_url is not null
    )
  ),
  constraint us_conan_candidate_reviews_authority_url_check check (
    official_authority_url is null or official_authority_url ~ '^https://(www\.)?(supremecourt\.gov|loc\.gov|govinfo\.gov)/'
  ),
  constraint us_conan_candidate_reviews_evidence_check check (
    jsonb_typeof(safe_evidence) = 'object' and pg_column_size(safe_evidence) <= 16384
  ),
  constraint us_conan_candidate_reviews_text_check check (
    length(reviewed_by) between 1 and 160 and length(review_reason) between 1 and 1000
  )
);

create index if not exists us_conan_case_candidates_classification_idx
  on us_conan_case_candidates_v1(snapshot_id, court_classification, priority desc, normalized_citation);
create index if not exists us_conan_candidate_reviews_latest_idx
  on us_conan_candidate_reviews_v1(candidate_id, revision desc);

create or replace function us_conan_snapshot_guard_v1()
returns trigger
language plpgsql
set search_path = public, extensions, pg_temp
as $function$
begin
  if tg_op = 'DELETE' or old.status = 'closed' then
    raise exception using errcode = '55000', message = 'US_CONAN_SNAPSHOT_IMMUTABLE';
  end if;
  if new.id <> old.id or new.source_key <> old.source_key or new.source_url <> old.source_url
    or new.source_policy_version <> old.source_policy_version or new.payload_hash <> old.payload_hash
    or new.parser_version <> old.parser_version or new.capture_mode <> old.capture_mode
    or new.citation_coverage_assurance <> old.citation_coverage_assurance
    or new.observed_at <> old.observed_at or new.opened_at <> old.opened_at or new.created_by <> old.created_by
    or new.status <> 'closed' or new.candidate_count <= 0 or new.manifest_hash is null or new.closed_at is null
  then
    raise exception using errcode = '55000', message = 'US_CONAN_SNAPSHOT_INVALID_TRANSITION';
  end if;
  return new;
end;
$function$;

drop trigger if exists us_conan_candidate_snapshots_guard_trigger on us_conan_candidate_snapshots_v1;
create trigger us_conan_candidate_snapshots_guard_trigger
before update or delete on us_conan_candidate_snapshots_v1
for each row execute function us_conan_snapshot_guard_v1();

create or replace function us_conan_manifest_insert_guard_v1()
returns trigger
language plpgsql
set search_path = public, extensions, pg_temp
as $function$
declare
  v_snapshot_id uuid;
  v_status text;
begin
  if tg_table_name = 'us_conan_case_candidates_v1' then
    v_snapshot_id := new.snapshot_id;
  else
    select c.snapshot_id into v_snapshot_id from us_conan_case_candidates_v1 c where c.id = new.candidate_id;
  end if;
  select s.status into v_status from us_conan_candidate_snapshots_v1 s where s.id = v_snapshot_id;
  if v_status is distinct from 'open' then
    raise exception using errcode = '55000', message = 'US_CONAN_MANIFEST_CLOSED';
  end if;
  return new;
end;
$function$;

drop trigger if exists us_conan_case_candidates_insert_guard_trigger on us_conan_case_candidates_v1;
create trigger us_conan_case_candidates_insert_guard_trigger
before insert on us_conan_case_candidates_v1
for each row execute function us_conan_manifest_insert_guard_v1();

drop trigger if exists us_conan_candidate_essay_insert_guard_trigger on us_conan_candidate_essay_evidence_v1;
create trigger us_conan_candidate_essay_insert_guard_trigger
before insert on us_conan_candidate_essay_evidence_v1
for each row execute function us_conan_manifest_insert_guard_v1();

drop trigger if exists us_conan_case_candidates_immutable_trigger on us_conan_case_candidates_v1;
create trigger us_conan_case_candidates_immutable_trigger
before update or delete on us_conan_case_candidates_v1
for each row execute function case_backfill_prevent_mutation_v1();

drop trigger if exists us_conan_candidate_essay_immutable_trigger on us_conan_candidate_essay_evidence_v1;
create trigger us_conan_candidate_essay_immutable_trigger
before update or delete on us_conan_candidate_essay_evidence_v1
for each row execute function case_backfill_prevent_mutation_v1();

create or replace function us_conan_review_validate_v1()
returns trigger
language plpgsql
set search_path = public, extensions, pg_temp
as $function$
declare
  v_candidate us_conan_case_candidates_v1%rowtype;
  v_expected_revision integer;
begin
  select c.* into v_candidate from us_conan_case_candidates_v1 c where c.id = new.candidate_id;
  if not found then raise exception using errcode = 'P0001', message = 'US_CONAN_CANDIDATE_NOT_FOUND'; end if;
  select coalesce(max(r.revision), 0) + 1 into v_expected_revision
  from us_conan_candidate_reviews_v1 r where r.candidate_id = new.candidate_id;
  if new.revision <> v_expected_revision then
    raise exception using errcode = '40001', message = 'US_CONAN_REVIEW_STALE_REVISION';
  end if;
  if new.status = 'verified' and (
    v_candidate.court_classification <> 'scotus_candidate'
    or not exists(select 1 from us_conan_candidate_essay_evidence_v1 e where e.candidate_id = new.candidate_id)
  ) then
    raise exception using errcode = '22023', message = 'US_CONAN_VERIFICATION_GATE_FAILED';
  end if;
  return new;
end;
$function$;

drop trigger if exists us_conan_candidate_reviews_validate_trigger on us_conan_candidate_reviews_v1;
create trigger us_conan_candidate_reviews_validate_trigger
before insert on us_conan_candidate_reviews_v1
for each row execute function us_conan_review_validate_v1();

drop trigger if exists us_conan_candidate_reviews_immutable_trigger on us_conan_candidate_reviews_v1;
create trigger us_conan_candidate_reviews_immutable_trigger
before update or delete on us_conan_candidate_reviews_v1
for each row execute function case_backfill_prevent_mutation_v1();

create or replace function us_conan_candidate_snapshot_open_v1(
  p_source_policy_version text,
  p_payload_hash text,
  p_parser_version text,
  p_capture_mode text,
  p_citation_coverage_assurance text,
  p_observed_at timestamptz,
  p_created_by text
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $function$
declare
  v_id uuid;
  v_policy source_corpus_policies%rowtype;
begin
  select p.* into v_policy from source_corpus_policies p
  where p.source_key = 'us-constitution-annotated' and p.policy_version = p_source_policy_version;
  if not found then raise exception using errcode = '22023', message = 'US_CONAN_SOURCE_POLICY_REQUIRED'; end if;
  if v_policy.review_due_at <= transaction_timestamp() then
    raise exception using errcode = '55000', message = 'SOURCE_POLICY_REVIEW_OVERDUE';
  end if;
  if p_payload_hash !~ '^[0-9a-f]{64}$' or length(trim(p_parser_version)) not between 1 and 120
    or length(trim(p_created_by)) not between 1 and 160 or p_observed_at > now() + interval '5 minutes'
  then raise exception using errcode = '22023', message = 'US_CONAN_INVALID_SNAPSHOT'; end if;
  insert into us_conan_candidate_snapshots_v1(
    source_url, source_policy_version, payload_hash, parser_version, capture_mode,
    citation_coverage_assurance, observed_at, created_by
  ) values (
    'https://constitution.congress.gov/resources/cases-cited/', p_source_policy_version,
    p_payload_hash, trim(p_parser_version), p_capture_mode, p_citation_coverage_assurance,
    p_observed_at, trim(p_created_by)
  )
  on conflict (payload_hash, parser_version, capture_mode, source_policy_version) do nothing
  returning id into v_id;
  if v_id is null then
    select s.id into v_id from us_conan_candidate_snapshots_v1 s
    where s.payload_hash = p_payload_hash and s.parser_version = trim(p_parser_version)
      and s.capture_mode = p_capture_mode and s.source_policy_version = p_source_policy_version;
  end if;
  return v_id;
end;
$function$;

create or replace function us_conan_candidate_upsert_v1(
  p_snapshot_id uuid,
  p_stable_candidate_key text,
  p_case_name text,
  p_citation text,
  p_normalized_citation text,
  p_court_classification text,
  p_priority integer,
  p_priority_reasons text[],
  p_essay_references jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $function$
declare
  v_candidate us_conan_case_candidates_v1%rowtype;
  v_reference jsonb;
begin
  if not exists(select 1 from us_conan_candidate_snapshots_v1 s where s.id = p_snapshot_id and s.status = 'open') then
    raise exception using errcode = '55000', message = 'US_CONAN_MANIFEST_CLOSED';
  end if;
  if jsonb_typeof(p_essay_references) <> 'array' or jsonb_array_length(p_essay_references) < 1
    or jsonb_array_length(p_essay_references) > 50 or pg_column_size(p_essay_references) > 32768
  then raise exception using errcode = '22023', message = 'US_CONAN_ESSAY_EVIDENCE_REQUIRED'; end if;

  select c.* into v_candidate from us_conan_case_candidates_v1 c
  where c.snapshot_id = p_snapshot_id and c.stable_candidate_key = trim(p_stable_candidate_key);
  if found and (
    v_candidate.case_name <> trim(p_case_name) or v_candidate.citation <> trim(p_citation)
    or v_candidate.normalized_citation <> trim(p_normalized_citation)
    or v_candidate.court_classification <> p_court_classification
    or v_candidate.priority <> p_priority or v_candidate.priority_reasons <> coalesce(p_priority_reasons, '{}')
  ) then raise exception using errcode = '23505', message = 'US_CONAN_CANDIDATE_CONFLICT'; end if;
  if not found then
    insert into us_conan_case_candidates_v1(
      snapshot_id, stable_candidate_key, case_name, citation, normalized_citation,
      court_classification, priority, priority_reasons
    ) values (
      p_snapshot_id, trim(p_stable_candidate_key), trim(p_case_name), trim(p_citation),
      trim(p_normalized_citation), p_court_classification, p_priority, coalesce(p_priority_reasons, '{}')
    ) returning * into v_candidate;
  end if;

  for v_reference in select value from jsonb_array_elements(p_essay_references)
  loop
    if jsonb_typeof(v_reference) <> 'object'
      or coalesce(v_reference->>'essayId', '') !~ '^ALDE_[A-Z0-9_]+$'
      or length(trim(coalesce(v_reference->>'title', ''))) not between 1 and 500
      or coalesce(v_reference->>'url', '') !~ '^https://constitution\.congress\.gov/browse/essay/[^/]+/ALDE_[A-Za-z0-9_]+/$'
    then raise exception using errcode = '22023', message = 'US_CONAN_INVALID_ESSAY_EVIDENCE'; end if;
    insert into us_conan_candidate_essay_evidence_v1(candidate_id, essay_id, essay_title, essay_url)
    values (v_candidate.id, v_reference->>'essayId', trim(v_reference->>'title'), v_reference->>'url')
    on conflict (candidate_id, essay_id) do nothing;
    if not exists(
      select 1 from us_conan_candidate_essay_evidence_v1 e
      where e.candidate_id = v_candidate.id and e.essay_id = v_reference->>'essayId'
        and e.essay_title = trim(v_reference->>'title') and e.essay_url = v_reference->>'url'
    ) then raise exception using errcode = '23505', message = 'US_CONAN_ESSAY_EVIDENCE_CONFLICT'; end if;
  end loop;
  return v_candidate.id;
end;
$function$;

create or replace function us_conan_candidate_snapshot_close_v1(p_snapshot_id uuid)
returns table(snapshot_id uuid, candidate_count integer, manifest_hash text)
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $function$
declare
  v_snapshot us_conan_candidate_snapshots_v1%rowtype;
  v_count integer;
  v_hash text;
begin
  select s.* into v_snapshot from us_conan_candidate_snapshots_v1 s where s.id = p_snapshot_id for update;
  if not found then raise exception using errcode = 'P0001', message = 'US_CONAN_SNAPSHOT_NOT_FOUND'; end if;
  if v_snapshot.status = 'closed' then
    return query select v_snapshot.id, v_snapshot.candidate_count, v_snapshot.manifest_hash;
    return;
  end if;
  if exists(
    select 1 from us_conan_case_candidates_v1 c
    where c.snapshot_id = p_snapshot_id
      and not exists(select 1 from us_conan_candidate_essay_evidence_v1 e where e.candidate_id = c.id)
  ) then raise exception using errcode = '55000', message = 'US_CONAN_ESSAY_EVIDENCE_REQUIRED'; end if;
  select count(*)::integer,
    encode(digest(coalesce(string_agg(
      c.stable_candidate_key || chr(31) || c.normalized_citation || chr(31) || c.court_classification || chr(31)
      || c.priority::text || chr(31) || coalesce((
        select string_agg(e.essay_id || chr(30) || e.essay_url, chr(29) order by e.essay_id)
        from us_conan_candidate_essay_evidence_v1 e where e.candidate_id = c.id
      ), ''), chr(28) order by c.stable_candidate_key), ''), 'sha256'), 'hex')
  into v_count, v_hash
  from us_conan_case_candidates_v1 c where c.snapshot_id = p_snapshot_id;
  if v_count = 0 then raise exception using errcode = '55000', message = 'US_CONAN_EMPTY_SNAPSHOT'; end if;
  update us_conan_candidate_snapshots_v1 s set
    status = 'closed', candidate_count = v_count, manifest_hash = v_hash, closed_at = now()
  where s.id = p_snapshot_id returning s.* into v_snapshot;
  return query select v_snapshot.id, v_snapshot.candidate_count, v_snapshot.manifest_hash;
end;
$function$;

create or replace function us_conan_candidate_review_v1(
  p_candidate_id uuid,
  p_expected_revision integer,
  p_status text,
  p_official_scotus_identity_verified boolean,
  p_constitutional_essay_context_verified boolean,
  p_official_authority_verified boolean,
  p_constitutional_holding_verified boolean,
  p_official_authority_url text,
  p_safe_evidence jsonb,
  p_reviewed_by text,
  p_review_reason text
)
returns table(review_id uuid, review_revision integer, review_status text)
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $function$
declare
  v_current_revision integer;
  v_review us_conan_candidate_reviews_v1%rowtype;
begin
  if not exists(
    select 1 from us_conan_case_candidates_v1 c
    join us_conan_candidate_snapshots_v1 s on s.id = c.snapshot_id
    where c.id = p_candidate_id and s.status = 'closed'
  ) then raise exception using errcode = '55000', message = 'US_CONAN_CLOSED_CANDIDATE_REQUIRED'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_candidate_id::text, 1700));
  select coalesce(max(r.revision), 0) into v_current_revision
  from us_conan_candidate_reviews_v1 r where r.candidate_id = p_candidate_id;
  if v_current_revision <> p_expected_revision then
    raise exception using errcode = '40001', message = 'US_CONAN_REVIEW_STALE_REVISION';
  end if;
  insert into us_conan_candidate_reviews_v1(
    candidate_id, revision, status, official_scotus_identity_verified,
    constitutional_essay_context_verified, official_authority_verified,
    constitutional_holding_verified, official_authority_url, safe_evidence,
    reviewed_by, review_reason
  ) values (
    p_candidate_id, v_current_revision + 1, p_status, p_official_scotus_identity_verified,
    p_constitutional_essay_context_verified, p_official_authority_verified,
    p_constitutional_holding_verified, nullif(trim(p_official_authority_url), ''),
    coalesce(p_safe_evidence, '{}'::jsonb), trim(p_reviewed_by), trim(p_review_reason)
  ) returning * into v_review;
  return query select v_review.id, v_review.revision, v_review.status;
end;
$function$;

create or replace view us_conan_candidate_current_v1
with (security_barrier = true)
as
select
  c.*,
  coalesce(r.revision, 0) as review_revision,
  coalesce(r.status, 'candidate') as constitutional_relevance_status,
  r.official_scotus_identity_verified,
  r.constitutional_essay_context_verified,
  r.official_authority_verified,
  r.constitutional_holding_verified,
  r.official_authority_url,
  r.reviewed_at
from us_conan_case_candidates_v1 c
left join lateral (
  select review.* from us_conan_candidate_reviews_v1 review
  where review.candidate_id = c.id order by review.revision desc limit 1
) r on true;

alter table us_conan_candidate_snapshots_v1 enable row level security;
alter table us_conan_case_candidates_v1 enable row level security;
alter table us_conan_candidate_essay_evidence_v1 enable row level security;
alter table us_conan_candidate_reviews_v1 enable row level security;

revoke all on table us_conan_candidate_snapshots_v1, us_conan_case_candidates_v1,
  us_conan_candidate_essay_evidence_v1, us_conan_candidate_reviews_v1 from public;
revoke all on us_conan_candidate_current_v1 from public;
revoke all on function us_conan_candidate_snapshot_open_v1(text, text, text, text, text, timestamptz, text) from public;
revoke all on function us_conan_candidate_upsert_v1(uuid, text, text, text, text, text, integer, text[], jsonb) from public;
revoke all on function us_conan_candidate_snapshot_close_v1(uuid) from public;
revoke all on function us_conan_candidate_review_v1(uuid, integer, text, boolean, boolean, boolean, boolean, text, jsonb, text, text) from public;

do $permissions$
begin
  if exists(select 1 from pg_roles where rolname = 'anon') then
    revoke all on table us_conan_candidate_snapshots_v1, us_conan_case_candidates_v1,
      us_conan_candidate_essay_evidence_v1, us_conan_candidate_reviews_v1 from anon;
    revoke all on us_conan_candidate_current_v1 from anon;
  end if;
  if exists(select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on table us_conan_candidate_snapshots_v1, us_conan_case_candidates_v1,
      us_conan_candidate_essay_evidence_v1, us_conan_candidate_reviews_v1 from authenticated;
    revoke all on us_conan_candidate_current_v1 from authenticated;
  end if;
  if exists(select 1 from pg_roles where rolname = 'service_role') then
    grant select on table us_conan_candidate_snapshots_v1, us_conan_case_candidates_v1,
      us_conan_candidate_essay_evidence_v1, us_conan_candidate_reviews_v1 to service_role;
    grant select on us_conan_candidate_current_v1 to service_role;
    grant execute on function us_conan_candidate_snapshot_open_v1(text, text, text, text, text, timestamptz, text) to service_role;
    grant execute on function us_conan_candidate_upsert_v1(uuid, text, text, text, text, text, integer, text[], jsonb) to service_role;
    grant execute on function us_conan_candidate_snapshot_close_v1(uuid) to service_role;
    grant execute on function us_conan_candidate_review_v1(uuid, integer, text, boolean, boolean, boolean, boolean, text, jsonb, text, text) to service_role;
  end if;
end;
$permissions$;

comment on table us_conan_candidate_snapshots_v1 is 'Private immutable Constitution Annotated citation manifests; not a Catalog publication.';
comment on table us_conan_case_candidates_v1 is 'Immutable citation candidates that always start unverified.';
comment on table us_conan_candidate_essay_evidence_v1 is 'Immutable official Constitution Annotated essay provenance for a citation candidate.';
comment on table us_conan_candidate_reviews_v1 is 'Append-only explicit review events; verified requires every authority and constitutional-context gate.';

commit;
