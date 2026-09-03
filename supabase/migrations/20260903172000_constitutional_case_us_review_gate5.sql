begin;

-- A verified review must bind to an exact current authority observation, official essay rows,
-- and bounded human-reviewed constitutional holding locators. Boolean assertions alone are insufficient.

do $preflight$
begin
  if exists(select 1 from us_conan_candidate_reviews_v1 where status = 'verified') then
    raise exception using errcode = '55000', message = 'US_CONAN_VERIFIED_REVIEW_RECONCILIATION_REQUIRED';
  end if;
end;
$preflight$;

alter table us_conan_candidate_essay_evidence_v1
  add constraint us_conan_candidate_essay_evidence_candidate_key unique (id, candidate_id);

alter table us_conan_candidate_reviews_v1
  add column authority_artifact_id uuid references us_conan_candidate_authority_artifacts_v1(id) on delete restrict,
  add column essay_evidence_ids uuid[] not null default '{}',
  add column holding_evidence jsonb not null default '[]'::jsonb,
  add constraint us_conan_candidate_reviews_bound_evidence_check check (
    cardinality(essay_evidence_ids) <= 50
    and jsonb_typeof(holding_evidence) = 'array'
    and pg_column_size(holding_evidence) <= 32768
    and (
      status <> 'verified'
      or (authority_artifact_id is not null and cardinality(essay_evidence_ids) > 0 and jsonb_array_length(holding_evidence) > 0)
    )
  );

create or replace function us_conan_review_validate_v1()
returns trigger
language plpgsql
set search_path = public, extensions, pg_temp
as $function$
declare
  v_candidate us_conan_case_candidates_v1%rowtype;
  v_expected_revision integer;
  v_authority us_conan_candidate_authority_artifacts_v1%rowtype;
  v_current_authority_id uuid;
  v_reference jsonb;
begin
  select c.* into v_candidate from us_conan_case_candidates_v1 c where c.id = new.candidate_id;
  if not found then raise exception using errcode = 'P0001', message = 'US_CONAN_CANDIDATE_NOT_FOUND'; end if;
  select coalesce(max(r.revision), 0) + 1 into v_expected_revision
  from us_conan_candidate_reviews_v1 r where r.candidate_id = new.candidate_id;
  if new.revision <> v_expected_revision then
    raise exception using errcode = '40001', message = 'US_CONAN_REVIEW_STALE_REVISION';
  end if;
  if new.status = 'verified' then
    if v_candidate.court_classification <> 'scotus_candidate' then
      raise exception using errcode = '22023', message = 'US_CONAN_VERIFICATION_GATE_FAILED';
    end if;
    select a.* into v_authority from us_conan_candidate_authority_artifacts_v1 a
    where a.id = new.authority_artifact_id and a.candidate_id = new.candidate_id and a.status = 'verified';
    if not found then raise exception using errcode = '22023', message = 'US_CONAN_VERIFIED_AUTHORITY_REQUIRED'; end if;
    select a.id into v_current_authority_id from us_conan_candidate_authority_current_v1 a
    where a.candidate_id = new.candidate_id;
    if v_current_authority_id is distinct from v_authority.id then
      raise exception using errcode = '40001', message = 'US_CONAN_AUTHORITY_ARTIFACT_STALE';
    end if;
    if new.official_authority_url is distinct from v_authority.details_url then
      raise exception using errcode = '22023', message = 'US_CONAN_VERIFIED_AUTHORITY_URL_MISMATCH';
    end if;
    if cardinality(new.essay_evidence_ids) <> (
      select count(distinct e.id)::integer from us_conan_candidate_essay_evidence_v1 e
      where e.candidate_id = new.candidate_id and e.id = any(new.essay_evidence_ids)
    ) then raise exception using errcode = '22023', message = 'US_CONAN_VERIFIED_ESSAY_EVIDENCE_INVALID'; end if;
    for v_reference in select value from jsonb_array_elements(new.holding_evidence)
    loop
      if jsonb_typeof(v_reference) <> 'object'
        or coalesce(v_reference->>'sourceUrl', '') not in (v_authority.details_url, v_authority.pdf_url)
        or length(trim(coalesce(v_reference->>'locator', ''))) not between 1 and 300
        or length(trim(coalesce(v_reference->>'constitutionalQuestion', ''))) not between 1 and 1000
      then raise exception using errcode = '22023', message = 'US_CONAN_VERIFIED_HOLDING_EVIDENCE_INVALID'; end if;
    end loop;
  end if;
  return new;
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
  if p_status = 'verified' then
    raise exception using errcode = '55000', message = 'US_CONAN_VERIFIED_REQUIRES_REVIEW_V2';
  end if;
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

create or replace function us_conan_candidate_review_v2(
  p_candidate_id uuid,
  p_expected_revision integer,
  p_status text,
  p_official_scotus_identity_verified boolean,
  p_constitutional_essay_context_verified boolean,
  p_official_authority_verified boolean,
  p_constitutional_holding_verified boolean,
  p_authority_artifact_id uuid,
  p_official_authority_url text,
  p_essay_evidence_ids uuid[],
  p_holding_evidence jsonb,
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
  -- v1 and v2 append to the same revision stream, so both entry points must
  -- serialize on the same candidate-scoped lock key.
  perform pg_advisory_xact_lock(hashtextextended(p_candidate_id::text, 1700));
  select coalesce(max(r.revision), 0) into v_current_revision
  from us_conan_candidate_reviews_v1 r where r.candidate_id = p_candidate_id;
  if v_current_revision <> p_expected_revision then
    raise exception using errcode = '40001', message = 'US_CONAN_REVIEW_STALE_REVISION';
  end if;
  insert into us_conan_candidate_reviews_v1(
    candidate_id, revision, status, official_scotus_identity_verified,
    constitutional_essay_context_verified, official_authority_verified,
    constitutional_holding_verified, authority_artifact_id, official_authority_url,
    essay_evidence_ids, holding_evidence, safe_evidence, reviewed_by, review_reason
  ) values (
    p_candidate_id, v_current_revision + 1, p_status, p_official_scotus_identity_verified,
    p_constitutional_essay_context_verified, p_official_authority_verified,
    p_constitutional_holding_verified, p_authority_artifact_id,
    nullif(trim(p_official_authority_url), ''), coalesce(p_essay_evidence_ids, '{}'),
    coalesce(p_holding_evidence, '[]'::jsonb), coalesce(p_safe_evidence, '{}'::jsonb),
    trim(p_reviewed_by), trim(p_review_reason)
  ) returning * into v_review;
  return query select v_review.id, v_review.revision, v_review.status;
end;
$function$;

revoke all on function us_conan_candidate_review_v2(uuid, integer, text, boolean, boolean, boolean, boolean, uuid, text, uuid[], jsonb, jsonb, text, text) from public;

do $permissions$
begin
  if exists(select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function us_conan_candidate_review_v2(uuid, integer, text, boolean, boolean, boolean, boolean, uuid, text, uuid[], jsonb, jsonb, text, text) to service_role;
  end if;
end;
$permissions$;

comment on function us_conan_candidate_review_v2(uuid, integer, text, boolean, boolean, boolean, boolean, uuid, text, uuid[], jsonb, jsonb, text, text)
  is 'Evidence-bound human/legal review transition. Verified requires current GovInfo authority, official essay rows, and bounded holding locators.';

commit;
