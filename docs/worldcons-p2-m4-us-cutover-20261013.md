# WorldCons P2-M4 - United States (SCOTUS) staged-cutover preflight / fail-closed readiness - 2026-10-13 (KST)

## 2026-10-15 - Owner-controlled PRIVATE single-case US summarization (holds preserved)

**Current judgment: P2-M4 remains BLOCKED. No Production write, deploy, commit, or ownership switch was performed.** This change closes the *private-processing* half of the exact blocker documented below: a genuinely new `us-scotus` opinion held at `collection.publishable=false` / `review.required=true` can now be turned into a real, schema-valid Korean `summary_json` + `korean_title` **without** releasing the private hold, publishing, staging Search, or recording a human receipt - so an authenticated human can afterwards review an exact snapshot and decide whether to publish. It is **private processing, NOT human approval**.

### The narrow path (fail-closed by construction)

- **Mode.** Cloudflare-account-triggered `WorldconsOperatorCanaryWorkflow` mode `prepare-us-private-summary-one`. Authorization is the operator's Cloudflare account/OAuth scope (the same trigger the canary already uses); there is **no** new unauthenticated route.
- **Strict envelope (`lib/cloudflare/ingest-stages/canary-workflow-payload.ts`).** `OPERATOR_CANARY_PREPARE_US_PRIVATE_SUMMARY_ONE_KEYS` accepts ONLY `mode`, `sourceKey` (exact literal `us-scotus`), `articleId` (validated UUID) and optional `operatorId`. No `candidateUrl`, `docket`, `ecli`, `rangeDays`, `dispatch`, `prompt`, `approve`, or any other key - every other key is rejected as `unknown_key`. A non-`us-scotus` source is rejected (`prepare_us_private_summary_source_not_allowed`) and a malformed Core UUID is rejected (`prepare_us_private_summary_article_id_invalid`).
- **Real provider, real private transitions (`lib/cloudflare/summary/us-private-summary.ts`).** `runD1PrivateUsSummary` resolves the live Core D1 binding, recovers a genuinely stale `summarizing` claim, then fails closed (ZERO writes, ZERO provider calls) unless ALL of: exact `us-scotus` persisted source key; `status='metadata_only'`; `collection.publishable===false`; `review.required===true`; cleaned text >=500 chars; verified official-PDF provenance (trusted `supremecourt.gov` host, `docketVerified===true`, 64-hex sha256, `artifacts/scotus_pdf/<sha>.pdf` r2Key); and no pre-existing P3 publication or human receipt. It then invokes the **real** shared Gemini `summarizeArticle` and validates the result with `SummarySchema`.
- **STRICT R2 provenance (not optional).** The bound `WORLDCONS_RAW` bucket is **required**: an absent binding is refused (`r2_binding_missing`) and is **never** accepted as valid Production provenance. The one-object check is on the exact `artifacts/scotus_pdf/<official SHA>.pdf` key: the object must exist, be non-empty, be within the 8 MiB cap (`US_PRIVATE_SUMMARY_MAX_PDF_BYTES`, else `r2_object_too_large`), and - when bytes are readable - carry the `%PDF-` magic signature (`r2_not_pdf`) and hash to the exact stored sha256 (`r2_hash_mismatch`). The official SHA is the exact Production `7883149526371c5543f77a310dfcfead3834a7247654b02190abd5eec6ecaa94`.
- **Hold-preserving two-phase CAS.** Phase 1 claims the row (`status='metadata_only' -> 'summarizing'`) guarding `id + source_key + status + updated_at + content_hash IS ?` AND re-asserts `publishable=0` and `review.required=1` in SQL. Phase 2 writes `status='summarized'`, `summary_json`, `korean_title`, `translation_status='translated'`, `review_state='needs_review'` under the same hold-guarded CAS. A competing/stale writer can therefore never be overwritten; a provider error rolls the claim back to the **exact** private hold (`status='metadata_only'`, `publishable=false`, `review.required=true`) and records a retryable error class.
- **No user-configurable provider prompt, no injectable model, US-only.** The strict envelope carries no `prompt`/`model`/provider field (every extra key is `unknown_key`), and `WorldconsOpsService.runPrivateUsSummary` no longer accepts a caller `model` - it uses only the operator's pinned/default Gemini selection via `GEMINI_SUMMARY_MODEL`/`GEMINI_PINNED_MODEL`, exactly like `runSummaryArticle`. The article id is an exact v4 Core UUID and the persisted `source_key` must equal the literal `us-scotus`.
- **Never a public artifact.** The module contains no `INSERT` into `article_publications_p3`, `article_cache_outbox_p3`, `e2e_approval_evidence_v1`, `search_documents`, or `search_fts`; a `scripts/check.ts` invariant forbids them. It searches for existing P3/receipts only to refuse. Source ownership (staged allowlist / M8 exclude) is untouched. A failure rollback restores the **exact** private hold (`publishable=false` / `review.required=true`), never widening access.
- **Human-reviewable, still held.** On success it synchronizes the lifecycle axes to `collection=source_text_ready`, `processing=complete` while keeping `lifecycle_review_state='needs_review'`. The private hold (`publishable=false` / `review.required=true`) still gates the one path that can publish: the authenticated, snapshot-bound `publish-reviewed` flow, which is unchanged.
- **Idempotent & repeat-safe.** A repeated call on an already privately-summarized row returns `already_summarized` with no second provider call; the Workflow `step.do` name is keyed on the exact article id.

### Operator invocation

```
wrangler workflows trigger worldcons-operator-canary-v1 \
  '{"mode":"prepare-us-private-summary-one","sourceKey":"us-scotus","articleId":"d8dc4ebc-7193-4a2d-8bcf-21e9cbbe4127"}'
```

The workflow returns only bounded, non-secret readback (`status`, `reason`, `provider`, `model`, `lifecycleSynced`) plus `publicationUntouched: true`, `searchUntouched: true`, `reviewHoldPreserved: true`.

### Tests added (`tests/p2-m4-us-private-summary-guard.test.ts`)

Genuine new-case private-summary success with a valid stub `SummaryJson` preserving the hold; exact human preview computable but no publication/receipt from private processing; idempotence (no second provider call); stale-CAS refusal (no provider call, no overwrite); fail-closed on bad source / released hold / missing provenance / non-official host / r2Key-sha mismatch / missing R2 object / existing P3 / existing receipt / no creds; strict R2 provenance (absent binding, missing/empty/oversized object, non-`%PDF-` body, hash mismatch all fail closed with no provider call, and a hash-matching `%PDF-` body succeeds); provider-failure rollback to the exact hold; and strict envelope rejection of every injected key. Tests inject a stubbed provider/SummaryJson; production never fakes a summary.

### Deploy order & Service Binding (controller-executed; NOT run this session)

1. **App Worker `worldcons` first** (it owns `WorldconsOpsService.runPrivateUsSummary`):
   `pnpm build:vinext && pnpm exec wrangler deploy --config dist/server/wrangler.json`
2. **Ingest Worker `worldcons-ingest` second** (it calls the binding):
   `pnpm exec wrangler deploy --config workers/async-pipeline/wrangler.jsonc`
3. Config binding already declared in `workers/async-pipeline/wrangler.jsonc`:
   `{ "binding": "WORLDCONS_APP_SERVICE", "service": "worldcons", "entrypoint": "WorldconsOpsService" }`.
   No new binding, var, route, queue, or workflow change is required.
4. No D1 schema/migration change; no Production data mutation. The private op only runs when an operator triggers the workflow.

### Changed files

- `lib/cloudflare/summary/us-private-summary.ts` - NEW private single-case US summarizer (strict R2 provenance).
- `lib/cloudflare/ingest-stages/canary-workflow-payload.ts` - NEW strict `prepare-us-private-summary-one` envelope shape.
- `workers/async-pipeline/src/index.ts` - `WorldconsOperatorCanaryWorkflow` `prepare-us-private-summary-one` branch; concatenated import statements de-concatenated onto separate lines.
- `worker/index.ts` - `WorldconsOpsService.runPrivateUsSummary` private-processing primitive (no injectable model).
- `scripts/check.ts` - static invariants for the private summarizer, strict R2 contract, and no-public-write contract.
- `tests/p2-m4-us-private-summary-guard.test.ts` - NEW private-summary tests (incl. strict R2 provenance).
- Pre-existing uncommitted `next-env.d.ts` edit was left untouched and is NOT part of this work (`next typegen` restored it to the committed state).

### Verification (this session, FINAL)

| Command | Result |
| --- | --- |
| `pnpm exec tsx --test tests/p2-m4-us-private-summary-guard.test.ts` | **13/13 pass** |
| `pnpm test:us-cutover` | **36/36 pass** |
| `pnpm test:canary` | **49/49 pass** |
| `pnpm test:ingest-stages` | **58/58 pass** |
| `pnpm check` | **All checks passed** |
| `pnpm typecheck` | **pass, 0 errors** |
| `pnpm m8:typecheck` | **pass** |
| `pnpm m8:dry-run` (Wrangler) | **pass**; source allow/exclude still FR/ES/DE, US M8-owned |
| root app Worker: `pnpm build:vinext && wrangler deploy --dry-run --config dist/server/wrangler.json` | **build + dry-run pass** |
| changed-source eslint | **pass (0 errors, 1 pre-existing warning in `worker/index.ts`)** |
| `git diff --check` | **clean** |

This session performed **no** Production write, deploy, commit, push, ownership switch, Search/publish/receipt action. The app-Worker dry-run validates the new `runPrivateUsSummary` code bundles; it does not deploy.

**P2-M4 country-wide cutover remains BLOCKED.** The new private path produces a reviewable summary only; it never substitutes for the required authenticated human approval + post-review P3/Search evidence.

## 2026-10-14 18:15 KST — Web + Ingest Production deployment and read-only guard witness

**Current judgment: P2-M4 safety engineering and both Worker deployments are complete; US country-wide staged ownership cutover remains BLOCKED pending genuine per-case human approval and fresh post-approval seven-stage proof.** US still belongs to M8; FR/ES/DE remain staged, with exact paired ownership values unchanged.

- GitHub main `07b1fc3c189b7e850bc3601a867f3108814d6e95` combines P2-M4 code commit `9a1ec2a` with unrelated authorized T3 main `ab2d6b5`. The unrelated code was preserved.
- Cloudflare public Web Worker `worldcons` Production version `7ab5c27d-ea5a-4408-bb3b-49458aeab2d6`, deployed at 2026-10-14T09:13:09Z using the **Vinext-generated** `dist/server/wrangler.json` after a successful `pnpm build:vinext`. The ordinary root `wrangler.jsonc` raw dry-run initially failed because Vinext's virtual entry is not directly resolvable, so the actual successful generated-config dry-run and deploy were used. Public `/api/sources` returned valid FR/DE/ES/US source data.
- Cloudflare Ingest Worker `worldcons-ingest` Production version `8bcd3e75-f1fe-44ac-92d5-17b73a856f09` at 2026-10-14T09:13:33Z. `/health` 200: M8 effective sources **US only**, excluded and staged sources **FR/ES/DE**, 7 stage names and limits unchanged.
- Code now protects ALL US articles for human-reviewed publication even without an FR/ES E2E ledger row, uses exact CAS-protected admin preview and immutable approval receipt, explicitly clears `review.required` only in an authenticated reviewed path, excludes US from automatic P3 drain, and checks the persisted article source key matches the staged job key before evaluating US approval. Read-only `audit-us-guard-one` mode reuses the exact runtime stage guard; it cannot enqueue jobs or write D1. These changes do not approve any article.
- Authenticated read-only live Workflow `cf_67fe0774399ec7ce5d30d3843af1daf003d149bffd5a98142c5732a3da309423` completed successfully on 2026-10-14T09:14:08Z for US Core UUID `4b3d5644-2681-449e-8ad5-28ee2defffe8`. It returned **`outcome=blocked`, `code=ingest_stage.us_manual_approval_receipt_required`, `blocked=true`, `retry=false`, `receiptPresent=false`, `receiptAuthenticated=false`, `officialPdfProvenancePresent=true`, `readOnly=true`**. This is a real Production guard evaluation, **NOT** a newly failed Public Judgment stage Job, a seven-stage approval receipt, or a synthetic manual approval.
- Production Core SELECT-only postcheck: official SCOTUS PDF R2 provenance/SHA remains `73ef64de152e4dc257baa83767b75eb19fe6aea473be8688b61644c0741afd2e`; historical P3 `published` revision 2/version `a561ed28-ddca-5fc7-ab5b-cece967d5ab7` remains published since 2026-09-27T02:44:49.651Z, and immutable human approval ledger count is **0**. No direct D1 write, automatic US publication, new P3, source ownership switch, or canary-limit bypass was performed.
- Verification on merged release: `pnpm typecheck`, `pnpm m8:typecheck`, `pnpm check`, `test:us-cutover` 23/23, `test:canary` 49/49, Vinext production build and generated Worker dry-run, async Worker dry-run all passed. Earlier E2E P0 M5 48/48 and ingest-stages 58/58 also passed.

**Still required before P2-M4 country cutover:** a genuinely new US opinion with private review hold, explicit authenticated *human* preview/approval and same-snapshot immutable consent, post-review new P3 and Search/FTS, and an eligible Production Discovery→Search linkage after the live guard is in force. The verified prior 7/7 legacy case remains disqualified for cutover. Preserve the 24-hour bounded canary throttle and both current country ownership values until these conditions are witnessed.

## 2026-10-15 — NEW US 26A476 private-summarization trace, exact blocker, and `approve-and-summarize` bypass closure

**Current judgment: P2-M4 remains BLOCKED. No Production write, deploy, commit, or ownership switch was performed.** The genuinely new Production US SCOTUS 2026-Term opinion `26A476 FCC v. Brown` (Core UUID `d8dc4ebc-7193-4a2d-8bcf-21e9cbbe4127`, published 2026-10-14, `status=metadata_only`, `review_state=needs_triage`, `summary_json=NULL`, `korean_title` absent, `translation_status=not_required`, `length(cleaned_text)=7979`, `collection={publishable:false,sourceTextAvailable:true,sourceUrlVerified:true}`, `review.required=true`/`scotus_pdf_human_review_required`, `officialPdf.docketVerified=true`, `sha256=7883149526371c5543f77a310dfcfead3834a7247654b02190abd5eec6ecaa94`, R2 original `artifacts/scotus_pdf/<sha>.pdf`) **cannot currently be privately summarized to a human-reviewable SummarySchema + Korean title without changing `publishable=false`/`review.required=true`, and cannot enter public Search/FTS.** This is not a fabricated finding: it is proven by executing the real eligibility and summary code against a real `metadata_only` fixture.

### Exact trace (native Hive DeepSeek 4.1 Flash; no Codex/Orca)

- **Normalize → US private path (`workers/async-pipeline/src/native-crawler.ts`).** `articleStatus` returns `"needs_review"` for every `us-scotus` candidate (line 744), so the legacy status collapses to `"metadata_only"` (line 1032) and the lifecycle `reviewState` is `needs_review`. The `collection.publishable=false` / `review.required=true` hold is written by the crawl candidate and never promoted by normalize. No summary is produced.
- **Translate adapter (`workers/async-pipeline/src/ingest-stage-handlers.ts`).** The `translate` handler calls the real per-item `WorldconsOpsService.runSummaryArticle` (`workers/async-pipeline/src/index.ts:878`). Before it calls, `verifyTranslationDurableEffect` requires `collection.publishable === true` (line 275). A US private-hold row can never satisfy that, so the durable-effect check cannot pass for US even if a summary existed. The per-article summarizer itself (`lib/cloudflare/summary/d1-summary-drain.ts` → `canSummarizeArticle`, `lib/ingest/publishability.ts:131`) also requires `collection.publishable === true`. **There is no private-summarization branch.**
- **M8 summary candidate selection (`lib/cloudflare/summary/d1-summary-drain.ts:239`).** `selectCandidates` filters `json_extract(source_metadata,'$.collection.publishable')=1`. A US `metadata_only` row with `publishable=false` is never selected. The legacy Supabase path (`lib/ingest/summary.ts:419`) applies the identical `.contains({collection:{publishable:true}})` filter.
- **API admin `approve-and-summarize` (`lib/admin/d1-review.ts`).** This was the **only** pre-summary branch that could flip the hold: it wrote `collection.publishable=true` and replaced `review` **before** any summary existed, with no exact preview hash and no actor binding (the old bypass described in section 5 of the 2026-10-13 audit). For a US opinion it would have silently cleared the private hold and allowed an unreviewed, unauthenticated summarization to run — potentially fabricating a "human reviewed" summary. **Closed (see below).**
- **`publish-reviewed` / `recordHumanApproval` (`lib/admin/d1-review.ts:69`, `lib/cloudflare/e2e/manual-approval.ts`).** `publish-reviewed` correctly requires `summary_json`, an authenticated session identity and an exact `expectedApprovalSnapshotHash` for protected sources; `recordHumanApproval` requires `collection.publishable===true`, `sourceTextAvailable`, `ready`+`source_url` verification, ≥500-char text, a schema-valid summary, a Korean title and a non-private review state. A `metadata_only` US row with no summary therefore cannot be approved — the exact blocker — and no human receipt is written. This is the only path that may set `publishable=true`/`review.required=false`.
- **`publicationEligible` (`lib/cloudflare/core-write/authority.ts`).** Even a hypothetical private summary cannot publish: it additionally requires `lifecycle_collection_state='source_text_ready'`, `lifecycle_processing_state='complete'`, `lifecycle_review_state ∈ {unreviewed,approved}`, `lifecycle_attention_state='clear'` and `collection.publishable===true`. The `metadata_only` US hold fails all of these.
- **Search/FTS (`lib/cloudflare/search-projection/d1-sync.ts`, `ELIGIBLE_PUBLISHED_PREDICATE`).** Projection is driven off a `published` P3 row; with no publication, a private US case produces zero `search_documents`/`search_fts` rows.
- **D1 lifecycle (`native-crawler.ts`).** A US insert commits `collectionState='metadata_only'`, `processingState='not_ready'`, `reviewState='needs_review'` and a raised `collection.pdf_text_unavailable` attention — never `complete`/`clear`.

### Conclusion: currently impossible → MINIMAL fail-closed closure implemented

The task permitted: (a) minimal fail-closed US-only private summarization support with explicit guards, or (b) tests + documentation of the blocker with no weakening. Because **US is M8-owned (not staged)**, the translate/public-judgment/publish/search adapters are only wired for staged canary sources, and any private-summarization entrypoint would itself require a new authenticated, protected-source-guarded route plus a novelty/rate-limit story — a new unauthenticated surface is explicitly forbidden and a broad change would be unsafe. The **genuine current blocker is that there is no authenticated, non-destructive private-summarization entrypoint that preserves the hold**, so option (b) was implemented together with the mandatory **bypass closure** (which is a strict safety improvement, not a weakening):

1. **Closed the `approve-and-summarize` US/protected-source bypass (`lib/admin/d1-review.ts`).** The branch now calls `protectedSourceRequired(core,id)` before doing anything and returns `skipped` (writing nothing) for any protected source — which always includes `us-scotus`. It can no longer flip `collection.publishable` to `true`, clear/replace `review.required`, change `status`, queue a pre-summary job, or create a "human reviewed" summary for an unreviewed hold. Only `publish-reviewed` may clear the hold, and only with an exact snapshot-bound human preview + valid summary + immutable receipt.
2. **Added `tests/p2-m4-us-private-summary-guard.test.ts` (4/4)** using a **real** `metadata_only` + `summary_json NULL` + `review_state=needs_triage` + `publishable=false` + `review.required=true` + no-ledger fixture:
   - `publish-reviewed` is honestly `skipped` with no summary; no P3, no receipt.
   - The real `canSummarizeArticle` returns `false`, the real `runD1SummarizeArticle` returns `skipped` and writes no summary — the exact blocker, machine-proven.
   - `approve-and-summarize` is refused and leaves `status='metadata_only'`, `summary_json=NULL`, `review_state='needs_triage'`, `publishable=false`, `review.required=true`, `article_publications_p3=0`, `e2e_approval_evidence_v1=0`.
   - A static guard asserts the protected-source check precedes any `publishable` write in that branch.
   - A separate test proves the hold (not the summary) gates publication: a hypothetical private summary with `publishable=false` retained still requires the exact human preview, and only a real human preview then publishes + clears the hold + records exactly one receipt.

**No `publishable=false` / `review.required=true` was changed for 26A476. No human was impersonated. No public Search/FTS entry was created. No unauthenticated endpoint, queue entrypoint, or direct D1 write was added.** No SCOTUS official PDF was staged-owned, no US pair source switch occurred, and the FR/ES guarded sources were not moved.

### Verification (this session)

| Command | Result |
| --- | --- |
| `pnpm test:us-cutover` (now includes the new guard file) | **27/27 pass** |
| `pnpm test:canary` | **49/49 pass** |
| `pnpm test:native-crawler` | **37/37 pass** |
| `pnpm test:ingest-stages` | **58/58 pass** |
| `pnpm test:e2e-p0-m5` | **48/48 pass** |
| `pnpm test:p2-m4-us` | **5/5 pass** |
| `pnpm check` | **All checks passed** |
| `pnpm typecheck` | **pass, 0 errors** |
| `pnpm m8:typecheck` | **pass** |
| `pnpm m8:dry-run` (Wrangler) | **pass**; source allow/exclude still FR/ES only |
| `git diff --check` | **clean** |

### Changed files

- `lib/admin/d1-review.ts` — fail-closed protected-source guard in the `approve-and-summarize` branch.
- `tests/p2-m4-us-private-summary-guard.test.ts` — NEW focused blocker + bypass-closure tests.
- `package.json` — `test:us-cutover` includes the new test file.
- `scripts/check.ts` — invariant asserting the pre-summary `approve-and-summarize` branch consults `protectedSourceRequired` before any `publishable` write.
- `docs/worldcons-p2-m4-us-cutover-20261013.md` — this section (existing 2026-10-14 audit preserved).
- Pre-existing uncommitted `next-env.d.ts` edit from the prior agent was left untouched and is NOT part of this work.

## Latest Production status — 2026-10-14 16:29 KST (supersedes old preflight status)

**P2-M4 country-wide operational cutover remains BLOCKED; US is M8-owned,
not staged.** Current paired staged/M8 exclusion lists are exactly
`fr-conseil-constitutionnel,es-tribunal-constitucional,de-bverfg`.
Protected FR/ES automatic E2E approval remains unchanged.

- Code-only PDF provenance repair and genuine US `discover-one` were shipped
  in GitHub `a64417f`, Production `worldcons-ingest`
  `9fb622eb-178d-4445-8f95-b23c94e872e2` at 06:23Z.
- Real SCOTUS official-listing discovery Job
  `9d3c4b99-af30-4524-86a8-d4d63b172d4a`, Crawl Job
  `59d0bbde-688f-409b-a90e-480b87a05c70`, and Normalize Job
  `98a4d567-443a-456d-bef0-19f86f377aeb` all succeeded, with the
  immutable original PDF (`26a388_q86b.pdf`, 63,361 bytes) verified and
  `source_metadata.officialPdf` now persisted for existing Core article
  `4b3d5644-2681-449e-8ad5-28ee2defffe8`. R2 and Core SHA-256 match
  `73ef64de152e4dc257baa83767b75eb19fe6aea473be8688b61644c0741afd2e`.
- IMPORTANT INCIDENT FINDING: **the same canary did automatically traverse
  Translate, Public Judgment, Publish and Search *before* the human-approval
  runtime guard was deployed**. The seven stage Jobs have `succeeded` status,
  but the row was **legacy published and publishable** and had **zero**
  same-case human-approval receipts. Public Judgment completed 06:45:22Z,
  Publish 07:00:25Z, Search 07:15:23Z. The P3 published version remains the
  *existing* `a561ed28-ddca-5fc7-ab5b-cece967d5ab7`, revision 2, published
  `2026-09-27T02:44:49.651Z`; no newly authorized P3 publication is
  evidenced. **This 7/7 must NEVER count as an eligible US cutover proof.**
- After detecting that legacy eligibility hole, the controller committed the
  **US-only human-approval runtime gate** (`1704e44`; merge into current
  GitHub main `f5dc099`) and deployed Production Worker
  `7cdc74d1-ca6f-4c28-968f-6a346ce0c2a3` at 07:26Z.
  Before allowing US Public Judgment **or** Publish **or** Search, the handler
  now independently requires an immutable same-article human receipt bound to
  the *current* full Core snapshot and verified PDF. All four snapshot/source
  hashes in the receipt document and immutable ledger must be nonempty and
  match the independently recomputed values. Unresolved `native:` article
  IDs fail closed; old P3 state, `publishable=true`, automatic FR/ES approval,
  a workflow trigger, or an operator-supplied boolean are **not** sufficient.
  D1 read failures retry; missing or stale consent blocks.
- Verification: `test:canary` 47/47, `test:us-cutover` 15/15,
  `test:ingest-stages` 58/58, typecheck, M8 typecheck, `pnpm check`,
  Wrangler dry-run and changed-file lint passed. Worker `/health` is healthy
  and confirms US still M8-owned.
- A post-guard authenticated one-case validation trigger
  `cf_346cc55918893515cf9b7d9573598ae816642114223325f8ca19e912f89268e2`
  was **correctly rate-limited** (`canary.rate_limited:4/1`, `enqueued:0`).
  Therefore **the new guard's post-deployment block has NOT been witnessed
  as a fresh Production Public Judgment Job**; tests and code inspection
  alone cannot be mislabeled live gate validation. Do not circumvent the
  source-rate limit.

**Remaining genuine release requirements:** observe a fresh US case with
`collection.publishable=false` and `review.required=true` at ingest, have
an actual human reviewer inspect and explicitly approve that **same case**
via the existing authenticated review workflow, verify the snapshot-bound
ledger receipt, observe post-approval P3 and Search/FTS with a new
Production Discovery→Search lineage, then and only then switch both paired
owner flags atomically. The current SCOTUS historical case cannot establish
the private-hold or manual-consent gates retrospectively.

## 2026-10-14 follow-up: US official-PDF provenance repair and genuine discovery canary

The older historical sections below describe their respective earlier release
states and ownership pairs, **not today's current settings**. Current ownership
before US cutover is FR/ES/DE staged, US M8; both Wrangler ownership values
match `fr-conseil-constitutionnel,es-tribunal-constitucional,de-bverfg`.

Read-only Production audit on 2026-10-14 found zero US Core
`source_metadata.officialPdf` rows, despite the earlier crawl-first US canary
successfully verifying a 63,361-byte original slip-opinion PDF at
`artifacts/scotus_pdf/73ef64de152e4dc257baa83767b75eb19fe6aea473be8688b61644c0741afd2e.pdf`.
An independent read-only Production R2 GET confirmed the `%PDF-` signature
and matching SHA-256. The same-case legacy Core row is
`4b3d5644-2681-449e-8ad5-28ee2defffe8`, with pre-existing P3 published
in September. That historic publication is **not** new review approval or
new P2-M4 7/7 evidence.

Root cause: a verified PDF was saved into the crawl candidate's metadata and
R2, but `persistArticle` returned `preserved` early on an existing published
US row to avoid destructive regression, silently skipping `officialPdf` Core
metadata persistence. A newly inserted US article would not hit this branch.
The remediation adds a CAS-fenced, idempotent official-PDF-only metadata attach
path that leaves publication, text, review and the historical P3 version
untouched, with bounded provenance history.

A separate operator-account-authenticated `discover-one` Workflow now supports
US via **real official SCOTUS slip-opinion listings**, without a supplied
candidate URL and without opening the US staged allowlist. The selected case
is limited to one and its Discovery->Crawl evidence is linked durably.
`bootstrap-de-one` remains DE-only. Neither route publishes/approves US.

The P2-M4 evaluator additionally requires a same-case human review evidence
receipt from the existing immutable `e2e_approval_evidence_v1` ledger (human
policy, human receipt schema, non-empty actor identity). A caller's
`manualPublicationAuthorization:true` boolean, historical P3 version or FR/ES
automatic approval ledger cannot authorize US cutover. No operator Workflow
trigger by itself constitutes manual approval.

**P2-M4 is NOT operationally complete until a genuinely reviewed US case has
same-case Discovery->Search 7/7 Production evidence, R2/Core provenance and a
human authorization receipt.** The country-wide paired Wrangler owner
switch must not be made before those checks pass. With DE already staged,
the paired *future* owner values would be
`fr-conseil-constitutionnel,es-tribunal-constitucional,de-bverfg,us-scotus`;
rollback is the present FR/ES/DE pair.

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

## 11. Code release and simultaneous engineering closure (2026-10-13)

This document's earlier sections describe the pre-release audit. The P2-M4
engineering deliverables plus a shared ownership-pairing fail-closed guard for
P2-M3/P2-M4 were subsequently committed and pushed to GitHub `origin/main` in
`76e780d222b22b6881b08472291f3fc38cbfe7b6`. The shared guard refuses a
cutover plan when current staged allowlist and M8 exclusion do not match in
source names and order, or contain blank/duplicate entries; rollback values
are retained and no planned mutation is emitted.

Wrangler dry-run passed. `worldcons-ingest` Production deployment version
`ff3d919f-02dd-4e45-aa71-55fc39914386` reached 100% on
2026-10-13T09:22:57Z. Post-deploy `/health` succeeded, verifying DE/US remain
M8-owned, FR/ES remain staged, and both staged limits remain 1.

**P2-M3 and P2-M4 engineering delivery are marked complete simultaneously**,
but their **actual country ownership cutovers remain GATED/BLOCKED** pending
independent genuine per-case Production evidence, review authorization and
the approved cutover procedure. The pure readiness planners are not an
automatic Wrangler deployment gate; no manual config bypass is authorized.
P0 checks 3 and P1 check 1 remain open.
