# WorldCons Cloudflare M11.4 ??admin_ops_events Node/GitHub authority seam

Date: 2026-09-28
Base checkpoint: `015397f869d261bebd2857305d64ad0c8dee8fcb` (M11.3R live D1 read parity)

## Decision

**M11.4 implements the bounded, fail-closed Cloudflare D1 compatibility path
for `worldcons_ops.admin_ops_events` that M11.3 deliberately deferred.**

Code and focused tests are complete. The M11.4R live read-only list
read-parity window has since run to PASS, and the M11.4 live write components
(bounded `d1-canary` insert, D1 read-before-write dedupe, D1 prune, and the
ordinary full-`d1` write) have since run to bounded PASS at head `6c44e5b`
(see the result sections below). The Cloudflare authority rests at
`WORLDCONS_ADMIN_OPS_EVENTS_WRITE_AUTHORITY=supabase` and
`WORLDCONS_ADMIN_OPS_EVENTS_READ_AUTHORITY=supabase`, so the Node/GitHub watchdog
behavior is byte-for-byte unchanged. No combined full-`d1` read/write cutover,
commit or push was performed by this documentation step.
**M11 is not complete**: ingest and core/publication remain pending.

## Why `admin_ops_events` is broader than the M11.3 heartbeat

M11.3 migrated `ops_workflow_heartbeats`, an append/upsert-only surface with one
row per key and no caller-side read-modify-write. `admin_ops_events` is different:
its sole writer, `recordWatchdogEvents` (`lib/ops/watchdog.ts`), runs a
**read-before-write dedupe** (it reads the latest event's `detail.signature` and
skips the insert when the signature is unchanged) and a **30-day retention
prune** (`OPS_EVENT_RETENTION_DAYS = 30`). The admin ops page additionally
consumes a **read projection** (`listAdminOpsEvents`). M11.4 therefore implements
insert, dedupe read, prune and list read while preserving all four exactly.

## Target contract inventory

| Concern | Resting Supabase behavior | M11.4 preservation |
| --- | --- | --- |
| Insert | `.from("admin_ops_events").insert({...})` | one parameterized D1 insert |
| Dedupe read | `.select("event_type, detail").order("created_at", desc).limit(1)`; `detail.signature === signature` skips the insert | one parameterized `ORDER BY created_at DESC LIMIT 1` |
| Prune | `.delete().lt("created_at", now - 30d)` | one parameterized `DELETE ... WHERE created_at < ?` |
| List read | `.select("*").order("created_at", desc).limit(limit)` | one parameterized `ORDER BY created_at DESC LIMIT ?` (default 20, max 100) |
| Admin consumer | `app/admin/ops/page.tsx` -> `listAdminOpsEvents(20)` | same record shape |

## Security model

M11.4 reuses the M11.3 boundary rather than inventing a new one. Three trust
boundaries, each least-privilege:

1. **Node/GitHub ??Cloudflare (public HTTPS, OIDC/bearer).** The existing
   `worldcons-ops-write` Worker (public workers.dev endpoint, preview URLs
   disabled, no routes/custom domain) gains four authenticated admin-ops-events
   paths under the same constant-time bearer / GitHub OIDC check:
   `POST /v1/ops/admin-events`, `GET /v1/ops/admin-events/latest`,
   `POST /v1/ops/admin-events/prune`, and the independently resolved read
   `GET /v1/ops/admin-events/list`. No unauthenticated write, read or diagnostic
   surface is added; `GET /health` remains bearer-gated.
2. **Cloudflare boundary ??D1 or Supabase.** The write authority
   (`WORLDCONS_ADMIN_OPS_EVENTS_WRITE_AUTHORITY`) resolves insert, dedupe read
   and prune together so they can never disagree; the read authority
   (`WORLDCONS_ADMIN_OPS_EVENTS_READ_AUTHORITY`) resolves the list read
   independently, exactly as M11.3R separated the heartbeat read. `d1-canary`
   selects only the explicitly marked canary window; `d1` routes everything; a
   D1 failure returns 503 and is **never** silently downgraded to Supabase.
3. **`worldcons-search` bridge ??Supabase.** The internal-only Worker gains
   `/internal/admin-ops-events*` and validates every body with the same
   runtime-neutral parser before writing; the existing M9 service-role credential
   stays exactly where it already lives and is not copied into the Node caller or
   the boundary.

All D1 statements are parameterized; no caller value enters SQL text. The
contract lives in `lib/cloudflare/ops-write/admin-ops-events.ts` and is
deliberately free of `node:*`/`next/*` so it bundles into both Workers and is
importable by the Node writer.

## Authority modes

- `WORLDCONS_ADMIN_OPS_EVENTS_WRITE_AUTHORITY=supabase|d1-canary|d1` (default
  `supabase`). `d1-canary` is a narrow selector: the Node writer adds the bounded
  `detail.m11AdminOpsEventsCanary=true` marker only while
  `WORLDCONS_ADMIN_OPS_EVENTS_CANARY_MARKER` is `true`/`1`, and the boundary
  accepts only that exact boolean marker. This is required because
  `admin_ops_events` has no run-id column and its `event_type` enum is fixed by
  the Postgres check constraint (which cannot be edited).
- `WORLDCONS_ADMIN_OPS_EVENTS_READ_AUTHORITY=supabase|d1` (default `supabase`,
  no `d1-canary` read mode).

Rollback is one var back to `supabase`; no schema or old migration was edited.

## GitHub Actions wiring

The concrete live-canary blocker was that `.github/workflows/admin-watchdog.yml`
never injected the M11.4 authority seam into the Node watchdog process. The
minimum safe wiring is:

- `WORLDCONS_ADMIN_OPS_EVENTS_WRITE_AUTHORITY: ${{ vars.WORLDCONS_ADMIN_OPS_EVENTS_WRITE_AUTHORITY || 'supabase' }}`
  and `WORLDCONS_ADMIN_OPS_EVENTS_READ_AUTHORITY: ${{ vars.WORLDCONS_ADMIN_OPS_EVENTS_READ_AUTHORITY || 'supabase' }}`
  are injected from repo vars with an explicit `supabase` fallback, so the
  resting watchdog write/read path is unchanged. The existing authenticated
  boundary base URL and per-job GitHub OIDC audience are reused; no shared secret
  is added and `WORLDCONS_OPS_WRITE_TOKEN` stays unset.
- The canary marker is **not** a persistent repo var. A
  `workflow_dispatch`-only boolean input `admin_ops_events_canary` (default
  `false`) sets
  `WORLDCONS_ADMIN_OPS_EVENTS_CANARY_MARKER: ${{ github.event_name == 'workflow_dispatch' && inputs.admin_ops_events_canary == true && 'true' || '' }}`,
  so only that dispatched run is marked and scheduled/ordinary runs stay
  unmarked. There is deliberately no
  `vars.WORLDCONS_ADMIN_OPS_EVENTS_CANARY_MARKER` fallback.
- The M11.3 heartbeat canary/read-parity inputs and behavior are unchanged.

## Verification

`test:m11` 120/120 (including the 11 new M11.4R read-parity tests), `test:m8`
23/23, `test:ops` 10/10, `test:masterdash` 22/22, `test:gate0` 4/4, M9 8/8, M10
5/5, admin-ops-reads 16/16, admin-ops-read-shadow 23/23, root and
ops-write/search-service typechecks, worker types check, lint (0 warnings),
`pnpm ops:admin-events-read-parity` dry-run (no network call), ops-write dry-run
with both admin-ops-events vars at `supabase`, and `git diff --check` pass. The
`test:postgres:release:static` (`test:d1-schema`) failure is a **pre-existing**
Windows CRLF artifact (`\n` emitter vs `\r\n` working copy) reproduced at clean
HEAD; the `m11:ops-write:types:check` failure is likewise a **pre-existing**
Windows wrangler issue reproduced at clean HEAD.

## M11.4R read-only `admin_ops_events` list parity probe

M11.4R is a **strictly READ-ONLY** parity gate for the `admin_ops_events` list
projection, modeled on the M11.3R heartbeat read-parity tooling but scoped to the
admin list. It compares the canonical Supabase `listAdminOpsEvents(limit=20)`
projection against the boundary/D1 read for the same 20 newest rows. It performs
**no** insert, **no** prune, **no** watchdog run and **no** heartbeat/event
mutation, and it changes no authority.

- **Comparator** `lib/cloudflare/ops-write/admin-ops-events-read-parity.ts`
  (runtime-neutral, no `node:*`/`next:*`). Unlike the M11.3R heartbeat (one row
  per authored key), the list is arbitrary and ordered, so the comparison is
  **order-aware and id-aligned**: array positions are compared one-to-one,
  `id`/`event_type`/`severity`/`source_key`/`summary`/`detail` are compared
  exactly, and `detail` is normalized to **canonical JSON** (recursively
  key-sorted) so Supabase JSONB and the D1 TEXT copy cannot create a false
  difference. `created_at` is compared by **instant** (`Date.parse`) because
  PostgREST `timestamptz` and D1 canonical UTC ISO-8601 TEXT may print the same
  instant differently. `AdminOpsEventsReadParityDifference` records the row
  `index` and `id` (or `null`) so evidence is unambiguous.
- **Canonical Supabase node** `readAdminOpsEventsFromSupabase(limit)` in
  `lib/ops/watchdog.ts` (extracted read-only from `listAdminOpsEvents`): the same
  `select("*")`, `order("created_at", desc)`, `limit(limit)` and defensive row
  mapping, so the left node is the exact admin list projection. Returns `null`
  only when Supabase is unconfigured; a query error throws (never a silent empty
  list).
- **Boundary/D1 node** `listAdminOpsEventsViaBoundary(20)` against the existing
  authenticated `GET /v1/ops/admin-events/list?limit=20`; the probe forces the
  admin read authority to `d1` **only in its own request environment**, so no
  repository or Worker authority changes. Under a resting `supabase` boundary the
  endpoint returns the fail-closed `503 READ_AUTHORITY_UNAVAILABLE` and the probe
  reports a mismatch rather than a false pass.
- **Optional independent direct-D1 node** `readAdminOpsEventsViaHttp(execute, 20)`:
  one parameterized `SELECT id, event_type, severity, source_key, summary, detail,
  created_at FROM admin_ops_events ORDER BY created_at DESC LIMIT ?` through the
  D1 HTTP query API (operator credential only).
- **Probe CLI** `scripts/ops-admin-events-read-parity.ts` / `pnpm
  ops:admin-events-read-parity`, mirroring the M11.3R probe: `--run`, `--report`,
  `--json`, `--no-direct-d1`, `--base-url=`; `--apply` is rejected. It emits a
  machine-readable JSON evidence artifact
  (`artifacts/cloudflare-m11/m11.4r-admin-ops-events-read-parity-live-evidence.json`)
  containing only the compared records (with `detail` canonicalized), booleans
  and counts; it never prints a token or credential.
- **Feature-branch dispatch shell.** A brand-new workflow cannot be
  `workflow_dispatch`-ed before it exists on the default branch (GitHub 404), so
  the already-present `admin-watchdog.yml` gains a `workflow_dispatch`-only
  boolean `admin_ops_events_read_parity_only` (default `false`). When true the
  watchdog/compensation step is skipped and the job runs **only**
  `pnpm ops:admin-events-read-parity -- --run --no-direct-d1 --report --json`,
  authenticating the boundary with the existing per-job GitHub OIDC `id-token`
  and reading Supabase only with the existing secrets. The M11.3R
  `read_parity_only` input and all normal watchdog behavior are unchanged.
- **Focused tests** `tests/m11-admin-ops-events-read-parity.test.ts` (11 tests):
  order/id alignment, canonical-JSON `detail`, instant timestamps, missing-row and
  length differences, the single parameterized direct-D1 read and its fail-closed
  limit/row validation, the dispatch-only boolean, the watchdog-skip/probe-only
  step wiring, and a source assertion that the probe never invokes a writer,
  insert, prune, watchdog or heartbeat path.

At code-complete time **no live M11.4R PASS was claimed**: the probe was
code-ready and a controller owned the live window (set the boundary admin read
authority to `d1`, dispatch `admin_ops_events_read_parity_only=true`, then roll
back). That live window has since run; see the result section below and
`artifacts/cloudflare-m11/m11.4r-admin-ops-events-read-parity-20260928.json`.

## M11.4R live read-parity result (2026-09-28, bounded PASS)

The controller live window has now run. At clean HEAD `3f584f239b3c7f82f08b705e699a34bb8e3949d5`
the baseline was Supabase `admin_ops_events` count 412 and D1 count 412, and the
latest 20 IDs/order matched. The canary/read-parity Worker version
`38b27a5b-ae1a-4d1d-94a1-49ee51236e7d` ran with `admin_ops_events` write authority
`supabase`, read authority `d1`, heartbeat write/read `supabase`, and OIDC allowed
refs `main` + `codex/m7-go-search`; unauthenticated
`GET /v1/ops/admin-events/list?limit=20` returned `401`.

GitHub `workflow_dispatch` run `36379545354` at head `3f584f23` with
`admin_ops_events_read_parity_only=true` completed **success**. The watchdog step,
the heartbeat M11.3R read probe, and all write-capable work were **skipped**; only
the `admin_ops_events` read-only parity step and the evidence upload ran. The
downloaded workflow artifact reports `boundaryCount` 20, `supabaseCount` 20,
`boundaryVsSupabase.holds=true`, `differences=[]`, `directD1` disabled in GitHub,
`ok=true`. **Because the boundary read authority was `d1`, boundary-vs-Supabase is
itself a D1 projection comparison.** The direct-D1 GitHub leg was intentionally
skipped (`--no-direct-d1`); independently the controller confirmed the D1
count/top-20 identity.

Cloudflare Observability saw exactly one authenticated `GET` for this parity run
(status `200`, outcome `ok`, `wallTimeMs` 471, auth-failure count 0, on version
`38b27a5b`). After the run Supabase count remained 412, D1 count remained 412, and
the Supabase watchdog `run_id` remained the prior `36377461933`, proving that no
heartbeat/watchdog/admin-event write occurred during this read-only run. The Worker
was restored to resting version `bc257622-da6e-45fb-9be3-46d9c0e56991` with
`admin_ops_events` write/read `supabase` and no temporary allowed-refs binding;
unauthenticated list `GET` returns `401`.

This marks **LIVE-READ-PARITY-PASS for M11.4R**. It does **not** claim a combined
full-`d1` `admin_ops_events` read/write cutover or M11 completion (ingest and
core/publication remain pending). See
`artifacts/cloudflare-m11/m11.4r-admin-ops-events-read-parity-live-evidence-20260928.json`.

## M11.4 live write result (2026-09-28, bounded component PASS)

At head `6c44e5b` the controller ran three `admin-watchdog` dispatches that
live-exercised the M11.4 `admin_ops_events` D1 write paths while read authority
rested at `supabase`. Because a selected D1 insert returns `200` only when the
bound parameterized insert actually succeeded (the boundary fails closed with a
`503`/throw otherwise and never silently downgrades to Supabase), the observed
`200` responses prove the D1 inserts executed.

- **Bounded `d1-canary` insert — PASS.** Run `36377157726` ran with
  `WORLDCONS_ADMIN_OPS_EVENTS_WRITE_AUTHORITY=d1-canary`, read `supabase`, and
  `WORLDCONS_ADMIN_OPS_EVENTS_CANARY_MARKER=true`. Worker version
  `cc448d9b-566c-465a-8ee9-dcfc2aef42c7` carried admin write `d1-canary`, read
  `supabase`, and the temporary feature allowed-refs binding. Cloudflare
  Observability recorded `GET /v1/ops/admin-events/latest` `200`,
  `POST /v1/ops/admin-events` `200` and `POST /v1/ops/admin-events/prune` `200`.
  The marked event therefore landed in D1 only, with the dedupe read and prune
  resolving to D1 and ordinary events still on Supabase.
- **D1 read-before-write dedupe — PASS.** Run `36377256343` ran on the same
  authority and Worker version `cc448d9b` and produced the same watchdog
  violation signature, but Observability shows `GET /latest` `200` and
  `POST /prune` `200` with **no** `POST /admin-events`. The dedupe read resolved
  the same latest signature on D1 and skipped the insert while prune still ran on
  D1, proving the dedupe-skipped-insert-while-still-pruning contract against D1.
- **Ordinary full-`d1` write — PASS.** Run `36377461933` ran with
  `WORLDCONS_ADMIN_OPS_EVENTS_WRITE_AUTHORITY=d1`, read `supabase` and an empty
  canary marker. Worker version `87f3acb5-6843-4118-bb7f-cc0f51a0f5e9` carried
  admin write `d1`, read `supabase` and the feature allowed-refs binding.
  Observability recorded `GET /latest` `200`, `POST /admin-events` `200` and
  `POST /prune` `200`, proving the ordinary full-D1 write path (dedupe read +
  successful parameterized insert + prune) under full `d1` authority.

At 04:21 a resting Worker version `d9ccf235-e4c6-4e78-9fdc-fdcaec122428` carried
admin write/read `supabase` with no feature allowed-refs binding, and controller
unauthenticated endpoint probes returned `401` as expected.

**Post-live clean state.** Current/reconciled production holds Supabase and D1
`admin_ops_events` both at **412** with matching latest-20 identity. Any temporary
canary or full-write D1 rows have already been cleaned/deleted and reconciled and
must **not** be reintroduced. This `412/412` clean state is the post-live
reconciled state and is explicitly **not** evidence that the historical inserts
did not happen.

This marks the M11.4 write **components** as bounded PASS. It does **not** claim a
combined full-`d1` `admin_ops_events` read/write cutover or M11 completion. See
`artifacts/cloudflare-m11/m11.4-admin-ops-events-write-live-evidence-20260928.json`.

## What is NOT claimed

- No combined full-`d1` `admin_ops_events` read/write cutover, no deploy, commit or push.
- No M11 completion: ingest and core/publication remain pending.
- The `412/412` reconciliation is the post-live clean state, not evidence the historical D1 inserts did not happen.

## Safest next live canary sequence (controller)

1. Deploy `worldcons-search` with `/internal/admin-ops-events*`; confirm it stays
   internal-only (`workers_dev=false`, Service Binding only). **(DONE)**
2. Deploy `worldcons-ops-write` with both admin-ops-events vars at `supabase`;
   confirm the four new paths return 401 without auth and the boundary remains
   workers.dev-only with preview URLs disabled. **(DONE)**
3. Capture baseline `admin_ops_events` counts on Supabase and on `worldcons_ops`
   D1. **(DONE)**
4. Write canary: coordinate both write vars to `d1-canary` and dispatch
   `admin-watchdog` with `admin_ops_events_canary=true`. **(DONE — bounded
   `d1-canary` insert PASS, run `36377157726`; second-run D1 dedupe PASS, run
   `36377256343`.)**
5. Full write window: coordinate both write vars to `d1` with an ordinary run.
   **(DONE — ordinary full-`d1` write PASS, run `36377461933`.)**
6. Read parity (M11.4R, read-only). **(DONE — M11.4R LIVE-READ-PARITY-PASS, run
   `36379545354`, recorded at commit `877f138a`.)**
7. Roll every write/read var and binding back to `supabase`; confirm the direct
   Supabase writer/reader resumes. **(DONE)**
8. Delete the canary event(s) and restore pre-canary counts. **(DONE — Supabase
   and D1 reconciled at 412/412, latest-20 identity matched.)**

**Next gate.** The deliberate combined full-`d1` `admin_ops_events` read/write
window, using the already-proven write components (bounded `d1-canary` insert,
D1 dedupe read, D1 prune, ordinary full-`d1` write) and the already-proven read
component (M11.4R D1 list read parity). This is explicitly **not** claimed yet.

See `artifacts/cloudflare-m11/m11.4-admin-ops-events-authority-seam-20260928.json`.
