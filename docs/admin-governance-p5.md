# Administrator Redesign P5: Operational Governance

## Status and scope

P5 is **implementation-ready**. Gate 5 and compatibility retirement remain **evidence-pending** until a real production observation window, current restore rehearsal, named approvals, and all health/parity gates pass. This stage does not remove a legacy reader or writer, flip a feature flag, apply a production migration, deploy, or certify production retirement.

The additive migrations are `supabase/migrations/20260712230000_admin_governance_p5.sql`, `supabase/migrations/20260712231000_admin_governance_p5_indexes.sql`, and the rerunnable acceptance correction `supabase/migrations/20260712233000_admin_governance_p5_acceptance_corrections.sql`. Apply them in that order after P0-P3. Run the index file outside a transaction because every index uses `CREATE INDEX CONCURRENTLY`; the base and correction files remain transactional. The health RPC returns aggregate counts/presence, age values, state distributions, source keys, evidence digests, approval roles, distinct actor counts, expiry, and status only. It does not return row identifiers, URLs, article/source text, payloads, credentials, usernames, or actor hashes.

## Ownership placeholders

Replace each placeholder in the production operations register before enabling verification:

| Role | Named owner placeholder | Responsibilities |
| --- | --- | --- |
| Operations owner | `TBD-OPERATIONS-OWNER` | Queue, workers, heartbeat, abort, retries, outbox, alert response |
| Data owner | `TBD-DATA-OWNER` | Lifecycle backlog, review age, publication parity, retention classification |
| Security owner | `TBD-SECURITY-OWNER` | Retirement approvals, evidence integrity, ACL/RLS review, legal hold liaison |
| Backup/restore role | `TBD-BACKUP-RESTORE-OWNER` | Backup verification, isolated restore rehearsal, evidence marker custody |
| Incident commander | `TBD-INCIDENT-COMMANDER` | Severity declaration, escalation, rollback coordination |

Owner approvals in `/admin/governance` are session-only, CSRF-protected, hashed, immutable evidence with a bounded expiry. Each approval is bound to the exact current `p5-evidence-v2` digest. Three required roles must have three distinct active actors for that same digest. They do not approve Gate 5 by themselves.

Configure role binding server-side with exact identity allowlists or pre-hashed actor allowlists. Document variable names, never values:

| Role | Exact identity variable | Pre-hashed allowlist variable |
| --- | --- | --- |
| Operations | `ADMIN_P5_OWNER_OPERATIONS_IDENTITIES` | `ADMIN_P5_OWNER_OPERATIONS_ACTOR_HASHES` |
| Data | `ADMIN_P5_OWNER_DATA_IDENTITIES` | `ADMIN_P5_OWNER_DATA_ACTOR_HASHES` |
| Security | `ADMIN_P5_OWNER_SECURITY_IDENTITIES` | `ADMIN_P5_OWNER_SECURITY_ACTOR_HASHES` |

Lists are comma-separated and bounded. A configured actor may belong to only one required role; any overlap or malformed hash invalidates the binding configuration. An unbound session cannot choose a role from the request. A single configured admin may approve at most its one bound role, so environments with only one admin identity correctly remain evidence-pending until distinct operators are provisioned.

## SLO policy and alerts

`lib/admin/p5/policy.ts` is the single typed policy. Every override is bounded and falls back safely. Values are never printed from the environment. Source freshness can use `ADMIN_P5_SOURCE_FRESHNESS_OVERRIDES_JSON`, limited to 50 source keys and 1-720 hours.

| Severity | Meaning | Response |
| --- | --- | --- |
| `critical` | Hard SLO exceeded, evidence unavailable, parity drift, or dead letter | Page operations owner; incident commander within 15 minutes; stop the narrowest authority change |
| `warning` | Warning threshold exceeded | Operations/data owner investigates during the current support window |
| `unknown` | Required aggregate evidence unavailable | Treat as critical for health verification and retirement readiness |
| `healthy` | At or below warning threshold | Continue observation; no retirement inference by itself |

The scheduled/manual workflow is disabled unless repository variable `ADMIN_P5_HEALTH_VERIFICATION_ENABLED` is exactly `true`. It creates a redacted JSON artifact and exits nonzero on critical or unknown SLOs. It adds no collection schedule and does not duplicate the production crawler or queue workers.

## Incident playbooks

### Stale worker or lease

1. Declare critical when heartbeat/lease age crosses the hard policy.
2. Confirm worker flag, allowlisted cohort, workflow status, and aggregate stale lease count without exposing worker IDs.
3. Stop new claims by disabling the narrowest worker flag. Do not mutate fencing tokens or leases manually.
4. Let the lease expire and use the fenced retry path. Verify one execution authority owns the cohort before re-enabling.
5. Record aggregate before/after evidence, owner, UTC times, and rollback decision.

### Summary quota exhaustion

1. Confirm retry age/backlog and the safe provider error class; do not log keys or source text.
2. Pause the summary cohort if retries amplify quota pressure. Collection may continue only if backlog capacity remains safe.
3. Restore with bounded drain size after quota recovery. Confirm lifecycle processing and attention counts converge.

### Source outage

1. Use per-source freshness, latest run time, and aggregate run status to identify scope.
2. Confirm robots/network/source-template state through existing diagnostics. Do not bypass source policy.
3. Disable only the affected source/cohort if retries create pressure. Keep other sources and publication independent.
4. After recovery, run a bounded catch-up and confirm freshness plus lifecycle backlog return below warning.

### Publication parity drift

1. Treat any mismatch, quarantine row, or identity-digest difference as critical.
2. Disable `ADMIN_PUBLICATION_V4_READ_ENABLED` first if public correctness is uncertain; preserve both authorities for diagnosis.
3. Run P3 evidence/reconciliation in read-only or approved bounded mode. Do not edit immutable history.
4. Re-enable only after count and identity parity, zero unexplained anomalies, and data-owner review.

### Outbox lag or dead letters

1. Confirm pending/processing counts and oldest delivery age. Any dead letter is critical under the default policy.
2. Verify the outbox processor flag and authenticated cache endpoint without printing tokens.
3. Retry through the idempotent P3 processor. Do not publish again merely to recreate an event.
4. Archive dead-letter evidence; never delete it through P5 maintenance apply mode.

## Retention and legal hold

`pnpm admin:retention:p5` is dry-run by default. It reports due counts for terminal command attempts/events, lifecycle events, publication history, content versions, compatibility observations, delivered outbox, and dead-letter outbox.

Authoritative command/lifecycle/publication history and content versions are archive/partition recommendations only. P5 apply mode never deletes them, current versions, publication history, source snapshots, or dead letters. The only batch-delete eligible records are expired aggregate compatibility buckets and old delivered outbox rows:

```bash
pnpm admin:retention:p5 -- --apply --confirm="APPLY P5 RETENTION"
```

Apply is limited to 500 rows per domain per invocation, enforces documented minimum ages, and fails when an active `admin_retention_holds_p5` record covers `all`, `observations`, or `outbox`. Legal/privacy counsel owns hold creation and release through a separately controlled DBA change. Prefer detached/archived partitions for high-volume ledgers.

Minimum defaults: terminal commands 180 days, lifecycle audit 7 years, publication/version authority 7 years, compatibility observations 400 days, delivered outbox 180 days, dead letters 2 years and archive-only. Local law, litigation hold, or organizational policy may require longer periods, never shorter than the enforced minimums without a separately approved change.

## Backup and restore rehearsal

1. Backup role records the backup identifier and SHA-256 evidence outside application logs.
2. Restore into an isolated nonproduction target. Verify schema, row-count aggregates, immutable trigger behavior, P0-P3 evidence RPCs, and P5 aggregate redaction.
3. Run focused P0-P5 tests against the isolated target. Do not connect restored workers to production queues or callbacks.
4. Record one successful `backup_restore` evidence marker with owner hash, evidence digest, rehearsal time, and bounded expiry through the controlled operations procedure.
5. Retirement readiness fails closed when the marker is missing, expired, or older than policy.

## Rollout and rollback order

Legal rollout order:

1. Apply additive migrations and enable `ADMIN_P5_COMPATIBILITY_OBSERVATION_ENABLED`; leave all legacy compatibility intact.
2. Enable and prove new queue worker authority for allowlisted cohorts.
3. Enable lifecycle P2 reads after P2 reconciliation passes.
4. Enable P3 publication reads and outbox processor after publication count and identity parity pass.
5. Disable queue, lifecycle, and publication shadow writes only after the corresponding new authority is stable.
6. Enable P5 governance UI and health workflow independently when operators are ready.
7. Observe for at least 336 continuous hours (14 days by default), with coverage at both window boundaries and `ADMIN_P5_COMPATIBILITY_OBSERVATION_SAMPLE_RATE=1` for the full retirement window. Sampling may be lower outside a retirement evidence window.
8. Run the read-only retirement evaluator with explicit UTC bounds. No script flips flags or deletes data.

Rollback reverses the narrowest read/worker flag first, preserves dual-written data, and confirms no mixed execution authority. Publication read rollback must not require data rollback. Observation and P5 UI flags may be disabled without changing application authority.

## Retirement evaluator

The evaluator requires explicit bounds and is read-only. Its evidence digest excludes `generatedAt`, report wording, approval accumulation, and other presentation fields. It canonically hashes versioned thresholds, exact observation bounds, presence/last-seen evidence, aggregate gate inputs, backup marker, legal flags, and the required approval rule. Identical evidence is stable; a gate-relevant input change produces a new digest and invalidates older approval sets.

```bash
pnpm admin:retirement:p5 -- --observation-start=2026-07-01T00:00:00Z --observation-end=2026-07-15T00:00:00Z
```

It requires complete full-sample observation coverage; zero unexplained legacy reads/writes; passing P0-P3 anomalies, count parity, and identity digest; no hard/unknown SLO or stale lease; no legacy in-flight work or mixed authority; healthy outbox; current restore evidence; all owner approvals; and legal flag order. Output contains only aggregate evidence, a SHA-256 digest, and an optional HMAC signature when `ADMIN_P5_REPORT_SIGNING_KEY` is configured. The key itself is never output.

## Future compatibility removal

Destructive cleanup is a separate, future change requiring its own approval, current backup/restore evidence, legal retention review, rollback plan, and production observation report. That change may stop legacy writers/readers and later archive or remove compatibility data. P5 intentionally does none of those things and must not be cited as Gate 5 production approval.
