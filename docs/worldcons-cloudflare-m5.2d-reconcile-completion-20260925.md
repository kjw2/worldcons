# WorldCons Cloudflare M5.2d — bounded D1 reconciliation (completion)

Status: **complete**. Supabase remains the sole production read authority.
No deploy, DNS change, remote mutation from this document, D1 write authority
switch, or search/Vectorize projection work occurred. Search remains M7.

This document records M5.2d accurately as shipped on `main` (HEAD
`b7e5cd9d0c4da9021eaf42f9503ccb1ddfd942b9`, "feat: add bounded d1
reconciliation"). It does **not** claim a cutover.

## 1. What M5.2d added

M5.2c PART 2b copied Postgres data into the remote D1 databases with an
INSERT-only seam that refuses any table whose common primary-key rows already
differ. A final audit found **nine mutable drift tables** where the remote had
no rows the source lacked (`remoteOnly === 0`) but common-PK rows differed, and
sometimes source-only rows existed.

M5.2d adds a **new, separate operator-only reconciliation path** that closes
exactly that gap without weakening the copy path:

- module: `lib/cloudflare/d1/remote/reconcile.ts`
  (`buildD1RemoteReconcileManifest`)
- CLI: `scripts/d1-reconcile.ts` (`pnpm d1:reconcile`)
- focused tests: `tests/d1-reconcile.test.ts` (29 tests)
- HTTP read fallback surface: `lib/cloudflare/d1/remote/http-query.ts`
  (`createD1HttpQueryExecutor` / `createD1HttpAffectedWriter`), added in the
  same change and covered by `tests/d1-http-query.test.ts` (27 tests)

The operator is dry-run by default and applies only with an explicit
`--apply --database=<name>`. It classifies each table `exact` / `insert-only` /
`update-only` / `mixed` / `refused` / `unknown`, refuses any table with a
remote-only primary key (never a DELETE), emits only PLAIN INSERTs for
source-only rows and full-row parameterized UPDATEs by exact primary key with
PK columns excluded from `SET`, and re-reads source + remote after apply to
require row-count and canonical full-table hash equality.

`worldcons_search` is out of scope; `D1_REMOTE_RECONCILE_DATABASES` is exactly
`worldcons_core`, `worldcons_ingest`, `worldcons_ops`.

## 2. Focused test evidence

Run from a clean tree at HEAD:

| suite | command | result |
| --- | --- | --- |
| reconcile | `pnpm test:d1-reconcile` | **29 / 29 pass** |
| copy-data | `pnpm test:d1-copy-data` | **58 / 58 pass** |
| http-query | `pnpm test:d1-http-query` | **27 / 27 pass** |
| typecheck | `pnpm typecheck` | pass |
| diff check | `git diff --check` | pass |

Combined reconcile + copy-data + http-query run: **114 / 114 pass**.

## 3. Reconciliation evidence

### 3.1 `glossary_candidates`

`glossary_candidates` was reconciled with **50 updates** (changed common-PK
rows; no inserts, no remote-only keys).

### 3.2 Remaining eight tables

The remaining mutable-drift tables were reconciled with **21 inserts + 51
updates** total.

### 3.3 Final dry-run snapshot (exact)

A direct final dry-run snapshot of all **nine** mutable-drift tables reported,
for every table:

- `state: "exact"`, `action: "none"`, `verified: true`;
- source row count == remote row count and source canonical hash == remote
  canonical hash;
- `remoteOnlyRowCount: 0`;
- zero planned writes.

Because the reconcile seam re-reads both sides and requires canonical full-table
hash equality, `exact` + `source == remote` + `remoteOnly === 0` + zero planned
writes is the acceptance condition: a rerun is a verified no-op.

Supabase remained the authority throughout; M5.2d performed remote D1 writes
only through the explicit `--apply` operator path and never changed read
authority.

## 4. Safety contract (unchanged)

- Supabase is the sole production read authority.
- No Worker deploy, DNS change, or Supabase authority switch.
- No Delete/Truncate/Replace/Upsert/On-Conflict, no DDL, no PK mutation.
- Every reconciled value is a bound parameter, never interpolated SQL.
- `worldcons_search` and the search projection remain untouched (M7).

## 5. What comes next

M6.1 — the smallest meaningful reference-read shadow slice — is documented in
`docs/worldcons-cloudflare-m6.1-reference-read-shadow-20260925.md`. M6.0 is the
planning/transition entry (this document + the full-migration-plan update), not
a cutover. M7 (search projection + Vectorize) is explicitly out of scope.
