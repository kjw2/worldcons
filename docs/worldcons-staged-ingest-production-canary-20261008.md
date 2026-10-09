# WorldCons staged ingestion — production canary (2026-10-08)

## Production activation configuration

- Production-only Cloudflare worldcons-ingest; no preview environment.
- Master flag: WORLDCONS_INGEST_STAGES_ENABLED=true.
- Stage allowlist: discovery,crawl,normalize,translate,public-judgment,publish,search.
- Initial scheduled bootstrap source (2026-10-08): fr-conseil-constitutionnel. This was a temporary canary, not the long-term source policy.
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

- Verify Spain's first staged production E2E after the next `0 21 * * *` UTC bootstrap before increasing its per-source limit above 1.
- Germany remains M8-owned: recent official BVerfG URL variants return 404 and require source-verification canaries.
- US SCOTUS remains M8-owned: the native crawler currently preserves official PDF metadata without Worker-safe PDF text extraction; it must never become staged-public without verified text.
- Do not retire the remaining M8 schedules or weaken the official-source/P3 publication gates.

## Operator dead-letter redrive (production installed)

- `d1/worldcons_ingest/0004_ingest_stage_redrive.sql`: additive `ingest_stage_redrive_records` transition ledger (no table/index/row dropped).
- `lib/cloudflare/ingest-stages/redrive.ts`: stage-scoped, bounded diagnosis (`diagnoseIngestStageJobs`, `listIngestStageDeadLetterJobs`) and a fenced, reasoned, rate-limited, audited `redriveIngestStageDeadLetter`. A redrive only returns a job to `pending`; it never marks anything succeeded and never bypasses a blocked/publication gate. Diagnosis reports per-stage status counts, the oldest **pending** job (`oldestPendingJobId`/`oldestPendingCreatedAt`, the queue-depth stall signal) and the oldest active lease.
- `app/api/admin/ingest/dead-letter/route.ts`: authenticated operator route (GET diagnosis, POST fenced redrive). There is no public/unauthenticated redrive route.
- Tests: `tests/ingest-stage-redrive.test.ts` (9 cases) covers 404/429, repeated retries, denied invalid redrive, double-redrive, cross-stage safety, nonterminal conflict, the transition ledger, oldest-pending selection (leased/terminal/other-stage excluded) and the oldest-pending signal clearing a redrive.
- Production `worldcons_ingest` contains `ingest_stage_redrive_records` (migration 0004); the unauthenticated operator API returns 401.

## 2026-10-09 phase 2: bounded Spanish canary

- The native adapter list covers Germany, US, France and Spain. France-only was an assistant-selected temporary production canary, not a user instruction to exclude the others.
- Production config selects `fr-conseil-constitutionnel,es-tribunal-constitucional` for staged discovery. The exact matching M8 `crawler-daily` exclusions leave Germany and US M8-owned. All other M8 kinds remain active.
- Candidate bootstrap remains `1` per source and stage dispatch remains `1` per 15-minute tick. There is no preview/staging environment.
- Source guard: reject Spain's `Show/0` listing placeholder. Targeted Crawl passes the actually verified German official URL variant and Spanish official JSON-corrected metadata into Normalize.
- Next live acceptance: verify a positive HJ ID, official JSON text of at least 2,000 characters, R2 candidate/crawl/raw objects, Core original-source provenance and translation, Public Judgment, P3 publication, Search projection, dispatch outbox and DLQ. A nonpublic or unavailable article must fail closed honestly.
- Rollback Spain ownership as a pair: remove Spain from both the staged allowlist and M8 exclusion in the same Production deployment. Updating only one side can create a duplicate owner or an ownership gap.
