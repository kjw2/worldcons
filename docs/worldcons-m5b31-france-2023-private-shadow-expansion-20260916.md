# WorldCons M5-B3.1 France 2023 private-shadow expansion evidence

Date: 2026-09-16

## Scope

This stage executes the first post-canary historical expansion wave for the already approved France Conseil constitutionnel source policy:

- source: `fr-conseil-constitutionnel`
- policy: `france-dila-constit-2026-09-v1`
- year: 2023
- document types: `QPC`, then `DC`
- mode: Gate 5 private shadow only
- publication: disabled
- Gemini/AI: disabled

`CASE_CATALOG_FRANCE_HISTORY_ENABLED=true` was supplied only to each bounded CLI process. `CASE_CATALOG_WRITE_ENABLED=false` was also supplied for every executable phase. The default environment was not changed.

## Official read-only inventory cross-check

Before opening either production snapshot, `verify:france-inventory` re-downloaded the official DILA CONSTIT stock and independently compared it to the Conseil constitutionnel annual/type facet.

### 2023 QPC

- DILA in-scope count: 45
- Conseil annual/type count: 45
- exact identity-set match: true
- page count: 1
- DILA stock: `Freemium_constit_global_20250713-140000.tar.gz`
- stock SHA-256: `67270556060b481ec139f21436244af913cccd3eb6e074c65d6600f48596f627`

### 2023 DC

- DILA in-scope count: 15
- Conseil annual/type count: 15
- exact identity-set match: true
- page count: 1
- DILA stock and SHA-256: same sealed official stock as QPC

## QPC production private shadow

Snapshot:

`f7356ffa-e45e-453d-a6e3-bfffe92ea688`

Closed manifest:

`71e2aecebd5a55882ce576e6bbcfbd497d1352d8036536c216b9fe645a64e03b`

Final evidence:

- expected: 45
- discovered: 45
- fetched: 45
- normalized: 45
- verified: 45
- published: 0
- item errors: 0
- active claims after completion: 0
- retryable failures: 0
- terminal failures: 0

All five runs (`discover`, `fetch`, `normalize`, `verify`, `reconcile`) finished with status `succeeded`.

The 45-item production fetch also served as the first live verification of M5-B2.1. The prior `AsyncEventEmitter` / `migrating` listener warning did not recur during the full QPC fetch.

## DC production private shadow

Snapshot:

`8c1a5ea8-b221-4b78-8df1-e74ef51e6da1`

Closed manifest:

`0c65b361ac6b460dcf147c70f0f031b84b6b394e2c30a2de8ba9bb694135d400`

Final evidence:

- expected: 15
- discovered: 15
- fetched: 15
- normalized: 15
- verified: 15
- published: 0
- item errors: 0
- active claims after completion: 0
- retryable failures: 0
- terminal failures: 0

All five runs (`discover`, `fetch`, `normalize`, `verify`, `reconcile`) finished with status `succeeded`.

## Combined operational audit

The 2023 expansion wave therefore completed:

- 60/60 authoritative inventory items discovered
- 60/60 fetched
- 60/60 normalized
- 60/60 verified
- 0 retryable failures
- 0 terminal failures
- 0 active claims after completion
- 0 item errors
- 0 Catalog publications
- 0 `p1.case-backfill.publish` commands
- 0 Gemini/AI work

Commands submitted by `chatgpt-m5b3-france-2023` were exactly two successful commands for each of:

- `p1.case-backfill.discover`
- `p1.case-backfill.fetch`
- `p1.case-backfill.normalize`
- `p1.case-backfill.verify`
- `p1.case-backfill.reconcile`

No publish command was submitted.

The France policy still has zero rows in `case_catalog_publications_v1` after this wave.

## Fail-closed state after execution

After all scoped command processes ended, default readiness was checked without the history flag:

```text
source/year/type      France / 2023 / QPC
policyAuthorized      true
executionEnabled      false
allowed               false
errorCode             case_backfill.france_history_disabled
publicCatalogWrites   0
geminiCalls           0
```

Therefore the expansion flag was not persisted into the normal environment.

## Stage decision

M5-B3.1 (France 2023 QPC/DC) is complete.

The next bounded historical expansion wave is:

1. 2022 QPC
2. 2022 DC

Each year/type remains an independent authoritative snapshot and must complete `discover -> fetch -> normalize -> verify -> reconcile` before moving to the next tranche. Catalog publication remains a separate later gate.
