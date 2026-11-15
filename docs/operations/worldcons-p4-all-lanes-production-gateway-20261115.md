# WorldCons P4 — all four production summary lanes on Cloudflare AI Gateway

Date: 2026-11-15 KST. Repository: F:\dev\worldcons.
User direction: complete the operational model-route migration for G1, G2, G3 and G4.

## Production result

**ALL FOUR LANES CUT OVER**, including the default summarization backend:

| Flag | Live value |
| --- | --- |
| WORLDCONS_SUMMARY_BACKEND | cloudflare-ai-gateway |
| WORLDCONS_SUMMARY_BACKEND_G1 | cloudflare-ai-gateway |
| WORLDCONS_SUMMARY_BACKEND_G2 | cloudflare-ai-gateway |
| WORLDCONS_SUMMARY_BACKEND_G3 | cloudflare-ai-gateway |
| WORLDCONS_SUMMARY_BACKEND_G4 | cloudflare-ai-gateway |

All four use the existing authenticated/BYOK default Gateway, dynamic/gemini-flash-fallback. The already-active route version 68dfaf5b-e13d-4467-969c-7a99f02351fd contains Gemini 3.8 Flash, Gemini 3.6 Flash, Gemini 3.5 Flash-Lite and Gemini 3.1 Flash-Lite, in that fallback order. No Gateway route version, BYOK setting or model sequence was changed.

## Release controls and actual Cloudflare receipts

- Full 109/109 targeted Gateway, D1 summary, admin, legal quality, private US, ingest, publication and rollback regression suite passed on the final all-Gateway source configuration.
- pnpm typecheck passed. pnpm build:vinext passed.
- Generated dist/server/wrangler.json validated all five explicit Gateway flags, native AI binding and the intended route. Wrangler version-only upload dry run passed.
- **Worker version 119:** 8e07b65d-47f6-4318-8e7b-b60e081d2d5a; uploaded successfully.
- Compared active version 114 vs new 119 by Cloudflare versions API: all matching binding names and types for 12 secret, 4 D1, 1 R2, 1 AI, 1 Vectorize, 1 assets and 1 Durable Object. No missing binding. Version preview URLs remain disabled.
- Live 1% canary deployment: 534e40b1-806d-49bd-ab7d-ba3476f3e014 (114 = 99%, 119 = 1%). Targeted HTTP GET to version 119 returned HTTP 200 for home, robots.txt, MCP health and MasterDash health.
- **Full production deployment:** 033a5239-36cd-4504-a008-5bcfd1af2e5b, Worker 119 **100%**, old Worker 114 **0%**. Cloudflare Deployments API readback explicitly confirmed one active version at 100%.
- Post-cutover ordinary (non-overridden) HTTP GET: home, robots.txt, sitemap.xml, MCP health, MasterDash health all returned HTTP 200.
- Actual source-to-service RPC audit: G1 ingest-stage passes source=ingest into WorldconsOpsService.runSummaryArticle; G2 scheduler passes source=scheduled into runSummaryDrain; G3 admin uses source=admin for both targeted and batch reprocessing; G4 private US calls runPrivateUsSummary which chooses the us-private flag. The four flags therefore affect the real service-binding operations, not only the HTTP frontend.

## Production data safety readback

- Core D1 US Supreme Court case 26A560 remained metadata_only, review_state=needs_triage, summary JSON absent, publishable=false, review.required=true.
- No pending/running/claimed/retry ingest-stage jobs and no queued/running/retry admin jobs were observed in the pre-/post-change D1 snapshots.
- The previously tested Gateway legal evidence gate holds suspicious output before it can be saved; review holds are excluded from batch/targeted automatic publication, and protected US publication policy remains unchanged.
- This operation did not deliberately trigger any production article resummary, make a new human approval receipt, change published article contents, or remove a private hold.

## Evidence boundaries and rollback

The configuration and production traffic switch are CONFIRMED. The isolated Cloudflare staging environments previously exercised all G1–G4 summary adapters and one official-source G1 durable Gemini result. Because production queues were empty, **a new production per-lane model response and D1 provider/model receipt has not been observed in this release**. Never claim this HTTP health check alone establishes fresh production Gemini requests.

Known-good rollback Worker: version 114, 88665194-9712-4246-93c0-1233a09fbf52. If Gateway execution fails in production, create a new Cloudflare Workers percentage deployment routing 100% back to version 114, verify routing and the job queue before requeueing affected work. A historical G3 job explicitly requesting Gateway must not silently become direct Gemini after rollback; drain/cancel/requeue it intentionally.

The existing public German/Spanish/French summary correction proposals still require separate independent legal-content approval. Their correction/publication is NOT part of the route migration.
