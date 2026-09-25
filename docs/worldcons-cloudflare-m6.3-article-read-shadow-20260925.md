# WorldCons Cloudflare M6.3 - article-read shadow

Status: **implemented, default OFF, never authoritative**.
Supabase remains the sole production read authority. No deploy, DNS change,
remote mutation, D1 write, authority switch, or search/Vectorize projection work
is part of M6.3. Search/Vectorize remains **M7** and is untouched. M6.3 does
**not** claim `GO-D1-READ`.

Related: `docs/worldcons-cloudflare-m6.1-reference-read-shadow-20260925.md`,
`docs/worldcons-cloudflare-m6.2-reference-read-shadow-20260925.md` and the
full-migration plan M6 section.

## 1. Scope

M6.1/M6.2 shadowed the seven `ReferenceReadRepository` methods. M6.3 extends the
same default-off, read-only, background shadow to the six-method
`lib/article-reads` seam:

- `listArticles(filters)`
- `listPublicSitemapArticles()`
- `listTopViewedArticles(limit, filters)`
- `listRelatedArticleIds(tagId, options)`
- `getArticleBySelect(slug, select, options)`
- `getArticleSourceTextBySlug(slug, options)`

Every public caller still receives the exact authoritative Supabase result
unchanged (returned by identity before any background work). Nothing is written
to D1 or Supabase and the search surface is untouched.

## 2. Architecture (M6.3 deltas)

| concern | module | M6.3 change |
| --- | --- | --- |
| bounded runtime-safe D1 read runner | `lib/cloudflare/d1/runtime-read.ts` | `neq` and `in` predicates (authored identifiers, every value bound) |
| shadow comparison | `lib/cloudflare/d1/shadow/compare.ts` | optional `unordered` array contract (primitive id lists with no authored key) |
| shadow config | `lib/cloudflare/d1/shadow/config.ts` | new `article_read` surface constant (still opt-in) |
| D1 article reader | `lib/article-reads/d1-repository.ts` | six methods over `worldcons_core`; shared row mapping; bounded multi-read composition; truncation/ambiguity errors |
| orchestration wrapper | `lib/article-reads/shadow.ts` | per-method gating, projection/search skips, contract selection |
| selection point | `lib/article-reads/index.ts` | injects the authoritative projection and case-catalog decisions |
| observability | `lib/cloudflare/d1/shadow/events.ts` | unchanged (row-content-free) |
| Worker wiring / flags | `worker/index.ts`, `wrangler.jsonc` | unchanged |

### 2.1 Authoritative selection (unchanged)

`articleReads()` still selects Supabase whenever configured, otherwise the mock
adapter. When Supabase is authoritative the repository is wrapped with
`withArticleReadShadow(...)`, which **awaits the authoritative result, returns
it immediately (same object identity)**, and only afterwards may schedule a
background shadow task. The D1 result never replaces, modifies or blocks the
authoritative result.

### 2.2 Gates (all required before a shadow is scheduled)

1. `WORLDCONS_D1_SHADOW_READ_ENABLED` is on;
2. the `article_read` surface is allowed (`WORLDCONS_D1_SHADOW_SURFACES`);
3. the authoritative call is a safe legacy/base-table shape: not a publication
   projection (`public_article_projection_p3`) or case-catalog V4 detail
   (`public_article_detail_v4`) read, not a `filters.q` search path, and not an
   unsupported/unbounded/ambiguous shape;
4. the `worldcons_core` D1 binding is present;
5. a background scheduler is registered (Worker `ctx.waitUntil`);
6. the deterministic sample accepts;
7. the per-isolate in-flight bound has room.

A missing binding skips with `no_binding` and **zero** D1 calls. No scheduler
means skip, never a synchronous await. All article reads use `worldcons_core`;
none requires `worldcons_ops`.

## 3. Authority / safety skips

### 3.1 Projection and case-catalog V4

`public_article_projection_p3` and `public_article_detail_v4` are **not migrated
to D1**, so any authoritative call that would read them must skip before any D1
call. The wrapper takes explicit `projection` and `caseCatalogPublic` decisions:

- the selection point injects the same decisions the authoritative Supabase
  adapter makes (`publicProjectionReadsEnabled(false)` and
  `caseCatalogPublicReadsEnabled()`);
- a direct wrapper construction without the options defaults conservatively to
  `true` (skip) for both.

`includeUnpublished` is honored exactly as in the authoritative adapter: it
forces the legacy/base relation, so the projection/V4 gate does not apply and
the shadow may read the base `articles` table. All other public reads skip with
reason `projection_mode` and make **zero** D1 calls.

### 3.2 Search / full text (M7)

Any `filters.q` path is M7 (full-text/ranked/case-catalog search). The wrapper
emits a structured skip with reason `search_deferred_m7` and makes **zero** D1
calls. `listTopViewedArticles`/`listRelatedArticleIds` accept no `q`.

### 3.3 Unsupported / unbounded / ambiguous shapes

- `count: "planned" | "estimated"` skips (`unsupported_count_mode`) because an
  exact total cannot be proven from D1.
- `listRelatedArticleIds` requires a positive integer `limit` bounded by
  `maxRows`; otherwise `unbounded` / `limit_exceeds_max_rows`. An overflow past
  the requested limit is `ambiguous_limit` (the authoritative order is not
  contractually defined), never a partial comparison.
- `listTopViewedArticles` skips with `ambiguous_ranking` when a view-count tie
  crosses the safe-limit cut, because the top-N set would not be deterministic.
- Any bounded read that observes more than `maxRows` rows raises the typed
  `D1ShadowTruncatedError` and the wrapper emits `shadow_truncated`.

## 4. Per-method semantics

All mapping reuses the authoritative adapter's shared row mapping
(`articleRowToItem`, `articleMappingOptions`) and publishability semantics
(`isPublishableListItem`); M6.3 never duplicates output shaping.

### 4.1 `listArticles`

- skipped (`search_deferred_m7`) for `filters.q`; skipped (`projection_mode`) for
  projection/V4 public reads;
- legacy filters `ids`/`source`/`jurisdiction`/`type`/`language`/`range`/`tag`
  are reproduced (`ids` and legacy tag ids as bound `in` predicates; the tag
  table resolves tag ids by slug and by name, then `article_tags` resolves the
  bounded article ids);
- ordering `original_published_at desc nulls last, id asc`, the
  page/pageSize/hasMore/total semantics and `count: "none"` are preserved; the
  full matching set is read once at `maxRows + 1`, so an overflow is a
  truncation-skip rather than a partial count;
- view counts are attached from `article_view_counts` unless
  `includeViewCounts === false`, exactly as the authoritative adapter does;
- public publishability matches the authoritative SQL text filter (JSON `true`
  or the string `"true"`); `includeUnpublished` bypasses the public-only
  filters.

### 4.2 `getArticleBySelect`

- skipped (`projection_mode`) for projection/V4 public reads;
- `list`/`page`/`detail` mapping matches `articleRowToItem` with
  `articleMappingOptions`; the PostgREST projection aliases
  (`one_line_summary`, `resolution_type`, `case_number`) are reproduced and the
  list projection drops `summary_json`/`source_metadata`;
- legacy article tags are hydrated from `article_tags` + `tags` (ordered by
  `article_id, tag_id`, matching the Postgres primary key order);
- slug is exact; public publishability applies the textual SQL filter and the
  strict post-filter exactly as the authoritative adapter; `includeUnpublished`
  is exact;
- `raw_text` is relocated to R2 in D1 (there is no D1 column); the shadow maps
  it to `null`, matching an externalized row, while the blob metadata columns
  are reproduced.

### 4.3 `getArticleSourceTextBySlug`

- skipped (`projection_mode`) for projection/V4 public reads;
- exact legacy base-table fields (`slug`, `source_key`, `source_metadata`,
  `original_url`, `cleaned_text`, `content_hash`) and the public filtering /
  `includeUnpublished` behavior are preserved.

### 4.4 `listPublicSitemapArticles`

- skipped (`projection_mode`) in projection mode;
- `slug` + `lastModified` precedence `summarized_at || fetched_at ||
  discovered_at || null` and the authoritative ordering are preserved;
- reads at most `maxRows + 1`; overflow skips, never a partial compare.

### 4.5 `listTopViewedArticles`

- skipped (`projection_mode`) for projection/V4 public reads;
- `safeLimit` (positive, clamped to 20) and `filters` are preserved; ranking
  uses `article_view_counts` ordered by `view_count desc` with the same probe
  window (`max(safeLimit * 4, safeLimit)`);
- a tag filter reuses the safe `listArticles` shadow path, exactly as the
  authoritative adapter does;
- the primary `article_view_counts` ranking path and its empty-table
  `listArticles` fallback are reproduced exactly. There is no `site_events`
  shadow, so the authoritative per-slug `site_events` fallback (which only runs
  when the Supabase `article_view_counts` aggregate query errors) cannot be
  reproduced; such an operational anomaly would surface as a `mismatched`
  event, never as a silent approximation. A view-count tie across the safe
  limit skips with `ambiguous_ranking`.

### 4.6 `listRelatedArticleIds`

- `article_tags` where `tag_id = ?` and `article_id != ?` (the authoritative
  `excludeArticleId ?? ""`), bounded by the requested `limit`;
- de-dup preserves the first occurrence; an overflow past the requested limit is
  `ambiguous_limit`.

## 5. Runtime-safe read extensions

`buildD1RuntimeReadStatement` now additionally accepts `neq` (`column != ?`) and
`in` (`column in (?, ?, ...)`) predicates. Identifiers remain authored D1 schema
names guarded by `^[a-z_][a-z0-9_]*$`; every value travels as a bound parameter,
including every `in` element. An empty `in` array fails closed. The module still
imports no Node builtin, no remote operator and no `process.env`, and exposes
only `prepare().bind(...).all()` (read-only).

## 6. Comparison semantics

- array contracts sort by an authored stable key (`slug` for articles/sitemap,
  `null` for the primitive related-id list) — a reordered but otherwise
  identical set is EQUAL;
- the primitive related-id list uses the new `unordered` contract and compares
  as a canonical set, because the authoritative order is not contractually
  defined;
- objects/detail rows compare by canonical JSON;
- each side is hashed over its canonical form with the pure-JS `shadowDigest`;
- the first bounded diff path is captured on mismatch;
- **no row content, cleaned text, source text, URL or secret is ever logged.**

## 7. Observability

One `worldcons.d1_shadow` JSON event per shadow decision through the injectable
sink (default `console.log`), unchanged in shape:

```
{ event, surface, method, outcome, reason, errorCode, db, tables,
  primaryCount, shadowCount, primaryHash, shadowHash, diffPath,
  orderMatches, compared, readOutcome, latencyMs }
```

`surface` is `article_read`; `db` is `worldcons_core`. New reasons:
`search_deferred_m7`, `projection_mode`, `unsupported_count_mode`, `unbounded`,
`limit_exceeds_max_rows`, `ambiguous_limit`, `ambiguous_ranking`,
`shadow_truncated`. Errors, timeouts, truncation, ambiguity and backpressure are
swallowed into events; a sink failure can never surface into the authoritative
read.

## 8. Safety

- Supabase is the sole production read authority; the authoritative result is
  returned by identity before any background work.
- D1 is read-only: `prepare().bind(...).all()` only; no
  INSERT/UPDATE/DELETE/UPSERT, no DDL, no D1 write.
- No Supabase write, no P5 observation RPC, no search/Vectorize work, no M7
  FTS5/Vectorize work.
- Identifiers authored + regex guarded, all values bound (`in` included).
- Response validation is fail-closed; a malformed envelope or non-object row is
  an error, never a silently shorter result.
- Projection/V4/search paths skip before any D1 call; missing binding skips with
  zero D1 calls.
- Bounded reads (`maxRows + 1`) treat overflow as truncation; no partial
  comparison.
- No retries; background work is bounded by timeout and per-isolate in-flight.
- `READ=true, COMPARE=false` probes read D1 and report `readOutcome` only.
- Flags remain default OFF; no production enablement, no deploy, DNS change,
  remote mutation or authority switch.

## 9. Tests

| suite | file | coverage |
| --- | --- | --- |
| D1 read runner | `tests/d1-read-runner.test.ts` | `neq`/`in` SQL rendering with bound values, empty `in` rejection |
| D1 article reader | `tests/article-read-d1-repository.test.ts` | shared-mapping parity, list/page/detail, publishability, `includeUnpublished`, tag hydration/filtering, sitemap precedence, related ids, top-view ranking/fallback, bounded/truncation/ambiguity |
| article shadow orchestration | `tests/article-read-shadow.test.ts` | authoritative identity, default-off, projection/V4/search zero-D1 skips, direct-construction conservative default, missing binding/scheduler/surface/sampling, bounded limit, truncation, timeout/backpressure, no raw row content, M6.1/M6.2 regression |
| runtime boundary + wiring | `tests/d1-shadow-runtime-boundary.test.ts` | runtime-safe imports, read-only SQL, Worker wiring, default-off flags |

Commands: `pnpm test:article-read-shadow`, `pnpm test:d1-shadow-all`,
`pnpm test:article-reads`, `pnpm test:reference-reads`,
`pnpm exec tsx --test tests/cloudflare-runtime-boundary.test.ts`. M6.3 does
**not** authorize `GO-D1-READ`; the shadow is default off and never
authoritative, and M7 search remains deferred.

## 10. Rollback

Turn the flags off (`WORLDCONS_D1_SHADOW_READ_ENABLED=false` and
`WORLDCONS_D1_SHADOW_COMPARE_ENABLED=false`). The wrapper then performs zero
shadow work and is a pure pass-through. Because M6.3 is read-only and never
authoritative, there is no data to unwind and no D1 or Supabase state changes.
