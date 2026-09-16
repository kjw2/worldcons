# WorldCons M5-B4.1 — Germany 2023 production private-shadow (discover complete, fetch blocked on reviewed throughput)

Date: 2026-09-16

Status: **PARTIAL — 2023 DISCOVERY SEALED, FETCH IN PROGRESS, BLOCKED BY REVIEWED 30s/REQUEST SOURCE-POLICY THROUGHPUT**

This document records the Germany 2023 expansion authorized by the owner on 2026-09-16 under the existing reviewed 2024 source-policy assumptions, bounded to 2023 only. Discovery is complete and sealed. The fetch phase cannot be completed inside a single bounded run because the reviewed source policy mandates a 30-second minimum request delay with concurrency 1 and the existing fetch implementation issues roughly seven governed requests per item; the full 354-item tranche therefore needs roughly 20 wall-clock hours. The production fetch drain was left running against the sealed snapshot so the controller can let it finish or resume it with one command.

This is an operational throughput blocker, not a legal/robots/source-policy blocker: every reviewed assumption was independently re-verified unchanged and no new exception was needed.

## 1. Authorization and assumption re-verification

The owner explicitly instructed continuing the Germany historical backfill and authorized extending the reviewed 2024 policy to the next single year, 2023 only, conditional on every reviewed assumption being unchanged. Live read-only verification on 2026-09-16 confirmed:

| Assumption | Observation | Verdict |
| --- | --- | --- |
| BVerfG robots.txt | HTTP 200, SHA-256 `7565360aa0562e6f2a86d90f58566885b8bf9106e6e493453f1fc9079837e17f`, `Crawl-delay: 30`, `/SiteGlobals/` disallowed | unchanged (exact reviewed hash) |
| Official scope URL | `https://www.bundesverfassungsgericht.de/DE/Entscheidungen/entscheidungen_node.html` HTTP 200 | unchanged |
| Terms URL | `.../DE/Service/Impressum/impressum_node.html` HTTP 200 (manual review fetch, as in the 2026-09-04 review) | unchanged |
| Sitemap index | `Sitemap_Index.xml` HTTP 200, still points only to `Sitemap_Basepage.xml` (still cannot prove exhaustive enumeration) | unchanged |
| dejure robots | `User-agent: *` still allows `/dienste/rechtsprechung?gericht=BVerfG`; `31.12.2222` sentinel still disallowed | unchanged |
| External index | `https://dejure.org/dienste/rechtsprechung?gericht=BVerfG` HTTP 200 | unchanged |
| Authority host / redirect host / external index host | `www.bundesverfassungsgericht.de` / `www.bverfg.de` / `dejure.org` | unchanged |
| Inventory method, fetch/verify semantics, `external_index_assisted` limitation, `metadata_only` private shadow, Gemini denied | same resolver, parser, and validator path as 2024 | unchanged |

No new legal, robots, or source-policy decision was required. No broader year (2022 or older) was opened or authorized in this run.

## 2. Successor policy migration

New migration, applied to the linked production Supabase project:

`20260916110000_constitutional_case_germany_2023_policy_approval.sql`

- inserts immutable policy row `de-bverfg` / `bverfg-unattended-canary-v2`
- `supersedes_policy_version = bverfg-unattended-canary-v1` (lineage only; the v1 row is never updated or deleted)
- only scope change is `approvedYears: [2024, 2023]`; document type, hosts, robots/terms, discovery method, `metadata_only`, `bounded_evidence`, 30000 ms delay, concurrency 1, and Gemini-denied posture are byte-for-byte the reviewed v1 values
- `reviewed_by = WorldCons owner via explicit approval`, `reviewed_at = 2026-09-16T00:00:00Z`, `review_due_at = 2027-03-15T00:00:00Z`

Pre-apply checks:

- `supabase db push --linked --dry-run` reported exactly one pending migration (`20260916110000`).
- zero non-terminal `p1.case-backfill.*` command runs; zero active item claims; zero unreleased source request permits; zero open snapshots; `service_role` present.

Post-apply verification:

- v1 row unchanged (`WorldCons owner via unattended automatic approval`, review due 2027-03-03, no `supersedes`).
- v2 row present, supersedes v1, `approvedYears = [2024, 2023]`.
- `supabase_migrations.schema_migrations` contains `20260916110000 / constitutional_case_germany_2023_policy_approval`.

Code guard state: `germanyBverfgExpansionGuard` authorizes exactly 2024 and 2023; 1998-2022 returns `case_backfill.germany_expansion_not_approved`; 2025+ stays outside Gate 5. `rollout:readiness` now reports `approvedSelectionCount = 32`, `newlyAuthorizedSelectionCount = 31`, Germany `approvedYears = [2023, 2024]`, `policyVersion = bverfg-unattended-canary-v2`.

## 3. Production discovery (complete)

- Snapshot: `57948d51-1300-4ff1-86db-be00a6572bc9`
- source policy: `bverfg-unattended-canary-v2`
- coverage assurance: `external_index_assisted`
- scope: `2023-01-01`..`2023-12-31`, document type `DECISION`
- status: `closed`
- discovered count: **354**
- closed manifest hash: `d93af2b195b2ec0b667f8c56f46c20e4b7a6ea74dc9bd9431d4bf3439c745c76`
- enumeration manifest hash: `dc89833d131f755dfe10dae26c8e1926182ca971788ddaa9af71bbe8de77a7b2`
- enumeration artifacts: 26 (25 page + 1 boundary probe)
- opened `2026-09-16T11:36:13.934744Z`, closed `2026-09-16T11:49:39.959178Z`
- P1 evidence: command `6ba6743f-5f17-4ce3-be39-ac14eeb61a1e`, run `9beee557-abc1-4e06-93a4-bb400b86ee77`, attempt `05e489eb-cfde-4c7c-ae44-a76ed4b269c6` (`succeeded`, claimed 1 / succeeded 1)

Independent live read-only verifier result before any write (`pnpm verify:bverfg-inventory -- --year=2023`):

- discovered: 354
- unresolved official URL candidates: 2
- page count: 25, request count: 26
- observed last page: 425
- first page probe stable: true
- verifier enumeration artifact manifest hash: `fda0bbb9488f4f12c71daa1f0f0d49aa6471af115fd36a77acdbaebb33589e6a`
- `inventoryContractVerified: true`, `productionWriteAuthorized: false`, `geminiCalls: 0`

## 4. Fetch phase (in progress — throughput blocker)

- Snapshot fetch drain launched with process-scoped flags only:

```bash
CASE_CATALOG_GERMANY_HISTORY_ENABLED=true \
CASE_CATALOG_WRITE_ENABLED=false \
ADMIN_QUEUE_V3_WORKER_ENABLED=true \
ADMIN_QUEUE_V3_WORKER_COMMAND_TYPES=p1.case-backfill.discover,p1.case-backfill.fetch,p1.case-backfill.normalize,p1.case-backfill.verify,p1.case-backfill.reconcile \
ADMIN_QUEUE_V3_WORKER_COHORTS=catalog-backfill \
pnpm backfill:bverfg-fetch-drain -- --snapshot=57948d51-1300-4ff1-86db-be00a6572bc9 \
  --batch-limit=2 --max-passes=400 --execute --requested-by=worldcons-germany-2023-rollout
```

Observed throughput:

- fetch pass 1: 2 items claimed/succeeded in 394 s
- fetch pass 2: 2 items claimed/succeeded in 476 s
- ≈ 200 s per item
- 43 granted source-request permits for the first ~6 items processed (≈ 7 governed requests/item)
- 354 items × ≈ 200 s ≈ **20 h**, exceeding any single bounded run

Root cause is the reviewed policy floor, not a defect to be waived here: `min_request_delay_ms = 30000` with `max_concurrency = 1` governs every authority request, and the current fetch path issues multiple governed requests per item (robots + official URL candidates). Halving this would require changing fetch behavior, which the 2023 authorization explicitly does not cover, so execution stopped short of completion instead of altering reviewed semantics.

State at 2026-09-16T12:11:34Z (live, if still draining):

- `fetched`: 5, `fetching`: 1, `discovered`: 348, terminal failures: 0, active claims: ≤ 1
- fetch runs: 3 started (pass 1, 2 `succeeded`)

Resume or monitor:

```bash
# monitor
pnpm backfill:corpus status --snapshot=57948d51-1300-4ff1-86db-be00a6572bc9
# resume the same bounded drain (idempotent; reuses queued passes)
pnpm backfill:bverfg-fetch-drain -- --snapshot=57948d51-1300-4ff1-86db-be00a6572bc9 --batch-limit=2 --max-passes=400 --execute --requested-by=worldcons-germany-2023-rollout
```

The remaining phases for this tranche once fetch completes are:

`normalize → verify → reconcile → status → pnpm verify:bverfg-shadow-canary -- --snapshot=57948d51-1300-4ff1-86db-be00a6572bc9`

`publish` is not part of this wave.

## 5. Non-regression and fail-closed state

- Prior 2024 replacement snapshot `d6c7b404-2252-4369-a719-8e17d2dfaba2` is unchanged: 287 items, manifest `7971b3b988a338896bfc156f56ca9bbb81fe113e9db0eafd8f4cab4e36df3446`, enumeration manifest `f353a780f426bc2acd750fefeb9a233fab5a6fa32e0b9d66c33c4e160c9a2cd3`.
- Superseded 2024 snapshot `63d50ccb-9824-4460-bb06-049e410b3015` remains `superseded`, untouched.
- 2022 and older remain `case_backfill.germany_expansion_not_approved`.
- `CASE_CATALOG_WRITE_ENABLED` was forced `false` for every process; no `p1.case-backfill.publish` command was created; `case_catalog_publications_v1` has zero `de-bverfg` rows and Gemini/AI calls remain zero.
- The Germany history flag was supplied only to the bounded execution processes; after they stop, default readiness returns `case_backfill.germany_history_disabled` with `publicCatalogWrites=0` and `geminiCalls=0`.

## 6. Acceptance status

| Criterion | Status |
| --- | --- |
| Reviewed assumptions unchanged | met |
| Successor policy migration applied and conflict-detecting | met (20260916110000) |
| 2024 remains valid / 2022 stays blocked | met (tests + readiness) |
| 2023 discover sealed with manifest | met (354 items, `d93af2b1…`) |
| 2023 fetch/normalize/verify/reconcile complete | **not met — fetch ≈ 20 h, in progress** |
| every item verified or excluded | not met (fetch incomplete) |
| 2024 snapshot/hash unchanged | met |
| no Catalog publication / Gemini | met |

## 7. Next frontier

1. Let the 2023 fetch drain finish (≈ 20 h total), then run normalize, verify, reconcile, and `verify:bverfg-shadow-canary`.
2. Only after 2023 is fully sealed and canary-passed consider 2022, which still requires its own owner-approved policy version.
