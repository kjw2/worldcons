# WorldCons staged ingest — M6 reliability / M7 local verification (2026-10-08)

## Current status

**Local code and fake E2E only; not production enabled.** The new staged
pipeline must remain off until deployment preflight, additive D1 migrations,
queue provisioning and operational approval are complete.

- Worker: worldcons-ingest; per-stage Cloudflare Queues plus durable
  worldcons_ingest stage jobs and outbox. The older M8 worker/cron remains
  authoritative until cutover.
- Feature flags in wrangler.jsonc: WORLDCONS_INGEST_STAGES_ENABLED=false,
  WORLDCONS_INGEST_STAGE_ALLOWLIST="" (fail closed).
- No preview/staging deployment. No remote D1/R2 mutation or paid model
  request took place during this verification.

## Implemented M6 safeguards

1. **Atomic D1 stage handoff:** completeStageAndRegisterNext now requires
   D1.batch. Parent completion, idempotent child registration, and success /
   advancement event inserts happen in a single ingest DB transaction. Failure
   of child registration rolls back the parent; no separate-write fallback.
   Fencing token **and unexpired lease** are checked before success.
2. **Bounded retries:** if a consumer repeatedly crashes and an expired lease
   has already reached max_attempts, the next bounded claim marks it
   dead_letter with ingest_stage.lease_attempts_exhausted. It is never
   repeatedly re-leased. This is not an automatic override of source policy.
3. **Daily discovery:** each daily bootstrap request has its own version keyed
   by its scheduled UTC day; reruns during a day are idempotent, but a
   previously completed discovery no longer suppresses tomorrow's crawl.
   A discovered URL's crawl job also carries the daily version; normalize
   still dedupes genuinely identical retrieved content by content hash.
4. **Outbox identity collision fixed:** the physical dispatch message ID is
   now a SHA-256 digest of the entire canonical job key, not its first 100
   sanitized characters. This distinguishes dates, source revisions and
   content hashes even with long official source IDs.
5. Prior M0-M5: dispatcher cannot complete consumers' jobs; fencing tokens,
   durable dispatch outbox, per-stage physical queue selection, policy gates,
   per-article publication/search and canonical article identity remain intact.

## Verified tests

- pnpm test:ingest-stages: **41/41**, including fake single-case
  discovery -> crawl -> normalize -> translate -> public-judgment -> publish
  -> search, wrong fence, double delivery, no false publish, rollback fault
  injected at the child insert, exhausted-lease terminalization and
  next-day re-discovery of an unchanged official URL.
- pnpm test:m8: **40/40**; pnpm test:native-crawler: **10/10**;
  pnpm test:ingest-workflow: **16/16**.
- pnpm exec tsc --noEmit, pnpm m8:typecheck,
  pnpm m8:types:check (after generating types), pnpm m8:dry-run,
  git diff --check: **pass**.

## Existing red checks — release not green

The following commands are still failing, including in the earlier M4-M5
baseline verification, and must be reconciled before release:

- pnpm test:p3: immutable authority/public surface contract assertion expecting
  adminQueries.select("id").
- pnpm test:d1-case-catalog: expected one public Catalog/legacy list row that
  the current source-only visibility policy excludes.
- pnpm test:reference-reads: legacy Supabase adapter selection expectation
  conflicts with Cloudflare D1 authority.
- pnpm check: article detail on-demand ISR assertion.

These regressions are outside the M6 changes. Their failure remains a
**release blocker** unless reviewed and explicitly rebaselined against the
current production-only Cloudflare architecture. Do not simply skip tests.

## Diagnostic procedure (read only)

If the additive migration is present, query worldcons_ingest by status,
stage, next_attempt_at and lease_expires_at. Use bounded limits and indexed
filters; do not scan every row each cron tick. Correlate
ingest_stage_job_events and ingest_stage_dispatch_outbox by job_id or
idempotency_key. To diagnose a suspected lost transition, check both the
parent event and the child by deterministic idempotency key; the new
transaction makes a partial parent/child commit impossible.

Dead-letter rows remain terminal. **Do not automatically reset or publish
them.** Manual redrive tooling, operator authorization, policy-state
reinspection, and per-stage DLQ drainage tests are still pending.

## Remaining M6/M7 pre-production gates

- Exercise real Cloudflare Queue retry/DLQ semantics in an authorized
  production-only controlled release; fake SQLite cannot prove remote
  isolation, R2 and service-binding latency, or Gemini 429 timing.
- Implement audited, permissioned dead-letter redrive and observability
  reporting (per-stage counts, oldest pending and oldest lease).
- Resolve/rebaseline four release checks above without bypassing
  publication source authority and privacy gates.
- Keep the master feature flag **off** until migrations and consumer
  topology have been verified and an explicit activation decision is made.
