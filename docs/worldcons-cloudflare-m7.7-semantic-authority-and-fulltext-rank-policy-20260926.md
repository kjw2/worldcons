# WorldCons Cloudflare M7.7 — Semantic authority + fulltext rank policy

Date: 2026-09-26

## Status

M7.7-A (semantic embedding-authority repair) is **authored and locally verified
only**. The new Supabase migration is **NOT applied remotely**, no production
resource/route/DNS/traffic flag was changed, `SearchRepository` selection is
unchanged, `search_m7` remains blocked and no `GO-SEARCH`/`GO-D1-READ` is
claimed. Supabase remains the sole production search/read authority.

M7.7 is split into two independent decisions:

- **M7.7-A — semantic authority drift.** Repair the `public_article_projection_p3`
  embedding authority so a current provenance-locked Gemini artifact backs the
  projection even when `article_content_versions_p3.embedding` is NULL. This is
  the slice implemented here.
- **M7.7-B — fulltext rank policy.** Decide whether FTS5 bm25 vs Postgres
  `ts_rank_cd` ordering differences are `informational`-only production policy or
  require an agreed acceptance threshold. **No threshold was invented in M7.7-A.**
  The M7.6 `fulltext_rank_threshold_unagreed` blocker stays present and is not
  resolved here. The **v1** corpus is **invalid (scope)** and archived: its strict
  candidates had zero exact matches and its evidence compared a 1258-row
  production id window against only the first 100 local source rows. The **v2**
  corpus is **invalid (harness)** and archived: it executed the exact-case strict
  cases through the FTS-only path/oracle even though exact-case is a distinct M7.3
  branch, and it required a single `expectedId` for the BVerfG exact title even
  though three authoritative public rows share that exact title. The **v3**
  corpus is **invalid (targetset)** and archived: the Spain case key `572025`
  legitimately belongs to BOTH an AUTO and a SENTENCIA, but v3 froze only one
  authoritative id. The **v4 corpus/harness is now the valid evidence
  baseline**: complete authoritative exact-case/exact-title target sets,
  ranked-page exact-case execution, and the full-scope read-only paged reader
  were frozen before the v4 run. Final linked v4 evidence compared the same
  1,258 production ids on both sides, passed all 8 strict invariants, and
  produced no runtime/oracle errors. The policy intentionally remains
  `insufficient_evidence` because no independently pre-registered generic
  lexical acceptance threshold exists.

## 0. M7.7-A read-only production baseline (content-free, counts only)

The following read-only semantic-provenance audit baseline was recorded against
the linked production Supabase authority (the M7.7-A migration remains
**unapplied**, so this is the *pre-migration* gate2 `public_article_projection_p3`
state):

```text
current_published_rows                  = 1258
projection_rows                         = 1258
projection_embedding_null_count         = 872
artifact_backed_current_published_rows  = 1258
legacy_version_embedding_only_count     = 872
artifact_provider_mismatch_count        = 0
artifact_model_mismatch_count           = 0
artifact_dimensions_mismatch_count      = 0
artifact_content_hash_mismatch_count    = 0
artifact_version_mismatch_count         = 0
```

Interpretation: all 1,258 current published rows are backed by a
provenance-locked Gemini artifact, but the currently deployed projection exposes
only `article_content_versions_p3.embedding`, which is NULL for 872 rows. The
M7.7-A view change is therefore still required and is still **not applied**.

## 1. New migration (authored, never applied remotely)

`supabase/migrations/20260926120000_m7_7a_semantic_authority_projection.sql`

- One NEW timestamped migration. No existing migration is edited.
- Re-creates `public.public_article_projection_p3` with the **latest gate2 column
  list/order/types** (`20260903130000_constitutional_case_catalog_gate2.sql`) and
  the **gate2 freshness/catalog eligibility predicate preserved exactly**.
- Changes **only** the semantic embedding authority: it left-joins
  `public.article_embedding_artifacts` on the current
  `article_version_id` + `article_id` + `content_hash` and
  `provider='gemini'` + `model='gemini-embedding-001'` + `dimensions=1536`, then
  exposes `coalesce(e.embedding, v.embedding) as embedding`.
- Retains `with (security_barrier = true)` and the existing
  anon/authenticated/service_role SELECT grant semantics (restated fail-soft,
  idempotent; never granted to `PUBLIC`).
- Adds a fail-closed preflight assertion that the **current** view column
  names/order match the expected gate2 list before it replaces anything
  (`M77A_PROJECTION_VIEW_MISSING` / `M77A_PROJECTION_VIEW_COLUMN_DRIFT`), and
  ends with `notify pgrst, 'reload schema';`.

Applying the migration remotely is a **separate operator decision** and is not
part of M7.7-A.

### Rollback

Rollback is a **future new migration** that re-creates
`public_article_projection_p3` without the artifact join, restoring bare
`v.embedding` (the gate2 shape). It must **never** edit
`20260926120000_m7_7a_semantic_authority_projection.sql`; forward-only migration
history is preserved. The same fail-closed preflight and grant/notify semantics
apply. No rollback is applied remotely by M7.7-A.

## 2. Source-selection reconciliation (code only, no authority switch)

`lib/cloudflare/search-projection/source.ts` previously claimed to “exactly
mirror” `public_article_projection_p3` while only filtering
`article_publications_p3.state='published'`. It now accepts optional
`gate2Eligibility` inputs (`legacy_version_freshness_classifications_v4` and
`case_catalog_publications_v1`, plus the additive gate2 version fields) and,
when supplied, applies the gate2 predicate exactly:

- `version_role is null`: current legacy freshness classification required and
  no published catalog publication allowed;
- `version_role='enrichment_full'`: a published catalog publication is required
  with a matching `source_anchor_version_id` and an anchor whose
  `source_content_hash` equals `enrichment_source_content_hash`;
- any other role (for example `authoritative_source`) is never selected.

Without `gate2Eligibility` the historical published-only selection is retained
so existing local fixtures/canary plans are unchanged; the unconditional parity
claim was removed. `buildVectorProjection` and
`buildSearchCanaryProjectionPlan` forward the new field. **No production
authority switch:** `SearchRepository` is untouched and the canary path keeps its
previous selection unless eligibility rows are supplied.

## 3. Read-only semantic provenance audit

- `lib/cloudflare/search-vector/provenance-audit.ts` authors ONE read-only
  observation query and maps its single row to counts only:
  `artifact_backed_current_published_rows`,
  `projection_embedding_null_count`, `legacy_version_embedding_only_count`, and
  `provider`/`model`/`dimensions`/`content_hash`/`version` mismatch counts.
- `scripts/semantic-provenance-audit.ts` (`pnpm audit:semantic-provenance`)
  wires it to the existing linked-Supabase CLI runner. `--dry-run` prints the SQL
  without connecting; `--json` prints the counts. It selects no vector value,
  text, summary, URL or id, writes no Supabase row and has **no `--apply`**.

## 4. Tests

- `tests/m7.7a-semantic-authority.test.ts` (`pnpm test:m7.7a`, 11 cases) proves
  the migration column list/order is identical to gate2 except the embedding
  expression, the gate2 predicate is byte-identical after normalization, the
  provenance join literals are present, the preflight/notify/grants exist, the
  source gate2 eligibility semantics (legacy, enrichment, ambiguity, role
  exclusion, backward compatibility) and the audit SQL/parser/no-apply
  constraints.
- `tests/constitutional-case-catalog-gate2.postgres.test.ts` adds PostgreSQL
  subtests that apply the new migration and prove: a legacy published row with a
  NULL version embedding is backed by its Gemini artifact, a non-Gemini artifact
  is ignored, re-application is idempotent, and a drifted current view fails the
  preflight closed.

## Local verification

```text
pnpm test:m7.7a                   # 11/11 pass
pnpm test:d1-search-projection    # 15/15 pass
pnpm test:d1-fts-search           # 16/16 pass
pnpm test:d1-ranked-search        # 24/24 pass
pnpm test:d1-vector-search        # 32/32 pass
pnpm test:d1-search-canary        # 29/29 pass
pnpm test:d1-search-canary-m7.6   # 55/55 pass
pnpm typecheck                    # pass
pnpm lint                         # pass (0 errors)
git diff --check                  # pass
```

The PostgreSQL subtests are skipped unless `CATALOG_TEST_DATABASE_URL` points at
a disposable catalog test database, exactly like the existing Gate 2 suite.

## Boundaries preserved

- No remote Supabase migration was applied; the new migration is authored only.
- No Supabase row was mutated by M7.7-A; the audit is read-only with no apply.
- `SearchRepository`, `GO-SEARCH`, DNS and traffic are unchanged.
- `search_m7` remains blocked; the M7.6 semantic drift is now *repairable by a
  migration* but is not marked resolved until that migration is applied and the
  frozen suite is rerun. The `fulltext_rank_threshold_unagreed` blocker remains
  for M7.7-B.

# M7.7-B — fulltext rank policy (implemented, evidenced, still `insufficient_evidence`)

M7.7-B does **not** invent, tune or ship a generic lexical acceptance threshold.
M7.2 already documents that FTS5 bm25 does not reproduce Postgres
`ts_rank_cd`. M7.7-B instead makes the decision *legible and reproducible*: a
frozen content-free corpus, a read-only D1-FTS5-vs-production harness, aggregate
`compareRankedIds` evidence metrics, strict exact-match invariants, and an
explicit policy state machine. With no independently pre-registered threshold
the generic categories stay `insufficient_evidence` and
`fulltext_rank_threshold_unagreed` remains — exactly as intended.

## 5. Runtime-neutral rank-policy module

`lib/cloudflare/search-rank-policy/*` (no `node:*` import; no remote read/write):

- `types.ts` — the frozen corpus contract (`RankCorpusCase`,
  `RankCorpusManifest`), the aggregate metric shapes, the strict-invariant and
  informational summaries, the optional `RankPolicyThresholds` (M7.7-B ships
  none) and the `pass | fail | insufficient_evidence` state type.
- `corpus.ts` — the authored candidate pool, the deterministic selection
  (`selectRepresentativeCorpus`), category/invariant consistency validation and
  the stable `rankCorpusHash` (via the runtime-neutral `shadowDigest`, never
  `node:crypto`).
- `metrics.ts` — `aggregateRankComparisons`: macro (mean-over-cases) overlap@K,
  prefix, exactOrder and sameSet reduction of the M7.2 `compareRankedIds`
  evidence, plus raw counts.
- `invariants.ts` — deterministic resolution of the exact-case target (the M7.3
  separator-delimited `case_numbers` token test) and the exact-title target (the
  M7.2 encoded-title exact match) against the local projected corpus, plus
  `resolveFrozenStrictTarget`, which validates the frozen v4 manifest target set
  against that projection and returns `frozenValidated=false` when the query no
  longer resolves to exactly the frozen set, so the policy **fails closed** on
  drift or a new ambiguity instead of silently passing.
- `policy.ts` — `evaluateRankPolicyCase` + `summarizeRankPolicy`, the strict
  100% exact-invariant accounting and the category threshold accounting.
- `evidence.ts` — content-free `buildFtsParityReport` and
  `renderFtsParityMarkdown` (ids/counts/hashes/states only).

**Policy rules (in order):** any strict exact-case/exact-title failure ⇒ `fail`;
no evaluable strict case ⇒ `insufficient_evidence`; generic lexical cases with
no independently pre-registered threshold ⇒ `insufficient_evidence` (with
`fulltext_rank_threshold_unagreed`); a registered threshold not met ⇒ `fail`;
otherwise `pass`. The strict invariants require the local authoritative top id to
belong to the frozen target set, and the production oracle top id to belong to
that same set whenever the production oracle returned a non-empty window. They
are exact, never numeric.

## 6. Frozen representative corpus manifest (v4 active; v1/v2/v3 archived invalid)

Three invalid manifests are archived verbatim and MUST NOT be edited:

- `corpus.manifest.v1-invalid.json` (`version 1`,
  `corpusHash 62c5e359e5b9838d`, 14 cases) — **invalid scope**: its strict
  fixture-shaped candidates had zero exact matches in the current production
  projection and its evidence compared a 1258-row production id window against
  only the first 100 local source rows, so it was neither like-for-like nor a
  valid strict corpus.
- `corpus.manifest.v2-harness-invalid.json` (`version 2`,
  `corpusHash 26f2a4d4b03e7a90`) — **invalid harness**: it executed the
  exact-case strict cases through the FTS-only path/oracle although exact-case is
  a distinct M7.3 branch, and it required a single `expectedId` for the BVerfG
  exact title even though three authoritative public rows share that title.
- `corpus.manifest.v3-targetset-invalid.json` (`version 3`,
  `corpusHash fb108124e7fe6ed8`) — **invalid targetset**: the Spain case key
  `572025` authoritatively belongs to both an AUTO and a SENTENCIA, but v3 froze
  only the deterministic anchor id.

The active `lib/cloudflare/search-rank-policy/corpus.manifest.json` is **v4** and
content-free: only case **queries**, stable case **ids**, bounded **filters**,
**categories** and (strict cases only) an `expectedIds` target set are stored
(`display_title`/`search_text`/`cleaned_text`/`summary`/`url`/`embedding`/
`vector` never appear). It was selected deterministically **before any v4 parity
outcome was read**, and MUST NOT be edited to match an observed result.

- Stable `corpusHash`: `ed18add749fe4a23` (order-independent).
- 18 selected cases: 4 `exact-case` + 4 `exact-title` (one anchor per supported
  source) + 2 per informational category (`multilingual-legal-term`,
  `case-number-identifier`, `jurisdiction-source`, `cclrag2-shape`,
  `cclmetasearch-shape`). Every v3 query/filter/category/limit/k is unchanged.
- Deterministic strict provenance: for each supported `source_key` take the
  lowest `public_article_projection_p3` article id having a non-null `case_key`
  and recognized display-case metadata. The frozen anchors are
  `de-bverfg 00083deb-5bc9-4b28-bbcd-68076cd05514` (`2 BvL 21/14` /
  `Beschluss vom 21. Oktober 2025`),
  `es-tribunal-constitucional` (`57/2025` / `AUTO 57/2025, de 27 de mayo de
  2025`),
  `fr-conseil-constitutionnel 0018a822-df15-4526-abd8-6c22e6ba7988`
  (`2024-6412 AN` / `Décision n° 2024-6412 AN du 6 juin 2025`) and
  `us-scotus 0346769f-97d0-48e2-b2e2-3a371e7d2eee`
  (`24-304` / `Laboratory Corp. of America Holdings v. Davis`), selected from
  authoritative public metadata independently of any rank outcome.
- The v4 `caseIds`/`titleIds` are the **complete authoritative exact-match sets**
  for the already-frozen queries: `exact-case-es-tribunal-constitucional`
  (`57/2025`) has exactly
  `00cc18bd-ace3-4b5e-aabb-f3aacbd6d077` and
  `e6e97786-ad78-46b1-8549-7a69788ea178` (AUTO and SENTENCIA share the key); every
  other exact-case set is a singleton. The exact-title sets are unchanged from v3
  (`exact-title-de-bverfg` keeps all three authoritative ids).
- Strict target evaluation validates the frozen target set against the local
  authoritative projection and fails closed if the query no longer resolves to
  exactly that set (drift or a new ambiguity).

`pnpm test:search-rank-policy` proves the v1/v2/v3 archives and hashes, v4 hash
stability, deterministic selection (including candidate-pool order independence),
content-free shape, informational-query preservation, the complete v4
exact-case/exact-title target sets, preflight set equality, multi-member
pass/outside-id fail, frozen-target fail-closed, aggregate metric math,
strict-invariant failure ⇒ `fail`, exact-case metric exclusion, and
`insufficient_evidence` when no threshold exists.

## 7. Read-only parity harness

`scripts/d1-fts-parity.ts` (`pnpm d1:fts-parity`) plus the operator-only
`scripts/d1-fts-source-pager.ts`:

- reads the FULL production `public_article_projection_p3` id set (read-only,
  ids only, ceiling 5000; touching the ceiling fails closed);
- pages ALL published `article_publications_p3` rows read-only through the
  dedicated FTS source pager by a stable `article_id` cursor (50-100 rows/page),
  selecting only the projection/FTS columns and **never an embedding**;
- restricts the paged rows to exactly the production projection ids and
  materializes them through the M7.1/M7.2 D1 projection + FTS5 path into an
  in-memory `node:sqlite` database; it **fails closed before any rank
  evaluation** unless the local projected article-id set exactly equals the
  production projection id set (missing/extra id counts must both be 0);
- exposes a content-free scope summary (`productionProjectionIds`,
  `sourceRowsFetched`, `localDocuments`, `missingIds`, `extraIds`,
  `scopeValid`) that never prints an id;
- queries the production `public_fulltext_ranked_ids_v1` RPC read-only for
  exact-title and informational fulltext cases (authored literals only, no
  vector/text selection) and restricts the oracle to the same local id window;
- routes `exact-case` strict cases through the M7.3 ranked-page branch on both
  sides: local `runRankedSearchPage` and production
  `worldcons_ranked_search_page_v1` with `mode='fulltext'`; the returned
  `retrievalMode` must be `exact-case`, and those cases are excluded from the
  generic FTS5-vs-`ts_rank_cd` aggregate;
- computes strict invariants + macro overlap@K/prefix/exactOrder/sameSet and
  per-category metrics, evaluating strict targets against the frozen
  `expectedIds` target set;
- writes content-free
  `artifacts/cloudflare-m7/m7.7-fts-parity-report.{json,md}`.
- production evidence defaults to full like-for-like scope: if an operator
  passes `--max-articles` below the production projection count the harness
  **fails with an explicit `scope-too-small` error** and produces no metrics.
- `--dry-run` prints the corpus plan without connecting; `--source=fixture`
  supports offline runs; an operator may pass an explicit
  `--min-overlap-at-k`/`--min-prefix-macro`/`--min-exact-order-macro`/
  `--min-same-set-macro`, but no default threshold exists. There is **no
  `--apply`**, no Supabase mutation, no D1/Vectorize write and no canary data
  write.

## 8. Stored M7.7-B evidence — v4 valid full-scope baseline

The **v1** report that used the archived corpus compared a 1258-row production
id window against only the first 100 local source rows, so it was not
like-for-like. It is preserved verbatim for audit as
`artifacts/cloudflare-m7/m7.7-fts-parity-report-v1-scope-invalid.{json,md}`
(state `insufficient_evidence`, 0 evaluable strict cases, blocker
`rank_policy_no_strict_cases`) and is **not** valid M7.7-B evidence.

The **v2** full-scope run is preserved as
`m7.7-fts-parity-report-v2-harness-invalid.{json,md}`. Its 1,258/1,258 scope
was valid, but its strict harness was not: exact-case used the FTS-only branch
and the non-unique BVerfG exact title was frozen to one id.

The **v3** run is preserved as
`m7.7-fts-parity-report-v3-targetset-invalid.{json,md}`. It corrected the
exact-case branch and non-unique title set, but froze Spain `57/2025` to one
article even though authoritative public metadata contains both an AUTO and a
SENTENCIA with the same canonical case key `572025`.

The active **v4** report
`artifacts/cloudflare-m7/m7.7-fts-parity-report.{json,md}` is the first valid
full-scope M7.7-B evidence:

```text
corpusHash                = ed18add749fe4a23
productionProjectionIds   = 1258
sourceRowsFetched         = 1258
localDocuments            = 1258
missingIds                = 0
extraIds                  = 0
scopeValid                = true
errors                    = 0

strict cases              = 8
strict passed             = 8
strict failed             = 0
strict pass rate          = 1.0000
exact-case passed         = 4/4
exact-title passed        = 4/4

informational cases       = 10
informational compared    = 8
pre-registered threshold  = false

aggregate compared        = 12
overlap@K macro           = 0.3083333333
prefix-match macro        = 0.5333333333
exact-order macro         = 0.5000000000
same-set macro            = 0.5833333333
policy state              = insufficient_evidence
```

The only remaining rank-policy blocker is
`fulltext_rank_threshold_unagreed`. This is deliberate: the v4 run is evidence,
not a source from which to invent a threshold. The strict blocker is gone, and
the generic lexical metrics above remain informational until a threshold is
pre-registered independently of the observed v4 outcomes.

## M7.7-B boundaries preserved

- The M7.7-A migration is still **not applied**; Supabase was read-only and no
  Supabase row was mutated.
- No D1/Vectorize resource was written; the D1 path is in-memory `node:sqlite`.
- `SearchRepository`, `GO-SEARCH`, DNS and traffic are unchanged; no deployment.
- No generic lexical threshold was invented or tuned from M7.6 or from any
  single query.
- The v1/v2/v3 invalid evidence artifacts are preserved unchanged.
- The v4 linked parity run was read-only: no Supabase mutation, no D1/Vectorize
  remote write and no deployment occurred.

