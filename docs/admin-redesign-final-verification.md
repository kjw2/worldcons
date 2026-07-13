# Administrator Redesign Final Verification

## Scope

- Audited implementation range: `87cba71` through pre-integration HEAD `486172b` (Gate0, P0, P1, P2, P3, P4, and P5).
- Final integration adds only configuration/default documentation, migration deployability checks, a P5 database rehearsal, mobile focus correction, regression coverage, and this evidence.
- `design-drafts/` was not read, changed, staged, or committed.

## Results

- Phase suites: 128 passed, 0 failed, 0 skipped across `test:gate0`, `test:p0`, `test:p1`, `test:p2`, `test:p3`, `test:p4`, and `test:p5`. The combined final run completed in 64.1 seconds.
- Contract coverage includes duplicate submit/claim, fencing, heartbeat, abort, retry, exact candidate URL, lifecycle failure/recovery/review, explicit version publish/withdraw/outbox/projection, session-only P4 actions, and digest-bound P5 approvals/retention failure. Queue or lifecycle completion alone did not change public visibility.
- Project verification passed: TypeScript, ESLint, `pnpm check`, `pnpm admin:migrations:check`, production build, and `git diff --check`.
- The production build includes the new admin work/detail/governance pages and work/governance API routes.

## Migration Rehearsal

- Used only an isolated local PostgreSQL cluster and dedicated database names containing `p0`, `p1`, `p2`, `p3`, or `p5`. Tests reject destructive setup against a database without the expected phase marker. `DATABASE_URL` was not used by destructive tests.
- P0, P1, P2, P3, and P5 PostgreSQL suites passed. The P5 suite applied the complete P0 -> P1 -> P2 -> P3 -> P5 chain in timestamp order and reapplied every rerunnable file; its full-chain test completed in 2.1 seconds.
- Local pgvector was unavailable. P3 used the existing test-only `double precision[]` operator shim and skipped only the pgvector index implementation. Production migrations were not changed for vector compatibility.
- The read-only manifest check covers 14 redesign migrations, 36 fixed-search-path `SECURITY DEFINER` functions, two outside-transaction index files, and 18 concurrent indexes.

Lock/deployability shape:

- P0/P1 create new queue objects; their indexes do not scan legacy tables.
- P2 adds nullable/constant-default article metadata without a heap rewrite, adds checks `NOT VALID`, then explicitly validates them. Validation scans `articles`; schedule and observe its `SHARE UPDATE EXCLUSIVE` lock. Its four indexes use `CREATE INDEX CONCURRENTLY` outside a transaction.
- P3 creates new authority tables. Its transactional indexes target only those new empty tables; reconciliation is bounded and never runs automatically.
- P5 base/correction files are transactional. Fourteen governance/operability indexes, including indexes on existing tables, were moved to `20260712231000_admin_governance_p5_indexes.sql` and must run outside a transaction with `CREATE INDEX CONCURRENTLY`.
- RLS, PUBLIC/anon/authenticated revocation, service-role grants, fixed `search_path`, index validity/readiness, idempotence, and aggregate-only evidence passed. Routine rollback preserves additive data and uses forward fixes rather than destructive migration reversal.

## Authority Flags And Compatibility

The redesigned administrator shell, unified work queue, and governance screen are permanent and have no V2 fallback flag. Remaining authority flags are server-side and enabled only by trimmed, case-insensitive `true`. Defaults remain compatible:

- Queue shadow/worker, lifecycle shadow/read, publication shadow/read/outbox, P5 observation, and health verification are false by default; queue command/cohort and lifecycle cohort allowlists are empty.
- Queue worker authority additionally requires bounded command and cohort allowlists.
- Governance visibility does not change queue, lifecycle, or publication authority.
- Public visibility continues to use the independently controlled publication predicate.

## Permanent Administrator Cutover

- `/admin` always renders the redesigned operations overview after authentication.
- `/admin/work` and `/admin/governance` no longer have UI feature-flag redirects.
- The V2 tab strip and standalone action/attention/job components were deleted.
- `/admin/operations` permanently redirects to `/admin`; `/admin/jobs` permanently redirects to `/admin/work?type=execution`.
- Compatibility job data remains available through `/admin/work/legacy/[id]`; no retired screen is linked from the new shell.

## Browser And Security

- The pre-cutover local production build passed at 1440x900 and 390x844. The permanent-cutover verification reruns the redesigned shell, work queue, work detail, governance, and retained specialist pages with no V2 fallback surface.
- Fixed the mobile modal-navigation focus defect found during verification: focus now enters the dialog, remains contained, closes on Escape, and returns to the opener.
- Security smoke: unauthenticated new actions returned 401; cron credentials returned 401 for P4/P5 human actions; authenticated requests without CSRF returned 403; GET mutation routes returned 405; unchanged public APIs returned 200. Redaction and session-only action contracts also passed focused suites.
- Browser/server logs and screenshots were not retained. Local servers and PostgreSQL were stopped after verification.

## Rollout And Rollback

Production rollout remains gated and ordered: apply schema with every flag false; prove P0 shadow evidence; enable only allowlisted P1 worker cohorts; reconcile and observe P2 cohorts; prove P3 backfill/parity, then enable one outbox worker and canary reads; enable P4 UI independently; enable P5 observation/governance/health independently; complete the observation, restore, approval, and legal gates before any future compatibility retirement.

Rollback disables the narrowest authority first: P3 public reads, P3 outbox claims, P1 worker claims, then the corresponding shadow writer. UI, governance, and observation flags may be disabled independently. Preserve queue, lifecycle, publication, outbox, and governance evidence; use additive forward fixes.

## Production Migration Execution

The production database migration and additive backfill ran on 2026-07-13 with every redesign authority flag left disabled:

- Supabase migration history is current through `20260713093000`. The P2 and P5 concurrent-index files were executed one statement at a time in autocommit mode, then recorded with the official migration-repair command because Supabase CLI pipeline mode cannot execute multiple `CREATE INDEX CONCURRENTLY` statements.
- Supabase extension references are schema-qualified (`extensions.digest`, `extensions.vector`, vector distance operator, and vector opclass). This matches the production extension installation and preserves fixed function `search_path` restrictions.
- P2 initialized 1,174 articles in three bounded batches. Uninitialized rows, lifecycle anomalies, legacy-only rows, and compatibility-only rows are zero; legacy and compatibility public identity digests match.
- P3 initialized 1,174 immutable versions and publication rows in 50-row batches after a 500-row attempt failed atomically on the statement timeout. Legacy and projection public counts are both 1,174, identity digests match, and both directional mismatch counts are zero.
- Ten legacy-public articles had completed processing after an explicit summary approval. P3 now recognizes that completed state as eligible. One quarantine created before the correction remains immutable and has an appended resolution record; unresolved quarantine is zero.
- All 1,175 publication outbox events were delivered. Pending, processing, failed/dead-letter, and projection parity counts are zero after delivery.
- The post-migration Gate 0 anomaly set is zero and the P5 operational health check reports no hard SLO violations. Retirement readiness remains pending because observation, restore, distinct-owner, legal, and flag-order evidence is intentionally incomplete.

## Production Evidence Pending

- Production canary observation, detailed lock-wait/table/index-growth capture, pgvector query-plan review, and rollback rehearsal.
- At least 336 continuous production observation hours, current isolated restore evidence, named distinct-owner approvals, legal/retention review, and retirement approval.
- Strict no-write browser attestation: the first local browser launch inherited the repository analytics configuration before analytics was explicitly disabled, so a bounded page-view event may have been emitted. No production inspection or cleanup was performed. All subsequent browser checks ran with analytics and every redesign writer/worker flag explicitly disabled.

Production schema migration, additive lifecycle/publication backfill, tag-count refresh, cache revalidation, and outbox delivery occurred in this rollout. No redesign authority flag was enabled, and no compatibility retirement, retention deletion, or destructive article/source-snapshot mutation occurred.
