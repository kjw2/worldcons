# Incremental collection invariants and recovery procedures

Date: 2026-11-21. Scope: `worldcons`, `worldcase`, `newthesis` and
`law_repo_trans` incremental collection lanes share this staged-ingestion
runtime. This document records the invariants enforced by the 2026-11-21
reliability fix and the operator procedures for every bounded retry budget.

## Invariants

1. **No cursor/checkpoint advance on incomplete work.** A discovery window,
   page or batch is only marked complete after every observed candidate has a
   durable `ingest_discovery_items_v1` row. A committed snapshot is replayed
   verbatim; it is never replaced by a changed official page.
2. **Overflow is deferred durably, never dropped.** Items beyond a tick's
   processing budget stay `pending` in `ingest_discovery_items_v1` (row-sized
   durable deferral). Outbox sends, redrives and bridge applications use their
   own ledger/outbox rows. A rate limit or a missing ledger table defers work;
   it never terminalizes it.
3. **Terminal means permanent only.** `crawler.official_404_unresolved`,
   robots, non-official host, duplicate-official-case, policy and human-review
   outcomes are terminal. Transient transport/429/5xx/storage/timeout outcomes
   remain retryable. `ingest_stage_jobs.last_failure_retryable` records the
   authoritative classification (1 transient, 0 terminal); legacy rows with
   NULL are recovered only for an explicit retryable error code.
4. **Every retry loop is bounded and observable.** Each loop has a finite
   attempt budget, a durable terminal/dead-letter transition and an audited
   recovery path. Counters are emitted to Worker logs and the admin staged
   collection status.

## What changed

| Area | Bound / terminal state | Recovery |
| --- | --- | --- |
| Discovery crawl transient recovery | one automated redrive per crawl job (`ingest_stage_redrive_records`) | operator redrive; rate-limited attempts are deferred, never terminalized |
| Post-crawl stage dead letter | one automated downstream resume per job | operator redrive of the exact stage job |
| Final official 404/410 | at most one recheck per 7 days, 52 recheck revisions | operator redrive or wait for the next bounded recheck |
| Dispatch/bridge outbox | `max_attempts` (8) then `dead_lettered_at` | `redriveIngestStageDispatchOutbox` / `redriveIngestCoreBridgeOutbox` |
| Summary retry | `SUMMARY_RETRY_MAX_ATTEMPTS` (8) then `summary.retry_exhausted` | admin targeted summary retry resets the budget |
| Backfill item retry | `CASE_BACKFILL_MAX_RETRYABLE_ATTEMPTS` (8) then `case_backfill.retry_exhausted` | operator requeue (SQL below) |
| Embedding backlog | 5 persisted failures per article, exponential backoff, then `exhausted_at` | `pnpm backfill:embeddings --retry-exhausted [--article=<id>]` |

## Required migrations (apply before deploying the Worker)

```powershell
pnpm d1:migrate --database=worldcons_ingest --apply
pnpm d1:migrate --database=worldcons_core --apply
```

Both migrations are additive and self-verifying (`@d1-verify`):

- `worldcons_ingest/0007_ingest_retry_and_outbox_terminal.sql` adds
  `ingest_stage_jobs.last_failure_retryable`, and
  `max_attempts`/`dead_lettered_at` on both outboxes.
- `worldcons_core/0012_embedding_backlog_failures.sql` adds
  `embedding_backlog_failures_v1`.

The minute discovery tick tolerates a missing redrive ledger by deferring the
item (it does not throw or terminalize), but the ledger must still be applied
so automatic recovery can make progress.

## Operator procedures

### Discovery: rate-limited automatic recovery

Symptom: health log `ingest_discovery_reservations` reports
`deferredRateLimited > 0`, or admin shows a high "rate-limit 종결" count.
Cause: the automatic redrive operator spent its 10-per-rolling-hour budget.

The affected item remains `pending`; no manual action is required for
transient failures. To accelerate one case, list the dead letter and redrive it
explicitly with a distinct operator id and a reason. Do not reset `attempt_count`.

### Discovery: post-crawl dead letter

Symptom: `recoveredDownstream` does not increase and admin shows
"미복구 DLQ N건" for a source.

The reservation tick resumes only dead letters whose recorded failure is
retryable. A terminal block (public-judgment/policy/human review) stays linked
to its crawl job and requires an operator decision. Inspect with
`listIngestStageDeadLetterJobs` and use the audited
`redriveIngestStageDeadLetter` path; the handler re-evaluates every gate.

### Discovery: final official 404/410

A candidate whose crawl ended in `crawler.official_404_unresolved` is rechecked
at most weekly with a new `:recheck:YYYY-MM-DD` crawl revision. The terminal row
is never mutated. After 52 revisions the item is counted as `recheckExhausted`
and needs an operator.

### Dispatch / bridge outbox dead letter

`reconcileIngestStageDispatch` excludes `dead_lettered_at` rows. Re-arm one row
with `redriveIngestStageDispatchOutbox(db, { messageId, now })` (or
`redriveIngestCoreBridgeOutbox` for the bridge). If the underlying
`ingest_stage_jobs` row is also `dead_letter`, redrive that job too. Counts are
logged as `dispatchOutboxDeadLetters`/`bridgeOutboxDeadLetters` on the
`*/15` dispatch tick and shown in admin.

### Summary retry exhaustion

`summary.retry_exhausted` rows are excluded from the automatic drain. An
explicit admin targeted summary retry (`source = "admin"`) clears the retry
bookkeeping and runs the normal provider, legal-evidence and publication gates.
Do not clear `error_class` in SQL without an operator decision.

### Backfill item retry exhaustion

`case_backfill.retry_exhausted` items are terminal failures. To requeue a
reviewed snapshot item:

```sql
UPDATE source_backfill_items
   SET status = CASE WHEN retry_phase = 'fetch' THEN 'queued' ELSE status END,
       attempt_count = 0, next_attempt_at = NULL, retry_phase = NULL,
       error_code = NULL, error_summary = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE id = '<item-id>' AND status = 'terminal_failure';
```

If the item was a fetch-phase failure, set `status='queued'`; for a
normalize/verify/publish retry, set the appropriate pre-phase status from the
snapshot and keep the verified artifacts.

### Embedding backlog

```powershell
pnpm backfill:embeddings --retry-exhausted                 # clear all exhausted rows
pnpm backfill:embeddings --retry-exhausted --article=<id>  # clear one article
```

Exhausted articles are excluded from selection by
`embedding_backlog_failures_v1.exhausted_at`; backoff rows are excluded until
`next_attempt_at`.

### Incremental checkpoint

The incremental range anchor is read from
`worldcons_ingest.ingestion_runs` (completed runs, newest first) through
`lib/cloudflare/ingest-write/ingestion-runs-read.ts`. Supabase is retired and
is no longer consulted. If the D1 binding is unavailable the historic floor is
used safely; the checkpoint never advances on an incomplete run.

## Monitoring

Minute tick (`ingest_discovery_reservations`):
`claimed`, `reserved`, `recovered`, `recoveredDownstream`, `terminalLinked`,
`recheckScheduled`, `recheckExhausted`, `deferredRateLimited`,
`deferredLedgerUnavailable`, `pendingCount`, `oldestPendingAgeSeconds`,
`stalledCaptureCount`, `requiresAttention`.

Dispatch tick (`ingest_stage_dispatch`): per-stage
`claimed/enqueued/failed/deadLettered`, `dispatchOutboxDeadLetters`,
`bridgeOutboxDeadLetters`.

Admin `단계별 수집 상태` shows per-source downstream DLQ counts plus the
global discovery pending/oldest, rate-limited, dispatch DLQ and bridge DLQ
counters.
