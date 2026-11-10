# WorldCons AI Gateway migration — Gemini dynamic routing by default

Date: 2026-11-10
Status: **Plan approved by owner; implementation and production traffic cutover NOT performed.**
Priority: P0 authentication and routing contract; P1 shared adapter; P2 administration; P3 staged validation and production cutover.

## 1. Binding decision and current verified state

**WorldCons summarization/translation defaults to the existing Cloudflare AI Gateway dynamic route `dynamic/gemini-flash-fallback` on gateway `default`, not to DeepSeek.** DeepSeek is a separately managed, non-default candidate that MUST NOT be silently inserted into this default summarization chain. No automatic Gemini -> DeepSeek application-level fallback is authorized by this plan. A future explicit policy change is required to use DeepSeek in this workflow.

On 2026-11-10 the Cloudflare MCP API updated the account's sole existing AI Gateway `default`: `byok_only: false -> true`. GET after PUT verified `byok_only: true`, `authentication: true`; other gateway settings and Secrets Store ID were unchanged. This gateway-level control covers every currently deployed dynamic route on this gateway (`gemini-flash-fallback`, `deepseek-flash-fallback`, `worldcase-fr-backfill`), not only WorldCons. It prevents implicit fallback to Unified Billing when no applicable customer-provided provider credential exists; provider-key errors can still fail the request, and BYOK providers may still charge for their own usage. New gateways, if created later, MUST independently enable and verify `byok_only: true` before receiving traffic.

Verified deployed `gemini-flash-fallback` nodes, each timeout **20,000 ms** and `retries: 0`:

1. `custom-gemini-openai/gemini-3.8-flash`
2. `custom-gemini-openai/gemini-3.7-flash`
3. `custom-gemini-openai/gemini-3.6-flash`
4. `custom-gemini-openai/gemini-3.5-flash-lite`

This is a live *route configuration*, not proof all four nodes work. Before cutover, run authenticated read-only model and fallback probes. The `default` gateway currently has five stored provider keys, including `gemini-openai` under the `default` alias, but key registration alone does not prove successful inference. Existing unrelated Gateway route configurations must not be changed.

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
| **P1: Core adapter** | Main Worker AI binding, shared adapter and all `runSummary*` paths; gate via config flag, keep direct Gemini as explicit rollback | Typecheck, no-secret-leak tests, code searches show no remaining hard-coded Gemini in automatic/administrator selection, schema parity fixtures |
| **P2: Admin & control plane** | `/admin/llm` shows `cloudflare-ai-gateway` backend, gateway ID, selected `dynamic/gemini-flash-fallback`, dynamic route health and actual model from latest call; restrict configuration to allowlisted gateways/routes | Auth, config-read/write and dry-run test coverage; old provider key encryption remains compatible; no plain text BYOK key storage |
| **P3: Staged quality and safety** | Run 10+ held-out official cases across Spain/France/Germany/US (only with valid full text), compare against current Gemini output; test unavailable source, malformed JSON, route outage, delayed timeout and repeated job | Original case identifiers, dates, citations, official links preserved; metadata-only causes **zero** LLM requests; no unauthorized publication; immutable P3 unchanged |
| **P4: Controlled cutover** | Gradual settings/feature-flag traffic progression; monitor error, latency, model, request cost and E2E publication; roll back to direct Gemini on failed gates | Live end-to-end batch including staging→approval→search verification, recovery/rollback rehearsed, existing deployments remain available |

Gateway route changes need explicit **version deploy**; simply editing route configuration does not activate a new version. Model order is governed by the Gateway route and **not duplicated** as a source-code list. Circuit-breaker budgets and retry limits must avoid amplifying four Gateway model attempts per application-level retry. Never silently move to another vendor to satisfy a single downstream task.

## 5. Rollback and scope limits

- Backend selection is a reversible feature flag; rollback points at existing direct-Gemini adapter while leaving protected publication/search D1 states unchanged.
- BYOK-only remains **on**, even during rollback. Reverting WorldCons's LLM backend must **not** disable global gateway BYOK policy or change WorldCase routes.
- No separate WorldCons Gateway is required for the initial cutover. If a dedicated Gateway is proposed later, BYOK-only and credential isolation must be verified independently before deployment.
- This document is a **plan**. It does not claim the dynamic route was smoke-tested for WorldCons, code was migrated, or production WorldCons LLM traffic was cut over.

Official references: [Dynamic routing](https://developers.cloudflare.com/ai-gateway/features/routing/dynamic-routing/), [Workers AI Gateway binding](https://developers.cloudflare.com/ai-gateway/usage/worker-binding-methods/), [BYOK and credential precedence](https://developers.cloudflare.com/ai-gateway/features/unified-billing/), [Gateway logging](https://developers.cloudflare.com/ai-gateway/observability/logging/).
