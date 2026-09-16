# WorldCons M5-B3.2 — France 2022 private-shadow completion evidence

Date: 2026-09-16

Status: **COMPLETE — PRODUCTION PRIVATE-SHADOW VERIFIED, PUBLICATION/AI REMAIN OFF**

## Scope

This stage completed the next newest-to-oldest France historical expansion wave under the owner-approved successor policy:

- source: `fr-conseil-constitutionnel`
- policy: `france-dila-constit-2026-09-v2`
- year: 2022
- document types: QPC, then DC
- execution: P1 command-control / fencing only
- Catalog publication: disabled
- Gemini/AI: disabled

The three additive v2 migrations were applied to the linked production Supabase project before the 2022 run:

1. `20260916100000_constitutional_case_france_policy_v2_approval.sql`
2. `20260916101000_constitutional_case_france_inventory_provenance_v3.sql`
3. `20260916102000_constitutional_case_france_public_attribution_v2.sql`

Post-application verification confirmed that `service_role` can execute `source_inventory_item_upsert_v3`, cannot execute v2, and the immutable v2 policy row supersedes v1 without changing the existing v1 row. A final linked `supabase db push --dry-run` reports `Remote database is up to date.`

## Official inventory verification

Immediately before each production tranche, the live read-only verifier re-downloaded the official DILA CONSTIT stock plus every ordered increment and independently reconciled the result against the Conseil constitutionnel annual/type facet and reviewed detail evidence.

Common archive evidence:

- stock: `Freemium_constit_global_20250713-140000.tar.gz`
- stock SHA-256: `67270556060b481ec139f21436244af913cccd3eb6e074c65d6600f48596f627`
- ordered increments applied: 21
- cumulative XML members: 7,600
- increment-chain hash: `556e75db2021b0396125bb880555f831c79da554a1a31ed8ba2201114529562d`

QPC verification:

- expected: 67
- discovered: 67
- exact identity-set match: true
- exception applications: exactly one `e2_dila_canonicalization`
- canonical DILA ID: `CONSTEXT000047955984`
- retired DILA ID: `CONSTEXT000046216504`
- Conseil identity: `20225813AN_QPC`

DC verification:

- expected: 13
- discovered: 13
- exact identity-set match: true
- exception applications: exactly one `e1_conseil_provider_fallback`
- stable item key: `constit:conseil-omission:2022847dc`
- Conseil identity: `2022847DC`
- reason: `dila_omission_verified_absent`

## QPC production private shadow

Snapshot:

`1273e11d-e754-4fcc-809a-e23d7de2a231`

Closed manifest:

`3955d040bb54995ef26ac7b7c292371c4d2d4c1764e6d4b65ca9d3b2eaf03188`

Enumeration manifest:

`a081d71937850015e01a811b10ab9f4a8f5046c0a8b5f6d4ce2429a43bc79b37`

Final database evidence:

- expected/discovered: 67/67
- item status: 67 `verified`
- fetch: 67/67
- normalize: 67/67
- verify: 67/67
- item errors: 0
- active claims after completion: 0
- retryable failures: 0
- terminal failures: 0
- E2 retirement evidence blocks: exactly 1

All five runs (`discover`, `fetch`, `normalize`, `verify`, `reconcile`) finished `succeeded`.

## DC production private shadow

Snapshot:

`de5e7ff3-75ff-4458-b2d7-44c1268618a3`

Closed manifest:

`70fa8c53373c4473a658638d2d86a4a825a0555fba4bf7cd1d06b1c4dd257a88`

Enumeration manifest:

`a081d71937850015e01a811b10ab9f4a8f5046c0a8b5f6d4ce2429a43bc79b37`

Final database evidence:

- expected/discovered: 13/13
- item status: 13 `verified`
- fetch: 13/13
- normalize: 13/13
- verify: 13/13
- item errors: 0
- active claims after completion: 0
- retryable failures: 0
- terminal failures: 0
- E1 Conseil-provider items: exactly 1

All five runs (`discover`, `fetch`, `normalize`, `verify`, `reconcile`) finished `succeeded`.

## Combined operational audit

The 2022 wave completed:

- 80/80 authoritative items discovered
- 80/80 fetched
- 80/80 normalized
- 80/80 verified
- 0 retryable failures
- 0 terminal failures
- 0 item errors
- 0 active claims
- 0 active `p1.case-backfill.*` command runs after completion
- 0 rows in `case_catalog_publications_v1`
- 0 `p1.case-backfill.publish` commands
- all bounded rollout preflight output reported `publicCatalogWrites=0` and `geminiCalls=0`
- independent production inspection found no embedding/AI write attributable to this wave

The prior closed France snapshots remain unchanged:

- 2024 QPC: `9e61bcc34d61d99a8f6216b287cfd13ab9290a687368f5e304e7ca58abea4523`
- 2024 DC: `b88b4a0d1d0a28a22a9e5304663db18cb3daf5918340167bd253bb477baadd5f`
- 2023 QPC: `71e2aecebd5a55882ce576e6bbcfbd497d1352d8036536c216b9fe645a64e03b`
- 2023 DC: `0c65b361ac6b460dcf147c70f0f031b84b6b394e2c30a2de8ba9bb694135d400`

## Fail-closed state after execution

The France history flag was only supplied to the bounded execution processes. After those processes exited, default readiness was re-run and returned:

- `policyAuthorized=true`
- `executionEnabled=false`
- `allowed=false`
- `errorCode=case_backfill.france_history_disabled`
- `publicCatalogWrites=0`
- `geminiCalls=0`

The default environment therefore remains closed.

## Stage decision

M5-B3.2 (France 2022 QPC/DC) is complete.

France QPC/DC production completion advances from **4/30 to 6/30**. The next newest-to-oldest expansion wave is 2021 QPC, then 2021 DC. It requires a new bounded execution step; this completion does not automatically start 2021 and does not authorize Catalog publication.

