# WorldCons SEO P0 — 2026-10-31 live evidence and rollout gate

This continuation concerns URL discovery and Googlebot sitemap reliability.
It supplements [the 2026-10-29/30 implementation record](WORLDCONS-SEO-P0-2026-10-29.md).
Read-only diagnostics were run against the single newly reauthorized GSC
connection; the user's earlier duplicate connections were not called.

## Live GSC evidence (2026-10-31 KST)

Property: `https://worldcons.cclib.workers.dev/` (siteOwner).

- Submitted sitemap: `https://worldcons.cclib.workers.dev/sitemap.xml`.
  Search Console returned `lastSubmitted=2026-10-01T05:43:43.401Z`,
  `lastDownloaded=2026-10-19T23:08:57.582Z`, `errors=0`,
  `warnings=0`, and `contents.web.submitted=2839`. The `indexed=0`
  sitemap metadata must **not** be interpreted as the property's total indexed
  URL count; the homepage inspection shows a positive indexed page.
- Homepage `https://worldcons.cclib.workers.dev/`: GSC Inspection
  `verdict=PASS`, `coverageState=Submitted and indexed`,
  `lastCrawlTime=2026-10-01T05:47:35Z`, robots allowed, mobile fetch
  successful, and Google/user canonical both equal to the homepage.
- Two independently sampled current sitemap article URLs were reported
  `verdict=NEUTRAL`, `coverageState=URL is unknown to Google`. For these
  unknown URLs the Google Inspection API did **not** provide a positive crawl
  or robots verdict, so an explicit Google block or crawl attempt is unproven:
  - `/articles/germany-de-bverfg-2026-10-07-beschluss-vom-7-oktober-2026-648ac7`
  - `/articles/france-fr-conseil-constitutionnel-2026-08-14-decision-n-2026-910-2-dr-dc-du-14-aout-2026-0ba9c0`
- The two actual public article responses were both HTTP 200, emitted
  `<meta name="robots" content="index, follow">`, and emitted an exact
  self-referencing canonical. Their HTML bodies were nonempty; neither had
  an `X-Robots-Tag` denial. This checks only these samples, not every article.
- The same newly reauthorized GSC link was successfully queried again over
  fifteen minutes after the first successful query, without a reconnect flow.
  This is one positive live continuity check, not an audit of the underlying
  token refresh exchange or long-term connection validity.

## Read-only production sitemap probe

`pnpm seo:sitemap:probe` performed two bounded sequential fetches. Both
returned HTTP 200 `application/xml` and exactly the same canonical URL set:

| Probe | TTFB | Total | URLs | Article URLs | Bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 9,612.67 ms | 9,638.30 ms | 3,592 | 2,277 | 764,233 |
| 2 | 6,963.69 ms | 6,969.67 ms | 3,592 | 2,277 | 764,233 |

- Unique URLs 3,592; duplicates 0. XML, canonical origin and protocol safety
  checks passed. Zero cross-origin, non-HTTPS, credential, fragment or query
  URLs. `lastmodCount=3518`.
- Both returned normalized URL-set SHA-256
  `4ff0698956e37afc4100c15e42e5a1974ea812f838406a1544b44a7cb9d1028b`.
- These are two observed requests, **not** a P95/cold-run or Googlebot
  timing distribution. The historical 2026-10-28 Googlebot `/sitemap.xml`
  cancellation after ~16.98 seconds remains a separate corroborating
  symptom, not proof of the current Google crawl outcome.
- GSC's `submitted=2839` and the live sitemap's 3,592 URL count are
  snapshots from different times, not a transactional mismatch finding.

## Code, deployment and validation gates

- Local `main` at `ba0bed0` was clean and **7 commits ahead** of
  `origin/main` when examined.
- Cloudflare Deployments API confirmed 100% production traffic is still
  running WorldCons Worker version
  `7039e41f-d7aa-465c-a1bd-180f5919005a` (2026-10-29).
- Cloudflare Worker settings exposed no
  `WORLDCONS_FAST_SITEMAP_ENABLED` or
  `WORLDCONS_JSON_GUARD_BATCHING_ENABLED` override; both opt-in paths
  remain OFF.
- `pnpm test:public-regression` passed **18/18 tests** in this run.
- Attempts to run `pnpm seo:sitemap:workers`,
  `pnpm test:workers-sitemap`, and the comprehensive
  `tests/article-read-d1-fast-list.test.ts` were blocked by DevSpace
  command/tool timeouts; **no passing result is claimed for these attempts**.
  The earlier documented 4-mode local Workerd parity remains historical
  evidence only; fresh acceptance is pending.
- A separate read-only Codex diagnosis was started to investigate those
  timeouts. Its final result was recovered in the next continuation; see below.
  It is not an authorization to mutate or deploy.

## Recovered local read-only Codex diagnostic (2026-10-31)

The previously timed-out read-only Codex run `30cffb3b-46af-4c97-a539-877834b50a9d`
completed. Its report identifies Windows module-loading and the DevSpace
per-command time limit as the problem, **not** a proven deadlock in the
article-read test. A nondefault loader completed all **29 of 29**
`article-read-d1-fast-list` tests (reported test-body duration 8.06 seconds,
entire execution 50.7 seconds). Loading `esbuild` cold took approximately
40.26 seconds in the same environment.

On an identical local SQLite data snapshot, the worker reports an exact
sorted `slug + lastModified` parity for all 2,239 visible articles across
the four configurations, including withdrawn/catalog exclusions, approved
metadata, current generation, and pending-metadata fail-closed:

| Fast sitemap | JSON1 guard | SQL statements | Local SQLite execution |
| --- | --- | ---: | ---: |
| OFF | OFF | 179 | 372.2 ms |
| ON | OFF | 122 | 183.9 ms |
| OFF | ON | 87 | 114.2 ms |
| ON | ON | 30 | 101.9 ms |

These are the recovered agent's local SQLite measurements, **not** a fresh
full Workerd `rows_read` or HTTP response result. The documented earlier
local Workerd snapshot remains 20,771 / 20,745 / 20,771 / 20,745 rows-read
and 622 / 279 / 237 / 106 ms Worker elapsed for OFF/OFF, ON/OFF,
OFF/ON, ON/ON respectively, with identical normalized XML and URL hashes.
It is historical evidence rather than a remeasurement from this run.

### New bounded full-scale Workerd attempt

The DevSpace operation timeout is shorter than the test's internal
120-second bound. A dedicated detached **local-only** Node process was
started with an explicit 480-second harness bound to collect a new four-way
Workerd report while preserving the harness's ephemeral local D1, disabled
outbound network, no production database IDs, and temporary directory cleanup.
The temporary log is outside the repository at
`%TEMP%\worldcons-seo-p0-workerd-20261031.log`. No passing outcome may
be claimed until that log contains `WORKER_ACCEPTANCE_COMPLETE` and the
reported rows-read/parity/safety conditions are inspected.

**The independent run completed successfully** with the explicit completion
marker and JSON report; process PID 3076 had exited when inspected. The
report records 66,215 ms total duration, temporary local D1, outbound
network disabled, temporary directory removed, 20 seed requests, four
healthy matrix requests and four negative checks.

| Fast sitemap | JSON1 guard | Entries | SQL statements | Local Workerd `rows_read` | Worker elapsed |
| --- | --- | ---: | ---: | ---: | ---: |
| OFF | OFF | 2,239 | 179 | 20,771 | 1,758 ms |
| ON | OFF | 2,239 | 122 | 20,745 | 1,117 ms |
| OFF | ON | 2,239 | 87 | 20,771 | 471 ms |
| ON | ON | 2,239 | 30 | 20,745 | 167 ms |

All four runs produced **byte-identical sitemap XML**:
`c47028e0ad5a12960611083a48b7e060fa0cb6cabf3370de27e4be0f6098a29b`,
and the same URL + `lastmod` SHA-256:
`c93d3a61c8cb1cb58967046a76fcf78425dddb3e77c56bcd08b07bdfb4927592`.
Every mode returned HTTP 500 for a pending metadata repair, preserving
fail-closed behavior. These are newly obtained **local Workerd** observations,
not production request `rows_read`, Googlebot fetch results or production TTFB.

## Follow-up implementation: sitemap-only JSON1 opt-in

The initial shared flag `WORLDCONS_JSON_GUARD_BATCHING_ENABLED` changes
multiple public-read paths. To reduce the production blast radius, a
separate opt-in flag `WORLDCONS_SITEMAP_JSON_GUARD_BATCHING_ENABLED` was
implemented locally and is **unset/OFF** in the runtime configuration.

- The D1 article repository forwards this explicit boolean **only from**
  `listPublicSitemapArticles` to the public-generation/metadata overlay.
- The overlay passes it through both initial and final CAS/identity reads
  to `currentGenerations` and `readPublicMetadataState`.
- `readBatchedByIds` accepts an optional request-local `jsonBatching`
  override. When it is undefined, existing callers keep their original
  global policy; explicit `true` enables JSON1 only for the caller, and
  explicit `false` enforces legacy reads even if the global flag is on.
- The isolated Workerd fixture now passes the explicit sitemap option rather
  than mutating process-global environment variables between test requests.
- Scoped regression coverage verifies optimized sitemap SQL, ordinary
  guards remaining legacy, full legacy fallback when JSON1 fails, and
  explicit OFF overriding a global ON state.

**Local code is not deployed, and no global guard flag is activated.**
The scoped code passed the following independent validation:

| Command / check | Result |
| --- | --- |
| `pnpm typecheck` | PASS; Next.js typegen and TypeScript |
| `node --import tsx --test tests/article-read-d1-fast-list.test.ts` | 30/30 PASS; includes sitemap-scoped behavior and JSON1 fallback |
| `pnpm test:public-regression` | 18/18 PASS |
| `pnpm test:seo-sitemap-probe` | 11/11 PASS |
| Full-scale isolated Workerd + local D1, new scoped-option fixture | 4/4 sitemap PASS; 4/4 pending-metadata fail-closed |
| ESLint restricted to the eight changed TypeScript files (`--max-warnings 0`) | PASS; zero errors or warnings |
| `pnpm build:vinext` | PASS; all five build stages completed |
| `git diff --check` | PASS |

The **scoped** Workerd matrix produced 2,239 identical article entries and
byte-identical XML across all four modes:

| Fast | Sitemap JSON1 | SQL statements | Local `rows_read` | Worker elapsed |
| --- | --- | ---: | ---: | ---: |
| OFF | OFF | 179 | 20,771 | 2,598 ms |
| ON | OFF | 122 | 20,745 | 823 ms |
| OFF | ON | 87 | 20,771 | 500 ms |
| ON | ON | 30 | 20,745 | 149 ms |

Identical XML SHA-256 is
`c47028e0ad5a12960611083a48b7e060fa0cb6cabf3370de27e4be0f6098a29b`
and normalized URL/`lastmod` SHA-256 is
`c93d3a61c8cb1cb58967046a76fcf78425dddb3e77c56bcd08b07bdfb4927592`.
The isolated execution removed its temporary local D1 and blocked outbound
network; no real production D1 was bound.

This establishes a narrow, read-only **release candidate**. Production
response time, actual production-data snapshot parity, and live Googlebot
fetch success remain unverified. Production code and flags are unchanged,
and any deployment/activation must retain a rollback path.

Next.js `typegen` rewrote the generated `next-env.d.ts` during testing;
that change was restored before the final changeset. An old, zero-byte
`.git/index.lock` (created before this continuation) was inspected,
confirmed to have no active Git writer, then removed so Git could operate.
Neither file is part of the SEO implementation.

### Recent Googlebot log sampling

A narrow read-only Workers Observability telemetry query for service
`worldcons`, text `Googlebot`, from 2026-10-30T12:00:00Z to
2026-10-31T01:30:00Z returned zero matching logged events. This **does not**
prove Googlebot made no requests: the User-Agent may not be present in
indexed event fields and logging is not a complete traffic ledger.

Production optimization switches remain OFF. In particular, the current
`WORLDCONS_JSON_GUARD_BATCHING_ENABLED` is a **shared** switch used by
other public-read paths, not a sitemap-exclusive control; activating it
without scope isolation would have a wider effect than the sitemap P0.

## Immediate decision and remaining gate

The public sitemap is complete for the two measured requests but too slow
for comfortable crawler reliability. GSC inspection shows positive homepage
indexing and unknown article discovery; no site-wide `noindex` or per-sample
article canonical/robots fault was observed.

**Do not activate either sitemap optimization flag or deploy unverified code
based on these data alone.** Reproduce real Workerd 4-mode URL/`lastmod`
parity and `rows_read` bounds on the same data; validate that new production
candidate code does not change the public sitemap set and is faster before
release. After a safe rollout, repeat production sitemap timing, verify
Google's actual `lastDownloaded` changes, and inspect the exact same article
URLs. No guarantee of indexing follows from a successful sitemap fetch.

No GSC submission, Google OAuth reconnect, DNS, Cloudflare config change,
production D1 modification, deployment, push or PR was performed in this
continuation.

## 2026-10-31 production rollout and immediate rollback (later continuation)

**This section supersedes the earlier statement about no deployment for the
later continuation only.** The validated `16a20c2` source was deployed once
with both optimization flags OFF. The release failed the live sitemap smoke
and was immediately rolled back. No Google, production D1, DNS, or GitHub
write was made.

| Evidence | Result |
| --- | --- |
| Pre-deploy live sitemap | HTTP 200; 3,609 URLs, 2,287 article URLs; TTFB 6.67 s / 6.12 s |
| Old production Worker | `7039e41f-d7aa-465c-a1bd-180f5919005a` |
| New 100% OFF-flag deployment | `d3dea58d-1012-4186-ad3c-d9ea304fb646` at 2026-10-31T05:02:54Z |
| New version sitemap smoke | HTTP 500 twice; 16.78 s / 18.33 s |
| Cloudflare error logs | `sitemap_source_unavailable`, `source=articles`, retries=2 |
| Immediate rollback | Deployment `68c5d0a9-2c09-435f-a358-54599e6a062d` at 2026-10-31T05:04:08Z, 100% old version |
| Recovery smoke | HTTP 200; 3,609 URLs, 2,287 article URLs; 6.54 s |

### Root-cause evidence

The prior legacy sitemap candidate read did **not** project `articles.id`,
so `overlayPublicGenerationRows` could not look up metadata guards for those
candidate rows. The new source correctly includes `id`, activating the
strict metadata repair guard. The production Core D1 read-only inventory
showed `public_read_required=1`, 834 metadata-verified published rows with
zero missing immutable P3 versions, and at least one, later two, concurrently
`leased` metadata rows (some in the published summarized set).

A `leased` row in the strict `readPublicMetadataState` function raises
`e2e.public_metadata_pending`. This is a **high-confidence causal
explanation**, but the production wrapper deliberately suppresses underlying
errors and logs only `sitemap_source_unavailable`; the original inner error
code was not captured from that deployment. Do not describe this as
fully proven from the Cloudflare exception stack.

### Candidate: safely withhold only unverified article URLs

The follow-up local patch changes **only the sitemap candidate list**. After
candidate collection and before the unchanged strict generation/metadata
overlay it checks the metadata repair table for non-`verified` rows or
revision/applied-revision mismatches, bounds the result set, and removes
those article IDs from the sitemap candidates. No unverified article is
served; unrelated verified public URLs remain available. Errors in the
read, an over-limit result set, or a concurrent metadata change detected
after this prefilter still fail closed. Search and detail reads retain
their original strict behavior.

The isolated Workerd test was updated to insert one published `pending`
metadata case after the healthy snapshot: all four modes should return
HTTP 200, omit that case, and preserve the baseline XML bytes exactly.
The full local Workerd run passed, with 2,239 matching healthy entries,
4/4 safe withholding checks, and 4/4 XML equality. SQL statement counts
rose by 2 for one metadata table check and one bounded unverified lookup.

**The follow-up patch is not yet deployed.** Its own typecheck/build and
revalidation must complete first. The live service remains on the
recovered 2026-10-29 version until a separately verified release.

## Follow-up: second OFF-flag release failed, rollback, targeted diagnosis

- The follow-up sitemap withholding fix was committed as `b275f729601061f121c2ea3638702e9449fa71e9`.
- At **2026-10-31T05:16:30Z**, Worker version
  `b8d6e675-1840-46e6-902d-ef53c6c196d7` was deployed at 100%
  with both optimization flags still OFF. Two immediate public sitemap
  fetches both returned HTTP **500** after ~12.08 and ~15.74 seconds.
- The emergency rollback deployment `b38502e6-49e2-4a37-b3b5-bf1b1ff23781`
  at **2026-10-31T05:18:02Z** restored the original safe version
  `7039e41f-d7aa-465c-a1bd-180f5919005a` to 100% of traffic.
  Independent recovery smoke returned HTTP **200**, 3,609 total URLs,
  2,287 article URLs, 7.24-second elapsed.
- Cloudflare Workers logs confirmed both second-release errors as
  `sitemap_source_unavailable`, source `articles`. **The root
  internal exception remained suppressed.** Thus one leased case
  cannot be presented as the verified sole cause of the outage.

### Additional production D1 read-only evidence

With 80 approved published P3 versions (same query cohort) read-only:

| Projection | Approximate serialized result size | Query result |
| --- | ---: | --- |
| `SELECT v.*` (all 40+ immutable P3 columns) | 2,149,553 characters | 80/80 |
| Sitemap fields only (`id, article_id, slug, summarized_at, fetched_at, discovered_at, source_metadata`) | 39,016 characters | 80/80 |

The full projection includes immutable source text (around 20 MB over
~835 verified published versions at the time of the snapshot) but the
sitemap needs only URL, modified date, and publication metadata. All
sampled versions had valid JSON. This is a plausible significant
performance bottleneck, not proof of the specific 500 exception.

### Next narrow revision

- Only when invoked by `listPublicSitemapArticles`, the unchanged
  two-pass immutable overlay receives `versionProjection:'sitemap'`.
  Its metadata-approved and protected-generation P3 queries select
  only the seven required fields, not `v.*`. All other public detail,
  search and source reads retain the full `v.*` projection.
- `resilientSitemapRead` emits one sanitized
  `sitemap_source_attempt_failed` diagnostic per failed attempt:
  source, attempt count and a **strictly validated short code** only,
  never arbitrary error messages, SQL or case content. The existing
  fail-closed public behavior remains unchanged.
- Added direct tests for narrow P3 queries, preservation of ordinary
  P3 reads, sanitized retry diagnostics, and no leakage of raw error
  messages. Focused article/JSON1 test **30/30 PASS** and public
  SEO regressions **19/19 PASS**.
- The 2,239-article isolated Workerd four-mode acceptance and the
  pending-metadata withholding checks **4/4 PASS**, exact XML and
  normalized URL+lastmod parity, no outbound and no production D1 access.

This narrow revision is a **candidate only**, not a claim of an
operational repair. Typecheck, lint, release build and live verification
must succeed before activating any sitemap optimization flag.

## Later continuation: third release failure and definitive inner error

- The narrow immutable version projection plus sanitized diagnostics were
  committed as `37ef570f852069d558c9b1b170df1a1c7da9e7f6`.
- The Worker release `e77178c4-b159-4731-9e82-549eeec7b708`
  was deployed at 2026-10-31T05:22:58Z, all sitemap optimization flags
  still OFF. Immediate `/sitemap.xml` smoke returned HTTP **500**
  after 13.43 seconds.
- The rollback `349c8dec-bd6f-4026-946c-291442ee2fcf` at
  2026-10-31T05:23:35Z returned 100% traffic to
  `7039e41f-d7aa-465c-a1bd-180f5919005a`; recovered sitemap
  HTTP **200**, 3,609 URLs/2,287 article URLs in 6.31 seconds.
- For the first time, bounded Workers Observability logs revealed the
  exact underlying error code from **both attempts**:
  `sitemap_source_attempt_failed` / `e2e.public_metadata_pending`.
  This establishes the **inner error** for the third release. It does
  not independently establish every specific article or the exact
  earlier release's underlying exception.
- The previous prefilter of unverified metadata IDs is insufficient:
  the immutable overlay independently reads metadata twice, while
  the ongoing ingestion/repair workflow can change the approval state
  between those reads. The prefilter and full-row projection reductions
  alone did not restore the live endpoint.

### Fourth candidate: per-article two-pass sitemap exclusion

The next local change replaces the one-time prefilter with an
explicitly sitemap-only `tolerateUnverified` option for metadata reads.
The default mode used by ordinary detail, search, source and E2E
guards still **throws** on a pending or revision-mismatched metadata
record. When called by the sitemap overlay only:

1. Both metadata-state passes return the unverified state without
   prematurely failing the whole sitemap.
2. Only verified immutable P3 versions are selected for hydration.
3. Any article whose metadata is unverified on either pass, whose
   revision/fencing token changed, or whose metadata guard first
   appeared on the second pass is withheld from the sitemap.
4. Other verified, stable articles remain visible. Generation
   identity checks and ordinary reads' strict guard remain unchanged.
5. The previous narrow sitemap-only P3 projection and safe error-code
   diagnostics are retained. The unnecessary prefilter scan has been
   removed, restoring the earlier SQL statement count.

The focused test simulates a **verified metadata record changing to
`leased` between the first and second metadata queries**. The sitemap
omits the changed article while the ordinary metadata read still rejects
it. Together with existing status coverage, the article/JSON1 tests
passed **31/31**, the independent strict public E2E and metadata suites
**34/34**, the public SEO regression **19/19**, and the full-scale
isolated Workerd 4-mode matrix reproduced **2,239 byte-identical XML
articles** and 4/4 pending cases safely withheld. Local Workerd
`rows_read` was 20,771/20,745/20,771/20,745 and SQL statements
179/122/87/30 for OFF/OFF, ON/OFF, OFF/ON and ON/ON.

This fourth candidate is **not yet verified on production D1**. No
Google write, production D1 change, DNS change, Git push, PR or
optimization flag activation occurred as part of this change.

## Final 2026-10-31 production result: safe two-pass rollout and sitemap JSON1 ON

This section is the **latest operational state** and supersedes the
earlier rollout-gate statements above.

### Successful OFF-flag repair release

- Commit `62e292d37a4078fcd7655cb846bc535df6c77d41` correctly handles
  metadata that is pending, leased, or changes between the two approval
  reads. The regular public/search/detail strict rejection remains intact.
  The unnecessary one-time prefilter was removed.
- `pnpm typecheck`, scoped ESLint, Vinext five-stage production build,
  Wrangler dry-run, 31/31 focused article tests, 34/34 independent
  public/metadata E2E tests, 19/19 public SEO tests, and a full
  2,239-entry isolated Workerd matrix all passed.
- Deployed `d21883c5-172d-4317-af51-36466310b555` at
  **2026-10-31T05:28:19Z**, 100% traffic, both sitemap optimizations OFF.
- Initial public sitemap request returned HTTP 200, 3,609 URLs including
  2,287 articles, 9.35 seconds elapsed. Two subsequent complete fixed
  probes returned HTTP 200, 3,609/2,287, identical URL+`lastmod` hash
  `5619428f3c2f5dd5d298d6f94c368b575cfb6c3773736fab235d0b2beedfc433`,
  3,535 `lastmod` entries, zero duplicate or cross-origin URLs, and
  TTFB **10.02 s / 10.00 s**. All XML/HTTPS/canonical safety checks passed.

### Production sitemap-only JSON1 activation

- Commit `964d4b9a71f7a13599637e90c2cdffde6476b0fb` sets **only**
  `WORLDCONS_SITEMAP_JSON_GUARD_BATCHING_ENABLED=true` in
  `wrangler.jsonc`. It does **not** set
  `WORLDCONS_JSON_GUARD_BATCHING_ENABLED` or
  `WORLDCONS_FAST_SITEMAP_ENABLED`. Vinext build and Wrangler dry-run
  both passed; the dry-run and live Worker settings confirmed just the
  sitemap-specific flag.
- Deployed `e673c119-0086-40c2-a76c-3805baa7092d` at
  **2026-10-31T05:30:48Z**, independently confirmed at 100% traffic.
- First production request: HTTP 200, 3,609 URLs/2,287 articles,
  TTFB **5.18 s**. The next two complete bounded probes were also
  HTTP 200 and returned TTFB **5.01 s / 4.87 s**.
- Every optimized probe preserved **exactly** 3,609/2,287 URLs, 3,535
  `lastmod` entries and the same normalized URL+`lastmod` SHA-256
  `5619428f3c2f5dd5d298d6f94c368b575cfb6c3773736fab235d0b2beedfc433`.
  The XML was valid and canonical/same-origin/HTTPS safe, with zero
  duplicate, query, fragment, credential or external URLs.
- The two-probe comparison against the same tool's immediately preceding
  OFF release improved TTFB from **10.02/10.00 s to 5.01/4.87 s**,
  approximately **51%** for this narrow sample. This is an observed
  production result, **not** a latency percentile or promise for Googlebot.
- Public smoke after activation: homepage HTTP 200, `robots.txt` HTTP
  200 with sitemap declaration, German case detail HTTP 200 with explicit
  `index, follow` and exact self-canonical. The normal public-read
  code was not reconfigured to use JSON1.

### Google Search Console follow-up

- Used the **single currently reauthorized GSC link only**. The existing
  sitemap entry still reports last submitted **2026-10-01T05:43:43Z**,
  last downloaded **2026-10-19T23:08:57Z**, warnings=0 and errors=0.
  The `indexed=0` sitemap metadata is not the property-wide indexed count.
- A single attempt to resubmit the **existing** sitemap failed with
  HTTP **403 `insufficient_scope`**: the current MCP connection lacks
  `gsc:write` (requires both `gsc:read` and `gsc:write`). **No
  submission occurred.** Do not retry through older duplicate links
  or cause another OAuth reconnect without user approval.
- The previously sampled German (2026-10-07) and French (2026-08-14)
  case detail URLs still report `URL is unknown to Google`. Faster XML
  delivery has **not** yet established any Google download or indexing gain.

### Handoff

Production state at this checkpoint is **healthy Worker
`e673c119-0086-40c2-a76c-3805baa7092d` with sitemap-only JSON1 ON**.
Safe rollback candidate is the verified `d21883c5-172d-4317-af51-36466310b555`
with optimizations OFF (or original `7039e41f` if needed).

Keep the global JSON1 and Fast Sitemap flags OFF. Continue checking live
XML parity, response latency, Workers errors, and the GSC sitemap
`lastDownloaded` timestamp before drawing conclusions about indexing.
Do not claim a successful Google re-submission, full-source snapshot
parity, property-wide indexing gain, or P95 improvement based only
on these samples. No browser, PR or GitHub push was used.

## 2026-10-31 afternoon: Google discovery and archive pagination

### GSC ground truth (read-only, current connection only)

- Search Console property `https://worldcons.cclib.workers.dev/`
  reports `siteOwner`; the submitted sitemap's `lastDownloaded`
  remains **2026-10-19T23:08:57Z**, `lastSubmitted` remains
  **2026-10-01T05:43:43Z**, with zero warnings/errors and 2,839
  reported submitted URLs. The current live sitemap advertises 3,609;
  this is not evidence that Google has retrieved the newer XML.
- Search Analytics finalized data for **Oct 1–28, 2026** shows
  **0 clicks and 1 impression** (Oct 18), entirely from the homepage.
- URL Inspection: homepage **Submitted and indexed**, robots
  `ALLOWED`, fetch `SUCCESSFUL`, matching canonical,
  last crawled **2026-10-01T05:47:35Z** as mobile. The sampled
  German Oct 7 and French Aug 14 case URLs remain
  `URL is unknown to Google`. Do not infer property-wide
  indexing totals from this small sample.
- The existing GSC MCP connection has read access but does not
  have `gsc:write`. The previous 403 submission was not retried;
  no OAuth reconnection or Google write was attempted.

### Production HTTP and Cloudflare observational evidence

- Confirmed Worker `e673c119-0086-40c2-a76c-3805baa7092d`,
  100% traffic, sitemap-only JSON1 enabled, other optimization
  flags absent.
- In the queried 2026-10-30/31 Cloudflare Workers telemetry
  interval, a Googlebot user-agent filter returned no matching
  events. This is limited to the available sampled/retained
  telemetry, not proof Google never visited.
- A Naver Yeti bot hit `/tags/bverfgg` with HTTP 500 on the
  earlier Worker `7039e41f`; the same route currently returns
  HTTP 200. `/tags` currently serves around 2.03 MB of HTML
  with 1,256 unique tag anchors, while `/tags/bverfgg` serves
  around 1.18 MB and 50 unique article anchors. A later tag hub
  response-size improvement is possible but not yet implemented.
- Direct server HTML inspection without a browser: homepage
  exposes 4 unique article links; `/list` exposes approximately
  15 unique article links and ordinary pagination anchors.
  Page 2 and page 3 render distinct article records server-side.

### Confirmed canonical defect and scoped implementation

- Live `/list?page=2` and `/list?page=3` both formerly
  advertised canonical `/list` despite separate published
  article lists and real previous/next anchors. The pages were
  discoverable without JavaScript, but their canonical metadata
  instructed crawlers to consolidate with the first page.
- Added `lib/seo/list-pagination.ts` and switched
  `app/list/page.tsx` from one static canonical to
  request-specific `generateMetadata()`. Unfiltered valid
  archive pages N ≥ 2 self-canonicalize to `/list?page=N`;
  page 1 uses canonical `/list`. Filtered/search combinations
  and invalid page numbers receive `noindex, follow` and
  canonical `/list` to avoid filtered URL explosion.
- Article source URLs, visible pagination UI, sitemap XML,
  publication controls, and the global JSON1 feature switch
  remain unchanged.
- Dedicated canonical regression tests added to
  `tests/seo-public-surface.test.ts`: public SEO **20/20 PASS**,
  sitemap probe regression **11/11 PASS**, TypeScript typecheck
  **EXIT 0**, scoped ESLint **EXIT 0**, five-stage Vinext production
  build **EXIT 0**, and Wrangler deploy dry-run **EXIT 0**.
  The deployment and live canonical checks remain separate gates.
  Wrangler dry-run retained sitemap-only JSON1=true and left
  global JSON1/Fast Sitemap absent.
- Additional GSC URL Inspections for archive page 2, German
  `/tags/bverfgg`, and one Oct 23 French case returned
  `URL is unknown to Google`. All of these are pre-rollout
  baseline observations, not evidence of newly induced exclusion.

### Production deployment and final verification

- The code, tests and pre-deployment observations were committed as
  `457d569b54ee7b000a503216707352988d3948e1`.
- Cloudflare deployed Worker
  `ee16f1ec-a7ef-45e6-9be9-a6221a311e5a` at
  **2026-10-31T08:28:09Z**, independently verified at **100%**
  traffic. The only active sitemap performance flag remains
  `WORLDCONS_SITEMAP_JSON_GUARD_BATCHING_ENABLED=true`;
  global JSON1 and Fast Sitemap remain OFF.
- Live HTTP 200 and canonical parity:
  - `/list` canonical is `/list`.
  - `/list?page=2` canonical is **`/list?page=2`**.
  - `/list?page=3` canonical is **`/list?page=3`**.
  - `/list?jurisdiction=Germany&page=2` and
    `/list?q=free` both output **`noindex, follow`** and
    canonical `/list`, with HTTP 200.
  - Home, `robots.txt`, and `/tags/bverfgg` also returned
    HTTP 200. No article URL or sitemap publication policy changed.
- The production sitemap was fetched twice with the bounded,
  fixed-endpoint checker: **HTTP 200 twice**, 3,609 total URLs,
  2,287 article URLs, 3,535 `lastmod` entries, no duplicates or
  cross-origin URLs, valid XML, and **exact normalized URL+lastmod
  parity** to the previous release (SHA-256
  `5619428f3c2f5dd5d298d6f94c368b575cfb6c3773736fab235d0b2beedfc433`).
  TTFB measurements were 6.21 and 5.24 seconds; no P95 claim.
- Google's index does **not** update immediately with deployment:
  the three newly inspected URLs and two older case samples
  remain unknown as of the inspection. GSC sitemap re-submission
  remains blocked by missing `gsc:write` and was not retried.
  **This fixes the canonical defect, not Google's crawl schedule.**

No browser, PR, Google write, production D1 write or OAuth
reconnection was used. GitHub push was not performed. Next P0
observation should compare GSC `lastDownloaded`, indexStatus
samples, and external crawler access after the live metadata change.

## 2026-10-31 later P0 continuation: tag-hub HTML size and crawler navigation

### Problem and safety constraints

The old `/tags` returned **2,027,648 bytes** of HTML, with
**1,256 tag detail anchors** and about **1.29 million inline-script
characters** in one response. This loads every published tag at once
and unnecessarily increases page cost for humans and crawlers. The
change must not modify published tag eligibility, tag-detail URLs,
click analytics, or the canonical sitemap inventory.

### Implementation and validation

- Added pure `lib/seo/tag-hub-pagination.ts`: fixed 96-tag page
  size, stable descending article count / ascending slug ordering,
  strict page parsing, canonical page URLs and bounded result slices.
- Updated `app/tags/page.tsx` to accept URL page numbers, render
  only the selected 96 tags via the existing `TagHubList`, and render
  all numbered server-side `<a href>` navigation plus previous/next.
  `/tags` has canonical `/tags`; page N has canonical
  `/tags?page=N`. Invalid/out-of-range page numbers are HTTP 404.
- Kept the existing `TrackedLink` per-tag analytics and public
  `listTags({sort:'count', minArticleCount:3})` eligibility. The
  underlying D1 inventory is still read in full, so the measured
  benefit is **HTML/render payload**, not yet reduced D1 reads.
- New regression test checks 1,256 representative tags split into
  14 pages with every slug present exactly once, stable ties, page
  parsing, self-canonical metadata and server-side link wiring.
- Verification passed: public SEO **21/21**, reference reads
  **10/10**, sitemap probe **11/11**, `pnpm typecheck`,
  scoped ESLint, five-stage `pnpm build:vinext`, and
  Wrangler dry-run (**all EXIT 0**).
- Local code committed as `6c1b3837158e0918b73deb2aaa9eee7f2b7386e1`.

### Production results

- Deployed `504d3c2d-bd40-44b2-9207-67cf6baff36a` at
  **2026-10-31T09:19:36Z**; Cloudflare independently confirmed
  **100% traffic** to this Worker and only sitemap-scoped JSON1
  remains enabled.
- Live `/tags` is **186,081 bytes**, down from
  **2,027,648 bytes (~90.8% reduction)**, HTTP 200 and 96 tag links.
  Page 2 has 96 tag links and 185,413 bytes; final page 14
  has 8 links and 45,820 bytes. All return self-canonical HTML.
- A complete production crawl of **all 14 tag index pages**
  confirmed **14/14 HTTP 200**, **1,256 distinct tag URLs**,
  **zero duplicates**, **14/14 self-canonical**, and all
  14 page destinations linked from each page's server HTML.
  Production Core D1 read-only `COUNT(*)` with
  `article_count >= 3` returned exactly **1,256** matching
  publishable index candidates. Page 15 and page 0 returned 404.
- `/tags/bverfgg` remained HTTP 200. `/sitemap.xml` remained
  HTTP 200 with **3,609 total URLs/2,287 article URLs**.
  A short post-deployment Worker telemetry window
  (2026-10-31 09:19:36Z–09:21:06Z) yielded zero observed
  HTTP 5xx; this is **not** a long-term error-rate guarantee.
- GSC sitemap metadata remains unchanged:
  `lastDownloaded=2026-10-19T23:08:57.582Z`. There was no new
  GSC write or OAuth prompt. An HTML response improvement cannot
  itself confirm a Googlebot re-download or indexing gain.

### Next P0 focus

The `/tags/bverfgg` detail route still returns roughly **1.18 MB**
of HTML and contains 50 article links plus numerous related-tag links;
investigate a bounded server-rendered detail listing without losing
article discoverability. Continue read-only GSC and available crawler
telemetry checks. Do not infer that Googlebot has indexed new case URLs
until URL Inspection or equivalent independent evidence changes.

No browser, PR, GitHub push, production D1 mutation, Google write,
or OAuth reconnection was performed in this continuation.

## 2026-10-31 evening: tag-detail pagination hardening and production outcome

### Initial 10-case HTML optimization and two rollbacks

- Implemented a 10-case server-rendered article page for each tag-detail
  route and canonical page-specific URLs; optional related tags now read
  only 9 candidates. Existing `/api/tags/:slug` still returns 50
  cases and its original JSON shape, without `pageInfo`.
- Original `/tags/bverfgg` HTML was approximately **1,178,842
  bytes** with 50 article cards; optimized first-page HTML is
  **281,791 bytes (~76% smaller)**. Core D1 has 72 distinct
  published tag/article/slug links, so 8 pages should contain
  10/10/10/10/10/10/10/2 records when all are verified.
- Commit `50bb25386157b73df1bf9800af2dbae5e6fc2430` deployed
  as `772433b6-62d9-4358-8bb7-248d588c6eb5`. Repeated
  live checks revealed HTTP **500** on page 2 and page 3. Cloudflare
  request telemetry confirmed the 500 responses but exposed no
  underlying exception code. **Immediately rolled back** to known
  healthy `504d3c2d-bd40-44b2-9207-67cf6baff36a` via
  deployment `e389cd0f-1961-4033-8723-9c962848bedf`.
- Implemented a tag-detail-only guarded metadata-omission path
  `withholdUnverifiedMetadata`; global regular list, search and
  detailed article reads remain strict. Also added bounded (2
  attempts, 120ms gap) read retry with sanitized error-code logging,
  plus fail-soft related-tag enrichment. Committed as
  `30c97e00504ad44028e6b42303340f5241cdf6da`.
  Full article/metadata/regression tests and Workerd passed.
- Deployed `bbe27186-2ac0-4ae0-ac68-d167c3bdf552`.
  All 8 pages responded HTTP 200, and two full crawls showed
  72 unique links. However the third and a subsequent full crawl
  showed **71 distinct links and one duplicate** across page
  boundaries 6 and 7 (sample slug
  `de-bverfg-dejure-2021-07-22-2bvc321`). Source
  D1 had **72 unique article IDs/slugs/links, no duplicate rows**.
  **Rolled back a second time** to `504d3c2d` via deployment
  `d0743629-921c-4f3e-9e41-a735bd3b7ae1`.

### Fixed candidate page slots before metadata withholding

- The problem was not source-table duplication or a missing
  deterministic sort (the D1 list comparator sorts by
  `original_published_at DESC, id ASC`). The previous
  page query withheld unverified cases **before** slicing the
  requested page; when approvals changed during a multi-page crawl,
  a later published case could slide from page 7 into page 6
  and be rendered twice in the two independently fetched pages.
- New opt-in `stablePageBoundaries` is accepted **only** when
  a tag filter, `count:'exact'`, `withholdUnverifiedMetadata`,
  and a public read are all present. It sorts the published,
  textually eligible candidate array, freezes the offset slice,
  then applies the two-pass immutable metadata/public approval
  gate **only to that page**. An unverified slot is left empty,
  rather than backfilled from the next page. The count is
  **candidate count** (UI labels it “연결된 판례”), not a claim
  that every slot is currently approved.
- Added real SQLite/D1 regression that sets up **12 published,
  equally dated, deterministically ID-sorted tagged cases**,
  leases the page-1 second case, reads the first page, verifies
  its approval before reading the next page, and proves page 2
  still contains cases #11/#12 with **no duplicates or offset
  shift**. D1 guarded tests **34/34** PASS.
- Overall validation PASS: public SEO **23/23**, article reads
  **23/23**, metadata E2E **10/10**, reference reads **10/10**,
  sitemap probe unit tests **11/11**, `pnpm typecheck`,
  scoped ESLint zero warnings, five-stage Vinext production build,
  Wrangler dry-run, and isolated Workerd **2,239-entry,
  four-switch byte-identical sitemap matrix** with 4/4 safe
  pending-case withholding.
- Fix committed as `17c6da494d6357e1078a4ffd95f46fa0ec5d0ed5`
  and deployed as production Worker
  **`10c2407e-d742-4236-9749-1c9a9c56e23d`** at
  **2026-10-31T10:01:17Z**, 100% traffic confirmed.
- **Three complete 8-page live crawls** (24 successful HTTP
  200 responses) each found **72 distinct article slugs,
  zero duplicates**, every page self-canonical, 8 page
  navigation destinations, and the expected last page of two
  articles. Previously unstable pages 6/7 were clean every
  time. `/tags` remains **186,081 bytes**, and
  `/api/tags/bverfgg` remains HTTP 200, 50 articles without
  `pageInfo`. Out-of-range page 9 returns HTTP 404.
- Workers Observability query after final deployment found
  **zero observed HTTP 5xx events** in the queried interval.
  Sitemap-only JSON1=true remains the sole sitemap performance
  flag. No PR, GitHub push, browser, OAuth reconnection, GSC
  submission or production D1 write was performed.

### Outstanding independent P0: unstable sitemap membership

- Despite successful tag-detail crawls, the **post-release
  production `pnpm seo:sitemap:probe` failed twice**
  with two-run parity errors (`urlSetSha256`, later also counts
  and lastmod). Three further read-only HTTP 200 responses
  contained respectively **3,618 / 3,617 / 3,619 URLs**
  (article URLs **2,293 / 2,292 / 2,294**). Differences
  were actual inclusion/exclusion of several old 2021–2024
  German-case URLs, not differences to the `lastmod`
  values of existing URLs. The tag-detail pagination change
  does not change the sitemap query itself.
- Those fluctuating sample URLs were confirmed present and
  published in Core D1. A read-only Core D1 snapshot showed
  **2 leased / 854 verified metadata repairs** and sample
  verified records with exceptionally high approval revision
  counts (e.g. **73, 321, 366**). Another read showed those
  particular revision counters had stabilized; do not assume
  they are continually changing at all times.
- Source review in `lib/cloudflare/search-projection/d1-sync.ts`
  found `syncSearchProjectionForArticle` **unconditionally
  calls `invalidateSearchMetadata` if a repair record is
  already `verified`**, and `invalidateSearchMetadata`
  increments the revision and changes status to pending.
  This is a **plausible source** of excessive invalidation
  when incremental synchronization invokes unchanged
  articles repeatedly; actual upstream call frequency and
  unchanged-input contract still need confirmation before
  changing it.
- The sitemap is still serving **HTTP 200**, and its guarded
  per-article omission remains fail-closed, but its URL set
  currently fails the stable two-fetch parity gate. **Do not
  report WorldCons SEO indexing or site-wide P0 as done.**
  Next work should diagnose repetitive metadata invalidation
  and stabilize the eligible public URL set without bypassing
  approvals or serving withdrawn cases. Current successful
  tag-detail Worker `10c2407e` is retained, because the
  independent sitemap source code was not altered in this
  rollout. If a new Worker-specific sitemap 500 or unsafe
  URL leak is established, use the verified rollback
  `504d3c2d` and revalidate.

## 2026-10-31 P0 continuation: repeated metadata invalidation and pinned legacy Workflow

### Root cause and evidence

- `runNativeSearchProjectionSync` scans **all** records in
  `search_metadata_repairs_v1` on each full synchronization. The old
  `syncSearchProjectionForArticle` always called
  `invalidateSearchMetadata` when the record was already `verified`,
  without first checking the immutable P3 input or actual Search
  document/FTS. This bumped `revision` and changed metadata to
  `pending` during every repeat visit, temporarily withholding otherwise
  approved public URLs from sitemap. Publication, translation, crawler
  and scheduled search workflows can all start a full synchronization.
- Read-only production Core D1 at **2026-10-31T10:51:00Z**:
  856 verified metadata rows, average revision **205.7**,
  maximum **439**; **603** managed records had an `updated_at`
  within the prior ten minutes. At **10:58:45Z** another query found
  **256** search metadata attempts within five minutes. This is
  production evidence of ongoing repeated work, not merely a sitemap
  formatting issue.
- Production Workflow API revealed a single old-running instance:
  `m8-publication-drain-2026-10-31T09-50-00-000Z` with
  **Workflow version `0dc82093-d826-4d69-829a-4bd95a42e131`**,
  deployed 2026-10-26, despite the new Workflow version
  `f3a1bd6b-044b-4c0f-9a13-9f57dfcca7fe` being deployed at
  2026-10-31T10:56:02Z. Its publication step had already finished
  `degraded`: selected 1, published **0**, failed 1
  (`publication_d1.transition:ineligible`). Its
  `native-search-projection-sync-after-publication` step timed out
  after 25 minutes **twice** (10:16:00 and 10:41:30Z) and had been
  continuously executing its third attempt since 10:42:30Z.
  This old, pinned instance explains why invalidation continued after
  the new Worker was deployed.

### Implemented no-op guard and safety

- Added `verifiedLegacyMetadataProjectionMatches` to
  `lib/cloudflare/search-projection/d1-sync.ts`. A previously
  verified legacy record is reused **only** when its revision and
  applied revision match, the current Core approved publication and
  tags generate exactly the same desired Search document/FTS, the
  stored Search metadata guard has the matching revision/fence,
  tombstone and fingerprints, actual Search/FTS rows match their
  fingerprints and cardinality, and a **second Core read** confirms
  that the revision, fence and verified status did not change during
  those checks.
- A private review, pending metadata, changed publication, stale
  guard, corrupt FTS, or missing Search record still uses the
  existing durable invalidation/repair path. A genuinely pending
  Core invalidation is **not** overwritten. Current E2E generations
  use the independently guarded generation verification path without
  forcing a new legacy metadata revision.
- SQLite integration tests prove repeated per-article and full scans
  no longer increase `revision`, fencing token or attempt count;
  actual FTS corruption and tag additions **still** perform repairs;
  publication/private/E2E safety tests retain their original contracts.
- Tests PASS: M5 **50/50**, M3, M8, ingest stages,
  D1 Search projection, sitemap probe unit tests, TypeScript
  for both main and ingest Workers, scoped ESLint,
  five-stage Vinext build and both Wrangler dry-runs.
  An **unrelated date-sensitive discovery test** originally failed
  after Oct 25 because a fixed Oct 11 article was compared against
  the wall clock with a 14-day range; the test fixture now uses
  fixed Oct 20, and M5 50/50 passes.
- `m8:types:check` independently reported an existing generated
  `worker-configuration.d.ts` drift and Wrangler on Windows exited
  with `3221226505`. No new Worker binding/configuration was
  introduced; the actual `m8:typecheck` and `m8:dry-run`
  passed. Regenerating unrelated runtime type baselines was
  intentionally deferred.
- Code/tests commit:
  **`11ed99166e6092932e37431ca5f0c25570531fdf`**.

### Production rollout and stale instance termination

- **`worldcons-ingest`** deployed as
  **`9fbb786a-2cff-4832-87db-ed92180cb2c1`**
  at **2026-10-31T10:55:56Z**; traffic **100%**,
  cron/queue/workflow/D1/service bindings retained. Previous
  rollback version: `07963eae-7e27-465e-9182-69253dfefa4b`.
- **`worldcons`** deployed as
  **`00792e11-e0b5-4032-87a5-5f28c41f4f62`**;
  previous rollback version
  `10c2407e-d742-4236-9749-1c9a9c56e23d`.
  Live home, tag hub, tag pages 1/2/6/7/8, original
  tag API and robots/sitemap returned HTTP 200.
  Page 9 retained HTTP 404.
- The previously pinned Workflow continued to mutate metadata
  after both deployments; sitemap probe still failed parity.
  The exact old instance was checked read-only against its
  old version and `publication-drain` payload, then terminated
  using Cloudflare's Workflow instance status API with
  `{status:'terminate', rollback:false}`, **without** deleting
  or restarting any other instance and without reverting
  completed publication data.
  Termination confirmed **`terminated` at
  2026-10-31T11:00:29.465Z**. Immediately afterward the
  Workflow API returned **no running or queued instances**.
- The first two production `pnpm seo:sitemap:probe` calls
  **after termination both PASSED** their two-fetch URL/lastmod
  parity check. Each response had HTTP 200, **3,621 total
  unique URLs / 2,296 article URLs, 0 duplicates, 3,547 lastmods**,
  canonical-safe XML and the same SHA-256
  `185f8b6a8b7c7be28919cfd5662c9b607d84a21465e276c08b58c3657154ace2`.
  Samples showed sitemap TTFB ~5–6 seconds.
- At **2026-10-31T11:01:37Z**, read-only Core D1 found
  **0 new metadata repair attempts since termination**.
  One `leased` metadata record from the old in-flight
  operation remained with lease expiry
  `2026-10-31T11:02:27.706Z`; let the existing
  durable repair scheduler recover it rather than altering
  production D1 manually.

### Remaining verification

Recheck the last leased metadata row after lease expiry and the
next newly-created `worldcons-async-v1` search-sync instance,
confirming it runs the new Workflow version and has zero
unnecessary repeat revisions. A brief run of successful sitemap
probes cannot prove that Googlebot has re-crawled or indexed pages.
GSC write scope remains unavailable; no new OAuth connection,
GSC resubmission, PR, browser or GitHub push was performed.

### Lease convergence and stable post-recovery sitemap (final check)

- Exactly one leftover Core metadata record,
  `de-bverfg-dejure-2024-04-07-2bvr105722`, was
  `leased` with `revision=289, applied_revision=288` and
  `lease_until=2026-10-31T11:02:27.706Z` following
  termination of the old full-scan Workflow. Do not
  forcibly mark this record verified or replay it manually.
- The new one-minute `worldcons-ingest` scheduled metadata
  drain recovered it autonomously at
  **2026-10-31T11:03:23.863Z**. Observability emitted
  `search_metadata_drain` with
  `ready:true, processed:1, failed:0, pendingCount:0,
  deadLetterCount:0`. Read-only Core D1 confirmed
  **856/856 records verified**, the leftover record's
  `applied_revision=289`, and exactly **one** repair
  attempt after the termination timestamp (the legitimate
  expired-lease recovery).
- Two more independent production `pnpm seo:sitemap:probe`
  runs, each making two serial requests **after the
  lease recovery**, returned HTTP 200 with exactly
  **3,622 total URLs, 2,297 article URLs, 3,548 lastmods,
  0 duplicates**, and the identical normalized
  URL+lastmod SHA-256
  `143bc17367c0ad79df7bf05775822f55f1fe7e3a257fed221bce9254177cc15d`
  across all four responses. All canonical/origin/HTTPS
  checks passed. TTFB in these samples was
  **2.27/1.70/2.22/1.82 seconds** (not P95).
- The one extra article URL versus the earlier 3,621
  count is consistent with the one previously leased
  published article becoming verified; this is
  approved recovery, not a renewed URL-flapping incident.
- **Implementation, deployment, old-Workflow termination,
  automated repair convergence and repeated sitemap
  stability checks are complete for this P0 defect**.
  Long-term stability and the next real new-version
  full-sync Workflow should still be monitored. Search
  Console last-download/indexing state has not been
  proven to change; the separate Google indexing P0
  remains open.

## 2026-10-31 late follow-up: avoid unnecessary M8 full Search sync steps

### Read-only post-release verification

- Cloudflare Workflows showed the new `worldcons-async-v1`
  version `f3a1bd6b-044b-4c0f-9a13-9f57dfcca7fe`
  completed both the scheduled admin-job drain and watchdog
  at 2026-10-31T11:00Z. These **do not** prove the full
  Search sync has completed; retain the explicit full-sync
  verification milestone separately.
- The Core D1 metadata cohort remained **856/856 verified**,
  max revision **439**, last update at
  `2026-10-31T11:03:23.863Z`; no new unnecessary metadata
  invalidations were observed in the inspected window.
- Read-only GSC using the existing authorized connection:
  homepage is `Submitted and indexed`, last Google crawl
  2026-10-01T05:47:35Z. The sampled
  `/tags/bverfgg`, a French article, and `/list?page=2`
  remained `URL is unknown to Google`. Sitemap
  `lastDownloaded=2026-10-19T23:08:57.582Z`; submitted
  2,839 / indexed 0 refers **only to the sitemap metadata
  row**, not to site-wide coverage. Search Analytics
  October 20–29 returned zero impressions/clicks.
  **No GSC write or OAuth refresh** was performed.

### Defect: full scans ran even after an upstream no-op

- `WorldconsAsyncWorkflow` always invoked the full
  `native-search-projection-sync-after-publication` step
  after `publication-drain`, even with
  `publication.publishedCount=0`. The previous real
  long-running Workflow had published **zero** and
  nonetheless spent two 25-minute timeouts and a third
  attempt on that scan.
- The `crawler-daily` branch likewise always ran a
  full Search scan even with no article changes.
  Importantly, the production M8 ownership split
  excludes FR/ES/DE but **retains US Supreme Court**
  (`us-scotus`). Checking only
  `sourcePolicy.effective.length` was therefore too
  weak: one US source can return zero changes.
- Added pure `lib/cloudflare/async-pipeline/search-sync-gate.ts`.
  Publication follow-up scan runs only with
  `publishedCount > 0`; invalid negative/noninteger
  counts fail closed. Crawler follow-up scan is based
  on the **actual persisted source results**, and runs
  for any insertion, refresh, or provenance attachment.
  Zero-change results skip the scan; missing/invalid
  counters run it conservatively. The explicit standalone
  `search-projection-sync` job remains a full
  reconciliation path regardless of prior changes.
- The `native-crawler.ts` completed-run replay response
  now preserves `provenanceAttachedCount`, matching
  the first-run output and preventing a hidden change
  from being masked during idempotent replay.
- Validation PASS: M8 **51/51**, M5 **50/50**,
  native crawler **37/37**, M8 TypeScript, scoped ESLint
  zero warnings and Wrangler dry-run. Live sitemap
  probe matched **3,622 URLs / 2,297 articles**,
  exact hash `143bc17367c0ad79df7bf05775822f55f1fe7e3a257fed221bce9254177cc15d`.
- Initial commit `2faeb6cbd5403a6ca8caa99c9782a4ce2083550c`;
  corrective commit `b2589dcfab79b34c069e5e4c35151b68cb525e88`.

### Deployment, controlled canary and results

- The intermediate `worldcons-ingest` release
  `df0b611c-9eb3-4c9f-8525-4d57aa4cc1b3`
  checked only effective source count. In an
  operator-created canary, the real
  `us-scotus` crawler completed with
  discovered/inserted/refreshed **0/0/0** but still
  started a full Search sync; that specific
  diagnostic Workflow was **terminated promptly**,
  without rollback and with no new case records.
  A preceding malformed diagnostic Workflow was
  rejected at payload validation and had no steps.
- Deployed the correction as Worker
  **`677ad87e-6828-484c-9cdf-94a54da16653`**,
  100% traffic. The corresponding new Workflows
  version is
  **`e9502b6a-a5f2-4910-9712-d979ca56dca9`**.
- A fresh `crawler-daily` canary
  `p0-crawler-replay-fixed-gate-20261031` was
  created **on precisely that new Workflow version**,
  using the original zero-change `us-scotus`
  idempotency key. It reused the completed ingestion
  run (no network refetch or article writes), completed
  **successfully** with exactly one crawler step,
  and returned **`searchProjection:null`** — the
  expensive full Search scan was correctly skipped.
- Independent Cloudflare read-back confirmed 100%
  deployment of `677ad87e`, 856/856 approved
  Core metadata records with unchanged last-update
  timestamp, and another two-request sitemap
  parity PASS with 3,622 URLs and the exact same
  URL/lastmod hash. No web Worker redeploy, D1 manual
  mutation, browser, PR, GitHub push, or GSC write.

### Remaining independent work

The next *actual* non-noop full
`search-projection-sync` Workflow has not yet
completed under the new guard; do not report
end-to-end full-scan timing or resource efficiency
as validated. GSC re-download of the new sitemap
and representative non-home URL indexing remain
unconfirmed. A future optimization should make
the full scan bounded/checkpointable if it still
approaches the 25-minute step timeout.

## 2026-10-31 22:00 KST continuation: checkpointed full Search synchronization

### Production baseline and GSC read-only check

- At `2026-10-31T12:59:56Z`, latest `worldcons-ingest`
  Worker `677ad87e-6828-484c-9cdf-94a54da16653`
  served 100% traffic. The current Workflow version
  `e9502b6a-a5f2-4910-9712-d979ca56dca9`
  had completed periodic watchdog and admin-job drains;
  no new-version **full** search-projection-sync had
  completed yet.
- Core D1: 2,430 articles; 2,298 P3 `published`
  records, 856 metadata-managed identities, 67 E2E
  managed heads; all 856 metadata rows `verified`,
  maximum approval revision 439, unchanged
  `updated_at` since `2026-10-31T11:03:23.863Z`.
  Search D1: exactly 2,297 `search_documents` and
  2,297 `search_fts` rows. The one-record difference
  between generic P3 `published` and Search records
  must not be classified as missing without checking
  the stricter eligible-publication predicate.
- Existing GSC connection `link_6ae531dfe2f081918a6113d4c791985e`
  reported sitemap `lastDownloaded=2026-10-19T23:08:57.582Z`,
  no warnings or errors, and no evidence of Google
  recrawling the fixed site. No GSC writes or OAuth
  reauthorization.

### Implemented durable Workflows checkpoint

- Added `listManagedSearchProjectionIds`,
  `syncManagedSearchProjectionBatch` and optional
  `preverifiedManagedIds` handling to
  `lib/cloudflare/search-projection/d1-sync.ts`.
  The current managed inventory is deduplicated and
  sorted; each protected Core/FTS reconciliation
  batch is **at most 12 IDs** (helper enforces a hard
  maximum 20), with a durable Workflow step name and
  its own 5-minute bounded retry window.
- Added
  `workers/async-pipeline/src/checkpointed-search-sync.ts`,
  which persists the inventory and each batch as
  independent Workflow steps. After all protected
  batches it invokes the **existing unprotected
  reconciliation and terminal counts/identity
  assertions**, without redoing verified managed
  batches. A changed/duplicate managed inventory
  fails closed rather than silently skipping it.
- Wired the explicit `search-projection-sync` kind
  and the crawler, publication, translation, watchdog
  follow-on full-scan sites to the same checkpointed
  runner. Existing no-op after-publication and
  unchanged-crawler guards are retained.
- SQLite integration verifies unchanged repeated
  batches leave Core approval revision/fencing and
  Search data intact, and that truncated, stale or
  duplicate inventories are rejected. Tests PASS:
  M3, full M5, M8 **51/51**, D1 Search projection,
  native crawler **37/37**, TypeScript, scoped
  ESLint and Wrangler dry-run. The live sitemap
  paired requests still matched 3,622 unique URLs
  / 2,297 case URLs and the previous SHA-256.
- Local implementation checkpoint:
  **`e87353bf14c0b1616b4ab8540eb51e18fbdac985`**.
  Deployed **only `worldcons-ingest`** as Worker
  **`e81e3070-a917-471e-8a3a-16b4d5648113`**,
  100% traffic; new Workflow version
  **`2f911c5d-06d5-4217-8602-a3772112e1b9`**.
  Web Worker, GSC and production D1 were not
  directly changed.

### Live guarded first-batch canary

- Created `p0-checkpointed-search-canary-20261031`
  on exactly the new Workflow version with
  a valid `search-projection-sync` payload.
  The inventory and **five** 12-ID managed batches
  completed successfully (60 total, all unchanged),
  with first-five batch times approximately
  **4.41, 3.45, 3.40, 3.40 and 3.23 seconds**.
  The canary was then **explicitly terminated**
  (`rollback:false`) to bound its diagnostic scope.
  One following in-flight step was interrupted
  by termination and must not be counted successful.
- Post-canary Core remained 856/856 `verified`,
  unchanged last-mutation timestamp; Search was
  exactly 2,297 documents and 2,297 FTS rows.

### Full live Workflow validation status

- Started an explicit `search-projection-sync`
  Workflow `p0-checkpointed-full-search-20261031`
  on new version `2f911c5d` at approximately
  `2026-10-31T13:12:11Z`.
- This is an actual full scan, not a dry run:
  monitor all protected batch results and the
  terminal unprotected reconciler. **Do not call
  it complete until the final Workflow result
  is `complete`, `verified=true`, and the Search
  document/FTS parity and unchanged Core revision
  have been confirmed.**

### Full operational completion and post-run verification

- **Verified complete.** Workflow
  `p0-checkpointed-full-search-20261031`
  ran under version
  `2f911c5d-06d5-4217-8602-a3772112e1b9`
  from **2026-10-31T13:12:10.557Z** through
  **2026-10-31T13:17:23.778Z**, approximately
  **5 minutes 13 seconds end-to-end**.
- All **72/72** protected batches completed, reconciling
  exactly **856** managed article identities. Their
  aggregate was `added=0, changed=0, removed=0,
  unchanged=856`, with zero failed batch steps and
  no unnecessary Core metadata invalidation.
- The final `native-search-projection-sync-unmanaged-reconcile`
  step ran from **13:16:47.159Z** through
  **13:17:23.764Z**, approximately **36.6 seconds**.
  Its result was `verified:true`,
  `projected:2297`, `documentCount:2297`,
  `ftsCount:2297`, `statementCount:0`,
  `batchCount:0`, `changes:{added:0,changed:0,
  removed:0,unchanged:1452}`.
  The Workflow final JSON also recorded
  `managedChecked:856` and `managedBatches:72`.
- Read-only post-run Core D1 still showed
  **856/856** metadata rows in `verified`,
  maximum revision **439**, last update
  **2026-10-31T11:03:23.863Z** (unchanged).
  Search D1 still showed **2,297 documents /
  2,297 FTS / 2,297 distinct FTS article IDs**.
  Both Workers remained on their expected versions;
  `worldcons-ingest` version
  `e81e3070-a917-471e-8a3a-16b4d5648113`
  had **100%** traffic and no running Workflow
  instance after the successful full run.
- Post-run live sitemap dual-fetch probe **PASSED**:
  HTTP 200, 3,622 URL nodes / 2,297 article URL
  nodes, zero duplicates, 3,548 lastmod tags,
  canonical-safe, SHA
  `143bc17367c0ad79df7bf05775822f55f1fe7e3a257fed221bce9254177cc15d`
  unchanged. Sample TTFB values were
  approximately **9.76 and 8.14 seconds**,
  so site performance remains worth follow-up;
  do not claim the full-sync improvement also
  improved sitemap TTFB.
- Clarified the apparent **2,298** generic P3
  `published` count versus **2,297** eligible
  Search records: the stricter
  `ELIGIBLE_PUBLISHED_PREDICATE` returns exactly
  **2,297**. The excluded 2021 German case
  `germany-de-bverfg-2021-03-24-beschluss-vom-24-marz-2021-f879e6`
  has a fresh legacy version **but** a published
  `case_catalog_publications_v1` entry.
  It is correctly excluded from the overlapping
  legacy projection, not an unexplained missing
  public article.
- Existing GSC read-only sitemap metadata remained
  `lastDownloaded=2026-10-19T23:08:57.582Z`
  after the run, errors 0/warnings 0. GSC
  submission, crawling and indexing were **not**
  triggered or claimed complete. No manual
  production D1 writes, GitHub push, PR, browser,
  OAuth refresh or GSC write was performed.

**P0 Search full-sync checkpointing: IMPLEMENTED,
TESTED, DEPLOYED AND PRODUCTION-VERIFIED.**
Outstanding independent SEO work: verify Google
actually downloads the current sitemap, investigate
non-home URL discovery/indexing, and improve
the observed 8–10 second sitemap TTFB without
changing crawlable URL membership.
