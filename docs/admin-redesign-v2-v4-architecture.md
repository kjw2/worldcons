# Administrator Redesign V2+V3+V4 Architecture Contract

Status: approved implementation contract
Scope: administrator operations, queue execution, and publication control
Stage 0 rule: baseline and documentation only; no queue or publication migration

## Intent

The redesign combines the useful V2 operator surfaces, the V3 durable-work model, and the V4 publication model without coupling job execution to public visibility. Existing V2 pages and APIs remain the compatibility path until each later phase passes its gate. Changes are additive first, flag-controlled, observable, and reversible without deleting production data.

## System Boundaries

The administrator system has three ownership domains:

1. **Content workflow** owns article collection, normalization, summarization, review, and error states. These states describe work performed on content; they do not by themselves make content public.
2. **Queue execution** owns durable jobs, attempts, leases, cancellation, retries, idempotency, progress, and operator events. Queue completion reports an operation outcome; it never grants publication.
3. **Publication** owns the public eligibility decision, publication revision, published/withdrawn timestamps, actor/reason, and the public read projection. Public routes read only the publication contract, not queue status.

Cross-domain updates use stable article/job identifiers and audited commands. A worker may propose publication eligibility, but an explicit publication transition is required. Cancelling, retrying, or completing a job must not silently publish or withdraw an article.

## Target Data Contracts

- **Queue command:** immutable type, validated payload reference, idempotency key, requester, priority, and creation time.
- **Queue attempt:** job reference, attempt number, lease owner/expiry, start/finish timestamps, outcome/error class, and bounded redacted result summary.
- **Queue event:** append-only state transition with actor and redacted structured details. Payloads, credentials, source text, and URLs are not event data.
- **Publication record:** article reference, state (`draft`, `in_review`, `published`, `withdrawn`), revision, decision actor/reason, and transition timestamps.
- **Public projection:** only the current published revision and fields approved for public reads. Legacy `articles.status` and `source_metadata.collection.publishable` remain compatibility inputs during migration, not the final authority.

## Delivery Phases

### P0 - Additive Foundations

Add queue/attempt and publication-contract migrations, constraints, indexes, audit vocabulary, and backfill bookkeeping. Do not switch readers or workers. Migrations must be online-safe, additive, and rerunnable where practical. Gate 0 evidence is the sizing and anomaly input.

### P1 - Shadow Writes and Backfill

Dual-write existing administrator commands to the new queue contract while the V2 path remains authoritative. Backfill publication records from the legacy public predicate, recording ambiguous or malformed rows for review rather than guessing. Compare old/new state and command counts continuously.

### P2 - Queue Cutover

Enable new queue claiming for a bounded job-type cohort, then expand by flag. Prove lease recovery, idempotency, cancellation, retry limits, and event completeness. Keep legacy enqueue/read paths available for immediate rollback; publication reads remain unchanged.

### P3 - Publication Cutover

Enable publication dual-write, reconcile every legacy-public article, then switch public reads to the publication projection. Queue completion remains unable to publish directly. Cache invalidation follows committed publication transitions and is idempotent.

### P4 - Administrator Experience Cutover

Move V2 operator pages to V3 queue and V4 publication read models. Preserve deep links and action authorization. The UI must show execution state separately from publication state, expose stale/cancel/retry outcomes, and retain audit traceability.

### P5 - Compatibility Retirement

After the observation window, stop legacy writes and remove compatibility reads in a later, separately approved change. Destructive column/table cleanup is never part of the cutover release and requires its own backup, retention, and rollback review.

## Phase Gates

| Gate | Required evidence | Blocks |
| --- | --- | --- |
| Gate 0: baseline | Read-only repeatable-read baseline captured; schema/index/constraint inventory complete; state, publication, stale/cancel, and malformed aggregate counts reviewed; artifact hashes retained | P0 migrations |
| Gate 1: foundation | Migrations tested on a production-shaped copy; locks and runtimes within budget; constraints valid; rollback/forward-fix rehearsed | P1 dual-write |
| Gate 2: queue parity | No lost/duplicate commands; idempotency and lease recovery tests pass; old/new aggregate state parity is explained; cancellation SLA met | P2 queue expansion |
| Gate 3: publication parity | Every public row reconciled; malformed/ambiguous set is zero or explicitly adjudicated; old/new public result counts and sampled identities match | V4 public-read cutover |
| Gate 4: operator acceptance | Critical desktop/mobile workflows pass; authorization and audit tests pass; support runbook and dashboards are ready | Full admin UI cutover |
| Gate 5: retirement | Rollback window elapsed; no legacy readers/writers observed; restore evidence current; owner approval recorded | Compatibility removal |

A gate is a stop condition, not a target date. Any unexplained regression keeps the next phase disabled.

## Feature Flags

Flags default off in every environment and are enabled in this order:

| Flag | Purpose | Rollback effect |
| --- | --- | --- |
| `ADMIN_REDESIGN_UI_ENABLED` | Use redesigned operator navigation and views | Return to V2 UI |
| `ADMIN_QUEUE_V3_SHADOW_WRITE_ENABLED` | Mirror legacy commands into the new queue | Stop new shadow writes |
| `ADMIN_QUEUE_V3_WORKER_ENABLED` | Claim selected job types from the new queue | Return execution to legacy worker |
| `ADMIN_QUEUE_V3_READ_ENABLED` | Read queue state/events from the new model | Return operator reads to V2 model |
| `ADMIN_PUBLICATION_V4_SHADOW_WRITE_ENABLED` | Mirror legacy publication transitions | Stop publication mirroring |
| `ADMIN_PUBLICATION_V4_READ_ENABLED` | Serve public content from the V4 projection | Return public reads to legacy predicate |

Queue and publication flags are independent. Flag evaluation must be server-side for authority decisions, environment-scoped, observable without exposing secret configuration, and covered by default-off tests.

## Acceptance Principles

- **Safety:** no migration or worker path can publish content as a side effect of job success; authorization and CSRF boundaries remain intact.
- **Correctness:** queue transitions are constrained and idempotent; publication has one explicit authority; all compatibility divergence is measurable.
- **Privacy:** operational artifacts contain aggregate counts and structural catalog definitions only, never URLs, source text, row payloads, metadata blobs, credentials, or secrets.
- **Operations:** stale leases, cancellation lag, retries, failures, and publication divergence have bounded alerts and named owners.
- **Performance:** queue claims use indexed bounded queries; public projection latency and cache behavior meet or improve the V2 baseline.
- **Accessibility and usability:** keyboard, focus, responsive layouts, status labels, confirmations, and error recovery pass the operator workflow checklist.
- **Verification:** each phase includes focused tests, typecheck, lint, repository checks, build, migration rehearsal, and a documented smoke/rollback exercise appropriate to its blast radius.

## Rollback Principles

1. Disable the narrowest read/worker flag first; preserve dual-written data for diagnosis.
2. Never roll back by deleting jobs, attempts, publication history, or audit events.
3. Prefer a forward fix for additive schema. Reverting a migration is allowed only when its inverse is proven non-destructive and lock-safe.
4. Keep legacy readers and writers deployable through Gate 5. A read rollback must not require a data rollback.
5. Reconcile in-flight leases and commands before changing worker authority; only one execution authority may claim a job cohort at a time.
6. Roll publication reads back independently from queue execution. Revalidate caches after either publication read-direction change.
7. Record the trigger, flags changed, aggregate before/after evidence, owner, and follow-up. Do not place production values or secrets in rollback records.

## Gate 0 Evidence Contract

Run `pnpm admin:gate0` only with a PostgreSQL `DATABASE_URL`; it opens `REPEATABLE READ READ ONLY`, verifies both settings, executes aggregate/catalog queries, and writes redacted deterministic artifacts under `artifacts/admin-redesign/gate0/`. It never falls back to the Supabase HTTP/service-role client. `pnpm admin:gate0:dry` validates the same query/report/hash contract without a database for CI.

The baseline records tool/version, commit, UTC timestamp, environment label, PostgreSQL version, relevant table live/dead estimates, state distributions, legacy/explicit/malformed publication counts, stale/cancel job counts, index sizes/definitions, and constraints. The SHA-256 manifest makes a captured baseline tamper-evident. Artifacts are operational evidence and remain untracked.

Gate 0 does not prove application correctness, execute migrations, claim jobs, mutate rows, or authorize P0 automatically. A human reviewer must explain anomalies and record the go/no-go decision before P0 begins.
