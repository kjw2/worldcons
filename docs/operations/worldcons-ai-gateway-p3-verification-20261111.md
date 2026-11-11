# WorldCons P3 — held-out full-text Gateway and safety verification

Date: 2026-11-11 (Asia/Seoul). Branch: `feat/worldcons-ai-gateway-p3`.

## Result and interpretation

**Four authentic constitutional/supreme-court decision texts were read from the production Core D1 database with read-only SQL and submitted through the deployed Cloudflare AI Gateway dynamic route. All four returned HTTP 200, a parseable JSON object with the required WorldCons summary *field shape*, and Korean title/core points.** These tests deliberately wrote nothing to production D1, R2, public Search, approval ledgers or publication queues.

**This is evidence of the Gateway's real full-text inference capability, NOT proof of end-to-end invocation by a deployed G1/G2/G3/G4 WorldCons Worker.** The P1/P2 integration remains in a local, not-yet-deployed feature branch. The prompts used below followed the WorldCons summary field contract, but were compact test prompts rather than the exact versioned `SUMMARY_SYSTEM_PROMPT` and `buildSummaryUserPrompt` byte-for-byte. The remote JSON was checked for field presence/types by the probe rather than parsed by the repository's actual Zod `SummarySchema`. Human legal accuracy review and actual production-workflow receipts remain outstanding. **Do not declare P4 cutover GO from these results alone.**

## Grounded read-only samples

Each decision was selected from real `worldcons_core.articles`, with its persisted `content_hash`, original decision date, official URL, cleaned full text and (where present) prior Gemini-produced summary. The source text was used *inside* the test request, never committed to the repo, returned in the probe receipt or stored in Gateway request/response logging.

| Nominal lane | Court / sampled case | Full cleaned source | HTTP / actual returned model | API latency | Prompt / output tokens | Field-shape JSON |
| --- | --- | ---: | --- | ---: | ---: | --- |
| G1 | Germany, BVerfG decision of 15 Oct 2026, Core `afbbb6ef` | 6,547 chars | 200 / `gemini-3.5-flash-lite` | 45,515 ms | 2,386 / 1,020 | Yes; 3 core points |
| G2 | Spain, `AUTO 48/2026`, Core `864accea` | 11,798 chars | 200 / `gemini-3.1-flash-lite` | 35,950 ms | 3,320 / 978 | Yes; 3 core points |
| G3 | France, `2026-1230/1231 QPC`, Core `f252de7d` | 12,547 chars | 200 / `gemini-3.1-flash-lite` | 12,305 ms | 3,664 / 1,104 | Yes; 4 core points |
| G4 | United States, `Mullin v. Friends of the Ruidosa Church`, Core `20353a3d` | 7,911 chars | 200 / `gemini-3.5-flash-lite` | 10,440 ms | 2,475 / 1,036 | Yes; 3 core points |

Spain's generated JSON retained `48/2026`; France's retained the decision number and correctly used `프랑스 헌법위원회`; the US output correctly used `미국 연방대법원`. These spot checks do not establish that every proposition, citation or translation is correct.

Production Gateway route: `default/dynamic/gemini-flash-fallback`, deployed version `68dfaf5b-e13d-4467-969c-7a99f02351fd`; nodes in order: 3.8 Flash, 3.6 Flash, 3.5 Flash-Lite, 3.1 Flash-Lite. Verified `byok_only: true` and Gateway authentication enabled. Each matching Gateway log recorded `byok=default`, `wholesale=false`, `collect_log_payload=false` and a successful 200 response. Thus no Cloudflare Unified Billing was used for these probes, but upstream BYOK charges remain possible.

| Lane | Gateway log ID | Chat completion ID |
| --- | --- | --- |
| G1 | `01a1c81f-a803-71a5-b541-4727d20c4e29` | `ib7zat37LZbA1e8P67yE0QY` |
| G2 | `01a1c821-1cbf-761b-8932-856d98cebea3` | `4L7zarbqGemi9tMPvK78gAU` |
| G3 | `01a1c822-06fa-764a-b55d-9bb3ceac1714` | `BL_zaoXWJYn71e8Po7uwiQE` |
| G4 | `01a1c822-94f4-7347-bf52-5ec142a45e8c` | `Ib_zaq7XBaTMrfcPmNK06A8` |

All structured, sanitized per-case receipts and exact source hashes are in `tests/fixtures/ai-gateway-p3-20261111.json`.

## Privacy and publication verification

For the US real sample `20353a3d-af47-44de-baa3-98d8fca1bdde`, a post-probe **read-only re-query** verified:

- `status=metadata_only`, `summary_json=NULL`.
- `collection.publishable=false`, `review.required=true`.
- Zero `article_publications_p3` rows and zero `e2e_approval_evidence_v1` rows.

The US real inference was isolated and did NOT persist a private summary or modify lifecycle flags. Local D1 integration tests separately exercised actual private-mode claim, official-PDF/R2 verification, successful private write, idempotence, failed request rollback and human approval restriction with mocked Gateway responses.

## Repeatable repository safety checks

`tests/ai-gateway-p3.test.ts` verifies the distinct four-country receipts, provenance/date/hash, successful routing model and BYOK/no-payload constraints; exercises the exact shared `summarizeArticle` adapter (with synthetic long-text fixtures and an injected Worker AI mock) for each of the four *lanes*; rejects 429, 504, invalid JSON and secret-bearing upstream error content without hidden vendor retries; and checks the separate admin authorization and US private holds.

Other P1/P2 and existing staged-ingestion/private-case tests cover metadata-only zero model calls, deduplication, fencing/CAS, repeat delivery, authoritative separate publication/search and approval protection. **Mocked path tests are not live Worker receipts.** The actual 4-case Cloudflare probes, local full-schema mock tests, and existing production persisted baseline summaries are distinct evidence classes, not interchangeable proof of semantic equivalence.

## Remaining gates before P4

1. **Exact deployed Worker G1–G4 execution:** stage P1/P2/P3 code in an isolated environment, invoke each of the four actual entrypoints with safe D1/R2 fixtures, and capture source hash, route, actual returned model, result/error, durable status, publication and search receipts. No production D1 writes from P3 probes.
2. **Full production prompt/schema parity:** compare actual `summarizeArticle` output against the existing Gemini summary for representative full-text cases, parse with `SummarySchema`, inspect decision/case/date and provision references for unsupported inventions, and record human legal-review sign-off.
3. **Failure drills on the deployed integration:** unavailable source (zero AI requests), invalid JSON, provider timeout/429/5xx and duplicate delivery; prove retries stay bounded and private/approval status remains unchanged.
4. **Rollback evidence:** read back route, BYOK, four per-lane flags and service binding; establish clear rollback to direct Gemini without changing Search, publication or unrelated DeepSeek routes.

**P3 verdict:** four-country live Gateway inference **PASS**; local integration and regression checks **PASS**; exact deployed four-workflow and independent legal-quality checks **NOT YET VERIFIED**. **P4 production cutover: NO-GO pending those checks.**
