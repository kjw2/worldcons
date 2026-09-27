# WorldCons Cloudflare M10 — bounded D1 write canary

Date: 2026-09-27
Base checkpoint: `3262928161abaf114d190a1fc4b0e0e814090725`

## Decision

**GO-D1-WRITE-CANARY: PASS for the bounded `worldcons_ops.site_events`
operator canary.**

This is not an M11 runtime write-authority switch. Normal application writes
still use the existing Supabase path. M10 proves that a deliberately isolated,
low-risk ops-domain row can be D1-authoritative, compared against Supabase and
rolled back without touching publication, ingest or admin-command authority.

## Canary scope

The selected mutation domain is the append-only analytics/event log:

```text
worldcons_ops.site_events
```

It was selected because:

- it is already modeled and populated in `worldcons_ops`;
- the D1 and Postgres schemas share the canary fields;
- it does not own publication or ingestion state;
- one row has a natural UUID primary-key invariant;
- rollback is an exact primary-key delete;
- the existing 65-row background delta can be kept separate from the canary by
  comparing only the canary UUID.

Pre-canary counts:

- D1 `worldcons_ops.site_events`: 15,516
- Supabase `public.site_events`: 15,581

The 65-row pre-existing delta is not treated as a canary failure and was not
modified by M10.

## Bounded row

- id: `ee3ac059-01e6-4728-a627-05fe09a66919`
- occurred_at: `2026-09-27T12:37:13Z`
- event_type: `security_event`
- path: `/__m10/d1-write-canary`
- source_key: `m10-d1-write-canary`
- result_count: `1`
- metadata:
  - `authority=d1`
  - `m10Canary=true`
  - `purpose=site_events_write_canary`
- is_bot: false

No user data or credential material is present in the row.

## Execution order

1. Verified the UUID was absent from both D1 and Supabase.
2. Inserted the row into D1 **first**.
3. D1 returned `changes=1`.
4. Read the row back from D1 by exact primary key.
5. Only after D1 read-after-write succeeded, inserted the same UUID into
   Supabase as comparison/shadow evidence.
6. Read the Supabase row back and compared the bounded fields.
7. Deleted the D1 row and verified it was absent.
8. Verified D1 total count returned to 15,516.
9. Deleted the Supabase comparison row.
10. Verified Supabase canary count was zero and total count returned to 15,581.
11. Repeated the D1 insert and attempted an identical second insert.
12. The duplicate was rejected with
    `SQLITE_CONSTRAINT_PRIMARYKEY`; the original canary remained exactly one
    row.
13. Deleted that row and reverified D1 count 15,516.

## Parity

The read-back fields matched:

- UUID
- UTC second timestamp
- event type
- canary path
- source key
- result count
- metadata content
- bot flag

SQLite `is_bot=0` and Postgres `is_bot=false` are normalized as equivalent.
SQLite metadata TEXT and Postgres JSONB are compared by canonical JSON key
ordering.

## Rollback note

One diagnostic attempt combined a parameterized SELECT with a second SQL
statement in the same Cloudflare D1 query request. Cloudflare rejected that
verification request because `params` with multiple statements is unsupported.
The delete had already completed, and separate read-only queries then verified
the row was absent and the total count had returned to 15,516. This API-shape
limitation did not weaken or bypass the rollback check.

## Code contract

`lib/cloudflare/d1/write-canary/site-events.ts` freezes the exact M10
operator contract:

- explicit UUID + UTC-second validation;
- fixed canary path/source/event type;
- parameterized D1 INSERT/SELECT/DELETE statements;
- canonical SQLite/Postgres comparison;
- fail-closed malformed-row handling.

`tests/m10-d1-write-canary.test.ts` covers the bounded contract, statement
parameterization, storage-form parity, mismatch detection and input rejection.

## Verification

- `pnpm test:m10`: 5/5 pass
- root `pnpm typecheck`: pass
- root `pnpm lint`: pass
- `git diff --check`: pass
- remote D1 insert/read/delete: pass
- remote D1 duplicate-PK rejection: pass
- Supabase comparison/read/delete: pass
- both databases restored to their exact pre-canary counts

Machine-readable evidence:
`artifacts/cloudflare-m10/go-d1-write-canary-evidence-20260927.json`.

## M11 boundary

M10 does **not** change `recordSiteEvent()`, DNS, frontend routes or any
production authority flag. M11 must introduce an explicit, reversible runtime
authority seam for the first ops domain and prove rollback/observability before
expanding to ingest or core/publication writes.
