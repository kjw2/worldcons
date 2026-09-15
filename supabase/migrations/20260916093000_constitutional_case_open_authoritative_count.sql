begin;

-- France (and any future authoritative-counted/crosschecked source) discovers
-- the official count during the governed discovery pass. The snapshot must be
-- able to exist in `open` state before that network evidence is available.
--
-- Closed/superseded authoritative snapshots still require a fixed count. A
-- failed discovery may remain count-less so the failure is auditable without
-- inventing an expected corpus size.
alter table source_inventory_snapshots
  drop constraint if exists source_inventory_snapshots_authoritative_count_check;

alter table source_inventory_snapshots
  add constraint source_inventory_snapshots_authoritative_count_check check (
    coverage_assurance not in ('authoritative_counted', 'authoritative_crosschecked')
    or expected_count is not null
    or status in ('open', 'failed')
  );

comment on constraint source_inventory_snapshots_authoritative_count_check
  on source_inventory_snapshots is
  'Authoritative counted/crosschecked snapshots may learn expected_count while open; closed or superseded snapshots must seal a non-null count, while failed snapshots may preserve an unknown count.';

commit;
