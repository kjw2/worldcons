# WorldCons AI Gateway migration — Gemini dynamic routing by default

Date: 2026-11-10
Status: **P0 live Gateway smoke check passed; P1 G1/G2 and P2 G3/G4 adapters implemented and tested locally. Production Worker traffic cutover NOT performed.**
Priority: P0 authentication and routing contract; P1 shared adapter; P2 administration; P3 staged validation; P4 controlled production cutover.

## 1. Binding decision and current verified state

**WorldCons summarization/translation defaults to the existing Cloudflare AI Gateway dynamic route `dynamic/gemini-flash-fallback` on gateway `default`, not to DeepSeek.** DeepSeek is a separately managed, non-default candidate that MUST NOT be silently inserted into this default summarization chain. No automatic Gemini -> DeepSeek application-level fallback is authorized by this plan. A future explicit policy change is required to use DeepSeek in this workflow.

On 2026-11-10 the Cloudflare MCP API updated the account's sole existing AI Gateway `default`: `byok_only: false -> true`. GET after PUT verified `byok_only: true`, `authentication: true`; other gateway settings and Secrets Store ID were unchanged. This gateway-level control covers every currently deployed dynamic route on this gateway (`gemini-flash-fallback`, `deepseek-flash-fallback`, `worldcase-fr-backfill`), not only WorldCons. It prevents implicit fallback to Unified Billing when no applicable customer-provided provider credential exists; provider-key errors can still fail the request, and BYOK providers may still charge for their own usage. New gateways, if created later, MUST independently enable and verify `byok_only: true` before receiving traffic.

Verified deployed `gemini-flash-fallback` nodes, each timeout **20,000 ms** and `retries: 0`:

1. `custom-gemini-openai/gemini-3.8-flash`
2. `custom-gemini-openai/gemini-3.6-flash`
3. `custom-gemini-openai/gemini-3.5-flash-lite`
4. `custom-gemini-openai/gemini-3.1-flash-lite`

Verified active route version `68dfaf5b-e13d-4467-969c-7a99f02351fd` with BYOK-only enabled and Gateway authentication on. Individual model calls may be unavailable (the P0 pass criterion is successful JSON from at least one of the ordered fallback nodes). Keep model ordering exclusively in Gateway, not in Worker source. Existing unrelated Gateway route configurations must not be changed.

## 2. Existing WorldCons code, identified change sites

| Surface | Existing behavior | Planned modification |
| --- | --- | --- |
| `lib/cloudflare/summary/d1-summary-drain.ts` | `summarize` called with `provider: "gemini"`, Gemini API key array and Gemini-only model selection | Route through one shared `SummaryGenerationAdapter` that obtains the selected backend from policy; preserve D1 job state, schema validation, source and translation safety gates |
| `worker/index.ts` | `runSummaryArticle` / `runSummaryDrain` supply Gemini keys and can fail when Gemini keys missing | Attach `AI` binding and pass gateway-capable adapter into both call sites; **gateway mode does not require a direct Gemini API key** |
| `lib/ai/client.ts` | Provider-specific clients/fallbacks | Add AI Gateway dynamic chat completions adapter, map response/usage/actual provider/model; no nested application-level provider fallback when Gateway handles routing |
| `workers/async-pipeline/src/admin-job-drain.ts` | `retry-summary` explicitly rejects providers other than `gemini` | Use configured gateway backend for retry-summary; preserve bounded job IDs and explicit approval/triage |
| `lib/cloudflare/summary/us-private-summary.ts` | US private case flow can use separate client | Audit and reconcile with shared adapter while keeping US source/private case restrictions |
| `lib/ai/llm-settings.ts`, `lib/ai/llm-settings-types.ts`, `app/api/admin/llm-settings/**`, `components/admin-llm-settings-panel.tsx` | D1 provider/model selection and connection test do not govern automated Gemini drain end-to-end | Add first-class backend `cloudflare-ai-gateway`, gateway id, dynamic route, selected backend status and non-mutating test; distinguish logical route from actual returned provider/model |
| `wrangler.jsonc` and Worker Env types | No `AI` binding in the main `worldcons` service | Add `"ai": {"binding":"AI"}` to **main** Worker and regenerate/check types; `worldcons-ingest` invokes the main app through the existing service binding, so do not add a second competing LLM caller without need |

**Do not conflate summarization with embeddings.** Existing Gemini embedding policy (`EMBEDDING_PROVIDER`, `GEMINI_EMBEDDING_MODEL`) is out of scope for this summary routing migration. Preserve source acquisition, cleaned official text, `metadata_only` fail-closed flow, E2E approval, immutable P3 publication and search version verification.

### 2.1 Mandatory four-path migration scope

**All four production translation/summary entrypoints MUST use the same gateway-backed summary generation adapter and the same default `dynamic/gemini-flash-fallback` route.** Do not mark the migration complete after changing only `lib/ai/summarize.ts`; every entrypoint's Gemini-key guard, model override, retry behavior and fail-closed policy must be reviewed. Retain the different work selection and publication authorities:

| ID | Entry point and actual current call chain | Planned Gemini dynamic route integration | Must retain / independently verify |
| --- | --- | --- | --- |
| **G1 — Single-item incremental ingestion** | `worldcons-ingest` staged `translate` → `WORLDCONS_APP_SERVICE.runSummaryArticle({articleId})` → `runD1SummarizeArticle` → `summarizeCandidate` → `summarizeArticle` | Resolve one shared gateway backend and route; **one article ID per invocation**, without direct `GEMINI_API_KEY` dependency in gateway mode | Native discovery/crawl/normalize identity, content-hash CAS, source-text eligibility, staged approval → P3 → Search and exactly-once durable result handling; `metadata_only` produces no AI request |
| **G2 — Backfill and pending batch summary** | Scheduled `translation-drain` → `executeM8TaskNative` → `WORLDCONS_APP_SERVICE.runSummaryDrain` → `runD1SummaryDrain` → `summarizeCandidate` → `summarizeArticle` | Same gateway adapter/route and prompt/schema; preserve bounded batch and filter by source when supplied | No blanket re-translation of already valid summaries, candidate/source-text eligibility, D1 retry/lease/claim and publisher verification. **Separate `p1.case-backfill.*` inventory/fetch/normalize/catalog publication remains source-only and must not start an LLM call by itself**; its eligible Core articles can subsequently enter the normal pending summary drain |
| **G3 — Administrator manual retry/resummary** | Admin job `retry-summary` → `workers/async-pipeline/src/admin-job-drain.ts` → `runSummaryArticle`; admin `summarize` / `ingest-and-summarize` → `runSummaryDrain` | Remove the hardcoded `provider !== "gemini"` rejection **only after** applying the configured gateway backend. Normal manual retries still use the default Gemini dynamic route; any explicit model override must be either blocked or separately governed, never silently passed as a provider-specific string to a dynamic route | Authenticated admin actions, per-item audit/actor, user-initiated force-resummary scope, no bypass of publication approval, no duplicate publication or invalid downstream summary |
| **G4 — US private single-case summary** | `WorldconsOpsService.runPrivateUsSummary` → `runD1PrivateUsSummary` → `summarizeArticle` | Use the same adapter/route without making the direct Gemini key a prerequisite in gateway mode | **Strict private hold**: official PDF/R2 hash evidence, single US article ID, review required, no automatic publication, no Search projection, no approval receipt creation; keep private result visibility restrictions |

**Routing parity contract:** all four use the same configured `gatewayId`, `dynamicRoute`, prompt/schema validation, model metadata extraction and bounded gateway error classification. They do **not** share batch selectors, authorization, source-provenance policy, publication control or per-job retry limits. Preserve the explicit administrator and US-private audit trails. Direct Gemini is a single explicit rollback backend, not a hidden second fallback after a Gateway failure.

**Model-selection parity:** the current single-item path prioritizes `GEMINI_SUMMARY_MODEL` while the batch path can use Gemini auto-discovery; these must no longer select different upstream models when gateway mode is enabled. The Gateway deployment owns model order; a per-article `model` override must not change the default dynamic route without a separate allowlisted operator policy. Keep the existing Gemini embedding provider/model separate.

## 3. Planned configuration and authentication contract

New policy keys (names subject to final implementation review; do not set in production before the gateway adapter is tested):

```text
WORLDCONS_SUMMARY_BACKEND=cloudflare-ai-gateway
WORLDCONS_AI_GATEWAY_ID=default
WORLDCONS_AI_GATEWAY_ROUTE=gemini-flash-fallback
```

For the new backend, use the Worker AI binding and the *chat completions* shape:

```ts
// Illustrative contract, not installed code:
const completion = await env.AI.run(
  "dynamic/gemini-flash-fallback",
  {
    messages: [
      { role: "system", content: buildSystemInstruction() },
      { role: "user", content: buildSummaryPrompt(cleanedOfficialText) },
    ],
    // Structured-output support must be probed for EACH custom provider.
  },
  { gateway: { id: "default" } },
);
```

Cloudflare dynamic routes accept OpenAI chat completions requests, not arbitrary model-native `generateContent` payloads. The existing Gemini API JSON contract must be translated carefully. Determine actual output from the returned response/metadata and **do not treat a successful HTTP response as a valid summary**. Retain strict parsed JSON schema, identity/date checks and controlled retry on invalid content. Cloudflare's internal route fallback handles upstream/model failures; if output fails schema validation, record a separate semantic validation error and use a bounded repair path, not an uncontrolled DeepSeek fallback.

Use Cloudflare's existing gateway authentication and provider credentials. Do not copy provider API keys or Gateway tokens into D1 settings, code, logs or the browser. Keep the production Gateway `byok_only: true` enforced. Choose restrictive logging (`cf-aig-collect-log-payload: false` where supported) to retain cost/latency/usage metadata without duplicating full judicial texts.

## 4. Execution gates

| Gate | Concrete work | Acceptance evidence |
| --- | --- | --- |
| **P0: Read-only Gateway smoke test** | On `default`, authenticate dynamic route `gemini-flash-fallback`, test a short legal Korean JSON payload, schema and required length, a forced failure of first node and fallback, timeout behavior, verify BYOK-only stays true | Real request/log IDs, provider/model, token use, 2xx results, fallback receipts, redacted logs. Do **not** switch production traffic if any guard fails |
| **P1: Core adapter + G1/G2 integration** | Main Worker AI binding, shared adapter, incremental single-item and backfill/pending batch paths; gate via config flag, keep direct Gemini as explicit rollback | G1 and G2 integration tests, typecheck, no-secret-leak tests, JSON/schema parity, same Gateway route/model policy, no unnecessary direct Gemini key dependency |
| **P2: Admin & private G3/G4 integration** | `/admin/llm` shows `cloudflare-ai-gateway` backend, gateway ID, selected `dynamic/gemini-flash-fallback`, dynamic route health and actual model from latest call; migrate admin retry and US-private calls to shared adapter | G3 admin authorization/force/resummary tests, G4 official-PDF/R2/private hold tests, D1 config-read/write and dry-run tests; no plain-text BYOK keys |
| **P3: Four-path staged quality and safety** | Exercise **G1, G2, G3, G4 separately** using held-out full-text decisions across Spain/France/Germany/US; compare current Gemini results; test unavailable source, invalid JSON, provider outage, timeout and repeated job | Test receipts for **each of four paths** recording requested route and actual model, text/case/date provenance and summary parity; metadata-only makes zero AI requests; G4 remains private; no unauthorized publication or P3 mutation |
| **P4: Controlled four-path cutover** | Roll out flags per path G1→G2→G3→G4 while monitoring errors, latency, models, actual BYOK provider charges, token use, approval and Search verification; keep all paths on Gemini dynamic route | Four positive live workflow receipts plus negative fail-closed cases; existing E2E publication/search invariants verified, each lane has reversible direct-Gemini rollback, no half-migrated path |

### 4.1 Current P1/P2 implementation (2026-11-11)

- Local branch `feat/worldcons-ai-gateway-p2` contains P1 baseline `7b5dee3` and P2 code (not yet a live Worker deploy).
- Main Worker `AI` binding is configured, and the backend remains **`direct-gemini`** for all four lanes until explicit P4 cutover.
- Per-lane reversible Worker settings: `WORLDCONS_SUMMARY_BACKEND_G1` (incremental), `_G2` (scheduled/backfill), `_G3` (admin retries/batch), `_G4` (US private) accept `direct-gemini` or `cloudflare-ai-gateway`. They independently override the global `WORLDCONS_SUMMARY_BACKEND`.
- G3 admin retry uses the existing authenticated, audited job queue; the dynamic route refuses forced model overrides. G4 retains official-PDF/R2 verification, private review hold, immutable approval and publication guards.
- `/admin/llm` shows read-only route, four lane flags, last test result and actual returned model; an authenticated, CSRF-protected test performs a **real API call** only when explicitly clicked. Only sanitized test metadata is stored in the existing `worldcons_ops.llm_settings` document.
- Local integration tests, TypeScript, Vinext build and Wrangler dry-run validate wiring; P3 held-out full-document live quality tests and P4 Worker cutover remain **unperformed**.

### 4.2 Definition of done for four paths

- [ ] **G1** incremental per-article: official full text → dynamic Gemini summary → persisted translation → guarded E2E publication/search; missing text → no model call.
- [ ] **G2** backlog/batch: multiple eligible old/new Core articles → dynamic Gemini with bounded claims and retries; source-only case-catalog backfill never makes an implicit model request.
- [ ] **G3** manual: authenticated admin retries a single case and invokes bounded batch summarization; both use Gateway, preserve audit and do not bypass any approval.
- [ ] **G4** US private: verified official PDF/R2 and private hold → dynamic Gemini summary; publication, public Search and approval receipt remain untouched.
- [ ] Every above receipt includes route ID, actual provider/model where available, request ID, token/cost metadata if returned, and error classification; no keys, raw full-text or hidden vendor fallback in logs.
- [ ] Production `default` Gateway returns `byok_only: true` on final verification; DeepSeek is excluded from these four default chains.

Gateway route changes need explicit **version deploy**; simply editing route configuration does not activate a new version. Model order is governed by the Gateway route and **not duplicated** as a source-code list. Circuit-breaker budgets and retry limits must avoid amplifying four Gateway model attempts per application-level retry. Never silently move to another vendor to satisfy a single downstream task.

## 5. Rollback and scope limits

- Backend selection is a reversible feature flag; rollback points at existing direct-Gemini adapter while leaving protected publication/search D1 states unchanged.
- BYOK-only remains **on**, even during rollback. Reverting WorldCons's LLM backend must **not** disable global gateway BYOK policy or change WorldCase routes.
- No separate WorldCons Gateway is required for the initial cutover. If a dedicated Gateway is proposed later, BYOK-only and credential isolation must be verified independently before deployment.
- **P0** Gateway smoke checks succeeded with at least one valid JSON response; **P1/P2** have local implementation/test evidence. This document does **not** claim a deployed WorldCons Worker, successful live full-document G1–G4 traffic, or a P4 production cutover.

Official references: [Dynamic routing](https://developers.cloudflare.com/ai-gateway/features/routing/dynamic-routing/), [Workers AI Gateway binding](https://developers.cloudflare.com/ai-gateway/usage/worker-binding-methods/), [BYOK and credential precedence](https://developers.cloudflare.com/ai-gateway/features/unified-billing/), [Gateway logging](https://developers.cloudflare.com/ai-gateway/observability/logging/).
