# WorldCons Cloudflare M5.2b - D1 Import Emitter and Local Apply

Date: 2026-09-21

Baseline: clean HEAD `b2f65d9` (feat: add cloudflare m5.2a canonical converter). No Orca, no
deploy, no remote D1 creation, no D1 read or write against Cloudflare, no DNS change, no
Supabase/production mutation, no authority switch. The existing `supabase/migrations/*.sql` files
are read-only inputs and were not modified.

## 1. Objective and scope

M5 is "create four D1 databases, implement PostgreSQL export -> canonical transform -> D1 import".
M5.2a delivered the first two stages; M5.2b delivers the third as a local-only, platform-neutral
seam:

- the `D1ImportStatement` / `D1ImportTarget` contract;
- a deterministic D1 import emitter that reduces every canonical table dataset to parameterized
  `insert` statements plus a literal SQL script;
- a local `node:sqlite` apply target and a transactional apply;
- import round-trip verification that re-derives the M5.1 per-table/database hashes from the
  target and compares them to the canonical transform;
- a read-only `pnpm d1:import` operator CLI and machine-readable report.

Out of scope for M5.2b (deferred to M5.2c+): remote D1 creation, the actual Postgres -> Cloudflare
D1 data copy, shadow reads (M6), and any read/write authority switch. `worldcons_search` stays
empty because its FTS5 projection is M7.

## 2. Method (reproducible, local-only)

- `lib/cloudflare/d1/import/emitter.ts` reduces a canonical dataset to multi-row parameterized
  inserts. The only non-parameter text is the table name and the authored column names, which are
  re-validated against `^[a-z_][a-z0-9_]*$` and fail closed.
- `D1_MAX_BOUND_PARAMETERS = 100` mirrors the D1 limit: rows per statement are derived from the
  column count (`floor(100 / columns)`), so a wide table such as `articles` emits one row per
  statement and a narrow table packs 50. A caller request above the limit is clamped, not obeyed.
- `lib/cloudflare/d1/import/literal.ts` renders the same statements as a literal SQL script for
  `wrangler d1 execute --file`: text is quote-escaped and blobs are `X'hex'`.
- `lib/cloudflare/d1/import/apply.ts` applies the local DDL, then the inserts inside one transaction
  (begin/rollback on failure). Verification reads each table back through the same projection the
  transform used, revives JSON-family text, re-derives the canonical dataset, and compares the
  per-table and per-database hashes. A stored D1 row is already the canonical scalar, so the only
  revival needed is parsing the `json`/`array` text so the shared M5.1 canonicalizer reproduces the
  identical bytes.
- `lib/cloudflare/d1/import/pipeline.ts` is the end-to-end seam: local DDL -> convert -> emit ->
  apply -> verify, per selected database, producing a `D1ImportReport`.
- `lib/cloudflare/d1/import/local-target.ts` wraps `node:sqlite`; like the `pg` operator source it
  is deliberately not re-exported from the barrel so runtime Workers code never loads it.
- The CLI refuses to guess a production read: `--source=postgres` requires `--url=` or
  `WORLDCONS_D1_SOURCE_URL`, and a missing value fails closed with exit code 1.

## 3. Contract

| Type | Meaning |
| --- | --- |
| `D1ImportStatement` | a `?`-parameterized statement plus its bound values (blobs are bytes). |
| `D1ImportTarget` | the write boundary: `exec` (DDL/multi-statement), `run` (one bound statement), `all` (verification read). |
| `D1TableImport` / `D1DatabaseImport` | emitted statements, counts and literal `sql` per table/database. |
| `D1TableVerification` / `D1DatabaseVerification` | read-back row counts and recomputed vs expected canonical hashes. |
| `D1ImportReport` | `stage: "d1-import"`, version fields, source/target, per-database results, skipped tables, totals incl. `verified`. |

## 4. Coverage

| Database | Imported tables | Notes |
| --- | ---: | --- |
| `worldcons_core` | 30 | includes `articles` / `article_content_versions_p3`; `search_vector` and `embedding` stay relocated |
| `worldcons_ingest` | 26 | no relocated columns |
| `worldcons_ops` | 19 | no relocated columns |
| `worldcons_search` | 0 | `search_documents` (derived) and `search_fts` (virtual) are reported as skipped; the projection is M7 |
| Total | 75 | every migrated Postgres table |

## 5. Verification

| Check | Result |
| --- | --- |
| `pnpm test:d1-import` | Pass, 14/14 |
| `pnpm test:d1-schema` | Pass, 19/19 (no regression) |
| `pnpm test:d1-convert` | Pass, 10/10 (no regression) |
| `pnpm exec tsc --noEmit` | Pass |
| `pnpm lint` | Pass |
| `pnpm check` | Pass |
| `pnpm build` (Next/Vercel path) | Pass |
| `pnpm check:vinext` | Pass, 100% compatible (16 supported, 0 partial, 0 issues) |
| `pnpm build:vinext` | Pass |
| `pnpm d1:import --source=memory` | Pass, 4 databases / 75 tables / 0 rows, `verified true`, skips `search_documents`/`search_fts` |
| `pnpm d1:import --source=memory --database=worldcons_core --fixture=... --db-dir=... --emit=... --report` | Pass, 30 tables / 1 row / 1 statement, `verified true`, emits a literal insert and writes the report |
| `pnpm d1:import --source=postgres` (no URL) | Pass, fails closed with exit code 1 |
| Remote surface | None: no remote database created, no Cloudflare D1 read/write, no deploy, no DNS change, no authority switch |

The focused tests prove: (1) the emitter excludes relocated columns, binds blobs as bytes, orders
by the canonical dataset and is order-independent; (2) rows per statement stay within the D1
100-parameter limit and an oversized request is clamped; (3) the literal renderer escapes quotes
and hex-encodes blobs; (4) the emitter fails closed on a mismatched dataset and on derived/virtual
tables; (5) a local apply + verify round trip reproduces the canonical hashes and rows for every
plan 6.1 family, including `jsonb`, arrays and `bytea`; (6) verification detects a tampered value
and a missing row; (7) a failed insert rolls the transaction back instead of leaving partial rows;
(8) an unconfigured source and a missing target fail closed; (9) the live empty report covers four
databases / 75 tables and matches the M5.2a canonical transform, deterministically; (10) a real
migratable table imports and verifies end to end for real core (`sources`), ingest
(`ingestion_runs`) and ops (`llm_settings`) tables, asserting the row counts, the re-derived
per-database/per-table hashes and the stored canonical `jsonb` text; (11) verification reads are
bounded, primary-key ordered and exclude relocated columns; and (12) a static guard keeps
`node:sqlite` out of the import barrel and the CLI gated behind the explicit source URL.

## 6. Files

Added:

- `lib/cloudflare/d1/import/types.ts` - the import/verify contract and report types.
- `lib/cloudflare/d1/import/literal.ts` - deterministic SQLite/D1 literal rendering.
- `lib/cloudflare/d1/import/emitter.ts` - parameterized import emitter and script renderer.
- `lib/cloudflare/d1/import/apply.ts` - transactional local apply and hash verification.
- `lib/cloudflare/d1/import/pipeline.ts` - convert -> emit -> apply -> verify pipeline and report.
- `lib/cloudflare/d1/import/local-target.ts` - local `node:sqlite` target (not barrelled).
- `lib/cloudflare/d1/import/index.ts` - import barrel.
- `scripts/d1-import.ts` - `pnpm d1:import` operator CLI (`--source`, `--url`, `--fixture`, `--database`, `--tables`, `--batch-size`, `--limit`, `--rows-per-statement`, `--db`, `--db-dir`, `--emit`, `--json`, `--report`).
- `tests/d1-import.test.ts` - 14 focused tests.
- this document.

Changed:

- `package.json` - `d1:import`, `test:d1-import`; `test:d1-import` added to `verify:release`.
- `docs/worldcons-cloudflare-full-migration-plan-20260920.md` - the M5 progress note and migration checklist record M5.2b.

## 7. Rollback

Repository-only: delete `lib/cloudflare/d1/import/`, `scripts/d1-import.ts`,
`tests/d1-import.test.ts`, this document, and revert the `package.json` additions. Nothing remote
was created or written, so there is no database or DNS rollback.

## 8. Next (M5.2c+)

Remote D1 database creation and the actual Postgres -> Cloudflare D1 data copy (bounded, verified
batches), then M6 shadow reads that compare the D1 read path against Postgres.
