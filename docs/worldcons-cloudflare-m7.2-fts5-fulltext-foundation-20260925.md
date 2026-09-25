# WorldCons Cloudflare M7.2 — FTS5 lexical full-text foundation

Status: **code + local verification only**.
Supabase remains the sole search authority. M7.2 adds the runtime-neutral D1
equivalent foundation for `public_fulltext_ranked_ids_v1`: an exact-title FTS5
sidecar, a safe FTS5 MATCH compiler, one parameterized `search_fts` JOIN
`search_documents` query, a fail-closed runtime reader and evidence-only parity
metrics. It performs **no deployment, push, remote D1/Supabase mutation,
Vectorize index creation, DNS change or production-flag change**, does **not**
switch `SearchRepository` authority, and makes **no `GO-SEARCH` / `GO-D1-READ`
claim**. `search_m7` stays a blocker in the M6.5 global gate.

Related: `docs/worldcons-cloudflare-full-migration-plan-20260920.md` (M7, 11.1),
`docs/worldcons-cloudflare-m7.1-search-projection-foundation-20260925.md`,
`docs/worldcons-cloudflare-m6.5-shadow-parity-gate-20260925.md`.

## 1. The gap M7.2 closes

`public_fulltext_ranked_ids_v1` gives exact-title priority when the query equals
**either** `korean_title` **or** `original_title`. M7.1's `search_documents` keeps
only a single Korean-preferred `display_title`, so a query equal to the original
title would lose its exact-title priority whenever a Korean title exists.

M7.2 solves this **without a schema change**: a pure
`SearchProjectionFtsDocument` sidecar is produced from the same authoritative P3
version snapshot, one-to-one with `search_documents`, and the FTS5 `title` column
now holds deterministic normalized variants of BOTH titles. `search_documents`
keeps its authored shape and checksum behavior. No Supabase or D1 `0001`
migration is modified; no new remote migration is needed.

## 2. Exact-title sidecar

`lib/cloudflare/search-projection/fts-document.ts` builds one sidecar row per
projected document. `lib/cloudflare/search-fts/title.ts` owns the encoding:

```
title = \u0001<normalized original title>\u0001 \u0001<normalized korean title>\u0001
```

- Normalization is deterministic and locale-free: NFKC, control-character strip,
  whitespace collapse/trim, Unicode-default lowercase — identical at projection
  and query time.
- `U+0001` is an FTS5 token separator, so the encoded title stays **searchable**.
  No letter/digit kind marker sits inside the boundaries: such a marker would be
  indexed as a real token, so a single-character query (`o`/`k`) would match every
  document.
- Exact detection is `instr(search_fts.title, \u0001<normalized query>\u0001) > 0`
  with the needle **bound as a parameter**. It never relies on SQLite `lower()`
  or on how SQLite tokenizes a raw title, and it works for either title.
- Missing/blank titles are omitted; raw text, R2 content and URLs are never read
  or emitted.

`buildSearchProjection` now returns `{ documents, ftsDocuments, manifest }` with
`ftsDocuments` in the same `article_id` order as `documents`. The full-rebuild and
incremental plans take the sidecar explicitly, assert strict 1:1 identity
(fail-closed on duplicate/missing/extra rows) and never read
`display_title` as the FTS title again. Because every title component is also in
`search_text`, any title change already changes the document checksum, so
incremental changed detection recreates both the base and the FTS sides.

## 3. Runtime-neutral query module

`lib/cloudflare/search-fts/*` imports no `node:*` builtin, selects no adapter and
contains no network or `process.env` access.

### 3.1 Input validation (matches `public_fulltext_ranked_ids_v1`)

- trimmed query non-empty, at most 200 characters (`invalid_query`);
- `limit` integer 1..100 (`invalid_limit`);
- `range` in `latest | today | week | month` (`invalid_range`);
- optional `source` / `jurisdiction` / `contentType` / `language` strings
  (`invalid_filter`);
- an **injected** `referenceNow` (Date / epoch ms / ISO string); the pure builder
  never reads the wall clock (`invalid_clock`).

### 3.2 Safe FTS5 MATCH compiler

`compileSearchFtsQuery` implements a conservative deterministic web-search-like
subset:

- plain terms => implicit AND; `"quoted phrases"`; `OR` between positive clauses;
  unary `-term` / `-phrase` allowed only alongside a positive clause;
- NFKC + whitespace normalization;
- every user literal is emitted only inside a double-quoted FTS5 string with
  embedded `"` doubled, so `*`, `(`, `)`, `:`, `^`, `NEAR`, `AND`, `NOT`, `+`
  cannot be injected;
- malformed/unbalanced (`malformed_query`), negative-only (`negative_only`) and
  empty (`empty_query`) input fails closed with stable codes.

The compiled MATCH expression is **bound as a `?` parameter** — it is never
concatenated into SQL text. All SQL values (MATCH, filters, range threshold,
exact-title needle, limit) are bound; only authored identifiers and syntax are
literal.

### 3.3 Documented divergence

This is **not** `websearch_to_tsquery`. It does not reproduce tsquery operator
precedence for negative-only OR branches, it NFKC-normalizes and collapses
whitespace for both the MATCH terms and the exact-title comparison (Postgres
`websearch_to_tsquery` and the RPC's `btrim`/`lower` do not), it treats `-only`
style input as `negative_only` rather than an empty match, and FTS5 bm25
tokenization is not the Postgres `simple`-dictionary tokenization. Range
filtering compares the projected `original_published_at` text (assumed to be an
ISO-8601 UTC string) lexicographically against a UTC-midnight threshold, while
Postgres compares `timestamptz`. **No query-language, rank or threshold parity is
claimed.**

### 3.4 Parameterized SQL and ordering

`buildSearchFtsQuery` emits one query hard-scoped to
`search_fts JOIN search_documents ON article_id`:

```
select search_documents.article_id as article_id,
       -1.0 * bm25(search_fts, <weights>) as relevance_score
from search_fts
join search_documents on search_documents.article_id = search_fts.article_id
where search_fts match ?
  [and search_documents.source_key = ?] ...
  [and search_documents.original_published_at >= ?]
order by (instr(search_fts.title, ?) > 0) desc,
         relevance_score desc,
         (search_documents.original_published_at is null) asc,
         search_documents.original_published_at desc,
         search_documents.article_id asc
limit ?
```

- Ranges use an injected UTC clock and reproduce `current_date` conservatively at
  the UTC day boundary: `today` = UTC midnight today, `week` = 7 days ago,
  `month` = 30 days ago; `latest` has no threshold.
- `relevance_score` is `-bm25(...)` so a larger score is a better lexical match.
  Exact-title priority is an ORDER-BY-only signal and is **not** folded into the
  score.
- The bm25 weights (`title 10`, `case_numbers 8`, `search_text 4`, `tags_text 2`)
  are **provisional local parity-tuning constants, NOT an agreed production
  threshold**, and do not reproduce `ts_rank_cd(..., 32)`.

### 3.5 Runtime reader

`runSearchFtsQuery` / `readSearchFtsQuery` accept an injected `D1RuntimeDatabase`
(or structural equivalent) and use exactly `prepare(sql).bind(...).all()`. A
malformed envelope, a non-object row, a missing string `article_id` or a
non-finite `relevance_score` raises `invalid_response`; a `success:false` envelope
raises `query_failed`; a binding without `bind/all` raises `unavailable`. The
adapter is **not** selected by `lib/search/repository/index.ts`.

## 4. Parity metrics (evidence only)

`compareRankedIds(expected, actual, { k })` returns `exactOrder`, `sameSet`,
`overlapAtKCount`/`overlapAtK`, `prefixMatchCount`/`prefixMatchRate` and sorted
`missing`/`extra`. It has no pass/fail field and defines no GO threshold.

## 5. Local corpus and tests

`tests/d1-fts-search.test.ts` (15 focused tests) builds a frozen synthetic legal
corpus and materializes it into an in-memory `node:sqlite` database using the D1
`worldcons_search` DDL and the M7.2 plan. It covers:

- sidecar title containing both authoritative titles deterministically, with no
  URL/raw text;
- no artificial single-character title tokens (a bare `o`/`k` query matches
  nothing);
- original-title and Korean-title exact queries winning with both titles present;
- exact-title priority beating a higher-bm25, more recent non-exact document;
- plain/AND, quoted phrase, OR and negative semantics;
- source/jurisdiction/contentType/language filters;
- `latest`/`today`/`week`/`month` with an injected fixed clock;
- deterministic bm25 ordering plus date/id tie-breaks;
- German case number, French and US identifiers, and
  Korean/English/French/Spanish/German legal terms;
- invalid query/limit/range/filter/clock fail-closed codes;
- injection resistance: user text never enters SQL text; the MATCH is bound;
- malformed D1 responses failing closed;
- parity metrics determinism/order-sensitivity;
- unchanged Supabase-authoritative `SearchRepository` and preserved `search_m7`
  blocker;
- no `node:*`, `fetch(`, `process.env` or remote execution in the
  `search-fts` / `search-projection` runtime libraries.

Expected results are hand-authored against the documented **local D1** semantics;
they are **not** production Postgres parity evidence.

## 6. Local operator CLI

```
pnpm d1:fts-local --fixture=corpus.json --query="first amendment" --limit=20
pnpm d1:fts-local --fixture=corpus.json --query="amparo" --range=month --json
pnpm d1:fts-local --fixture=corpus.json --query="..." --expect=id1,id2
```

Local and dry-run only: it materializes an in-memory `node:sqlite` database,
runs the parameterized query and prints ranked ids/scores (and an optional parity
report). No production credentials, no network, no remote read/write and no
`--apply`.

## 7. Explicit non-goals

- No remote projection rebuild, D1/Supabase mutation, Vectorize index, DNS or
  production-flag change.
- No agreed FTS parity threshold and no `GO-SEARCH` / `GO-D1-READ` claim.
- No Vectorize / semantic / hybrid authority (deferred to M7.3+).
- No `SearchRepository` D1 adapter selection and no M7 search shadow event.
- `search_m7` remains a blocker in the M6.5 global `GO-D1-READ` gate.
- No existing Supabase or D1 `0001` migration was modified; no new migration was
  required.

## 8. Provenance

Clean HEAD `7b99ba8630077c10d07305ac076eeaac57d8e702`.
