# WorldCons P2-M3/P2-M4 operator single-case staged canary + verified official-document ingest — 2026-10-13 (KST)

> **Status: engineering implementation delivered; NO ownership cutover, NO deploy,
> NO Production write performed by this session.** This document records a
> bounded, runtime-neutral implementation of a *safe, authenticated, operator-
> initiated single-case canary* for Germany (`de-bverfg`) and the United States
> (`us-scotus`), plus read-only lineage/policy assertions. It does not claim a
> Production E2E occurred; it reports exactly what was built and what remains
> blocked. The country ownership switchovers remain **GATED / BLOCKED**.

## 0. Session facts (ground truth)

- Repo: isolated DevSpace worktree, base HEAD **`6580df5`**
  (`docs(worldcons): close M3 and M4 engineering together without claiming cutover`), clean at start.
- Model route: Hive DeepSeek 4.1 Flash (this session). **No Codex. No Orca.**
- Production D1/R2 **read only from the audit script only**; this session ran no
  Production query. No `INSERT`/`UPDATE`/`DELETE` against Production. No Worker
  deploy. No commit/push (controller reviews).
- `M8_CRAWLER_SOURCE_EXCLUDE` / `WORLDCONS_INGEST_STAGE_SOURCE_ALLOWLIST` /
  `M8_ENABLED_KINDS` in `workers/async-pipeline/wrangler.jsonc` were **not touched**.
  The Wrangler config is unchanged.
- No robots bypass, no third-party index treated as official, no fabricated
  ECLI/docket, no forced US auto-publish, no test-derived success claim.

## 1. The problem this session solves

Before P2-M3/P2-M4 the only ways to obtain a per-case seven-stage Production
lineage for a non-staged country were:

1. a direct Production D1 `ingest_stage_jobs` insert (explicitly prohibited), or
2. widening `WORLDCONS_INGEST_STAGE_SOURCE_ALLOWLIST` (which opens the **whole**
   source to staged ownership — the exact thing the cutover gate forbids).

Neither is acceptable. This session adds a **third, safe path**: a bounded,
authenticated, operator-initiated canary that seeds exactly one case as an
*explicit controlled exception* while preserving the broad ownership split.

## 2. What was implemented (all local, uncommitted)

### 2.1 Runtime-neutral official-source identity contract (fixture-free)

New `lib/ingest/official-source-verify.ts` (pure, no `@/` alias, no Node
builtins, no network/DB):

- `isOfficialHost(sourceKey, url)` — HTTPS + exact official host/subdomain.
- `bverfgDecisionIdentity(url)` — parses the official `SharedDocs/Entscheidungen`
  path to `{ecli, decisionId, publishedAt}`, tolerating optional `.html`/`.htm`
  and any query suffix while rejecting a mismatched path-vs-date identity.
- `extractBverfgEcliFromBody(text)` / `verifyBverfgOfficialText(body, final, discovered)`
  — the exact in-body ECLI equality contract.
- `isOfficialScotusPdfUrl(url)`, `scotusPdfIdentity(url)`, `normalizeScotusDocket`,
  `scotusBodyDocketMatches(body, docket)` — the SCOTUS PDF URL/docket contracts.

`workers/async-pipeline/src/native-crawler.ts` and `scotus-pdf.ts` now **delegate
to and re-export** these, so the crawler and the canary enforce byte-identical
identity rules. Behavior is unchanged (native-crawler 35/35, m8 48/48).

### 2.2 Fenced single-job claim/dispatch (bounded)

`lib/cloudflare/ingest-stages/repository.ts` `claimIngestStageJobs` and
`dispatcher.ts` `dispatchIngestStagePass` gained an **optional `jobId`** that
narrows the existing indexed, claimable-only SELECT to exactly one row. It is
still stage-scoped and fence-checked, so it can never reach another stage or a
job another owner legitimately holds. Absent parameter = unchanged behavior.

### 2.3 Operator single-case canary module

New `lib/cloudflare/ingest-stages/canary.ts` (pure/runtime-neutral, relative
imports only):

- `planCanaryCase(request, {now})` — deterministic, fail-closed planner. Rejects
  any source other than `de-bverfg`/`us-scotus` (`denied_source`), any non-
  official host (`denied_official_host`), and any missing/mismatched operator
  identifier (`denied_identity`: German ECLI must equal the URL-derived ECLI; US
  docket must normalize). Emits a candidate with `collection.publishable=false`
  and `sourceUrlVerified=false` and **no self-marked review**, so a canary can
  never auto-publish.
- `seedCanaryCase(...)` — enforces **max 1 canary per source per rolling 24h**
  (`denied_rate_limited`), persists the candidate under the explicit
  `stages/canary/<sourceKey>/<canaryId>.json` prefix, registers exactly one
  `crawl` job with a deterministic idempotency key, and writes an **immutable**
  audit row for **every** attempt accepted or denied.
- `dispatchCanaryCase(...)` — leases only the named job under the explicit
  `canary-owner:<canaryId>` identity via the audited dispatcher.
- `canarySourceGateAllows({stage, sourceKey, payloadRef, stagedSources})` — the
  per-source gate used by the consumer at the **official-fetch entry stages**
  (`discovery`, `crawl`): a non-staged source is allowed **only** when its
  payload carries the explicit `stages/canary/` prefix. Downstream stages act on
  already-fetched data and never re-fetch an official host.
- `advanceCanaryCase(...)` — **optional** bounded next-stage advance. It refuses
  unless the named job is `succeeded`, `claimed_by='canary-owner:<canaryId>'`, has
  a durable `job_stage_advanced` event linking the next job, and that next job's
  `source_key` is the canary source. It never fabricates a transition, completes/
  fails a job, or publishes; it only appends an audit entry. Scheduled 15-minute
  transitions remain the normal path.

### 2.4 Consumer per-source gate (fail-closed)

`workers/async-pipeline/src/ingest-stage-consumer.ts` gained an optional
`sourceGate`. When wired, a live discovery/crawl job for a non-authorized source
is **dead-lettered before any handler runs** (`ingest_stage.source_not_authorized`),
so an accidental future widening cannot silently pull `de-bverfg`/`us-scotus`
through the normal path. `workers/async-pipeline/src/index.ts` wires it to
`canarySourceGateAllows` with the configured staged allowlist.

### 2.5 Canary artifact carry-through (no new approval authority)

`ingest-stage-handlers.ts` uses `carriesApprovalArtifact(sourceKey)` to carry the
candidate/crawl artifact references across stages for FR/ES staged E2E **plus**
the explicit `canarySources`. The **auto-approval / staged publish / staged
search branches remain strictly `deps.e2e.sources` (FR/ES only)**, so a US canary
can never be auto-approved: it ends honestly blocked at public judgment
(`ingest_stage.public_judgment_not_publishable`). This is the required honest
outcome.

### 2.6 Immutable audit ledger (additive migration)

New `d1/worldcons_ingest/0006_ingest_stage_canary.sql`: append-only
`ingest_stage_canary_records_v1` (no authority; records canary_id, source_key,
candidate_id, canonical_url, identity_ecli/docket, job_id, outcome, operator_id,
deployment_ref, detail, created_at) with `@d1-verify` markers and additive-only
indexes. The migration runner auto-discovers `d1/**/*.sql`; the job row/fence
ledger remains the sole source of truth.

### 2.7 Authenticated operator route (dedicated secret only)

New `workers/async-pipeline/src/worker-auth.ts` (`operatorCanaryAuthorized`,
constant-time over SHA-256) and `workers/async-pipeline/src/stage-canary-route.ts`
(`POST /v1/stage-canary`). The route uses a **dedicated optional Worker Secret,
`WORLDCONS_CANARY_TOKEN`** — **not** `BROWSER_RUN_TOKEN`.

Correction to an earlier draft: a live `wrangler secret list --name
worldcons-ingest` returned `[]`, so `BROWSER_RUN_TOKEN` **does not exist** in the
deployed `worldcons-ingest` Worker (the browser transport is invoked over the
service binding, not a secret). This implementation therefore does not assume any
pre-existing secret:

- If `WORLDCONS_CANARY_TOKEN` is unset, the route returns **401** and no endpoint
  is exposed (fail closed). The operator must provision the token explicitly.
- Comparison is constant-time. A matching `BROWSER_RUN_TOKEN` is irrelevant and
  cannot authorize the canary; provisioning the canary token never activates the
  unrelated `/v1/navigate` path.

The route validates the official host/identity, enforces the per-source gate, and
never changes ownership or publishes. `index.ts` wires the route.

### 2.8 Read-only lineage + manual-policy audit

New `scripts/audit-worldcons-canary-lineage.ts` (`pnpm audit:canary-lineage`):
SELECT-only, bounded, indexed Production reads that report the observed stage
lineage for a given article/job, the canary audit rows, Core `officialPdf`
provenance, P3 publication state, and the automatic approval ledger.

Honesty rules (corrected after review):

- A stage is **verified only when a durable `ingest_stage_jobs` row for that
  exact stage has `status='succeeded'`**. Mere presence is never success.
- The canary is **crawl-first by design** and does not create a `discovery` job,
  so `sevenStageComplete` can never be true for a canary; `discovery` is reported
  as `discoveryNotExecutedByCanary`. This is a **lower-scope single-case control,
  NOT proof of the literal Discovery->Search seven-stage criterion**.
- A crawl job's `article_id` is a `native:` candidate hash, while `normalize` and
  later stages use the real core UUID. A query filtered only by the core UUID
  cannot observe crawl (and vice versa). When both identities cannot be resolved
  from observed rows (or the normalize `job_stage_advanced` event), the relation
  is reported `unresolved` and the missing side stays **NOT_OBSERVED**.
- `e2e_approval_evidence_v1` is the **automatic** FR/ES staged approval ledger,
  **not** a US manual publication authorization. It is never counted as manual
  consent: `manualAuthorizationPresent` is **always** reported `false`/unproven.
- Search/FTS same-case proof is reported unobserved unless an explicit
  `search_documents` row for the resolved case identity is observed.

`assertSelectOnly` rejects any non-SELECT statement. Tests cover a blocked stage,
the native/UUID split, and the "automatic ledger is not manual consent" rule.

## 3. What is explicitly NOT claimed

- **No Production canary was executed.** No row was written to Production D1/R2
  by this session; the route is implemented and tested but not deployed.
- **No seven-stage Production E2E was observed, and this canary cannot produce
  one.** The canary is **crawl-first by design** (it seeds a `crawl` job, not a
  `discovery` job), so it **cannot meet the original literal Discovery->Search
  seven-stage criterion**. It is a lower-scope, single-case control intended to
  obtain a real per-case official-fetch + normalize lineage before a broad
  cutover; it is **not** cutover proof. A future cutover still requires the
  separate genuine Discovery->Search lineage the cutover guards demand.
- **US cannot complete 7/7 without separately approved case review.** A US canary
  holds `publishable=false` / manual review, blocks at public judgment, and has no
  manual publication authorization.
- **No cutover gate was advanced.** `planGermanyCutover`/`planUsCutover` remain
  fail-closed; all evidence gates stay `NOT_OBSERVED`.
- **No manual publication authorization exists** for any US case.

## 4. Official-source evidence used (read-only, no robots bypass)

The task supplied two real official German detail URLs (HTTP 200 on the website,
`ECLI:DE:BVerfG:2026:rk20260905.2bvr135824` and
`...rk20260901.2bvr128625`) and the previously-M1-verified US PDF
`https://www.supremecourt.gov/opinions/25pdf/26a388_q86b.pdf` (docket `26A388`).
These are used **only** as identity fixtures in tests, never as a claim of an
in-project verified crawler fetch. The canary's crawl stage performs the real
official GET and the exact in-body ECLI/docket verification; a mismatching body
is rejected. `robots.txt` `Crawl-delay: 30` and the `/SiteGlobals/` disallow are
respected unchanged.

## 5. Focused verification executed (bounded, local)

| Command | Result |
| --- | --- |
| `pnpm test:canary` (new) | **14/14 pass** |
| `pnpm test:ingest-stages` | **58/58 pass** |
| `pnpm test:native-crawler` | **35/35 pass** |
| `pnpm test:m8` | **48/48 pass** |
| `pnpm test:germany-cutover` | **9/9 pass** |
| `pnpm test:us-cutover` | **12/12 pass** |
| `pnpm test:m2-readiness` | **3/3 pass** |
| `pnpm test:p2-m4-us` | **5/5 pass** |
| `pnpm check` | **All checks passed** |
| `pnpm typecheck` | **pass, 0 errors** |
| `pnpm m8:typecheck` | **pass** |
| `pnpm exec eslint <changed files>` | **0 errors** (2 pre-existing native-crawler warnings) |
| `git diff --check` | clean |

Deliberately **not** run: full `verify:release`, `m8:types:check` (known Windows
hang / pre-existing clean-HEAD failure). No deploy, no Production write, no
commit/push, no Codex/Orca.

## 6. Exact operator invocation (once reviewed/deployed)

The route requires a **dedicated secret `WORLDCONS_CANARY_TOKEN`** that the
operator must provision; there is **no unauthenticated endpoint** and the route
returns **401** until the token is set. The secret value must never appear in Git
or command output.

Provision (operator, output shows only the name):

```
pnpm exec wrangler secret put WORLDCONS_CANARY_TOKEN --name worldcons-ingest
# paste the token at the prompt; do not echo it
```

Then invoke (PowerShell; the token is read from the operator's own secure store):

```
# The value is supplied out-of-band and NEVER printed or committed.
$token = Read-Host -Prompt 'WORLDCONS_CANARY_TOKEN' -AsSecureString
$plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
  [Runtime.InteropServices.Marshal]::SecureStringToBSTR($token))
Invoke-RestMethod -Method Post `
  -Uri "https://worldcons-ingest.cclib.workers.dev/v1/stage-canary" `
  -Headers @{ Authorization = "Bearer $plain" } `
  -ContentType "application/json" `
  -Body '{"sourceKey":"de-bverfg","candidateUrl":"https://www.bundesverfassungsgericht.de/SharedDocs/Entscheidungen/DE/2026/09/rk20260905_2bvr135824.html?nn=68112","ecli":"ECLI:DE:BVerfG:2026:rk20260905.2bvr135824","operatorId":"ops:reviewer","dispatch":true}'
```

US example (expect an honest public-judgment block — that is correct):

```
-Body '{"sourceKey":"us-scotus","candidateUrl":"https://www.supremecourt.gov/opinions/25pdf/26a388_q86b.pdf","docket":"26A388","operatorId":"ops:reviewer","dispatch":true}'
```

### Optional bounded next-stage advance

To avoid waiting 15 minutes between stages, an operator may advance **one**
already-succeeded canary job to its next stage, gated by exact canary provenance
(job `status='succeeded'` AND `claimed_by='canary-owner:<canaryId>'` AND a durable
`job_stage_advanced` event linking a canary next job). It never completes, fails,
publishes or fabricates a transition; scheduled transitions remain the normal path.

```
-Body '{"advance":true,"jobId":"<succeededCanaryJobId>","canaryId":"<canaryId>","operatorId":"ops:reviewer"}'
# returns the next stage/jobId, or a 409 with a named refusal reason
# repeat once per stage using the returned nextJobId
```

Then observe (read-only):

```
pnpm audit:canary-lineage -- --article <coreUuid>
pnpm audit:canary-lineage -- --job <stageJobId>
```

If the dedicated operator secret is unavailable, the route stays fail-closed
(401) and **no** endpoint is exposed; the planner/tests remain usable locally.

## 7. Remaining blockers (must not be marked closed)

1. **No live Production canary executed.** Deploy + operator invocation are a
   separate, explicitly-authorized action; this session did not deploy.
2. **Germany:** no newly-fetched in-project official ECLI/body beyond the raw
   HTTP observation; no German seven-stage Production job. G2/G3/G4 still
   `NOT_OBSERVED`.
3. **United States:** no new Production `officialPdf` row (0 articles), no manual
   publication authorization, and a US canary will honestly block at public
   judgment. The 136/136/136 legacy counts remain non-proof.
4. **Ownership intentionally unchanged.** DE/US stay M8-owned; FR/ES stay staged.
   No paired allowlist/exclude change; no Wrangler edit.
5. **P2-M1 extractor/selection:** the two historical US candidates remain
   `retrying` at attempt 11 and are outside routine reselection; resolving them
   is a separate policy question, not altered here.

## 8. Changed files (local, uncommitted)

New:
- `lib/ingest/official-source-verify.ts`
- `lib/cloudflare/ingest-stages/canary.ts`
- `workers/async-pipeline/src/worker-auth.ts`
- `workers/async-pipeline/src/stage-canary-route.ts`
- `d1/worldcons_ingest/0006_ingest_stage_canary.sql`
- `scripts/audit-worldcons-canary-lineage.ts`
- `tests/ingest-stage-canary.test.ts`
- `docs/worldcons-p2-m3-m4-operator-canary-20261013.md` (this file)

Modified:
- `workers/async-pipeline/src/native-crawler.ts` (delegate shared identity)
- `workers/async-pipeline/src/scotus-pdf.ts` (delegate shared docket/url)
- `workers/async-pipeline/src/ingest-stage-handlers.ts` (`canarySources` carry-through only)
- `workers/async-pipeline/src/ingest-stage-consumer.ts` (per-source gate)
- `workers/async-pipeline/src/index.ts` (route + gate wiring)
- `lib/cloudflare/ingest-stages/repository.ts` (optional bounded single-job claim)
- `lib/cloudflare/ingest-stages/dispatcher.ts` (optional `jobId`)
- `scripts/check.ts` (canary invariants)
- `package.json` (`test:canary`, `audit:canary-lineage`)

## 9. Recommended next legitimate commands (controller)

1. Review this diff; run `pnpm test:canary && pnpm test:ingest-stages && pnpm test:m8 && pnpm test:native-crawler && pnpm check && pnpm typecheck`.
2. Apply the additive `0006` migration to Production **only** as part of an
   approved deploy of `worldcons-ingest`.
3. Deploy `worldcons-ingest` (the route is inert until the secret is used).
4. Execute one authenticated DE canary (dispatch:true); confirm the crawl stage
   fetched the official body and the in-body ECLI matched; observe the lineage
   via `pnpm audit:canary-lineage`.
5. Feed only genuinely observed facts into `planGermanyCutover`/`planUsCutover`.
   Do **not** treat the canary itself as cutover evidence until the guard gates
   are individually satisfied.
6. For US, do not publish: record an explicit manual authorization only if a
   human reviewer actually approves the specific PDF.
