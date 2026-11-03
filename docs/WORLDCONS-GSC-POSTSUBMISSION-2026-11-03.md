# WorldCons GSC — post-submission baseline (2026-11-03 KST)

## Disposition

**Sitemap resubmission succeeded; Google's next sitemap download and public article indexing remain pending.** This is an external Google discovery follow-up, not a regression or reopening of the completed WorldCons SEO P0 engineering.

No browser, D1 mutation, additional Google sitemap submission, source deploy, GitHub push or indexing request was performed for this baseline.

## Search Console evidence (GSC MCP, connected site owner)

- Property: `https://worldcons.cclib.workers.dev/` — permission `siteOwner`.
- Sitemap: `https://worldcons.cclib.workers.dev/sitemap.xml`.
- `lastSubmitted=2026-11-03T06:45:11.155Z` (Nov 3, 15:45 KST), confirmed after a successful `gsc_submit_sitemap` call.
- `isPending=true`; `lastDownloaded=2026-10-19T23:08:57.582Z` (Oct 20, 08:08 KST), so there is **not yet** evidence of a new Google download.
- GSC sitemap record: `warnings=0`, `errors=0`, historical content counters `submitted=2839`, `indexed=0`. These **are not** a current count of all live XML URLs or a domain-wide indexing census; the download predates the resubmission and subsequent site changes.
- GSC URL Inspection, Google's indexed version (not a live test):

| Sample | GSC result |
| --- | --- |
| `/` | `PASS`; `Submitted and indexed`; last crawl 2026-10-01; robots/indexing allowed; successful fetch; self canonical |
| `/list` | `URL is unknown to Google` |
| `/tags` | `URL is unknown to Google` |
| `/sources` | `URL is unknown to Google` |
| France Constitutional Council Oct 23 article (slug ending `c01b4f`) | `URL is unknown to Google` |
| German Federal Constitutional Court Oct 15 article (slug ending `4eee59`) | `URL is unknown to Google` |
| US Supreme Court Sep 25 article (slug ending `4e0d24`) | `URL is unknown to Google` |

- GSC Search Analytics `web` by date, Pacific Time:
  - October 1–31: one reported impression (Oct 18), zero clicks.
  - November 1–2, queried as `dataState=all`: zero reported clicks/impressions. Freshness and data filtering apply.
  - Performance rows are not an indexing census.

## Fresh public-HTTP checks (no graphical browser)

- `/robots.txt`, `/`, `/list`, `/tags`, `/sources`, and the two sampled France/Germany article URLs: all HTTP 200.
- Sampled public HTML contained canonical references, with no literal `noindex` token; the robots file advertised the sitemap URL.
- `pnpm seo:sitemap:probe`: two XML fetches, both HTTP 200:
  - `urlCount=3777`, `articleUrlCount=2397`, `lastmodCount=3703`.
  - `uniqueCount=3777`, `duplicateCount=0`; canonical/origin/HTTPS/XML safety all true.
  - `urlSetSha256=675467f9ab702d710bd27bb7163febe74ec75b1113c92cd53b48fef660c00b5b` in both runs; `bothRunsMatch=true`.
  - `bytes=801162`; TTFB 3824 / 2942 ms (two samples, not a latency percentile).
- Compared with the Nov 1 P0 closeout: +110 total sitemap URLs and +70 article URLs. New entries are not evidence that Google downloaded them.

## Next decision gate

1. Check `gsc_get_sitemap` for a newer `lastDownloaded` and the transition from `isPending=true`; do not repeatedly resubmit the same sitemap while pending.
2. After a confirmed new download and processing interval, recheck the **same seven** URL Inspection samples to compare verdicts and Google crawl timestamps. No index request is available through this GSC API; inspection reads the indexed version.
3. If `lastDownloaded` remains unchanged after a reasonable interval, inspect Search Console's sitemap UI and Googlebot access/server logs before altering robots, canonical or publication rules. Do not assume that an unknown inspection URL is blocked or that Google's reported `indexed:0` means zero indexed domain URLs.
4. Track performance separately; never infer property-wide coverage from a small sample or Search Analytics reporting.

No new source-code defect was demonstrated by the above checks; current action is **monitor Google processing**, not another speculative Worker or sitemap rewrite.
