# WorldCons Cloudflare M6.2 - reference-read shadow expansion

Status: **implemented, default OFF, never authoritative**.
Supabase remains the sole production read authority. No deploy, DNS change,
remote mutation, D1 write, authority switch, or search/Vectorize projection work
is part of M6.2. Search/Vectorize remains **M7** and is untouched. M6.2 does
**not** claim `GO-D1-READ`.

Related: `docs/worldcons-cloudflare-m6.1-reference-read-shadow-20260925.md`
(M6.1 slice) and the full-migration plan M6 section.

## 1. Scope

M6.1 covered three `ReferenceReadRepository` methods over `worldcons_core`
(`listSources`, `listGlossaryTerms`, `getGlossaryTerm`). M6.2 adds the remaining
four reference methods to the same default-off, read-only, background shadow:

- `ReferenceReadRepository.listTags(options)` - bounded, `worldcons_core.tags`
- `ReferenceReadRepository.getTagBySlug(slug)` - `worldcons_core.tags`
- `ReferenceReadRepository.listIngestionRuns(limit)` -
  `worldcons_ingest.ingestion_runs`
- `ReferenceReadRepository.listJurisdictionArticleCounts(jurisdictions, options)`
  - `worldcons_core.articles`

Nothing is written to D1, nothing is written to Supabase (no P5 observation
RPC), and the search surface is untouched.

## 2. Architecture (M6.2 deltas)

| concern | module | M6.2 change |
| --- | --- | --- |
| bounded runtime-safe D1 read runner | `lib/cloudflare/d1/runtime-read.ts` | optional authored column projection, `eq`/`gte` predicates, `asc`/`desc` + `nulls first/last` ordering |
| D1 reference reader (all 7 methods) | `lib/reference-reads/d1-repository.ts` | tags, tag lookup, ingestion runs, jurisdiction counts; per-method core/ingest binding; truncation error |
| shared row mappers | `lib/reference-reads/shared.ts` | reused unchanged (`tagRowToSummary`, `ingestionRunRowToRecord`, `normalizeTagListOptions`) |
| orchestration wrapper | `lib/reference-reads/shadow.ts` | per-method D1 binding, projection gate, bounded/unbounded tag gate, truncation handling |
| selection point | `lib/reference-reads/index.ts` | injects the projection decision |
| observability | `lib/cloudflare/d1/shadow/events.ts` | unchanged (row-content-free) |
| Worker wiring / flags | `worker/index.ts`, `wrangler.jsonc` | unchanged |

### 2.1 Authoritative selection (unchanged)

`referenceReads()` still selects Supabase whenever configured, otherwise the
mock adapter. When Supabase is authoritative the repository is wrapped with
`withReferenceReadShadow(...)`, which **awaits the authoritative result, returns
it immediately (same object identity)**, and only afterwards may schedule a
shadow task. The D1 result never replaces, modifies or blocks the authoritative
result.

### 2.2 Gates (all required before a shadow is scheduled)

1. `WORLDCONS_D1_SHADOW_READ_ENABLED` is on;
2. the `reference` surface is allowed;
3. the method is not skipped (projection mode / unbounded tags);
4. the method's D1 binding is present (`worldcons_core` or, for ingestion runs,
   `worldcons_ingest`);
5. a background scheduler is registered (Worker `ctx.waitUntil`);
6. the deterministic sample accepts;
7. the per-isolate in-flight bound has room.

A missing ingest binding skips `listIngestionRuns` even when the core binding
exists (reason `no_binding`, `db: "worldcons_ingest"`). No scheduler means skip,
never a synchronous await.

## 3. Projection decision

`public_tag_projection_p3` is **not migrated to D1**, so the D1 tag and
jurisdiction-count shadows cannot be compared against the authoritative
projection. The wrapper takes an explicit `projection?: boolean`:

- the selection point injects the same decision the authoritative Supabase
  adapter makes (`publicProjectionReadsEnabled(false)`);
- a direct wrapper construction without the option defaults to the conservative
  `true`, so tags/counts **skip** rather than compare against a relation D1 does
  not have.

With `projection: true`, `listTags`, `getTagBySlug` and
`listJurisdictionArticleCounts` skip with reason `projection_mode` and make
**zero D1 calls**. With `projection: false` (legacy/base-table mode) they shadow
the base `tags` table and the `articles` relation exactly as the legacy
authoritative adapter reads them.

## 4. Per-method semantics

### 4.1 `listTags`

- skipped (`projection_mode`) in projection mode;
- skipped (`unbounded`) when the normalized options carry no explicit positive
  bounded limit, and skipped (`limit_exceeds_max_rows`) when that limit exceeds
  the shadow `maxRows`;
- otherwise: optional `type = ?`, optional `article_count >= ?`, order
  `name asc` / `latest_article_at desc nulls last` / `article_count desc`
  (default), then `limit ?`;
- rows map through the shared `tagRowToSummary`.

### 4.2 `getTagBySlug`

- skipped (`projection_mode`) in projection mode;
- otherwise `where slug = ? limit 1`, mapped through the shared
  `tagRowToSummary` (a missing slug is `null` on both adapters).

### 4.3 `listIngestionRuns`

- reads `worldcons_ingest.ingestion_runs`; a missing ingest binding skips;
- `started_at desc`, requested/default limit bounded by `maxRows + 1`;
- rows map through the shared `ingestionRunRowToRecord`, with `metadata`
  revived from canonical JSON text by the runtime read runner;
- an overflow (more than `maxRows` rows) is truncated, never partially compared.

### 4.4 `listJurisdictionArticleCounts`

- skipped (`projection_mode`) in projection mode;
- otherwise reproduces the legacy `public_jurisdiction_article_counts(range_start)`
  semantics: `articles` where `status = 'summarized'` and
  `source_metadata->collection->>publishable = 'true'` (both JSON `true` and the
  string `"true"`), optional `original_published_at >= rangeStartIso(options.range)`,
  grouped by jurisdiction;
- **no `catalog_ai_stale_v4` filter** (the legacy RPC does not apply it);
- only `jurisdiction` and `source_metadata` are projected; the read is bounded at
  `maxRows + 1` and an overflow is truncated, never partially compared;
- requested jurisdictions are zero-filled for absent entries, matching the
  authoritative adapter.

## 5. Truncation

`lib/reference-reads/d1-repository.ts` raises the typed
`D1ShadowTruncatedError` (`code: "d1_shadow.truncated"`) when a bounded read
observes more than `maxRows` rows. The wrapper catches it and emits a `skipped`
event with reason `shadow_truncated`, `compared: false`, `readOutcome:
"success"`. A partial row set is never compared.

## 6. Runtime-safe read extensions

`buildD1RuntimeReadStatement` now accepts:

- an authored `select` projection (unknown columns fail closed);
- predicates with an `eq`/`gte` operator (unsupported operators fail closed);
- ordering entries with `asc`/`desc` direction and optional `nulls
  first`/`last` (unsupported directions fail closed).

Every identifier is an authored D1 schema name guarded by the strict
`^[a-z_][a-z0-9_]*$` regex and every value travels as a bound parameter. The
module still imports no Node builtin, no remote operator and no `process.env`,
and exposes only `prepare().bind(...).all()` (read-only).

Widening a projection also narrows revival: `runD1RuntimeRead` revives only the
selected columns, so a projected jurisdiction-count row never carries an
unnecessary article field.

## 7. Comparison semantics (unchanged from M6.1)

- arrays compare after a stable sort by an authored key (`slug` for tags, `id`
  for ingestion runs); a reordered but otherwise identical set is EQUAL;
- raw order is informational `orderMatches`;
- objects (`getTagBySlug`, jurisdiction counts) compare by canonical JSON;
- each side is hashed over its canonical form with the pure-JS `shadowDigest`;
- the first bounded diff path is captured on mismatch;
- **no row content, table value or secret is ever logged.**

## 8. Observability

One `worldcons.d1_shadow` JSON event per shadow decision through the injectable
sink (default `console.log`), unchanged in shape:

```
{ event, surface, method, outcome, reason, errorCode, db, tables,
  primaryCount, shadowCount, primaryHash, shadowHash, diffPath,
  orderMatches, compared, readOutcome, latencyMs }
```

New reasons: `projection_mode`, `unbounded`, `limit_exceeds_max_rows`,
`shadow_truncated`. `db` may now be `worldcons_ingest`. Errors, timeouts,
truncation and backpressure are swallowed into events; a sink failure can never
surface into the authoritative read.

## 9. Safety

- Supabase is the sole production read authority; the authoritative result is
  returned by identity before any background work.
- D1 is read-only: `prepare().bind(...).all()` only; no
  INSERT/UPDATE/DELETE/UPSERT, no DDL, no D1 write.
- No Supabase write, no P5 observation RPC, no search/Vectorize work.
- Identifiers authored+regex guarded, all values bound.
- Response validation is fail-closed; a malformed envelope or non-object row is
  an error, never a silently shorter result.
- Bounded reads (`maxRows + 1`) treat overflow as truncation; no partial
  comparison.
- No retries; background work is bounded by timeout and per-isolate in-flight.
- `READ=true, COMPARE=false` probes read D1 and report `readOutcome` only.
- No Worker deploy, DNS change, remote mutation or authority switch.

## 10. Tests

| suite | file | coverage |
| --- | --- | --- |
| D1 read runner + adapter | `tests/d1-read-runner.test.ts` | projection/`eq`/`gte`/order SQL, fail-closed invalid input, projected revival, tags/tag-lookup/ingestion/count parity with Supabase, ingest binding isolation, truncation |
| shadow orchestration | `tests/reference-read-shadow.test.ts` | M6.2 method orchestration, projection/unbounded/over-max skips, missing ingest binding, truncation skip, primary identity, M6.1 regression |
| runtime boundary + wiring | `tests/d1-shadow-runtime-boundary.test.ts` | runtime-safe imports, read-only SQL, Worker wiring, default-off flags |

Commands: `pnpm test:d1-read-runner`, `pnpm test:d1-shadow`,
`pnpm test:d1-shadow-boundary`, or all three via `pnpm test:d1-shadow-all`.
`pnpm test:reference-reads` still passes unchanged. M6.2 does **not** authorize
`GO-D1-READ`; the shadow is default off and never authoritative.

## 11. Rollback

Turn the flags off (`WORLDCONS_D1_SHADOW_READ_ENABLED=false` and
`WORLDCONS_D1_SHADOW_COMPARE_ENABLED=false`). The wrapper then performs zero
shadow work and is a pure pass-through. Because M6.2 is read-only and never
authoritative, there is no data to unwind and no D1 or Supabase state changes.
