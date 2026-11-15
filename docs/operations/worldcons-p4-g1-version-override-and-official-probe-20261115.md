# WorldCons P4 G1: version override and isolated official-source probe

Date: 2026-11-15 KST. Branch: feat/worldcons-ai-gateway-p3.

## Actual 0-percent version override / rollback (PASS)

- Original production Worker 114 ID 88665194-9712-4246-93c0-1233a09fbf52; inactive G1-only Worker 116 ID ac4d2176-b462-43d7-89d2-b06bd9978ba5.
- Cloudflare deployment b6d6f858-7c1d-4dcb-9ff5-239573012843: 114 at 100% ordinary traffic, 116 at 0%. This is a reversible configuration change, not a production G1 model cutover.
- Targeted HTTP GET requests used the Cloudflare-Workers-Version-Overrides header specifying the Worker version. Normal and explicitly targeted 114 homepage responses had identical SHA-256 hashes. Targeted 116 returned HTTP 200 and a different homepage hash. HTTP MCP health checks also returned 200.
- Version overrides target HTTP fetch invocations and DO NOT target service-binding RPC methods. The requests did not call the real runSummaryArticle RPC. No per-invocation version-ID receipt was available in the HTTP responses.
- Actual rollback deployment 36c43641-b326-40f5-8feb-a0fa217ca0be restored 114 alone at 100%. Cloudflare confirmed the state.

## Actual German court text and direct Gemini Gateway inference (PARTIAL)

- Read-only production D1 supplied official BVerfG 2 BvR 1735/26 cleaned text of 6,547 characters. The source is publicly available from the issuing court. No production D1 mutation.
- Direct Gateway API inference used the existing default dynamic/gemini-flash-fallback route with payload logging disabled on the request. It succeeded using gemini-3.5-flash-lite; request ID vY35atCSJN2t1e8P4rjV6AU; about 26 seconds, 2,236 prompt and 402 completion tokens.
- Parseable JSON returned four Korean core points. In this sample, the erroneous direction "독일로의 송환" and mistransliterations "아스일" and "제2센트" were absent.
- The output DID NOT preserve the original title exactly and appeared to assert the applicant's reported Somali nationality without the source's "nach ihren Angaben" qualification. These trigger legal-quality follow-up, not approval.
- The direct API call used a compact test prompt, NOT the full application SUMMARY_SYSTEM_PROMPT and NOT the persistent G1 Worker path. It did not save a production summary or approval.

## Remote durable official-source G1: BLOCKED

- A 7,255-character excerpt was fetched again via HTTP 200 from the official court for isolated staging. The disposable P3 Worker and runner were extended to accept an authenticated official-G1 fixture, run the real G1 summary function, verify a temporary D1 write and replay, and return content-free model/audit receipts.
- Local Wrangler D1 creation failed before producing any database ID, so staging stopped before an actual Gateway call or summary write. The trial suffix was worldcons-p3-remote-1a2f6aa620.
- A follow-up Cloudflare API search found no D1 database, R2 bucket or Worker with that prefix. No leftover remote staging resources and no production mutations were observed.
- Full local typecheck and regression-test commands repeatedly stalled without test results and were interrupted. The latest changed code has NOT passed the complete test suite; do not promote it.

## Local code changes pending verification

- Staging official-source G1 fixture support and a cleanup fix to skip deletion requests for resources not confirmed as created.
- New legal audit reason applicant_nationality_attribution_review for source statements reported by the litigant but asserted as independently established nationality in Korean.
- Summary prompt requires exact originalTitle preservation and qualification of applicant-reported nationality. Added focused regression test for the nationality attribution.

**Decision: HTTP version-selection and actual rollback PASS; direct isolated Gemini inference PARTIAL; full official-source durable G1 model/storage proof and human legal approval OPEN. Worker 114 continues to handle 100% of production traffic, all four summary lanes direct Gemini. Candidate 116 remains inactive.**

**Later 2026-11-15 update:** the transient Wrangler problem cleared. A fresh isolated Cloudflare Worker and three D1 databases successfully executed the genuine German official-source G1 handler end-to-end: actual Gateway model gemini-3.5-flash-lite, D1 summary persisted with valid schema/title, replay did not repeat inference, publication/approval tables remained empty, and all temporary resources were deleted and independently checked. Latest code passed 106 regression tests, typecheck and Vinext build; improved candidate 117 was uploaded inactive. See worldcons-p4-g1-real-durable-staging-20261115.md. This update supersedes the earlier BLOCKED staging status but does not authorize a production cutover.
