# WorldCons Cloudflare M5.1 - D1 Schema Foundation

Date: 2026-09-21

Baseline: clean HEAD `2538137` (feat: complete cloudflare m4 rpc ledger). No Orca, no
deploy, no remote D1 creation, no DNS change, no Supabase/production mutation, no
authority switch. Supabase remains production authority. The existing
`supabase/migrations/*.sql` files are read-only inputs and were not modified.

## 1. Objective and scope

M5's objective is "create four D1 databases, implement PostgreSQL export -> canonical
transform -> D1 import". M5.1 is the schema foundation of that milestone. It delivers:

- the canonical, platform-neutral D1 schema (types, tables, ownership) for the four
  databases;
- the Postgres -> D1 type mapping (plan section 6.1) as executable code;
- the canonical value/row/table hash primitives the M5.2 converter and the M5/M6 parity
  checks reuse (M5 acceptance: "canonical per-table hashes");
- a reproducible read-only scanner over the existing Supabase migrations;
- a validator that proves ownership coverage and full column parity;
- a deterministic local DDL emitter for the four `worldcons_*` databases.

M5.1 is local-only: it creates no remote database and deploys nothing.

## 2. Method (reproducible, read-only)

- `lib/cloudflare/d1/postgres/scan.ts` scans `supabase/migrations/*.sql` in filename
  order with a line-oriented regex scanner (not a general SQL parser). It handles
  `create table`, `alter table ... add/drop column`, `add constraint ... check`,
  `create index`, `create type ... as enum` and `drop table`, including string and
  dollar-quoted bodies. It never writes the migrations directory.
- The D1 schema is hand-authored in `lib/cloudflare/d1/schema/*.ts` against those
  Postgres origins.
- `buildTable` derives each column's SQLite storage kind, enum CHECK and FTS5/Vectorize
  relocation from the plan 6.1 mapping, so the authored schema cannot drift from it.
- `validateD1Schema` cross-checks the schema against the scanned registry: internal
  consistency; ownership coverage (every Postgres table owned exactly once, every
  covered entry has a D1 table, every planned entry still exists in Postgres and has no
  D1 table yet); and full column parity for covered tables (storage kind, required
  FTS5/Vectorize relocation, enum-check agreement).
- `buildD1SchemaReport` produces the machine-readable report; `pnpm d1:schema --json`
  prints it, `--emit` writes `d1/<database>/0001_init.sql`, `--report` writes the
  git-ignored `artifacts/cloudflare-m5/d1-schema-report.json`.

### 2.1 Parity defect fixed in this milestone

`buildTable` previously stored `sourceTable: spec.sourceTable ?? null`, so every migrated
table had `sourceTable === null` and `validateAgainstPostgres` returned early: column
parity was silently skipped for all 15 covered tables. M5.1 now defaults a migrated
table's `sourceTable` to the D1 table name and reserves `null` for derived projections
(`search_documents`) and virtual tables (`search_fts`). With the check actually running,
the full live schema still validates with 0 errors (section 5) - that run is the real
acceptance evidence, not the earlier no-op check.

## 3. Four databases (plan section 5)

| Database | Purpose | Covered tables in M5.1 |
| --- | --- | --- |
| `worldcons_core` | public/legal metadata and publication state | `articles`, `sources`, `tags`, `article_tags`, `glossary_terms` |
| `worldcons_ingest` | high-write operational ingestion state | `ingestion_runs`, `source_url_candidates` |
| `worldcons_ops` | administrative and operational state | `site_events`, `admin_jobs`, `admin_job_events`, `admin_audit_logs`, `admin_article_edit_history`, `llm_settings` |
| `worldcons_search` | disposable, rebuildable search projection | `search_documents`, `search_fts` |

15 covered tables. The other 62 Postgres tables are assigned an owning database as
`planned` and deferred to M5.2+ (`worldcons_core` 25, `worldcons_ingest` 24,
`worldcons_ops` 13). Relocations: `articles.search_vector` -> FTS5 (`search_fts`) and
`articles.embedding` -> Vectorize (plan 6.1/11.1/11.2); no D1 column stores a `tsvector`
or `vector`.

Continuation (M5.1b, 2026-09-21): the 25 `worldcons_core` planned tables are now fully
covered, so `worldcons_core` owns 30 tables and the remaining 37 planned tables are
`worldcons_ingest` 24 + `worldcons_ops` 13. See
`docs/worldcons-cloudflare-m5.1b-core-schema-expansion-20260921.md`.

## 4. Type mapping (plan section 6.1)

`POSTGRES_TYPE_MAPPING_RULES` is surfaced verbatim in the schema report.

| Postgres | D1 target | Note |
| --- | --- | --- |
| `uuid` | `text` | application-generated UUID (no `gen_random_uuid` default) |
| `text` / `varchar` / `citext` | `text` | stored verbatim |
| `timestamptz` / `timestamp` / `date` / `time` | `text` | normalized UTC ISO-8601 with milliseconds |
| `jsonb` / `json` | `text` | canonical JSON text (sorted keys) |
| `boolean` | `integer` | `0` / `1` |
| `smallint` / `integer` / `serial` | `integer` | JS-safe integer |
| `bigint` / `bigserial` | `text` | decimal TEXT unless proven JS-safe |
| `numeric` / `double precision` / `real` | `real` | SQLite REAL (double) |
| `text[]` / arrays | `text` | canonical JSON array text |
| enums (`create type ... as enum`) | `text` | TEXT + CHECK |
| `bytea` | `blob` | BLOB |
| `tsvector` | `fts5` | relocated to a `worldcons_search` FTS5 projection (plan 11.1) |
| `vector(1536)` | `vectorize` | relocated to a Vectorize index (plan 11.2) |

Unmapped types return `null` and fail validation (`unmapped-postgres-column`) instead of
silently defaulting to `text`.

## 5. Verification

| Check | Result |
| --- | --- |
| `pnpm d1:schema` | Pass, 15 tables (15 covered, 62 planned) across 4 databases; validation OK with full column parity enforced |
| `pnpm d1:schema --json` | Pass, machine-readable report (`version` 1, `foundationVersion` 1, `rowHashVersion` 1) |
| `pnpm test:d1-schema` | Pass, 19/19 |
| `pnpm exec tsc --noEmit` | Pass |
| `pnpm lint` | Pass |
| `pnpm check` | Pass |
| Emitted DDL applied to in-memory SQLite | Pass, every table created and `search_fts` matches `due` |
| `d1/<database>/0001_init.sql` vs emitter | Pass, byte-identical for all four databases |
| Remote surface | None: no remote database created, no deploy, no DNS change, no authority switch |
| Postgres source scan | 92 migrations, 1,174 statements, 75 tables |

## 6. Files

Added:

- `lib/cloudflare/d1/types.ts` - database/storage/relocation/ownership types and the D1 schema contract.
- `lib/cloudflare/d1/mapping.ts` - Postgres -> D1 type mapping and canonical conversion families.
- `lib/cloudflare/d1/canonical-values.ts` - canonical scalar converters.
- `lib/cloudflare/d1/canonical-row.ts` - canonical row/table hashing (`hashCanonicalRow`, `hashCanonicalTable`).
- `lib/cloudflare/d1/postgres/scan.ts` - read-only Supabase-migration scanner.
- `lib/cloudflare/d1/schema/*.ts` - authored schema (`shared.ts`, `ownership.ts`, `worldcons-core|ingest|ops|search.ts`, `index.ts`).
- `lib/cloudflare/d1/ddl.ts` - deterministic local DDL emitter.
- `lib/cloudflare/d1/validate.ts` - schema/ownership/parity validator.
- `lib/cloudflare/d1/index.ts` - barrel + `buildD1SchemaReport`.
- `scripts/d1-schema.ts` - `pnpm d1:schema` CLI (`--json`, `--emit`, `--report`).
- `d1/<database>/0001_init.sql` - emitted local DDL for the four databases.
- `tests/d1-schema.test.ts` - 19 focused tests.
- this document.

Changed:

- `lib/cloudflare/d1/schema/shared.ts` - `buildTable` now defaults a migrated table's `sourceTable` to the D1 table name (section 2.1).
- `package.json` - `d1:schema`, `test:d1-schema`; `test:d1-schema` added to `verify:release`.
- `.gitignore` - ignore the generated `artifacts/cloudflare-m5/` report.

## 7. Rollback

Repository-only: delete or revert `lib/cloudflare/d1/`, `scripts/d1-schema.ts`,
`tests/d1-schema.test.ts`, `d1/`, this document, and the `package.json` / `.gitignore`
additions. Nothing remote was created, so there is no database or DNS rollback.
