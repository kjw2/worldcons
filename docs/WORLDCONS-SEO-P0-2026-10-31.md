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
