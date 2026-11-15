# WorldCons P4 — official German decision, real G1 Gateway + durable D1 canary

Date: 2026-11-15 (KST). Repository: F:\dev\worldcons. Branch: feat/worldcons-ai-gateway-p3.

## Result and scope

**PASS — actual isolated G1 summary handler, native Cloudflare Worker AI binding, dynamic Gemini Gateway route, remote durable D1 write, legal evidence audit and idempotent replay.**

This was an actual Cloudflare **disposable isolated Worker** bound to three temporary D1 databases and one temporary R2 bucket. It was **not** a production Worker 114/116 invocation, production D1 write or publication. The issuing court's authentic source was used only for G1; other seeded rows were test fixtures and were not processed in this official-G1-only run.

## Actual receipts

- Original: German Bundesverfassungsgericht, 2 BvR 1735/26, https://www.bverfg.de/e/rk20261015_2bvr173526.
- Actual official HTTP GET: 200. An anchored 7,255-character German source excerpt was seeded into **isolated remote Core D1**, with a SHA-256/size-only fixture receipt.
- Created three isolated APAC D1 databases; successfully applied **11 Core, 6 Ingest and 2 Ops migration files**. Created separate R2 bucket and deployed a separate authenticated staging Worker.
- Actual G1 handler: runD1SummarizeArticle with source=ingest; actual provider selected as cloudflare-ai-gateway via the native AI.run binding with the existing route default/dynamic/gemini-flash-fallback. No direct provider fallback.
- First invocation: **one AI request**, no handler error, status=summarized, durable summary_json stored=true, SummarySchema valid=true, exact original title retained=true, provider=cloudflare-ai-gateway, effective model=**gemini-3.5-flash-lite**.
- First invocation elapsed **49,453 ms** including the handler's workflow, not merely model generation latency.
- Deterministic legal evidence audit: status=pass, findings=[], legalAccuracyVerified=false. The audit is a risk screen, **not** an independent legal-accuracy certification.
- Second invocation of the exact same G1 article with source=ingest: outcome=skipped, **zero additional AI requests**; replay/idempotency PASS.
- Post-write safety: article_publications_p3 rows=0, article_cache_outbox_p3 rows=0, e2e_approval_evidence_v1 rows=0. No approval or publication occurred. No error payload/token leakage detected in test D1 error_context.

## Cleanup and production readback

The isolated test logged successful removal of its R2 object, separate Worker, R2 bucket, and all three temporary D1 databases. Cloudflare management API independently verified **zero** matching D1 resources, **zero** R2 buckets and **no** Worker under the temporary prefix worldcons-p3-remote-0ed860783d.

Production stayed on deployment 36c43641-b326-40f5-8feb-a0fa217ca0be with **Worker version 114 = 100%**, all four summary backend flags = direct-gemini. Read-only Core D1 verified US SCOTUS case 26A560 remained metadata_only, review_state=needs_triage, summary_json absent, publishable=false, review.required=true. No live candidate cutover.

## Source quality and test suite

- The new legal evidence rule distinguishes the German applicant's self-reported nationality from a judicially established fact. The prompt now requires exact preservation of originalTitle and explicit attribution of "nach ihren Angaben".
- Standalone audit implementation verification: **5/5 PASS**, including wrong direction, changed original title, nationality assertion and qualified citation checks.
- Gateway/summary/admin/US private/rollback regression suite: **106/106 PASS** after the latest changes.
- pnpm typecheck (Vinext type generation + TypeScript): **PASS**, exit code 0.
- pnpm build:vinext: **PASS**, completed production build.
- The isolated staging Worker successfully deployed and executed the real summarization handler. Its actual model receipt demonstrates G1 E2E in disposable remote resources, **not** that production version 117 has handled any G1 inference.

## Updated inactive candidate

Built the latest code and uploaded via the Vinext-generated, no-bundle Wrangler config. Only G1 was set to cloudflare-ai-gateway; G2/G3/G4 and global backend remain direct-gemini. Dry-run PASSED before upload.

**Uploaded Worker version 117**: ce7fd0f4-35e2-4678-b739-7576a75190ec — INACTIVE, 0% live traffic.

Cloudflare version-specific API verified that 117 retained 12 secret_text bindings, 4 D1 bindings, 1 R2 binding, 1 AI binding, with matching names to active 114; preview URLs stayed disabled. Version 114 remains the sole active version at 100%.

## Acceptance / remaining gates

**P4 real official-source G1 durable staging: PASS.**
**P4 candidate 117 upload and configuration separation: PASS.**

**Not yet completed:** human legal review/approval of the existing German, Spanish and French public summary corrections; confirmed **production** G1 Gateway inference and controlled limited live rollout; end-to-end source-specific audit and no-publication policy during a live canary; G2/G3/G4 production switch. Do not silently publish corrected summaries or remove the US private hold.
