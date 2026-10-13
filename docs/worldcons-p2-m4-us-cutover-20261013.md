# WorldCons P2-M4 - United States (SCOTUS) staged-cutover preflight / fail-closed readiness - 2026-10-13 (KST)

> **P2-M4 status: GATED / BLOCKED. No production cutover.**
> This document records a bounded US-specific implementation and a read-only
> Production audit. No allowlist/exclude value was changed, no Worker was
> deployed, no Production row was written, no forced publish and no policy
> override occurred. `us-scotus` remains M8-owned; FR/ES stay staged.
>
> **Engineering implementation vs operational cutover are DISTINCT.** This
> session delivered the fail-closed *planner/evaluator*, the *invariant*, the
> *focused tests* and the *read-only audit*. It did NOT perform the operational
> ownership cutover, which remains blocked by unobserved Production evidence.

## 0. Session facts (ground truth)

- Repo: isolated DevSpace worktree, branch `main`, base commit **`9743c4b`**
  (`docs(worldcons): record P2-M3 code-only production deployment evidence`),
  clean at start.
- Model route: Hive DeepSeek 4.1 Flash (this session). **No Codex. No Orca.**
- Production-only; Cloudflare D1/R2 read-only; no `INSERT`/`UPDATE`/`DELETE`;
  no forced publish; no direct Production D1 write; no remote redrive.
- Unrelated working-tree changes preserved. Official-source robots, R2/Core
  provenance and approval policy untouched.
- The prior Hive/P2-M3 session notes are preserved; this is a separate bounded
  US continuation. `worldcons-ingest` current release is `c8195b21`
  (code-only P2-M3 release); this session made **no deploy**.

## 1. US discovery -> fetch -> R2 -> Core -> publish -> search chain (inspected)

The US path is deliberately the most conservative of the four sources.

| Stage | US behavior | Fail-closed? |
| --- | --- | --- |
| Discovery (`discoverScotus`) | official `opinions/slipopinion/<term>` listing only; only `.pdf` anchors on the official host; term-rollover scans the adjacent previous term only inside the bounded October window; each candidate starts `collection.sourceUrlVerified=false`, `publishable=false`, `review.required=true` | yes |
| Crawl (`fetchCandidate` us branch) | `fetchScotusPdf` enforces official host, robots-positive evidence, <=2 redirect hops, `application/pdf`/octet-stream MIME, 8 MiB cap, PDF signature, and `extractOfficialScotusPdf` verifies the docket **against PDF body text**; original bytes written to R2 `artifacts/scotus_pdf/<sha256>.pdf`; `officialPdf` provenance recorded; then forces `collection.publishable=false`, `review.required=true` ("awaiting separate public-judgment readiness") | yes |
| Normalize (`persistArticle` / `persistNativeStageRecord`) | `articleStatus` returns `needs_review` for every `us-scotus` candidate regardless of extracted text; legacy status collapses to `metadata_only`; lifecycle `reviewState=needs_review`; a transient PDF/robots/docket failure (`previousPdf.docketVerified===true && currentPdf!=true`) preserves the earlier verified original instead of overwriting it with fallback text | yes |
| Translate | only runs when a real adapter is wired; the durable effect is re-verified in Core | yes |
| Public-judgment (`evaluatePublicJudgment`) | requires `collection.publishable===true`, `sourceTextAvailable===true`, `sourceUrlVerified===true`, non-seed, non-robots, non-source-only, and a non-private `review_state`; US never satisfies `publishable===true`, so it blocks | yes |
| Publish | per-article `runD1PublishArticle` uses the shared eligibility predicate and `articlePublicationService.transition`; no whole-queue drain | yes |
| Search | per-article `syncSearchProjectionForArticle`, same gate2 predicate | yes |

### 1.1 Fail-open states examined and resolved

1. **Discovery candidate treated as URL-verified.** Resolved: SCOTUS discovery
   candidates start `sourceUrlVerified=false`; only the crawl stage's in-body
   docket verification flips provenance. A discovery-only candidate can never
   pass the public-judgment source gate.
2. **Fallback text masquerading as a verified opinion.** Resolved: on any PDF
   verification failure the candidate keeps `publishable=false`; `articleStatus`
   forces `needs_review`; the previous verified original is preserved rather than
   replaced by synthetic title/URL text.
3. **Staged E2E auto-approval for a new source.** The staged approve path
   (`recordAutomaticApproval`) hardcodes only
   `fr-conseil-constitutionnel`/`es-tribunal-constitucional` hosts and rejects
   any other source (`host=null -> blocked`). US cannot be auto-approved by the
   staged E2E approval machinery.
4. **Source-ownership side door.** `M8_CRAWLER_SOURCE_EXCLUDE` and
   `WORLDCONS_INGEST_STAGE_SOURCE_ALLOWLIST` currently both name only FR/ES, so
   `us-scotus` is M8-owned and not staged; `/health` confirms it.

**Conclusion:** no *unpatched* fail-open that would auto-publish a US opinion was
found. A **staged E2E cannot count as published when unreviewed** because the US
collection policy holds `publishable=false` and the public gate refuses it. This
session did **not** force publish or mutate the legacy 136.

## 2. P2-M4 fail-closed readiness evaluator / planner (implemented)

New module `lib/cloudflare/ingest-stages/us-cutover-readiness.ts`, analogous to
the Germany P2-M3 guard but US-specific. It is pure, runtime-neutral and inert
until an operator supplies genuine proof.

Nine required gates, all explicitly `true`:

| Gate | Meaning |
| --- | --- |
| `official_pdf_fetched` | a genuine new official `supremecourt.gov` PDF was fetched through the crawl path |
| `docket_identity_verified` | PDF body docket exactly matched the discovered docket (application or cert form) |
| `r2_original_bytes` | original bytes stored in R2 and stored SHA-256 == provenance SHA-256 |
| `core_provenance` | Core `source_metadata.officialPdf` (url/r2Key/sha256/docketVerified) persisted |
| `private_review_hold` | article still carries `collection.publishable=false` and `review.required=true` |
| `staged_e2e` | one bounded Discovery->Search staged Production E2E for the US article |
| `manual_publication_authorization` | explicit MANUAL publication authorization evidence exists (US policy disallows automatic) |
| `p3_published` | immutable P3 `published` version for the SAME case lineage |
| `search_projected` | Search projection + FTS row for the SAME case lineage |

- `evaluateUsCutoverReadiness` fails closed for null/empty/partial proof.
- **Legacy historical counts are rejected**: a proof that contains only numeric
  Production counts (`coreArticles`/`publishedP3`/`searchEligible`/`discovered`/
  `fetched`) with no explicit gate is rejected with
  `us_cutover.legacy_historical_counts_rejected`. Counts alone never authorize.
- `planUsCutover` returns `authorized=false` and empty planned values unless every
  gate is explicitly `true`; it always captures the exact rollback strings. The
  paired staged allowlist and M8 exclusion always move **byte-identically**.
- Because US policy disallows automatic publication, a missing/false
  `manualPublicationAuthorization` is a named first blocker and the planner never
  substitutes an automatic approval.
- **Stronger ownership precondition (shared with P2-M3).** `planUsCutover` also
  fails closed (`authorized=false`, empty planned values, both rollback strings
  retained, reason `us_cutover.ownership_not_paired_<reason>`) whenever the
  *current* `stagedAllowlist` and `m8Exclude` are not already **exact paired**
  (same length, same keys, same order, no blank/duplicate entries). A mis-paired
  input would produce non-byte-identical planned strings, so it is never planned.
  The precondition lives in the pure shared helper
  `lib/cloudflare/ingest-stages/paired-ownership.ts` (`evaluateOwnershipPairing`)
  and is used identically by `planGermanyCutover`.

## 3. Automated invariant + focused tests

- `scripts/check.ts` gains an invariant asserting the US guard keeps
  `US_CUTOVER_GATES`, `planUsCutover`, `manualPublicationAuthorization`,
  `legacy_historical_counts_rejected`, and the fail-closed `if (!readiness.ready)`
  branch that emits no paired mutation. `pnpm check` passes.
- `tests/us-cutover-readiness.test.ts` (9/9): null/empty/partial fail closed;
  each gate individually blocks; full proof yields the exact paired values; no
  duplication; rollback captured; missing manual authorization blocks with the
  named reason; legacy-historical-counts-only proof is rejected.
- New scripts: `pnpm test:us-cutover`, `pnpm test:p2-m4-us`.

## 4. Read-only US Production audit (viable)

New `scripts/audit-worldcons-p2-m4-us.ts` (`pnpm audit:p2-m4-us`): SELECT-only
Production D1, bounded, plus an optional `--r2` single-object existence/hash
check (read-only `r2 object get`; never put/delete). It reports legacy counts
explicitly labelled **not proof**.

Observed 2026-10-13 (KST), production read-only:

| Query | Result |
| --- | --- |
| `us_official_pdf_article` (articles with `officialPdf.r2Key`) | **0 rows** |
| `us_candidate_snapshot` | 2 rows: `26a308_pok0.pdf`, `26a388_q86b.pdf`, both `retrying`, `PDF_TEXT_EXTRACTION_UNAVAILABLE`, `attempt_count=11`, last attempt 2026-09-30 |
| `us_legacy_counts_not_proof` | Core `us-scotus` articles **136**, P3 published **136** |
| `us_legacy_search_count_not_proof` | Search docs **136** |
| ownership | `usM8Owned=true`, `usNotStaged=true`, `pairedExact=true` |
| `--r2` | not run (no article with `officialPdf.r2Key` exists, so there is nothing to fetch) |

Interpretation: **0** Production articles carry `officialPdf` provenance; the
two known real candidates are still the pre-P2-1-fix `retrying` projectors,
past the deferring backoff window and outside the 14-day primary window. The
136/136/136 trio is the same legacy count recorded in P2-M2 and is **not** P2-M4
evidence. The R2 check cannot be run because no Production `officialPdf` key
exists yet.

## 5. Safe authenticated single-case US canary - assessment (no unsafe endpoint)

A bounded single-case US staged canary would need a runtime entrypoint that
seeds exactly one `us-scotus` discovery job without widening the staged
allowlist and without duplicating M8 ownership. **No safe runtime entrypoint
currently exists:**

- `runIngestStageDiscoveryBootstrap` only seeds sources from
  `resolveIngestBootstrapSources(WORLDCONS_INGEST_STAGE_SOURCE_ALLOWLIST, ...)`.
  `us-scotus` is not in that allowlist, and widening it would open the **entire**
  US source to staged ownership (the exact thing the cutover gate forbids).
- `stagedE2EOptionsFromEnvironment` hard-restricts staged E2E sources to FR/ES
  and throws `e2e.staged_configuration_incomplete` otherwise.
- There is no authenticated "seed one stage job" route; the only admin ingest
  route enqueues a generic admin job, not a single staged source job.
- The remaining option would be a direct Production D1 `ingest_stage_jobs`
  insert, which is explicitly prohibited (no direct Production D1 writes).

Therefore, per instruction, **no unsafe endpoint was created and no E2E was
fabricated**. The exact blocker is recorded in section 7. The audit test
(`tests/p2-m4-us-readiness.test.ts`) asserts the SELECT-only/bounded contract,
the R2 key-shape guard, paired ownership, and fail-closed readiness so that no
unauthorized queue/D1 write or auto-publish can be introduced by this work.

## 6. Exact paired allowlist / exclude values (planned, NOT applied)

Current live values in `workers/async-pipeline/wrangler.jsonc`:

```
"M8_CRAWLER_SOURCE_EXCLUDE": "fr-conseil-constitutionnel,es-tribunal-constitucional",
"WORLDCONS_INGEST_STAGE_SOURCE_ALLOWLIST": "fr-conseil-constitutionnel,es-tribunal-constitucional",
"M8_ENABLED_KINDS": "... (unchanged; no M8 kind disabled) ...",
```

**If and only if all nine gates are genuinely observed**, the cutover would set
both values together to:

```
"M8_CRAWLER_SOURCE_EXCLUDE": "fr-conseil-constitutionnel,es-tribunal-constitucional,us-scotus",
"WORLDCONS_INGEST_STAGE_SOURCE_ALLOWLIST": "fr-conseil-constitutionnel,es-tribunal-constitucional,us-scotus",
```

- The two values must always be **byte-identical** (paired change).
- `M8_ENABLED_KINDS` stays unchanged; only `crawler-daily` source coverage
  narrows.
- **Rollback** = restore both values to
  `fr-conseil-constitutionnel,es-tribunal-constitucional` in the same deploy.
  D1/Queues are untouched by either direction.

These exact strings are produced by `planUsCutover` and covered by tests; the
guard emits **no mutation** until the proof is complete.

## 7. Exact blockers (must not be marked closed)

1. **No newly collected official US PDF in Production.** 0 articles carry
   `officialPdf`; the 2 candidates remain `PDF_TEXT_EXTRACTION_UNAVAILABLE`
   `retrying` at attempt 11. The P2-M1 extractor fix is deployed but only helps
   candidates that are *discovered and fetched*; these rows are past the
   deferring backoff and outside the 14-day window, so routine eligibility does
   not reselect them. No DB write/redrive/replay was performed to bypass this.
2. **No US seven-stage Production E2E.** `us-scotus` is not staged; no
   `ingest_stage_jobs` row exists for it.
3. **No manual publication authorization evidence.** US policy holds every new
   opinion at `publishable=false`/`review.required=true`; a cutover requires an
   explicit manual authorization that does not yet exist.
4. **Historical-only Core/P3/Search counts (136/136/136).** Explicitly not fresh
   E2E proof and explicitly rejected by the guard.
5. **No safe runtime canary entrypoint.** Seeding one US staged job is only
   possible via a disallowed Production D1 insert or by opening the whole US
   staged allowlist. → no canary performed.
6. **Ownership intentionally unchanged.** US stays M8-owned; FR/ES stay staged.
   No paired allowlist/exclude change was made.

## 8. Focused verification executed (bounded)

| Command | Result |
| --- | --- |
| `pnpm test:us-cutover` (new) | **9/9 pass** |
| `pnpm test:p2-m4-us` (new) | **5/5 pass** |
| `pnpm test:native-crawler` | **35/35 pass** |
| `pnpm test:m8` | **48/48 pass** |
| `pnpm test:ingest-stages` | **58/58 pass** |
| `pnpm test:m2-readiness` | **3/3 pass** |
| `pnpm test:germany-cutover` | **6/6 pass** |
| `pnpm check` | **All checks passed** |
| `pnpm typecheck` | **pass, 0 errors** |
| `pnpm m8:typecheck` | **pass** |
| `pnpm exec eslint <changed files>` | **0 errors, 0 warnings** |
| `git diff --check` | clean |
| `pnpm audit:p2-m4-us` | read-only Production audit (see section 4) |

Deliberately **not** run: full `verify:release`, `m8:types:check` (known Windows
hang / pre-existing clean-HEAD failure). No deploy, no commit, no Codex/Orca.

## 9. Engineering implementation vs operational cutover (DISTINCT)

- **P2-M3 (Germany) engineering implementation:** the fail-closed guard/planner,
  tests, invariant and URL-identity hardening are complete and committed
  (`60ef9bb`, `95c7bdd`). **P2-M3 operational cutover:** GATED/BLOCKED.
- **P2-M4 (United States) engineering implementation:** the US fail-closed
  guard/planner, focused tests, invariant and read-only audit are complete (this
  session, uncommitted). **P2-M4 operational cutover:** GATED/BLOCKED.
- Neither milestone's administrative completion authorizes the other country's
  real ownership switchover. P0 three checks and P1 one monitoring item remain
  open.

## 10. Follow-up minimal path to clear P2-M4

1. Obtain a genuinely **newly collected** official SCOTUS PDF: an eligible
   in-window opinion (or an operator-bounded fetch) that actually runs
   `crawlNativeStageCandidate` and persists `officialPdf` to R2 + Core while
   keeping `publishable=false` / `review.required=true`.
2. Record an explicit **manual** publication authorization for that exact case
   (US policy disallows automatic).
3. Run one bounded US staged E2E (or equivalent bounded, non-allowlist-widening
   action) and observe P3 + Search for the SAME case lineage.
4. Feed the observed facts into `planUsCutover`; only a full-proof plan
   authorizes the paired allowlist/exclude change in one deploy.
5. Re-verify with `pnpm audit:p2-m4-us` (read-only) and rollback strings from
   section 6.

Until steps 1-3 produce genuine Production evidence, **P2-M4 remains BLOCKED and
the US stays M8-owned.**
