# WorldCons Cloudflare M5.1b - Core Schema Expansion

Date: 2026-09-21

Baseline: local-only HEAD `0f652f9` (feat: complete cloudflare m5.1 d1 schema foundation). This is a
continuation of M5.1. No Orca, no deploy, no remote D1 creation, no DNS change, no Supabase/production
mutation, no authority switch. Supabase remains production authority. The existing
`supabase/migrations/*.sql` files are read-only inputs and were not modified.

## 1. Objective

M5.1 authored the D1 schema foundation with 15 `covered` tables and 62 `planned`. This continuation
completes the `worldcons_core` database: the 25 `worldcons_core` tables that were still `planned` are
now fully modeled, so `worldcons_core` owns 30 covered tables. `worldcons_ingest` (24 planned) and
`worldcons_ops` (13 planned) remain deferred to M5.2+.

## 2. Method

The schema stays hand-authored against the read-only Postgres scan
(`lib/cloudflare/d1/postgres/scan.ts`); `buildTable` still derives each column's storage kind, enum
CHECK and FTS5/Vectorize relocation from the plan 6.1 mapping. `validateD1Schema` continues to enforce
ownership coverage and full column parity, so the new tables cannot drift from Postgres.

Two small correctness fixes were required for real-migration parity:

- `mapPostgresType` / `postgresTypeCanonicalKind` only matched `vector(n)`. The live migrations declare
  `extensions.vector(1536)` (pgvector installed in the `extensions` schema), so the vector pattern now
  accepts an optional schema qualifier. Both forms relocate to Vectorize.
- `parseInCheck` treated `check (col in (...) and ...)` as unparseable. It now captures only the value
  list of the `in (...)` term, so `source_corpus_policies.normalize_replay_policy` is modeled with its
  real values (`full_snapshot`, `bounded_evidence`, `non_replayable`) instead of being dropped.

## 3. Newly covered core tables (25)

Article version/publication lifecycle: `article_content_versions_p3`, `article_revision_heads_v4`,
`article_version_heads_p3`, `article_publications_p3`, `article_publication_history_p3`,
`article_publication_requests_p3`, `article_publication_quarantine_p3`,
`article_publication_quarantine_resolutions_p3`, `article_audit_ledger_p3`, `article_cache_outbox_p3`,
`article_lifecycle_events_p2`, `article_lifecycle_anomalies_p2`, `article_view_counts`.

Catalog/constitutional case: `case_catalog_publications_v1`, `case_catalog_publication_events_v1`,
`case_catalog_cache_outbox_v1`, `case_identifiers_v1`, `case_metadata_v1`,
`legacy_version_freshness_classifications_v4`.

Embedding provenance: `article_embedding_artifacts`.

Legal concepts/glossary/source policy: `legal_concept_alias_sets_v1`, `legal_concepts_v1`,
`legal_concept_aliases_v1`, `glossary_candidates`, `source_corpus_policies`.

## 4. Relocations added

- `article_content_versions_p3.search_vector` -> `worldcons_search` FTS5
- `article_content_versions_p3.embedding` -> Vectorize
- `article_embedding_artifacts.embedding` -> Vectorize

No D1 column stores a `tsvector` or `vector`, matching plan 6.1 / 11.

## 5. Parity notes

- bigint identity primary keys (`article_audit_ledger_p3`, `article_lifecycle_events_p2`,
  `article_publication_history_p3`, `article_publication_quarantine_p3`,
  `article_publication_requests_p3`, `case_catalog_publication_events_v1`) become application-generated
  decimal TEXT, per the plan 6.1 bigint rule; no SQLite autoincrement is authored.
- Array defaults are emitted as canonical JSON `'[]'` (not the Postgres `'{}'` literal), matching the
  array -> canonical JSON TEXT conversion family.
- `article_publication_quarantine_resolutions_p3` and `source_corpus_policies` use composite primary keys.
- The two `case_identifiers_v1` Postgres unique indexes are partial
  (`identifier_type in (...)` and `is_primary`); D1 keeps the lookup indexes and leaves the partial
  uniqueness to the service layer. The two Postgres partial lookup indexes are authored as plain D1 indexes.
- Conditional/compound Postgres CHECKs (replay policy vs `allow_raw_snapshot`, freshness vs enrichment
  status, publication timestamp consistency, secret-scanning) stay in the service layer; D1 keeps the
  enum value CHECK only.

## 6. Verification

| Check | Result |
| --- | --- |
| `pnpm d1:schema` | Pass, 40 tables (40 covered, 37 planned) across 4 databases; validation OK, 0 errors, 0 warnings |
| Core coverage | Pass, `worldcons_core` fully covered (30 tables); planned reduced to `worldcons_ingest` 24 + `worldcons_ops` 13 |
| `pnpm test:d1-schema` | Pass, 19/19 |
| `pnpm exec tsc --noEmit` | Pass |
| `pnpm lint` | Pass |
| `pnpm check` | Pass |
| Emitted DDL applied to in-memory SQLite | Pass, every table created, FTS5 `search_fts` matches `due` |
| `d1/<database>/0001_init.sql` vs emitter | Pass, byte-identical; only `worldcons_core` changed |
| Postgres source scan | 92 migrations, 1,174 statements, 75 tables (unchanged) |
| Remote surface | None: no remote database created, no deploy, no DNS change, no authority switch |

## 7. Files

Changed:

- `lib/cloudflare/d1/schema/worldcons-core.ts` - 25 newly authored core tables plus the non-unique `index` helper.
- `lib/cloudflare/d1/schema/ownership.ts` - the 25 core tables moved from `planned` to `covered`.
- `lib/cloudflare/d1/mapping.ts` - accept schema-qualified `extensions.vector`.
- `lib/cloudflare/d1/postgres/scan.ts` - capture the value list of a compound `col in (...)` check.
- `tests/d1-schema.test.ts` - updated counts to 40 covered / 37 planned; added vector-mapping, compound-enum
  and `article_content_versions_p3` relocation assertions.
- `d1/worldcons_core/0001_init.sql` - regenerated local DDL (30 tables).
- this document.

## 8. Rollback

Repository-only: revert the files above (or restore `d1/worldcons_core/0001_init.sql` and the
`worldcons-core.ts` / `ownership.ts` changes). Nothing remote was created, so there is no database or DNS
rollback.