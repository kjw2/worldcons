# WorldCons P3: native Cloudflare Worker/Gemini Gateway integration and legal QA

Date: 2026-11-11 (Asia/Seoul).
Repo: `F:\dev\worldcons`; branch: `feat/worldcons-ai-gateway-p3`.

## Scope / separation

Verified the **actual Workers AI binding**, the versioned production `summarizeArticle` prompt, shared Gateway adapter, `SummarySchema`, and all four *nominal lane selections* against four actual decisions read from production D1 **read-only**. Tests ran in a disposable Worker with a unique random Worker name and 256-bit bearer token; **no production D1/R2/Search bindings**. The staging Worker always executed an isolated stateless summary and never called the production G1 incremental job, G2 claim/drain, G3 authenticated admin job queue, or G4 private PDF/R2 lifecycle method. The production `worldcons` and `worldcons-ingest` Workers, D1 data, Gateway route, production flags, and publication/search indexes were not modified. **These are native Worker inference integration receipts, NOT four production workflow E2E receipts.**

The staging Worker `tests/staging/p3-native-ai-worker.ts` can be redeployed temporarily by `node tests/staging/run-p3-remote-stage.mjs`: the script reads exact article IDs via Wrangler D1 read-only SQL, deploys an authenticated Worker with AI binding only, tests each lane, prints limited summary review data, then deletes the Worker in `finally`. The generated temporary config containing the one-time auth token is deleted. Never commit it, deploy it as the production Worker, or bind writable production D1/R2 to it.

## Real native Worker results

| Lane | Official court / selected case | Source | HTTP | Returned model | Elapsed | Zod | Core points |
| --- | --- | ---: | --- | --- | ---: | --- | ---: |
| G1 | Germany, BVerfG 15 Oct 2026 `afbbb6ef` | 6,547 chars | 200 | Gemini 3.1 Flash-Lite | 13.6 s | pass | 3 |
| G2 | Spain, AUTO 48/2026 `864accea` | 11,798 chars | 200 | Gemini 3.5 Flash-Lite | 6.2 s | pass | 3 |
| G3 | France, 2026-1230/1231 QPC `f252de7d` | 12,547 chars | 200 | Gemini 3.5 Flash-Lite | 11.9 s | pass | 3 |
| G4 | US SCOTUS Mullin, private case `20353a3d` | 7,911 chars | 200 | Gemini 3.5 Flash-Lite | 31.5 s | pass | 3 |

All calls used the same `default/dynamic/gemini-flash-fallback` dynamic route, distinct source URLs, official titles, dates, and original-language full text. No application-level vendor switching. Old records had 3 existing core points in Germany, Spain and France; the US case had no existing summary and retained its private hold. US private Core D1 remained `metadata_only`, `summary_json=NULL`, `publishable=false`, `review.required=true`, zero publication and approval rows; staging never wrote it.

An earlier synthetic German case sent from a separate ephemeral Worker also returned native binding 200, Gemini 3.6 Flash, strict Zod pass. After the log safety change, a second *real* German full-text canary returned 200, Gemini 3.1 Flash-Lite in 13.1 s, schema pass, 3 core points. All named staging Workers were removed at the end of their respective tests. All four original model nodes remain configured in production Gateway; one successful node suffices for the routing P0 contract.

## Findings and remediation

1. **JSON repair gap**: a read-only direct REST call using the full production-style prompt returned a nonparseable JSON response. The old Gateway adapter failed immediately with `summary_gateway.invalid_json` and did not reach the existing semantic repair. Implemented a single bounded JSON repair attempt using the **same** dynamic Gateway, with existing `SUMMARY_SYSTEM_PROMPT` and `buildRepairPrompt`; accept a plain fenced JSON object without a paid second request. Invalid/empty JSON and upstream errors still fail closed; no DeepSeek/OpenAI vendor fallback.
2. **Severe logging privacy gap**: native `env.AI.run` calls initially inherited Gateway payload logging and stored actual official full texts and responses. Added `extraHeaders: { "cf-aig-collect-log-payload": "false" }` to every Gateway adapter call (including repair). A live 6,547-char official German test then returned HTTP 200 with log ID `01a1c851-c17c-7655-a33f-8a60bd99d890`, `collect_log_payload=false`, `byok=default`, `wholesale=false`. Seven *specific* test log IDs with payloads were individually filtered and deleted via Cloudflare management API, and re-query verified **zero remaining records** for those seven IDs. No unrelated AI Gateway logs or settings were deleted.
3. **Source identity drift**: the G3 French model paraphrased the original multi-line title, resulting in `originalTitlePreserved=false`. Fixed finalization to retain the immutable `article.originalTitle` for Gateway-produced summaries; added a focused three-line French decision number/title test. The correction is locally verified but has not been re-tested on the actual live French text.
4. **Legal quality problem, not solved by Zod**: the first G1 German output introduced the phrase “신속 아동/망명 절차”, although the German original has no reference to a child (neither `Kind` nor `minderjähr`). The repeat G1 result no longer included this error, proving response variability, not that factual accuracy is fixed. Spain's recusal outcome and France's insurance-premium freeze invalidity were consistent with existing Korean summary baselines; US stay disposition and IIRIRA §102 issue broadly matched source, but the output cited U.S. Constitution Article I §1, which appears in the text as **respondents' claim**, not necessarily as the Court's adopted holding. Human legal review and reference attribution remain required before publishing new translated summaries.
5. **Local-dev limitation**: the Wrangler local AI remote-proxy returned an immediate inference error, while actual authenticated remote Worker binding successfully invoked the same Gateway. The remote environment is the authoritative deployment-path check.

## Safety, limits and P4 gate

- No production source, approval, publication, R2 or Search mutation; staging Worker owns none of these bindings.
- G1–G4 are verified through a **real Worker binding + shared summary adapter** but not through their separate original durable entrypoints. Local D1 fixtures with mocked AI cover private restrictions, idempotency, CAS, replay and errors.
- Actual model and Gateway request log IDs are corroborated by the gateway; BYOK true, no Cloudflare Unified Billing on canary calls; upstream Gemini BYOK provider charges may apply.
- Need isolated **actual durable G1/G2/G3/G4 entrypoint** E2E against throwaway D1/R2 data or safe staging copies, comparison against the old summary with explicit independent legal-quality sign-off, plus 429/504/invalid schema failure and user-visible rollback verification before P4.

**Verdict**: native Worker four-lane inference **PASS**, shared schema **PASS**, post-fix payload suppression **PASS**, legal correctness **open QA risk**, durable four-path E2E **not tested**. **P4 production cutover is NO-GO**. Do not change production `direct-gemini` flags yet.
