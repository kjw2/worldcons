begin;

-- Append-only official authority observations remain distinct from human/legal relevance reviews.

create table if not exists us_conan_candidate_authority_artifacts_v1 (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references us_conan_case_candidates_v1(id) on delete restrict,
  resolver_version text not null,
  resolution_hash text not null,
  status text not null,
  citation text not null,
  official_case_name text,
  details_url text not null,
  pdf_url text,
  payload_hash text,
  blocking text[] not null default '{}',
  observed_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (candidate_id, resolver_version, resolution_hash),
  constraint us_conan_candidate_authority_status_check check (status in ('verified', 'not_found', 'mismatch', 'blocked')),
  constraint us_conan_candidate_authority_hash_check check (
    resolution_hash ~ '^[0-9a-f]{64}$' and (payload_hash is null or payload_hash ~ '^[0-9a-f]{64}$')
  ),
  constraint us_conan_candidate_authority_url_check check (
    details_url ~ '^https://www\.govinfo\.gov/app/details/USREPORTS-[0-9]+/USREPORTS-[0-9]+-[0-9]+$'
    and (pdf_url is null or pdf_url ~ '^https://www\.govinfo\.gov/content/pkg/USREPORTS-[0-9]+/pdf/USREPORTS-[0-9]+-[0-9]+\.pdf$')
  ),
  constraint us_conan_candidate_authority_verified_shape_check check (
    (status = 'verified' and official_case_name is not null and pdf_url is not null
      and payload_hash is not null and cardinality(blocking) = 0)
    or (status <> 'verified' and cardinality(blocking) > 0)
  ),
  constraint us_conan_candidate_authority_text_check check (
    length(resolver_version) between 1 and 120 and length(citation) between 1 and 300
    and (official_case_name is null or length(official_case_name) between 1 and 500)
    and cardinality(blocking) <= 20
  )
);

create index if not exists us_conan_candidate_authority_latest_idx
  on us_conan_candidate_authority_artifacts_v1(candidate_id, observed_at desc, created_at desc);

drop trigger if exists us_conan_candidate_authority_immutable_trigger on us_conan_candidate_authority_artifacts_v1;
create trigger us_conan_candidate_authority_immutable_trigger
before update or delete on us_conan_candidate_authority_artifacts_v1
for each row execute function case_backfill_prevent_mutation_v1();

create or replace function us_conan_candidate_authority_record_v1(
  p_candidate_id uuid,
  p_resolver_version text,
  p_status text,
  p_citation text,
  p_official_case_name text,
  p_details_url text,
  p_pdf_url text,
  p_payload_hash text,
  p_blocking text[],
  p_observed_at timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $function$
declare
  v_candidate us_conan_case_candidates_v1%rowtype;
  v_parts text[];
  v_expected_details text;
  v_expected_pdf text;
  v_resolution_hash text;
  v_id uuid;
begin
  select c.* into v_candidate from us_conan_case_candidates_v1 c
  join us_conan_candidate_snapshots_v1 s on s.id = c.snapshot_id
  where c.id = p_candidate_id and s.status = 'closed';
  if not found then raise exception using errcode = '55000', message = 'US_CONAN_CLOSED_CANDIDATE_REQUIRED'; end if;
  if v_candidate.citation <> trim(p_citation) then
    raise exception using errcode = '22023', message = 'US_CONAN_AUTHORITY_CITATION_MISMATCH';
  end if;
  v_parts := regexp_match(trim(p_citation), '^([0-9]+)\s+U\.\s*S\.\s+(?:\([^)]+\)\s+)?([0-9]+)');
  if v_parts is null then raise exception using errcode = '22023', message = 'US_CONAN_AUTHORITY_CITATION_INVALID'; end if;
  v_expected_details := format('https://www.govinfo.gov/app/details/USREPORTS-%s/USREPORTS-%s-%s', v_parts[1], v_parts[1], v_parts[2]);
  v_expected_pdf := format('https://www.govinfo.gov/content/pkg/USREPORTS-%s/pdf/USREPORTS-%s-%s.pdf', v_parts[1], v_parts[1], v_parts[2]);
  if p_details_url <> v_expected_details or (p_pdf_url is not null and p_pdf_url <> v_expected_pdf) then
    raise exception using errcode = '22023', message = 'US_CONAN_AUTHORITY_URL_MISMATCH';
  end if;
  if p_status = 'verified' and v_candidate.court_classification <> 'scotus_candidate' then
    raise exception using errcode = '22023', message = 'US_CONAN_VERIFICATION_GATE_FAILED';
  end if;
  if p_observed_at > now() + interval '5 minutes' then
    raise exception using errcode = '22023', message = 'US_CONAN_AUTHORITY_OBSERVED_AT_INVALID';
  end if;
  v_resolution_hash := encode(digest(
    concat_ws(chr(31), p_status, trim(p_citation), coalesce(trim(p_official_case_name), ''),
      p_details_url, coalesce(p_pdf_url, ''), coalesce(p_payload_hash, ''),
      array_to_string(coalesce(p_blocking, '{}'), chr(30)), p_observed_at::text),
    'sha256'
  ), 'hex');
  insert into us_conan_candidate_authority_artifacts_v1(
    candidate_id, resolver_version, resolution_hash, status, citation, official_case_name,
    details_url, pdf_url, payload_hash, blocking, observed_at
  ) values (
    p_candidate_id, trim(p_resolver_version), v_resolution_hash, p_status, trim(p_citation),
    nullif(trim(p_official_case_name), ''), p_details_url, p_pdf_url, p_payload_hash,
    coalesce(p_blocking, '{}'), p_observed_at
  )
  on conflict (candidate_id, resolver_version, resolution_hash) do nothing
  returning id into v_id;
  if v_id is null then
    select a.id into v_id from us_conan_candidate_authority_artifacts_v1 a
    where a.candidate_id = p_candidate_id and a.resolver_version = trim(p_resolver_version)
      and a.resolution_hash = v_resolution_hash;
  end if;
  return v_id;
end;
$function$;

create or replace view us_conan_candidate_authority_current_v1
with (security_barrier = true)
as
select distinct on (a.candidate_id) a.*
from us_conan_candidate_authority_artifacts_v1 a
order by a.candidate_id, a.observed_at desc, a.created_at desc, a.id desc;

alter table us_conan_candidate_authority_artifacts_v1 enable row level security;
revoke all on table us_conan_candidate_authority_artifacts_v1 from public;
revoke all on us_conan_candidate_authority_current_v1 from public;
revoke all on function us_conan_candidate_authority_record_v1(uuid, text, text, text, text, text, text, text, text[], timestamptz) from public;

do $permissions$
begin
  if exists(select 1 from pg_roles where rolname = 'anon') then
    revoke all on table us_conan_candidate_authority_artifacts_v1 from anon;
    revoke all on us_conan_candidate_authority_current_v1 from anon;
  end if;
  if exists(select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on table us_conan_candidate_authority_artifacts_v1 from authenticated;
    revoke all on us_conan_candidate_authority_current_v1 from authenticated;
  end if;
  if exists(select 1 from pg_roles where rolname = 'service_role') then
    grant select on table us_conan_candidate_authority_artifacts_v1 to service_role;
    grant select on us_conan_candidate_authority_current_v1 to service_role;
    grant execute on function us_conan_candidate_authority_record_v1(uuid, text, text, text, text, text, text, text, text[], timestamptz) to service_role;
  end if;
end;
$permissions$;

comment on table us_conan_candidate_authority_artifacts_v1 is 'Append-only GovInfo/U.S. Reports identity observations; never a constitutional relevance review by itself.';

commit;
