# Administrator Redesign V2+V3+V4 Architecture Contract

Status: approved implementation contract; P0 and P1 implemented but not production-applied; P1 disabled by default
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
- **Queue run:** command reference, active-only dedupe identity, scheduling/retry policy, abort request, terminal state, and bounded redacted result summary.
- **Queue attempt:** run reference, attempt number, lease owner/expiry, heartbeat, fencing token, start/finish timestamps, outcome/error class, and bounded redacted result summary.
- **Queue event:** append-only state transition with actor and redacted structured details. Payloads, credentials, source text, and URLs are not event data.
- **Publication record:** article reference, state (`draft`, `in_review`, `published`, `withdrawn`), revision, decision actor/reason, and transition timestamps.
- **Public projection:** only the current published revision and fields approved for public reads. Legacy `articles.status` and `source_metadata.collection.publishable` remain compatibility inputs during migration, not the final authority.

## Delivery Phases

### P0 - Additive Foundations

Add the command -> run -> attempt queue contract, constraints, indexes, audit vocabulary, repositories, and transition services. Do not switch readers or workers. Preserve `admin_jobs` and ingestion behavior through a default-off compatibility adapter. Migrations must be online-safe, additive, and rerunnable where practical. Publication, article-state, version, outbox, and UI work are explicitly outside P0.

### P1 - Direct GitHub Workers

Add direct GitHub worker execution and bounded shadow/cutover cohorts on the P0 command control plane. Prove that the worker uses heartbeat, fencing, abort, and terminalization RPCs. The V2 queue remains available for rollback until its retirement gate.

### P2 - Orthogonal Article States

Separate collection, processing, review, and error state so article workflow is not overloaded into one status. Queue completion still cannot publish content.

### P3 - Versions, Publication, Audit, and Outbox

Add immutable article versions, explicit publication authority, durable audit, and an outbox. Backfill and reconcile the legacy public predicate before any read cutover. Cache invalidation follows committed publication transitions and is idempotent.

### P4 - AdminShell and Work Queue

Build the AdminShell and operator work queue over accepted backend contracts. Preserve deep links and action authorization. The UI must show execution state separately from article and publication state, expose stale/abort/retry outcomes, and retain audit traceability.

### P5 - Governance and Retirement

Complete ownership, retention, alerts, and support governance. After the observation window, stop legacy writes and remove compatibility reads in a later, separately approved change. Destructive cleanup requires its own backup, retention, and rollback review.

## Phase Gates

| Gate | Required evidence | Blocks |
| --- | --- | --- |
| Gate 0: baseline | Read-only repeatable-read baseline captured; schema/index/constraint inventory complete; state, publication, stale/cancel, and malformed aggregate counts reviewed; artifact hashes retained | P0 migrations |
| Gate 1: foundation | Migrations tested on a production-shaped copy; locks and runtimes within budget; constraints valid; rollback/forward-fix rehearsed | P1 worker/shadow start |
| Gate 2: worker parity | No lost/duplicate commands; idempotency and lease recovery tests pass; old/new aggregate state parity is explained; abort SLA met | P2 article-state work |
| Gate 3: publication parity | Every public row reconciled; malformed/ambiguous set is zero or explicitly adjudicated; old/new public result counts and sampled identities match | P3 public-read cutover |
| Gate 4: operator acceptance | Critical desktop/mobile workflows pass; authorization and audit tests pass; support runbook and dashboards are ready | Full admin UI cutover |
| Gate 5: retirement | Rollback window elapsed; no legacy readers/writers observed; restore evidence current; owner approval recorded | Compatibility removal |

A gate is a stop condition, not a target date. Any unexplained regression keeps the next phase disabled.

## Feature Flags

Flags default off in every environment. Their controls and immediate rollback effects are:

| Flag | Purpose | Rollback effect |
| --- | --- | --- |
| `ADMIN_REDESIGN_UI_ENABLED` | Use redesigned operator navigation and views | Return to V2 UI |
| `ADMIN_QUEUE_V3_SHADOW_WRITE_ENABLED` | Mirror legacy commands into the new queue | Stop new shadow writes |
| `ADMIN_QUEUE_V3_WORKER_ENABLED` | Claim selected job types from the new queue | Return execution to legacy worker |
| `ARTICLE_LIFECYCLE_P2_SHADOW_WRITE_ENABLED` | Mirror confirmed legacy lifecycle outcomes for configured cohorts | Stop lifecycle evidence writes |
| `ARTICLE_LIFECYCLE_P2_READ_ENABLED` | Reserve the accepted lifecycle read cutover state | Return lifecycle reads to legacy evidence |
| `ADMIN_PUBLICATION_V4_SHADOW_WRITE_ENABLED` | Mirror legacy publication transitions | Stop publication mirroring |
| `ADMIN_PUBLICATION_V4_READ_ENABLED` | Serve public content from the V4 projection | Return public reads to legacy predicate |
| `ADMIN_PUBLICATION_V4_OUTBOX_PROCESSOR_ENABLED` | Deliver publication cache events | Stop claims and preserve pending events |
| `ADMIN_P5_COMPATIBILITY_OBSERVATION_ENABLED` | Record bounded compatibility aggregates | Stop observation writes |
| `ADMIN_P5_GOVERNANCE_UI_ENABLED` | Show governance only inside the redesigned shell | Hide governance without changing authority |

Queue, lifecycle, publication, UI, and governance controls remain independent except that governance UI requires the redesigned shell. Flag evaluation must be server-side for authority decisions, environment-scoped, observable without exposing secret configuration, and covered by default-off tests. The legal rollout order is phase-gated rather than the display order of this inventory.

For P0, only `ADMIN_QUEUE_V3_SHADOW_WRITE_ENABLED` is read by new code. Its exact default is `false`, including when unset or set to any value other than case-insensitive `true`. With the flag off, the compatibility adapter calls only the legacy implementation and returns its existing result without evaluating shadow success. With it on, every call site must provide an explicit domain success predicate; only confirmed non-empty work is followed by a terminal `shadowed` command/run record. Resolved failure/no-op values, zero-work results, and thrown failures never shadow-write. No P0 code claims or executes V3 work, and a failed shadow submission never changes the legacy response.

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

## P0 Command Control Plane

Gate 0 commit `87cba71` was accepted after an independent production-pooler run completed in `REPEATABLE READ READ ONLY`. The accepted evidence reported `explicitPublic=1174`; every reported malformed, stale, and cancel anomaly was zero. No production mutation was made by that run.

P0 adds `20260712090000_admin_command_control_plane.sql` after the existing `20260710100000_fix_claim_admin_job_parameter_references.sql` migration. It creates only new tables, a sequence, indexes, triggers, and RPC functions. It does not alter, backfill, delete, or claim from `admin_jobs`, ingestion tables, article tables, or publication data.

The database-enforced invariants are:

1. Commands and command events are immutable; events are append-only.
2. `(command_type, idempotency_key)` identifies one accepted command, while a partial unique index permits only one active run per `dedupe_key`. Terminal history does not block later equivalent work.
3. Claims use row locks with `FOR UPDATE SKIP LOCKED`. Expired leases are closed as `lease_expired` before a new attempt is created.
4. Every attempt receives a globally increasing sequence-backed fencing token. Heartbeat, success, and failure lock the attempt and run and require the current token, current attempt identity, unexpired lease, running state, and no abort.
5. Heartbeat timestamps and lease extensions are persisted. Process memory is not authoritative.
6. Abort terminalizes queued, waiting, or running work in one transaction. A running attempt becomes `aborted`, and its worker can no longer heartbeat, complete, or fail the run.
7. Retryable failures schedule bounded exponential backoff until `max_attempts`; terminal failures and exhausted leases finish the run.
8. Payload references, summaries, messages, reasons, and event details are bounded. Application services redact sensitive keys and text, database payload guards reject secret-like keys, and RPC errors expose fixed codes rather than database details.
9. Security-definer RPC execution is revoked from `PUBLIC`; only `service_role` receives execute permission. Anonymous and authenticated roles receive no table DML.

Operational rehearsal, acceptance evidence, rollback, and the ingress inventory are in `docs/admin-command-control-plane-p0.md`.

## P1 Direct GitHub Workers

P1 adds `20260712130000_admin_command_worker_p1.sql`, a direct GitHub worker, canonical bounded handlers, and an exact-candidate retry path. The migration is additive and rerunnable. It adds a cohort-filtered claim RPC plus service-role-only candidate begin/finish RPCs; it does not alter or remove the P0 claim RPC, `admin_jobs`, article/publication state, or public readers.

Execution authority requires all three server-side settings: `ADMIN_QUEUE_V3_WORKER_ENABLED=true`, a non-empty bounded `ADMIN_QUEUE_V3_WORKER_COMMAND_TYPES` allowlist, and a non-empty bounded `ADMIN_QUEUE_V3_WORKER_COHORTS` allowlist. The flag defaults to false. The P1 claim RPC filters command type and `payload_ref.cohort` before row locking, so a worker cannot claim outside its configured cohort. P0 `shadowed` runs remain terminal and unclaimable.

The approved P1 command vocabulary is `p1.collect`, `p1.summarize`, `p1.candidate.retry`, `p1.refresh-derived`, and `p1.public-cache.revalidate`. Handlers call the existing ingestion, summary, tag-count, candidate adapter, and cache-revalidation services. Cache invalidation is invoked through the authenticated deployed Next endpoint because `revalidateTag` and `revalidatePath` are owned by that runtime; GitHub still owns the queue claim, heartbeat, handler orchestration, and fenced terminal transition.

The 06:00 KST workflow has mutually exclusive P1 and legacy branches under one concurrency group. P1 submits and executes collect, bounded summary drain, derived-count refresh, and cache revalidation in that order. With the worker flag off, the existing Crawlee/summarize/tag/cache steps run unchanged. The separate V2 `admin_jobs` workflow and cron endpoint remain deployable rollback paths.

Candidate retry loads one candidate by service-role RPC, validates source ownership and the official HTTPS host/path policy, and passes the stored URL unchanged to `fetchItem`. It never calls `discover`, substitutes a base/list URL, or follows a broad fallback. Candidate attempt count is the transition fence; fetched/ignored rows are idempotent no-ops, and retrying attempts finish as fetched or failed with bounded evidence.

Worker heartbeat persists every lease extension through P0 RPCs. A watchdog aborts a shared execution signal on process stop, local deadline, or heartbeat-reported abort/lease loss; renewal stops after that point, and a non-settling handler is raced out without leaving an unhandled rejection or a path to successful terminalization. Supported ingest, robots/sitemap discovery, source-specific fetches, Crawlee queue/run boundaries, LLM, candidate, refresh, and cache operations receive the signal and guard durable boundaries. Completion and failure always use the claimed fencing token; a stale worker's terminal write is rejected. P1 operational settings, rollout, parity evidence, abort SLA, and rollback are specified in `docs/admin-command-control-plane-p1.md`. Gate 2 remains closed until the migration and production-shaped verification are approved and the documented observation evidence is complete.
