begin;

create or replace function source_inventory_snapshot_evidence_v2(
  p_snapshot_id uuid,
  p_coverage_evidence jsonb,
  p_expected_count integer default null,
  p_expected_count_basis text default null
)
returns boolean
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $function$
begin
  if jsonb_typeof(coalesce(p_coverage_evidence, '{}'::jsonb)) <> 'object'
    or pg_column_size(coalesce(p_coverage_evidence, '{}'::jsonb)) > 16384
    or (p_expected_count is not null and p_expected_count < 0)
    or ((p_expected_count is null) <> (p_expected_count_basis is null))
    or (p_expected_count_basis is not null and length(trim(p_expected_count_basis)) not between 1 and 200)
  then
    raise exception using errcode = '22023', message = 'CASE_BACKFILL_INVALID_COVERAGE_EVIDENCE';
  end if;

  update source_inventory_snapshots s set
    coverage_evidence = p_coverage_evidence,
    expected_count = p_expected_count,
    expected_count_basis = nullif(trim(p_expected_count_basis), '')
  where s.id = p_snapshot_id and s.status = 'open';
  if not found then raise exception using errcode = '55000', message = 'CASE_BACKFILL_SNAPSHOT_NOT_OPEN'; end if;
  return true;
end;
$function$;

revoke all on function source_inventory_snapshot_evidence_v2(uuid, jsonb, integer, text) from public;

do $permissions$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function source_inventory_snapshot_evidence_v2(uuid, jsonb, integer, text) to service_role;
  end if;
end;
$permissions$;

comment on function source_inventory_snapshot_evidence_v2(uuid, jsonb, integer, text)
  is 'Atomically fixes coverage evidence and its official expected-count basis before an inventory manifest is closed.';

commit;
