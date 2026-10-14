# WorldCons P2-M3/P2-M4 operator single-case staged canary + verified official-document ingest — 2026-10-13 (KST)

> **Status: a REAL Production operator canary ran for both DE and US; country
> ownership is UNCHANGED (DE/US M8, FR/ES staged).** The DE canary completed all
> six staged stages (Crawl->Search); the US canary reached Crawl+Normalize and
> honestly stopped at a legacy-preserved case. The literal seven-stage
> Discovery->Search criterion is **NOT MET** (the operator canary is crawl-first
> by design and creates no Discovery job), so neither country is a cutover. This
> revision corrects the read-only lineage audit to follow the durable linked chain
> (no fake discovery, no unrelated same-source jobs, native->core identity proof,
> search_documents+search_fts rowid proof, legacy-vs-staged publication
> classification) and records the controller-verified Production facts.
>
> This document was updated by a Hive DeepSeek 4.1 Flash session that performed
> **no Production write, no deploy, no commit/push**.

## 0. Production facts (controller-verified 2026-10-13T11:46Z)

- **Worker:** `worldcons-ingest` version **`ebb08bb9-2172-416b-be5d-3507be608bb7`**,
  main HEAD **`a6d98ca`**; Workflow `worldcons-operator-canary-v1` deployed.
- **DE canary `c121c7d71702d52251f439f7130f91be`** (source `de-bverfg`):
  - Official ECLI `ECLI:DE:BVerfG:2026:rk20260905.2bvr135824`; official text 5,856 chars;
    R2 artifact `stages/ingest-crawl/de-bverfg/734c9d...`.
  - Linked stage jobs, **all six durable `succeeded`**: crawl
    `db44b56c-b5d6-46cf-821f-693c09757f49` -> normalize `fda0fc1a-a366-4cfe-bc36-6967f97a6d10`
    -> translate `62107b51-9227-46ee-ab2c-d14a1a8d218a` -> public-judgment
    `bec0c4a2-6111-49de-b312-1a97379a4d60` -> publish `ee85f533-0417-4eb6-81c5-8513786d8dfe`
    -> search `8a344a70-5d7a-4f27-ac84-04c5e72e5fc4`.
  - Core UUID `a60db8bb-4ec3-4ecf-bb5a-6245f621a334` summarized/translated; P3
    `published` at 11:45:27Z; `worldcons_search.search_documents` article_id same,
    state `published`, **rowid 16847**, and `search_fts` **rowid 16847** same id.
  - **No Discovery job** by design (operator canary starts at Crawl) -> original
    literal 7/7 guard NOT MET.
- **US canary `759ea8a17ce1b8b393e1b3064895f6ba`** (source `us-scotus`):
  - Crawl `ed2f72db-b51e-4ace-852a-4902b4929b53` succeeded; Normalize
    `a205faa2-fc98-4eaf-aec0-72d63d05fad1` succeeded with `registerNext:false`
    because an existing legacy case was **persisted/preserved**; no new
    Translate/PJ/Publish/Search jobs.
  - Official `www.supremecourt.gov/opinions/25pdf/26a388_q86b.pdf` 5 pages, text
    8,623, docket verified; R2 original
    `artifacts/scotus_pdf/73ef64de152e4dc257baa83767b75eb19fe6aea473be8688b61644c0741afd2e.pdf`
    63,361 bytes, SHA-256 independently verified by a separate R2 remote fetch.
  - Existing Core UUID `4b3d5644-2681-449e-8ad5-28ee2defffe8` (canonical exact PDF
    URL), `status=summarized`, `review_state=summarized`, `collection.publishable=true`,
    from 2026-09-26; P3 `published` 2026-09-27; old Search doc published. **Its Core
    metadata lacks `officialPdf` hash/r2Key/docketVerified**, and the 2026-10-13
    Normalize preserved the legacy row as a legitimate safety; there is **no new
    after-stage lineage**. Do NOT infer the old P3 was authorized by present
    approval, and do NOT mutate the old public status without review. No separate
    manual US per-case authorization exists. **P2-M4 ownership remains BLOCKED.**
- Ownership unchanged: M8 effective DE/US, staged FR/ES. No allowlist/exclude change.


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

### 2.7b Operator canary Cloudflare Workflow (administrative auth; no Worker Secret)

New class `WorldconsOperatorCanaryWorkflow extends WorkflowEntrypoint<Env,
OperatorCanaryEvent | string>` in `workers/async-pipeline/src/index.ts`, bound in
`wrangler.jsonc` as `OPERATOR_CANARY_WORKFLOW` (`worldcons-operator-canary-v1`).
It is the primary operator path because it needs **no Worker Secret**: the
operator is authorized by their existing Cloudflare account/OAuth scope through
`wrangler workflows trigger`. New pure contract module
`lib/cloudflare/ingest-stages/canary-workflow-payload.ts`
(`parseOperatorCanaryEvent`) strictly validates the event envelope:

- `sourceKey` restricted to `de-bverfg`/`us-scotus`; any other source rejected;
- `candidateUrl` required and length-bounded; per-source identity required
  (`ecli` for DE, `docket` for US);
- **unknown top-level keys rejected** (`operator_canary.unknown_key:*`) and
  **unknown `mode` rejected** (`operator_canary.mode_not_allowed`); no
  list/limit/paging field is accepted (no unbounded work);
- `operatorId` optional (default `cloudflare-workflow-operator`); `mode` optional
  (default `seed-and-dispatch`, or `seed`).

The run() body reuses exactly the canonical `planCanaryCase` (official identity
gating), `seedCanaryCase` (per-source rate limit + immutable audit + explicit
`stages/canary/` payload) and `dispatchCanaryCase` (fenced single Crawl Queue
dispatch) with the Worker's D1/R2/Queue bindings. Every step is idempotent
(`step.do` name derived from the event identity; the job key is deterministic), so
a retry cannot duplicate the job and the fencing/rate-limit make a re-dispatch a
no-op. It returns only non-secret IDs and enqueue status, never publishes, never
bypasses review, and does not fabricate a seven-stage lineage. A denied plan is
recorded as an immutable audit row and returned honestly (`jobId: null`).

### 2.8 Read-only lineage + manual-policy audit

New `scripts/audit-worldcons-canary-lineage.ts` (`pnpm audit:canary-lineage`):
SELECT-only, bounded, indexed Production reads that follow a canary's **durable
linked chain** and report the stage lineage, Core provenance, P3 publication state,
the automatic approval ledger, and the search projection.

Corrections after review + a controller finding (the earlier version keyed stages
by the Core UUID alone and wrongly reported DE as 4/6 with an unresolved identity
even though all six stages were `succeeded`):

- The audit starts at the original Crawl `--job <uuid>` and walks each stage's
  durable `job_stage_advanced.safe_details.nextKey` (= the next job's
  `idempotency_key`) to the next stage, so **no single identity filter is used and
  no unrelated same-source job can be counted**. The native candidate id (Crawl) and
  the Core UUID (Normalize+) are both observed; the native->core relation is proven
  by the Normalize advance event (`fromArticleId`/`resolvedArticleId`).
- A stage is **verified only when its linked job has `status='succeeded'`**. A
  missing/broken link, a non-succeeded stage, a mixed/foreign `source_key`, a
  duplicate stage, or out-of-canonical-order fails closed with a named reason
  (`chain_stage_not_succeeded`, `chain_mixed_source`, `chain_non_canary_source`,
  `chain_out_of_order`, `chain_stage_duplicate`, `chain_empty`).
- The canary is **crawl-first by design** and creates no `discovery` job, so
  `sevenStageComplete` is only true when a genuine discovery row is present in the
  chain; it is **never back-filled**. The canary reports `six staged stages
  complete` (`stagedChainComplete`) and a literal 7/7 of **false**.
- `search_documents` AND `search_fts` must both exist for the exact same article
  and the same FTS **rowid** (`evaluateSearchProjection`); otherwise unobserved.
- A pre-existing published P3 with no publish stage in THIS chain is reported
  `legacy_published_preexisting` (`classifyPublication`), never a staged
  publication.
- `e2e_approval_evidence_v1` is the **automatic** FR/ES ledger, never US manual
  consent: `manualAuthorizationPresent` is always `false`/unproven.
- If a US Core row lacks `officialPdf`, the audit emits
  `usCoreProvenanceNote: canary_lineage.us_core_provenance_missing_officialPdf`.
- `parseJobId` rejects a malformed/forged `--job` value before any SQL interpolation.
- `assertSelectOnly` rejects any non-SELECT statement.

Unit tests cover the linked-chain verify/fail-closed cases, the native->core split,
search-documents+FTS rowid ambiguity, legacy-vs-staged publication classification,
and the "automatic ledger is not manual consent" rule.

## 3. What is explicitly NOT claimed

- **A real Production canary DID run** for DE and US (facts in §0). What is NOT
  claimed is a **cutover**: the literal seven-stage Discovery->Search criterion is
  **NOT MET** because the operator canary is crawl-first (it seeds a `crawl` job,
  not a `discovery` job). A future cutover still requires the genuine
  Discovery->Search lineage the cutover guards demand.
- **US is NOT a staged publication.** The 2026-10-13 US chain ended at
  Normalize (`registerNext:false`, legacy preserved); its old `published` P3/Search
  are pre-existing legacy and are reported `legacy_published_preexisting`, never
  attributed to this run. Its Core metadata lacks `officialPdf` provenance and
  there is no separate manual US authorization.
- **No cutover gate was advanced.** `planGermanyCutover`/`planUsCutover` remain
  fail-closed; all evidence gates stay `NOT_OBSERVED`.
- **No manual publication authorization exists** for any US case; the automatic
  FR/ES ledger is never treated as US manual consent.

## 4. Official-source evidence (read-only, no robots bypass)

The DE canary fetched the real official BVerfG decision
`ECLI:DE:BVerfG:2026:rk20260905.2bvr135824` (official 5,856 chars; R2
`stages/ingest-crawl/de-bverfg/734c9d...`) with exact in-body ECLI verification.
The US canary fetched the real official `26a388_q86b.pdf` (5 pages, docket
`26A388` verified; R2 original SHA-256 verified). `robots.txt` (`Crawl-delay: 30`)
and the `/SiteGlobals/` disallow are respected unchanged; no third-party index is
treated as official.

## 5. Focused verification executed (bounded, local)

| Command | Result |
| --- | --- |
| `pnpm test:canary` (new) | **24/24 pass** |
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

## 6. Exact operator invocation

There are TWO independent, mutually-redundant operator paths. Both converge on
the same canonical `planCanaryCase` / `seedCanaryCase` / `dispatchCanaryCase`
modules and the same immutable audit ledger; neither changes ownership, publishes
or bypasses review.

### 6A. Cloudflare Workflow (primary; administrative auth, no Worker Secret)

When `wrangler secret put` is unavailable (tooling safety) or no Worker Secret is
provisioned, use the Workflow. Authorization is the operator's existing Cloudflare
account/OAuth scope via `wrangler workflows trigger`; **no Worker Secret value is
ever created, stored or printed**. The Workflow binding is
`OPERATOR_CANARY_WORKFLOW` (`worldcons-operator-canary-v1` →
`WorldconsOperatorCanaryWorkflow`).

Event shape (strict; unknown keys/modes and non-DE/US sources are rejected):

```jsonc
{ "sourceKey": "de-bverfg" | "us-scotus",
  "candidateUrl": "https://<official-host>/...",
  "ecli": "<required for de-bverfg>",
  "docket": "<required for us-scotus>",
  "operatorId": "cloudflare-workflow-operator",   // optional; default used if absent
  "mode": "seed" | "seed-and-dispatch" }           // optional; default seed-and-dispatch
```

Germany (official 2026 decision):

```
pnpm exec wrangler workflows trigger worldcons-operator-canary-v1 `
  --config workers/async-pipeline/wrangler.jsonc `
  --payload '{"sourceKey":"de-bverfg","candidateUrl":"https://www.bundesverfassungsgericht.de/SharedDocs/Entscheidungen/DE/2026/09/rk20260905_2bvr135824.html?nn=68112","ecli":"ECLI:DE:BVerfG:2026:rk20260905.2bvr135824","operatorId":"cloudflare-workflow-operator"}'
```

United States (M1-verified official PDF; expect an honest public-judgment block):

```
pnpm exec wrangler workflows trigger worldcons-operator-canary-v1 `
  --config workers/async-pipeline/wrangler.jsonc `
  --payload '{"sourceKey":"us-scotus","candidateUrl":"https://www.supremecourt.gov/opinions/25pdf/26a388_q86b.pdf","docket":"26A388","operatorId":"cloudflare-workflow-operator"}'
```

Inspect status/output (non-secret IDs and enqueue status only):

```
pnpm exec wrangler workflows instances list worldcons-operator-canary-v1 --config workers/async-pipeline/wrangler.jsonc
pnpm exec wrangler workflows instances describe worldcons-operator-canary-v1 <instanceId> --config workers/async-pipeline/wrangler.jsonc
```

(If the installed wrangler uses a different `workflows` subcommand spelling, use
the `wrangler workflows --help` form; the binding/name/class are what matter.)

### 6B. Authenticated HTTP route (fallback; requires dedicated secret)

The route requires a **dedicated secret `WORLDCONS_CANARY_TOKEN`** that the
operator must provision; there is **no unauthenticated endpoint** and the route
returns **401** until the token is set. The secret value must never appear in Git
or command output. If the secret cannot be provisioned, use §6A instead (leave
this route fail-closed).

```
pnpm exec wrangler secret put WORLDCONS_CANARY_TOKEN --name worldcons-ingest
# paste the token at the prompt; do not echo it
```

Then invoke (PowerShell; the token is read from the operator's own secure store):

```
$token = Read-Host -Prompt 'WORLDCONS_CANARY_TOKEN' -AsSecureString
$plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
  [Runtime.InteropServices.Marshal]::SecureStringToBSTR($token))
Invoke-RestMethod -Method Post `
  -Uri "https://worldcons-ingest.cclib.workers.dev/v1/stage-canary" `
  -Headers @{ Authorization = "Bearer $plain" } `
  -ContentType "application/json" `
  -Body '{"sourceKey":"de-bverfg","candidateUrl":"https://www.bundesverfassungsgericht.de/SharedDocs/Entscheidungen/DE/2026/09/rk20260905_2bvr135824.html?nn=68112","ecli":"ECLI:DE:BVerfG:2026:rk20260905.2bvr135824","operatorId":"ops:reviewer","dispatch":true}'
```

### Optional bounded next-stage advance (Workflow mode `advance`)

To avoid waiting 15 minutes between stages, an operator may advance **one**
already-succeeded canary job to its next stage. This is the SAME Workflow with a
second, strictly discriminated payload shape `{mode:'advance',jobId,canaryId,operatorId?}`
— it carries **no** `sourceKey`/`candidateUrl`/identity, so it can only continue an
already-seeded canary. Provenance is durable: the job must be `status='succeeded'`
AND `claimed_by='canary-owner:<canaryId>'` AND the `job_stage_advanced` event must
link a next job whose `source_key` equals the addressed job's canary source. It
then dispatches exactly that next job to its own per-stage queue (`workerId
canary-owner:<canaryId>`, limit 1, bounded lease). If the scheduled dispatcher
already leased the job, the advance is a clean no-op. It never publishes, bypasses
review, or fabricates a transition; scheduled transitions remain the normal path.

```
# DE example (advance the succeeded crawl job db44b56c-... to normalize)
pnpm exec wrangler workflows trigger worldcons-operator-canary-v1 `
  --config workers/async-pipeline/wrangler.jsonc `
  --payload '{"mode":"advance","jobId":"db44b56c-b5d6-46cf-821f-693c09757f49","canaryId":"c121c7d71702d52251f439f7130f91be","operatorId":"cloudflare-workflow-operator"}'

# US example (advance the succeeded crawl job ed2f72db-... to normalize)
pnpm exec wrangler workflows trigger worldcons-operator-canary-v1 `
  --config workers/async-pipeline/wrangler.jsonc `
  --payload '{"mode":"advance","jobId":"ed2f72db-b51e-4ace-852a-4902b4929b53","canaryId":"759ea8a17ce1b8b393e1b3064895f6ba","operatorId":"cloudflare-workflow-operator"}'
```

The run returns `{fromStage,nextStage,nextJobId,sourceKey,dispatched,enqueued,reason}`.
A denial (`canary.advance_owner_mismatch`, `canary.advance_next_event_missing`,
`canary.advance_next_stage_mismatch`, `canary.advance_next_source_mismatch`,
`canary.advance_terminal_stage`, …) fails the run non-retryably and is retained in
the audit ledger. Repeat once per stage using the returned `nextJobId`. The
`dispatched` audit row is written only AFTER a real enqueue, with the real canary
source (never an optimistic pre-send row).

The HTTP-route equivalent (`POST /v1/stage-canary` with `{"advance":true,...}`)
remains available only when `WORLDCONS_CANARY_TOKEN` is provisioned; use the
Workflow when it is not.

Then observe (read-only):

```
pnpm audit:canary-lineage -- --article <coreUuid>
pnpm audit:canary-lineage -- --job <stageJobId>
```

If the dedicated operator secret is unavailable, the **HTTP route** stays
fail-closed (401) and **no** endpoint is exposed; use the §6A Workflow instead.
The Workflow requires no Worker Secret and is the recommended path.

### Honest operational status (no cutover claim)

- The Workflow, like the HTTP route, is **crawl-first**: it seeds exactly one
  `crawl` job and (optionally) dispatches it. It **does not create a `discovery`
  job and cannot produce the literal Discovery->Search seven-stage lineage**; it
  is a lower-scope single-case control, **not** cutover proof.
- The **new US PDF crawl artifact** is private/review-required
  (`publishable=false`). Its *previously published legacy Core article* is a
  separate, historical state; it was not published by this canary. No current
  manual authorization is evidenced. Do **not** expect or report 7/7 for the US.
- The automatic FR/ES approval ledger is never US manual consent; the lineage
  audit always reports `manualAuthorizationPresent: false`.
- **No full operational cutover is claimed** until a genuine seven-stage lineage AND
  a verified, separately-recorded manual US approval both exist. Neither exists today.

## 7. Remaining blockers (must not be marked closed)

1. **DE: actual staged Discovery job still missing.** The DE canary proves
   official-fetch + normalize + translate + public judgment + publish + search
   for one case. A newly implemented **official homepage SSR discovery adapter**
   is independently read-only tested against the live court homepage and found
   three recent official decision links. It uses the permitted root `/`, never
   the robots-disallowed `/SiteGlobals/` search, and leaves discovered URLs
   unverified until fetched with exact ECLI. However **no real staged Discovery
   Job linked to this case** has executed yet; 7/7 and country cutover remain
   blocked pending a separately proven, bounded source-discovery lineage.
2. **US: Core provenance mismatch + no manual authorization.** The pre-existing US
   case (`4b3d5644-2681-449e-8ad5-28ee2defffe8`) lacks `officialPdf` hash/r2Key/
   docketVerified in Core, and the 2026-10-13 chain preserved it (no new
   publish/search). Its old `published` status is `legacy_published_preexisting`.
   There is **no separate manual per-case authorization**, and US policy forbids
   automatic publication. P2-M4 ownership stays **BLOCKED**.
3. **Ownership intentionally unchanged.** DE/US stay M8-owned; FR/ES stay staged.
   No paired allowlist/exclude change; no source-allowlist Wrangler change.
4. **Literal 7/7 not met.** The operator canary is crawl-first; the guards'
   Discovery->Search criterion remains `NOT_OBSERVED`.

### Suggested safe next implementation (NOT implemented here)

- **Genuine discovery:** add a bounded, robots-compliant discovery adapter for a
  real official feed (e.g. a BVerfG RSS/decision-archive endpoint) that creates a
  real `discovery` job; do not synthesize a discovery row.
- **US manual review:** add an explicit, separately-audited manual US publication
  authorization record (never the automatic FR/ES ledger) and a read-only
  provenance-upgrade path that stores `officialPdf` hash/r2Key/docketVerified for
  the already-verified PDF, without mutating the legacy public status until reviewed.
- Neither path may auto-publish or bypass review.

### Rerun the audit (read-only; controller)

```
# DE: follow the durable linked chain from the original Crawl job
pnpm audit:canary-lineage -- --job db44b56c-b5d6-46cf-821f-693c09757f49 --source de-bverfg
# US: follow the durable linked chain from the original Crawl job
pnpm audit:canary-lineage -- --job ed2f72db-b51e-4ace-852a-4902b4929b53 --source us-scotus
# Fallback (article-only; cannot observe crawl/discovery)
pnpm audit:canary-lineage -- --article a60db8bb-4ec3-4ecf-bb5a-6245f621a334
```

Expected: DE reports `stagedChainComplete: true`, `sevenStageComplete: false`,
`discoveryExecuted: false`, `nativeCoreRelation: resolved`, `searchProjection.verified:
true` (same live document/FTS rowid, re-projection may change the numeric id), `publication.classification: staged_publication`. US reports
the crawl+normalize chain, `publication.classification: legacy_published_preexisting`,
`usCoreProvenanceNote: canary_lineage.us_core_provenance_missing_officialPdf`,
`manualAuthorizationPresent: false`.

## 8. Changed files (local, uncommitted)

New:
- `lib/ingest/official-source-verify.ts`
- `lib/cloudflare/ingest-stages/canary.ts`
- `lib/cloudflare/ingest-stages/canary-workflow-payload.ts` (Workflow envelope contract)
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
- `workers/async-pipeline/src/index.ts` (operator canary Workflow + route + gate wiring)
- `workers/async-pipeline/wrangler.jsonc` (`OPERATOR_CANARY_WORKFLOW` binding; no allowlist/exclude change)
- `lib/cloudflare/ingest-stages/repository.ts` (optional bounded single-job claim)
- `lib/cloudflare/ingest-stages/dispatcher.ts` (optional `jobId`)
- `scripts/check.ts` (canary + workflow invariants)
- `package.json` (`test:canary`, `audit:canary-lineage`)

## 9. Recommended next legitimate commands (controller)

1. Review this diff; run `pnpm test:canary && pnpm test:ingest-stages && pnpm test:m8 && pnpm test:native-crawler && pnpm check && pnpm typecheck && pnpm m8:typecheck && pnpm m8:dry-run`.
2. Apply the additive `0006` migration to Production **only** as part of an
   approved deploy of `worldcons-ingest` (already applied per handoff).
3. Deploy `worldcons-ingest` (the Workflow and route are inert until invoked).
4. Trigger one DE canary via §6A (`wrangler workflows trigger`); confirm the crawl
   stage fetched the official body and the in-body ECLI matched; observe the
   lineage via `pnpm audit:canary-lineage`.
5. Feed only genuinely observed facts into `planGermanyCutover`/`planUsCutover`.
   Do **not** treat the canary itself as cutover evidence until the guard gates
   are individually satisfied.
6. For US, do not publish: record an explicit manual authorization only if a
   human reviewer actually approves the specific PDF.

## 10. Production read-only recheck and official homepage discovery (2026-10-13)

- The corrected linked-chain auditor was executed against live Production D1:
  `pnpm audit:canary-lineage -- --job db44b56c-b5d6-46cf-821f-693c09757f49 --source de-bverfg`
  returns `stagedChainComplete:true`, exactly six durable succeeded stages,
  `nativeCoreRelation:resolved`, `publication:staged_publication`,
  `searchProjection.verified:true` with matching document/FTS rowids;
  `sevenStageComplete:false` and missing real `discovery`.
- US audit using Crawl job `ed2f72db-b51e-4ace-852a-4902b4929b53` returns
  exactly two succeeded stages and resolves the preserved legacy Core UUID via
  the durable successful Normalize `result_ref`, without inventing a subsequent
  stage. The prior P3 publication is classified `legacy_published_preexisting`;
  existing Search/FTS evidence is legacy, not new canary publication.
  `usCoreProvenanceNote` reports missing `officialPdf` in Core; manual
  authorization remains unproven; the auditor appropriately exits with code 3.
- BVerfG official robots.txt was fetched (HTTP 200). `/` is allowed, while
  `/SiteGlobals/` is disallowed and `Crawl-delay: 30` is required. The
  production-path **read-only** `discoverNativeStageCandidates("de-bverfg")`
  now uses homepage SSR anchors ahead of the JS-only listing/failing third-party
  index. Real official HTTP 200 returned **three** September 2026 links
  (`rk20260923_2bvr168126`, `rk20260905_2bvr135824`,
  `rk20260902_1bvr258425`). All discovery artifacts remain
  `sourceUrlVerified:false` until an exact-ECLI official detail fetch.
  No Production D1 write or artificial Discovery Job was used for this probe.
- Tests: `pnpm test:native-crawler` **36/36**, `pnpm test:canary` **25/25**,
  `pnpm typecheck`, `pnpm m8:typecheck`, `pnpm check` all passed after
  resolving the auditor typo, the native->Core normalize-result link, and
  an indexed exact-rowid FTS assertion.

**Cutover gate status remains unchanged**: DE needs one genuine linked
Discovery->Search Production 7/7 (the one-case canary is only Crawl->Search),
and US needs a genuinely reviewed authorization and Core official-PDF
provenance as well as its own actual 7/7. Do not flip broad source ownership.
