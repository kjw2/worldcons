# WorldCons SEO P0 — Technical Closeout (2026-11-01 KST)

**Disposition: P0 engineering remediation COMPLETE.**

This status closes the controllable P0 source, indexing-surface and
operations defects. **It does not claim that Google has re-crawled or
indexed the public article URLs.** External Google discovery remains
an independently tracked follow-up, not a hidden success criterion.

## Scope / acceptance

| Acceptance item | Result | Evidence |
| --- | --- | --- |
| Partial sitemap generation cannot silently return HTTP 200 | COMPLETE | `resilientSitemapRead` fails closed; public SEO regression coverage |
| P3 approval, metadata/E2E protection and withdrawals honored | COMPLETE | Guarded Core/FTS reads, Workerd parity, M3/M5 regressions |
| Sitemap URLs and `lastmod` stable across adjacent fetches | COMPLETE | 2026-11-01 production probe: two matching normalized hashes, no duplicates |
| Crawlable tag and article HTML | COMPLETE | HTTP 200, self-canonical, server-rendered links, no robots denial |
| Oversized tag detail and tag hub page problem | COMPLETE | Ten articles per tag page with bounded, stable pagination; smaller response size |
| Excessive sitemap cold-path latency | COMPLETE at measured acceptance | Fast-sitemap D1 query enabled in production; 2026-11-01 ~2.61–3.11 s two-fetch TTFB (not a P95 guarantee) |
| Search/FTS repeated metadata invalidation | COMPLETE | No-op guard, durable leases, automatic recovery, revision stability |
| Long full-search sync Workflow timeouts | COMPLETE | 856 managed identities in 72 durable steps; terminal reconciliation `verified:true`, 2,297/2,297, 5m13s |
| Google sitemap re-download / new article indexing | **EXTERNAL PENDING** | GSC last download October 19; samples unknown to Google; not source-code acceptance |

## Final read-only production snapshot (2026-11-01 ~20:08 KST)

- Main `worldcons` Worker version
  `dd8e1a6b-0ae7-4095-b5f5-0b3bf9e3363c`,
  **100% traffic**, with the verified fast sitemap path.
- `pnpm seo:sitemap:probe`: HTTP **200** twice,
  **3,667 total / 2,327 article URLs / 3,593 lastmods**,
  no duplicate, unsafe, cross-origin, non-HTTPS, fragment
  or query URLs. Both requests have the exact same normalized
  URL/lastmod SHA-256
  `34a3f365ed6b541dab826e9c5be732f70c1e8a0fc788140f516e5b424736ddfc`.
  TTFB **3,105 / 2,613 milliseconds**; content 779,126 bytes.
- Core D1 `search_metadata_repairs_v1`:
  **886 records, all `verified`**; Search D1
  **2,327 documents, 2,327 FTS rows and 2,327 distinct
  FTS article IDs**. A second post-deployment read confirmed
  the same counts and all 886 metadata rows still verified.
  These counts increased naturally since the preceding snapshot
  as new approved records were collected.
- `robots.txt` advertises the correct sitemap. The live
  homepage, `/tags`, `/tags/bverfgg`, `/list` and sampled
  article served 200; representative detail was
  `index, follow` with its exact self canonical. The home
  and tag pages contain server-rendered discovery links.
- The existing verified production Workflows full search
  `p0-checkpointed-full-search-20261031` completed with
  `verified:true` in ~5m13s (see the 2026-10-31 record).

## Google Search Console — explicit external blocker

- Property `https://worldcons.cclib.workers.dev/` reported
  `permissionLevel=siteOwner` on the connected GSC account.
- The submitted sitemap is already present, with no errors or
  warnings, but GSC still reported
  `lastDownloaded=2026-10-19T23:08:57.582Z`.
  The homepage is indexed; representative article and tag/list
  URLs remain `URL is unknown to Google`.
- **Attempted the exact existing sitemap submission on 2026-11-01**:
  `https://worldcons.cclib.workers.dev/sitemap.xml`.
  The connector rejected the request with **HTTP 403,
  `insufficient_scope`**, reporting that writes require both
  `gsc:read` and `gsc:write`. This is an OAuth scope gap
  **despite the site's `siteOwner` permission**, not an XML
  validation failure. **No successful submission is claimed.**
- The connector needs `gsc:write` granted by an authorized user
  before the same sitemap can be resubmitted through ChatGPT.
  Google's crawler scheduling and indexing decisions remain
  outside the repository's control. Monitor a new sitemap
  `lastDownloaded` time and representative URL Inspection
  outcomes as a separate external-follow-up item.
- Do not alter approval policy, remove metadata guards,
  serve unapproved articles, or bypass robots/canonical
  contracts merely to affect Google discovery.

## Delivery notes

- Final combined gates: public SEO regression, sitemap probe
  unit suite **11/11**, M5 **52/52**, M8 **51/51**,
  scoped ESLint, main-project `tsc --noEmit`,
  `m8:typecheck` and Wrangler `m8:dry-run` all passed.
- The final audit caught a cross-target TypeScript build
  issue: the portable checkpointed sync runner and its test
  directly imported the Worker-only `cloudflare:workers`
  type. The runner now accepts a minimal typed checkpoint
  adapter, implemented using actual `WorkflowStep.do`
  only inside the Worker entrypoint. Inventory,
  12-record managed steps and 25-minute terminal
  reconciliation retain the **same retry/timeout settings**
  and semantics. Code commit:
  `fa1c6dcd3a7d1c6c8806b415cbb3601b296a921d`.
- Deployed **only** `worldcons-ingest` as
  `9d4352de-3dac-42b1-b188-36f458f13070`,
  **100% production traffic**, Workflows version
  `884fadef-0fb6-4974-b03b-26c5ddaeac02`.
  A newly created, explicitly version-pinned full-sync
  diagnostic instance
  `p0-closeout-checkpoint-canary-20261101`
  completed **five managed batches / 60 articles**
  with `added=changed=removed=0` and
  `unchanged=60`; it was then intentionally terminated
  with `rollback:false`. No failed publication,
  invalidation or content mutation was observed.
- After the canary, another live sitemap two-fetch
  comparison passed with identical 3,667 URLs,
  2,327 case URLs, no duplicates and the same
  normalized URL/lastmod hash. Sample TTFB:
  **3,537 / 2,837 milliseconds**.
- Historical implementation and evidence:
  [Oct 29/30 source and SEO integrity](WORLDCONS-SEO-P0-2026-10-29.md);
  [Oct 31/Nov 1 production rollout and Workflows](WORLDCONS-SEO-P0-2026-10-31.md).
- No additional main **web** Worker deployment or data
  migration was necessary. The one final async-Worker
  type-boundary update described above was deployed and
  rechecked in production.
- Fast sitemap is currently set as an operational
  `secret_text` binding; tracked `wrangler.jsonc`
  contains a future plain-text `WORLDCONS_FAST_SITEMAP_ENABLED=true`
  setting. Check the type migration on the next **separately
  authorized** deploy. The working tree was clean when closure
  verification began.
- Keep Google discovery / Search Console recrawl under a
  separate external-monitoring item; **do not reopen the
  already accepted code-level P0 without a new regression**.
- No browser, GSC OAuth change, manual D1 modification, GitHub
  push or PR was performed by the closeout.
