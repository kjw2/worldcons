# WorldCons M5-B3.2 — France 2022 production rollout preflight (2026-09-16)

Status: **READ-ONLY PREFLIGHT COMPLETE — PRODUCTION MIGRATIONS/BACKFILL NOT EXECUTED**

This document records the controller-reviewed operational preflight for the France 2022 QPC/DC private-shadow wave after owner approval and implementation of `france-dila-constit-2026-09-v2`.

## 1. Safety state

- Repository HEAD: `95505c717e0300e2192dccdd1c2b0e91b70d73d2` (`feat: implement france 2022 source policy v2`).
- `main` is ahead of `origin/main`; no push or deploy was performed in this stage.
- Protected untracked paths remain untouched:
  - `artifacts/`
  - `docs/worldcons-recovery-and-improvement-plan-20260905.md`
- No production migration was applied.
- No 2022 snapshot, run, item, claim, or backfill write was created.
- Public Catalog/article publication remains disabled.
- Gemini/AI egress remains zero.
- 2021 and older France tranches remain blocked until 2022 completes successfully.

## 2. Read-only evidence completed before rollout

The controller re-ran the live v2 inventory verifier against the current official DILA archive chain and Conseil constitutionnel sources.

### 2022 QPC

- expected/discovered: **67/67**
- exact Conseil identity-set match: yes
- applied exception: exactly one `e2_dila_canonicalization`
- omission fallback count: 0
- canonicalization count: 1

### 2022 DC

- expected/discovered: **13/13**
- exact Conseil identity-set match: yes
- applied exception: exactly one `e1_conseil_provider_fallback`
- omission fallback count: 1
- canonicalization count: 0

Both runs used:

- stock: `Freemium_constit_global_20250713-140000.tar.gz`
- stock SHA-256: `67270556060b481ec139f21436244af913cccd3eb6e074c65d6600f48596f627`
- ordered increments: 21
- cumulative XML members: 7,600
- increment-chain hash: `556e75db2021b0396125bb880555f831c79da554a1a31ed8ba2201114529562d`

Controller hardening additionally requires:

- E1: every raw DILA XML member in the selected stock + all ordered increments is scanned for both `2022847DC` and `CSCL2237744S`; any hit makes the exception stale and fails closed.
- E1: the current official Conseil detail page must still match the frozen canonical URL, title/decision number, description, ECLI, and JORF evidence.
- E2: the duplicate set must be exactly `CONSTEXT000046216504` + `CONSTEXT000047955984` for `20225813AN_QPC`, and the current Conseil detail title/ECLI must still match the frozen owner-reviewed canonical record before `CONSTEXT000047955984` is selected.

## 3. Verification state

Post-hardening verification passed:

- `pnpm typecheck`
- `pnpm lint`
- `pnpm check`
- `pnpm test:backfill`: **142 pass / 0 fail / 1 skip** (disposable PostgreSQL unavailable)
- `pnpm test:catalog`: **13 pass / 0 fail / 1 skip**
- `pnpm test:postgres:release:static`: **7 pass / 0 fail / 0 skip**
- `git diff --check`
- France v2 focused tests: **15/15 pass**

Default rollout readiness remains fail-closed. With no France history flag, 2022 QPC reports:

- `policyAuthorized=true`
- `executionEnabled=false`
- `allowed=false`
- `errorCode=case_backfill.france_history_disabled`
- `publicCatalogWrites=0`
- `geminiCalls=0`

## 4. Pending production migrations

`supabase db push --linked --dry-run` was executed read-only. It reported exactly these pending migrations and no others:

1. `20260916100000_constitutional_case_france_policy_v2_approval.sql`
2. `20260916101000_constitutional_case_france_inventory_provenance_v3.sql`
3. `20260916102000_constitutional_case_france_public_attribution_v2.sql`

No migration was applied by the dry run.

## 5. v2 → v3 worker cutover constraint

The rollout has one important operational compatibility boundary.

- The previously deployed/older repository path calls `source_inventory_item_upsert_v2`.
- HEAD `95505c7` calls `source_inventory_item_upsert_v3`.
- Migration `20260916101000` creates v3, revokes `service_role` execute on v2, and grants execute on v3 in the same migration transaction.

Therefore:

1. **Running the new worker before the migration is invalid** because v3 does not yet exist in production.
2. **Running an old worker after the migration is invalid** because `service_role` can no longer execute v2.
3. The migration must be applied inside a **backfill-idle window** with no queued/running P1 case-backfill work and no active claims.
4. Immediately after migration verification, only the worker from HEAD `95505c7` or a later compatible commit may perform case-backfill discovery.

The current operational backfill path runs through the local P1 CLI worker (`scripts/backfill-corpus.ts` / `runAdminCommandWorkerP1`). No Next.js route or Vercel cron directly invokes `runCaseBackfillPass`; the configured Vercel cron is unrelated to this France private-shadow path. Consequently a Vercel application redeploy is **not a prerequisite for this bounded private-shadow wave**, provided no separately deployed/scheduled stale P1 worker is active. Any such worker must be stopped or upgraded before migration application.

## 6. Mandatory pre-apply checks

Before any production migration is applied:

1. Confirm HEAD and worktree:
   - HEAD must be `95505c7` or a reviewed successor containing the same v3/E1/E2 contracts.
   - only the two protected untracked paths may remain.
2. Re-run `supabase db push --linked --dry-run` and require exactly the three migrations in §4.
3. Confirm the production France v1 policy row and existing 2024/2023 closed snapshots are unchanged.
4. Confirm there are no open France 2022 snapshots.
5. Confirm no queued/running/retry-wait `p1.case-backfill.*` command/run exists.
6. Confirm no residual active item claims exist.
7. Confirm `service_role` exists.
8. Re-run 2022 QPC/DC live v2 verification and require 67/67 and 13/13 respectively.
9. Confirm default readiness remains `france_history_disabled` with public writes/Gemini zero.
10. Confirm production backup/PITR posture before applying schema changes.

Any failure is a stop condition.

## 7. Production migration sequence (not executed in this stage)

When explicitly authorized for M5-B3.2 execution:

1. Freeze/stop all case-backfill workers and verify no in-flight P1 work.
2. Re-run linked dry-run.
3. Apply exactly the three migrations in timestamp order.
4. Verify:
   - v2 policy row exists and supersedes v1 without modifying v1;
   - `source_inventory_item_upsert_v3` exists;
   - `service_role` execute on v3 = true;
   - `service_role` execute on v2 = false;
   - France public-attribution validator/trigger is bound to v2 guard;
   - Catalog/public/Gemini flags remain off.
5. Use only HEAD `95505c7`-compatible worker code after the migration.

Migrations are forward-only. Do not edit an already applied migration and do not use migration-history repair to hide a failed rollout. Any schema correction must be a new timestamp migration.

## 8. 2022 private-shadow execution order (not executed in this stage)

The rollout remains newest-to-oldest. 2024 and 2023 are complete, therefore the next wave is:

1. **2022 QPC**
2. verify QPC is fully sealed and clean
3. **2022 DC**
4. verify DC is fully sealed and clean
5. stop; do not start 2021 in the same approval step

For each tranche, use process-scoped France history enablement and P1 command-control/fencing only. No direct production `UPDATE`/`INSERT`/`DELETE` is permitted.

QPC has 67 items, so item-processing phases must use a batch limit that covers 67 (e.g. `--batch-limit=100`) or explicitly run a second bounded pass. DC has 13 items.

Expected flow for each snapshot:

`discover → fetch → normalize → verify → reconcile → status`

`publish` is not part of this wave.

## 9. Acceptance criteria

### QPC

- expected = 67
- discovered = 67
- fetched = 67
- normalized = 67
- verified = 67
- retryable failures = 0
- terminal failures = 0
- item errors = 0
- active claims after completion = 0
- snapshot closed with valid manifest hash
- exactly one E2 retirement evidence block:
  - canonical: `CONSTEXT000047955984`
  - retired: `CONSTEXT000046216504`

### DC

- expected = 13
- discovered = 13
- fetched = 13
- normalized = 13
- verified = 13
- retryable failures = 0
- terminal failures = 0
- item errors = 0
- active claims after completion = 0
- snapshot closed with valid manifest hash
- exactly one E1 Conseil-provider item:
  - stable key `constit:conseil-omission:2022847dc`
  - `provider=conseil`
  - `reasonCode=dila_omission_verified_absent`

For both tranches:

- discover/fetch/normalize/verify/reconcile runs must terminate successfully;
- no `p1.case-backfill.publish` command may be created;
- public Catalog publications remain zero;
- Gemini/AI calls remain zero;
- existing 2024/2023 closed snapshot manifest hashes remain unchanged;
- after the scoped execution environment exits, readiness must again return `case_backfill.france_history_disabled`.

## 10. Stop conditions

Stop immediately and do not continue to the next phase/tranche if any of the following occurs:

- migration dry-run includes any file other than the three listed in §4;
- any case-backfill command/run/claim is active at migration cutover;
- v3 privilege verification fails;
- live source counts differ from QPC 67 or DC 13;
- E1/E2 count is not exactly one for its applicable tranche;
- Conseil corroboration or DILA absence evidence drifts;
- unexpected DILA duplicate/surplus/mismatch appears;
- any item reaches retryable/terminal failure after the bounded recovery policy;
- any active claim remains after a phase;
- any public Catalog row or publish command appears;
- any Gemini/AI activity occurs;
- an existing 2024/2023 manifest changes.

## 11. Progress accounting

This preflight does **not** change production completion counts.

- 2024 QPC/DC: complete
- 2023 QPC/DC: complete
- 2022 QPC/DC: not yet production-complete
- France QPC/DC total remains **4/30** production-complete
- 2021 and 2020–2010 remain pending

The count may move from 4/30 to 6/30 only after both 2022 QPC and DC private-shadow snapshots satisfy all acceptance criteria above.

