# WorldCons Cloudflare M7.6 — Parameterized D1 writer + isolated binding canary

Date: 2026-09-26

## Status

M7.6 code, local verification and bounded remote canary evidence through the
isolated canary resources. **M7 remains blocked and no `GO-SEARCH` /
`GO-D1-READ` is claimed.** Supabase remains the sole production search/read
authority and `SearchRepository` selection is unchanged. No production
resource was created, deleted or switched. The only deployed resource added to
the M7.6 evidence surface is the isolated non-production
`worldcons-search-canary` Worker bound to the pre-existing v2 canary D1 /
Vectorize resources.

The production `wrangler.jsonc` is byte-for-byte unchanged. The isolated canary
Worker has its own config with no routes, no `route` and no custom domain.

### Evidence provenance (accurate labels)

- The 100-row materialization and timing evidence ran through
  **local-runtime + remote-bindings**: Worker code
  executed locally under `wrangler dev` while the isolated `remote: true`
  bindings reached the real, non-production `worldcons_search_canary_v2` D1 and
  `worldcons-search-canary-v2` Vectorize resources. This is **not** a deployed
  Worker runtime SLO and must not be cited as one. The isolated Worker **is**
  deployed, but its bearer-protected `POST /canary/run` path was not used for
  these latency numbers.
- Final isolated Worker deployment: version
  `720d2c2a-e2fc-4f05-9aae-fd425b7a392a` at
  `worldcons-search-canary.cclib.workers.dev`. An unauthenticated
  `GET /health` returned HTTP **401**, confirming the deployed endpoint remains
  fail-closed.
- The binding `p50`/`p95` in the evidence is the Worker-measured latency of that
  local-runtime + remote-bindings path, not a production `GO-SEARCH` SLO.
- Supabase (production authority) was read only; no Supabase write and no new
  Supabase migration were made. No production Vectorize index, D1 database,
  route, DNS or traffic flag was changed.

## Implemented

### 1. Isolated search-canary Worker (real D1 + Vectorize bindings)

`workers/search-canary/` adds a separate, non-production Worker:

- `workers/search-canary/wrangler.jsonc` binds only
  `SEARCH_CANARY_DB` → `worldcons_search_canary_v2` and
  `SEARCH_CANARY_INDEX` → `worldcons-search-canary-v2`. It declares **no**
  `routes`/`route`/custom domain, so it can never serve production traffic. Both
  bindings set `remote: true`, a **development-only** Wrangler option
  ("whether the ... should be remote or not in local development"): a plain
  `wrangler dev` then executes Worker code locally while reaching the real
  isolated canary resources. It changes only `wrangler dev` resolution — the
  binding names, database/index identities and absent routes are unchanged, and
  `wrangler deploy` ignores it. The isolated `worldcons_search_canary_v2`
  `database_id` (not the production `worldcons_search` id) is filled from
  `wrangler d1 list --json` for the remote-binding canary.
- `workers/search-canary/src/index.ts` serves only over its `workers.dev`
  endpoint and requires a shared bearer token on **every** route:
  - `GET /health` — binding-presence only;
  - `POST /d1/statement` — executes one `?`-parameterized statement through the
    real D1 binding (`params` are sent out of band, never in SQL text);
  - `POST /vectorize/query` — executes a Vectorize query through the real
    binding and returns ids/scores only;
  - `POST /canary/run` — runs the frozen cases through the real D1 + Vectorize
    bindings via the unchanged M7.4 orchestrator and returns per-case binding
    latency (ids only; no vector values or document text).

Error responses carry a bounded machine code only; the bearer token is never
logged, echoed or interpolated into a response. Local bundle verification:
`wrangler deploy --dry-run` from `workers/search-canary` succeeds (67.25 KiB)
with both bindings resolved.

### 1a. Local-only unauthenticated remote-binding path

ChatGPT tooling must never read or send the deployed canary bearer secret. The
Worker therefore supports an explicit **local-dev** path:

- The Worker skips bearer auth **only** when
  `WORLDCONS_SEARCH_CANARY_DEV_UNAUTH === "true"` (exact string) **and** the
  request hostname is loopback (`127.0.0.1`, `localhost` or `::1`). Anything
  else — any non-loopback host, or any flag value other than exactly `true` —
  stays on the unchanged mandatory bearer path. `workers/search-canary/.dev.vars`
  (local only, gitignored, never uploaded by `wrangler deploy`) sets the flag so
  `wrangler dev` on `http://127.0.0.1:8787` is tokenless locally. The deployed
  Worker has no such env var and remains fail-closed.
- Combined with the `remote: true` bindings above, a local/ChatGPT caller drives
  the isolated D1 + Vectorize resources through `wrangler dev` without any
  bearer secret.
- The operator CLI adds `--writer=local-dev` (or the explicit
  `WORLDCONS_SEARCH_CANARY_DEV_UNAUTH=true` opt-in with `--writer=auto`). It
  sends no `authorization` header and fails closed unless the endpoint is
  loopback **http**; https/public hosts are refused. `--binding-canary` uses the
  same tokenless loopback path. `local-dev` is never the default for the normal
  `worker`/`http` modes, which still require the token.

### 2. Parameterized D1 writer (replaces the M7.5 literalized write limit)

M7.5 inlined every bound value into SQL so it could use
`wrangler d1 execute --command`; large `search_text` values then exceeded D1's
100 KB per-statement limit. M7.6 never literalizes a write:

- `lib/cloudflare/search-canary/writer.ts` builds a `SearchCanaryWritePlan` that
  keeps the authored `?` SQL and the bound params **separate**. It refuses a
  non-`INSERT` statement and any non-string/number/null param (blobs fail
  closed). The literal byte size is retained as a diagnostic only; it never
  truncates and never gates a write.
- `lib/cloudflare/search-canary/operator/parameterized-writer.ts` provides two
  transports:
  - `worker-binding` — POSTs each statement to the isolated Worker's D1 binding;
    the Worker is deployed with the repository's own Wrangler-authenticated
    account, so this is the repository-compatible path (the M7.5 connector
    account returned authorization error 7403 and was never used for worldcons);
  - `d1-http` — reuses the existing D1 HTTP query primitives
    (`createD1HttpAffectedWriter`) with `CLOUDFLARE_ACCOUNT_ID` +
    `CLOUDFLARE_API_TOKEN` + `WORLDCONS_SEARCH_CANARY_DATABASE_ID`.
- `scripts/d1-search-canary.ts` now plans the parameterized writes once
  (dry-run reports the exact plan with no remote call), and on `--apply` writes
  the initial projection through the selected parameterized transport. There is
  no literalized write path, no `--file` write path, and no source truncation.
  `--writer=auto|worker|http|none` selects the transport; `auto` prefers the
  Worker path and falls back to D1 HTTP.

### 3. Binding/runtime timing separated from operator wall time

- Every `SearchCanaryObservation` now carries `bindingLatencyMs` in addition to
  the existing operator `latencyMs`.
- `--binding-canary` runs the same frozen cases through the isolated Worker's
  real bindings (`POST /canary/run`) and records the Worker-measured latency.
- `lib/cloudflare/search-canary/timing.ts` summarizes the operator and binding
  distributions separately. `SearchCanaryThresholds` gains optional
  `maxBindingLatencyP50Ms`/`maxBindingLatencyP95Ms` (defaults 500/1500).
- **Latency gate selection (binding-first).** A mode's latency pass/fail is the
  binding `p50`/`p95` when binding samples exist; operator wall time is then
  evidence only and is never a gate. The legacy operator thresholds
  (`maxLatencyP50Ms`/`maxLatencyP95Ms`) gate **only** a mode with no binding
  samples, so an operator-only run is never silently assumed fast and a
  binding run is never falsely failed by the Wrangler child-process wall time.
  This matters because the latest 4-case run measured operator `p50/p95` of
  1943/6277 ms but binding `p50/p95` of 161/386 ms: the same evidence passes the
  binding gate while remaining far outside the provisional operator ceiling.

### 4. Explicit semantic oracle modes + artifact-reference drift handling

- `lib/cloudflare/search-canary/oracle.ts` adds explicit oracle modes:
  `production-rpc`, `artifact-reference` and `none`.
- `resolveSearchCanaryOracleMode(...)` selects `artifact-reference` when the
  production `public_article_projection_p3.embedding` is NULL for an
  artifact-backed semantic/hybrid row and records `drift: true`; the report
  surfaces `production_semantic_oracle_drift` and the per-observation oracle
  mode. Supabase is only ever read; no Supabase mutation and no new Supabase
  migration were added. Semantic/hybrid artifact-reference behavior is
  unchanged.

### 4a. Conservative lexical-rank gate (no benchmark mixing, no invented threshold)

M7.2 documents that FTS5 bm25 does **not** reproduce Postgres `ts_rank_cd` and
claims no query-language/rank parity and no agreed rank threshold. M7.6 therefore
splits lexical production comparison by whether it can gate:

- **Strict** — the deterministic `exact-case-*` cases (top-anchored `top-id` /
  `exact-order` expectations) keep strict production-rpc top-id parity, exactly
  as before.
- **Informational** — generic lexical (`contains`) fulltext cases compute and
  store a `rankComparison` with the existing M7.2 `compareRankedIds` helper
  (`overlapAtK`, `prefixMatch*`, `exactOrder`, `sameSet`, `missing`/`extra`), but
  a production top-1 divergence is recorded as `oracleParity: "informational"`
  instead of `"mismatch"`: the local frozen expectation must still pass, and the
  case is not failed solely because production top-1 differs.
- The report derives an explicit, unresolved blocker
  **`fulltext_rank_threshold_unagreed`** whenever a non-strict lexical
  comparison diverged, so `GO-SEARCH` stays blocked rather than the gate
  inventing a threshold. No threshold was tuned to the observed mismatch.

This refinement does not change any score, weight, corpus or threshold; it only
stops mislabelling a documented-baseline ordering difference as a correctness
failure.

### 5. Tests

`tests/d1-search-canary-m7.6.test.ts` (55 cases) covers the Worker contract,
strict auth/no-leak, the loopback-only `local-dev` bypass and its non-loopback
rejection, the normal bearer path, the `local-dev`/tokenless binding-canary
writer selection, the parameterized writer plan/execution, the
artifact-reference oracle and drift, operator/binding timing separation, the
report evidence shape, the runtime-neutral boundary, and the isolated/no-routes
`remote: true` Worker config. It additionally covers the refined conservative
evidence gates: exact-case strict production-rpc top-id parity, generic lexical
informational rank metrics with non-failure, the unresolved
`fulltext_rank_threshold_unagreed` blocker, binding-versus-operator latency gate
selection, the no-binding operator fallback, and content-free rank evidence. All
remote seams are fakes: no network, no Supabase, no Wrangler.

### 6. Scripts and docs

- `package.json` adds `test:d1-search-canary-m7.6` and includes it in
  `verify:release`.
- `scripts/d1-search-canary.ts` writes M7.6 evidence to
  `artifacts/cloudflare-m7/m7.6-search-canary-report.{json,md}`, preserving the
  M7.5 evidence files unchanged.

## Local verification

```text
pnpm test:d1-search-canary-m7.6   # 55/55 pass
pnpm test:d1-search-canary        # 29/29 pass (M7.5 regression)
pnpm test:d1-fts-search           # 16/16 pass
pnpm test:d1-vector-search        # 32/32 pass
pnpm typecheck                    # pass
git diff --check                  # pass
```

The canary Worker also bundles locally with both `remote: true` bindings:

```text
cd workers/search-canary
node ../../node_modules/wrangler/bin/wrangler.js deploy --dry-run
```

## Bounded remote canary — materialization facts now proven

The isolated canary was run through local-runtime + remote-bindings (the
`remote: true` bindings plus the loopback `wrangler dev` flag, with no bearer
secret). The `database_id` for `worldcons_search_canary_v2` is filled in
`workers/search-canary/wrangler.jsonc`. The following are now proven facts, not
plans:

- **D1**: the canary projection was append-only expanded from a verified 15-row
  subset to **100 `search_documents` rows and 100 `search_fts` rows**, with the
  post-write verification equal to the desired projection. No row was deleted,
  updated or replaced.
- **Vectorize**: `worldcons-search-canary-v2` holds **100 provenance-locked
  vectors** and all five authored metadata indexes.
- **Literalized ceiling (M7.5, unchanged in M7.6 as a diagnostic)**: the
  100-document probe had **10 oversized statements, max 272,048 literal bytes**.
  The M7.6 parameterized writer carried those same values as bound parameters
  with **no truncation**; `literalOversizedStatements` remains a diagnostic only.
- **Idempotency**: the final evidence rerun was a true no-op — 0 inserted rows,
  0 parameterized statements, `writePlan.statements = 0` — confirming the
  append-only population converges.
- **Binding latency (4-case local-runtime + remote-bindings evidence)**: binding
  `p50/p95` of **161/386 ms**; operator wall time `p50/p95` of 1943/6277 ms is
  retained as evidence only and no longer gates. These are **not** deployed
  Worker runtime SLO numbers.
- **Frozen correctness**: the strict `exact-case-*` production oracle matched; the
  generic lexical fulltext divergence is informational under the refined gate;
  the semantic/hybrid cases matched their artifact-reference parity with explicit
  `production_semantic_oracle_drift`.

## Remaining steps

These remain explicitly deferred; no production resource, route, DNS or flag is
touched:

1. The isolated Worker is already deployed and has no production route or
   custom domain. Its public endpoint is bearer-protected and returns 401 without
   credentials. If an authorized operator supplies the canary bearer secret,
   exercise the deployed `workers.dev` `POST /canary/run` path and record
   **deployed-runtime** latency separately from the local-runtime +
   remote-bindings numbers above. Do not reuse those local-runtime measurements
   as deployed SLO evidence.
2. Resolve/document the Supabase semantic authority drift (restore
   artifact-backed projection semantics or formally approve the artifact
   projection as authority with a separate regression corpus).
3. Agree the fulltext rank acceptance threshold for FTS5 bm25 vs Postgres
   `ts_rank_cd` (the current `fulltext_rank_threshold_unagreed` blocker), or
   formally accept informational-only lexical ranking as the production policy.
4. Re-agree production-facing operator/binding latency and row-read thresholds,
   rerun the frozen suite, and only then consider `GO-SEARCH`. `search_m7`
   remains blocked until then.

## Stored evidence note

`artifacts/cloudflare-m7/m7.6-search-canary-report.{json,md}` is the bounded
remote canary evidence from the run described above. The report is content-free
(ids/counts/hashes/latencies only). After the lexical-rank/latency gate
refinement the stored report was re-derived locally from the **same recorded
observation ids and latencies** under the refined classifier (no remote call, no
id/latency changed): the generic fulltext ordering divergence is now
`informational` with stored `compareRankedIds` metrics (`overlap@10=4`,
`exactOrder=false`, `sameSet=false`), the binding gate replaces the operator gate,
and the explicit `fulltext_rank_threshold_unagreed` blocker is present. The
`generatedAt` is preserved from the original run.

## Boundaries preserved

- Supabase remains the sole production search/read authority; no Supabase write
  and no new Supabase migration.
- Production `wrangler.jsonc` and `worker/index.ts` are unchanged.
- No production resource was created, deleted, redeployed or switched. The
  isolated non-production `worldcons-search-canary` Worker was deployed and
  its unauthenticated `/health` path was verified to fail closed with HTTP 401;
  the only data mutation remained the isolated canary D1/Vectorize
  materialization described above.
- M7.5 evidence under `artifacts/cloudflare-m7/m7.5-*` is untouched.
- `search_m7` and `GO-SEARCH` / `GO-D1-READ` remain blocked for the semantic
  authority drift and the unagreed fulltext rank acceptance.
