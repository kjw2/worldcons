# WorldCons P4 — official-source quality gate and inactive G1 version 116

Date: 2026-11-14 KST. Local branch: feat/worldcons-ai-gateway-p3.

## 1. Real court-source checks

Read-only HTTP requests to the issuing courts (no browser) verified four original documents. The script scripts/verify-p4-official-sources.mjs checks court case identity and key operative text. All 4 out of 4 source checks passed, using the German court's official stable redirect and direct Spanish and French court pages.

- Germany, BVerfG 2 BvR 1735/26: operative deportation prohibition, no invented destination; up to six months.
- Spain, Tribunal Constitucional AUTO 48/2026: recusation not admitted; the litigant's defective art. 219.1 e) reference has [sic] in the original.
- France, Conseil constitutionnel 2026-1230/1231 QPC: invalidity covers a specified sentence of Article 13; effect begins on publication of the constitutional decision, applies to not-yet-final judgments.
- US, Supreme Court Mullin No. 26A560: PDF GET 200, header PDF-1.6, 64,875 bytes, SHA-256 c8dcdbba8c419cded45bd9e042b8b53ab8c7b3002a3345633700994c10e7327b equals the metadata hash recorded in WorldCons D1.

The first attempt with the BVerfG URL's old query-string form encountered a temporary network timeout. A separate official short URL succeeded and all four official-source assertions then passed. Transport errors are not misreported as contradictions in court decisions.

Proposed Korean correction passages for three existing summarized cases and a separate US private-review note are documented in worldcons-p4-official-court-review-20261114.md. No correction has been published, no source text overwritten, and a source-identity PASS is not an independent professional legal signoff.

## 2. Quality validation and typecheck repair

- Added an explicit review reason code for the existing erroneous Korean French statute rendering "사회보장재정1법".
- Made the Spanish party citation [sic] evidence check tolerant of whitespace in official HTML.
- Extended the system summary prompt to require the correct French social-security financing statute rendering.
- Aligned pnpm typecheck with the actual Vinext build stack. The previous Next.js-generated validator was incompatible with Vinext's generated routes.d.ts; the typecheck now calls vinext typegen, deletes only a file proven by header and imports to be the stale generated Next.js validator, then runs tsc --noEmit. It does not delete handwritten code or the Vinext route type declarations.
- Full pnpm typecheck: PASS (exit 0).
- P0–P4 Gateway, legal quality, G1/G2 D1, G3 admin, G4 private, ingestion, and rollback regression: 105 / 105 PASS.
- Vinext production build: PASS (all five build phases).
- Generated Wrangler config upload dry-run with no_bundle=true and native AI binding: PASS.

## 3. Cloudflare version-only upload: NO TRAFFIC CUTOVER

The new compiled Vinext code was uploaded using the generated dist/server/wrangler.json, copied to a temporary generated config with G1 changed to cloudflare-ai-gateway and G2/G3/G4 left direct-gemini. The source wrangler.jsonc was NOT changed.

- Uploaded **inactive candidate version 116**: ac4d2176-b462-43d7-89d2-b06bd9978ba5.
- Previous inactive candidate version 115: df134500-313e-4a67-9cea-9b5da1f2d450 (superseded for subsequent P4 work).
- **Active production version 114**: 88665194-9712-4246-93c0-1233a09fbf52, still 100% of traffic.
- The version-specific API confirmed version 114 has G1/G2/G3/G4 all direct-gemini. Version 116 has G1 cloudflare-ai-gateway and G2/G3/G4 direct-gemini.
- Version 116 retains 12 secret bindings by name, AI, four D1 bindings, R2 and static assets. Version previews remain disabled.
- The default/gemini-flash-fallback route and its four ordered Gemini nodes were not modified.
- After upload, homepage, robots.txt, sitemap.xml, MCP health and MasterDash health all returned HTTP 200.
- Read-only production D1 verification: US 26A560 remains metadata_only, review_state needs_triage, publishable=false, review.required=true, and has NO summary. German, Spanish, French cases remain summarized with the existing public content. No R2 write, admin job, human approval or search/publication change was performed.

## 4. Release assessment

**PASS:** court-source identity and key passages 4/4, stored US PDF identity, local legal QA tests, full TypeScript check, production build, candidate package upload, version separation and production HTTP health.

**OPEN:** human/professional legal signoff on the proposed corrections and the US case's protected publication rules; a controlled production G1 canary with explicit rollback exercise, source/version receipts and queue checks; correction of the existing public summaries through a versioned review workflow.

**P4 production G1 Gateway switch: NO-GO.** This report certifies the inactive candidate package, NOT an actual G1 Gateway production request or approved publication.
