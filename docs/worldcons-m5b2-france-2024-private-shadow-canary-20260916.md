# WorldCons M5-B2 — France 2024 QPC/DC private-shadow canary — 2026-09-16

## Result

**PASS.** The owner-approved France historical source policy was exercised against production Supabase for the bounded 2024 `QPC` and `DC` canaries only. Both immutable snapshots were discovered, fetched, normalized, verified, and reconciled successfully. No Catalog publication phase was submitted, no item was published, and no Gemini/AI phase was invoked.

The history enable flag was scoped to the individual CLI processes. After the canary commands exited, the default readiness check again returned `case_backfill.france_history_disabled`.

## Approved scope used by this canary

- source: `fr-conseil-constitutionnel`
- policy: `france-dila-constit-2026-09-v1`
- policy review due: `2027-03-15`
- historical year: `2024`
- document types: `QPC`, `DC`
- Catalog write: disabled
- public Catalog: unchanged/disabled by this stage
- AI/Gemini egress: denied / zero calls
- `L` / `LP` / `OTHER_CONSEIL_NATURE`: not approved and not executed

## Read-only source reconciliation immediately before execution

The live DILA stock and Conseil annual/type facets were re-verified before any inventory write.

```text
stock filename   Freemium_constit_global_20250713-140000.tar.gz
stock SHA-256    67270556060b481ec139f21436244af913cccd3eb6e074c65d6600f48596f627
compressed bytes 12,511,366
expanded bytes   73,502,720
XML members      7,112

2024 QPC         DILA 42 / Conseil 42 / exact identity-set match
2024 DC          DILA 12 / Conseil 12 / exact identity-set match
```

Coverage basis for both snapshots is `authoritative_crosschecked` with expected-count basis `official_dila_stock_and_conseil_facet_exact_identity_set`.

## Schema blocker found and repaired before the canary

The first QPC `discover` attempt was stopped by PostgreSQL before a snapshot row could be created:

```text
source_inventory_snapshots_authoritative_count_check
```

The original Gate 1 constraint required a non-null `expected_count` as soon as an `authoritative_counted` or `authoritative_crosschecked` snapshot was inserted. France discovery, however, intentionally learns and freezes the official DILA/Conseil count **during** the governed discovery pass via `source_inventory_snapshot_evidence_v2`, before closing the snapshot.

No failed/partial France snapshot was left behind by this first attempt; a read-only production check still showed QPC=0 and DC=0 snapshots at that point.

The existing migration was not edited. A new timestamp migration was added:

```text
20260916093000_constitutional_case_open_authoritative_count.sql
```

It changes only the authoritative-count check so that:

- `open`: expected count may still be unknown;
- `failed`: expected count may remain unknown for auditability;
- `closed` / `superseded`: authoritative counted/crosschecked snapshots must have a non-null expected count.

The fix is committed as:

```text
33c7e97 fix: allow authoritative discovery to learn counts
```

Pre-application `supabase db push --linked --dry-run` showed exactly this one migration. It was then applied to the linked `worldcons` production Supabase project. A final dry-run reports `Remote database is up to date.`

Regression verification before production application:

```text
pnpm typecheck                    PASS
pnpm lint                         PASS
pnpm check                        PASS
pnpm test:backfill                119 pass / 0 fail / 1 skip
pnpm test:catalog                 13 pass / 0 fail / 1 skip
pnpm test:postgres:release:static 7 pass / 0 fail / 0 skip
git diff --check                  PASS
```

The skipped cases are the existing disposable-PostgreSQL integration suites; the release workflow enforces skip=0 on its disposable pgvector database.

## QPC canary

```text
snapshot id       473522ae-2b03-4581-8ba7-7632a8e41048
document type     QPC
expected count    42
discovered count  42
snapshot status   closed
manifest hash     9e61bcc34d61d99a8f6216b287cfd13ab9290a687368f5e304e7ca58abea4523
```

Final item audit:

```text
items        42
fetched      42
normalized   42
verified     42
published     0
errors        0
active claims 0
```

Every phase had exactly one `source_backfill_runs` row with `status=succeeded`:

```text
discover   claimed 42 / succeeded 42 / retryable 0 / terminal 0
fetch      claimed 42 / succeeded 42 / retryable 0 / terminal 0
normalize  claimed 42 / succeeded 42 / retryable 0 / terminal 0
verify     claimed 42 / succeeded 42 / retryable 0 / terminal 0
reconcile  claimed  0 / succeeded  0 / retryable 0 / terminal 0
```

## DC canary

```text
snapshot id       bc1ebccd-8cbc-4821-babe-5fe850925875
document type     DC
expected count    12
discovered count  12
snapshot status   closed
manifest hash     b88b4a0d1d0a28a22a9e5304663db18cb3daf5918340167bd253bb477baadd5f
```

Final item audit:

```text
items        12
fetched      12
normalized   12
verified     12
published     0
errors        0
active claims 0
```

Every phase had exactly one `source_backfill_runs` row with `status=succeeded`:

```text
discover   claimed 12 / succeeded 12 / retryable 0 / terminal 0
fetch      claimed 12 / succeeded 12 / retryable 0 / terminal 0
normalize  claimed 12 / succeeded 12 / retryable 0 / terminal 0
verify     claimed 12 / succeeded 12 / retryable 0 / terminal 0
reconcile  claimed  0 / succeeded  0 / retryable 0 / terminal 0
```

## Publication and command audit

Production query:

```text
case_catalog_publications_v1 rows with source_policy_version=france-dila-constit-2026-09-v1: 0
```

Commands submitted by `chatgpt-m5b2-france-canary` were exactly:

```text
p1.case-backfill.discover   2 succeeded
p1.case-backfill.fetch      2 succeeded
p1.case-backfill.normalize  2 succeeded
p1.case-backfill.verify     2 succeeded
p1.case-backfill.reconcile  2 succeeded
```

There was no `p1.case-backfill.publish` command.

After the scoped execution processes exited:

```text
pnpm rollout:readiness --source=france --year=2024 --document-type=QPC --require-authorized
=> exit 2 / case_backfill.france_history_disabled
```

This proves that the history execution flag was not persistently enabled.

## Operational observation before M5-B3 bulk expansion

During the 42-item QPC fetch, Node emitted one warning:

```text
Possible AsyncEventEmitter memory leak detected. 51 migrating listeners added to AsyncEventEmitter.
```

It did **not** cause a failed request, retry, stale claim, worker failure, or data-integrity mismatch. The QPC canary still completed 42/42 and the 12-item DC run did not reproduce the warning.

Inspection showed that fixed detail-only crawls were creating Crawlee `RequestQueue` instances that retain global `migrating` listeners after queue disposal. M5-B2.1 resolved this by routing fixed `DETAIL` request sets through `RequestList` while preserving `RequestQueue` for dynamic `LIST` discovery. A 60-detail local regression completed 60/60 with zero retained `migrating` or `aborting` listener delta. See [worldcons-m5b21-france-crawlee-listener-hardening-20260916.md](./worldcons-m5b21-france-crawlee-listener-hardening-20260916.md).

## Stage decision

M5-B2 is complete:

- France 2024 QPC private-shadow: PASS
- France 2024 DC private-shadow: PASS
- 54/54 items verified
- retryable failures: 0
- terminal failures: 0
- active claims after completion: 0
- Catalog publications: 0
- publish commands: 0
- history flag after completion: OFF
- Gemini/AI work: 0

The bounded Crawlee listener/queue lifecycle hardening is now complete. The next execution stage is M5-B3 historical expansion, beginning with France 2023 QPC and then France 2023 DC.
