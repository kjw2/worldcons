# WorldCons AI Gateway P0 verification

Date: 2026-11-10
Repo HEAD: `63ee6cd9eed7bb1d4bd160ffa9c177063bf33a87`
Scope: P0 read-only smoke test of gateway `default`, dynamic route `gemini-flash-fallback`.
Result: **P0 validation run completed with additional Cloudflare MCP controller verification; readiness remains NO-GO because two planned models return 429 and full timeout/fallback trace parity is not established. Production traffic stays on direct Gemini.** The initial Grok-only assessment and its credential limits are preserved below; supplemental privileged controller evidence is in the addendum.

No WorldCons Worker, route, gateway setting, or provider key was changed. No code was deployed to `worldcons` or `worldcons-ingest`. Nothing was pushed.

## What was called

Authenticated `POST /accounts/c0975029797a404cd3ff402ee6a605b2/ai/v1/chat/completions` with Wrangler OAuth as the Cloudflare bearer token.

Request headers that matter:

- `cf-aig-gateway-id: default`
- `cf-aig-collect-log: true`
- `cf-aig-collect-log-payload: false`
- `cf-aig-skip-cache: true`
- `cf-aig-metadata`: `worldcons_p0=20261110`, `route=gemini-flash-fallback`

Body: `model` `dynamic/gemini-flash-fallback`, `temperature` 0, `max_tokens` 320, `response_format.type` `json_object`, and a short synthetic Korean administrative-law prompt. The prompt is not a real judgment.

The call returned HTTP 200 in 4433 ms of client time. Gateway log duration for the same request is 3747 ms. `finish_reason` is `stop`. The response was not served from cache.

## Response metadata

| Field | Observed value |
| --- | --- |
| Chat completion id | `ErvyasvaNo-M1e8Pu6GBuQg` |
| `cf-aig-log-id` / `cf-aig-event-id` / `cf-aig-request-id` | `01a1c42a-b81c-7157-ac14-74bdfef2f8a3` |
| `cf-aig-trace-id` | `b41211e106d54f068e3c5496c76d3b01` |
| `cf-auditlog-id` | `01a1c42a-b705-7979-a441-05431377d451` |
| `cf-ray` | `a58308c4cc9e8510-ICN` |
| API version | `2026-10-01.epoch` |
| Response `model` | `gemini-3.5-flash-lite` |
| Prompt tokens | 198 |
| Completion tokens | 130 |
| Total tokens | 328 |
| Log `provider` | `unknown` |
| Log `step` | 0 |
| Log `status_code` / `success` | 200 / true |
| Log `path` | `/run` |
| Log `authentication` | true |
| Log `byok` | `default` |
| Log `wholesale` | false |
| Log `cost` | 0 |
| Log `collect_log_payload` | false |
| Log request and response bodies | empty |
| Log metadata | `worldcons_p0=20261110`, `route=gemini-flash-fallback` |
| Log `updated_at` | `2026-11-10 06:35:00` |

`cost: 0` with `wholesale: false` means this request did not draw Cloudflare unified-billing credits. The BYOK provider can still charge for its own usage. The gateway log does not show a provider invoice.

The completion `model` and the log `model` are the bare id `gemini-3.5-flash-lite`. They do not include the `custom-gemini-openai/` prefix from the plan. The log provider is `unknown`, so this call does not by itself prove the custom-provider slug.

## JSON contract

The model returned one JSON object. Parsed keys are exactly `caseId`, `decisionDate`, `koreanTitle`, `holdingKo`, `statute`, and `topics`.

- `caseId` is `P0-SYNTH-001`.
- `decisionDate` is `2024-01-15`.
- `statute` is `공공기관의 정보공개에 관한 법률 제9조`.
- `topics` is `["정보공개"]`.
- `koreanTitle` is `정보공개 거부처분 취소소송` (14 characters; required 8–40).
- `holdingKo` is `행정청이 거부 사유를 제시하지 않고 정보공개 청구를 거부한 처분은 위법하다.` (42 characters; required 20–80).

This is the compact P0 probe schema. It is not the production `SummarySchema` in `lib/ai/schema.ts`. Full summary-schema parity remains a P1 gate.

## Authentication, BYOK, and stored credentials

Wrangler OAuth is valid for this account. `GET /user` and `GET /accounts/c0975029797a404cd3ff402ee6a605b2` returned 200. The token scopes include `ai:write` and `secrets_store:write`. They do not include an AI Gateway read or write scope. No `CLOUDFLARE_API_TOKEN`, `CF_API_TOKEN`, or `CF_AIG_TOKEN` is set in the process, user, or machine environment, and this worktree has no `.env` or `.dev.vars`.

These management reads returned HTTP 403, error code 10000, message `Authentication error`:

- `GET /ai-gateway/gateways`
- `GET /ai-gateway/gateways/default`
- `GET /ai-gateway/gateways/default/routes`
- `GET /ai-gateway/gateways/default/provider_configs`
- `GET /ai-gateway/gateways/default/logs`
- `GET /ai-gateway/gateways/default/logs/01a1c42a-b81c-7157-ac14-74bdfef2f8a3`

**`byok_only: true` was not re-read from the gateway API in this session.** The 2026-11-10 plan states that a previous session set and read it back. This session cannot confirm that the setting is still true.

What this session can confirm:

- The live request was authenticated (`authentication: true` on the log).
- The gateway selected BYOK alias `default` (`byok: "default"`).
- Wholesale / unified billing was not used (`wholesale: false`).
- Secrets Store `default_secrets_store` (`80cb518bdd2949839b8991f6cb5a5a91`) lists five active secrets scoped to `ai_gateway`. Names only, no values and no previews were read:
  - `default_gemini-openai_default`
  - `default_openai_default`
  - `default_opencode-go_default`
  - `default_commandcode_default`
  - `default_hive-ai_default`
- The same five names were still present after the probe. The list response has no secret value field.
- `worldcons` Worker secret names include `GEMINI_API_KEY`. That secret was not read and was not sent on this call. `worldcons-ingest` has no Worker secrets.

`default_gemini-openai_default` matches the documented BYOK name `{gateway}_{provider}_{alias}` for gateway `default`, provider slug `gemini-openai`, alias `default`. Provider-config records themselves were not readable.

## Model and fallback status

| Planned node | Observed in this probe |
| --- | --- |
| `custom-gemini-openai/gemini-3.8-flash` | Not observed. No separate success, failure, or timeout receipt. |
| `custom-gemini-openai/gemini-3.7-flash` | Not observed. |
| `custom-gemini-openai/gemini-3.6-flash` | Not observed. |
| `custom-gemini-openai/gemini-3.5-flash-lite` | The only model id returned. Log step 0, HTTP 200, gateway duration 3747 ms. |

Step 0 means this log entry is the first recorded step. No earlier failed attempt is in this log. Route configuration could not be re-read, so the plan's four-node order and 20 second timeouts were not re-verified.

Fallback was not observed. Timeout behavior was not probed. Forcing a first-node failure, a timeout, or a per-model call would require a route change or extra paid attempts. Those were not done.

DeepSeek was not called. The response model is a Gemini flash-lite id, and this probe did not target `dynamic/deepseek-flash-fallback`.

## Temporary log reader

The log-detail API returned 403, so a temporary Worker `worldcons-aig-p0-probe-tmp` was deployed with only an AI binding, used once to call `env.AI.gateway("default").getLog` for the log id above, and then deleted with `wrangler delete --force`.

- Upload version during its lifetime: `726aae13-a29e-47be-ab39-bf3f8e5abb99`
- URL host was `worldcons-aig-p0-probe-tmp.cclib.workers.dev`
- No custom route and no change to the `worldcons` script
- After delete, `GET /workers/scripts/worldcons-aig-p0-probe-tmp` returned 404, error 10007, `This Worker does not exist on your account.`

The Worker returned sanitized log fields. Request and response payload fields were empty because `cf-aig-collect-log-payload: false` was honored. Token counts in the report come from the chat-completion `usage` object. The log also had numeric `tokens_in` and `tokens_out`, but the redaction filter dropped every field whose name contains `token`, so those log numbers are not repeated here.

## P0 acceptance

| Criterion | Result |
| --- | --- |
| Authenticated call to `dynamic/gemini-flash-fallback` on `default` | Met. HTTP 200, log authentication true. |
| Short Korean legal JSON, strict schema, required length | Met for the compact probe schema above. Production `SummarySchema` was not exercised. |
| Actual provider and model | Model `gemini-3.5-flash-lite` at step 0. Provider logged as `unknown`. |
| Token use, latency, Cloudflare request id | Met. See the metadata table. |
| Redacted log | Met for this request. Payload collection was off and stored bodies are empty. |
| Gateway `byok_only: true` read back from the API | Not met. Management API returned 403. The request did use BYOK alias `default` and did not use wholesale billing. |
| Stored credential exists without exposing it | Met for secret name `default_gemini-openai_default`, status `active`, scope `ai_gateway`. Provider-config API was not readable. |
| Forced first-node failure and fallback receipt | Not met. Not attempted. |
| Timeout behavior | Not met. Not attempted. |
| Each of the four model nodes verified | Not met. Only `gemini-3.5-flash-lite` was observed. |
| Production traffic stays put when a guard fails | Met. No WorldCons cutover, deploy, or gateway write. |

Offline contract checks live in `tests/ai-gateway-p0-probe-contract.test.ts` and run with `pnpm test:ai-gateway-p0`. They check the probe schema, redaction, and that this receipt does not authorize cutover. They do not call Cloudflare.

## Limitations

- Gateway `byok_only` was not confirmed in this session.
- The live route graph, node order, retries, and per-node timeouts were not confirmed in this session.
- `gemini-3.8-flash`, `gemini-3.7-flash`, and `gemini-3.6-flash` have no new health evidence.
- No fallback and no timeout were exercised.
- The successful model id does not include the custom provider prefix, and the log provider is `unknown`.
- One small BYOK inference was made. Gateway `cost` is 0. Provider-side Gemini billing is outside this log.

## Addendum — Cloudflare MCP controller verification, 2026-11-10

The Grok 4.7 CLI credential lacked permission for the AI Gateway management APIs. The ChatGPT controller independently performed **Cloudflare MCP** GET calls with its own connected Cloudflare authorization. This is separate provenance, not evidence that Grok's OAuth permissions changed.

1. **Gateway:** GET `default` confirmed `byok_only: true`, `authentication: true`, the previously verified Secrets Store binding and no change to existing gateway settings.
2. **Original route:** GET confirmed `gemini-flash-fallback` route ID `5fb41e42-131a-42db-9ab8-6e9662c0f332`, active version `cf5d2285-d758-4475-b917-5715dec350f2` and deployment `f21efcf2-c0e6-4c01-a8d9-c5f2f7ddd57f`. The deployed 3.8 → 3.7 → 3.6 → 3.5 Flash-Lite chain retains 20,000 ms per node and 0 per-node retries.
3. **Positive main-route probes:** independent real calls returned `gemini-3.6-flash` (HTTP 200 but empty content on a low-output-token test) and `gemini-3.5-flash-lite` (HTTP 200, valid JSON `{"ok":true,"country":"KR"}`, 24 input + 9 output tokens and ~5.5 seconds). The initially empty response is an important application-level validation negative case: HTTP 200 alone is insufficient.
4. **Controlled failure fallback:** a separately named, temporary route `worldcons-p0-fallback-20261110` was created and deployed with a deliberately invalid first model followed by known-good `gemini-3.5-flash-lite`. The final inference returned **HTTP 200**, valid JSON `{"ok":true}`, model `gemini-3.5-flash-lite`, **19 input + 5 output tokens**, ~2.1 seconds. The route was deleted; the original route graph was untouched.
5. **Timeout-configured fallback:** another isolated temporary route `worldcons-p0-timeout-20261110` used a 1 ms first-node timeout on `gemini-3.6-flash`, followed by 3.5 Flash-Lite at 20,000 ms. Gateway log `01a1c433-0e45-71b1-83e1-be21d397ae1e` confirms final model `gemini-3.5-flash-lite`, **HTTP 200**, BYOK alias `default`, no wholesale billing, 11 input + 6 output tokens, and duration 2211 ms. This demonstrates success under the timeout-configured routing graph; the log did not separately expose the reason the first node failed, so a precise timeout error is **not** claimed.
6. **Isolated model-node probes:** temporary single-model routes each used the same custom provider and were deleted after testing. The 3.8 and 3.7 nodes each returned **HTTP 429**, Cloudflare error `7003`, `Model execution failed (Error)`; their failure logs identify `provider: custom-gemini-openai`. A 3.6-only route returned **HTTP 200**, model `gemini-3.6-flash`, 17 input + 5 output tokens. The 3.5 node is independently confirmed by the main and fallback routes. These are **observed errors at the test time**, not proof that the model IDs are universally invalid or that the cause is a provider quota versus another failure.
7. **No leftover configuration:** Cloudflare MCP listed exactly the original three routes `worldcase-fr-backfill`, `gemini-flash-fallback`, `deepseek-flash-fallback` after the tests. The original Gemini route remained active at the same version; its definition and gateway BYOK setting were not modified. Grok's one-time Worker was also independently reported deleted.

### Consolidated P0 acceptance verdict

| Gate | Final P0 result |
| --- | --- |
| Authenticated inference on actual default dynamic route | **PASS** |
| BYOK-only enforced and checked by management API | **PASS**, controller MCP |
| Original four-node route and deployment verified | **PASS**, controller MCP |
| Korean legal JSON probe, identity/date/length checks | **PASS** for small synthetic probe, Grok 4.7 |
| Actual returned model, trace/request ID, usage, latency | **PASS** for observed successful requests |
| Controlled first-node failure and fallback | **PASS** on isolated temporary route; not a forced outage of the shared production route |
| Timeout-configured fallback | **PARTIAL** — isolated test returned through fallback, but failure reason unavailable |
| Model-by-model healthy JSON responses for all four registered nodes | **FAIL** — 3.8 and 3.7 returned HTTP 429, 3.6 and 3.5 returned HTTP 200 |
| No live WorldCons traffic or permanent config changes | **PASS** |

**Operational conclusion:** P0 tests and documentation are complete, but the migration cutover gate is **NO-GO** until 3.8/3.7 provider errors are resolved or those nodes are removed/replaced by separately approved healthy models and the active route is retested. Do not silently change the existing shared route or enter P1 production rollout. Any remediation must preserve `byok_only: true` and exclude an implicit DeepSeek fallback.
