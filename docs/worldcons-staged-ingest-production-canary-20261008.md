# WorldCons staged ingestion — production canary (2026-10-08)

## Production activation configuration

- Production-only Cloudflare worldcons-ingest; no preview environment.
- Master flag: WORLDCONS_INGEST_STAGES_ENABLED=true.
- Stage allowlist: discovery,crawl,normalize,translate,public-judgment,publish,search.
- One scheduled bootstrap source: fr-conseil-constitutionnel.
- One candidate per source bootstrap and one item dispatched per stage per 15-minute tick.
- Seven stage queues and seven DLQs created.
- Additive D1 migration 0003 applied to worldcons_ingest and worldcons_core; tables verified.
- Existing M8 continues running. This is parallel bounded canary, not complete ownership cutover.

## Observation and rollback

- Production bootstrap cron: 0 21 * * * (UTC); dispatcher: */15 * * * * (UTC).
- GET https://worldcons-ingest.cclib.workers.dev/health reports ingestStages activation and limits.
- Inspect bounded D1 stage job/event/outbox reads, success, failure, dead_letter and lease metrics.
- To stop new staged dispatch and consumption, revert master flag to false and redeploy worldcons-ingest.
- Keep D1 and queues intact; do not purge DLQ or delete persisted jobs during rollback.
- No source authority or publication eligibility checks are bypassed.

## 2026-10-09 live E2E success and France source-ownership cutover

- First real France staged E2E completed all seven stages on 2026-10-09 KST for
  case `2026-335 L` (article `16b4fc11-d9cc-4e5b-b8e5-acf687ab760e`):
  discovery -> crawl -> normalize -> translate -> public-judgment -> publish ->
  search.
- Duplication evidence: the legacy M8 `crawler-daily` also ran for
  `fr-conseil-constitutionnel` at `2026-10-08T21:02Z` and
  discovered/fetched/inserted 10 rows, i.e. France was collected by two owners.
- Cutover: `M8_CRAWLER_SOURCE_EXCLUDE=fr-conseil-constitutionnel` makes the
  legacy daily crawler own only `de-bverfg`, `us-scotus`,
  `es-tribunal-constitucional`; staged ingestion is the single owner of France.
  M8 kinds and all other countries are unchanged. `GET /health` reports the
  effective/excluded source split. Invalid/unknown exclusion tokens fail closed.
- Rollback: remove the exclusion and redeploy `worldcons-ingest`.

## Known outstanding gates

- Validate live per-item stage progression and duplicate collection / M8 parity before expanding countries or retiring legacy M8. France duplication is now resolved by the explicit source-ownership split above.
- Audited operator dead-letter redrive and per-stage observability reporting (counts, oldest pending, oldest lease) are implemented locally (see below); the production D1 migration 0004 and the operator procedure still need to be applied/verified against the live canary.

## Operator dead-letter redrive (local, not yet deployed)

- `d1/worldcons_ingest/0004_ingest_stage_redrive.sql`: additive `ingest_stage_redrive_records` transition ledger (no table/index/row dropped).
- `lib/cloudflare/ingest-stages/redrive.ts`: stage-scoped, bounded diagnosis (`diagnoseIngestStageJobs`, `listIngestStageDeadLetterJobs`) and a fenced, reasoned, rate-limited, audited `redriveIngestStageDeadLetter`. A redrive only returns a job to `pending`; it never marks anything succeeded and never bypasses a blocked/publication gate. Diagnosis reports per-stage status counts, the oldest **pending** job (`oldestPendingJobId`/`oldestPendingCreatedAt`, the queue-depth stall signal) and the oldest active lease.
- `app/api/admin/ingest/dead-letter/route.ts`: authenticated operator route (GET diagnosis, POST fenced redrive). There is no public/unauthenticated redrive route.
- Tests: `tests/ingest-stage-redrive.test.ts` (9 cases) covers 404/429, repeated retries, denied invalid redrive, double-redrive, cross-stage safety, nonterminal conflict, the transition ledger, oldest-pending selection (leased/terminal/other-stage excluded) and the oldest-pending signal clearing a redrive.
