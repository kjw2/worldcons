# WorldCons Cloudflare M5.2a - Postgres -> Canonical Transform

Date: 2026-09-21

Baseline: clean HEAD `91ea06f` (feat: complete cloudflare m5.1 d1 schema coverage). No Orca, no
deploy, no remote D1 creation, no D1 read or write, no DNS change, no Supabase/production mutation,
no authority switch. Supabase remains production authority. The existing
`supabase/migrations/*.sql` files are read-only inputs and were not modified.

## 1. Objective and scope

M5's objective is "create four D1 databases, implement PostgreSQL export -> canonical transform ->
D1 import". M5.2 is that converter, and M5.2a delivers its first two stages as a platform-neutral,
read-only seam:

- the `PostgresRowSource` export contract, a read-only `pg` operator adapter, and an in-memory
  source for tests and local runs;
- the deterministic Postgres projection for each D1 table: stored columns in authored order,
  primary-key read order, bounded batches;
- the canonical transform of raw Postgres rows into canonical scalar datasets through the M5.1
  converters, with the per-table and per-database hashes the M5 acceptance check compares;
- a read-only `pnpm d1:convert` operator CLI and machine-readable report.

Out of scope for M5.2a (deferred to M5.2b+): the D1 import emitter, the actual data copy into a D1
database, remote D1 creation, and any read/write authority switch. `worldcons_search` has no
migratable Postgres table yet (its FTS5 projection is M7), so M5.2a reports it as covered but empty.
## 2. Method (reproducible, read-only)

- `lib/cloudflare/d1/convert/select.ts` derives the projection from the M5.1 schema, so relocated
  `tsvector`/`vector` columns and derived projection columns can never be read as D1 columns.
  Every Postgres identifier is validated against `^[a-z_][a-z0-9_]*$` and fails closed, and every
  value is a bound parameter - no identifier or value is interpolated into SQL.
- `lib/cloudflare/d1/convert/transform.ts` reduces rows with `canonicalizeRow` and hashes with
  `hashCanonicalTable` (M5.1), so the canonical scalar families and the per-table hash are exactly
  the primitives the M5/M6 parity checks compare. A database hash composes the table hashes in
  table-name order, so it is independent of read order.
- `lib/cloudflare/d1/convert/pipeline.ts` reads each migratable table in bounded batches
  (default 1000 rows), optionally capped by `maxRows`, and classifies virtual/derived tables as
  skipped rather than silently dropping them.
- Sources: `memory-source.ts` (tests/local) and `postgres-source.ts` (operator-only: the session is
  switched to read-only, identifiers are validated, values are bound, and no DDL/DML is issued).
  The `pg` adapter is deliberately not re-exported from the convert barrel so runtime Workers code
  never loads `pg`; only the operator CLI imports it directly.
- The CLI refuses to guess a production read: `--source=postgres` requires `--url=` or the
  `WORLDCONS_D1_SOURCE_URL` environment variable, and a missing value fails closed with exit code 1.

## 3. Contract

| Type | Meaning |
| --- | --- |
| `PostgresReadRequest` | `relation`, projected `columns`, `orderBy` (primary key), `limit`, `offset`. |
| `PostgresRowSource` | `isConfigured()`, `readRows(request)`, `close()`; a disabled source fails closed. |
| `CanonicalTableDataset` | table/database/source, primary key, columns, relocations, `rowCount`, `hash`, canonical `rows`. |
| `CanonicalDatabaseDataset` | table datasets plus `tableCount`, `rowCount`, composed `hash`. |
| `CanonicalTableSummary` / `CanonicalDatabaseSummary` | row-free views used by the report. |
| `CanonicalConversionReport` | `stage: "canonical-transform"`, version fields, source, database summaries, skipped tables, totals. |
## 4. Coverage

| Database | Migratable tables | Notes |
| --- | ---: | --- |
| `worldcons_core` | 30 | includes `articles` / `article_content_versions_p3` (`search_vector` -> FTS5, `embedding` -> Vectorize) and `article_embedding_artifacts` (`embedding` -> Vectorize) |
| `worldcons_ingest` | 26 | no relocated columns |
| `worldcons_ops` | 19 | no relocated columns |
| `worldcons_search` | 0 | `search_documents` (derived) and `search_fts` (virtual) are reported as skipped; the projection is M7 |
| Total | 75 | every migrated Postgres table |

Relocations are recorded on each dataset (`relocated: [{ column, target }]`) and are never emitted as
D1 columns, matching plan 6.1 and the M5.1 schema.
## 5. Verification

| Check | Result |
| --- | --- |
| `pnpm test:d1-convert` | Pass, 10/10 |
| `pnpm test:d1-schema` | Pass, 19/19 (no regression) |
| `pnpm exec tsc --noEmit` | Pass |
| `pnpm lint` | Pass |
| `pnpm check` | Pass |
| `pnpm build` (Next/Vercel path) | Pass |
| `pnpm verify:release` (full chain) | Pass; the host shell exports `INGEST_USER_AGENT`, which is cleared for the run (see note) |
| `pnpm check:vinext` | Pass, 100% compatible (16 supported, 0 partial, 0 issues) |
| `pnpm build:vinext` | Pass |
| `pnpm d1:convert --source=memory` | Pass, 4 databases / 75 tables / 0 rows; skips `search_documents` (derived) and `search_fts` (virtual) |
| `pnpm d1:convert --source=postgres` (no URL) | Pass, fails closed with exit code 1 |
| Remote surface | None: no remote database created, no D1 read/write, no deploy, no DNS change, no authority switch |

Note: this host exports `INGEST_USER_AGENT=worldcons/0.1 (+https://localhost:3000)`, which overrides the default crawler User-Agent in `lib/crawler/user-agents.ts` and makes `tests/ingest-workflow-hardening.test.ts` fail on a pre-existing, environment-only assertion. With that shell variable cleared, `pnpm verify:release` passes end to end. This is unrelated to M5.2a, which does not touch crawler headers.

The focused tests prove: (1) the projection excludes relocated and derived columns while ordering by
primary key, and invalid identifiers throw; (2) the transform normalizes every plan 6.1 family
(uuid, timestamp, jsonb, array, bigint, integer, real, boolean, enum) and its table hash is
independent of row order and equal to the M5.1 `hashCanonicalTable` primitive; (3) the transform
fails closed on a missing NOT NULL value, an invalid enum and an invalid uuid; (4) database hashing
is table-order independent and aggregates counts; (5) the memory source projects columns, bounds
reads, and fails closed once closed; (6) `convertTable` bounds reads with `batchSize`/`maxRows` and
rejects a non-positive batch size; (7) an unconfigured source fails closed; (8) the live report
covers the four databases, sums to 75 tables, and deterministically skips the two derived search
tables; and (9) a static guard keeps the `pg` adapter out of the convert barrel and the CLI gated
behind the explicit source URL.
## 6. Files

Added:

- `lib/cloudflare/d1/convert/types.ts` - export/transform contract and report types.
- `lib/cloudflare/d1/convert/select.ts` - deterministic projection and identifier guard.
- `lib/cloudflare/d1/convert/transform.ts` - canonical table/database transform and hashes.
- `lib/cloudflare/d1/convert/memory-source.ts` - in-memory export source.
- `lib/cloudflare/d1/convert/postgres-source.ts` - read-only `pg` operator source (not barrelled).
- `lib/cloudflare/d1/convert/pipeline.ts` - batched conversion pipeline and report builder.
- `lib/cloudflare/d1/convert/index.ts` - convert barrel.
- `scripts/d1-convert.ts` - `pnpm d1:convert` operator CLI (`--source`, `--url`, `--database`, `--tables`, `--batch-size`, `--limit`, `--json`, `--report`, `--fixture`).
- `tests/d1-convert.test.ts` - 10 focused tests.
- this document.

Changed:

- `package.json` - `d1:convert`, `test:d1-convert`; `test:d1-convert` added to `verify:release`.
- `docs/worldcons-cloudflare-full-migration-plan-20260920.md` - the M5 progress note and migration checklist record M5.2a (Postgres export + canonical transform; the D1 import/data copy remains M5.2b+).

## 7. Rollback

Repository-only: delete `lib/cloudflare/d1/convert/`, `scripts/d1-convert.ts`,
`tests/d1-convert.test.ts`, this document, and revert the `package.json` additions. Nothing remote
was created or written, so there is no database or DNS rollback.

## 8. Next (M5.2b+)

The D1 import emitter and local apply, remote D1 creation/import, and the canonical parity
comparison against Postgres under M6 shadow reads. M5.2a intentionally stops before any D1 write.