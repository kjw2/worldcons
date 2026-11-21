# Incremental collection reliability release — 2026-11-21

Branch: `fix/incremental-collection-20261121-worldcons`.
Invariants and operator procedures: [incremental-collection-invariants.md](./incremental-collection-invariants.md).

## Commits

- `900bde7` fix(ingest-stages): bound outbox retries and record retryable failures
- `3aec1eb` fix(discovery): defer rate-limited recovery and resume downstream dead letters
- `e3452c5` fix(summary): bound retryable summary failures and add admin recovery
- `f57cf3c` fix(backfill): bound retryable item attempts and terminalize exhaustion
- `245bac9` fix(embeddings): persist backlog backoff so one poison row cannot starve the run
- `346e7c5` fix(ingest): read the incremental checkpoint from D1 instead of retired Supabase
- `9f28fe0` fix(crawler): combine the Spanish HJ tail with search instead of starving it
- `1a3dab3` feat(workers): add Spain incremental recovery workflow and outbox DLQ logging
- `52bcf8c` docs(operations): record incremental collection invariants and recovery paths

## Migrations (applied to production D1 before the Worker upload)

- `worldcons_ingest/0007_ingest_retry_and_outbox_terminal.sql` — applied and verified.
- `worldcons_core/0012_embedding_backlog_failures.sql` — applied and verified.
- Pre-flight dry run confirmed the previously deployed `worldcons_ingest/0004`
  redrive ledger was already present and verified, so the automatic redrive
  ledger no longer risks a missing-table tick failure. The reservation path now
  also defers safely if that ledger is ever unavailable.

## Worker deployments

| Worker | New version | Previous 100% version (rollback) |
| --- | --- | --- |
| `worldcons` (root) | `3a9b56d4-aeff-4269-bb7e-094fa3d34c16` | `42100d56-a81a-43bf-9ea2-a366d6bdd402` |
| `worldcons-ingest` (async) | `98ec4374-109c-4341-8d54-c6120b91709e` | `3cb1d08c-a91a-481b-b296-77641f2e0b9c` |

Deployment commands:

```powershell
pnpm exec wrangler deploy --config workers/async-pipeline/wrangler.jsonc \
  --message "incremental collection reliability 20261121 (worldcons-ingest)"
pnpm exec wrangler deploy --config dist/server/wrangler.json --keep-vars \
  --message "incremental collection reliability 20261121 (worldcons root)"
```

Both were preceded by a clean `wrangler deploy --dry-run` of the same config.

## Post-deploy checks

- `pnpm build:vinext`: pass; generated `dist/server/wrangler.json`.
- Root HTTP: `/`, `/robots.txt`, `/sitemap.xml`, `/api/mcp/health`,
  `/api/masterdash/health`, `/api/search?...` all HTTP 200.
- Async `GET https://worldcons-ingest.cclib.workers.dev/health`: HTTP 200,
  scheduler enabled, valid kinds, nine Workflow triplets including
  `worldcons-spain-incremental-recovery-v1`.
- D1 readback: `last_failure_retryable` exists; both outboxes have
  `max_attempts`/`dead_lettered_at`; `embedding_backlog_failures_v1` exists.
- Production counters immediately after deploy: `pending_items=0`,
  `dead_jobs=74` (pre-existing: 50 public-judgment review-required, 9 translate
  skipped, 7 search terminal, 4 publish/terminal, 2 legacy crawl 404, 1 publish
  retryable, 1 crawl transient), `dead_dispatch=0`, `dead_bridge=0`,
  `rate_limited_1h=0`.

The 74 pre-existing dead jobs are not auto-redriven in bulk: terminal policy,
human-review, duplicate and ineligible outcomes stay fail-closed. The retryable
legacy rows resume only through the next normal discovery re-observation or an
audited operator redrive.

## Rollback

Create a new Cloudflare percentage deployment routing 100% back to the previous
version IDs above. Do not force-push or rewrite history. Migrations are additive
and safe to leave in place.
