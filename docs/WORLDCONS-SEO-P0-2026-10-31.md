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
