# WorldCons SEO P0: Indexability Integrity

- Date: 2026-10-29
- Repository HEAD at implementation: `a99cd9f252f961292a0b275fe782a2a9a3568e82`
- Scope: bounded P0 source fix plus local regression evidence
- Not performed: browser automation, PR, push, deploy, live Cloudflare writes

## Verified observations

| Surface | Verified observation | Evidence source |
| --- | --- | --- |
| Homepage | Indexed by Google | Google Search Console |
| Detail URL samples | 4 of 4 sampled detail URLs returned `URL is unknown to Google` | Google Search Console URL Inspection |
| Live sitemap | HTTP 200, 3,492 total URLs, including 2,216 detail URLs | Controller read-only probe |
| Detail URL contract | HTTP 200, `robots: index, follow`, self-referencing canonical | Controller read-only probe |
| `robots.txt` | Crawlable and references the sitemap | Controller read-only probe |

The homepage is indexed while sampled detail URLs are absent from Google's index. That combination rules out a blanket site-wide block at the homepage level, but it does not by itself prove why individual detail URLs are unknown.

### Unknown-to-Google samples

The controller handoff confirmed four sampled detail URLs as `URL is unknown to Google`, but did not include the exact URL strings in the repository context. The strings are deliberately not fabricated here. Record the four GSC-inspected URLs before external circulation.

| Sample | Exact URL | GSC URL Inspection |
| --- | --- | --- |
| 1 | Not captured in repository context | `URL is unknown to Google` |
| 2 | Not captured in repository context | `URL is unknown to Google` |
| 3 | Not captured in repository context | `URL is unknown to Google` |
| 4 | Not captured in repository context | `URL is unknown to Google` |

No conclusion is drawn from the sample URL strings themselves. The confirmed facts are the HTTP/canonical/robots contract and the GSC status above.

## Confirmed source defect

`app/sitemap.ts` used a local `resilientSitemapRead` helper that retried each required source once. If both attempts failed, it logged `sitemap_source_unavailable` and **returned an empty array**. `Promise.all` then resolved normally and the sitemap route still returned HTTP 200 with one or more sections silently missing.

This is partial success:

- The sitemap could be served as healthy HTTP 200 while omitting all articles, all sources, all tags, or all glossary entries.
- Crawlers and operators cannot distinguish a complete sitemap from a truncated one by status code.
- A 200 response is not evidence that sitemap generation succeeded.

With 2,216 detail URLs expected in the live sitemap, a failed article or reference read can remove a large portion of the advertised URL set without surfacing an error.

## Remediation

- Extracted the retry boundary to `lib/seo/sitemap-source.ts`.
- Kept the existing bounded behavior: 2 attempts with a 150 ms delay, so the healthy path performs no additional D1 reads.
- Kept structured failure logging with only `event`, `source`, and `attempts`; no exception message or source contents are logged.
- A permanent source failure now throws `SitemapSourceUnavailableError` instead of returning `[]`.
- `app/sitemap.ts` does not catch the failure or install a fallback list, so the error propagates to Next's dynamic metadata route handler rather than producing an incomplete HTTP 200 sitemap.
- No D1 calls, caches, schema changes, or robots rules were added or changed.
- Sitemap URL shape is unchanged for healthy reads: homepage, list, tags, sources, glossary, guide, guide/chatgpt-plugin, active sources, published articles, indexable tags, and glossary terms.

## Regression coverage

`tests/seo-public-surface.test.ts` now verifies:

- A transient first-attempt failure is retried at 150 ms and returns the successful result without logging a failure.
- A permanent failure retries, logs exactly one structured entry naming only the source, and rejects with `SitemapSourceUnavailableError` instead of returning a partial list.
- The log object contains only `attempts`, `event`, and `source`.
- The thrown error message does not include the underlying exception detail.
- `app/sitemap.ts` imports the extracted helper, contains no local fallback `return []`, and contains no local `catch` that would swallow the error.
- Existing sitemap URL/canonical contracts remain in place: no `/search` entries, no `/v2` entries, thresholded tags only, and clean canonical paths.
- Existing article robots and canonical structured-data contracts remain in place.

Local verification:

```text
pnpm test:public-regression
tests 18
pass 18
fail 0
```

## Remaining indexing uncertainty

This change fixes silent sitemap truncation. It does not guarantee that Google will crawl or index detail URLs.

- The four sampled detail URLs were already reported as unknown to Google before this source fix.
- The live sitemap was HTTP 200 with 3,492 URLs, so sitemap availability alone does not explain the detail indexing gap.
- Googlebot request logs were not inspected in this task; Googlebot crawl behavior is unverified.
- The deployed runtime may differ from this repository HEAD until a separately authorized deployment occurs.
- Actual Google discovery, crawl scheduling, indexing decisions, and ranking are outside repository control.
- A sitemap failure will now be visible as a generation error, but a healthy sitemap still requires Google to recrawl and select the detail URLs.
- No claim is made that this P0 change resolves the observed unknown-to-Google status. It removes one confirmed integrity defect and preserves the existing canonical, robots, and sitemap contracts for follow-up verification.

## Follow-up: bounded sitemap read remedy (2026-10-29)

- Repository HEAD at this follow-up: `26f010420ac6fda3882405bab743d8e0a9b171ba`
- Deployed Cloudflare version at handoff: `7039e41f-d7aa-465c-a1bd-180f5919005a`
- Scope: corrected bounded set-based sitemap read plus guard-key deduplication
- Status: **corrected implementation verified locally, but deployment is blocked**. With real distinct article ids the unchanged guard overlay still scales at roughly one round trip per 80 articles per guard pass, so a sub-5-second cold path is not proven.
- Not performed: browser automation, PR, push, deploy, live Cloudflare writes, schema changes

### New live evidence

| Observation | Value |
| --- | --- |
| Googlebot `GET /sitemap.xml` | `2026-10-28T17:36:37.890Z`, Worker outcome `canceled`, `wallTime` 16,977 ms, no `response.status` |
| Googlebot `GET /robots.txt` seven minutes earlier | HTTP 200, 15 ms |
| Live sitemap after P0 deploy | 3,492 URLs including 2,216 detailed articles, TTFB 16.5 s |
| Older sitemap probe | 5.9 s |
| Search Console | Homepage indexed; four sampled article URLs `unknown to Google` |

The sitemap source fix from the previous section is deployed and the URL set is still served; this follow-up addresses the cold read cost that let the crawler cancel before a response status existed.

### Read-only path profile

`listPublicSitemapArticles` previously executed these bounded reads for `N` published heads:

1. `p3PublishedArticleIds`: one published-head read, then `ceil(N / 80)` catalog reads, plus version/anchor reads for catalog-corrected rows.
2. Article hydration: `ceil(N / 80)` independent `articles ... article_id IN (...)` reads.
3. `overlayPublicGenerationRows`: one E2E table probe plus `ceil(N / 80)` generation reads, then one metadata table probe, one policy read and `ceil(N / 80)` metadata reads.

The previous sitemap projection did not select `id`, so the overlay received `"undefined"` for every row and its generation/metadata guards were ineffective. That was a safety gap, not an optimization to preserve. The corrected path projects the real `id`, so generation content, withdrawal state and pending metadata now apply to the actual articles.

For 2,216 published heads with a small catalog-correction set the legacy path is roughly 116 serial D1 round trips before any catalog version reads. The measured local SQLite equivalent for 200 heads with real distinct ids was 16 reads: one head read, three catalog batches, three article batches, four generation guard reads and five metadata guard reads.

### Implemented remedy

- `listPublicSitemapArticles` now has an opt-in `fastSitemap` path used by the production runtime.
- It keeps the legacy bounded published-head read and `maxRows` overflow failure.
- It replaces the catalog batches plus article-id batches with one authored JOIN that reproduces the exact `p3PublishedArticleIds` catalog anti-join and the existing `status = 'summarized'` / `catalog_ai_stale_v4 = 0` article predicates.
- It projects the real `a.id` together with the existing sitemap fields, so `overlayPublicGenerationRows` verifies the actual article ids instead of the repeated string `"undefined"`. The immutable overlay, E2E CAS re-read, metadata policy and post-overlay textual `publishable` filter are all unchanged and now effective.
- Legacy `listPublicSitemapArticles` also projects `id` so the fallback and parity tests exercise the same identity-aware guard.
- `currentGenerations` and `readPublicMetadataState` deduplicate repeated article ids before their bounded 80-key reads, matching the existing `assertPublicSearchFreshness` behavior. Both results are keyed by article id, so duplicates can never change guard outcomes; the change only removes duplicate guard round trips.
- No schema, index, cache, R2, edge TTL, search-document substitution, or new Cloudflare resource was added.

Local read-count evidence for 200 published heads with E2E heads and active metadata policy, using real distinct article ids:

| Path | D1 round trips | Candidate writes |
| --- | --- | --- |
| Legacy batched composition | 16 | 0 |
| Fast sitemap composition | 11 | 0 |

The fast path's 11 reads are one published-head bound, one candidate JOIN, four generation guard reads and five metadata guard reads. At 2,216 heads the same shape is approximately `5 + 2 * ceil(N / 80)` = 61 reads when the first generation/metadata read finds nothing, or approximately `8 + 4 * ceil(N / 80)` = 120 reads when the overlay must perform its second CAS re-read. The earlier claim of 7 reads was invalid: it was measured only because every row carried the same `"undefined"` id, which collapsed the guard keys and skipped real identity checks. Actual production `rows_read` and cold TTFB were not measured, so no live speedup is claimed.

### Regression coverage

`tests/article-read-d1-fast-list.test.ts` now additionally proves:

- Fast and legacy sitemaps return the same sorted URL set for published, textual-true, numeric-true, private, needs-review, stale, withdrawn, in-review, catalog-blocked, catalog-enriched and wrong-hash rows.
- `lastModified` precedence is unchanged (`summarized_at` -> `fetched_at` -> `discovered_at`) and an overflowing `maxRows` still raises `D1ShadowTruncatedError`.
- Exactly one authored candidate JOIN and one published-head bound are issued by the fast path.
- The 200-head local fixture with real distinct ids measures 16 legacy reads versus 11 fast reads, not the earlier invalid 7.
- An active generation overrides mutable draft slug/timestamps, a withdrawn publication disappears from the sitemap, and a pending metadata repair fails closed with `e2e.public_metadata_pending` for both fast and legacy paths.
- Repeated generation/metadata guard keys still issue one bounded read per table.

Verification run after identity correction:

```text
pnpm test:public-regression       18 passed, 0 failed
article-read-d1-fast-list         16 passed, 0 failed
article fast/list/reads/shadow    71 passed, 0 failed
e2e M3/M5 + search projection     50 passed, 0 failed
pnpm typecheck                    passed
eslint (changed TS files)         passed with no findings
```

### Blocked decision and next evidence

The identity-corrected fast path removes the article/catalog batch loops, but it cannot avoid the guard overlay's `ceil(N / 80)` reads per pass. At the live 2,216-article size that is roughly 61 reads when no managed rows are found and roughly 120 when the second CAS re-read runs. This is bounded by `maxRows`, but it is not evidence of a sub-5-second cold path, so **commit/deploy remains blocked**.

The next candidate optimization is a set-based guard snapshot over the small E2E/metadata relations (read the bounded generation heads and metadata repairs once per pass, then match ids in memory) replacing the per-80-id guard loops. It must preserve the existing `currentGenerations` projection hash, the metadata revision/fencing checks, the second CAS re-read, and the `maxRows` fail-closed bound. It has not been implemented or measured here.

### Remaining uncertainty

- The 16,977 ms crawler cancellation is consistent with the profiled read amplification, but this task did not reproduce live cold timing or inspect Cloudflare query metrics.
- The guard overlay still scales with article count (`ceil(N / 80)` per pass); only duplicate-key amplification was removed.
- The deployed Worker will not contain this change unless the controller independently verifies it and accepts the remaining latency risk.
- The candidate `fastSitemap` path is disabled by default: the runtime requires an explicit `WORLDCONS_FAST_SITEMAP_ENABLED=true` opt-in. Current production Wrangler config does not set this flag; no unverified optimization is active in the released Worker.
- No claim is made that Google will now crawl or index the detail URLs; sitemap availability and latency are only two of several crawl and indexing inputs.

## Follow-up: JSON1 guard batching (2026-10-30)

- Repository HEAD at implementation: `001f7b2b1de5d24e2f710340bdf8321dbbc1574d` plus the uncommitted change described here
- Scope: read-only batching inside `currentGenerations` and `readPublicMetadataState`; no schema, cache, Cloudflare, R2, deployment or live write
- Status: local read amplification and exact parity verified; live cold latency and live `rows_read` remain unmeasured
- `WORLDCONS_FAST_SITEMAP_ENABLED` remains OFF by default
- Shared JSON1 generation/metadata guard batching also remains OFF by default (`WORLDCONS_JSON_GUARD_BATCHING_ENABLED` is unset); it requires separate approval before affecting public reads.

### Why this is safe

Cloudflare D1 caps bound parameters per statement, so the guard readers used one `IN (...)` query per 80 article ids. The new path binds the exact same id set as one JSON array and expands it with `json_each(?)`:

```sql
... WHERE h.article_id IN (SELECT value FROM json_each(?)) LIMIT ?
... WHERE article_id IN (SELECT value FROM json_each(?)) LIMIT ?
```

- Only the id carrier changed. The generation SELECT, `CURRENT_GENERATION_SQL`, `generationProjectionHash`, review-state blacklist, metadata `status='verified'` / `revision=applied_revision` check, the second `currentGenerations` read, the second metadata CAS read, the immutable version overlay, publication eligibility and post-overlay textual `publishable` filtering are unchanged.
- Inputs are deduplicated and capped at 10,000 ids. Each JSON batch is capped at 500 ids and 64 KiB, and each query is bounded by `LIMIT batch_size`.
- The primary-key lookup is preserved: local SQLite 3.51.3 `EXPLAIN QUERY PLAN` on the real Core/E2E schema reports `SEARCH h USING INDEX sqlite_autoindex_e2e_generation_heads_v1_1 (article_id=?)` and `SEARCH search_metadata_repairs_v1 USING INDEX sqlite_autoindex_search_metadata_repairs_v1_1 (article_id=?)` for the `IN (SELECT value FROM json_each(?))` shape.
- Local JSON1 support was verified with `node:sqlite`. D1 JSON1 is already used by the same guard SQL (`json_group_array`, `json_object`, `json_extract`, `json_type`), so `json_each` is the same built-in extension. This is inference from deployed JSON1 use, not a live D1 probe.
- Any JSON1 statement error, including a SQLite build without JSON1, discards the partial JSON result and re-reads every id with the original 80-id `IN (...)` composition. If that fallback also fails, the error propagates. There is no partial guard map and no stale cache.

### Local read-count evidence

`tests/article-read-d1-fast-list.test.ts` builds real SQLite fixtures with the Core schema, E2E generation tables and metadata repair tables.

| Fixture | JSON1 path | Exact 80-id fallback |
| --- | --- | --- |
| 200 published articles, one guard pass | legacy sitemap composition 12 total statements; fast sitemap 7 total statements; both use 2 guard-table reads plus 3 probes | Not measured separately; the guard shape is one generation read and one metadata read because 200 ids fit one JSON batch. |
| 2,216-head fast sitemap, two-pass overlay | 30 total statements; 10 generation + 10 metadata guard reads | 126 total statements when JSON1 is forced unavailable (112 legacy guard reads, four failed JSON1 attempts and the same ten fixed reads). |

The 2,216-head shape is now two passes x `ceil(2216 / 500) = 5` reads per guard type, instead of two passes x `ceil(2216 / 80) = 28`. The earlier estimate of roughly 61 one-pass / 120 two-pass guard statements therefore becomes roughly 15 one-pass / 30 two-pass **local statements**. This is a statement-count and round-trip bound, not a latency measurement.

The fixture proves exact sorted sitemap parity between the JSON1 path and the forced 80-id fallback. It also proves generation/metadata map parity, a mid-stream JSON batch failure that discards the partial result, metadata pending failure in a later batch, duplicate-id deduplication, projection-changed / `needs_review` / withdrawn exclusion, post-read metadata CAS mismatch and a generation change between the two overlay reads.

### Sub-5-second claim remains unproven

The previous sub-5-second cold-path claim is **not** restored by this change. The local evidence only shows that the guard loop no longer issues one D1 round trip per 80 distinct article ids. It does not measure:

- live D1 round-trip latency, `rows_read`, rows returned or cold TTFB;
- the deployed Worker, which still has `WORLDCONS_FAST_SITEMAP_ENABLED` unset;
- Googlebot behavior or indexing.

Independent staging verification and a live cold probe are still required before any sub-5-second or live speedup claim. The opt-in flag must remain OFF until then.

### Verification run

| Command | Result |
| --- | --- |
| `pnpm exec tsx --test tests/article-read-d1-fast-list.test.ts` | 24 passed, 0 failed |
| `pnpm test:e2e-p0-m1` | 18 passed, 0 failed |
| `pnpm test:e2e-p0-m2` | 20 passed, 0 failed |
| `pnpm test:e2e-p0-m3` | 25 passed, 0 failed |
| `pnpm test:e2e-p0-m4` | 27 passed, 2 failed (pre-existing at HEAD; reproduced with this change stashed) |
| `pnpm test:e2e-p0-m5` | 47 passed, 1 failed (pre-existing at HEAD; reproduced with this change stashed) |
| `pnpm test:public-regression` | 18 passed, 0 failed |
| `pnpm test:article-reads` | 22 passed, 0 failed |
| `pnpm test:search-repository` | 19 passed, 0 failed |
| `pnpm typecheck` | passed |
| `pnpm lint` | 0 errors, 20 pre-existing warnings in unrelated files |
| `git diff --check` | clean |

## P0 isolated four-mode sitemap A/B acceptance (2026-10-30)

### Production D1 bounded read-only cost probe

- The actual `worldcons_core` D1 returned **2,237 published article heads**. The head-ID query incurred `rows_read=4,475`.
- With the existing 500-ID JSON1 `JOIN` carrier, five generation queries returned 56 generation records at `rows_read=2,405`; five metadata queries returned 784 records at `rows_read=3,021`.
- These **10 guard queries / 5,426 rows read** are *not* a complete sitemap request. They omit other head/candidate/catalog/approval/CAS read paths, and do not measure Worker latency or full per-request D1 charges.
- Read-only D1 lookups only; no production schema/data mutation and no flag activation.

### Reproducible isolated SQLite four-mode comparison

The newly added same-snapshot regression uses 2,237 ordinary published rows, plus a withdrawn record, a catalog mismatch, a verified metadata-repair record and an active protected generation. A separate negative test puts a repair into `pending` state. It executes the same repository and overlay path under all four combinations:

| Sitemap candidates | JSON1 guards | SQL statements | Exact published slug/lastModified entries |
| --- | --- | ---: | ---: |
| Legacy | Legacy 80-id batches | 179 | 2,239 |
| Fast | Legacy 80-id batches | 122 | 2,239 |
| Legacy | JSON1 `JOIN` (500-id batches) | 87 | 2,239 |
| Fast | JSON1 `JOIN` (500-id batches) | 30 | 2,239 |

All four modes returned exactly the same *sorted slug and last-modified value pairs*, not merely the same count. Withdrawn and catalog-mismatched items were excluded; verified metadata and the current protected generation were included. All four modes fail closed for a pending metadata repair. Other tests cover a changed generation and a metadata CAS mismatch during the two-pass overlay.

The isolated fixture indicates a **149-statement (about 83%)** reduction from legacy+legacy to fast+JSON1. This is a local SQLite SQL-statement count, **not** production `rows_read`, Googlebot response time, or Cloudflare cost reduction. It is not a snapshot of production data; current live sitemap URL parity remains unverified. No `wrangler dev --remote` preview was used, to avoid exposing the production D1 binding in a test Worker.

Checks after the isolated test change: `pnpm exec tsx --test tests/article-read-d1-fast-list.test.ts` **28/28 passed**, `pnpm test:public-regression` **18/18 passed**, and test-file ESLint / `git diff --check` passed. The business-logic and Wrangler configuration remain unchanged.

### Rollout gate still open

Both `WORLDCONS_FAST_SITEMAP_ENABLED` and `WORLDCONS_JSON_GUARD_BATCHING_ENABLED` stay **unset/OFF**. The deployed production Worker remains `7039e41f-d7aa-465c-a1bd-180f5919005a`. To activate the new path, the full returned sitemap URL set and `lastmod` values plus actual Worker TTFB/D1 `rows_read` must first be compared under a safely isolated acceptance environment. No claim is made that the prior Googlebot cancellation has been fixed.

The M4 failures were a local `wrangler deploy --dry-run` `spawn EPERM` and the staged discovery Queue identity assertion. The M5 failure was the discovery item count assertion. Both failing tests reproduce on the unmodified HEAD with this change stashed, so they are not caused by the guard batching change.

## Follow-up: bounded production sitemap parity probe (2026-10-30)

- Repository HEAD at implementation: `65c71123d53ca88bed6c9c77dfaf464c5a95af77`
- Endpoint: fixed HTTPS `GET https://worldcons.cclib.workers.dev/sitemap.xml`
- Existing deployed Worker remains `7039e41f-d7aa-465c-a1bd-180f5919005a` at 100% of traffic. This task did not deploy or change Cloudflare.
- Added `scripts/seo-sitemap-probe.ts`, `pnpm seo:sitemap:probe` and offline `node:test` coverage. The probe is read-only: exactly two sequential GETs, a 1 s gap, 30 s abort limit per request, 2 MiB response cap, no redirects, no cache-busting, no extra query parameters and no User-Agent impersonation. It prints only counts, timings, safety flags and a sorted normalized URL-set SHA-256, never the URL list or response body.
- Changes are limited to the standalone probe, its test/package entry and this doc; no application runtime, schema, index, cache, Worker version or opt-in flag was changed.

### Controller baseline (2026-10-30)

| Run | HTTP | TTFB | Total | Bytes |
| --- | --- | --- | --- | --- |
| 1 | 200 | 2.657638 s | 2.800148 s | 751451 |
| 2 | 200 | 2.368496 s | 2.514336 s | 751451 |

### Bounded probe snapshot after implementation

The probe's two runs matched exactly. These are single read-only observations, not a cache-miss, cold-start or P95 measurement.

| Run | HTTP | TTFB | Total | Bytes | URLs | Article URLs | Unique | Duplicates | `lastmod` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 200 | 6.792109 s | 6.816803 s | 751451 | 3528 | 2236 | 3528 | 0 | 3454 |
| 2 | 200 | 6.360173 s | 6.367335 s | 751451 | 3528 | 2236 | 3528 | 0 | 3454 |

Shared normalized URL-set SHA-256: `174131cd3f3f9f980895f616d062749c090b46c11b4c8531e2e3d1c6305aea8d`. Both runs reported XML valid, canonical/same-origin safe, zero cross-origin, non-HTTPS, credential, fragment or query URLs, `application/xml`, no redirects and `bothRunsMatch: true`.

The probe timings differ from the controller baseline above. They are separate observations and do not establish cache state or a regression.

### Read-only production D1 query results

| Query | Result | `rows_read` |
| --- | --- | --- |
| Published heads | 2237 rows | 2238 |
| Exact candidate SQL | 2236 rows | 7642 |
| Visible sitemap article URLs | 2216 earlier | not measured by this probe |

- The exact candidate SQL count is not equivalent to the visible sitemap article count without the post-join eligibility overlay (generation/withdrawal state, metadata policy and post-overlay `publishable` filtering).
- The 2,216 visible-article figure is from an **earlier snapshot**. The subsequent two-run production probe in this section reports **2,236 article URLs**, so subtracting 2,216 from the 2,236 SQL candidates does **not** establish that 20 documents were withheld. These are not transactionally consistent snapshots and public source data can change between reads.
- `EXPLAIN QUERY PLAN` reports index usage plus a `TEMP B-TREE` for ordering. These were read-only queries; no SQL write was executed.

### Preserved rollout state

- `WORLDCONS_FAST_SITEMAP_ENABLED` remains OFF/unset.
- `WORLDCONS_JSON_GUARD_BATCHING_ENABLED` remains OFF/unset.
- The existing Worker version above remains unchanged. No browser, push, deploy, PR, Google write or Cloudflare write was performed.

## Follow-up: JSON1 JOIN source correction (2026-10-30)

- Repository HEAD at implementation: `882600aa47dd86fb17dbe7550319fe2948ab3ce1` plus this uncommitted change.
- Scope: read-only guard source correction in `lib/cloudflare/e2e/generation-state.ts` (`currentGenerations`) and `lib/cloudflare/search-projection/metadata-repair.ts` (`readPublicMetadataState`). No schema, index, Worker, cache, Cloudflare, deployment or live write change.
- `WORLDCONS_FAST_SITEMAP_ENABLED` and `WORLDCONS_JSON_GUARD_BATCHING_ENABLED` remain OFF/unset by default.

### Change

The JSON1 guard reads now expand the bounded id array first and join the target relation by primary key instead of filtering with `article_id IN (SELECT value FROM json_each(?))`:

```sql
SELECT g.*, a.review_state, ...
FROM json_each(?) AS ids
JOIN e2e_generation_heads_v1 h ON h.article_id=ids.value
JOIN e2e_generations_v1 g ON g.generation_id=h.generation_id
LEFT JOIN articles a ON a.id=g.article_id
LIMIT ?

SELECT m.*
FROM json_each(?) AS ids
JOIN search_metadata_repairs_v1 m ON m.article_id=ids.value
LIMIT ?
```

- The generation projection fields, the `CASE WHEN CURRENT_GENERATION_SQL` expression, `identity_current`, `tag_snapshot`, `generationProjectionHash`, review-state blacklist and publication-state checks are unchanged.
- The legacy reads are unchanged: generation keeps `FROM e2e_generation_heads_v1 h JOIN ... WHERE h.article_id IN (?,?,...)` and metadata keeps `SELECT * FROM search_metadata_repairs_v1 WHERE article_id IN (?,?,...)`.
- Inputs are still deduplicated, capped at 10,000 ids, 500 ids / 64 KiB per JSON batch, and each JSON read keeps `LIMIT ?`. Any JSON failure still discards the partial result and re-reads every id with the legacy 80-id composition; a fallback failure propagates. Approval and the second-pass CAS re-reads are unchanged.

### Production D1 read-only source-bound probe (2026-10-30)

Sample: 240 `article_id` values from the union of current generation heads and metadata repair rows. Only the bounded lookup statements below were run; this is not the complete sitemap read set.

| Guard lookup | Legacy 80-id `IN` | JSON1 `IN (SELECT value FROM json_each(?))` | JSON1 `FROM json_each(...) JOIN` |
| --- | --- | --- | --- |
| Generation head/generation | 303 (`3 x 80`) | 543 | 303 |
| Metadata repair | 480 (`3 x 80`) | 720 | 479 |

- All three shapes returned the same sorted result set on the sample.
- `EXPLAIN QUERY PLAN` for the JSON1 JOIN shape reports `SCAN json_each`, then indexed `SEARCH h` / `SEARCH m` on the primary-key autoindex. On the sample it returned 21 generation rows and 240 metadata rows. The legacy 80-id shape also performs primary-key lookups.
- Core D1 JSON1 and the query plan were verified directly against production D1 with read-only lookups.

### Limitation

These numbers are bounded guard-lookup probes, not the `rows_read` of a complete sitemap request. The full sitemap path also runs the published-head bound, the candidate JOIN, eligibility/overlay reads and post-overlay filtering; those reads were not measured here. No live Worker TTFB, cold-start timing, or public URL parity was measured for either fast flag, so no sub-5-second or live speedup is claimed. Both opt-in flags remain OFF until independent verification.

### Verification run

| Command | Result |
| --- | --- |
| `pnpm exec tsx --test tests/article-read-d1-fast-list.test.ts` | 26 passed, 0 failed |
| `pnpm test:public-regression` | 18 passed, 0 failed |
| `pnpm test:article-reads` | 22 passed, 0 failed |
| `pnpm typecheck` | passed |
| `pnpm exec eslint <changed TS files>` | passed with no findings |
| `git diff --check` | clean |

## Follow-up: isolated Workers-runtime sitemap acceptance harness (2026-10-30)

- Repository HEAD at implementation: `2155ba7f2427702552d9f8c5b21c2b1c0ab0dd13`
- Scope: standalone local Miniflare/workerd acceptance harness plus narrow `node:test` isolation coverage. No production runtime, Wrangler config, schema, index, Worker version, flag or Cloudflare resource was changed.
- Not performed: browser automation, PR, Git push, deploy, `wrangler dev --remote`, production D1 binding, Cloudflare API write, production secret read.

### What the harness proves

`scripts/workers-sitemap-runtime-harness.ts` bundles `scripts/fixtures/worldcons-sitemap-runtime-worker.ts` with esbuild (TypeScript `@/*` alias included) and starts an actual Miniflare/workerd instance with exactly one **new ephemeral local D1** binding:

- Binding: `WORLDCONS_CORE`
- Local database ID: `worldcons-local-sitemap-harness`
- No production database ID, remote binding, credential, `wrangler dev --remote` or `CLOUDFLARE_API` path exists in the harness or worker source.
- Outbound network is fail-closed through a Miniflare `outboundService` that throws `harness_network_disabled`.
- The temporary bundle/working directory is removed in `finally`; the report records `tempDirRemoved: true`.

The test-only Worker imports the real `createD1ArticleReadRepository` from `lib/article-reads/d1-repository.ts` and calls its real `listPublicSitemapArticles()`. It is a **repository-level Worker smoke**, not the full `app/sitemap.ts` Next.js route. It serializes the exact repository `slug` and `lastModified` pairs into sitemap XML with a fixed test base URL. It does not use production URLs or production article URLs.

The local dataset uses the real Core migrations `0001_init.sql`, `0004_e2e_generations.sql` and the real metadata migration `0011_search_metadata_repair.sql`:

- 2,237 ordinary published rows with real `articles`, published `article_publications_p3` and `article_content_versions_p3` rows.
- 1 withdrawn publication, withheld.
- 1 published Catalog correction whose version is not an eligible `enrichment_full` snapshot, withheld.
- 1 verified metadata-repair row, visible.
- 1 current protected E2E generation row, visible.
- 1 additional pending metadata-repair fixture inserted only for the negative pass.
- Visible total in the healthy matrix: **2,239** exact `slug` + `lastModified` entries.

`lastModified` varies across rows and exercises the `summarized_at -> fetched_at -> discovered_at` precedence, including null fallbacks.

### Measured full-scale local results

One command:

```text
pnpm seo:sitemap:workers
```

| Sitemap candidates | JSON1 guards | Local D1 statements | `rows_read` | Local Worker elapsed | Entries | Exact normalized SHA-256 |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| Legacy | Legacy 80-id batches | 179 | 20,771 | 414 ms | 2,239 | `c93d3a61c8cb1cb58967046a76fcf78425dddb3e77c56bcd08b07bdfb4927592` |
| Fast | Legacy 80-id batches | 122 | 22,985 | 269 ms | 2,239 | same |
| Legacy | JSON1 `JOIN` (500-id batches) | 87 | 20,771 | 221 ms | 2,239 | same |
| Fast | JSON1 `JOIN` (500-id batches) | 30 | 22,985 | 102 ms | 2,239 | same |

- All four modes returned **byte-identical XML** (`xmlSha256 = c47028e0ad5a12960611083a48b7e060fa0cb6cabf3370de27e4be0f6098a29b`) and the same normalized URL-set SHA-256. `allNormalizedSetsEqual: true`, `allXmlBytesEqual: true`.
- The normalized SHA-256 is over the sorted lines `<absolute test loc>\t<lastmod or empty>`, after XML entity decoding. It is a parity witness for the local fixture, not a production sitemap hash.
- The withdrawn and catalog-mismatch fixtures were absent in all four modes. The verified-metadata and current-generation fixtures were present in all four modes.
- The pending metadata negative pass returned HTTP 500 `e2e.public_metadata_pending` in all four modes. Fail-closed behavior is preserved.
- `binding.meta.rows_read` is available in this local Miniflare D1; `rowsReadAvailable: true`. The harness reports the actual observed values above.
- Statement counts reproduce the earlier isolated SQLite result exactly: **179 / 122 / 87 / 30**.
- `rows_read` does **not** monotonically improve: the fast candidate JOIN reads more rows locally (22,985) than the legacy batched composition (20,771) even though it issues far fewer statements. This is a candid local observation, not a production cost claim.
- The full run, including 20 seed requests, 4 matrix requests and 4 negative requests, completed in **18.7 s**. The healthy matrix itself is exactly **4 Worker fetch calls**; the negative pass is another 4. Both are inside the 2-minute bound.

### Isolation and safety coverage

`tests/workers-sitemap-runtime-harness.test.ts` verifies:

- The harness source configures only the local ephemeral D1 binding and local database ID.
- The source contains no `wrangler dev`, `--remote`, `CLOUDFLARE_API`, `CLOUDFLARE_ACCOUNT` or any production D1 UUID.
- The `outboundService` fail-closed guard and temporary-directory cleanup are present.
- A reduced-data end-to-end run starts actual workerd, uses the real repository path, exercises all four switch combinations, proves byte and normalized-set parity, proves withholding and pending-metadata fail-closed behavior, reports local `rows_read`, and confirms temporary-directory removal.

Verification run:

```text
pnpm test:workers-sitemap       2 passed, 0 failed
pnpm seo:sitemap:workers        2239 visible, 4/4 parity, 4/4 pending fail-closed
pnpm typecheck                  passed
eslint (changed TS files)       passed with no findings
git diff --check                clean
```

### Limitations

- These are **local Miniflare/workerd timings**, not production Cloudflare TTFB, cold-start, queueing, edge-cache or Googlebot behavior measurements.
- The local `rows_read` values are from Miniflare D1 and are not production D1 billing or execution statistics.
- This is a repository-level Worker smoke, **not** the full `app/sitemap.ts` route: source/tag/glossary sections, Next.js metadata serialization and the deployed runtime are not exercised.
- The dataset is a deterministic local fixture, not a production snapshot. Production URL parity, `lastModified` parity and the live 2,236-article public set remain unverified.
- Both feature flags remain unset/OFF in production. The deployed Worker remains `7039e41f-d7aa-465c-a1bd-180f5919005a`.

### Exact next gate

1. Controller reviews and checkpoints this local-only harness; no commit, push or deploy is performed here.
2. Treat **JSON1 guard ON + fast sitemap OFF** as the first candidate: local Workerd/D1 cut SQL statements from 179 to 87 without increasing `rows_read`. The fast-sitemap candidate increased local `rows_read` by 2,214; keep it OFF pending a separate SQL read-cost improvement.
3. A separately authorized staging/candidate deployment may use an isolated non-production D1 binding and both flag variants. Compare the candidate **against a baseline using the same staging data snapshot**; never compare its synthetic URL digest to the live production digest because the datasets differ.
4. If production-snapshot parity is required, establish a separately authorized, protected and consistent snapshot before testing. Run the exact same snapshot through the original and candidate code, compare complete sitemap URL/`lastmod` sets, and measure Worker TTFB plus full-request D1 `rows_read` for both paths. The current local harness does not establish that production parity.
5. Only after exact same-snapshot public URL parity plus acceptable full-request latency and rows-read evidence should production flag activation be considered. Google indexing remains a separate, unproven outcome.

## Follow-up: lazy version join in the sitemap candidate SQL (2026-10-30)

- Repository HEAD at implementation: `242bb559731d9af64195fe8c421a37c0fbbe5bdd` plus this uncommitted change.
- Scope: `lib/article-reads/d1-repository.ts` `SITEMAP_FROM` / `SITEMAP_WHERE` only. No schema, index, Worker version, cache, Cloudflare write, deployment, promotion, secret access or production write was performed.
- `WORLDCONS_FAST_SITEMAP_ENABLED` and `WORLDCONS_JSON_GUARD_BATCHING_ENABLED` remain OFF/unset by default.

### Change

`SITEMAP_FROM` no longer joins `article_content_versions_p3` unconditionally. It keeps the published P3 head, the joined `articles` row and the published `case_catalog_publications_v1` correction:

```sql
from article_publications_p3 p
join articles a on a.id = p.article_id
left join case_catalog_publications_v1 c on c.article_id = p.article_id and c.state = 'published'
```

The catalog policy is now a correlated `EXISTS` that only runs for corrected rows:

```sql
c.article_id is null
or exists (
  select 1
  from article_content_versions_p3 v
  join article_content_versions_p3 anchor on anchor.id = c.source_anchor_version_id
  where v.id = p.version_id
    and v.article_id = p.article_id
    and v.version_role = 'enrichment_full'
    and v.source_anchor_version_id = c.source_anchor_version_id
    and anchor.version_role = 'authoritative_source'
    and anchor.source_content_hash is not null and anchor.source_content_hash != ''
    and v.enrichment_source_content_hash = anchor.source_content_hash
)
```

- Rows with no published catalog correction skip both version joins entirely.
- Corrected rows keep the exact public policy: missing/foreign/invalid versions stay excluded, while a matching anchored `enrichment_full` snapshot remains admitted.
- `SITEMAP_COLUMNS`, ordering (`original_published_at desc nulls last`, `id asc`), generation/metadata overlay, CAS re-read, `maxRows` bound and both opt-in flags are unchanged.
- `FAST_FROM` and `FAST_WHERE` (the regular public list SQL) were not touched.

### Production read-only SQL A/B (candidate query only)

The exact candidate statements were run read-only against production D1. This is **not** a full sitemap request, not a Worker TTFB measurement and not a data snapshot.

| Candidate SQL | Rows | Ordered full-row checksum | `rows_read` | D1 query time |
| --- | ---: | ---: | ---: | ---: |
| Previous `SITEMAP_FROM` / `SITEMAP_WHERE` | 2246 | 860979221 | 9928 | 266.8 ms |
| New lazy `EXISTS` version join | 2246 | 860979221 | 7682 | 209.8 ms |

- Both statements returned the same 2,246 candidates and the same ordered full-row checksum `860979221`.
- `rows_read` fell from 9,928 to 7,682, a reduction of 2,246 rows (**-22.6%**).
- D1 query time fell from 266.8 ms to 209.8 ms.
- These numbers describe only the candidate SQL. They do not measure the published-head read, the guard overlay, the full returned sitemap, production TTFB, cold starts or Googlebot behavior. No write was executed.

### Local Workerd four-mode result

`pnpm seo:sitemap:workers` reproduced the four-mode matrix with **2,239** visible entries, byte-identical XML (`xmlSha256 = c47028e0ad5a12960611083a48b7e060fa0cb6cabf3370de27e4be0f6098a29b`) and identical normalized URL-set SHA-256 (`c93d3a61c8cb1cb58967046a76fcf78425dddb3e77c56bcd08b07bdfb4927592`) in all modes.

| Sitemap candidates | JSON1 guards | Statements | Local `rows_read` | Local Worker elapsed |
| --- | --- | ---: | ---: | ---: |
| Legacy | Legacy 80-id batches | 179 | 20,771 | 622 ms |
| Fast | Legacy 80-id batches | 122 | 20,745 | 279 ms |
| Legacy | JSON1 `JOIN` (500-id batches) | 87 | 20,771 | 237 ms |
| Fast | JSON1 `JOIN` (500-id batches) | 30 | 20,745 | 106 ms |

- The previous fast-sitemap regression (`rows_read` 22,985 versus 20,771 for the same JSON1 guards) is resolved: fast+JSON1 now reads **20,745**, 26 rows below the **20,771** legacy+JSON1 baseline.
- Withdrawn and catalog-mismatch fixtures remained absent; verified metadata and the current protected generation remained present.
- The pending metadata negative pass still returned HTTP 500 `e2e.public_metadata_pending` in all four modes.
- These are local Miniflare/workerd values, not production `rows_read`, billing, cold-start or TTFB.

### Tests

`tests/article-read-d1-fast-list.test.ts` adds explicit coverage that the fast sitemap admits a valid anchored enrichment, excludes a catalog mismatch and a wrong anchor role, matches the legacy URL set, uses a correlated `EXISTS`, and does not emit an unconditional `left join article_content_versions_p3`.

| Command | Result |
| --- | --- |
| `pnpm seo:sitemap:workers` | 2,239 entries, 4/4 XML and normalized parity, 4/4 pending fail-closed |
| `pnpm test:workers-sitemap` | 2 passed, 0 failed |
| `pnpm exec tsx --test tests/article-read-d1-fast-list.test.ts` | 29 passed, 0 failed |
| `pnpm test:public-regression` | 18 passed, 0 failed |
| `pnpm typecheck` | passed |
| `pnpm exec eslint lib/article-reads/d1-repository.ts tests/article-read-d1-fast-list.test.ts` | passed with no findings |
| `git diff --check` | clean |

### Limits

- Both flags remain OFF, so this change is inactive in the deployed Worker until separately reviewed and authorized.
- Production read-only evidence is limited to the candidate SQL A/B. Full sitemap URL/lastmod parity, production TTFB, `rows_read` per full request, cache behavior and Google indexing remain unverified.
- No browser, PR, push, deploy, Cloudflare write or production data write was performed.
