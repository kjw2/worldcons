# WorldCons P4 — production Gateway re-summary smoke (2026-11-17)

## Scope and authorization

- User explicitly authorized reprocessing and replacing an existing summary for the smoke test.
- Selected exactly **one previously summarized, unpublished, human-review-held** case: Spain **AUTO 64/2026**, article ID `7de14640-c4fd-4af5-b66d-a239ca3cd366`.
- Precondition readback: `status=summarized`, `translation_status=translated`, `collection.publishable=true`, `review.required=true`, **no** `article_publications_p3` published row.
- The previous valid summary was backed up locally before invoking the production writer, under the ignored directory `.wrangler/worldcons-p4-backups/`, filename `7de14640-c4fd-4af5-b66d-a239ca3cd366-20261117-before-replacement.json`.
- Previous summary SHA-256: `b7988ac4b9d12857a9d13883b9332aade0bcf5b28349ce8ed8c9c82f0db9e9f0`; previous metadata: `provider=gemini`, `model=gemini-4-hydrogen`.

## Execution

1. The first temporary Worker was deployed but its URL returned HTTP 404 before reaching the RPC. Subsequent D1 comparison confirmed **no change** to the summary. That temporary Worker was deleted.
2. In the second run, a randomly token-protected, short-lived Worker was deployed without any D1 or R2 binding, containing only a service binding to `worldcons#WorldconsOpsService`. A private readiness endpoint confirmed the binding was present (HTTP 200).
3. The temporary Worker called the **deployed** `WorldconsOpsService.runSummaryArticle({articleId})` with **no** `source` field, directly testing v120's legacy G1 source fallback. This was a real production operation, not a mocked LLM call or manual D1 overwrite.
4. The main Worker returned HTTP 200: `status=summarized`, `provider=cloudflare-ai-gateway`, `model=gemini-3.5-flash-lite`, `writeDisposition=written`.
5. New summary checksum SHA-256: `1d0c1d876281c689b9a8f897a3b8fd35b1af17ab7f342de5ebe35087a1d05203` (different from previous). New `summarized_at=2026-11-17T11:21:37.251Z` (20:21:37 KST).
6. The temporary Worker was deleted successfully. Temporary one-shot source files were removed from the repository after the test to avoid an accidentally repeatable production mutation. The local old-summary backup remains.

## Independent Cloudflare API readback

- Cloudflare AI Gateway `default` log: `2026-11-17T11:21:36.315Z`, `model=gemini-3.5-flash-lite`, `success=true`.
- Core D1 `articles`: `status=summarized`, `review_state=summarized`, `translation_status=translated`, `translation_provider=cloudflare-ai-gateway`, `translation_model=gemini-3.5-flash-lite`.
- The summary JSON `aiMetadata.provider`/`aiMetadata.model` matches the durable D1 provider/model.
- `error_class=NULL`; the gateway legal-evidence audit must pass before the summary writer persists its result. **This is an automated policy pass, not an independent legal-accuracy signoff.**
- `source_metadata.review.required=1`, no `article_publications_p3` row, and no lingering `status=summarizing` row.
- Main Worker **120 at 100%**; ingest Worker **127 at 100%**. No change to production route configuration, deployment, publication approval, or protected U.S. cases.

## Coverage boundary

- The narrow smoke confirms real **legacy source-less G1 RPC → Cloudflare Gemini dynamic route → legal evidence gate → D1 replacement**, with no accidental publication.
- It does **not** independently validate the G2 scheduled workflow, G3 admin retry path, G4 private U.S. path, new-case discovery, or expert review of the generated Korean legal summary.
- Earlier isolated German G1 and Spanish G2 summary smoke outputs correctly triggered `block` and `review` quality findings. Those outputs were not persisted.
