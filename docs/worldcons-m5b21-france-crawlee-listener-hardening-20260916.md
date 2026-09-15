# WorldCons M5-B2.1 — France Crawlee listener / request-source hardening

Date: 2026-09-16

## Result

Status: **COMPLETE**.

The 2024 France QPC private-shadow canary completed successfully, but its 42-item fetch pass emitted one Crawlee warning after many short-lived detail crawlers:

```text
Possible AsyncEventEmitter memory leak detected. 51 migrating listeners added to AsyncEventEmitter.
```

No fetch, normalization, verification, reconciliation, Catalog, or AI failure accompanied the warning. M5-B2.1 therefore treated it as an operational hardening blocker before the 2010-2023 France expansion rather than ignoring it.

## Root cause

`runOfficialSpider()` used `RequestQueue.open()` even when a crawl consisted only of a fixed set of `DETAIL` URLs. France historical fetch processes authoritative detail URLs and does not need to discover or enqueue new URLs during that detail-only pass.

The installed Crawlee implementation registers global event-manager listeners when a `RequestQueue` is opened. A local probe showed the lifecycle behavior directly:

```text
5 RequestQueue.open() calls:
  migrating listeners before       = 0
  migrating listeners after open   = 10
  migrating listeners after drop() = 10
```

`drop()` removes queue storage but does not remove those global listeners. Repeated one-case detail crawls therefore accumulated listeners even though every crawler finished successfully.

This is distinct from Crawlee's crawler-run migration/abort listeners: `BasicCrawler.run()` removes its own temporary listeners in its `finally` path. The retained listeners came from the repeatedly created `RequestQueue` objects.

## Fix

`lib/crawlee/shared.ts` now selects the request source according to crawl shape:

- fixed `DETAIL`-only request sets -> `RequestList`;
- any pass containing `LIST` requests -> existing `RequestQueue` path;
- LIST handling has an explicit fail-closed `crawler.request_queue_required_for_list` invariant.

The change preserves dynamic link discovery where it is required, while fixed detail fetches no longer create persistent queue listeners.

No source-policy, database, migration, Catalog, public, Gemini, or AI setting changed in this stage.

## Regression proof

`tests/constitutional-case-backfill-france-gate5.test.ts` includes a real local HTTP crawl with 60 distinct detail URLs in one detail-only pass.

Observed result:

```text
requestsFinished = 60
requestsFailed   = 0
items returned   = 60
migrating listener count after = count before
aborting listener count after  = count before
```

The old RequestQueue implementation would fail the listener-count assertion because even one queue open leaves global listeners behind. The new RequestList path leaves no retained listener delta.

The test intentionally covers more than 50 detail fetches so the original warning threshold is represented without making CI create 60 separate crawler instances.

## Full verification

After the final guard adjustment:

```text
pnpm typecheck                    PASS
pnpm check                        PASS
pnpm lint                         PASS
pnpm test:backfill                120 pass / 0 fail / 1 skip
pnpm test:p1                      22 pass / 0 fail / 1 skip
pnpm test:ingest-workflow         18 pass / 0 fail / 0 skip
pnpm test:catalog                 13 pass / 0 fail / 1 skip
pnpm test:postgres:release:static 7 pass / 0 fail / 0 skip
git diff --check                  PASS
```

The skipped PostgreSQL integration cases remain governed by the existing disposable-pgvector release gate, which requires skip=0 in its release environment.

## Production impact

This stage did **not** execute another production historical backfill and did **not** write any new production snapshot, run, item, Catalog publication, or migration.

The verified M5-B2 France 2024 private-shadow evidence remains unchanged:

- QPC snapshot `473522ae-2b03-4581-8ba7-7632a8e41048`: 42/42 fetched, normalized, verified; 0 published; 0 errors.
- DC snapshot `bc1ebccd-8cbc-4821-babe-5fe850925875`: 12/12 fetched, normalized, verified; 0 published; 0 errors.
- default France history execution remains fail-closed unless `CASE_CATALOG_FRANCE_HISTORY_ENABLED=true` is supplied to an authorized execution process.

## Next stage

M5-B3 can now begin the approved France 2010-2023 historical QPC/DC expansion.

The rollout should remain annual and facet-separated, newest to oldest. The next production tranche is therefore **France 2023 QPC**, followed by **France 2023 DC**, with each snapshot required to complete discover -> fetch -> normalize -> verify -> reconcile and reach zero retryable/terminal failures before the next tranche begins.

Catalog publication remains a separate later gate.
