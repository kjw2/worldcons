# WorldCons Cloudflare M6.1 — reference-read shadow slice

Status: **implemented, default OFF, never authoritative**.
Supabase remains the sole production read authority. No deploy, DNS change,
remote mutation, D1 write authority switch, or search/Vectorize projection work
is part of M6.1. Search/Vectorize is **M7** and is untouched.

Related: `docs/worldcons-cloudflare-m5.2d-reconcile-completion-20260925.md`
(M6.0 completion record) and the full-migration plan M6 section.

## 1. Scope

M6 is "shadow public/admin reads against D1; compare result sets and invariants;
no user-visible dependency on D1 yet". M6.1 is the **smallest meaningful
reference-read shadow slice**, deliberately limited to three methods:

- `ReferenceReadRepository.listSources()`
- `ReferenceReadRepository.listGlossaryTerms()`
- `ReferenceReadRepository.getGlossaryTerm(slug)`

All three read `worldcons_core`. Nothing is written to D1, nothing is written to
Supabase (no P5 observation RPC), and the search surface is untouched.

Deferred (NOT shadowed in M6.1): `listTags`, `listJurisdictionArticleCounts`,
`listIngestionRuns`, `getTagBySlug`, the article reads, admin reads, and every
search/Vectorize concern.

## 2. Architecture

| concern | module |
| --- | --- |
| runtime D1 binding injection | `lib/cloudflare/d1/runtime-binding.ts` |
| runtime background scheduler | `lib/runtime/background.ts` |
| shadow config/flags | `lib/cloudflare/d1/shadow/config.ts` |
| bounded runtime-safe D1 read runner | `lib/cloudflare/d1/runtime-read.ts` |
| JSON/array revival for a D1 row | `lib/cloudflare/d1/canonical-kind.ts` (pure kind extract) + shared `parseCanonicalJsonText` |
| D1 reference reader (3 methods) | `lib/reference-reads/d1-repository.ts` |
| shared row mappers | `lib/reference-reads/shared.ts` |
| canonical comparison + digest | `lib/cloudflare/d1/shadow/compare.ts`, `digest.ts` |
| structured observability | `lib/cloudflare/d1/shadow/events.ts` |
| per-isolate backpressure | `lib/cloudflare/d1/shadow/inflight.ts` |
| orchestration wrapper | `lib/reference-reads/shadow.ts` |
| selection point | `lib/reference-reads/index.ts` |
| Worker wiring | `worker/index.ts`, `wrangler.jsonc` |

### 2.1 Authoritative selection (unchanged)

`referenceReads()` still selects Supabase whenever it is configured, otherwise
the mock adapter. When Supabase is authoritative the repository is wrapped with
`withReferenceReadShadow(...)`. The wrapper **awaits the authoritative result,
returns it immediately**, and only afterwards may schedule a shadow task. The D1
result never replaces, modifies or blocks the authoritative result.

### 2.2 Gates (all required before a shadow is scheduled)

1. `WORLDCONS_D1_SHADOW_READ_ENABLED` is on;
2. the `reference` surface is allowed;
3. the `worldcons_core` D1 binding is present in the runtime slot;
4. a background scheduler is registered (Worker `ctx.waitUntil`);
5. the deterministic sample accepts;
6. the per-isolate in-flight bound has room.

Any failed gate emits a `skipped` event (or nothing when the read flag is off)
and the request proceeds with zero shadow work. **No scheduler means skip, never
a synchronous await.** No Supabase means no shadow.

## 3. Flags (all default OFF)

| var | default | meaning |
| --- | --- | --- |
| `WORLDCONS_D1_SHADOW_READ_ENABLED` | `false` | run the background D1 read |
| `WORLDCONS_D1_SHADOW_COMPARE_ENABLED` | `false` | compare D1 vs authoritative (implies read) |
| `WORLDCONS_D1_SHADOW_SURFACES` | `reference` | allowed surfaces (comma list) |
| `WORLDCONS_D1_SHADOW_TIMEOUT_MS` | `1500` | per-shadow timeout |
| `WORLDCONS_D1_SHADOW_MAX_ROWS` | `2000` | bounded D1 read rows |
| `WORLDCONS_D1_SHADOW_MAX_IN_FLIGHT` | `2` | per-isolate concurrent shadows |
| `WORLDCONS_D1_SHADOW_SAMPLE_RATE` | `0.1` | deterministic sampling fraction |

`wrangler.jsonc` declares each var at its safe default. `resolveD1ShadowConfig`
is pure and fail-safe: an unparseable value falls back to the default, and
`compare` cannot be enabled without `read`.

`READ=true, COMPARE=false` still runs the D1 read and emits latency / success /
error with `readOutcome`, but performs no result comparison (`compared:false`,
`outcome:"disabled"`, `reason:"compare_disabled"`).

## 4. Ambiguity resolutions (recorded decisions)

- **`isActive` parity**: the shared `sourceRowToRecord` mapper normalizes
  `is_active` from Supabase boolean or D1 INTEGER 0/1 to the contract boolean,
  so both adapters map identically.
- **`getGlossaryTerm` shape**: the D1 repository issues a bounded SQL equality
  lookup (`where slug = ? limit 1`), while Supabase lists and finds. Both return
  the identical `GlossaryTerm | null`; a missing term is `null` on both, so the
  comparison is stable. No undocumented caveat to the match definition.
- **D1 adapter interface**: the D1 repository satisfies the full
  `ReferenceReadRepository` interface, but the four uncovered methods throw an
  explicit typed `D1ReferenceReadUnsupportedError`. The wrapper never calls them
  on the shadow repository; it delegates them straight to the authoritative
  repository.
- **Digest**: comparison uses a pure-JS, non-crypto FNV-1a-style 64-bit fold
  (`shadowDigest`), because the Worker path must not import a Node crypto
  builtin. It is local parity evidence only, never a security primitive.
- **Shared revival/mapping**: the D1 runtime read revives JSON/array canonical
  text through the same `parseCanonicalJsonText` helper used by the D1
  foundation, and both adapters map rows through the shared
  `lib/reference-reads/shared.ts` mappers, so the only difference between the
  Supabase and D1 results is the storage engine.
- **Runtime-clean seam**: the read seam selects only authored D1 column names
  and never reads a Node global (`process.env`) or imports a `node:*`/converter/
  remote-operator module. Configuration comes from the Worker-resolved runtime
  slot or an explicitly injected environment, and is fully off otherwise.

## 5. Comparison semantics

- arrays are compared after a stable sort by an authored key
  (`sourceKey` for sources, `slug` for glossary terms), so a reordered but
  otherwise identical set is EQUAL;
- raw order is recorded separately as informational `orderMatches`;
- each side is hashed over its canonical form;
- the first bounded diff path (e.g. `listSources[1].name`) is captured on
  mismatch;
- **no row content, table value or secret is ever logged.**

## 6. Observability

One JSON event per shadow decision, `event: "worldcons.d1_shadow"`:

```
{ event, surface, method, outcome, reason, errorCode, db, tables,
  primaryCount, shadowCount, primaryHash, shadowHash, diffPath,
  orderMatches, compared, readOutcome, latencyMs }
```

`outcome ∈ { matched, mismatched, error, timeout, skipped, disabled }`.
The sink is injectable for tests and defaults to `console.log`. Errors, timeouts
and backpressure are swallowed into events; a sink failure can never surface
into the authoritative read.

## 7. Safety

- Supabase is the sole production read authority.
- D1 is read-only in M6.1: `prepare().bind(...).all()` only; no
  INSERT/UPDATE/DELETE/UPSERT, no DDL, no D1 write.
- No Supabase write, no P5 observation RPC.
- Identifiers are authored D1 schema names guarded by a strict regex; every
  value travels as a bound parameter.
- Response validation is fail-closed: a malformed envelope or a non-object row
  is an error, never a silently shorter result.
- No retries. Background work is bounded by timeout and per-isolate in-flight.
- No search projection / Vectorize work (M7).
- No Worker deploy, DNS change or authority switch.

## 8. Tests

| suite | file | tests |
| --- | --- | --- |
| D1 read adapter + runner | `tests/d1-read-runner.test.ts` | 7 |
| shadow orchestration | `tests/reference-read-shadow.test.ts` | 13 |
| runtime boundary + wiring | `tests/d1-shadow-runtime-boundary.test.ts` | 7 |

Commands: `pnpm test:d1-read-runner`, `pnpm test:d1-shadow`,
`pnpm test:d1-shadow-boundary`, or all three via `pnpm test:d1-shadow-all`.
The release gate (`pnpm verify:release`) runs `test:d1-shadow-all`. Existing
reference-read behavior is preserved: `pnpm test:reference-reads` still passes
unchanged (all flags off is a pure pass-through).

## 9. Rollback

Turn the flags off (`WORLDCONS_D1_SHADOW_READ_ENABLED=false` and
`WORLDCONS_D1_SHADOW_COMPARE_ENABLED=false`). The wrapper then performs zero
shadow work and is a pure pass-through to the authoritative repository. Because
M6.1 is read-only and never authoritative, there is no data to unwind; no D1 or
Supabase state changes.
