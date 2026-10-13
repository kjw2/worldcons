# WorldCons P2-M1 · P2-M2 Acceptance — 2026-10-13 (KST)

## Administrative milestone closure (2026-10-13)

At the user's direction, **P2-M1 = COMPLETED** (extractor repair, genuine official-PDF probe, tests, production Worker deploy) and **P2-M2 = COMPLETED** (readiness audit, country-level gate matrix, tests and evidence). These labels close the *delivered work packages*, **not** the unobserved Production acceptance criteria below. Preserve each original `NOT_OBSERVED` verdict. Germany/US staged cutover is still **NOT READY** and is **not authorized** by this administrative closure.

- Carry forward to P2-M4 entrance: US real-case Production PDF original in R2 + Core `officialPdf` provenance and no auto-publication.
- Carry forward to P2-M3 entrance: DE genuine newly fetched official ECLI/body, backoff effectiveness and verified per-case processing.
- Carry forward to P2-M3/M4: verify country-specific end-to-end pipeline evidence before pairing staged allowlist and legacy M8 exclusion.
- Do not alter the independent P0 three checks or P1 remaining operational check.

Strict verdicts only. `PASS` = evidence observed in this session; `FAIL` = contradicted by evidence; `NOT_OBSERVED` = not proven (must not be reported as passed). Production acceptance requires a real operator/Publish path, which was **not** executed here.

- Repo: `F:\dev\worldcons`, branch `main`, base commit `116e27e` (clean at start).
- Model route: Hive DeepSeek 4.1 Flash (this session). **No Codex. No Orca.**
- Production-only; Cloudflare D1/R2 read-only (`SELECT`/aggregate only); no `INSERT`/`UPDATE`/`DELETE`; no forced automated publish; robots respected; 30s BVerfG crawl delay not bypassed.
- DE/US ownership unchanged (M8-owned); FR/ES remain staged; allowlist/exclude untouched.
- P0-3 / P1-1 closure tracking not modified.

---

## P2-M1 — SCOTUS official PDF ingestion validation

### 1. Root-cause diagnosis (what actually blocks `PDF_TEXT_EXTRACTION_UNAVAILABLE`)

Production `worldcons_ingest.source_url_candidates` (indexed SELECT, `WHERE source_key='us-scotus'`) returns **exactly 2** rows:

| url | status | attempt_count | last_error_code | last_attempt_at |
| --- | --- | --- | --- | --- |
| `https://www.supremecourt.gov/opinions/25pdf/26a308_pok0.pdf` | retrying | 11 | `PDF_TEXT_EXTRACTION_UNAVAILABLE` | 2026-09-30T21:01:45.560Z |
| `https://www.supremecourt.gov/opinions/25pdf/26a388_q86b.pdf` | retrying | 11 | `PDF_TEXT_EXTRACTION_UNAVAILABLE` | 2026-09-30T21:01:45.001Z |

Docket shapes: `26A308`, `26A388` — **application dockets (letter `A`, no hyphen)**.

Distinguishing the candidate causes:

| Hypothesis | Verdict | Evidence |
| --- | --- | --- |
| 2026 prior-term date/revision filtering misses eligible opinions | **FAIL (not the cause)** | Real `GET /opinions/slipopinion/25` returns 74 PDF rows; `26A388`/`26A308` are dated 9/25/26 (within the 14-day primary window in late September). Term-rollover scan (`42ee7e3`) is already an ancestor of `main`. |
| robots / redirect / docket-listing gate blocks | **FAIL (not the cause)** | `robots.txt` 200, `User-agent:*` allowed except `/images/ /rss/ /cdn/`, `Crawl-delay:1`; our bot is permitted. Real `GET`s returned 200 with `application/pdf` at the final official URL. |
| PDF extractor actually fails on valid official PDFs | **PASS (the cause)** | `normalizeDocket()` accepted only `^\d{1,3}-\d{1,6}$`, so a letter docket `26A388` threw `scotus.docket_unverified`; the PDF-header matcher also required `Nos?.\d+-\d+`, so even an accepted letter docket hit `scotus.pdf_docket_mismatch`. The native-crawler maps any non-fetch to `PDF_TEXT_EXTRACTION_UNAVAILABLE` (`native-crawler.ts:1249`). |

Direct reproduction against the **real official PDF**: `extractOfficialScotusPdf(26a388_q86b.pdf, "26A388")` returned `scotus.docket_unverified` before the fix, and `OK pages: 5 chars: 8623` after. Plain cert dockets (`24-43`) extracted both before and after (77 pages).

### 2. Fix

`workers/async-pipeline/src/scotus-pdf.ts`:
- `normalizeDocket()` now also accepts official application dockets `^\d{1,3}[A-Z]\d{1,6}$` (uppercased), keeping the hyphenated cert form.
- The in-PDF docket matcher now accepts an optional letter and optional hyphen (`26A388`, `24-43`, `141, Orig.` remains unverified) and normalizes before comparison, so a letter docket can never cross-match a hyphenated one.

No change to `publishable=false`, review gate, R2 provenance, or ownership. Review-required remains: the verified candidate is still `needs_review` with `collection.publishable=false`.

### 3. Real-origin, Worker-compatible integration (no Production write)

`scripts/scotus-official-pdf-probe.ts` runs the **actual production path** (`crawlNativeStageCandidate` → `fetchScotusPdf` robots/redirect/MIME/size checks → `extractOfficialScotusPdf`) against genuine `supremecourt.gov` PDFs using a temporary **in-memory R2 bucket**. It performs no Production D1/R2 write and no publication.

| URL | HTTP | bytes | sig | pages | chars | sha256 | docketVerified | r2 original | publishable | review |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `.../25pdf/26a388_q86b.pdf` | 200 | 63361 | `%PDF-1.6` | 5 | 8623 | `73ef64de152e4dc257baa83767b75eb19fe6aea473be8688b61644c0741afd2e` | true | written, sha matches | false | required |
| `.../25pdf/26a308_pok0.pdf` | 200 | — | `%PDF-` | 19 | 36135 | `9f401c171e16498100bb2bd3962bba4cca37803e3b941b78d03f6f9d5c3fe45a` | true | written, sha matches | false | required |
| `.../25pdf/24-43_2b35.pdf` (control) | 200 | 383173 | `%PDF-` | 77 | 154353 | `43a1a329994be812c65f8b6f6bfd8c78f746b893b1ae3357510c603d44842fca` | true | written, sha matches | false | required |

R2 key format `artifacts/scotus_pdf/<sha256>.pdf`; extracted text begins with the official slip-opinion header (`SUPREME COURT OF THE UNITED STATES / No. 26A388`).

### 4. P2-M1 acceptance verdicts

| Criterion | Verdict | Basis |
| --- | --- | --- |
| Real (not mocked) official PDF from `supremecourt.gov` with PDF signature | **PASS** | Real-origin probe, 3 official PDFs, `%PDF-` signatures |
| Official final URL + 200 + official `application/pdf` | **PASS** | Probe `finalUrl` equals requested official URL; production fetch path enforced redirect/MIME/host |
| Docket verified against PDF body text | **PASS** (application + cert dockets) | Probe `docketVerified=true` for `26A388`, `26A308`, `24-43` |
| Extraction text quality bounded | **PASS** | 8,623 / 36,135 / 154,353 chars, within 800–1,000,000 bounds |
| SHA-256 hash of original + R2 original object | **PASS (in-memory bucket)** | Probe wrote original bytes to R2-compatible map; stored sha == provenance sha |
| Core provenance `source_metadata.officialPdf` linkage | **PASS (unit/db harness)** | `tests/native-crawler.test.ts` persists and re-reads `officialPdf.r2Key`/`sha256` |
| Production R2 original + Core provenance written for a real case | **NOT_OBSERVED** | No operator/bounded run performed; Production still `official_pdf=0` for `us-scotus` (see M2). Reported as the true blocker, not claimed. |
| US production end-to-end (M8 fetch → Core → non-public) | **NOT_OBSERVED** | Latest Production `us-scotus` runs `discovered=0/fetched=0` (see M2); no eligible in-window candidate was processed |
| `publishable=false` / review required preserved | **PASS** | Probe + tests; no P3 insert |
| No invented case / no robots bypass / no direct DB write | **PASS** | Robots honored; D1 read-only; no insert/update |

**P2-M1 overall: code fix + real-origin integration PASS; Production R2/Core E2E NOT_OBSERVED (blocked by unprocessed candidates, not by extractor any longer).**

---

## P2-M2 — Germany/US staged-readiness matrix (actual production data)

Source: `pnpm audit:m2-readiness` (`scripts/audit-worldcons-m2-readiness.ts`), read-only production D1 aggregates + code-native ownership resolver. Raw output is reproducible from that command.

### Ownership (code-native, unchanged)

`NATIVE_CRAWLER_SOURCES = [de-bverfg, us-scotus, fr-conseil-constitutionnel, es-tribunal-constitucional]`.
`M8_CRAWLER_SOURCE_EXCLUDE = fr-conseil-constitutionnel,es-tribunal-constitucional`; `policyEffective = [de-bverfg, us-scotus]`; staged allowlist = FR+ES.
`pairedExact=true`, `deUsM8Owned=true`, `deUsNotStaged=true`. **No allowlist/exclude change made.**

### Production D1 readiness matrix

| Criterion | `de-bverfg` | `us-scotus` | Verdict |
| --- | --- | --- | --- |
| Official URL + identity | Core `collection.sourceUrlVerified=1`: **1430/1430** | **136/136** | **PASS** (recorded) — but see caveat below |
| Official source-text | `collection.sourceTextAvailable=1`: **1430/1430** | **136/136** | **PASS** (recorded) |
| Official-number identity (docket PDF vs ECLI) | BVerfG ECLI gate exists (`9fa36e2`); latest candidate `2 BvR 1702/26` still `BVERFG_OFFICIAL_VARIANTS_404` | SCOTUS docket verified against PDF **only via real-origin probe**, never recorded in Production | **PARTIAL / NOT_OBSERVED in Production** |
| Normalize/Translate | `cleaned` 847 (`pending`), `summarized` 583 (`translated`) | `summarized` 136 (`translated`) | **PASS** (exists) |
| Review gate / private states | 296 carry `review_state=summarized`; 1430 remain `publishable` | 12 `review_state=summarized`; 136 `publishable` | **PASS (gate exists)**; state hygiene needs review |
| Publisher / P3 | `published_p3`: **583** | **136** | **PASS** (published) |
| Search identity | `search_documents`: **582** | **136** | **PASS for eligible counts**; DE P3 published 583 but the exact Search eligibility predicate yields 582 (intentional Catalog duplicate exclusion). Full ID-set/fingerprint equality was not checked in this audit. |
| Staged ownership switchover readiness | M8-owned, 9 candidates `retrying` `BVERFG_OFFICIAL_VARIANTS_404` (latest 2026-10-11), latest run 2026-10-12 `discovered=0` `BVERFG_CANDIDATES_DEFERRED_BACKOFF` | M8-owned, 2 candidates `retrying` `PDF_TEXT_EXTRACTION_UNAVAILABLE`, latest run 2026-10-12 `discovered=0/fetched=0` | **NOT READY** — not switched |
| 404 cooldown / backoff | present (`4b384be`), selecting deferred candidates | `revisionDate` 90-day recheck path present | **PASS (implemented)** |
| Warnings | `BVERFG_CANDIDATES_DEFERRED_BACKOFF` (honest degraded) | `PDF_TEXT_EXTRACTION_UNAVAILABLE` (now fixed in extractor) | **PASS (honest)** |

Caveat recorded deliberately: `collection.publishable=1` for **100%** of DE/US is a **historical legacy marker** (pre-P2-1 metadata), not evidence of an independently verified official number; the P2 roadmap’s “US `publishable=false` / review required” applies to **newly collected** PDF articles via the P2-1 path, which is coded but not yet exercised in Production. No publishable flag was changed.

### P2-M2 acceptance verdicts

| # | Criterion | Verdict |
| --- | --- | --- |
| 1 | Official URL + ECLI(docket) identity gate present in code | **PASS** |
| 2 | Actual Production DE/US official-number verification per case | **NOT_OBSERVED** |
| 3 | Normalize/Translate stage readiness (real counts) | **PASS** |
| 4 | Review gates block unverified metadata (false-publish prevention) | **PASS** (`tests/ingest-stage-handlers.test.ts` L/N) |
| 5 | Eligible Publisher/Search count reconciliation | **PASS for counts**: DE 582 eligible/582 Search; US 136/136. Exact ID-set and content fingerprints remain **NOT_OBSERVED**. |
| 6 | Staged ownership switchover readiness (DE/US) | **FAIL / NOT READY** — remain M8-owned |
| 7 | 404 cooldown/backoff | **PASS (implemented)** |
| 8 | Warnings honest (no false success) | **PASS** |
| 9 | Allowlist/exclude unchanged (FR/ES staged, DE/US M8) | **PASS** |

---

## Tests / checks executed this session

| Command | Result |
| --- | --- |
| `pnpm test:native-crawler` | **31/31 pass** (2 new application-docket tests) |
| `pnpm test:m8` | **48/48 pass** |
| `pnpm test:ingest-stages` | **58/58 pass** |
| `pnpm test:ingest-workflow` | **16/16 pass** |
| `pnpm test:m2-readiness` (new) | **3/3 pass** |
| `pnpm check` | **All checks passed** |
| `pnpm typecheck` (`tsc --noEmit`) | **pass, 0 errors** |
| `pnpm lint` | **0 errors** (20 pre-existing warnings) |
| `pnpm m8:typecheck` | **pass** |
| `pnpm m8:dry-run` | **pass** (Wrangler bundle OK) |
| `pnpm m8:types:check` | **FAIL at clean HEAD `116e27e`** — pre-existing, unrelated (`worker-configuration.d.ts out of date`; also has a Windows wrangler crash tail) |
| `pnpm chore(e2e)`-style deploymentRef coupling | **NOT_REQUIRED** — `WORLDCONS_E2E_DEPLOYMENT_REF` is verifier-only; my change does not alter E2E proof or pins |

## Residual / blockers (must not be marked closed)

1. Production still has **0** `officialPdf` provenance for `us-scotus`; the two real candidates are unprocessed. Completing P2-M1 Production E2E requires the P2-M1 extractor fix to be deployed **and** those candidates drained. **Critical nuance:** the P2-1 letter-docket fix only helps candidates that are *discovered and fetched*. The two Production rows are already `retrying` at `attempt_count=11` (>=10 in the prior 3-day window), so routine eligibility **defers** them; and the newest slip opinions are all applications (`26A…`) dated `9/25/26`, now **older than 14 days**, so the daily primary window no longer selects them. The code fix is necessary but not sufficient to force a Production E2E on its own, and no DB write/redrive/replay was performed to bypass this. No DB write was performed.
2. DE/US must **not** switch to staged ownership until per-case official-number verification is real in Production for both.
3. `m8:types:check` is broken at clean HEAD independent of this change.
4. DE P3 has 583 published, but the exact `ELIGIBLE_PUBLISHED_PREDICATE` from `lib/cloudflare/search-projection/d1-sync.ts` yields **582 eligible**, matching **582 Search documents**. The one-case difference is the existing intentional Catalog de-duplication gate, **not a demonstrated projection gap**. This query was independently rerun against Production Core D1 on 2026-10-13. Exact eligible/Search article-ID set and stored-content fingerprint equality remain **NOT_OBSERVED**; counts alone cannot prove these.

## Artifacts / commits

- Commit `ebbb410` (`fix(worldcons): verify SCOTUS application-docket official PDFs and add P2-M2 readiness audit`), pushed to `origin/main` (`116e27e..ebbb410`).
- `workers/async-pipeline/src/scotus-pdf.ts` — application/letter docket support.
- `tests/native-crawler.test.ts` — 2 regression tests (31/31).
- `scripts/scotus-official-pdf-probe.ts` + `probe:scotus-pdf` — real-origin probe.
- `scripts/audit-worldcons-m2-readiness.ts` + `audit:m2-readiness` — read-only readiness matrix.
- `tests/m2-readiness-diagnostic.test.ts` + `test:m2-readiness` — SELECT-only/ownership guard tests.
- Deployment evidence: `artifacts/p2-m1-m2-deploy-20261013/` (`pre-deploy-version.txt`, `deploy-async.stdout.log`, `deployment.json`).

## Deployment (affected Worker only)

- `worldcons-ingest`: `75d574e0-98dd-46c5-875a-5c47dbe5fc1f` → **`fca447ec-850c-4e20-8a76-3bb97ac03676`** (100%), 2026-10-13T06:34:55Z, via `wrangler deploy --config workers/async-pipeline/wrangler.jsonc`.
- Binding pins coherent: `WORLDCONS_E2E_DEPLOYMENT_REF` unchanged (`git:401b3e4…;worldcons:a1571934…`), root `worldcons` Worker unchanged, `M8_CRAWLER_SOURCE_EXCLUDE` unchanged. `/health` HTTP 200 with `effectiveSources=["de-bverfg","us-scotus"]`.
- Root `worldcons` Worker **not** redeployed (no root change); no preview/staging created.
