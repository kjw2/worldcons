# WorldCons P4 — legacy ingest-to-Gateway RPC compatibility, 2026-11-17

## Diagnosis

- Production `worldcons-ingest` v127 (`edd2ecf1-1157-453d-9ab8-1a91a7208d6d`) was deployed 2026-11-10 04:09 UTC, before `source: "ingest"` and `source: "scheduled"` were added to the repository's RPC call sites later that day.
- The main `worldcons` v119 had all five Gateway flags enabled, but its service methods passed the optional `input.source` straight to `resolveSummaryGateway`. That resolver intentionally returns `undefined` on a missing lane, selecting direct Gemini instead.
- The 2026-11-17 06:00 KST discovery run produced successful processing, including 11 newly saved summaries (10 ES, 1 DE). Core D1 `translation_provider` and embedded `aiMetadata.provider` were `gemini` for all 11, with no matching Gemini Gateway logs. This is not evidence of a successful production Gateway inference.

## Preserved ingest deployment

- Inactive candidate `worldcons-ingest` v128 (`69323e26-a4fc-48ed-8e4a-c112a12fd33b`) was uploaded but **never deployed**.
- API binding diff identified that production v127 had nine Workflow bindings, while v128 had eight; the missing binding was `SPAIN_INCREMENTAL_RECOVERY_WORKFLOW` (`worldcons-spain-incremental-recovery-v1`, `WorldconsSpainIncrementalRecoveryWorkflow`). The workflow currently had zero historical instances, but its capability must not be silently removed. The checked-out repository does not contain this class.
- Keep v127 at 100% until its extra workflow can be safely reconciled. No reprocessing, trigger changes, or changes to its service bindings were performed.

## Compatible main Worker change

- In `WorldconsOpsService.runSummaryArticle`, use `input.source ?? "ingest"` when resolving the Gateway.
- In `WorldconsOpsService.runSummaryDrain`, use `input.source ?? "scheduled"` when resolving the Gateway.
- This service-method-local fallback supports legacy RPC callers without weakening the strict `resolveSummaryGateway(env, undefined)` contract for unrelated code paths. Existing per-lane backend flags, no-direct-fallback gateway policy, legal evidence audit and US private hold remain in force.
- Updated the stale M8 test to expect `source: "scheduled"` and added a targeted legacy-call regression test.

## Verification and production receipt

- Targeted tests **51/51 passed**, `pnpm typecheck` passed, `pnpm build:vinext` passed, and generated main-Worker Wrangler version-upload dry run passed.
- Uploaded main Worker v120: `848347f6-8626-4b1e-b794-131e68ca4950`. Version API compared v119/v120: **68/68 bindings matching**, including 12 secrets, 4 D1, AI, R2, assets, Images, Vectorize and Durable Object; no missing, new or changed bindings.
- Canary 1% deploy: `24b05697-1370-4cab-8842-7c1a636a011e`. HTTP homepage and MCP health both responded 200 during canary.
- Full deploy: `70c2c739-1e6a-4262-b92c-bb62f32d1de3` at 2026-11-17 10:33:13 UTC. Cloudflare API readback showed v120 at **100%** and `worldcons-ingest` v127 still at **100%**.
- Post-deploy readback: zero new Core summaries after canary, zero `summarizing` Core rows, zero pending/leased/failed ingest-stage jobs, and the US case remains `metadata_only` and `needs_triage`.
- No browser, manual publication approval, forced resummary or Gateway route modification was used. A temporary local C3 scaffold accidentally created during remote-source recovery was removed without deployment.

## Evidence boundary and rollback

- **Gateway lane compatibility is deployed and statically/integration-tested, not yet confirmed by a fresh production model response.** A new eligible article must subsequently show `translation_provider=cloudflare-ai-gateway` and the correct D1/legal evidence receipts before G1 can be marked operationally validated.
- Roll back the **main** Worker to known-good v119 (`8e07b65d-47f6-4318-8e7b-b60e081d2d5a`) if v120 causes a regression. Note that v119's legacy source-less RPC calls return to direct Gemini; this is not a Gateway-successful state.
