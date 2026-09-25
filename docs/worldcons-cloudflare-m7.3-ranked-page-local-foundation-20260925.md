# WorldCons Cloudflare M7.3 — ranked-search page LOCAL foundation

Status: **code + local verification only**.
Supabase remains the sole search authority. M7.3 adds the runtime-neutral D1
equivalent foundation for `worldcons_ranked_search_page_v1` covering the
**exact-case, empty-query latest and fulltext branches only**: a control-character
tag exact-filter encoding (no schema change), a SQL-precedence-compatible primary
exact-case parser, one runtime-neutral ranked-page module, a fail-closed D1 reader
and a frozen local regression corpus. It performs **no deployment, push, remote
D1/Supabase mutation, remote projection rebuild, Vectorize index creation, DNS
change or production-flag change**, does **not** switch `SearchRepository`
authority, and makes **no `GO-SEARCH` / `GO-D1-READ` claim**. `search_m7` stays a
blocker in the M6.5 global gate. Semantic/hybrid and Vectorize are deferred.

Related: `docs/worldcons-cloudflare-full-migration-plan-20260920.md` (M7, 11.1),
`docs/worldcons-cloudflare-m7.1-search-projection-foundation-20260925.md`,
`docs/worldcons-cloudflare-m7.2-fts5-fulltext-foundation-20260925.md`,
`docs/worldcons-cloudflare-m6.5-shadow-parity-gate-20260925.md`.

## 1. The gap M7.3 closes

The ranked-search RPC (`supabase/migrations/20260826400000_case_keys_and_ranked_pagination.sql`
:: `worldcons_ranked_search_page_v1`) resolves one primary case reference, then
falls back to `latest` (empty query) or DB-native fulltext/semantic/hybrid. M7.2
provided the local lexical fulltext query only, and M7.1's `search_documents`
stored flat searchable tag text that could not reproduce the RPC's exact tag
filter:

```
item.tags.slug = p_tag OR item.tags.name = p_tag
```

M7.3 closes the local exact-case and exact-tag gaps and assembles the full
RPC-shaped page (entries / retrievalMode / total / hasMore / totalIsExact) with no
schema change and no authority change.

## 2. Tag exact-filter encoding (no schema change)

`lib/cloudflare/search-projection/tags.ts` changes the deterministic `tags_text`
encoding, still inside the existing `search_documents.tags_text` column:

```
\u0001<slug>\u0001 \u0001<name>\u0001 <normalized_name> <type>
```

- Slug and name are the **authoritative exact-filter values** and are wrapped in
  an internal control-character boundary (`U+0001`, `TAG_VALUE_BOUNDARY`).
- `normalized_name`/`type` stay **searchable only** and are emitted as plain
  tokens, so they can never satisfy an exact `p_tag` unless they are literally
  also a slug/name.
- `U+0001` is an FTS5 token separator, so every wrapped slug/name remains fully
  searchable. **No letter/digit marker** is placed inside the boundaries: such a
  marker would itself be indexed as a real token and a single-character query
  (`o`) would match every document.
- `buildExactTagNeedle` / `tagHasExactFilter` / `encodeSearchTags` are pure,
  runtime-neutral, deterministic and deduped in tag order (slug, then id). Raw
  text, R2 content and URLs are never read or emitted.
- The exact filter is a parameterized `instr(tags_text, ?) > 0`; user tag text
  never enters SQL.

`search_documents` keeps its authored columns. No D1 schema change and no Supabase
or `d1/*/0001` migration change was needed.

## 3. Primary exact-case parser (`lib/cloudflare/search-ranked/reference.ts`)

`primaryCaseReference(query)` mirrors `worldcons_query_case_reference_v1`
precedence and returns **one** reference:

1. `neubauer|klimabeschluss` alias FIRST => `de-bverfg` `1 BvR 2656/18` /
   `1bvr265618`;
2. BVerfG display form;
3. France;
4. Spain;
5. US.

It reuses `normalizeCaseNumber`/`caseNumberKey` so keys stay identical to the rest
of the search domain, but it does **not** reuse the multi-reference
`extractExactCaseReferences` semantics (whose alias placement and ordering
differ). Documented divergence: the query is NFKC-normalized before matching and
JS `\b` boundaries are ASCII-oriented; both are deterministic.

The D1 exact lookup requires `source_key = ?` and `case_key` as an **exact line
token** in `case_numbers`:

```
instr(char(10) || case_numbers || char(10), char(10) || ? || char(10)) > 0
```

Both values are bound; there is no substring matching. `case_numbers` already
includes the canonical `case_key`, so no column was added. When `p_source`
conflicts with the exact source, the reader returns an empty `exact-case` page
with `total = 0` and `totalIsExact = (count = 'exact')`, matching the RPC.

## 4. Ranked page module (`lib/cloudflare/search-ranked/*`)

Runtime-neutral barrel (no `node:*`, no adapter selection, no network):

- `types.ts` — RPC-mirroring enums/bounds, input/resolved/output/statement types;
- `errors.ts` — stable fail-closed codes, including `semantic_deferred`;
- `reference.ts` — primary exact-case parser;
- `validate.ts` — trim/max-200 query, `mode`, `1..100` limit, `0..10000` offset,
  optional filters, `range`, `count` and an injected-clock guard;
- `queries.ts` — parameterized builders for the three branches (reusing M7.2
  `compileSearchFtsQuery`, `buildFtsExactTitleNeedle`, `searchFtsRangeThresholdIso`
  and the bm25 weights rather than forking them);
- `page.ts` — pure `limit + 1` trimming and RPC total semantics;
- `reader.ts` — injected `D1RuntimeDatabase` fail-closed reader;
- `parity.ts` — evidence-only ranked-id parity wrapper.

### 4.1 Branch resolution

| Condition | Retrieval mode | Behavior |
| --- | --- | --- |
| primary exact case present | `exact-case` | supported regardless of requested mode; no embedding required; reads `search_documents` only |
| trimmed query empty | `latest` | supported regardless of requested mode; reads `search_documents` only |
| non-empty + `mode = fulltext` | `fulltext` | FTS5 MATCH + exact-title priority + filters/range/tag + offset + `limit + 1` |
| non-empty + `mode = semantic`/`hybrid`, no exact case | — | **fail closed** with `semantic_deferred` |

`semantic`/`hybrid` is **never approximated with lexical search**. The deferred
message is `WORLDCONS_SEARCH_SEMANTIC_DEFERRED`; even when an embedding is
supplied it is accepted structurally and not executed. The RPC's
`WORLDCONS_SEARCH_EMBEDDING_REQUIRED` is not reused because M7.3 defers the
semantic branch entirely.

### 4.2 Payload and count semantics

```
{ entries, retrievalMode, total, hasMore, totalIsExact }
```

- `exact-case`/`latest` entries are `{ id }`; `fulltext` entries are
  `{ id, score }` where `score = -bm25(...)` (higher is better).
- The raw window is `limit + 1`; the extra row is trimmed and only sets
  `hasMore`.
- `count = exact` executes a **separate parameterized COUNT** over the same
  branch predicate and returns the true `total` with `totalIsExact = true`.
- `planned`/`estimated`/`none` do **not** fake an estimate: they return the RPC
  lower bound `total = offset + returned + (hasMore ? 1 : 0)` with
  `totalIsExact = false`.

### 4.3 Parameterization and fail-closed reads

All SQL values (MATCH expression, filters, exact-tag needle, UTC range threshold,
exact-title needle, limit, offset) are bound `?` parameters; only authored
identifiers and fixed syntax are literal. A malformed envelope, non-object row,
missing string `article_id`, non-finite fulltext `score` or invalid COUNT raises a
stable code (`invalid_response` / `query_failed` / `unavailable`).

### 4.4 Documented divergence

Input enum handling mirrors the RPC's own normalization: `mode`/`count` are
trimmed and lowercased because the RPC does so, while `range` is compared
verbatim and is therefore case-sensitive, matching the RPC's unfolded
`p_range`. UTC range thresholds reproduce `current_date` conservatively at the
UTC day boundary (`today` = UTC midnight today, `week` = 7 days ago, `month` =
30 days ago), identical to M7.2; Postgres compares `timestamptz` against
`current_date`. FTS5 bm25 is not `ts_rank_cd(..., 32)`, the query compiler is not
`websearch_to_tsquery`, and JS/NFKC matching differs from Postgres regex. **No
query-language, rank or threshold parity is claimed.**

## 5. Local corpus and tests

`tests/d1-ranked-search.test.ts` (23 focused tests) materializes a frozen
synthetic corpus into an in-memory `node:sqlite` database using the D1
`worldcons_search` DDL and the M7.1/M7.2 projection plan. It covers:

- exact tag boundary encoding (slug/name wrapped; `normalized_name`/`type`
  searchable but not exact; no URL/raw text);
- alias-first primary-reference precedence across alias/BVerfG/France/Spain/US
  chains and non-string inputs;
- exact-case Germany/France/Spain/US and the alias;
- separator-safe `case_numbers` line matching (a longer docket does not shadow a
  shorter one);
- exact-case source conflict (empty page);
- empty-query latest ordering with null published dates last, exact UTC range
  boundary inclusivity (`>=` the day/week/month instant) and article_id
  tie-break for equal dates;
- pagination, `limit + 1` trimming and lower-bound totals, plus a proof that the
  lower bound differs from the exact total in the same window;
- `count = exact` true total (independent of limit/offset) vs
  `planned`/`estimated`/`none` lower bound, with `planned`/`estimated`/`none`
  building no COUNT statement;
- source/jurisdiction/contentType/language/range filters;
- tag slug/name exact filters, multi-word names, case-sensitivity,
  boundary-injection negatives and `normalized_name`/`type`/substring negatives;
- fulltext exact-title priority over a strictly higher-bm25 non-exact document
  (the score order is asserted so the test cannot pass without the boost), tag
  searchability and no artificial one-letter marker tokens;
- semantic/hybrid non-exact fail-closed/deferred, including the omitted-mode
  default, with and without an embedding;
- malformed fulltext input failing closed (never a lexical scan);
- invalid query/mode/count/limit/offset/range/filter/clock fail-closed codes;
- SQL parameter safety (hostile source/tag/query text never changes SQL and
  every bound value is a primitive);
- malformed D1 envelopes failing closed;
- unchanged Supabase-authoritative `SearchRepository`, preserved `search_m7`
  blocker and `node:*`-free ranked library.

`tests/d1-search-projection.test.ts` and `tests/d1-fts-search.test.ts` were
updated for the new `tags_text` encoding while proving the wrapped values stay
FTS-searchable and inject no marker tokens. Expected results are hand-authored
against the documented **local D1** semantics; they are **not** production
Postgres parity evidence.

## 6. Local operator CLI

```
pnpm d1:ranked-local --fixture=corpus.json --query="1 BvR 2656/18" --count=exact
pnpm d1:ranked-local --fixture=corpus.json --query= --limit=20 --tag=due-process --json
```

Local and dry-run only: it materializes an in-memory `node:sqlite` database, runs
the parameterized page and prints the RPC-shaped payload. No production
credentials, no network, no remote read/write and no `--apply`.

## 7. Explicit non-goals

- No remote projection rebuild, D1/Supabase mutation, Vectorize index, DNS or
  production-flag change.
- No production parity threshold and no `GO-SEARCH` / `GO-D1-READ` claim.
- No semantic/hybrid execution and no Vectorize authority: deferred to a later
  slice. A non-empty non-exact semantic/hybrid request always fails closed.
- No `SearchRepository` D1 adapter selection and no M7 search shadow event.
- `search_m7` remains a blocker in the M6.5 global `GO-D1-READ` gate.
- No existing Supabase migration or `d1/*/0001` migration was modified; no new
  migration or schema change was required.

## 8. Provenance

Clean HEAD `a3faef8fed5783e1560ed684300e5009ad73cdf0`.
