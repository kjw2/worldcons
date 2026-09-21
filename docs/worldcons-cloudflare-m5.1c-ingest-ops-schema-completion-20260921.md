# WorldCons Cloudflare M5.1c - Ingest and Ops Schema Completion

Date: 2026-09-21

Baseline: local-only working tree on HEAD `0f652f9` (feat: complete cloudflare m5.1 d1 schema foundation)
with the intentional M5.1b core-expansion changes preserved. This is a continuation of M5.1/M5.1b. No
Orca, no deploy, no remote D1 creation, no DNS change, no Supabase/production mutation, no authority
switch. Supabase remains production authority. The existing `supabase/migrations/*.sql` files are
read-only inputs and were not modified.

## 1. Objective

M5.1 covered 15 tables and M5.1b completed `worldcons_core` (30 covered). This slice completes the
remaining 37 `planned` tables (`worldcons_ingest` 24, `worldcons_ops` 13), so all four D1 databases are
fully modeled: 77 tables (75 migrated Postgres tables plus the two derived `worldcons_search` projection
tables), 0 `planned`.

## 2. Method

The schema stays hand-authored against the read-only Postgres scan
(`lib/cloudflare/d1/postgres/scan.ts`); `buildTable` still derives each column's storage kind, enum CHECK
and FTS5/Vectorize relocation from the plan 6.1 mapping. `validateD1Schema` continues to enforce ownership
coverage and full column parity, so the new tables cannot drift from Postgres.

No mapping or scanner change was needed in this slice: the 37 tables use only already-mapped type
families (`uuid`, `text`, `timestamptz`/`date`, `jsonb`, `boolean`, `integer`, `bigint`, `text[]`). The one
structural change is that the non-unique `index` helper moved from `worldcons-core.ts` into
`schema/shared.ts` so the ingest and ops schema files reuse a single definition.
## 3. Newly covered ingest tables (24)

Article-raw and artifact externalization:
`article_raw_externalization_ledger`, `article_raw_externalization_permits`,
`article_raw_inline_clear_permits`, `article_raw_inline_restore_permits`,
`source_artifact_externalization_ledger`, `source_artifact_externalization_permits`,
`source_artifact_inline_clear_permits`, `source_artifact_inline_restore_permits`.

Backfill orchestration and inventory:
`source_backfill_item_events`, `source_backfill_items`, `source_backfill_runs`, `source_fetch_artifacts`,
`source_normalization_artifacts`, `source_inventory_enumeration_artifacts`,
`source_inventory_snapshot_supersessions`, `source_inventory_snapshots`, `source_request_governor_states`,
`source_request_permits`.

US Constitution Annotated candidate pipeline:
`us_conan_candidate_authority_artifacts_v1`, `us_conan_candidate_catalog_events_v1`,
`us_conan_candidate_essay_evidence_v1`, `us_conan_candidate_reviews_v1`,
`us_conan_candidate_snapshots_v1`, `us_conan_case_candidates_v1`.

## 4. Newly covered ops tables (13)

Admin command control plane:
`admin_command_attempts`, `admin_command_events`, `admin_command_runs`, `admin_commands`.

Governance, retention and operations evidence:
`admin_compatibility_observations_p5`, `admin_governance_evidence_p5`, `admin_ops_events`,
`admin_retention_holds_p5`, `ops_workflow_heartbeats`.

MasterDash control/SSO and rate limiting:
`masterdash_collection_control`, `masterdash_control_requests`, `masterdash_sso_jtis`,
`security_rate_limit_buckets_v1`.

## 5. Parity notes

- bigint identity primary keys (`article_raw_externalization_ledger`,
  `source_artifact_externalization_ledger`, `source_backfill_item_events`,
  `source_inventory_snapshot_supersessions`, `admin_command_events`, `admin_governance_evidence_p5`,
  `admin_retention_holds_p5`) become application-generated decimal TEXT, per
  the plan 6.1 bigint rule; no SQLite autoincrement is authored.
- `admin_command_attempts.fencing_token` has a Postgres sequence default
  (`nextval('admin_command_fencing_token_seq')`); D1 stores it as application-generated decimal TEXT, so the
  sequence lives in the service layer.
- `source_request_governor_states.next_request_not_before` has a Postgres `'-infinity'::timestamptz`
  sentinel default, which has no canonical UTC ISO-8601 representation; D1 keeps the column NOT NULL and the
  service layer emits the sentinel.
- Array defaults are emitted as canonical JSON `'[]'`; `jsonb` defaults as `'{}'` or `'[]'`; identity/uuid/
  timestamp defaults are application-generated, matching the conversion families.
- `source_normalization_artifacts.normalized_output` is authored nullable because the live migration drops
  its NOT NULL once the body may live in R2. This is a deliberate deviation from the line-oriented scan,
  which does not track `alter column ... drop not null`; full column parity ignores nullability.
- Composite primary keys: the four article-raw/artifact permit tables, `admin_compatibility_observations_p5`
  (6 columns), and `security_rate_limit_buckets_v1`.
- Single-column text primary keys: `source_request_governor_states`, `masterdash_collection_control`,
  `masterdash_control_requests`, `masterdash_sso_jtis`, `ops_workflow_heartbeats`.
- Compound/conditional/regex Postgres CHECKs (claim shape, waiver shape, replay shape, storage-ref shape,
  hash shape, counts, terminal shape) stay in the service layer. D1 keeps only the enum value CHECKs the
  scanner captured as table-level constraints. Inline column-level checks the scan does not surface
  (`admin_ops_events.event_type`/`severity`, MasterDash `system_id`/`action`/`status`, the article-raw permit
  `article_table` value) also stay in the service layer and are noted on their tables.
- No D1 column stores a `tsvector` or `vector`; the ingest/ops tables have no relocated columns.
## 6. Verification

| Check | Result |
| --- | --- |
| `pnpm d1:schema` | Pass, 77 tables (77 covered, 0 planned) across 4 databases; validation OK, 0 errors, 0 warnings |
| Full coverage | Pass, all 75 scanned Postgres tables covered, plus the derived `search_documents` / `search_fts` |
| `pnpm test:d1-schema` | Pass, 19/19 |
| `pnpm exec tsc --noEmit` | Pass |
| `pnpm lint` | Pass |
| `pnpm check` | Pass |
| Emitted DDL applied to in-memory SQLite | Pass, every table created, FTS5 `search_fts` matches `due` |
| `d1/<database>/0001_init.sql` vs emitter | Pass, byte-identical; only `worldcons_ingest` and `worldcons_ops` changed |
| Postgres source scan | 92 migrations, 1,174 statements, 75 tables (unchanged) |
| Remote surface | None: no remote database created, no deploy, no DNS change, no authority switch |

## 7. Files

Changed:

- `lib/cloudflare/d1/schema/worldcons-ingest.ts` - 24 newly authored ingest tables plus the shared enum constants.
- `lib/cloudflare/d1/schema/worldcons-ops.ts` - 13 newly authored ops tables plus the shared enum constants.
- `lib/cloudflare/d1/schema/ownership.ts` - the 37 ingest/ops tables moved from `planned` to `covered`; the `planned` helper was removed.
- `lib/cloudflare/d1/schema/shared.ts` - the non-unique `index` helper (moved out of `worldcons-core.ts`).
- `lib/cloudflare/d1/schema/worldcons-core.ts` - imports `index` from `shared.ts`; behavior unchanged.
- `lib/cloudflare/d1/schema/index.ts`, `lib/cloudflare/d1/index.ts` - re-export `index`.
- `tests/d1-schema.test.ts` - counts to 77 covered / 0 planned; ingest/ops coverage assertions.
- `d1/worldcons_ingest/0001_init.sql`, `d1/worldcons_ops/0001_init.sql` - regenerated local DDL.
- this document.

Preserved (M5.1b continuation work, not otherwise modified by this slice): `lib/cloudflare/d1/mapping.ts`,
`lib/cloudflare/d1/postgres/scan.ts`, the `worldcons_core` tables, `d1/worldcons_core/0001_init.sql`,
`docs/worldcons-cloudflare-m5.1b-core-schema-expansion-20260921.md`, and the plan/M5.1 documentation edits.

## 8. Rollback

Repository-only: revert the files above (or restore the previous `d1/worldcons_ingest/0001_init.sql` /
`d1/worldcons_ops/0001_init.sql` and the `worldcons-ingest.ts` / `worldcons-ops.ts` / `ownership.ts`
changes). Nothing remote was created, so there is no database or DNS rollback.
