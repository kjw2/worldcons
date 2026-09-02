# Gemini embedding rollout

WorldCons uses one vector space only: `gemini-embedding-001`, 1536 dimensions, L2-normalized. Documents use `RETRIEVAL_DOCUMENT`; Search Worker queries use `RETRIEVAL_QUERY`. The application rejects any other `EMBEDDING_PROVIDER`.

## Safe production order

1. Set the Search Worker secret `GEMINI_API_KEY`, deploy the Worker with `SEMANTIC_SEARCH_ENABLED=false`, and verify semantic/hybrid requests report an explicit full-text fallback.
2. Apply `20260831130000_gemini_embedding_provenance.sql`, then `20260831140000_workflow_heartbeats.sql`.
3. Deploy the Vercel application. New document embeddings now carry provider, model, width, input hash, and generation time provenance.
4. Backfill in bounded passes. Do not use an unbounded one-shot run:

   ```bash
   pnpm backfill:embeddings -- --drain --limit=100 --max-passes=20 --pass-delay-ms=65000
   ```

   Re-run until `missingAfter` is zero. A quota deferral is resumable and must not be treated as data loss.
5. Verify every currently published P3 version resolves to a Gemini artifact and that the public projection has no null vectors for summarized records. Verify `/api/masterdash/health` reports `missingEmbeddingCount=0`, `missingPublishedEmbeddingArtifactCount=0`, and a recent successful embedding heartbeat.
6. Change `SEMANTIC_SEARCH_ENABLED=true`, deploy only the Search Worker, then canary exact-case, full-text, semantic, and hybrid searches. Exact-case preflight must remain embedding-free.

## Rollback

Set `SEMANTIC_SEARCH_ENABLED=false` and redeploy the Search Worker. This restores explicit full-text fallback without deleting vectors, changing immutable article versions, or reverting a database migration. Do not switch query generation back to OpenAI: newly written and backfilled documents are Gemini vectors.

## Security and observability

- Store `GEMINI_API_KEY` only as a Worker secret. Never put it in `wrangler.jsonc`, logs, health payloads, or test fixtures used outside local tests.
- `article_embedding_write_v1` is executable only by `service_role`; it updates the legacy article and a derived artifact for the matching immutable P3 version.
- `pendingItems` remains the compatibility total. Diagnose it using `pendingAdminJobs`, `openCandidateCount`, `retryableCandidateCount`, `exhaustedCandidateCount`, and `oldestOpenCandidateAt`.
- Collection, summary, embedding, and watchdog jobs write durable heartbeat rows. Missing, failed, or older-than-2.5x heartbeat intervals can degrade health independently of collection freshness.
