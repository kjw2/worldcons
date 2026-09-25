# WorldCons Cloudflare M7.1 — search projection + FTS5 synchronization foundation

Status: **code/local verification only**.
Supabase remains the sole search authority. M7.1 adds a pure, runtime-neutral
projection builder and a local, parameterized FTS5 synchronization plan for the
disposable `worldcons_search` D1 database. It performs **no deployment, push,
remote mutation, Vectorize index creation, DNS change or production-flag
change**, and it makes **no `GO-SEARCH` / `GO-D1-READ` claim**. Vectorize /
semantic authority is M7.4+ (M7.2 adds the local FTS5 lexical foundation and M7.3
the local exact-case/latest/fulltext ranked-page foundation).

Related: `docs/worldcons-cloudflare-full-migration-plan-20260920.md` (M7),
`docs/worldcons-cloudflare-m6.5-shadow-parity-gate-20260925.md`.
Forward: `docs/worldcons-cloudflare-m7.2-fts5-fulltext-foundation-20260925.md`,
`docs/worldcons-cloudflare-m7.3-ranked-page-local-foundation-20260925.md`,
`docs/worldcons-cloudflare-m7.4-vectorize-semantic-hybrid-foundation-20260925.md`.

## 1. Purpose

`worldcons_search` is a disposable, rebuildable derived D1 database: a
denormalized `search_documents` base plus an FTS5 `search_fts` index
(`lib/cloudflare/d1/schema/worldcons-search.ts`). M7.1 builds the deterministic
foundation that a later milestone can project and synchronize — without yet
changing search or read authority.

M7.1 delivers:

1. a pure projection builder (`lib/cloudflare/search-projection/*`) that
   consumes typed core rows and produces deterministic `SearchProjectionDocument`
   rows;
2. a P3 public-authority source selector that fails closed on ambiguity;
3. deterministic title / case-number / search-text / tag / checksum mapping;
4. a parameterized full-rebuild and incremental FTS5 synchronization **plan**
   (plan only, never execute);
5. verification helpers (counts, corpus hash, checksum/version/identity drift);
6. a local, dry-run operator CLI (`pnpm d1:search-projection`).

## 2. Authority contract

The projection models `public_article_projection_p3` exactly:

```
article_publications_p3 p
join article_content_versions_p3 v on v.id = p.version_id and v.article_id = p.article_id
where p.state = 'published'
```

- Only a `published` publication joined to its **authoritative version
  snapshot** becomes searchable. Draft / in-review / withdrawn publications are
  omitted.
- A published publication whose referenced version is missing, or whose version
  belongs to a different `article_id`, **fails closed**
  (`missing_publication_version` / `publication_version_mismatch`).
- Two published authorities for one `article_id` **fail closed**
  (`duplicate_published_authority`), as do duplicate publication/version/base/
  article-tag/tag primary keys.
- Base `articles` rows are joined **only** for `review_state`. Version content
  (title, cleaned_text, summary, metadata) always wins; a missing base row leaves
  `review_state` null and never changes content authority.
- `article_content_versions_p3.search_vector` and `embedding` are relocated out
  of the relational schema and are never required: searchable text is derived
  from source columns.

Tags stay article-level (`article_tags` + `tags`), hydrated in deterministic
`slug` order (tag id tie-break). `tags_text` uses only the safe searchable fields
`slug` / `name` / `normalized_name` / `type`; arbitrary tag metadata is never
emitted.

## 3. Deterministic document mapping

| field | formula |
| --- | --- |
| `article_id` | authoritative `article_content_versions_p3.article_id` |
| `jurisdiction`, `source_key`, `language`, `content_type` | version snapshot (`language` = `original_language`) |
| `publication_state` | `published` (P3 publication authority) |
| `review_state` | base `articles.review_state` when available, else null |
| `original_published_at` | version snapshot value, else null |
| `display_title` | non-blank Korean title, else original title, else empty string |
| `case_numbers` | canonical `case_key` plus normalized `source_metadata` case-number-like values, deduped and sorted (no URL scraping) |
| `search_text` | original title, Korean title, `cleaned_text`, canonicalized `summary_json` text, institution name, source key — stable `\n\n` separators; no `raw_text`/R2 fetch |
| `tags_text` | deduped safe tag tokens in slug order |
| `projection_version` | authored constant `1` |
| `updated_at` | max parseable authority timestamp across publication created/updated/published and version created/fetched/summarized/original-published; fails closed when none exists |
| `checksum` | deterministic digest over the FULL logical document excluding `checksum`, using canonical JSON + the pure `shadowDigest` (no random, no wall clock) |

`search_text` deliberately preserves the legacy source components (Korean title
A, original title B, `cleaned_text` C, `summary_json` D) but **does not claim
rank parity**: FTS5 BM25 / weight mapping belongs to M7.2. The projection carries
`source_key`, `jurisdiction`, `content_type`, `language`,
`original_published_at`, `tags_text` and searchable title/case-number text so the
M7.2 `public_fulltext_ranked_ids_v1` (and later M7.3 `worldcons_ranked_search_page_v1`) filters
(including exact-title and case-number boosts) have the data they need.

## 4. FTS5 synchronization plan

`planSearchProjectionFullRebuild(documents)` and
`planSearchProjectionIncrementalSync(current, next)` emit SQLite statements:

- hard-scoped to exactly `worldcons_search.search_documents` and
  `worldcons_search.search_fts`; no core/ingest/ops table ever appears;
- all user/data values are bound `?` parameters; only authored table/column
  names appear in SQL text;
- the full rebuild is explicitly destructive **inside `worldcons_search` only**
  (`DELETE FROM search_fts`, `DELETE FROM search_documents`, then inserts in
  `article_id` order) and idempotent;
- the incremental plan adds/updates both the document and FTS sides,
  delete-then-insert for changes, deletes both sides for removals, and is a true
  no-op for identical input (no stale FTS identity);
- every FTS row's `article_id` matches the projected `search_documents`
  `article_id`.

M7.1 declares the generated plan `atomic: false` and `executionDeferred: true`
because this milestone deliberately does not choose or execute a remote
application primitive. Current D1 Worker bindings support transactional `batch()`
execution (the sequence rolls back if a statement fails), so a later M7.1b can
evaluate that path with focused failure/rollback tests before any remote rebuild.
M7.1 itself remains plan-only and never executes.

## 5. Verification

`verifySearchProjection({ projected, documents?, ftsArticleIds? })` returns a
deterministic, text-free report (counts, corpus hash, offending `article_id`s):

- `duplicate_projected_id`, `checksum_mismatch`,
  `projection_version_mismatch` (self-checks);
- `missing_document` / `extra_document` / `duplicate_document` and
  `missing_fts` / `extra_fts` / `duplicate_fts` against materialized rows;
- `hashSearchProjectionDocuments` / `searchProjectionManifest` are
  order-independent and never emit document text.

## 6. Operator CLI

```
pnpm d1:search-projection --fixture=fixture.json
pnpm d1:search-projection --fixture=fixture.json --command=plan --plan=incremental --json
pnpm d1:search-projection --fixture=fixture.json --command=verify
pnpm d1:search-projection --empty --command=plan
```

Dry-run by default, local JSON fixture only, no production credentials and no
network access. `--apply` is deliberately rejected: remote application is not
wired in M7.1. Human output prints statement SQL with `?` placeholders and
parameter counts only — never bound values (which can contain full text).

## 7. Tests

`tests/d1-search-projection.test.ts` (14 focused tests) covers:

- P3 authority omission of unpublished/withdrawn/draft, publication/version
  mismatch, missing version, and duplicate published authority fail-closed;
- version snapshot content winning over legacy base article content;
- deterministic title/case/search/tag mapping and checksum independent of input
  order;
- slug ordering/dedupe, duplicate/missing tag fail-closed, and no URL/`raw_text`
  leakage;
- exact `search_documents` / `search_fts` schema-shape match;
- the M7.2 FTS sidecar encoding both authoritative titles 1:1 with
  `search_documents`, and the plan failing closed on duplicate, missing or
  count-mismatched sidecar rows;
- full rebuild and incremental plans scoped only to `worldcons_search`, values
  bound, deterministic, both sides updated for add/change/remove, no-op on
  identical input;
- verification drift detection (count/hash/checksum/version/missing/extra/
  duplicate FTS);
- empty corpus validity;
- runtime-neutral library (no Node builtins) and Node-only CLI;
- unchanged Supabase-authoritative `SearchRepository` selection and the
  preserved `search_m7` blocker.

Commands: `pnpm test:d1-search-projection`, `pnpm test:search-repository`,
`pnpm test:d1-schema`, `pnpm test:d1-shadow-parity`, `pnpm typecheck`,
`pnpm check`, targeted ESLint, `git diff --check`.

## 8. Explicit non-goals

- No remote projection rebuild was executed; no D1/Supabase/Cloudflare mutation.
- No FTS5 rank/weight parity is claimed (M7.2 adds a local D1 FTS5 foundation without an agreed parity threshold).
- No Vectorize / semantic authority (M7.3+).
- No `SearchRepository` D1 adapter and no M7 search shadow event yet.
- `search_m7` remains a blocker in the M6.5 global `GO-D1-READ` gate.
- No `GO-SEARCH` / `GO-D1-READ` claim, no deployment, push or DNS change.

## 9. Provenance

Clean HEAD `38543829540969fc35ca24f438d15a177eaed335`.
