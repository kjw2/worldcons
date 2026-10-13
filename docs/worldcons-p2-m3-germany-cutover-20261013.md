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
