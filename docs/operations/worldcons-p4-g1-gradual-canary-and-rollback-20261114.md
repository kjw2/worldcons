# WorldCons P4 — actual 0.01% G1 deployment and rollback rehearsal

Date: 2026-11-14 KST. Repo: F:\dev\worldcons.
This is a production traffic-split and rollback exercise, NOT an end-to-end G1 AI inference or a legal/publication approval.

## Preconditions checked

- Production active Worker version 114, ID 88665194-9712-4246-93c0-1233a09fbf52, 100% traffic, G1–G4 all direct-gemini.
- Candidate Worker version 116, ID ac4d2176-b462-43d7-89d2-b06bd9978ba5, G1 cloudflare-ai-gateway and G2–G4 direct-gemini.
- Both versions have native AI binding and 12 secret bindings.
- Shared Gateway route version: 68dfaf5b-e13d-4467-969c-7a99f02351fd, with the existing four-model BYOK/auth configuration.
- Read-only D1 snapshots returned zero pending/running/claimed/retry ingestion-stage jobs and zero queued/running/retry admin jobs before this rehearsal.
- Worker version preview URLs remained disabled.

## Controlled live traffic exercise

Cloudflare Workers Deployments API created deployment a23ba18d-57fd-475a-ab18-97dc8c86b184 with the following split:

- Version 114: 99.99%.
- Version 116: 0.01%.
- Immediate Cloudflare API readback confirmed the split.
- During that split, direct HTTP GET (no browser) returned HTTP 200 for /, /api/mcp/health and /api/masterdash/health.
- The 0.01% split does NOT establish which version handled the specific GET requests, nor guarantee a G1 request was served by version 116.

A NEW explicit rollback deployment restored 100% routing to version 114:

- Rollback deployment ID: 9084d700-4b8d-422a-b5b7-3008a9450bf1.
- After rollback, Cloudflare Deployments API reported 114 = 100%; 116 = 0%.
- After rollback, /, /robots.txt, /sitemap.xml, /api/mcp/health and /api/masterdash/health each returned HTTP 200.

## Production state readback

- US 26A560 remained metadata_only with review_state=needs_triage, summary_json=NULL, collection.publishable=false and review.required=true.
- The D1 snapshot reported no pending/running/claimed/retry staged-ingest jobs and no queued/running/retry admin jobs.
- Gateway route version remained unchanged; no affirmative G1 Gemini Gateway request log/receipt was identified for this canary. The absence of a receipt is NOT proof that no request reached version 116.
- German, Spanish and French published summary correction drafts were NOT applied.

## Decision and remaining gates

PASS: Cloudflare actual 0.01% gradual deployment, live public HTTP smoke, explicit production rollback to the known-good Worker 114, private US review hold retention and no queued work in sampled D1 state.

OPEN: a confirmed real G1 inference made by version 116 and its summary/model/provenance receipt, independent professional legal approval of pending public corrections, and G2/G3/G4 cutover.

P4 deployment/rollback subgate PASS. P4 G1 inference/cutover gate OPEN. Production remains at version 114 with G1–G4 direct-gemini. Do not publish the US private case or edit the shared Gemini route as part of this rehearsal.
