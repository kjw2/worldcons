# WorldCons P4-0: production AI binding, no routing cutover

Date: 2026-11-11 (KST). Local source commit: a95a118290c3774e186290868206b256ee934046.

## Deployment and rollback receipt

- Worker: worldcons; production URL: https://worldcons.cclib.workers.dev
- Prior deployment: 227944d7-be48-44a0-8e2c-0ec4aada0758; prior version 113: 352b8755-c70c-44ad-8a8b-6df7833ded57.
- New deployment: bab984db-c9e7-4cbb-98e8-e5cfd8870f1a; new active version: 88665194-9712-4246-93c0-1233a09fbf52 (100%).
- Applied command: pnpm exec wrangler deploy --keep-vars --strict --autoconfig=false --message "P4 readiness: AI binding installed, all G1-G4 continue direct Gemini".
- **Not executed**, emergency rollback target: pnpm exec wrangler rollback 352b8755-c70c-44ad-8a8b-6df7833ded57 --name worldcons --yes --message "Restore WorldCons pre-AI-binding production version".
- Existing 12 secret bindings preserved by name/type, including GEMINI_API_KEY and the secret WORLDCONS_FAST_SITEMAP_ENABLED; secret values were neither queried nor printed.
- Existing D1 Core/Ingest/Ops/Search, R2 artifacts, Search Vectorize, Assets, Images and rate-limit Durable Object bindings preserved.

The 39 pre-existing plain variables matched the source. New configuration contains the native AI binding plus seven Gateway-related plain variables:

| Variable | Value |
| --- | --- |
| WORLDCONS_SUMMARY_BACKEND | direct-gemini |
| WORLDCONS_SUMMARY_BACKEND_G1 | direct-gemini |
| WORLDCONS_SUMMARY_BACKEND_G2 | direct-gemini |
| WORLDCONS_SUMMARY_BACKEND_G3 | direct-gemini |
| WORLDCONS_SUMMARY_BACKEND_G4 | direct-gemini |
| WORLDCONS_AI_GATEWAY_ID | default |
| WORLDCONS_AI_GATEWAY_ROUTE | gemini-flash-fallback |

Cloudflare management API read-back verified 68 active bindings and AI type ai, the above seven exact variables, all 12 secrets still present, and the new Worker version at 100%.

## Live API checks (no browser)

The homepage (200, 63,966 chars), robots.txt (200, 197 chars), and sitemap.xml (200, 806,794 chars) were unchanged in length before and after deployment. The MCP health API, MasterDash health API, and two actual public article detail pages for Germany and France all returned HTTP 200. Anonymous admin/llm returned 404; this is **not** an authenticated admin test.

Gateway management read-back confirmed byok_only=true, authentication=true, active route version 68dfaf5b-e13d-4467-969c-7a99f02351fd, and the unchanged ordered 4-node Gemini fallback with each 20-second timeout and zero retries.

No production D1 write, LLM translation job, public Search/approval change, source crawl, or Gateway summary path switch was initiated by these probes. Existing direct-Gemini credentials were verified as retained bindings, not exercised in a fresh production model call.

## Cutover decision

**P4-0 binding-only deployment PASS.** All four actual production summary paths remain explicitly direct-gemini; the AI Gateway binding is installed but not selected. The legal-quality open issues in the German, Spanish and French stored summaries and the held US case remain in the P4 review memo. **Do not proceed to live G1–G4 Gateway cutover or private US publication until those review and rollback gates are completed.**
