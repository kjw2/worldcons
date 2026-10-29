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
