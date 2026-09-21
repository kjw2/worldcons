# WorldCons Cloudflare M4 — Public Reference-Read Repository Abstraction (M4.1 + M4.2)

Date: 2026-09-21

Baseline: clean HEAD `6a68fb8` (docs: complete cloudflare m3 remote canary) on the
`495d4ad` lineage. This checkpoint starts M4 (repository/data abstraction) and
deliberately implements only its first, narrow slice. **Section 7 records the
M4.2 follow-on slice**, completed later on clean HEAD `a0b5edf`.

## 1. Scope and safety boundary

M4.1 extracts the **public reference-read domain** that was embedded directly in
`lib/db/queries.ts` into a platform-neutral repository contract with a
Supabase-backed implementation that remains authoritative.

This checkpoint did **not**:

- deploy a Worker, change DNS, or touch production data,
- change Supabase production authority,
- introduce D1, a converter, or any shadow write,
- change any external HTTP contract or exported function signature,
- modify unrelated article, search, or ingest functions,
- run Orca.

Rollback is repository-only: revert `lib/reference-reads/`, restore the three
function bodies in `lib/db/queries.ts`, and drop the `rangeStartIso` helper.

## 2. Baseline coupling census (before M4.1)

Measured on the clean baseline with `\.from\(|\.rpc\(` and `getSupabaseAdmin`
source scans over `app/lib/scripts/workers/components/plugins` `.ts`/`.tsx`
files (test files excluded; the single `.from(` hit in `scripts/check.ts` is
`Array.from` and is not a Supabase call):

| Census | Count |
| --- | --- |
| Broad direct-coupling files (Supabase table `.from(` or RPC `.rpc(` usage) | 89 |
| Files calling `getSupabaseAdmin()` | 30 |
| Files calling `.rpc()` | 36 |

`lib/db/queries.ts` alone carried the three reference-read implementations plus
the shared row-mapping and range helpers this slice relocates.

## 3. M4 decomposition (planned slices)

M4 remains "eliminate direct Supabase coupling from business logic; introduce
platform-neutral repository interfaces; map every RPC to a service operation".
It is sliced so each step is small, reviewable, and behavior-preserving while
Supabase stays authoritative:

| Slice | Domain | Notes |
| --- | --- | --- |
| **M4.1** (this) | Public reference reads: `listSources`, `listTags`, `listJurisdictionArticleCounts` | Contract + Supabase adapter + mock adapter + selection. |
| M4.2 | Remaining simple catalog reads: glossary terms, ingestion-run history | Same contract shape; pure table reads. **Completed — see section 7.** |
| **M4.3a** | Public article detail read seam: `getArticleBySlug` / `getArticlePreviewBySlug` row fetch, `getArticleSourceTextBySlug` | Contract + Supabase adapter + mock; exercises detail-projection v4, select shapes, and publishability filtering. **Completed — see section 9.** |
| **M4.3b** | Remaining public article reads | Split further. **M4.3b1** (`listArticles`) completed — see section 10. **M4.3b2** (`listTopViewedArticles`, `getRelatedArticles`, `listPublicSitemapArticles`, `getTagBySlug`, `listArticlesForGlossaryTerm`) completed — see section 11. |
| **M4.4** | Search domain: ranked page, exact-case, case catalog, vector | Split. **M4.4a** (ranked page + exact-case data-access seam) completed — see section 13. **M4.4b** (case catalog, vector) completed — see section 14. Builds on the frozen search parity corpus. |
| M4.5 | Admin/ops read domains: dashboard, analytics, triage | Mostly `getSupabaseAdmin` call sites. Next slice after M4.4 — see section 14.7. |
| M4.6 | RPC ledger | One row per Postgres function: call sites, target service method, target DB, transaction semantics, parity test, status. |

## 4. Exactly what M4.1 moved

New module `lib/reference-reads/`:

- `types.ts` — `ReferenceReadRepository` contract plus `TagListOptions`,
  `JurisdictionRange`, and `JurisdictionCountOptions`. No Postgres/Supabase types.
- `shared.ts` — `SupabaseTagRow`, `tagRowToSummary`, `normalizeTagListOptions`,
  and `normalizeJurisdictions`. Shared by both adapters and by the remaining
  caller (`getTagBySlug`), so mapping/clamping cannot drift.
- `supabase-repository.ts` — `createSupabaseReferenceReadRepository`, the
  authoritative adapter. It preserves, verbatim:
  - `listSources` → `sources` select ordered by `jurisdiction`,
  - `listTags` → `public_tag_projection_p3` when projection reads are enabled,
    otherwise `tags`, with the same `type` / `minArticleCount` / sort / `limit`
    handling,
  - `listJurisdictionArticleCounts` → `public_jurisdiction_article_counts_p3`
    when projection reads are enabled, otherwise
    `public_jurisdiction_article_counts`, then the per-jurisdiction count
    fallback on `public_article_projection_p3` / `articles` with
    `status = summarized` and, when projection reads are disabled,
    `catalog_ai_stale_v4 = false` plus
    `source_metadata->collection->>publishable = true`. When no jurisdictions are
    given it resolves them from `listSources`, exactly as before.
- `mock-repository.ts` — `mockReferenceReads`, reproducing the pre-extraction
  mock fallback exactly (`mockSources`, `mockTags` filtering/sorting, and
  `mockArticles` jurisdiction counting with the `range` filter).
- `index.ts` — `referenceReads()` selection point: Supabase whenever
  configuration is present, otherwise the mock adapter.

Changed shared helper:

- `lib/utils/dates.ts` — added `rangeStartIso`, the exact ms-based
  `getRangeStartIso` implementation lifted out of `lib/db/queries.ts`.

Changed caller (`lib/db/queries.ts`):

- `listSources`, `listTags`, and `listJurisdictionArticleCounts` are now thin
  delegations to `referenceReads()`. Their exported signatures are unchanged
  (the option parameter types are the new named aliases with identical shapes),
  so every caller is untouched.
- The publication-read **observation** call (`observePublicProjectionRead()`) is
  retained at the query boundary, so telemetry semantics are unchanged.
- The now-unused local `SupabaseTagRow` / `SupabaseJurisdictionCountRow` types,
  `tagRowToSummary`, and `getRangeStartIso` were removed; `tagRowToSummary` and
  `getRangeStartIso` are imported from the new module / dates util.

Coupling effect (measured after M4.1, same scan; `Array.from` false positives in
`scripts/check.ts` and `lib/reference-reads/shared.ts` excluded):

| Census | Before | After |
| --- | --- | --- |
| Broad direct-coupling files | 89 | 90 |
| Files calling `getSupabaseAdmin()` | 30 | 31 |
| Files calling `.rpc()` | 36 | 36 |

This is an extraction, so the census is flat-to-slightly-up rather than down:
`supabase-repository.ts` is itself a new direct-coupling file and `index.ts`
calls `getSupabaseAdmin()`. The measurable win is at the boundary: no caller or
business module gains any Supabase dependency, and a future D1 adapter can
implement `ReferenceReadRepository` without touching callers. The RPC ledger
entry for the jurisdiction counts is deferred to M4.6.

## 5. Files changed

- Added: `lib/reference-reads/types.ts`
- Added: `lib/reference-reads/shared.ts`
- Added: `lib/reference-reads/supabase-repository.ts`
- Added: `lib/reference-reads/mock-repository.ts`
- Added: `lib/reference-reads/index.ts`
- Added: `tests/reference-reads-repository.test.ts`
- Added: `docs/worldcons-cloudflare-m4-repository-abstraction-20260921.md`
- Changed: `lib/db/queries.ts` (three delegations; helper/type removal)
- Changed: `lib/utils/dates.ts` (added `rangeStartIso`)
- Changed: `package.json` (`test:reference-reads`; added to `verify:release`)

## 6. Verification

| Check | Result |
| --- | --- |
| `pnpm test:reference-reads` | Pass, 6/6 |
| `pnpm typecheck` | Pass |
| `pnpm check` | Pass |
| `pnpm lint` | Pass |
| `pnpm test:public-regression` | Pass, 15/15 |
| `pnpm check:vinext` | Pass |
| `pnpm build:vinext` | Pass |
| `pnpm build` (Next/Vercel path) | Pass |
| `git diff --check` | Pass |

The focused tests prove:

1. `referenceReads()` selects the mock adapter and preserves the mock fallback
   (source/tag/jurisdiction-count values) when Supabase config is absent, and the
   exported `lib/db/queries` functions return the same mock data;
2. `referenceReads()` selects the Supabase adapter when config is present, and
   the exported functions delegate to it;
3. the Supabase adapter's `sources` and `tags` queries, sort/limit/min-count
   handling, and tag row mapping are byte-for-byte the legacy behavior;
4. the jurisdiction-count RPC selection switches between
   `public_jurisdiction_article_counts` and `public_jurisdiction_article_counts_p3`
   with the projection flag, and the per-jurisdiction count fallback carries the
   `summarized` / `catalog_ai_stale_v4` / `publishable` filters exactly when
   projection reads are disabled.

No commit or push was performed.

## 7. M4.2 — remaining simple catalog reads (completed)

**Status: done.** M4.2 extended the same abstraction with the remaining pure
table reads. Baseline: clean HEAD `a0b5edf` (feat: add cloudflare m4.1 reference
read repository). No new files were added, so the direct-coupling census is
unchanged from M4.1 (90 / 31 / 36): `supabase-repository.ts` was already counted.

### 7.1 Scope and safety boundary

M4.2 moved `listGlossaryTerms`, `getGlossaryTerm`, and `listIngestionRuns` out
of `lib/db/queries.ts` into the `ReferenceReadRepository` contract. It did
**not** broaden into `getTagBySlug`, the article read domain, search, admin
writes, or ingest writes, and it did **not** deploy, change DNS, touch production
data, introduce D1, or change any exported signature.

Rollback is repository-only: revert `lib/reference-reads/`, restore the three
function bodies and `sortGlossaryTerms` in `lib/db/queries.ts`.

### 7.2 What M4.2 moved

Contract (`lib/reference-reads/types.ts`): `ReferenceReadRepository` gained
`listGlossaryTerms()`, `getGlossaryTerm(slug)`, and `listIngestionRuns(limit?)`.
The three methods were added to the existing single contract rather than a
sibling one so `referenceReads()` remains the one selection point and both
adapters stay complete.

Shared (`lib/reference-reads/shared.ts`): added `SupabaseGlossaryTermRow` +
`glossaryTermRowToRecord`, `sortGlossaryTerms` (the exact `localeCompare(..., "ko")`
implementation lifted from `lib/db/queries.ts`), and `SupabaseIngestionRunRow` +
`ingestionRunRowToRecord`.

Supabase adapter (`lib/reference-reads/supabase-repository.ts`) preserves
verbatim:

- `listGlossaryTerms` → `glossary_terms` select `*` ordered by `term`, then
  `sortGlossaryTerms` after mapping;
- `getGlossaryTerm` → reuses `listGlossaryTerms` and finds by `slug`, returning
  `null` when absent (identical to the pre-extraction implementation);
- `listIngestionRuns` → `ingestion_runs` select `*`, `order("started_at",
  { ascending: false })`, `.limit(limit)`, then row mapping.

Mock adapter (`lib/reference-reads/mock-repository.ts`) reproduces the
pre-extraction fallback exactly: `sortGlossaryTerms(mockGlossaryTerms)`, a
derived `getGlossaryTerm`, and `mockIngestionRuns.slice(0, limit)`.

Changed caller (`lib/db/queries.ts`): the three functions are now thin
delegations to `referenceReads()` with unchanged exported signatures
(`listIngestionRuns(limit = 20)`, `listGlossaryTerms()`, `getGlossaryTerm(slug)`),
so every caller (`app/sitemap.ts`, `app/search/page.tsx`, the glossary routes,
`lib/db/admin-queries.ts`, and the admin ingestion-run pages/route) is untouched.
The now-unused local `sortGlossaryTerms` and the `mockGlossaryTerms` /
`mockIngestionRuns` imports were removed.

### 7.3 M4.2 files changed

- Changed: `lib/reference-reads/types.ts` (three contract methods)
- Changed: `lib/reference-reads/shared.ts` (glossary/ingestion row mappers; `sortGlossaryTerms`)
- Changed: `lib/reference-reads/supabase-repository.ts` (three methods)
- Changed: `lib/reference-reads/mock-repository.ts` (three mock methods)
- Changed: `lib/db/queries.ts` (three delegations; helper/import removal)
- Changed: `tests/reference-reads-repository.test.ts` (glossary + ingestion coverage)
- Changed: `docs/worldcons-cloudflare-m4-repository-abstraction-20260921.md`

No `package.json` change was needed: `test:reference-reads` already runs the
focused file and is already wired into `verify:release`.

### 7.4 M4.2 verification

| Check | Result |
| --- | --- |
| `pnpm test:reference-reads` | Pass, 8/8 |
| `pnpm typecheck` | Pass |
| `pnpm check` | Pass |
| `pnpm lint` | Pass |
| `pnpm test:public-regression` | Pass, 15/15 |
| `pnpm check:vinext` | Pass |
| `pnpm build:vinext` | Pass |
| `pnpm build` (Next/Vercel path) | Pass |
| `git diff --check` | Pass |

The focused tests now additionally prove:

1. `listGlossaryTerms` queries `glossary_terms` (`select "*"`, `order("term")`),
   maps `korean_term` → `koreanTerm`, defaults `related_tags` to `[]`, and applies
   the Korean `sortGlossaryTerms` order; `getGlossaryTerm` reuses that read and
   returns `null` for a missing slug;
2. `listIngestionRuns` queries `ingestion_runs` (`order("started_at",
   { ascending: false })`, `.limit(n)`), maps every column, and keeps the default
   limit at 20;
3. the Supabase error paths rethrow `glossary unavailable` / `runs unavailable`;
4. without Supabase config the mock adapter returns the sorted glossary seed, the
   derived term lookup, and `mockIngestionRuns.slice(0, limit)`, and the exported
   `lib/db/queries` functions return the same values;
5. with Supabase config present, the exported functions delegate to the Supabase
   adapter and issue the expected table requests.

No commit or push was performed.

## 8. M4.3 — public article read domain (split)

The original M4.3 planned to move the whole public article read domain in one
step. It was split so the lowest-risk seam could land first:

- **M4.3a (completed — section 9):** the public article **detail** read seam —
  `getArticleBySlug` / `getArticlePreviewBySlug`'s underlying slug row fetch and
  `getArticleSourceTextBySlug` — onto the platform-neutral repository seam
  (`lib/article-reads/`).
- **M4.3b (remaining):** `listArticles` (including the full-text path and the
  legacy/projected tag-filter joins), `listTopViewedArticles`, `getRelatedArticles`,
  `listPublicSitemapArticles`, and `getTagBySlug` (which depends on
  `listArticles`). This still needs its own parity evidence (field-by-field row
  mapping, tag aggregation, and pagination/ordering) because it exercises the
  tag-filter joins that M4.3a deliberately avoids.

Search (M4.4), admin/ops reads (M4.5), and the RPC ledger (M4.6) remain after
that, as planned in section 3.

## 9. M4.3a — public article detail read seam (completed)

**Status: done.** Baseline: clean HEAD `dae38b6` (feat: complete cloudflare m4.2
catalog read abstraction). No Orca, no deploy, no DNS change, no production data
change, no D1.

### 9.1 Scope and safety boundary

M4.3a extracted the public article **detail** read seam out of `lib/db/queries.ts`
into a sibling module `lib/article-reads/`:

- the slug-keyed row fetch behind `getArticleBySlug` and
  `getArticlePreviewBySlug` (the former private `getArticleBySlugWithSelect`), and
- `getArticleSourceTextBySlug`.

It did **not** touch `listArticles`, the full-text path, the tag-filter joins,
`listTopViewedArticles`, `getRelatedArticles`, `listPublicSitemapArticles`, or
`getTagBySlug` (M4.3b), and it did not change any exported signature.

Rollback is repository-only: delete `lib/article-reads/`, restore the private
`getArticleBySlugWithSelect` and `getArticleSourceTextBySlug` bodies plus the
select constants / projection helpers / `articleRowToItem` in `lib/db/queries.ts`,
and revert the three static test path updates.

### 9.2 What M4.3a moved

New module `lib/article-reads/`:

- `types.ts` — `ArticleReadRepository` contract (`getArticleBySelect(slug, select,
  options)`, `getArticleSourceTextBySlug(slug, options)`), the platform-neutral
  `ArticleReadSelect` kind (`"list" | "page" | "detail"`), `ArticleReadOptions`,
  and `ArticleSourceTextRecord`. No Postgres/Supabase types.
- `shared.ts` — the single source of truth for the article read selection and
  mapping: the `SupabaseArticleRow` / `SupabaseArticleTagRow` shapes, every
  `ARTICLE_*_SELECT` constant (`TAG_LIST_SELECT`, `ARTICLE_LIST_SELECT`,
  `ARTICLE_LIST_WITH_TAG_FILTER_SELECT`, `ARTICLE_PAGE_SELECT`,
  `ARTICLE_RAW_BLOB_METADATA_SELECT`, `ARTICLE_DETAIL_SELECT`, and the P3/V4
  variants), the projection/detail-v4 helpers (`publicationProjectionEnabled`,
  `articleRelation`, `articleDetailRelation`, `projectionSelect`,
  `detailProjectionSelect`), the kind→select and kind→mapping helpers
  (`articleSelectForKind`, `articleMappingOptions`), and the row mapping
  (`minimalSourceMetadata`, `articleRawBlobMetadataFromRow`, `articleRowToItem`).
  The projection/relation helpers take an optional `environment` that defaults to
  `process.env`, so the exported callers keep the pre-extraction behavior while
  focused tests can inject flags.
- `supabase-repository.ts` — `createSupabaseArticleReadRepository`, the
  authoritative adapter. It preserves, verbatim: the relation + select selection
  (`articles` / `public_article_projection_p3` / `public_article_detail_v4`, and
  the list/page/detail and P3/V4 select shapes), the legacy
  `status = summarized` + `catalog_ai_stale_v4 = false` + `publishable = true`
  filter applied only when projection reads are disabled, the
  `row.source_metadata !== undefined` publishability post-filter guard, and the
  exact source-text select literal and snapshot mapping.
- `mock-repository.ts` — `mockArticleReads`, reproducing the pre-extraction mock
  fallback exactly (full mock article with published-only filtering; mapped
  source-text snapshot).
- `index.ts` — `articleReads()` selection point: Supabase whenever configuration
  is present, otherwise the mock adapter.

Changed caller (`lib/db/queries.ts`):

- `getArticleBySlug`, `getArticlePreviewBySlug`, and `getArticleSourceTextBySlug`
  are now thin delegations to `articleReads()`, with unchanged exported
  signatures.
- Raw-text Blob (R2) hydration stays at the query boundary: `getArticleBySlug`
  still calls `hydrateArticleRawText` only for the `detail` kind with a mapped
  `rawTextBlob`, so the repository never touches Blob storage. This keeps the
  storage concern outside the repository/service boundary.
- The publication-read observation call (`observePublicProjectionRead()`) is
  retained at the query boundary, so telemetry semantics are unchanged.
- The relocated constants/helpers/type were removed. The remaining M4.3b
  functions (`listArticles`, `listTopViewedArticles`) import them from
  `lib/article-reads/shared`, so there is exactly one definition of each select
  shape and relation helper.

Coupling effect (same scan as sections 2/4): M4.3a adds three direct-coupling
files (`supabase-repository.ts` is a `.from(` file; `index.ts` calls
`getSupabaseAdmin()`), the same extraction shape as M4.1/M4.2. The measurable win
is still at the boundary: no caller or business module gains a Supabase
dependency, and a future D1 adapter can implement `ArticleReadRepository` without
touching callers.

### 9.3 Static test relocation

Three existing source-scanning tests asserted on definitions that moved from
`lib/db/queries.ts`. Their behavior assertions are unchanged; only the scanned
file moved to the canonical module:

- `tests/article-raw-blob.test.ts` — the detail/list select-shape and source-text
  select proofs now read `lib/article-reads/shared.ts` /
  `lib/article-reads/supabase-repository.ts`. The "dual read lives only in the
  detail path" proof still reads `lib/db/queries.ts`.
- `tests/constitutional-case-catalog-gate2.test.ts` — the
  `public_article_detail_v4` and `summaryAvailable` proof now reads
  `lib/article-reads/shared.ts`.
- `tests/article-publication-p3.test.ts` — the centralized public-read-authority
  proof now scans the union of `lib/db/queries.ts`,
  `lib/reference-reads/supabase-repository.ts`, and `lib/article-reads/shared.ts`.
  This also repairs the assertion that M4.1 had left failing at the old
  `queries.ts` location when it moved the jurisdiction-count RPC into
  `lib/reference-reads`.

### 9.4 M4.3a files changed

- Added: `lib/article-reads/types.ts`
- Added: `lib/article-reads/shared.ts`
- Added: `lib/article-reads/supabase-repository.ts`
- Added: `lib/article-reads/mock-repository.ts`
- Added: `lib/article-reads/index.ts`
- Added: `tests/article-reads-repository.test.ts`
- Changed: `lib/db/queries.ts` (three delegations; select/relation/mapping extraction)
- Changed: `tests/article-raw-blob.test.ts` (static path relocation)
- Changed: `tests/constitutional-case-catalog-gate2.test.ts` (static path relocation)
- Changed: `tests/article-publication-p3.test.ts` (static path relocation)
- Changed: `package.json` (`test:article-reads`; added to `verify:release`)
- Changed: `docs/worldcons-cloudflare-m4-repository-abstraction-20260921.md`

### 9.5 M4.3a verification

| Check | Result |
| --- | --- |
| `pnpm test:article-reads` | Pass, 7/7 |
| `pnpm typecheck` | Pass |
| `pnpm check` | Pass |
| `pnpm lint` | Pass |
| `pnpm test:public-regression` | Pass, 15/15 |
| `pnpm test:plugin` | Pass, 12/12 |
| `pnpm check:vinext` | Pass (100% compatible) |
| `pnpm build:vinext` | Pass |
| `pnpm build` (Next/Vercel path) | Pass |
| `git diff --check` | Pass |

Focused coupled regression (article-raw-blob, catalog gate2, publication p3,
reference-reads, plugin MCP): Pass, 69/69. The p3 assertion that was failing on
baseline now passes.

The focused tests prove:

1. `articleReads()` selects the mock adapter and preserves the mock fallback when
   Supabase config is absent, and the exported `lib/db/queries` functions return
   the same mock detail/preview/source-text values (the mock detail fetch ignores
   the select kind, exactly as before);
2. the Supabase adapter maps a detail row byte-for-byte (tag aggregation,
   `koreanTitle` fallback, `oneLineSummary` fallback, `summaryAvailable`
   fallback, minimal source metadata, raw-text blob metadata) and applies the
   legacy `summarized` / `catalog_ai_stale_v4` / `publishable` filter only when
   projection reads are disabled;
3. the relation and select switch correctly across `articles` →
   `public_article_projection_p3` → `public_article_detail_v4` and across the
   list/page/detail and P3/V4 select shapes, with no legacy published filter on
   projection reads;
4. the publishability boundary is preserved: non-publishable rows stay private for
   public reads, `includeUnpublished` returns them without the legacy filter, and
   a row without `source_metadata` skips the publishability post-filter; missing
   rows return `null` and query errors rethrow;
5. the source-text snapshot is selected and mapped exactly (select literal,
   relation, filters, published/unpublished handling, missing/error cases);
6. the exported functions delegate to the configured Supabase adapter;
7. raw-text hydration stays at the query boundary: it runs only for the `detail`
   kind with blob metadata and never for the `page` kind.

### 9.6 Remaining M4.3b scope

M4.3b was split once more. **M4.3b1** (`listArticles`, section 10) and
**M4.3b2** (section 11) are both complete: `listTopViewedArticles`,
`getRelatedArticles`, `listPublicSitemapArticles`, `getTagBySlug`, and
`listArticlesForGlossaryTerm` now compose `lib/article-reads` /
`lib/reference-reads` repository methods, and `lib/db/queries.ts` carries no
direct Supabase coupling for any public read.

No commit or push was performed.

## 10. M4.3b1 — public article list read (completed)

**Status: done.** Baseline: clean HEAD `2b8c1d2` (feat: add cloudflare m4.3a
article detail repository). No Orca, no deploy, no DNS change, no production
data change, no D1.

### 10.1 Scope and safety boundary

M4.3b1 extracted the public article **list** read out of `lib/db/queries.ts` into
the existing `lib/article-reads/` seam: `listArticles` and the private
data-access helpers it owns — pagination normalization, tag slug/name id lookup
and `article_tags` id lookup, the full-text/ranked/fallback path, the
legacy/projected tag-filter join selection, count modes, the
relation/select projection choice, the range/source/jurisdiction/type/language/id
filters, pagination/ordering/`hasMore`/`total` semantics, row mapping, and the
optional view-count attachment.

It did **not** move `listPublicSitemapArticles`, `listTopViewedArticles`,
`getRelatedArticles`, `getTagBySlug`, or `listArticlesForGlossaryTerm` (M4.3b2),
and it did not change any exported signature.

Rollback is repository-only: delete the `listArticles` method and its private
helpers from `lib/article-reads/supabase-repository.ts` and
`lib/article-reads/mock-repository.ts`, restore the helpers and `listArticles`
body in `lib/db/queries.ts`, and remove the shared list helpers.

### 10.2 What M4.3b1 moved

Contract (`lib/article-reads/types.ts`): `ArticleReadRepository` gained
`listArticles(filters?: ArticleListFilters): Promise<ArticleListResult>`, so
`articleReads()` stays the one selection point and both adapters stay complete.

Shared (`lib/article-reads/shared.ts`): added the canonical list helpers
`DEFAULT_PAGE_SIZE`, `normalizePagination`, `filterMockArticles` (with its
private `matchesText`), and `toFullTextQuery`. These are the single definitions
now used by both adapters and by the remaining `lib/db/queries.ts` caller
(`listPublicSitemapArticles` imports `filterMockArticles`).

Supabase adapter (`lib/article-reads/supabase-repository.ts`) preserves verbatim,
resolved against the injected client and environment:

- the empty-`ids` early return, then the projected/legacy tag-filter decision
  (`publicationProjectionEnabled(filters.includeUnpublished)` plus the
  `/^[a-z0-9][a-z0-9-]*$/i` slug guard), the `tagIdsForTagFilter` slug+name
  lookup, the `articleIdsForTagFilter` `article_tags` lookup for the `q` +
  legacy case, and the empty-tag early return;
- the `q` dispatch into `listArticlesByFullText`, preserving the case-catalog
  short-circuit, the `!tsQuery` empty result, the exact-case search, the
  `rankedSearchPage(..., "fulltext", null)` path (with id ordering), and the
  `textSearch` fallback with `fallbackCandidateLimit`, legacy published filter,
  and the re-`listArticles` ordering/`hasMore`/`totalIsExact` math;
- the count mode (`filters.count ?? "exact"`, omitted for `"none"`), the
  `ARTICLE_LIST_SELECT` / `ARTICLE_LIST_WITH_TAG_FILTER_SELECT` selection via
  `detailProjectionSelect`, the ordering
  (`original_published_at desc nullsLast`, `id asc`), every range/source/
  jurisdiction/type/language/id/legacy-tag/projected-tag filter, `.range(from,
  to + pageSize)`, the `hasMore`/`minimumTotal`/`Math.max(count, …)` total, and
  the list row mapping (`{ includeSummaryJson: false, includeDetailFields: false
  }`);
- view-count attachment (`articleViewCountsBySlug` over `article_view_counts`
  with the `site_events` count fallback, `attachArticleViewCounts`, and
  `attachArticleViewCountsIfNeeded` honoring `filters.includeViewCounts ===
  false`).

Mock adapter (`lib/article-reads/mock-repository.ts`) reproduces the
pre-extraction mock fallback exactly: the empty-`ids` early return,
`filterMockArticles`, the page slice, `viewCount: 0` unless
`includeViewCounts === false`, and the same `pageInfo` totals.

Changed caller (`lib/db/queries.ts`): `listArticles` is now a thin delegation to
`articleReads()` that keeps `observePublicProjectionRead(filters.includeUnpublished)`
at the query boundary, with an unchanged exported signature. `normalizePagination`
is re-exported from `lib/article-reads/shared`, so the module's exported surface
is preserved. The relocated helpers and `DEFAULT_PAGE_SIZE` were removed;
`filterMockArticles` is imported from the shared module for
`listPublicSitemapArticles`. Because M4.3b1 keeps the observation call at the
boundary, the recursive re-`listArticles` inside the full-text path no longer
re-observes; that duplicate observation coalesces in the P5 observation store
(60 s window, per-key), so telemetry is unchanged.

The full-text path still delegates to the untouched search modules
(`lib/search/case-catalog`, `lib/search/exact-case`, `lib/search/ranked-page`),
which keep importing the exported `listArticles`; only the article-read
repository is authoritative for the list read itself.

Coupling effect (same scan as sections 2/4/9): no new direct-coupling files were
added (`supabase-repository.ts` and `index.ts` were already counted by M4.3a).
The measurable win remains at the boundary: no caller or business module gains a
Supabase dependency.

### 10.3 M4.3b1 files changed

- Changed: `lib/article-reads/types.ts` (`listArticles` contract method)
- Changed: `lib/article-reads/shared.ts` (list helpers; `filterMockArticles`; `toFullTextQuery`)
- Changed: `lib/article-reads/supabase-repository.ts` (`listArticles` + private list helpers)
- Changed: `lib/article-reads/mock-repository.ts` (mock `listArticles`)
- Changed: `lib/db/queries.ts` (`listArticles` delegation; helper removal; `normalizePagination` re-export)
- Changed: `tests/article-reads-repository.test.ts` (list parity coverage; extended fake Supabase)
- Changed: `docs/worldcons-cloudflare-m4-repository-abstraction-20260921.md`

No `package.json` change was needed: `test:article-reads` already runs the
focused file and is already wired into `verify:release`.

### 10.4 M4.3b1 verification

| Check | Result |
| --- | --- |
| `pnpm test:article-reads` | Pass, 13/13 |
| `pnpm typecheck` | Pass |
| `pnpm check` | Pass |
| `pnpm lint` | Pass |
| `pnpm test:reference-reads` | Pass, 8/8 |
| `pnpm test:public-regression` | Pass, 15/15 |
| `pnpm test:plugin` | Pass, 12/12 |
| `pnpm check:vinext` | Pass (100% compatible) |
| `pnpm build:vinext` | Pass |
| `pnpm build` (Next/Vercel path) | Pass |
| `git diff --check` | Pass |

Coupled article regression (article-raw-blob, catalog gate2, publication p3,
reference-reads, plugin MCP): Pass, 69/69.

The focused tests prove:

1. `articleReads()` selects the mock adapter and preserves the pre-extraction
   list behavior when Supabase config is absent (published-only filtering, the
   tag/source/jurisdiction/text filters, date-desc ordering, the page slice,
   `viewCount: 0` by default and no view-count pass when `includeViewCounts ===
   false`, and the empty-`ids` early return), and the exported `listArticles`
   returns the same values;
2. the Supabase adapter preserves the list select (`ARTICLE_LIST_SELECT`), the
   legacy published filter, the ordering, `.range(from, to + pageSize)`, the
   exact-count/total semantics, and view-count attachment (`article_view_counts`
   keyed by the page slugs), with `count: "none"` omitting the count option and
   `totalIsExact: false`, and with the range/source/jurisdiction/type/language/id
   filters applied exactly;
3. the legacy tag filter resolves ids by slug and by name, uses
   `ARTICLE_LIST_WITH_TAG_FILTER_SELECT`, and filters by
   `article_tag_filter.tag_id`; the projected tag filter skips the id lookup,
   selects the P3 list shape, applies `contains("article_tags", …)`, and carries
   no legacy published filter; and an unresolved tag returns an empty page
   without touching `articles`;
4. the full-text path preserves the `!tsQuery` empty result, the `textSearch`
   fallback (`표현:* & 자유:*`, limit 200, ordering and legacy filter), the
   ranked-order re-list, the fallback error semantics (`items: []` with
   `total: 0`), and the ranked path's ranked-id ordering with the RPC page info
   passthrough.

No commit or push was performed.

## 11. M4.3b2 — remaining public article/reference reads (completed)

**Status: done.** Baseline: clean HEAD `d37a0ce` (feat: add cloudflare m4.3b1
article list repository). No Orca, no deploy, no DNS change, no production data
change, no D1.

### 11.1 Scope and safety boundary

M4.3b2 moved the last public article/reference reads off direct Supabase access
in `lib/db/queries.ts`:

- `listPublicSitemapArticles` — full move to the `ArticleReadRepository`.
- `listTopViewedArticles` — full move to the `ArticleReadRepository`.
- `getRelatedArticles` — the `article_tags` strongest-tag id lookup moved to
  `ArticleReadRepository.listRelatedArticleIds`; the three-step fallback chain
  stays at the query/service boundary because it only composes `listArticles`.
- `getTagBySlug` — the tag row lookup (`tags` / `public_tag_projection_p3`,
  `maybeSingle`, `tagRowToSummary`) moved to `ReferenceReadRepository.getTagBySlug`;
  the tag article list stays at the boundary because it only composes
  `listArticles`.
- `listArticlesForGlossaryTerm` — already pure orchestration over `listArticles`
  and `expandRelatedTagNames`; it stays at the boundary unchanged.

It did **not** deploy, change DNS, touch production data, introduce D1, or
change any exported signature.

Rollback is repository-only: delete the new `ArticleReadRepository` methods
(`listPublicSitemapArticles`, `listTopViewedArticles`, `listRelatedArticleIds`)
and `ReferenceReadRepository.getTagBySlug`, restore the five function bodies in
`lib/db/queries.ts`, and remove the new shared types.

### 11.2 What M4.3b2 moved

Contract (`lib/article-reads/types.ts`): `ArticleReadRepository` gained
`listPublicSitemapArticles()`, `listTopViewedArticles(limit?, filters?)`, and
`listRelatedArticleIds(tagId, options)`, plus the platform-neutral
`SitemapArticleEntry`, `TopViewedArticleFilters`, and `RelatedArticleIdsOptions`
types. Contract (`lib/reference-reads/types.ts`): `ReferenceReadRepository`
gained `getTagBySlug(slug): Promise<TagSummary | null>`.

Supabase article adapter (`lib/article-reads/supabase-repository.ts`) preserves
verbatim, resolved against the injected client and environment:

- `listPublicSitemapArticles` — the 1000-row pages up to 50k, ordered
  `original_published_at desc nullsLast, id asc`, the legacy
  `status = summarized` / `catalog_ai_stale_v4 = false` / `publishable = true`
  filter only when projection reads are disabled, the
  `slug, summarized_at, fetched_at, discovered_at` projection, and the
  `summarized_at || fetched_at || discovered_at || null` lastModified mapping
  with slug-less rows skipped;
- `listTopViewedArticles` — the `safeLimit` clamp (1..20, default 5), the early
  `filters.tag` path, the `article_view_counts` ranking probe (`view_count desc`,
  `limit max(4·limit, limit)`), the ranked view counts keyed by slug, the
  `public_article_projection_p3`/`articles` `projectionSelect(ARTICLE_LIST_SELECT)`
  list shape, the `slug in (...)`, `status = summarized`, and
  source/jurisdiction/content_type/original_language/range filters, the legacy
  filter only when projection reads are disabled, and the client-side ranked-id
  ordering + `viewCount` map + `slice(safeLimit)`; the fallbacks (tag filter,
  view-probe error/empty, article-probe error/empty) fall back to
  `listArticles({ ..., pageSize: safeLimit, count: "none" })` exactly;
- `listRelatedArticleIds` — the `article_tags` select `article_id`,
  `tag_id = ...`, `article_id != ...` (the excluded source article), `.limit(...)`,
  and the `Set` dedupe; a query error resolves to `[]` so the fallback chain is
  preserved.

Supabase reference adapter (`lib/reference-reads/supabase-repository.ts`)
preserves verbatim `getTagBySlug` — the `public_tag_projection_p3` / `tags`
selection, `select "*"`, `eq slug`, `maybeSingle`, `tagRowToSummary`, `null` for
a missing slug, and the error rethrow.

Mock adapters (`lib/article-reads/mock-repository.ts`,
`lib/reference-reads/mock-repository.ts`) reproduce the pre-extraction fallback
exactly: sitemap = `filterMockArticles({})` mapped to `{ slug, lastModified }`;
top-viewed = the mock list page; related-ids = `[]` (the mock corpus has no
`article_tags` join); tag = `mockTags.find((item) => item.slug === slug) ?? null`.

Changed caller (`lib/db/queries.ts`):

- `listPublicSitemapArticles` and `listTopViewedArticles` are thin delegations to
  `articleReads()`.
- `getRelatedArticles` keeps the strongest-tag selection and the three-step
  fallback chain (ids → tag slug → source) and calls
  `articleReads().listRelatedArticleIds(...)` for the join lookup; the chain is
  not duplicated into both adapters.
- `getTagBySlug` calls `referenceReads().getTagBySlug(slug)` and keeps
  `listArticles({ tag: slug, pageSize: 50 })` for the articles.
- `listArticlesForGlossaryTerm` is unchanged.
- `getSupabaseAdmin` and every `.from(...)` / `.rpc(...)` call are gone from the
  module. The now-unused imports (`getSupabaseAdmin`, `mockArticles`, `mockTags`,
  `rangeStartIso`, `tagRowToSummary`, `SupabaseTagRow`, `articleRelation`,
  `articleRowToItem`, `filterMockArticles`, `projectionSelect`,
  `publicationProjectionEnabled`, `ARTICLE_LIST_SELECT`, `SupabaseArticleRow`)
  were removed.
- The publication-read observation stays at the query boundary for every
  function. `getTagBySlug` and `getRelatedArticles` re-enter the exported
  `listArticles`, so their observation count is unchanged; `listTopViewedArticles`’
  internal fallbacks now call the repository seam directly, and those duplicate
  observations coalesce in the P5 observation store (60 s window, per-key),
  exactly as M4.3b1 established.

One observable harmonization: the mock `getTagBySlug` article list now flows
through the canonical `listArticles` mapper, so its articles carry
`viewCount: 0` (rendered identically to the previous `undefined` by
`formatViewCount`) and are date-sorted like every other mock list read. In the
mock corpus each tag has exactly one article, so the ordering is unchanged.

### 11.3 Coupling effect

Same scan as sections 2/4/9/10 (`app/lib/scripts/workers/components/plugins`
`.ts`/`.tsx`; the `Array.from` false positives in `scripts/check.ts` and
`lib/reference-reads/shared.ts` excluded):

| Census | Before M4.3a | Before M4.3b2 | After M4.3b2 |
| --- | --- | --- | --- |
| Broad direct-coupling files | 90 | 91 | 90 |
| Files calling `getSupabaseAdmin()` | 31 | 32 | 31 |
| Files calling `.rpc()` | 36 | 36 | 36 |

`lib/db/queries.ts` now has **0** direct Supabase calls (`getSupabaseAdmin`,
`.from(`, or `.rpc(`). The last public-read coupling moved into the
already-counted `lib/article-reads/supabase-repository.ts` and
`lib/article-reads/index.ts`, so the file-level census returns to the M4.1/M4.2
numbers while the query module is fully decoupled.

### 11.4 M4.3b2 files changed

- Changed: `lib/article-reads/types.ts` (three contract methods; sitemap/top-viewed/related-ids types)
- Changed: `lib/article-reads/supabase-repository.ts` (`listPublicSitemapArticles`, `listTopViewedArticles`, `listRelatedArticleIds`)
- Changed: `lib/article-reads/mock-repository.ts` (three mock methods)
- Changed: `lib/reference-reads/types.ts` (`getTagBySlug` contract method)
- Changed: `lib/reference-reads/supabase-repository.ts` (`getTagBySlug`)
- Changed: `lib/reference-reads/mock-repository.ts` (`getTagBySlug`)
- Changed: `lib/db/queries.ts` (five delegations/orchestrations; Supabase coupling removal)
- Changed: `tests/article-reads-repository.test.ts` (sitemap/top-viewed/related/tag/glossary parity; `neq` harness; queries.ts static guard)
- Changed: `tests/reference-reads-repository.test.ts` (`getTagBySlug` adapter parity)
- Changed: `docs/worldcons-cloudflare-m4-repository-abstraction-20260921.md`

No `package.json` change was needed: `test:article-reads` and
`test:reference-reads` already run the focused files and are already wired into
`verify:release`.

### 11.5 M4.3b2 verification

| Check | Result |
| --- | --- |
| `pnpm test:article-reads` | Pass, 22/22 |
| `pnpm test:reference-reads` | Pass, 10/10 |
| `pnpm typecheck` | Pass |
| `pnpm check` | Pass |
| `pnpm lint` | Pass |
| `pnpm test:public-regression` | Pass, 15/15 |
| `pnpm test:plugin` | Pass, 12/12 |
| `pnpm check:vinext` | Pass (100% compatible) |
| `pnpm build:vinext` | Pass |
| `pnpm build` (Next/Vercel path) | Pass |
| `git diff --check` | Pass |

Coupled article regression (article-raw-blob, catalog gate2, publication p3,
reference-reads, plugin MCP): Pass, 71/71.

The focused tests prove: (1) the sitemap mock fallback/delegation, the 1000-row
paging to 50k with the exact ranges/orders, the legacy vs projection filter, the
lastModified fallback chain, slug-skip, and error rethrow; (2) the top-viewed
mock fallback/delegation, the `article_view_counts` ranking with
`limit = 4·safeLimit`, the clamp, the ranked-id ordering with view counts, the
tag-filter bypass, projection select, and every error/empty fallback; (3) the
`article_tags` related-id query shape, dedupe, and error→`[]` fallback, plus the
exported strongest-tag ids path and the tag/source fallback chain (mock and
Supabase); (4) the exported `getTagBySlug` composing the tag lookup with the tag
article list, and the reference adapter's tag relation/mapping/missing/error
cases; (5) `listArticlesForGlossaryTerm` alias expansion, slug dedupe,
published-date sort, and limit; (6) a static guard that `lib/db/queries.ts` has
no `getSupabaseAdmin`, `.from(`, or `.rpc(` calls.

No commit or push was performed.

## 12. M4.4 — search domain (split)

M4.3 (public article reads) is complete: `lib/db/queries.ts` is a pure service
boundary with zero direct Supabase calls, and every public article and reference
read flows through `lib/article-reads` / `lib/reference-reads`. M4.4 (search
domain) is sliced so the two smallest search data-access paths could land first:

- **M4.4a (completed — section 13):** the ranked page RPC
  (`worldcons_ranked_search_page_v1`) and the exact-case id lookup, onto the new
  platform-neutral `lib/search/repository/` seam.
- **M4.4b (completed — section 14):** `lib/search/case-catalog.ts` (the
  `worldcons_case_search_page_v2` RPC with cursor error evidence, plus the
  cursor parsing/errors and materialization) and `lib/search/vector.ts`
  (`public_fulltext_ranked_ids_v1`, `match_public_article_versions_p3` /
  `match_articles`, and the public embedding-row read). These owned additional
  RPC payload schemas, cursor semantics, and client-side cosine/vector reads, so
  they needed their own parity evidence.

Both search modules keep importing the exported `listArticles` for the ranked
re-list, and `lib/article-reads/supabase-repository.ts` already imports
`rankedSearchPage` and `catalogCaseSearch`, so M4.4a was introduced without
changing those call sites. After M4.4b, the RPC ledger (M4.6) gains one row per
search function. Admin/ops read domains (M4.5) are the next slice — see section
14.7.

No commit or push was performed.

## 13. M4.4a — search data-access seam: ranked page + exact-case (completed)

**Status: done.** Baseline: clean HEAD `cb5c4cc` (feat: complete cloudflare
m4.3b2 public read abstraction). No Orca, no deploy, no DNS change, no production
data change, no D1.

### 13.1 Scope and safety boundary

M4.4a introduced a new platform-neutral search data-access module
`lib/search/repository/` and moved only the Supabase client/table/RPC access of
the two smallest search paths behind it:

- `lib/search/ranked-page.ts` — the `worldcons_ranked_search_page_v1` RPC.
- `lib/search/exact-case.ts` — the exact-case id lookup against the public
  article relation, including the indexed `case_key` lookup and the
  metadata/`original_url` rollout fallbacks.

It did **not** touch `lib/search/case-catalog.ts`, `lib/search/vector.ts`,
cclmetasearch, or the broader ranking logic, and it did not change any exported
signature. Orchestration and parsing stay in the search modules: gating, the
offset guard, payload parsing/page-info, reference extraction, ordering, and the
final `listArticles` materialization are unchanged.

Rollback is repository-only: delete `lib/search/repository/`, restore the two
`getSupabaseAdmin()`-based bodies in `lib/search/ranked-page.ts` /
`lib/search/exact-case.ts`, and revert the `test:search-repository` script.

### 13.2 What M4.4a moved

New module `lib/search/repository/`:

- `types.ts` — the `SearchRepository` contract plus `RankedSearchMode`,
  `RankedSearchPageRpcRequest`, `ExactCaseLookupReference`, and
  `ExactCaseArticleIdRequest`. No Postgres/Supabase types.
- `supabase-repository.ts` — `createSupabaseSearchRepository`, the authoritative
  adapter. It preserves, resolved against the injected client and environment:
  - `rankedSearchPageRpc` → the exact `worldcons_ranked_search_page_v1` RPC and
    every named argument (`p_query`, `p_mode`, `p_query_embedding`, `p_limit`,
    `p_offset`, `p_source`, `p_jurisdiction`, `p_content_type`, `p_language`,
    `p_tag`, `p_range`, `p_count`), returning the raw payload or `null` on error;
  - `findExactCaseArticleIds` → the per-reference `articles` /
    `public_article_projection_p3` relation choice, the `select("id").eq(
    "source_key", …)` base query, the legacy `status = summarized` +
    `source_metadata->collection->>publishable = true` filter only when
    projection reads are disabled, the jurisdiction/content_type/
    original_language filters, the indexed `.eq("case_key", …).limit(100)`
    lookup, the fallback-on-index-query-error branch, the
    `source_metadata->>caseNumber` `ilike` and the
    `de-bverfg`/`us-scotus` `original_url` `ilike` (token = `caseKey` for
    `de-bverfg`, otherwise `caseNumber`), and the per-reference id order/dedupe.
- `fail-closed-repository.ts` — `failClosedSearchRepository`: the ranked page
  resolves `null` and the exact-case lookup resolves `[]`, so without a database
  the exported callers keep their pre-extraction empty/`listArticles` behavior.
- `index.ts` — `searchRepository()` selection point: Supabase whenever
  configuration is present, otherwise the fail-closed adapter.

Changed callers:

- `lib/search/ranked-page.ts` keeps the `includeUnpublished` /
  `publicProjectionReadsEnabled` gate, the `offset > 10_000` guard, the payload
  parsing, and the `offset + ids.length + (hasMore ? 1 : 0)` total lower bound;
  it now calls `searchRepository().rankedSearchPageRpc(...)` instead of
  `getSupabaseAdmin().rpc(...)`. `RankedSearchMode` is defined in the repository
  contract and re-exported, so the exported surface is unchanged.
- `lib/search/exact-case.ts` keeps the reference extraction/source filter,
  reference order/dedupe, and the `listArticles` materialization with its
  page-slice/`pageInfo` math; it now calls
  `searchRepository().findExactCaseArticleIds(...)` instead of building the
  Supabase queries itself. The `publicArticleRelation` /
  `publicProjectionReadsEnabled` imports moved into the adapter.

### 13.3 Coupling effect and remaining coupling under `lib/search`

The extraction shape matches M4.1–M4.3: `supabase-repository.ts` is a new
direct-coupling file and `index.ts` calls `getSupabaseAdmin()`, while
`ranked-page.ts` and `exact-case.ts` lose their `getSupabaseAdmin` / `.from(` /
`.rpc(` calls. The measurable win is at the boundary: neither module gains a
Supabase dependency, and a future D1 adapter can implement `SearchRepository`
without touching them.

Remaining direct Supabase coupling under `lib/search` after M4.4a:

- `lib/search/case-catalog.ts` — `getSupabaseAdmin` + `worldcons_case_search_page_v2`
  (M4.4b).
- `lib/search/vector.ts` — `getSupabaseAdmin`, `public_fulltext_ranked_ids_v1`,
  `match_public_article_versions_p3` / `match_articles`, and the embedding read
  (M4.4b).
- `lib/search/repository/index.ts` — the selection point (counted coupling, same
  as the other repository `index.ts` files).
- `lib/search/repository/supabase-repository.ts` — the authoritative adapter.

`ranked-page.ts` and `exact-case.ts` now carry no direct Supabase coupling. As
with the earlier slices, the file-level census is flat-to-slightly-changed rather
than sharply down because the adapter files are themselves counted.

### 13.4 M4.4a files changed

- Added: `lib/search/repository/types.ts`
- Added: `lib/search/repository/supabase-repository.ts`
- Added: `lib/search/repository/fail-closed-repository.ts`
- Added: `lib/search/repository/index.ts`
- Added: `tests/search-repository.test.ts`
- Changed: `lib/search/ranked-page.ts` (RPC delegation; `publicProjectionReadsEnabled` gate/parsing retained)
- Changed: `lib/search/exact-case.ts` (lookup delegation; reference order/dedupe and `listArticles` materialization retained)
- Changed: `package.json` (`test:search-repository`; added to `verify:release`)
- Changed: `docs/worldcons-cloudflare-m4-repository-abstraction-20260921.md`

### 13.5 M4.4a verification

| Check | Result |
| --- | --- |
| `pnpm test:search-repository` | Pass, 14/14 |
| `pnpm test:article-reads` | Pass, 22/22 |
| `pnpm test:reference-reads` | Pass, 10/10 |
| `pnpm test:public-regression` | Pass, 15/15 |
| `pnpm test:plugin` | Pass, 12/12 |
| `pnpm test:catalog` | Pass, 13/13 (1 postgres SKIP) |
| `pnpm test:cclmetasearch` | Pass, 9/9 |
| `pnpm test:cclrag2` | Pass, 19/19 |
| `pnpm test:provider:search` | Pass, 20/20 |
| `pnpm typecheck` | Pass |
| `pnpm check` | Pass |
| `pnpm lint` | Pass |
| `pnpm check:vinext` | Pass (100% compatible) |
| `pnpm build:vinext` | Pass |
| `pnpm build` (Next/Vercel path) | Pass |
| `git diff --check` | Pass |

The focused tests prove: (1) `searchRepository()` selects the fail-closed adapter
without configuration and the Supabase adapter with it, and the exported
`rankedSearchPage` / `exactCaseSearch` keep their no-config behavior; (2) the
adapter issues the ranked RPC with the exact arguments and returns `null` on
error; (3) `rankedSearchPage` preserves the projection/unpublished gates, the
10k offset guard (including the exactly-10k boundary), the payload parsing, the
mode fallback, and the page-info lower bound, and rejects invalid payloads; (4)
the exact-case lookup preserves the indexed `case_key` query shape, the relation
projection choice, the legacy publishable filter, the filters, the
fallback-on-index-error metadata/`original_url` order, the per-source url token,
and cross-reference id order/dedupe; (5) the exported `exactCaseSearch` keeps
reference order/dedupe, the page slice, the projected-relation path, and its empty
short-circuits.

No commit or push was performed.

## 14. M4.4b — search domain: catalog + vector (completed)

**Status: done.** Baseline: clean HEAD `4dc4fe5` (feat: add cloudflare m4.4a
search repository seam). No Orca, no deploy, no DNS change, no production data
change, no D1.

### 14.1 Scope and safety boundary

M4.4b extended the `lib/search/repository/` seam with the remaining direct
Supabase coupling in the two largest search modules and nothing else:

- `lib/search/case-catalog.ts` — the `worldcons_case_search_page_v2` RPC, with
  database cursor error evidence passed through so the module keeps its exact
  `CatalogSearchCursorError` parsing and semantics.
- `lib/search/vector.ts` — the `public_fulltext_ranked_ids_v1` ranked-id RPC
  (`rankedFullTextCandidates`), the semantic vector-match RPC selection
  (`match_public_article_versions_p3` vs `match_articles`, `semanticSearch`), and
  the public article embedding-row read (`localSemanticSearch`).

It did **not** deploy, change DNS, touch production data, introduce D1, or
change any exported signature. Orchestration, parsing, legal reranking,
embedding creation, cosine similarity, fusion, pagination, fallback ordering,
exact-case precedence, and the `listArticles` materialization all stay in
`case-catalog.ts` / `vector.ts`.

Rollback is repository-only: delete the four new `SearchRepository` methods (and
`isConfigured`), restore the three `getSupabaseAdmin()`-based bodies in
`lib/search/case-catalog.ts` / `lib/search/vector.ts`, and revert the two static
test relocations.

### 14.2 What M4.4b moved

Contract (`lib/search/repository/types.ts`): `SearchRepository` gained
`isConfigured()`, `catalogCaseSearchRpc`, `fullTextRankedIdsRpc`,
`vectorMatchRpc`, and `findSemanticEmbeddingRows`, plus the platform-neutral
`SearchDatabaseErrorEvidence`, `CatalogCaseSearchRpcRequest`,
`CatalogCaseSearchRpcResult`, `FullTextRankedIdsRpcRequest`,
`VectorMatchRpcRequest`, and `SemanticEmbeddingRowRequest` types. No
Postgres/Supabase types are exposed.

- `CatalogCaseSearchRpcResult` is a discriminated union
  (`{ status: "ok"; data } | { status: "error"; error } | { status:
  "unavailable" }`). The `error` evidence (`code` / `message` / `details` /
  `hint`) is the exact pre-extraction shape that `databaseCursorError` parses,
  and `unavailable` preserves the no-config
  `case_catalog.search_database_unavailable` throw.

Supabase adapter (`lib/search/repository/supabase-repository.ts`) preserves,
resolved against the injected client and environment:

- `catalogCaseSearchRpc` → the exact `worldcons_case_search_page_v2` RPC and
  every named argument (`p_query`, `p_limit`, `p_cursor`, `p_source`,
  `p_jurisdiction`, `p_content_type`, `p_language`, `p_tag`, `p_range`), returning
  the raw payload, the raw error evidence, or the payload unchanged;
- `fullTextRankedIdsRpc` → the exact `public_fulltext_ranked_ids_v1` RPC and
  every named argument (`p_query`, `p_limit`, `p_source`, `p_jurisdiction`,
  `p_content_type`, `p_language`, `p_range`), returning the array or `null` on
  error/non-array;
- `vectorMatchRpc` → the `publicVectorMatchRpc(false, environment)` selection
  (`match_public_article_versions_p3` vs `match_articles`) and the exact
  `query_embedding` / `match_count` / `source_filter` / `jurisdiction_filter` /
  `content_type_filter` / `language_filter` arguments, returning the array or
  `null`;
- `findSemanticEmbeddingRows` → the `publicArticleRelation(false, environment)`
  relation, `select("id, embedding")`, `.not("embedding","is",null)`,
  `.eq("status","summarized")`, `.limit(max(matchCount, 100))`, the legacy
  `source_metadata->collection->>publishable = true` filter only when projection
  reads are disabled, the source/jurisdiction/content_type/original_language
  filters, and the `normalizeRange` `original_published_at >= …` date floor for
  `today` / `week` / `month`, returning the rows or `null`.

`isConfigured()` returns `true` for the Supabase adapter.

Fail-closed adapter (`lib/search/repository/fail-closed-repository.ts`):
`isConfigured()` is `false`, the catalog RPC reports `unavailable`, the
full-text/vector/embedding reads resolve `null`, and the exact-case lookup
resolves `[]`, so every caller keeps its pre-extraction no-config behavior.

Changed caller (`lib/search/case-catalog.ts`): the `getSupabaseAdmin()` guard and
the `supabase.rpc("worldcons_case_search_page_v2", …)` call are replaced by
`searchRepository().catalogCaseSearchRpc(...)`. `case-catalog.ts` keeps the
flag gate, the `page > 1 && !cursor` guard, `normalizeLegalSearchQuery`,
`databaseCursorError` parsing, `parseRetrievalMode` / `parseRankingVersion` /
`parseIds`, the `listArticles` materialization and its
`case_catalog.search_materialization_mismatch` check, `rerankLegalSearchItems`,
the page-info/next-cursor validation, and `nonNegativeInteger`.

Changed caller (`lib/search/vector.ts`): the three `getSupabaseAdmin()` guards
and the direct `.rpc(...)` / `.from(...)` calls are replaced by the repository
methods. `vector.ts` keeps the projection gate, `rankedSearchWindow` /
`rankedLookupFilters`, `rankedItemsByIds`, `reorderByIds`,
`paginateRankedArticleItems`, the cosine similarity, the full-text id mapping,
the RRF fusion, and the fallback chain. `semanticSearch` now uses
`searchRepository().isConfigured()` for the same early guard that previously
skipped embedding creation when Supabase was absent, so no embedding request is
made without a database; `localSemanticSearch` keeps `parseVector` /
`cosineSimilarity` and the `matchCount` slice. `publicVectorMatchRpc` and
`publicArticleRelation` moved out of `vector.ts` into the adapter;
`publicProjectionReadsEnabled` is still used for the `rankedFullTextCandidates`
gate, matching `ranked-page.ts`.

### 14.3 Coupling effect and remaining direct Supabase coupling under `lib/search`

The extraction shape matches M4.4a: the adapter stays the one direct-coupling
file and the selection point stays the one `getSupabaseAdmin()` call site, while
`case-catalog.ts` and `vector.ts` lose every `getSupabaseAdmin` / `.from(` /
`.rpc(` call. The measurable win is at the boundary: neither module gains a
Supabase dependency, and a future D1 adapter can implement `SearchRepository`
without touching them.

Remaining direct Supabase coupling under `lib/search` after M4.4b:

- `lib/search/repository/index.ts` — the selection point (`getSupabaseAdmin()`).
- `lib/search/repository/supabase-repository.ts` — the authoritative adapter
  (all `.rpc(` / `.from(` calls).

`lib/search/case-catalog.ts`, `lib/search/vector.ts`, `lib/search/ranked-page.ts`,
and `lib/search/exact-case.ts` now carry no direct Supabase coupling. Because the
adapter and selection files were already counted by M4.4a, the file-level census
is unchanged.

### 14.4 Static test relocation

Two existing source-scanning tests asserted on definitions that moved. Their
behavior assertions are unchanged; only the scanned file moved to the canonical
module:

- `tests/constitutional-case-search-gate3.test.ts` — the
  `worldcons_case_search_page_v2` proof now reads
  `lib/search/repository/supabase-repository.ts`; the `nextCursor` and
  Gemini-free proofs still read `lib/search/case-catalog.ts`.
- `tests/article-publication-p3.test.ts` — the `publicVectorMatchRpc` proof now
  reads `lib/search/repository/supabase-repository.ts`, and the adapter is added
  to the centralized-read-authority scan. The now-unused `vector.ts` read was
  removed.

### 14.5 M4.4b files changed

- Changed: `lib/search/repository/types.ts` (five contract methods; evidence/result/request types; contract doc)
- Changed: `lib/search/repository/supabase-repository.ts` (four new methods + `isConfigured`)
- Changed: `lib/search/repository/fail-closed-repository.ts` (`isConfigured`; catalog/full-text/vector/embedding fallbacks)
- Changed: `lib/search/case-catalog.ts` (catalog RPC delegation; `getSupabaseAdmin` removal)
- Changed: `lib/search/vector.ts` (full-text/vector/embedding delegations; `isConfigured` guard; coupling removal)
- Changed: `tests/search-repository.test.ts` (catalog/full-text/vector/embedding adapter parity; catalog cursor evidence end-to-end; fail-closed coverage; static zero-coupling guard; harness `not`/`gte`)
- Changed: `tests/constitutional-case-search-gate3.test.ts` (static path relocation)
- Changed: `tests/article-publication-p3.test.ts` (static path relocation; unused read removal)
- Changed: `docs/worldcons-cloudflare-m4-repository-abstraction-20260921.md`

No `package.json` change was needed: `test:search-repository` already runs the
focused file and is already wired into `verify:release`.

### 14.6 M4.4b verification

| Check | Result |
| --- | --- |
| `pnpm test:search-repository` | Pass, 21/21 |
| `pnpm test:catalog` | Pass, 13/13 (1 postgres SKIP) |
| `pnpm test:cclrag2` | Pass, 19/19 |
| `pnpm test:provider:search` | Pass, 20/20 |
| `pnpm test:cclmetasearch` | Pass, 9/9 |
| `pnpm test:p3` | Pass, 8/8 (1 postgres SKIP) |
| `pnpm test:article-reads` | Pass, 22/22 |
| `pnpm test:reference-reads` | Pass, 10/10 |
| `pnpm test:public-regression` | Pass, 15/15 |
| `pnpm test:plugin` | Pass, 12/12 |
| `pnpm typecheck` | Pass |
| `pnpm check` | Pass |
| `pnpm lint` | Pass |
| `pnpm check:vinext` | Pass (100% compatible) |
| `pnpm build:vinext` | Pass |
| `pnpm build` (Next/Vercel path) | Pass |
| `git diff --check` | Pass |

The focused tests prove: (1) the fail-closed adapter reports no config and
returns `unavailable`/`null` for the new operations, and the Supabase adapter
reports config; (2) the catalog adapter issues the exact RPC/arguments and
returns raw error evidence; (3) the exported `catalogCaseSearch` keeps the
no-config `search_database_unavailable` throw, maps
`EXPIRED`/`MISMATCH`/`MODE_CHANGED`/`INVALID_CURSOR` evidence to the exact
`CatalogSearchCursorError` reasons, keeps `search_failed:<code>` for other
errors, and materializes the RPC page with `listArticles`, retrieval
mode/ranking version, and cursor-bearing page info; (4) the full-text adapter
issues the exact RPC/arguments and resolves `null` on error/non-array; (5) the
semantic vector adapter selects `match_public_article_versions_p3` vs
`match_articles` by projection flag, sends the exact arguments, and resolves
`null` on error; (6) the embedding read uses the legacy/projected relation, the
publishable filter only when projection reads are disabled, `select("id,
embedding")`, the `not`/`status`/`limit`/source/jurisdiction/type/language
handling, the range date floor, and resolves `null` on error; (7) a static guard
proves `case-catalog.ts` and `vector.ts` carry no `getSupabaseAdmin`, `.from(`,
or `.rpc(` calls.

No commit or push was performed.

### 14.7 M4.5 — admin/ops read domains (next scope)

M4.4 completes the search domain: every public and search read path now flows
through a platform-neutral repository seam, and direct Supabase coupling under
`lib/search` is limited to the adapter and its selection point. The next slice is
**M4.5, the admin/ops read domains**, which is a different risk profile and is
explicitly out of scope for M4.4b:

- **Dashboard/analytics/triage reads** — `lib/db/admin-queries.ts`,
  `lib/db/analytics.ts`, `lib/db/article-triage.ts`, and the admin page/RSC read
  paths. These are mostly `getSupabaseAdmin()` call sites plus two snapshot RPCs
  (`rpc_admin_dashboard_snapshot`, `rpc_admin_analytics_health_snapshot`) that
  already carry a legacy fallback.
- **Admin audit/edit-history reads** — `lib/db/admin-audit.ts` and the
  `admin_audit_logs` / `admin_article_edit_history` projections.

M4.5 needs its own boundary because these reads are privileged (they read
private/unpublished state), so the contract must keep the "admin authority"
distinct from the public read authority, and the parity tests must prove the
privileged projections and redaction are unchanged. M4.6 (the RPC ledger) then
gains one row per Postgres function, including the two admin snapshot RPCs and
every search RPC moved in M4.4.
