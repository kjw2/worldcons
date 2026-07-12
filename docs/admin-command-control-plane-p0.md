# Administrator Command Control Plane P0

Status: implementation complete; migration not applied to production

## Scope

P0 establishes the durable backend contract for administrator commands, runs, attempts, leases, fencing, heartbeat, retry, abort, and safe events. It preserves the existing `admin_jobs` and direct administrator execution paths. It does not add a V3 worker, change queue readers, change article state, add publication/version/outbox contracts, change the administrator UI, push code, deploy code, or apply a production migration.

The only migration is:

`supabase/migrations/20260712090000_admin_command_control_plane.sql`

It depends on the repository migration chain through:

`supabase/migrations/20260710100000_fix_claim_admin_job_parameter_references.sql`

The migration is additive. It creates `admin_commands`, `admin_command_runs`, `admin_command_attempts`, `admin_command_events`, `admin_command_fencing_token_seq`, indexes, immutable-record triggers, and transaction RPCs. It does not alter or backfill `admin_jobs`, ingestion, articles, or publication data.

## Authority and Flag

`ADMIN_QUEUE_V3_SHADOW_WRITE_ENABLED` is server-only and defaults to `false`. Unset, empty, `false`, `1`, and all other values are false; only case-insensitive `true` enables it.

When false:

- Every state-changing administrator execution enters `executeAdminCompatibilityCommand`.
- The adapter calls the existing implementation exactly once.
- The legacy implementation remains the only write/execution authority.
- No V3 command, run, attempt, or event is written.

When true:

- The same legacy implementation still executes first and remains authoritative.
- Every adapter call supplies an explicit domain success predicate. Merely resolving is not success.
- Only after the predicate confirms success does the adapter write an immutable command and terminal `shadowed` run.
- Resolved failures and no-ops, including `{ ok: false }`, unavailable, incomplete, skipped, invalid, not-found, no-database, and null-result outcomes, return unchanged with `shadow: "skipped"` and do not submit.
- A thrown legacy failure propagates unchanged before the predicate or submitter can run.
- A predicate failure is treated conservatively as non-success and does not submit.
- A shadow write is never claimable and cannot duplicate execution.
- A shadow failure does not change the legacy response. Its result is a structured safe command error available to the caller for observability.

P0 never reads `ADMIN_QUEUE_V3_WORKER_ENABLED` and includes no V3 worker loop. Enabling the shadow flag is not a worker cutover.

Cron authentication remains separate. `/api/admin/cron/ingest` and `/api/admin/cron/jobs` continue to require the configured cron secret through `isAuthorizedSecretRequest`; browser administrator mutations continue to require session/secret authorization and CSRF/origin checks through `adminMutationAuthFailureStatus`.

Authentication session creation and deletion are identity-boundary operations, not control-plane execution commands. `/api/admin/login` and `/api/admin/logout` therefore remain outside the compatibility adapter.

## Ingress Inventory

The compatibility adapter covers these execution families:

| Family | Endpoint |
| --- | --- |
| Ingestion enqueue | `/api/admin/ingest` |
| Legacy worker drain | `/api/admin/jobs/run`, `/api/admin/cron/jobs` |
| Legacy cron ingestion | `/api/admin/cron/ingest` |
| Legacy job cancel/retry | `/api/admin/jobs/[jobId]` |
| Article review and bulk actions | `/api/admin/review`, `/api/admin/articles/bulk` |
| Manual summary edit | `/api/admin/articles/[articleRef]/summary` |
| Candidate transitions | `/api/admin/candidates` |
| Glossary generation/ignore/approve | `/api/admin/glossary-candidates` |
| LLM settings and health check | `/api/admin/llm-settings`, `/api/admin/llm-settings/test` |
| Public cache revalidation | `/api/admin/public-content/revalidate` |

## Database Invariants

- Command identity is permanent: `(command_type, idempotency_key)` is unique.
- Execution dedupe is active-only: the partial unique index covers `queued`, `running`, and `retry_wait`, so terminal history does not suppress future equivalent work.
- Submission serializes idempotency and dedupe decisions with transaction-scoped advisory locks. The partial index remains the final database guard.
- Claim selects bounded eligible work with `FOR UPDATE SKIP LOCKED` and creates one numbered attempt atomically.
- Reclaim closes the old attempt as `lease_expired` before assigning a new globally increasing fencing token.
- Heartbeat updates `heartbeat_at` and `lease_expires_at` in PostgreSQL.
- Heartbeat, completion, and failure require the current attempt id, matching fencing token, an unexpired lease, `running` state, and no abort request.
- Abort records the request and terminalizes the run and current attempt in the same transaction. It is idempotent for terminal runs.
- Retryable failure uses `min(cap, base * 2^(attempt_number - 1))`; terminal failure and attempt exhaustion finish the run.
- Commands and events reject update/delete. State transitions occur only through the security-definer RPCs.
- RPC execution is revoked from `PUBLIC` and granted to `service_role`; anonymous and authenticated table access is revoked.
- Queue JSON is bounded and rejects secret-like keys. Application services redact metadata and messages before RPC calls. Event details never contain command payloads, source text, URLs, credentials, or secrets.

## Safe Errors and Events

Repository errors are mapped to stable public codes: `unavailable`, `invalid_input`, `not_found`, `active_duplicate`, `stale_fence`, `lease_lost`, `aborted`, `not_retryable`, `unsafe_data`, `conflict`, and `internal`. Raw PostgreSQL or PostgREST messages are not returned by the command service.

The append-only event vocabulary is `command_accepted`, `command_deduplicated`, `run_queued`, `compatibility_shadowed`, `attempt_claimed`, `lease_reclaimed`, `heartbeat`, `attempt_succeeded`, `retry_scheduled`, `run_failed`, `abort_requested`, `run_aborted`, and `manual_retry_queued`.

## Acceptance Evidence

Gate 0 commit `87cba71` was accepted and independently run live through the production pooler in read-only repeatable-read mode. The accepted result was `explicitPublic=1174`, with all reported malformed, stale, and cancel anomalies equal to zero.

P0 migration and transition tests use a disposable PostgreSQL database whose name must contain `p0`; the test refuses to reset any other database. The suite applies the migration twice before testing rerunnability. Run it with:

```powershell
$env:P0_TEST_DATABASE_URL='postgresql://postgres@127.0.0.1:55432/worldcons_p0'
pnpm test:p0
```

The focused acceptance cases are concurrent duplicate idempotency, concurrent active-only dedupe, terminal dedupe reuse, expired lease reclaim, increasing fencing tokens, stale token rejection, persisted heartbeat extension, abort before claim, abort during execution, an abort/completion lock race, retryable backoff, high-attempt backoff capping, terminal failure, unsafe payload rejection, RPC grants and immutability, unauthorized ingress, default-off compatibility, resolved legacy failures, thrown legacy failures, success-predicate failures, successful shadow writes, and non-authoritative shadow submission failures.

Repository acceptance also requires:

```powershell
pnpm exec tsc --noEmit
pnpm lint
pnpm check
pnpm build
git diff --check
```

No production-shaped migration timing evidence is claimed by local tests. Gate 1 remains blocked until the migration is rehearsed on an approved production-shaped copy, locks and runtime are recorded, constraints and grants are inspected, and forward-fix/rollback operations are reviewed.

## Migration Rehearsal

Use an approved non-production clone. Do not use the production pooler or database for rehearsal.

1. Record schema-only pre-state for `admin_%` objects and current migration history.
2. Apply migrations in repository timestamp order through `20260712090000`.
3. Apply the P0 migration a second time and require success.
4. Verify all four tables, the sequence, partial dedupe index, claim/lease indexes, immutable triggers, foreign keys, checks, and function grants.
5. Run the focused PostgreSQL suite against a separate disposable database.
6. Record aggregate row counts only. Do not capture payload references, messages, URLs, metadata blobs, credentials, or secrets.
7. Keep `ADMIN_QUEUE_V3_SHADOW_WRITE_ENABLED=false` until Gate 1 is accepted.

## Rollback and Forward Fix

The immediate application rollback is to leave or set `ADMIN_QUEUE_V3_SHADOW_WRITE_ENABLED=false`. This restores pure legacy behavior without a data rollback. P0 does not enable V3 reads or claims, so existing `admin_jobs` processing remains unchanged.

Do not delete commands, runs, attempts, or events to roll back. Do not drop the additive schema in a routine rollback. Preserve it for diagnosis and prefer a forward migration for schema/function defects. If a separately approved destructive inverse is ever required before P1, first prove that the V3 tables contain no relied-upon evidence, capture schema-only backup evidence, stop every V3 writer, and rehearse the inverse on a clone.

If shadow writing is enabled during a later gate and errors rise:

1. Set `ADMIN_QUEUE_V3_SHADOW_WRITE_ENABLED=false`.
2. Confirm legacy endpoint behavior and `admin_jobs` processing.
3. Record aggregate shadow success/failure counts and fixed safe error codes.
4. Preserve all V3 rows and event history.
5. Correct with a new additive migration or application fix, then repeat the gate.
