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
- The read-only manifest check covers 12 redesign migrations, 35 fixed-search-path `SECURITY DEFINER` functions, two outside-transaction index files, and 18 concurrent indexes.

Lock/deployability shape:

- P0/P1 create new queue objects; their indexes do not scan legacy tables.
- P2 adds nullable/constant-default article metadata without a heap rewrite, adds checks `NOT VALID`, then explicitly validates them. Validation scans `articles`; schedule and observe its `SHARE UPDATE EXCLUSIVE` lock. Its four indexes use `CREATE INDEX CONCURRENTLY` outside a transaction.
- P3 creates new authority tables. Its transactional indexes target only those new empty tables; reconciliation is bounded and never runs automatically.
- P5 base/correction files are transactional. Fourteen governance/operability indexes, including indexes on existing tables, were moved to `20260712231000_admin_governance_p5_indexes.sql` and must run outside a transaction with `CREATE INDEX CONCURRENTLY`.
- RLS, PUBLIC/anon/authenticated revocation, service-role grants, fixed `search_path`, index validity/readiness, idempotence, and aggregate-only evidence passed. Routine rollback preserves additive data and uses forward fixes rather than destructive migration reversal.

## Flags And Compatibility

All authority flags are server-side and enabled only by trimmed, case-insensitive `true`. Defaults remain legacy:

- UI, queue shadow/worker, lifecycle shadow/read, publication shadow/read/outbox, P5 observation, governance UI, and health verification are false by default; queue command/cohort and lifecycle cohort allowlists are empty.
- Queue worker authority additionally requires bounded command and cohort allowlists.
- Governance UI additionally requires the redesigned shell flag. Observation, governance UI, and health verification do not change queue, lifecycle, or publication authority.
- With flags off, public home/list/detail/search and V2 admin behavior remained intact. Public visibility continued to use the legacy publication predicate.

## Browser And Security

- Local production build passed at 1440x900 and 390x844. Flag-off public routes and V2 admin, plus flag-on shell, work queue, work detail, and governance rendered without console errors, hydration overlays, document overflow, or login identity disclosure.
- Fixed the mobile modal-navigation focus defect found during verification: focus now enters the dialog, remains contained, closes on Escape, and returns to the opener.
- Security smoke: unauthenticated new actions returned 401; cron credentials returned 401 for P4/P5 human actions; authenticated requests without CSRF returned 403; GET mutation routes returned 405; unchanged public APIs returned 200. Redaction and session-only action contracts also passed focused suites.
- Browser/server logs and screenshots were not retained. Local servers and PostgreSQL were stopped after verification.

## Rollout And Rollback

Production rollout remains gated and ordered: apply schema with every flag false; prove P0 shadow evidence; enable only allowlisted P1 worker cohorts; reconcile and observe P2 cohorts; prove P3 backfill/parity, then enable one outbox worker and canary reads; enable P4 UI independently; enable P5 observation/governance/health independently; complete the observation, restore, approval, and legal gates before any future compatibility retirement.

Rollback disables the narrowest authority first: P3 public reads, P3 outbox claims, P1 worker claims, then the corresponding shadow writer. UI, governance, and observation flags may be disabled independently. Preserve queue, lifecycle, publication, outbox, and governance evidence; use additive forward fixes.

## Production Evidence Pending

- Production-shaped migration runtime, lock-wait, table/index growth, pgvector plan, and parity evidence.
- Live P0-P3 backfill/anomaly/identity checks, canary observation, cache/outbox SLOs, and rollback rehearsal.
- At least 336 continuous production observation hours, current isolated restore evidence, named distinct-owner approvals, legal/retention review, and retirement approval.
- Strict no-write browser attestation: the first local browser launch inherited the repository analytics configuration before analytics was explicitly disabled, so a bounded page-view event may have been emitted. No production inspection or cleanup was performed. All subsequent browser checks ran with analytics and every redesign writer/worker flag explicitly disabled.

No production migration, deployment, push, compatibility retirement, retention action, or administrator data action occurred in this final stage.
