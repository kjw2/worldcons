# Administrator Command Control Plane P1 Operations

Status: implementation complete; disabled by default; migration and production verification not applied

## Scope

P1 runs selected P0 commands directly in GitHub Actions. It adds the direct worker, bounded operational handlers, exact source URL candidate retry, and the ordered 06:00 KST pipeline. It does not change article/publication state, public read authority, administrator UI, or the V2 `admin_jobs` rollback path.

The additive rerunnable migration is `supabase/migrations/20260712130000_admin_command_worker_p1.sql`. Apply it only after Gate 1 is accepted on an approved production-shaped copy. Do not enable the P1 worker before the migration is present and verified.

## Feature Flags

| Setting | Default | Requirement |
| --- | --- | --- |
| `ADMIN_QUEUE_V3_WORKER_ENABLED` | `false` | Only case-insensitive `true` enables the application worker; the GitHub repository variable must be lowercase `true` to select the P1 workflow branch |
| `ADMIN_QUEUE_V3_WORKER_COMMAND_TYPES` | empty | Required bounded comma-separated subset of the five P1 command types |
| `ADMIN_QUEUE_V3_WORKER_COHORTS` | empty | Required bounded comma-separated subset of `daily`, `candidate-retry`, `manual` |
| `ADMIN_QUEUE_V3_SHADOW_WRITE_ENABLED` | `false` | Independent P0 evidence flag; shadowed runs are never executable |

An enabled flag with either allowlist missing, empty, oversized, or unknown exits with configuration code 2 and performs no claim. Authority is evaluated in the GitHub Node process and enforced again by the P1 claim RPC before locking a row.

## GitHub Secrets

Required names by enabled handler are:

- Queue and database: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
- Summarization: `LLM_PROVIDER` and the selected provider secret, currently `OPENAI_API_KEY`, `GEMINI_API_KEY`, or `GEMINI_API_KEYS`
- Embeddings when enabled: `EMBEDDING_PROVIDER` and its provider key
- Public cache revalidation: `CRON_SECRET`

`NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` remain workflow compatibility inputs but never authorize P1 command or candidate RPCs. `WORLDCONS_BASE_URL` is an optional GitHub variable override, not a secret; the current canonical production base URL remains the fallback.

## Authority Matrix

| Cohort | Worker flag | Allowlist | Execution authority | Rollback authority |
| --- | --- | --- | --- | --- |
| `daily` | off | any | Legacy Crawlee workflow steps | Already active |
| `daily` | on | all four daily command types plus `daily` | Direct P1 GitHub worker | Disable flag; next run uses legacy steps |
| `candidate-retry` | off | any | No P1 claim; existing candidate status operation remains available | Existing admin API |
| `candidate-retry` | on | `p1.candidate.retry` plus `candidate-retry` | Dispatch-only P1 GitHub worker | Disable flag |
| V2 `admin_jobs` | either | unrelated | Existing 15-minute `admin-job-worker.yml` | Same workflow and `/api/admin/cron/jobs` |
| P0 shadow evidence | either | unrelated | Never executable (`shadowed` terminal state) | Disable shadow flag |

Both P1 workflows use concurrency group `admin-command-p1` with cancellation disabled. The scheduled daily workflow selects exactly one of its P1 and legacy branches. Do not configure another schedule for a cohort during P1.

## Rollout Cohorts

1. **Production-shaped rehearsal:** keep all flags off; apply P0 then P1 migrations twice; run focused P0/P1 tests and inspect grants, claim plans, lease recovery, candidate fencing, and rerunnability.
2. **Manual cohort:** enable only `manual` and one low-risk command type. Verify claims, persisted heartbeat, terminalization, redacted logs, and aggregate parity.
3. **Candidate retry cohort:** enable only `candidate-retry` and `p1.candidate.retry`; execute approved candidate UUIDs. Sample the fetched URL identity in protected database evidence, never logs.
4. **Daily cohort:** use `daily` with `p1.collect,p1.summarize,p1.refresh-derived,p1.public-cache.revalidate`. Confirm the workflow skips every legacy daily execution step.
5. **Observation:** retain V2 workflows and flags for the full Gate 2 window. P1 remains reversible and default-off in source.

## Execution and Observability

The daily order is collect, bounded summarize/drain, refresh derived tag counts, then public cache revalidation. Retryable stages wait for the bounded database backoff and are reclaimed at most twice more in the same workflow; terminal failures stop the pipeline visibly. Manual inputs are limited to known sources/strategies, collect limits 1-100, date ranges 1-730, summary passes 1-8, and drain counts 1-20. Existing defaults remain 14 days, Spain 180 days with a 730-day cap, and BVerfG 60 days.

Logs are one-line JSON. They contain event name, aggregate counts, safe status/error code, and command/run/attempt IDs. They never contain payloads, candidate URLs, source text, provider output, tokens, secrets, or HTTP response bodies. Exit codes are: 0 success/disabled, 2 invalid configuration/input, 3 control-plane failure, 4 command failure or retry wait, and 5 abort/lost authority/fencing rejection.

Monitor these Gate 2 metrics by cohort and command type:

- submitted, claimed, succeeded, retry-wait, failed, aborted, lease-expired, and unclaimed counts
- command ID uniqueness, attempt count, fencing rejection count, heartbeat age, and lease-reclaim count
- legacy/P1 collected, fetched, summarized, deferred, failed, and tag-count aggregate parity
- candidate pending/retrying/fetched/failed transitions and duplicate article suppression
- cache revalidation success rate and daily stage duration

No lost command, duplicate execution, unexplained aggregate divergence, raw-data log event, or stale successful completion is acceptable.

## Abort SLA

The default lease is 180 seconds and heartbeat/checkpoint cadence is at most 60 seconds. Abort must be observed at the next heartbeat or bounded-step checkpoint, with a Gate 2 target of 75 seconds from abort request to an `aborted` terminal run. A process signal stops new claims and requests retryable yield at the next checkpoint. If authority is already lost, the worker does not attempt a stale business or terminal commit; the database abort/reclaim path is authoritative. Measure p95 and maximum abort latency in production-shaped evidence.

## Rollback

1. Stop manual dispatches and wait for the shared P1 concurrency group to clear, or abort active P1 runs.
2. Set `ADMIN_QUEUE_V3_WORKER_ENABLED=false`. Do not alter the allowlists yet.
3. Confirm no running P1 lease remains; abort or let an expired lease terminalize through the database policy.
4. Run the existing `crawlee-worker.yml` manually and verify the legacy branch executes. Keep `admin-job-worker.yml` enabled.
5. Compare aggregate counts and revalidate public caches through the existing authenticated endpoint.
6. Record trigger, command/run/attempt IDs, aggregate before/after evidence, owner, and follow-up. Do not delete P1 commands, runs, attempts, candidate evidence, or events.

The additive migration normally remains in place. Forward-fix it unless an independently approved non-destructive rollback has been rehearsed.

## Gate 2 Evidence

Gate 2 remains closed until all items are attached to the approval record:

- production-shaped migration applied twice with lock/runtime evidence and service-role grants verified
- default-off/no-claim, allowlist/cohort, heartbeat, abort, retry classification, stale fence, unsupported type, and signal/timeout tests
- exact candidate URL fidelity, no discovery fallback, official ownership, transition fencing, idempotency, and bounded error evidence
- daily schedule, ordered stage, concurrency, input bounds, four-country date settings, and legacy rollback workflow tests
- at least one lease-expiry/reclaim rehearsal proving the old fencing token cannot complete
- parity report for legacy and P1 aggregates with every divergence explained
- abort p95/max within the 75-second target and zero raw payload/URL/text/secret log findings
- rollback rehearsal demonstrating the next daily run uses the legacy branch without a schema rollback

Only the named approver may open Gate 2. P2 work must not begin from implementation completion alone.
