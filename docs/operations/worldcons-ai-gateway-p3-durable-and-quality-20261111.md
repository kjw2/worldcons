# WorldCons P3 — Durable Workflow and Legal Quality Follow-up

Date: 2026-11-11 KST. Branch: feat/worldcons-ai-gateway-p3.

## Local durable integration (in-memory SQLite / D1-compatible)

Tests exercise the real summary adapter, SQL claim/write and lifecycle code. Only the external AI response and object-store data are mocked. This is **not proof of remote Worker/D1/R2 production E2E**.

- G1: real runD1SummarizeArticle -> summarizeArticle -> mocked AI binding -> durable SQL write. Provider/model recorded. A source=ingest duplicate replay makes zero additional AI requests and never publishes.
- G2: real runD1SummaryDrain -> actual SQL write. Duplicate scheduled work makes zero additional AI requests, with no publication.
- G3: runD1AdminReviewAction -> worldcons_ops admin_jobs insert -> runNativeAdminJobDrain claim/execute/mark succeeded -> actual single-article summary. Duplicate admin enqueue converges to the same job. Manual model overrides are rejected before enqueue; Gateway jobs explicitly use provider=cloudflare-ai-gateway and model=null.
- G4: real runD1PrivateUsSummary verifies the mock R2 PDF signature and matching SHA-256, persists a private summary and model provenance, and retains publishable=false and review.required=true. Zero approval, publication or Search rows; repeated requests make zero new AI calls.
- Negative drill: HTTP 429 makes one AI request, stores no summary or publication and does not leak the upstream error text or API credentials to D1.

## Actual isolated remote Worker inference and legal observations

The disposable Worker has only an AI binding, with unique random bearer authentication, and is deleted after testing. Source texts were read from production D1 via read-only queries and sent to this Worker. The Worker has no remote D1/R2/Search write bindings.

At approximately 13:50 KST on Nov 11, Germany G1 and US G4 returned HTTP 200 with real source texts and correct JSON schemas. Both used Gemini 3.5 Flash-Lite, but the German output still contained poor transliterations of Asyl and Senat: Korean words "아스일" and "제2센트". The initial structural/semantic audit did not catch these, demonstrating that even an audit pass cannot be treated as legal correctness approval.

Added specific term checks and stronger legal attribution and German terminology instructions to the versioned prompt. At about 13:53 KST the 6,547-character German decision was rerun via an isolated remote Worker: HTTP 200, Gemini 3.6 Flash, 3 core points, schema pass, original-title preserved, and the deterministic audit returned pass. Neither problematic term appeared in that particular completion. **This is one improved sample, not general legal accuracy proof.**

Cloudflare Gateway management read-back confirmed unchanged four-node Gemini route, BYOK-only and authentication enabled. Recent verified Gemini requests showed collect_log_payload=false and wholesale=false. No production Worker or D1 mutations occurred during this live testing.

## Deterministic pre-cutover quality audit

lib/ai/legal-evidence-audit.ts returns stable reason-code findings only; it never returns source text or output text. It flags:

1. Official title drift, source-unsupported case identifiers and missing Korean summary.
2. Child/minor claims not supported by the original language text.
3. Observed incorrect German transliterations for Asyl and Senat.
4. Unverifiable long statutory reference numbers, requiring human review.
5. US court-versus-party constitutional-claim attribution, requiring human review.

The audit is active only in the disposable **staging** Worker and causes the staging script to fail on any non-pass status. It is **not installed as a production automatic publication gate**. The audit always returns legalAccuracyVerified=false: a clean result is insufficient for publication approval.

## P4 release gates still open (updated after remote durable test)

- No production cutover: all G1–G4 Worker backend flags remain direct-gemini in this branch; no production deployment or push has been performed.
- **Completed Nov 11**: G1/G2/G3/G4 real remote D1 Core/Ingest/Ops, real R2 for G4, genuine Gateway calls, idempotent replay, injected HTTP 429 drill and verified resource cleanup. See worldcons-ai-gateway-p3-remote-durable-20261111.md. Staging source texts and the PDF were synthetic, not verified judicial originals.
- An independent legal reviewer must confirm outcomes, citations, parties, court holdings and procedural posture of all four representative decisions against official source text before the quality gate is signed off.
- Replay/idempotency is verified remotely; mid-flight crash recovery and final production rollback drill are still open.

**P3 conclusion: local durable, remote inference and remote durable G1-G4 subgates PASS; independent legal accuracy and operational production rollback subgates OPEN. P4 cutover NO-GO.**
