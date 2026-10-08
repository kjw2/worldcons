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

## Known outstanding gates

- Prior failing tests: test:p3, test:d1-case-catalog, test:reference-reads, pnpm check.
- Validate live per-item stage progression and duplicate collection / M8 parity before expanding countries or retiring legacy M8.
- Audited operator dead-letter redrive remains unimplemented.
