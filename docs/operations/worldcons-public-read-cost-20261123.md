# WorldCons public read cost and edge cache (2026-11-23)

## Trigger

Cloudflare Workers requests on 2026-11-22 reached 15,554/day (usual ~6,500) and
`worldcons_core` rows read 5.10e8/day. A sustained external crawl of `/list`
(~31,721 requests/day, US/200, 450-550/hour) hit an edge-uncached, full-window
public list read. `/list` answered `cache-control: no-store, must-revalidate`
with no `cf-cache-status`, so every request re-rendered and re-read D1 for up to
~10k article rows.

## What changed

### 1. Shared edge cache for `/` and `/list`

`worker/index.ts` serves `GET /` and `GET /list` through the Cloudflare Cache API
(`caches.default`) with `lib/cloudflare/public-edge-cache.ts` and
`lib/cloudflare/public-edge-cache-runtime.ts`.

| Property | Value |
| --- | --- |
| Eligible paths | `/`, `/list` |
| Eligible methods | `GET` only |
| Cache-control | `public, s-maxage=60, stale-while-revalidate=300` |
| Cache key | origin + path + normalized query |
| Dropped key params | `pageSize`, `view`, `sort` |
| Remaining key params | sorted (`page`, `q`, `range`, `source`, `jurisdiction`, `type`, `tag`, `language`) |
| Status header | `x-worldcons-edge-cache: HIT | MISS | BYPASS` |

Never cached: requests with `authorization` or `cookie` (admin/signed-in),
RSC/prefetch (`rsc`, `next-router-prefetch`, `next-router-state-tree`,
`x-middleware-prefetch`), non-HTML `accept`, `range`, non-`200`, responses with
`set-cookie`, or non-`text/html` content.

### 2. Materialized publishability + bounded list SQL

Migrations `d1/worldcons_core/0013_public_list_publishable.sql` and
`0014_public_list_publishable_sync.sql` add
`articles.collection_publishable` (integer, default 0), backfill it once, and
keep it in sync with `source_metadata` through insert/update triggers. The
public candidate read (`lib/article-reads/d1-repository.ts`) now filters on
`a.collection_publishable = 1` instead of `json_type/json_extract` per row.

`0014` also adds:

- `articles_public_list_idx` on
  `(status, catalog_ai_stale_v4, collection_publishable, original_published_at, id)`;
- `article_publications_p3_state_article_idx` on
  `(state, article_id, version_id)`.

The fast list SQL now requests a page-sized window around the requested offset
(60-row lookbehind + 60-row lookahead) with `LIMIT ? OFFSET ?` instead of
refusing deep pages and falling back to the bounded corpus read. Deep pages up
to offset 10,000 stay page-sized; beyond that the bounded legacy read remains
the fallback.

The bounded legacy read also pushes `collection_publishable = 1` into SQL, so
an exact-count or tag/`q` path filters before `maxRows`.

### 3. Exact count policy

`lib/db/queries.ts` now owns `publicArticleListCountMode` /
`canUseJurisdictionTotal`. `/list` and `/api/home/range` default to `count:
none` and derive totals from the cheap jurisdiction counter; only a genuine
narrowing filter (`q`, `source`, `type`, `tag`, `language`, `ids`) asks for an
exact count, matching `/search`.

### 4. Per-request cost observability

`lib/cloudflare/d1/read-cost.ts` wraps the Worker `worldcons_core` binding and
sums `result.meta.rows_read`. `worker/index.ts` logs one
`public_read_cost` JSON event per request for `/`, `/list`, `/search` and adds:

- `x-worldcons-rows-read`
- `x-worldcons-rows-read-available`
- `x-worldcons-read-ms`

`tests/public-read-cost-regression.test.ts` fails if the public candidate SQL
stops using the materialized predicate/an index or if a page reads more than the
window budget.

### 5. Worker-level rate limit

`/list` is limited to 60 origin renders per client IP per minute in isolate
memory (fixed window). Over budget returns `429` with `Retry-After`. Disable with
the Worker var `WORLDCONS_PUBLIC_RATE_LIMIT_DISABLED=true`. This is the fallback
for WAF; see below.

## Invalidation

- Publication/admin mutations keep calling `invalidatePublicContentCaches`
  (`revalidateTag` + `revalidatePath`). The async pipeline's
  `WorldconsOpsService.revalidatePublicContentCache()` additionally deletes the
  base `/` and `/list` edge keys.
- Admin/private/personalized responses are never admitted to the shared cache.
- Filtered `/list?…` variants are not enumerable through the Cache API; they age
  out within the 60-second `s-maxage`. Maximum public staleness after a publish
  is therefore 60 seconds, with `stale-while-revalidate=300` only affecting
  downstream HTTP caches.

## Cost budget

| Surface | Budget |
| --- | --- |
| `/list` page 1 candidate window | `pageSize + 121` rows materialized (10 → 131) |
| `/list` rows read, p95 | ≤ 300 |
| `/list` rows read, alert | > 1,000 per request |
| `/list` origin renders per IP | ≤ 60/min |

Check a deployment with:

```powershell
curl.exe -sSI https://worldcons.cclib.workers.dev/list | Select-String "cache-control|x-worldcons"
curl.exe -sSI https://worldcons.cclib.workers.dev/list | Select-String "x-worldcons-edge-cache"
```

The second request (same normalized key, no cookies) must report
`x-worldcons-edge-cache: HIT` and a small `x-worldcons-rows-read`.

## WAF / usage alerts

Attempted on 2026-11-23 with the operator OAuth token:

- `GET /zones` (zone read) succeeded; the only zone is `soltera.dev`.
- The application hostname is `worldcons.cclib.workers.dev`, which has no
  customer-managed zone, so zone WAF Rate Limiting rules cannot target it.
- The token scope list is `zone (read)` only; it has no `zone:edit`/WAF write
  permission.

WAF rate limiting and zone usage alerts therefore require either a custom
domain on a zone the operator controls, or dashboard/API credentials with zone
write. Until then the worker-level `/list` limit is the enforced control.
Cloudflare account-level usage notifications (Workers/D1) must be configured in
the dashboard or with an account-scoped token.

## Rollback

1. **Worker code:** redeploy the previous `worldcons` version
   (`wrangler versions list --name worldcons`, then
   `wrangler rollback --name worldcons --version <previous>` or redeploy the
   previous commit). Old code ignores the additive column and triggers.
2. **Rate limit only:** set `WORLDCONS_PUBLIC_RATE_LIMIT_DISABLED=true` and
   redeploy, or `wrangler secret`/var update per the deployment procedure.
3. **Edge cache:** entries expire in 60 seconds. To force the base keys, call the
   authenticated public-content revalidate route or the
   `revalidatePublicContentCache` RPC; filtered variants still expire on their
   own.
4. **D1 migration:** additive only. Do **not** drop
   `articles.collection_publishable`, its triggers or indexes during a code
   rollback; the previous code does not read them and dropping them requires a
   table rebuild. Only a reviewed forward migration may remove them.

## 2026-11-24 live incident mitigation

The `/list` surface received roughly 100k crawler requests on 2026-11-23 (about
one third each `200`, `204` and `504`) while only 14 edge-cache hits were
recorded: cache-busting query strings and prefetch requests bypassed the cache.

- **Cache key allowlist.** `edgeCacheKeyUrl` now drops every query parameter that
  is not a real `/list` filter (`page`, `range`, `source`, `jurisdiction`,
  `type`, `language`, `tag`, `q`) and every parameter on `/`. A crawler rotating
  `cb`/`utm_*` values therefore shares one entry. Verified live: two different
  `cb` values on `?page=49` produced `MISS` (20,344 rows) then `HIT` (0 rows,
  `cf-cache-status=HIT`).
- **Rate limit scope.** Per-client fixed windows are now enforced for `GET` and
  `HEAD` on `/`, `/list` and `/search` (60/min for `/list`, 120/min otherwise)
  plus a per-isolate global budget (1,200/min `/list`, 2,400/min otherwise).
  Verified live: 65 rapid `/list` requests produced 60×`200` then 5×`429`.
- **Residual.** A `workers.dev` hostname has no customer zone, so WAF rate
  limiting and Cache Rules cannot be attached; this Worker-level guard and the
  Cache API are the available controls until the site moves to a zone with WAF.
  RSC/prefetch (`204`) traffic still calls origin and is only bounded by the
  per-client limit.

## Verification evidence

- `pnpm test:public-cost` (8/8): materialized predicate, index-backed plan,
  bounded first/deep page window, legacy SQL predicate, `meta.rows_read`
  accounting, cache key normalization, HIT/MISS, rate-limit budget.
- `pnpm test:article-reads`, `test:article-read-shadow`, `test:d1-case-catalog`,
  `test:d1-shadow-all`, `test:d1-schema`, `test:d1-migrate`,
  `test:d1-apply-schema`, `test:public-regression`: pass.
- `pnpm typecheck`, `pnpm lint` (0 errors), `pnpm build:vinext`, and
  `wrangler deploy --dry-run` pass.
- `pnpm check` still fails on the pre-existing
  `app/admin/page.tsx`/`AdminOperationsOverview` assertion already present on
  `origin/main`; it is unrelated to this change.
