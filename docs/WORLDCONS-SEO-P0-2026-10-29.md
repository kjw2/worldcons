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
