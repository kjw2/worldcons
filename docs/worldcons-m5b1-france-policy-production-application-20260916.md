# WorldCons M5-B1 — France QPC/DC production policy application

Date: 2026-09-16

## Result

The owner-approved France Conseil constitutionnel historical source policy was applied to the linked production Supabase project `worldcons`.

- project ref: `eawgnnytdvjuwhczyhlq`
- migration: `20260916090000_constitutional_case_france_policy_approval.sql`
- source key: `fr-conseil-constitutionnel`
- policy version: `france-dila-constit-2026-09-v1`
- approved scope: France 2010-2024 `QPC` / `DC` only
- reviewer: `WorldCons owner via explicit approval`
- reviewed at: `2026-09-16T00:00:00Z`
- review due: `2027-03-15T00:00:00Z`
- bounded replay retention: 90 days
- request delay: 3000 ms
- max concurrency: 1
- AI egress: denied

Spain, Germany 1998-2023, and France `L` / `LP` / `OTHER_CONSEIL_NATURE` are not covered by this approval.

## Pre-apply safety checks

`supabase projects list` identified the linked healthy project as `worldcons` in `ap-northeast-2`.

`supabase migration list` showed exactly one local migration missing remotely:

```text
20260916090000 | <remote missing>
```

`supabase db push --dry-run` reported exactly one migration would be applied:

```text
20260916090000_constitutional_case_france_policy_approval.sql
```

No unrelated pending migration was present.

## Production application

`supabase db push` applied only `20260916090000_constitutional_case_france_policy_approval.sql`.

A second `supabase migration list` confirmed local and remote both contain `20260916090000`.

## Read-only post-apply verification

A linked read-only SQL query confirmed exactly the approved policy row values:

```text
source_key                 = fr-conseil-constitutionnel
policy_version             = france-dila-constit-2026-09-v1
reviewed_by                = WorldCons owner via explicit approval
reviewed_at                = 2026-09-16T00:00:00Z
review_due_at              = 2027-03-15T00:00:00Z
retention_days             = 90
min_request_delay_ms       = 3000
max_concurrency            = 1
default_text_access_policy = full
allow_raw_snapshot         = false
aiEgress                   = denied
approvedScope              = france_conseil_2010_2024_qpc_dc
```

The historical execution flag was not enabled. Read-only counts after policy application were:

```text
France source_inventory_snapshots = 0
France source_backfill_runs        = 0
```

Therefore M5-B1 recorded the immutable production policy only. It did not open an inventory snapshot, create a backfill run, publish Catalog data, enable public reads, or invoke Gemini.

## Next gate

M5-B2 is a separate action: enable the France history execution flag only for the bounded 2024 private-shadow canary, then run QPC and DC through the existing fail-closed preflight and reconciliation path. Catalog publication remains a later independent gate.
