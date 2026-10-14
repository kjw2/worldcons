# WorldCons P2-M3 — Germany (BVerfG) staged-cutover preflight / blocker audit — 2026-10-13 (KST)

> **P2-M3 status: GATED / BLOCKED. No production cutover.**
> This document records a bounded, read-only attempt to reach the P2-M3 Germany
> cutover gate. The gate was **not** met. No allowlist/exclude value was changed,
> no Worker was deployed, no Production row was written, and no German source
> ownership was transferred. P2-M3 is **not** complete and must not be reported
> as complete.

## 0. Session facts (ground truth)

- Repo: `F:\dev\worldcons`, branch `main`, base commit **`13cfeca`** (`docs(worldcons): close P2-M1 and M2 milestones with evidence gates`), clean at start.
- Working tree at start: exactly one reported dirty path,
  `workers/async-pipeline/worker-configuration.d.ts`, attributable to the earlier
  canceled `m8:types:check`. It was a **stale index stat only**: the working-tree
  blob (`6e12cd5df279ace8decd4a5aa579090926478661`) is byte-identical to the HEAD
  blob. It was reverted/refreshed with no content change; there were no user edits
  to preserve.
- Model route: Hive DeepSeek 4.1 Flash (this session). **No Codex. No Orca.**
- Production-only; Cloudflare D1/R2 read-only; no `INSERT`/`UPDATE`/`DELETE`; no
  forced publish; official-host requests bounded (see §4). BVerfG `Crawl-delay: 30`
  was **not** bypassed.
- DE/US ownership unchanged (M8-owned). FR/ES remain staged. The paired
  `WORLDCONS_INGEST_STAGE_SOURCE_ALLOWLIST` / `M8_CRAWLER_SOURCE_EXCLUDE` values in
  `workers/async-pipeline/wrangler.jsonc` were **not** touched.
- The prior Hive run for this task was terminated after ~11 minutes with no output;
  exact session resume is unsupported, so this is a fresh bounded re-run. It remains
  local: no Worker deploy, no remote write.

## 1. Requirement being tested (P2-M3 entrance gate)

From `docs/worldcons-p2-m1-m2-acceptance-20261013.md:8` and the P2 roadmap, the
Germany staged-cutover entrance requires a **genuine newly fetched official
ECLI/body**, verified backoff effectiveness, and a **verified per-case
Discovery→Search seven-stage Production E2E** for `de-bverfg`, *before* the staged
source allowlist and the legacy M8 crawler exclusion are changed together.

`docs/worldcons-p1-…` roadmap line and `progress.md` already state
**DE/US staged cutover NOT READY**; this audit re-confirms it against current
Production and adds a fail-closed code guard.

## 2. What was attempted (bounded)

1. Read the current code path and confirmed the gate wiring exists and is honest:
   - `lib/cloudflare/ingest-stages/flags.ts` — master switch + production-env +
     valid stage allowlist, all fail-closed.
   - `lib/cloudflare/async-pipeline/crawler-source-ownership.ts` — paired
     exclude/exclude semantics.
   - `workers/async-pipeline/src/native-crawler.ts` — German candidate selection,
     `bverfgCandidateLookupUrls`, official ECLI identity verification
     (`crawler.bverfg_official_identity_mismatch`), branded retry code
     `BVERFG_OFFICIAL_VARIANTS_404`, and D1-aware backoff.
   - `lib/ingest/bverfg-candidate-retry.ts` — the bounded backoff schedule.
2. Classified the known Production state from the already-gathered evidence
   (no new external probe required to confirm it): the German candidate set is
   dominated by unresolved official-URL variants.
3. **Official listing probe — NOT USEFUL (PASS as a negative fact):** the live
   official listing `https://www.bundesverfassungsgericht.de/DE/Entscheidungen/entscheidungen_node.html`
   returns HTTP 200 but exposes **zero** direct ruling hyperlinks (client-side JS
   search form). It cannot be used to derive newly published official decision
   URLs, and the official site advertises `Crawl-delay: 30`. This is a **structural
   discovery limitation**, not a transient failure.
4. Examined the specific candidate `2 BvR 1702/26`
   (`rk20260917_2bvr170226.html`): Production shows `BVERFG_OFFICIAL_VARIANTS_404`
   `retrying` at high `attempt_count`. The remaining 8 German candidates are the
   same class. A third-party ECLI index hit is **not** an official body and was not
   treated as verified.

## 3. Gate matrix (strict verdicts)

`PASS` = observed this session; `FAIL` = contradicted; `NOT_OBSERVED` = not proven
(must not be reported as passed). Production acceptance would require a real
operator/Publish path, which was **not** executed.

| # | Gate | Verdict | Basis |
| --- | --- | --- | --- |
| G1 | New German candidate discovered | **PARTIAL** | Historical candidates exist; latest M8 run previously `discovered=1, fetched=0`. No *new* official candidate proven. |
| G2 | Official ECLI/body fetched from official BVerfG host | **NOT_OBSERVED** | Candidate `2 BvR 1702/26` and the other 8 remain official-URL 404/timeout. Official listing gives no direct links. |
| G3 | Official final-URL ECLI identity exactly matches discovered ECLI | **NOT_OBSERVED** | Nothing was fetched, so no identity comparison could run. `9fa36e2` gate exists in code. |
| G4 | Seven-stage Discovery→Search Production E2E for one German article | **NOT_OBSERVED** | No German staged job exists; `de-bverfg` is M8-owned and not staged. |
| G5 | Core verified official source text + summary/translation | **PASS (historical)** / **NOT_OBSERVED (new)** | 1430 Core rows recorded verified, but these are pre-existing rows, not a newly verified official ECLI. |
| G6 | Immutable P3 `published` version | **PASS (historical count 583)** | Not a fresh German E2E publication. |
| G7 | Search projection + FTS row | **PASS (historical count 582 eligible)** | Counts only; no fresh German E2E row. |
| G8 | 404 backoff implemented and selecting deferred candidates | **PASS (implemented)** | `4b384be` + `lib/ingest/bverfg-candidate-retry.ts`; honest `BVERFG_CANDIDATES_DEFERRED_BACKOFF`. |
| G9 | German staged ownership switchover authorized | **FAIL / BLOCKED** | All new-E2E gates above are `NOT_OBSERVED`. |
| G10 | Paired allowlist/exclude changed | **FAIL (not changed)** | Config still `fr-conseil-constitutionnel,es-tribunal-constitucional` for both. |

**P2-M3 overall: GATED / BLOCKED.** G4–G7 are backed only by *historical* counts,
which the M2 acceptance document explicitly records as **not** proof of a verified
official number (`docs/worldcons-p2-m1-m2-acceptance-20261013.md:109,147`).

## 4. Official ECLI probe discipline

- The official German listing yields no direct ruling URLs and advertises a 30s
  crawl delay. Any external request beyond the single listing fetch was avoided;
  no aggressive retry loop was issued.
- Third-party ECLI indexes were **not** accepted as official identity. A
  third-party hit only tells us a decision exists; it cannot satisfy G2/G3.

## 5. Old M8 backoff (unchanged, honest)

`lib/ingest/bverfg-candidate-retry.ts` (`bverfgCandidateRetryDelayMs`):

| attempt_count | delay for `variants-404` |
| --- | --- |
| < 3 | 12h |
| >= 3 | 1 day |
| >= 6 | 2 days |
| >= 10 | **3 days** |

`BVERFG_RETRY_SCHEDULE_GRACE_MS = 6h`; `shouldRetryBverfgCandidates` defers a
`retrying` candidate until `delay - grace` has elapsed. `2 BvR 1702/26` is well past
`attempt_count >= 10`, so it is deferred ~3 days and will not force a fetch on the
next M8 run. Backoff is working as designed; the blocker is the **absence of any
publishable official URL**, not a missing backoff.

## 6. Exact paired allowlist / exclude values (planned, NOT applied)

Current live values in `workers/async-pipeline/wrangler.jsonc`:

```
"M8_CRAWLER_SOURCE_EXCLUDE": "fr-conseil-constitutionnel,es-tribunal-constitucional",
"WORLDCONS_INGEST_STAGE_SOURCE_ALLOWLIST": "fr-conseil-constitutionnel,es-tribunal-constitucional",
"M8_ENABLED_KINDS": "... (unchanged; no M8 kind disabled) ...",
```

**If and only if all of G1–G7 are genuinely observed**, the cutover would set both
values together to:

```
"M8_CRAWLER_SOURCE_EXCLUDE": "fr-conseil-constitutionnel,es-tribunal-constitucional,de-bverfg",
"WORLDCONS_INGEST_STAGE_SOURCE_ALLOWLIST": "fr-conseil-constitutionnel,es-tribunal-constitucional,de-bverfg",
```

- The two values must always be **byte-identical** (paired change).
- `M8_ENABLED_KINDS` stays unchanged; only `crawler-daily` source coverage narrows.
- **Rollback** = restore both values to
  `fr-conseil-constitutionnel,es-tribunal-constitucional` in the same deploy.
  D1/Queues are untouched by either direction.

These exact strings are produced by the new guard (`planGermanyCutover`) and are
covered by tests; the guard emits **no mutation** until the proof is complete.

## 7. Automated fail-closed readiness guard (added this session)

- `lib/cloudflare/ingest-stages/germany-cutover-readiness.ts` — pure,
  runtime-neutral evaluator. `evaluateGermanyCutoverReadiness` fails closed for any
  missing/false gate; `planGermanyCutover` returns `authorized=false` and empty
  planned values unless every gate is explicitly `true`, and it always captures the
  exact rollback strings. A `germany_cutover.<gate>_not_observed` reason names the
  first blocker.
- **Stronger ownership precondition (2026-10-13 P2-M4 follow-up).** In addition to
  the proof gates, `planGermanyCutover` requires the *current* staged allowlist and
  M8 exclusion to already be **exact paired** (same length, same keys, same order,
  no blank/duplicate entries). A mis-paired input would produce non-byte-identical
  planned strings, so it fails closed with `authorized=false`, empty planned values,
  both rollback strings retained, and reason
  `germany_cutover.ownership_not_paired_<reason>`. The precondition is the pure
  shared helper `lib/cloudflare/ingest-stages/paired-ownership.ts`
  (`evaluateOwnershipPairing`), used identically by the US `planUsCutover`.
- `tests/germany-cutover-readiness.test.ts` (6/6) — null/empty/partial proof fails
  closed; each gate individually blocks; full proof yields the exact paired values;
  no duplication; rollback captured.
- `scripts/check.ts` — invariant asserting the guard module keeps a fail-closed
  `if (!readiness.ready)` branch that emits no paired mutation. `pnpm check` passes.
- New script: `pnpm test:germany-cutover`.
- This guard provides a **tested, fail-closed planning function** for a future operator cutover workflow. It is **not yet wired into the production deploy command** and does not independently prevent an operator from manually editing Wrangler configuration. The Production switchover remains prohibited until the real evidence above is obtained and the cutover procedure invokes the guard.

## 8. Focused verification executed (bounded)

| Command | Result |
| --- | --- |
| `pnpm test:germany-cutover` (new) | **6/6 pass** |
| `pnpm test:m2-readiness` | **3/3 pass** |
| `pnpm test:m8` | **48/48 pass** |
| `pnpm check` | **All checks passed** |
| `pnpm exec eslint <changed files>` | **0 errors, 0 warnings** |
| `git diff --check` | clean (whitespace only) |

Deliberately **not** run: full `verify:release` and `m8:types:check` (known
Windows hang / pre-existing failure at clean HEAD). No local Codex/Orca invoked. No
Worker deployed.

## 9. Exact blockers (must not be marked closed)

1. **No newly fetched official German ECLI/body.** `2 BvR 1702/26` and the other 8
   candidates remain `BVERFG_OFFICIAL_VARIANTS_404`; the official listing exposes
   no direct ruling links. → G2/G3 unmeetable from current official sources.
2. **No German seven-stage Production E2E.** `de-bverfg` is not staged; no
   `ingest_stage_jobs` row exists for it. → G4 `NOT_OBSERVED`.
3. **Historical-only Core/P3/Search counts.** 1430 Core / 583 P3 / 582 eligible
   Search are pre-existing legacy rows, not fresh E2E evidence. → G5–G7 unmoved.
4. **Ownership intentionally unchanged.** DE stays M8-owned; FR/ES stay staged. No
   paired allowlist/exclude change was made.

## 10. Follow-up minimal path to clear P2-M3

1. Obtain at least one **real official BVerfG decision URL** whose body is publicly
   reachable (not a JS-only search form), e.g. via the official RSS/decision archive
   or an operator-supplied `SharedDocs/Entscheidungen/...` link.
2. Fetch it through `crawlNativeStageCandidate`; require `officialHost`,
   `crawler.bverfg_official_identity_mismatch` = false, and text >= 200 chars.
3. Run one bounded staged E2E for that single German article
   (bootstrap limit 1, dispatch limit 1), observing all seven stages plus
   Core/P3/Search rows.
4. Feed the observed facts into `planGermanyCutover`; only a full-proof plan
   authorizes the paired allowlist/exclude change in one deploy.
5. Re-verify with `pnpm audit:m2-readiness` (read-only) and rollback strings from §6.

Until steps 1–4 produce genuine Production evidence, **P2-M3 remains BLOCKED and
Germany stays M8-owned.**

## 11. Continuation - official German URL identity hardening + sitemap/search evidence (2026-10-13)

Base commit for this continuation: **`60ef9bb`** (the section 7 guard is already
committed). Bounded, read-only; no ownership change, no deploy, no Production
write, and no change to `M8_CRAWLER_SOURCE_EXCLUDE`,
`WORLDCONS_INGEST_STAGE_SOURCE_ALLOWLIST`, or `M8_ENABLED_KINDS`.

Note: this section is intentionally ASCII-only. An earlier edit round-trip
corrupted the whole document's UTF-8 (arrows/dashes became `??`); the file was
restored byte-for-byte from HEAD before this clean append.

### 11.1 Official search discovery - NOT USABLE (structural, robot-enforced)

The official indexed search endpoint lives under `/SiteGlobals/`. The live
official `robots.txt` (fetched HTTP 200) contains:

```
Disallow: /SiteGlobals/
Allow: /SiteGlobals/Modules/
Allow: /SiteGlobals/StyleBundles/
Allow: /SiteGlobals/Frontend/
Crawl-delay: 30
Sitemap: https://www.bundesverfassungsgericht.de/Sitemap_Index.xml
```

The `Entscheidungssuche` search path is therefore robots-disallowed, so the
crawler must not fetch it. The search index is not an official fetch and its
snippets can never be equated with verified official source text. The generic
listing `DE/Entscheidungen/entscheidungen_node.html` returns HTTP 200 with zero
static decision links. Verdict: **NOT_OBSERVED / NOT_USABLE**.

### 11.2 Official sitemap - NO decision links (robots-allowed, factual negative)

The robots-allowed sitemap was inspected directly (single request per file,
`Crawl-delay: 30` respected):

| URL | Status | Bytes | `<loc>` count | Decision (`SharedDocs/Entscheidungen/.../[a-z]{2}\d{8}_...`) links |
| --- | --- | --- | --- | --- |
| `Sitemap_Index.xml` | 200 | 298 | 1 (child sitemap) | 0 |
| `Sitemap_Basepage.xml` | 200 | 57924 | 242 | **0** |

`Sitemap_Basepage.xml` lists only 242 non-decision pages (press, media, service,
`AusgewaehlteNeueingaenge`), every `<lastmod>` is `2024-02-26`, and **zero** URLs
match the official `SharedDocs/Entscheidungen` decision pattern. The sitemap is
therefore **not** a usable recent-decision-discovery source. Per the task's
instruction ("if sitemap lacks decisions or inaccessible, document factual
result, do NOT add a speculative endpoint"), **no sitemap discovery code was
added**. This is a factual negative, not a transient failure.

### 11.3 Official decision detail pages - GET-observable (raw HTTP only)

Read-only probes with the project UA and `Crawl-delay: 30`:

| Official URL | Status | Bytes | Body ECLI |
| --- | --- | --- | --- |
| `.../SharedDocs/Entscheidungen/DE/2026/09/rk20260905_2bvr135824.html?nn=68112` | 200 | 105981 | `ECLI:DE:BVerfG:2026:rk20260905.2bvr135824` |
| `.../SharedDocs/Entscheidungen/DE/2026/05/rs20260521_2bvr109622` (extensionless) | 200 | 282892 | `ECLI:DE:BVerfG:2026:rs20260521.2bvr109622` |

Both forms are real official identities; the optional `.html` extension and the
`?nn=` query suffix are cosmetic and never change the ECLI. This is **raw HTTP
observation only** - it was NOT performed through `crawlNativeStageCandidate`, so
it does not by itself satisfy G2/G3 (official-fetch E2E). It validates the
URL-identity contract the crawler enforces.

### 11.4 Bounded code changes (local, uncommitted)

`workers/async-pipeline/src/native-crawler.ts`:

1. `bverfgDecisionIdentity` parses the path stem, tolerating an optional
   `.html`/`.htm` extension and any query suffix, while still rejecting a
   mismatched path-vs-date identity. `verifyBverfgOfficialText` keeps the exact
   ECLI-in-body match against that identity.
2. `discoverBverfg` accepts **extensionless** official decision links in addition
   to `.html`.
3. **Fail-closed discovery flag:** an official-listing link now starts with
   `collection.sourceUrlVerified: false`; it becomes `true` only after the crawl
   stage fetches the URL and matches the exact in-body ECLI
   (`acceptBverfgOfficialVerification`). A discovery-only candidate that is never
   fetched can no longer be treated as URL-verified downstream (manual/automatic
   approval and publication gates require `sourceUrlVerified === true`).

Unchanged: exact ECLI-in-body match, official HTTPS host check, identity-mismatch
rejection, >=200 substantive chars, robots handling with `Crawl-delay: 30`,
bounded retry/backoff, and all publication safeguards.

### 11.5 Focused mocked regressions (`tests/native-crawler.test.ts`, 31 -> 35)

- Extensionless and `.html` official links are discovered, and discovery keeps
  `sourceUrlVerified: false`; a zero-link / JS-only page yields an honest empty
  set.
- Extensionless official URL verifies (fetch flips `sourceUrlVerified` true),
  including a query-suffixed final URL.
- Mismatched body ECLI and mismatched final-URL identity are rejected.
- 404 (and 403 without browser fallback) official pages are rejected without a
  fabricated fetch and without flipping `sourceUrlVerified`.

### 11.6 Single-case bounded canary assessment

A one-source, one-item German staged canary is shape-compatible with the existing
staged APIs without changing ownership (the same `limit 1` / dispatch-limit-1
contract France/Spain use, with manual approval and the fail-closed
`planGermanyCutover` guard preserved, and no direct D1 mutation). It is **not
authorized now**: the staged source allowlist is `fr`/`es` only, the in-project
verified official fetch and seven-stage E2E are unproven, and discovery of a new
candidate is unresolved (official search robots-disallowed; generic listing zero
links; sitemap zero decision links; OpenLegalData/seed fallbacks 404). A future
canary must be an explicit, separately-approved staged action, not a DE-wide
switch.

### 11.7 Verification (bounded, this continuation)

| Command | Result |
| --- | --- |
| `pnpm test:native-crawler` | 35/35 pass |
| `pnpm test:germany-cutover` | 6/6 pass |
| `pnpm test:m2-readiness` | 3/3 pass |
| `pnpm test:m8` | 48/48 pass |
| `pnpm check` | All checks passed |
| `pnpm m8:typecheck` | pass |
| `pnpm exec eslint <changed files>` | 0 errors (2 pre-existing warnings, untouched lines) |
| `git diff --check` | clean |

Deliberately not run: full `verify:release`, `m8:types:check` (known Windows hang
/ pre-existing clean-HEAD failure). No deploy, no Codex/Orca.

### 11.8 Remaining blockers (unchanged; must not be closed)

1. No in-project verified official German ECLI/body (raw HTTP 200 observed for two
   known detail URLs, but not through the crawler): G2/G3 stay NOT_OBSERVED.
2. No German seven-stage Production E2E: `de-bverfg` is not staged.
3. New-candidate discovery blocked: official search robots-disallowed; generic
   listing zero links; sitemap zero decision links; third-party fallbacks 404.
4. Ownership intentionally unchanged: DE stays M8-owned; FR/ES stay staged.

**P2-M3 overall: GATED / BLOCKED.** P0 three checks and P1 one monitoring item
remain open.

## 12. Follow-up deployment evidence - code-only Worker release, NO cutover (2026-10-13)

Section 11 describes the prior bounded code investigation, at which point no
Worker had been deployed. Subsequently, the verified four-file patch was
committed and pushed as `95c7bddb0cb71b6cef49815215c9a654153f5ca7`.
Wrangler `deploy --dry-run` succeeded with the unchanged configuration; the
Production `worldcons-ingest` Worker was then deployed at 2026-10-13
07:51:14 UTC as version `c8195b21-a8f7-4d25-b355-80725c016583` (100%).
The previous release was `fca447ec-850c-4e20-8a76-3bb97ac03676`.

Post-deploy `GET https://worldcons-ingest.cclib.workers.dev/health`
returned success with M8 effective crawler sources exactly
`de-bverfg,us-scotus`, M8 excluded sources exactly `fr,es`, and staged
bootstrap sources exactly `fr,es` (full canonical source keys in Wrangler);
both staged limits stayed at 1. No allowlist/exclusion/approval policy changed.
No direct D1 write, owner transfer, unreviewed publication or German staged
job was initiated.

This is a **code-only Production release**, **not** the P2-M3 staged
cutover. The official in-project verified fetch and one-case seven-stage
Core/P3/Search lineage remain **NOT_OBSERVED**; the six-gate cutover
planner cannot authorize Germany yet. P2-M3 stays **GATED / BLOCKED**,
with all P0 three checks and P1 one check open.

## 13. Independent Production lineage re-verification + paired-cutover blocker (2026-10-14)

Session facts (ASCII-only section). Worktree `C:\Users\jaeth\.devspace\worktrees\worldcons-ae313381`,
detached HEAD `57764bb58a3e9b535307e5275362ea900fbccea1`, GitHub `main` = `57764bb`.
Model route: Hive DeepSeek 4.1 Flash. No Codex/Orca. No push/deploy. No direct
Production D1 writes. Unrelated `next-env.d.ts` working-tree change preserved.

### 13.1 Real Production DE 7/7 lineage independently re-verified (READ-ONLY)

`pnpm audit:canary-lineage -- --job 00ad35bc-505e-4b27-9700-37b53acecee4 --source de-bverfg`
(exact UUID) returned exit 0 and confirmed, from the live Production databases only:

- `lineage.sevenStageComplete = true`, `stagedChainComplete = true`,
  `missingStages = []`, `nativeCoreRelation = "resolved"`,
  `officialIdentityVerified = true`.
- Core UUID `82f4cd73-1d0c-457f-9a2b-a23fa3cc5012`, `source_key=de-bverfg`,
  `status=summarized`, `translation_status=translated`,
  `collection_publishable=1`, `collection_source_url_verified=1`, canonical URL
  `https://www.bundesverfassungsgericht.de/SharedDocs/Entscheidungen/DE/2026/09/rk20260923_2bvr168126.html?nn=68112`.
- `publication.classification = "staged_publication"`; P3 `state=published`,
  `revision=1`, `version_id=003b2bf4-997b-5a2d-a581-ac5a49c0f947`,
  `published_at=2026-10-14T04:08:49.487Z`.
- `searchProjection.verified = true`, `documentsObserved = true`,
  `ftsObserved = true`, `sameArticle = true`, `documentRowid = 17427`,
  `ftsRowid = 17427`, `rowidMatch = true`, `publicationState = "published"`.
- The starting discovery job row (read from `worldcons_ingest`) has
  `payload_ref = "stages/canary/de-bverfg/<canaryId>.json"`, i.e. it is the
  explicit **canary-prefixed** discover-one path, not the ordinary staged
  bootstrap.

So every `GermanyCutoverProof` gate has genuine same-case Production evidence
today: `official_ecli_fetched`, `ecli_identity_exact`, `seven_stage_e2e`,
`core_verified_content`, `p3_published`, `search_projected` all true.

### 13.2 DECISIVE BLOCKER: a paired Wrangler change cannot be made this session

The task constrains the ONLY allowed edits to the two Wrangler vars
(`M8_CRAWLER_SOURCE_EXCLUDE` and `WORLDCONS_INGEST_STAGE_SOURCE_ALLOWLIST`) to a
byte-identical paired append of `de-bverfg`, while preserving everything else,
and requires `pnpm test:m8` and `pnpm test:ingest-stages` to pass. These two
requirements are mutually exclusive at HEAD `57764bb`:

- `tests/m8-crawler-source-ownership.test.ts:76-83` asserts the exact current
  values (`fr-conseil-constitutionnel,es-tribunal-constitucional`), that
  `owner.excluded` equals the staged list, and that
  `owner.effective == ["de-bverfg","us-scotus"]`.
- `tests/ingest-stage-pipeline.test.ts:600` asserts
  `WORLDCONS_INGEST_STAGE_SOURCE_ALLOWLIST == "fr-conseil-constitutionnel,es-tribunal-constitucional"`.

Empirically, with the proposed paired append applied **only** to
`workers/async-pipeline/wrangler.jsonc`, `pnpm test:m8` and
`pnpm test:ingest-stages` both FAIL (assertion: actual
`...-constitucional,de-bverfg` vs expected `...-constitucional`). Those tests
encode the ownership invariant; they were reverted immediately, and the Wrangler
file is byte-identical to HEAD.

Making the append pass those tests would require editing them (and the
`owner.effective` expectation) in the same patch. The task permits ONLY the two
Wrangler vars, so that edit is out of scope. Per the task rule ("If risk found
leave paired Wrangler values unchanged, report reason"), the paired values are
left UNCHANGED.

### 13.3 Additional independent reasons the ordinary staged path is not ready

Even setting the test conflict aside, activating `de-bverfg` via the ordinary
staged bootstrap is not a safe cutover at HEAD, because the following are
hard-restricted to FR/ES and were NOT widened by this session:

- `workers/async-pipeline/src/staged-e2e.ts:43` rejects any staged E2E source
  other than FR/ES (`e2e.staged_configuration_incomplete`).
- `workers/async-pipeline/src/discovery-coverage-scheduled.ts:13` throws
  `discovery.sources_invalid` for any non-FR/ES source.
- `WORLDCONS_E2E_STAGED_SOURCES` still names only FR/ES.

The verified 7/7 was produced by the explicit canary path
(`stages/canary/...`), which is intentionally a controlled exception and does
NOT prove the ordinary FR/ES-style staged bootstrap would behave the same for a
DE-wide source. A correct DE cutover therefore needs a coordinated change to
those hard-coded restrictions plus the paired allowlist, not a two-line append.

### 13.4 Safe additive change made (fail-closed evidence check)

To satisfy the task's "never infer 7/7 from aggregate counts; require same-case
linked audit evidence" safely, and mirroring the already-committed US P2-M4
guard, this session added an additive, fail-closed rule (no config change):

- `lib/cloudflare/ingest-stages/germany-cutover-readiness.ts` now exposes
  `GERMANY_LEGACY_HISTORICAL_FIELDS` and rejects a proof dominated by legacy
  historical counts (`coreArticles`/`publishedP3`/`searchEligible`/`discovered`/
  `fetched`) that carries no explicit boolean gate, with
  `germany_cutover.legacy_historical_counts_rejected` as the first blocker. The
  planner still emits no mutation in that case.
- `tests/germany-cutover-readiness.test.ts` gained a test for the counts-only
  rejection (now 10/10).
- `scripts/check.ts` invariant now also requires the guard to contain
  `legacy_historical_counts_rejected`.

### 13.5 Verification executed (unchanged config)

| Command | Result |
| --- | --- |
| `pnpm test:germany-cutover` | 10/10 pass |
| `pnpm test:canary` | 37/37 pass |
| `pnpm test:m8` | 48/48 pass |
| `pnpm test:ingest-stages` | 58/58 pass |
| `pnpm check` | All checks passed |
| `pnpm typecheck` | pass (0 errors) |
| `pnpm m8:typecheck` | pass |
| `pnpm m8:dry-run` (Wrangler dry-run) | success; vars show unchanged FR/ES ownership |
| `git diff --check` | clean |

### 13.6 Readiness + rollback (final operational, pending controller deploy/verify)

- **Readiness:** Germany's *evidence* gate is genuinely satisfied, but the
  *engineering* cutover at this HEAD is not implementable under the two-line
  paired constraint (13.2) and the ordinary staged path still hard-restricts
  DE (13.3). Status: **GATED / BLOCKED for an in-scope paired change; DE stays
  M8-owned; FR/ES stay staged.**
- **Rollback (unchanged; for the eventual authorized cutover):** restore both
  vars to `fr-conseil-constitutionnel,es-tribunal-constitucional` in the same
  deploy. D1/Queues are untouched either direction. Exact planned strings (from
  `planGermanyCutover`) would be
  `fr-conseil-constitutionnel,es-tribunal-constitucional,de-bverfg` for both.
- **Post-deploy health checks the controller must run (NOT run by agent):**
  effective M8 crawler sources exactly `us-scotus` (DE removed, FR/ES excluded),
  excluded sources include FR, ES, DE; staged bootstrap sources FR, ES, DE;
  both staged limits 1; stage processing validated per case. USA M8 ownership
  must remain unchanged and is NOT switched.

### 13.7 Open checks (must not be marked closed)

1. The paired-vars change conflicts with committed ownership contract tests at
   this HEAD; a correct cutover must move the tests and the FR/ES-only hard
   restrictions (13.2, 13.3) in one coordinated, separately-approved patch.
2. The ordinary staged bootstrap path for DE was never run in Production; only
   the explicit canary path produced 7/7.
3. P0 three checks and P1 one monitoring item remain open; US is not switched.

## 14. Follow-up: coordinated Germany ownership patch (2026-10-14)

This section **supersedes the provisional no-cutover conclusion in section 13**,
which was based on a two-config-lines-only change and tests hard-coded to the
old ownership. Independent review established that the two source lists have
different responsibilities:

- `WORLDCONS_INGEST_STAGE_SOURCE_ALLOWLIST` and
  `M8_CRAWLER_SOURCE_EXCLUDE` move **crawler ownership** together.
- `WORLDCONS_E2E_STAGED_SOURCES` is a **separate automatic E2E approval
  cohort** and remains strictly FR/ES. The FR/ES-only checks in
  `staged-e2e.ts` and `discovery-coverage-scheduled.ts` use this separate
  setting and do **not** prohibit German ordinary staged bootstrap.
  Germany uses the standard guarded non-E2E publish/search handlers, never
  the protected FR/ES automatic approval path.

The coordinated patch atomically sets both ownership values to
`fr-conseil-constitutionnel,es-tribunal-constitucional,de-bverfg`
in `workers/async-pipeline/wrangler.jsonc`, adjusts two ownership contract
tests to reflect **DE staged, US M8**, and adds a fail-closed Germany
historical-aggregate-count guard. It does **not** modify the US source,
`M8_ENABLED_KINDS`, protected E2E approval cohort, or review rules.

Tests independently rerun before deployment: `test:m8` 48/48,
`test:ingest-stages` 58/58, `test:canary` 37/37,
`test:germany-cutover` 10/10, `pnpm check`, `pnpm typecheck`,
`pnpm m8:typecheck`, Wrangler deploy dry-run, and `git diff --check`
all pass. This is an **ownership configuration change**, not independent
proof that the ordinary scheduled DE path has already completed a new
seven-stage Production case.

Rollback is a paired **single deployment** restoring both owner values to
`fr-conseil-constitutionnel,es-tribunal-constitucional`. Do not roll back
only one value. Preserve the genuine already-verified 2026-10-14 DE 7/7
canary as immutable evidence and do not mix it with any later normal
bootstrap run. P0/P1 open checks and the US manual-review gate are unchanged.
