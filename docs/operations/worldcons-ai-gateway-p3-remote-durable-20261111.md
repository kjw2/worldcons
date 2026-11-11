# WorldCons P3 — Isolated Remote D1/R2 Durable Integration Verification

Date: 2026-11-11 KST. Branch: feat/worldcons-ai-gateway-p3.

## Scope and isolation

This is a remote Cloudflare Worker + remote D1 + remote R2 + real AI Gateway integration canary for the existing P3 summary entrypoints. It is NOT a production article/source/approval workflow, and the production Worker was never switched to Gemini Gateway.

The one-time harness tests/staging/run-p3-remote-durable.mjs created three dedicated D1 databases (Core, Ingest, Ops), one dedicated R2 bucket, and one Worker authenticated by a random 256-bit token. The unique staging prefix was worldcons-p3-remote-9ebfef650e. It initialized the D1 resources with the complete versioned source SQL (11 Core files, 6 Ingest, 2 Ops files) and bound ONLY those resources plus AI to the disposable Worker.

**All article source texts were synthetic fixtures, not production originals.** The authentic production functions for G1/G2/G3/G4 were invoked against the actual remote Cloudflare resources and the actual Gemini Gateway. The test AI wrapper counted requests but passed real calls unchanged to env.AI.run. No public-judgment, publication, Search projection, automatic release of private US cases, or actual human approval actions were invoked.

For G4, test bytes beginning with %PDF-1.7 were written to a real R2 bucket. An SHA-256 digest was attached to the synthetic official-URL metadata, and the existing R2 existence/signature/hash gate accepted the bytes. This proves object transport and checksum consistency, **not** the authenticity of a real Supreme Court PDF.

## Actual remote durable results

| Lane | Real entrypoint | Gateway model | Assertions |
| --- | --- | --- | --- |
| G1 incremental | Single article SQL claim, Gemini, verified summary SQL write | Gemini 3.5 Flash-Lite | Actual provider/model, original title preserved, zero publication/outbox/approval rows |
| G2 scheduled | D1 candidate selection and summary drain | Gemini 3.6 Flash | One summary persisted, zero publication/outbox/approval rows |
| G3 admin | Ops D1 job queued, claimed, dispatched, succeeded, and Core D1 summary persisted | Gemini 3.6 Flash | One claimed/one succeeded/zero failed, zero publication/outbox/approval rows |
| G4 US private | Remote R2 PDF signature/hash checked; private D1 claim and summary write | Gemini 3.6 Flash | status summarized, review_state needs_review, publishable=false, review.required=true, zero publication/outbox/approval rows |

Replaying each of the four operations caused **zero additional AI calls**. G1 returned skipped, G2 performed no additional candidate work, G3 found no new queued job and G4 returned already_summarized.

**Negative error test:** a deliberately injected provider HTTP 429 on a fifth synthetic German case generated one attempted call, no saved summary, no publication, no exposed API key in D1 metadata, and review_state retry_later. This is an injected failure test, not evidence that live Gemini was rate-limited.

Cloudflare management logs around 2026-11-11 09:12–09:14 UTC corroborated successful HTTP 200 Gemini 3.5 and 3.6 calls, BYOK=default, wholesale=false, collect_log_payload=false. The four-model production Gateway route remained unchanged at version 68dfaf5b-e13d-4467-969c-7a99f02351fd.

## Cleanup verification

The harness deleted its R2 test object, temporary Worker, R2 bucket and all three temporary D1 databases. The Cloudflare management API then confirmed the three named D1 databases and the named R2 bucket were absent. The named Worker script also could not be retrieved. **No test resource remained.** Production D1, R2, Worker, Gateway configuration and the direct-gemini feature flags were unchanged.

## P4 cutover gate

Remote durable G1–G4 tests now PASS on a dedicated synthetic test cohort, including idempotent replay and a bounded injected 429 error. This supersedes the earlier statement that fully remote durable G1–G4 tests had not been performed.

Remaining: independent legal-review signoff on real court documents and their Korean summaries (disposition, citations, party allegations versus holdings, court panel, parties and dates); and final controlled production canary and rollback rehearsal. A clean heuristic legal quality audit never certifies substantive accuracy. Mid-flight crash/recovery was not exercised. The G4 synthetic PDF does not prove official-source provenance.

**Verdict: P3 remote durable PASS; P4 production cutover remains NO-GO until the outstanding legal-quality and operational rollout gates are satisfied.**
