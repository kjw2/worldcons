# WorldCons Cloudflare M6.5 - D1 shadow parity report + gate tooling

Status: **tooling implemented, production evidence absent**.
Supabase remains the sole production read authority. M6.5 is **local, read-only
evidence tooling only**: no deployment, no push, no Cloudflare/Supabase/D1
mutation, no authority switch and **no `GO-D1-READ` claim**. M7
search/FTS5/Vectorize and the two admin RPC snapshots remain deferred. M6
code coverage/tooling is complete, but **M6 production evidence is insufficient**
and the **global `GO-D1-READ` gate stays blocked**.

Related: `docs/worldcons-cloudflare-m6.1-reference-read-shadow-20260925.md`,
`docs/worldcons-cloudflare-m6.2-reference-read-shadow-20260925.md`,
`docs/worldcons-cloudflare-m6.3-article-read-shadow-20260925.md`,
`docs/worldcons-cloudflare-m6.4-admin-read-shadow-20260925.md` and the
full-migration plan M6 section.

## 1. Purpose

M6.1-M6.4 emit exactly one structured `worldcons.d1_shadow` JSON event per
shadow decision. M6.5 turns those raw events into:

- a **deterministic machine-readable report** (`--format=json`, default), and
- an **operator-friendly markdown report** (`--format=markdown`),

plus a conservative gate decision that keeps two distinct questions separate:

| gate | meaning |
| --- | --- |
| `m6EvidenceGate` | Do the **implemented, comparable M6 methods** meet the explicit thresholds on the supplied evidence? |
| `globalGoD1Read` | Is the global `GO-D1-READ` authorization ready? Always **blocked** in M6.5. |

M6.5 never changes runtime behavior, never touches D1/Supabase, and never emits
a hash, diff path value, URL, query, metadata payload, IP hash or row content.

## 2. CLI

```
pnpm d1:shadow-report --input=shadow.ndjson
Get-Content shadow.ndjson | pnpm d1:shadow-report --format=markdown
pnpm d1:shadow-report --input=shadow.ndjson --strict-scope=m6
```

Options:

| option | default | meaning |
| --- | --- | --- |
| positional / `--input=<path>` | stdin | NDJSON input (`-` = stdin) |
| `--format=json\|markdown` | `json` | output format |
| `--output=<path>` | stdout | write the report to a file |
| `--min-compared-per-method=<n>` | `20` | per-method compared sample floor |
| `--max-mismatch-rate=<0..1>` | `0` | per-method mismatched / compared |
| `--max-error-rate=<0..1>` | `0` | per-method errors / events |
| `--max-timeout-rate=<0..1>` | `0` | per-method timeouts / events |
| `--strict-scope=m6\|global\|none` | `none` | process exit behavior |
| `--strict` | - | alias for `--strict-scope=global` |

Thresholds are **proposed local defaults, not agreed production policy**; the
report records them and their `proposed_local_defaults` provenance.

Exit codes:

- `--strict-scope=m6`: exit `0` only when `m6EvidenceGate === go_candidate`.
- `--strict-scope=global`: exit `0` only when `globalGoD1Read === ready`. Since the
  global gate is intentionally blocked in M6.5, this (and `--strict`) always
  exits non-zero until M7 search and both admin RPC snapshots are resolved.
- `--strict-scope=none` (default): always exit `0` after writing a report.
- Usage/IO errors exit `2`; malformed input is reported and fails the gate closed,
  it does not silently disappear.

No network access is performed.

## 3. What the report aggregates

Globally and per surface+method:

- total events, compared, matched, mismatched, errors, timeouts, skipped,
  compare-disabled probes, read successes;
- reason counts and error-code counts (`compare_disabled`, `projection_mode`,
  `search_deferred_m7`, `rpc_deferred`, `no_binding`, `no_scheduler`,
  `sampled_out`, `backpressure`, `shadow_truncated`, `limit_exceeds_max_rows`,
  ...);
- `primaryCount`/`shadowCount` mismatch count and (count only, never values)
  hash mismatch count;
- order-only mismatch count (`matched` with `orderMatches=false`);
- latency min/max/mean/p50/p95/p99 over comparable/successful reads when at
  least 5 samples exist;
- `diffPathPresent` count only; the diff path value is never emitted.

The report is **deterministic and independent of input ordering** (counts are
summed, maps are key-sorted, latency samples are sorted before quantiles).
There is no event id in the current event shape, so duplicate events are
preserved as distinct samples and never deduplicated.

## 4. Evidence safety

Only method/surface/db/tables/counts/rates/latencies/reasons/error codes are
emitted. The report:

- never emits `primaryHash` / `shadowHash` values (only a mismatch count),
- never emits a `diffPath` value (only presence count),
- never emits URLs, queries, `search_query`, metadata payload values,
  `client_ip_hash` or row content (those fields are not part of the event shape
  and are ignored if present),
- sanitizes reason/error codes to a bounded token shape and drops anything else,
- sanitizes db/table names to bare identifiers.

## 5. Coverage derived from code

Comparable coverage is derived from the implemented wrappers themselves via the
existing `referenceReadShadowCoveredMethods()`,
`articleReadShadowCoveredMethods()`, `adminOpsReadShadowCoveredMethods()` and
`adminAnalyticsReadShadowCoveredMethods()` exports (see
`lib/cloudflare/d1/shadow/coverage.ts`), so the report cannot silently drift.

Deferred obligations are declared separately and can never count as parity:

- `search_m7` - M7 search/FTS5/Vectorize projection.
- `rpc_admin_dashboard_snapshot` - `loadDashboardSnapshot` emits `rpc_deferred`
  with zero D1 calls.
- `rpc_admin_analytics_health_snapshot` - `loadAnalyticsHealthSnapshot` emits
  `rpc_deferred` with zero D1 calls.

`isConfigured` on both admin surfaces stays synchronous authoritative behavior
and emits no event; it is listed as a sync method, not a comparable one.

## 6. Gate model

- Any malformed JSON line or structurally invalid event => `no_go` (fail closed).
- A method with fewer than `min-compared-per-method` compared samples =>
  `insufficient_evidence`. Skip-only methods never satisfy coverage, and
  compare-disabled probes never count as comparisons.
- Mismatch/error/timeout rates above their thresholds => `no_go`.
- Impossible combinations (for example `matched` with `compared=false`, an
  unknown surface/method, missing hashes on a compared event) are invalid.
- All comparable methods meeting coverage and thresholds, with no invalid input
  => `go_candidate` for the **M6 evidence gate only**.
- `globalGoD1Read` is **always** `blocked` in M6.5 with the explicit blockers
  `search_m7`, `rpc_admin_dashboard_snapshot` and
  `rpc_admin_analytics_health_snapshot`, regardless of green M6 data.

A production `GO` must never be inferred from one sample, from a single surface,
or from this report alone.

## 7. Operator workflow

1. Collect raw shadow events that contain the `worldcons.d1_shadow` event name
   from the chosen observability source (Workers Observability / `wrangler tail`
   / Logpush NDJSON export). Do not edit them.
2. Feed the NDJSON to the CLI as a file or stdin.
3. Inspect the JSON or markdown report: per-method `compared` counts, reason
   counts, rates, latencies and the two gate statuses.
4. Treat `m6EvidenceGate === go_candidate` as "the observed M6 surfaces meet the
   proposed local thresholds", nothing more. It is **not** `GO-D1-READ`.
5. **Do not enable authority based on M6.5 alone.** The global gate remains
   blocked pending M7 search/Vectorize parity and both admin RPC snapshot
   migrations, and a separate authorization process.

Current verdict on `42c504c` (clean HEAD): M6 code coverage and tooling are
complete, but there is **no production shadow evidence** in this thread, so
`m6EvidenceGate === insufficient_evidence` and `globalGoD1Read === blocked`.

## 8. Tests

`tests/d1-shadow-parity-report.test.ts` (17 focused tests) covers:

- exact all-green fixture reaching `go_candidate` only when every comparable
  method meets the minimum sample threshold;
- missing method => `insufficient_evidence`;
- mismatch / error / timeout / malformed line / invalid event => `no_go`;
- compare-disabled probes and skips never satisfy minimum comparisons;
- duplicate events counted separately;
- input order does not change the JSON report;
- deterministic, order-independent latency quantiles;
- safe output contains no hashes, diff paths, URLs, `search_query`, metadata
  values, `client_ip_hash` or row content;
- unknown/unsafe reason and error codes sanitized;
- global gate remains blocked by all three obligations even with green M6 data;
- strict-scope exit behavior;
- empty/no-evidence fixture (`tests/fixtures/d1-shadow-parity/no-evidence.ndjson`)
  yields `insufficient_evidence` + `blocked`.

Commands: `pnpm test:d1-shadow-parity`, `pnpm test:d1-shadow-all`,
`pnpm test:admin-ops-read-shadow`, `pnpm test:admin-analytics-read-shadow`,
`pnpm test:article-reads`, `pnpm test:reference-reads`,
`pnpm test:d1-shadow-boundary`, `pnpm typecheck`, `pnpm check`.

## 9. Explicit non-goals

- **No `GO-D1-READ`** is claimed or auto-granted.
- **No deployment, push, DNS change or remote mutation.**
- **No authority switch**; Supabase remains the sole read authority.
- **No M7** search/FTS5/Vectorize work.
- **Both admin RPC snapshots remain deferred.**
