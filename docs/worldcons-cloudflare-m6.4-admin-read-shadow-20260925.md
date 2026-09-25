# WorldCons Cloudflare M6.4 - privileged admin ops + analytics D1 shadow

Status: **implemented, default OFF, never authoritative**.
Supabase remains the sole production read authority. No deploy, DNS change,
remote mutation, D1 write, authority switch, or search/Vectorize projection work
is part of M6.4. Search/FTS5/Vectorize remains **M7** and is untouched. M6.4 does
**not** claim `GO-D1-READ`, and **both admin RPC snapshots remain deferred** to a
later migration/cutover design.

Related: `docs/worldcons-cloudflare-m6.1-reference-read-shadow-20260925.md`,
`docs/worldcons-cloudflare-m6.2-reference-read-shadow-20260925.md`,
`docs/worldcons-cloudflare-m6.3-article-read-shadow-20260925.md` and the
full-migration plan M6 section.

## 1. Scope

M6.1/M6.2 shadowed the seven `ReferenceReadRepository` methods and M6.3 the six
`lib/article-reads` methods. M6.4 extends the same default-off, read-only,
background shadow to the two **privileged** admin seams:

- `AdminOpsReadRepository` (`lib/admin/ops-read-repository`)
  - `loadDashboardSnapshot()`
  - `loadArticleRows()`
  - `loadCandidateRows()`
  - `countTableRows(table, fallback)`
  - `listAdminArticles(filters)`
- `AdminAnalyticsReadRepository` (`lib/admin/analytics-read-repository`)
  - `loadAdminAuditActionOptionRows(eventTypes)`
  - `loadAdminAuditEntryRows(request)`
  - `loadSiteEvents(since)`
  - `loadIngestionRunRows(since)`
  - `loadArticleSummaryRows()`
  - `loadAnalyticsHealthSnapshot(days)`

Every caller still receives the exact authoritative Supabase result unchanged
(returned by identity before any background work). Nothing is written to D1 or
Supabase. These reads are privileged (they expose unpublished/private state and
administrative audit data) and remain deliberately separate from the public
`ArticleReadRepository` / `ReferenceReadRepository`.

## 2. Architecture (M6.4 deltas)

| concern | module | M6.4 change |
| --- | --- | --- |
| shadow config | `lib/cloudflare/d1/shadow/config.ts` | new `admin_ops_read` / `admin_analytics_read` surface constants (still opt-in) |
| D1 ops reader | `lib/admin/ops-read-repository/d1-read-repository.ts` | `loadArticleRows`/`loadCandidateRows`/`countTableRows`/`listAdminArticles` over the exact per-table database |
| ops orchestration | `lib/admin/ops-read-repository/shadow.ts` | per-method gating, RPC/search skips, contract selection, zero D1 calls for the snapshot |
| ops selection point | `lib/admin/ops-read-repository/index.ts` | wraps the Supabase adapter only; mock/no-config path unchanged |
| D1 analytics reader | `lib/admin/analytics-read-repository/d1-read-repository.ts` | five audit/site-event/ingestion/article methods over the exact per-table database |
| analytics orchestration | `lib/admin/analytics-read-repository/shadow.ts` | per-method gating, RPC skip, contract selection, zero D1 calls for the snapshot |
| analytics selection point | `lib/admin/analytics-read-repository/index.ts` | wraps the Supabase adapter only; fail-closed/no-config path unchanged |
| runtime read runner | `lib/cloudflare/d1/runtime-read.ts` | unchanged (M6.1-M6.3 `eq`/`gte`/`neq`/`in` cover every new shape) |
| observability | `lib/cloudflare/d1/shadow/events.ts` | unchanged (row-content-free) |
| Worker wiring / flags | `worker/index.ts`, `wrangler.jsonc` | surfaces list now includes the two new opt-in surfaces |

### 2.1 Authoritative selection (unchanged)

`adminOpsReads()` still returns the mock adapter without Supabase config and the
Supabase adapter when configured; `adminAnalyticsReads()` still returns the
fail-closed adapter without config and the Supabase adapter when configured. The
no-config mock/fail-closed adapters are returned **unwrapped**, exactly as
before. When Supabase is authoritative the adapter is wrapped with
`withAdminOpsReadShadow(...)` / `withAdminAnalyticsReadShadow(...)`, which
**awaits the authoritative result, returns it immediately (same object
identity)**, and only afterwards may schedule a background shadow task.

`isConfigured()` stays direct authoritative/synchronous behavior: it delegates to
the authoritative adapter and adds no asynchronous D1 work and no event.

### 2.2 Gates (all required before a shadow is scheduled)

1. `WORLDCONS_D1_SHADOW_READ_ENABLED` is on;
2. the relevant surface is allowed (`admin_ops_read` / `admin_analytics_read`);
3. the method is not skipped (RPC / search-deferred / unsupported ambiguous shape);
4. the exact per-method database binding exists;
5. a background scheduler is registered (Worker `ctx.waitUntil`);
6. the deterministic sample accepts;
7. the per-isolate in-flight bound has room.

A missing binding skips with `no_binding` and **zero** D1 calls. No scheduler
means skip, never a synchronous await. Backpressure/sampling/scheduler rejection
skip before any D1 call. Errors, timeouts and truncation are swallowed into
events and never alter the authoritative result.

## 3. Exact database bindings (never substituted)

| method | database | table(s) |
| --- | --- | --- |
| `loadArticleRows` | `worldcons_core` | `articles` |
| `loadCandidateRows` | `worldcons_ingest` | `source_url_candidates` |
| `countTableRows("tags")` | `worldcons_core` | `tags` |
| `countTableRows("source_url_candidates")` | `worldcons_ingest` | `source_url_candidates` |
| `listAdminArticles` | `worldcons_core` | `articles` |
| `loadAdminAuditActionOptionRows` | `worldcons_ops` | `site_events` |
| `loadAdminAuditEntryRows` | `worldcons_ops` | `site_events` |
| `loadSiteEvents` | `worldcons_ops` | `site_events` |
| `loadIngestionRunRows` | `worldcons_ingest` | `ingestion_runs` |
| `loadArticleSummaryRows` | `worldcons_core` | `articles` |

Core is never substituted for ingest/ops. The wrapper resolves the binding
*before* scheduling: if the required database binding is missing, the method
skips with `no_binding` and makes zero D1 calls.

## 4. Authority / safety skips

### 4.1 RPC snapshots (deferred)

`rpc_admin_dashboard_snapshot` and `rpc_admin_analytics_health_snapshot` have
**no exact migrated D1 equivalent**. M6.4 does **not** reimplement or approximate
them in JS. The wrapper returns the authoritative RPC result unchanged and emits
an explicit `rpc_deferred` skip with **zero** D1 calls. Both snapshots remain
deferred to a later migration/cutover design.

### 4.2 Search / full text (M7)

Any `listAdminArticles({ q })` path is M7. The wrapper emits a structured skip
with reason `search_deferred_m7` and makes **zero** D1 calls. The D1 adapter
rejects a `q` shape defensively as well.

### 4.3 Unsupported / ambiguous / unbounded shapes

- Any bounded read that observes more than `maxRows` rows raises the typed
  `D1ShadowTruncatedError`; the wrapper emits `shadow_truncated`. Never a partial
  comparison.
- `loadAdminAuditActionOptionRows` / `loadAdminAuditEntryRows(filtered)` require
  the authoritative 1000-row window; if `maxRows < 1000` the method skips with
  `limit_exceeds_max_rows` before any D1 call.
- `loadAdminAuditEntryRows(filtered:false)` requires the exact-count range to fit
  `maxRows`; otherwise `range_exceeds_max_rows`. The range slice and exact count
  are compared as a `{status:"ok",rows,count}` object.
- `loadSiteEvents` and `loadIngestionRunRows` require `maxRows >= 10_000` and
  `>= 1000` respectively; otherwise `limit_exceeds_max_rows`.
- Invalid/empty `eventTypes` skip with `invalid_event_types` rather than inventing
  behavior.

## 5. Per-method semantics

### 5.1 `loadArticleRows`

Exact selected fields of the authoritative `ARTICLE_ROW_SELECT`. The
authoritative read has **no explicit order** and pages every row, so the shadow
uses the deterministic authored primary-key order (`id asc`) at `maxRows + 1`,
and the comparison is **unordered** with stable key `id`. Overflow skips; the
authoritative result array is returned by identity.

### 5.2 `loadCandidateRows`

Exact selected fields of `worldcons_ingest.source_url_candidates`, deterministic
`id asc` at `maxRows + 1`, **unordered** comparison keyed by `source_key` (with
duplicate rows preserved). The authoritative error fallback `[]` is preserved
because the primary is always returned unchanged. Overflow skips.

### 5.3 `countTableRows`

Exact bounded count by selecting only the authored primary-key column(s) at
`maxRows + 1`. The count is compared only when exact; overflow skips
(`shadow_truncated`). `tags` uses core and `source_url_candidates` uses ingest.
Primary fallback semantics are unchanged.

### 5.4 `listAdminArticles`

`q` is M7 (`search_deferred_m7`). For non-`q` shapes the wrapper preserves the
bounded page/pageSize (page floor/default 1, pageSize cap 50/default 25), the
filters `status`/`sourceKey`/`jurisdiction`/`publishable` yes|no/`hasSummary`
yes|no, ordering `original_published_at DESC NULLS LAST, updated_at DESC NULLS
LAST, id ASC`, and the exact `total`/`hasMore`/`totalIsExact`
(`totalIsExact:true`) plus the selected output fields. It is privileged: no
public publishability status filter is applied, so unpublished/private rows are
included. The D1 adapter bounded-scans `maxRows + 1`, applies the JSON/null
filters in JS, then orders/pages/counts; if the full filtered candidate set
cannot be proven within `maxRows` it skips rather than approximate.

The `publishable` filter reproduces the PostgREST projected-JSON text
comparison (`source_metadata->collection->>publishable`): `yes` matches only the
text `true` (JSON `true` or the string `"true"`), `no` matches a missing key or
any other text. This is the authoritative adapter's filter expression, which is
broader than the strict `=== true` used by the dashboard legacy counting helper.

### 5.5 `loadAdminAuditActionOptionRows`

`worldcons_ops.site_events`, `event_type in (...)` (bound `in`), `occurred_at
desc`, limit 1000, exact selected columns. Requires `maxRows >= 1000`; an
overflow past 1000 skips.

### 5.6 `loadAdminAuditEntryRows`

`worldcons_ops.site_events`, exact selected columns, `event_type in (...)`,
`occurred_at desc`. `filtered:true` takes the latest 1000 with `count:null`;
`filtered:false` slices the exact range `from..to` and reports the exact count.
The full `{status:"ok",rows,count}` result is compared. D1 errors do not alter
the primary.

### 5.7 `loadSiteEvents`

`worldcons_ops.site_events`, access-info field set, `occurred_at >= since`,
`occurred_at desc`, max 10,000. The authoritative result carries `schemaReady`.
The migrated D1 `site_events` schema supports every access-info column
(`client_ip_hash`, `accept_language`, `client_country`, `is_bot`), so a
successful D1 read is always `schemaReady:true`; the full `{rows,schemaReady}`
object is compared. Over the M6.4 default `maxRows` (2000 < 10000) this method
always skips — it can only be compared once an operator raises `maxRows` to at
least 10,000. `maxRows` bounds always win.

### 5.8 `loadIngestionRunRows`

`worldcons_ingest.ingestion_runs`, selected fields, `started_at >= since`,
`started_at desc`, limit 1000; bounded exact comparison, unordered by
`source_key`. Requires `maxRows >= 1000`.

### 5.9 `loadArticleSummaryRows`

`worldcons_core.articles` selected fields. Supabase pages without a cap and
preserves partial rows on a later error; the D1 shadow only compares when the
entire D1 set is proven within `maxRows` and **does not emulate** Supabase
partial-row-on-error semantics. Overflow skips.

## 6. Runtime-safe reads

M6.4 reuses the existing runtime-safe D1 read runner unchanged: authored
identifiers guarded by `^[a-z_][a-z0-9_]*$`, every value bound (including every
`in` element), fail-closed response validation, and only `prepare().bind(...).all()`
(read-only). No Node builtin, no remote operator and no `process.env` is imported.
Nothing beyond M6.1-M6.3 was needed, so the runner is untouched.

## 7. Comparison semantics

- `loadArticleRows`/`loadCandidateRows` use `kind:"array"` with `unordered:true`
  and stable keys `id`/`source_key`, because the authoritative SQL order is not
  contractually defined; duplicate rows are preserved (never collapsed into a
  set).
- `loadIngestionRunRows` is unordered by `source_key`.
- `loadArticleSummaryRows` is an uncapped array compared as an unordered set.
- `countTableRows` / `loadAdminAuditEntryRows` / `loadSiteEvents` are `kind:"object"`
  comparisons of the exact authoritative result shape.
- `loadAdminAuditActionOptionRows` is an ordered array by `id`.
- Each side is hashed over its canonical form with the pure-JS `shadowDigest`; the
  first bounded diff path is captured on mismatch; `orderMatches` is informational
  only.

## 8. Observability

One `worldcons.d1_shadow` JSON event per shadow decision through the injectable
sink (default `console.log`), unchanged in shape:

```
{ event, surface, method, outcome, reason, errorCode, db, tables,
  primaryCount, shadowCount, primaryHash, shadowHash, diffPath,
  orderMatches, compared, readOutcome, latencyMs }
```

`surface` is `admin_ops_read` or `admin_analytics_read`; `db` is the exact
per-method database. Events contain only method/surface/db/tables/count/hash/
diffPath/orderMatches/latency/skip/error codes. **No** private article fields,
metadata, audit path/query, IP hash, UA, source text, secret or row content is
ever emitted. New reasons: `rpc_deferred`, `search_deferred_m7`,
`invalid_event_types`, `limit_exceeds_max_rows`, `range_exceeds_max_rows`,
`invalid_range`, `invalid_since`, `shadow_truncated`.

## 9. Safety

- Supabase is the sole production read authority; the authoritative result is
  returned by identity before any background work.
- D1 is read-only: `prepare().bind(...).all()` only; no INSERT/UPDATE/DELETE/
  UPSERT, no DDL, no D1 write, no Supabase write.
- Privileged reads are never composed into a public surface.
- Exact per-method database binding; core is never substituted for ingest/ops.
- Both RPC snapshots are deferred (`rpc_deferred`) with zero D1 calls and no JS
  reimplementation.
- `isConfigured` is synchronous authoritative behavior only.
- Identifiers authored + regex guarded, all values bound.
- Bounded reads (`maxRows + 1`) treat overflow as truncation; no partial
  comparison.
- No retries; background work is bounded by timeout and per-isolate in-flight.
- `READ=true, COMPARE=false` probes D1 only for supported method shapes and emits
  `compare_disabled`; skip gates happen before any D1 call.
- Flags remain default OFF and the new surfaces stay opt-in (no automatic
  enabling); no production enablement, no deploy, DNS change, remote mutation or
  authority switch.

## 10. Tests

| suite | file | coverage |
| --- | --- | --- |
| ops D1 reader + orchestration | `tests/admin-ops-read-shadow.test.ts` | exact core/ingest routing, missing-binding zero-call skip, RPC zero-call skip, q zero-call skip, bounded overflow, exact filter/order/page/count semantics, authoritative identity, default-off, compare-disabled, scheduler rejection, timeout/backpressure, row-content-free events, no write/Node imports, no-config selection |
| analytics D1 reader + orchestration | `tests/admin-analytics-read-shadow.test.ts` | exact ops/ingest/core routing, missing-binding skip, both RPC zero-call skips, invalid-event-types skip, exact count/range branches, access-info `schemaReady`, bounded overflow, authoritative identity, default-off, compare-disabled, scheduler rejection, timeout/backpressure, row-content-free events, no write/Node imports, no-config selection |
| existing admin reads | `tests/admin-ops-read-repository.test.ts`, `tests/admin-analytics-read-repository.test.ts` | unchanged mock/fail-closed no-config behavior and Supabase contract parity |
| runtime boundary + wiring | `tests/d1-shadow-runtime-boundary.test.ts` | runtime-safe imports, read-only SQL for both admin adapters, Worker wiring, default-off/opt-in flags |

Commands: `pnpm test:admin-ops-read-shadow`,
`pnpm test:admin-analytics-read-shadow`, `pnpm test:d1-shadow-all`,
`pnpm test:admin-ops-reads`, `pnpm test:admin-analytics-reads`,
`pnpm test:article-reads`, `pnpm test:reference-reads`,
`pnpm exec tsx --test tests/cloudflare-runtime-boundary.test.ts`,
`pnpm test:d1-schema`, `pnpm test:d1-copy-data`, `pnpm test:d1-reconcile`,
`pnpm typecheck`, `pnpm check`.

## 11. Rollback

Turn the flags off (`WORLDCONS_D1_SHADOW_READ_ENABLED=false` and
`WORLDCONS_D1_SHADOW_COMPARE_ENABLED=false`). The wrappers then perform zero
shadow work and are pure pass-throughs. Because M6.4 is read-only and never
authoritative, there is no data to unwind and no D1 or Supabase state changes.

## 12. Explicit non-goals

- **No `GO-D1-READ`** is claimed.
- **Both RPC snapshots** (`rpc_admin_dashboard_snapshot`,
  `rpc_admin_analytics_health_snapshot`) remain **deferred** to a later
  migration/cutover design.
- **No M7** search/FTS5/Vectorize work; every admin `q`/full-text path is
  `search_deferred_m7`.
