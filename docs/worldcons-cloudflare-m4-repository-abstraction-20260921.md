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
| M4.3 | Public article read domain: `listArticles`, `getArticleBySlug`, sitemap, related, top-viewed | Largest public seam; exercises detail-projection v4 and tag filtering. |
| M4.4 | Search domain: ranked page, exact-case, case catalog, vector | Builds on the frozen search parity corpus. |
| M4.5 | Admin/ops read domains: dashboard, analytics, triage | Mostly `getSupabaseAdmin` call sites. |
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

## 8. Next safe slice — M4.3

**M4.3 — public article read domain.** Move `listArticles`, `getArticleBySlug`,
the sitemap reads, related articles, and top-viewed reads onto the same
platform-neutral repository seam. This is the largest public seam and unlike
M4.1/M4.2 it exercises the article detail-projection v4 selection and tag-filter
joins, so it needs its own parity evidence (field-by-field row mapping, tag
aggregation, and pagination/ordering). `getTagBySlug` should move with it because
it depends on `listArticles`.

Search (M4.4), admin/ops reads (M4.5), and the RPC ledger (M4.6) remain after
that, as planned in section 3.
