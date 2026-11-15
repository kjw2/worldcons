# WorldCons P4 — G1 legal-quality hold and inactive candidate 118

Date: 2026-11-15 KST. Branch: feat/worldcons-ai-gateway-p3.

## Risk and correction

The G1 summary operation is invoked by worldcons-ingest through the WorldconsOpsService.runSummaryArticle service-binding RPC, not by an ordinary public HTTP request. An HTTP version-override response is therefore NOT proof that production G1 RPC selected a particular Worker version.

The P3 publication predicate previously verified summarized/translated status and source publishability, but did not exclude legal review holds by review_state. Legal audit also ran in the staging wrapper rather than mandatorily in the actual G1 summary persistence path.

To fail closed before the Gateway cutover:

1. Gateway summarization now invokes auditLegalEvidence using the original source title, cleaned text and generated summary BEFORE writing the summary to D1.
2. For either block or review, it stores no generated summary and records the content-free error code summary_gateway.legal_evidence_review_required, with review_state=needs_triage. The manual review and targeted retry path remains available.
3. The automatic summary drain excludes this specific error class to avoid repeat billable calls without intervening review. No other failed-summary retry class is changed.
4. The shared P3_PUBLICATION_ELIGIBLE_PREDICATE excludes review_state values needs_review, needs_triage, closed_private, rejected, and blocked for BOTH scheduled and targeted publication.
5. The audit invocation applies only to the Gateway summarization adapter; direct Gemini is unchanged. The publication review hold is provider-independent.

These rule-based heuristics are a conservative safety screen, not an independent legal-accuracy certification.

## Verification

- Negative tests confirm that wrong deportation destination (block) and unqualified applicant nationality (review) are not persisted, enter needs_triage, and do not publish. The blocked article is excluded from automatic summary drain without an additional AI call.
- Both batch and per-article publication reject the review holds needs_review, needs_triage and blocked.
- **109/109** regression tests covering Gateway, legal evidence, D1 summary, ingest stages, admin jobs, US private hold, publication and rollback passed.
- Full pnpm typecheck and pnpm build:vinext both passed.
- Real official-source remote staging: Bundesverfassungsgericht 2 BvR 1735/26 source (7,255 chars) passed through a disposable Cloudflare Worker and real G1 native Gateway adapter into temporary D1. Effective model gemini-3.5-flash-lite; one AI request; summary stored with valid schema and exact title; legal audit pass with no findings; idempotent replay incurred zero additional AI calls; zero publication, cache outbox and human-approval records. Processing elapsed 48,787 ms.
- The first source HTTP attempt failed before resource creation; a bounded second try succeeded. All temporary test databases, Worker and R2 bucket were deleted and independently verified absent under prefix worldcons-p3-remote-484e5a6639.

## Deployed versus candidate

The Vinext-generated bundle was uploaded as a NEW INACTIVE G1-only candidate:

- Worker **118**: 737bb15f-d7fe-4ef6-a385-56f874ce275b; G1 cloudflare-ai-gateway; G2/G3/G4 and default direct-gemini.
- Existing binding counts match the current active version: 12 secret, 4 D1, 1 R2 and 1 native AI binding. Preview URLs remain disabled.
- Actual production deployment 36c43641-b326-40f5-8feb-a0fa217ca0be still runs version **114 at 100%**, all G1-G4 direct-gemini; version 118 receives **0%** ordinary traffic.
- No production D1 writes, content changes, publication, or shared Gateway route changes were made.
- US SCOTUS case 26A560 remains metadata_only, summary absent, publishable=false and review.required=true.

## Open release gates

Actual production G1 RPC version routing, a production G1 model/storage receipt, and independent human legal signoff on the known German/Spanish/French public summary corrections remain OPEN. No eligible pending G1 item was identified in the latest production D1 snapshot; do not fabricate or reprocess an existing live article just to force a canary.

**P4 official-source remote G1 + legal hold: PASS. P4 production G1 cutover: NO-GO until the remaining gates are satisfied.**
