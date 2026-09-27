# WorldCons Cloudflare M11.3 — ops_workflow_heartbeats Node/GitHub write boundary

Date: 2026-09-28
Base checkpoint: `9573173` (M11.2 admin-article-edit authority seam)

## Decision

**M11.3 introduces the minimal safe Cloudflare-native compatibility/write
boundary that Node/GitHub callers can invoke, and selects the append-only
`worldcons_ops.ops_workflow_heartbeats` surface as the first target.**

Code and focused tests are complete. The Cloudflare authority rests at
`WORLDCONS_OPS_HEARTBEAT_WRITE_AUTHORITY=supabase`, so Node/GitHub behavior is
byte-for-byte unchanged. No deploy, commit or push was performed and **no live
write canary is claimed**; a controller with Cloudflare credentials owns the
live canary.

## Why a boundary is needed

The remaining `worldcons_ops` writers selected by M11.0–M11.2 run from the
Cloudflare runtime and could use the M9 `WORLDCONS_SEARCH_SERVICE` Service
Binding compatibility bridge. `admin_ops_events` and `ops_workflow_heartbeats`
are different: their writers run from GitHub Actions and Node scripts
(`scripts/ops-watchdog.ts`, `scripts/summarize-pending.ts`,
`scripts/crawlee-worker.ts`, `scripts/backfill-*.ts`,
`scripts/admin-command-worker-p1.ts`, plus the Vercel fallback route
`app/api/ops/watchdog/route.ts`). GitHub Actions and Node cannot use a Worker
Service Binding at all.

Those callers currently hold `SUPABASE_SERVICE_ROLE_KEY` and call
`ops_workflow_heartbeat_v1`. Any migration of that write authority must let the
caller reach Cloudflare **without** holding a Cloudflare secret that grants more
than this one bounded write, and **without** exposing a weak public diagnostic
endpoint.

## Target inventory and selection

| Surface | Primary writer | Execution owner | Selection |
| --- | --- | --- | --- |
| `ops_workflow_heartbeats` | `recordWorkflowHeartbeat` (`lib/ops/workflow-heartbeat.ts`) | GitHub Actions + Node scripts + Vercel fallback route | **selected** |
| `admin_ops_events` | `recordAdminOpsEvent` / `recordWatchdogEvents` (`lib/ops/watchdog.ts`) | GitHub Actions (`admin-watchdog.yml` → `pnpm ops:watchdog`) + `app/api/ops/watchdog/route.ts` | deferred |
| `admin_jobs`, `admin_job_events` | `lib/db/admin-jobs.ts` | Node admin routes + P1 worker | deferred (mutable queue state) |
| `admin_command_*`, P5 evidence | command control plane | Node worker/scripts | deferred (higher-risk state machine) |
| MasterDash control/SSO, `llm_settings` | Node API routes | mutable upsert state | deferred |

`ops_workflow_heartbeats` was chosen as the lower-risk first target:

- **Append/upsert only.** One row per `workflow_key`, no read-modify-write in
  the caller, no cross-table transaction, no delete path in the writer.
- **Already a pure RPC.** The only authoritative write is the
  `ops_workflow_heartbeat_v1` SECURITY DEFINER upsert; the table itself grants
  `service_role` SELECT only. That makes the service-layer semantics (key
  pattern, status enum, run-id trim/length, detail size bound, timestamp carry)
  small, explicit and testable.
- **Single call path.** Every producer goes through
  `recordWorkflowHeartbeat`, so a single client seam covers all GitHub/Node
  callers at once.
- **No secret leakage required.** The heartbeat carries no article/credential
  material — only a bounded key, status, run id, timestamp and a small detail
  object.

`admin_ops_events` is deferred: its writer has a read-before-write dedupe path
(`recordWatchdogEvents` reads the latest signature) and a delete/prune path, so
it needs a slightly broader compatibility contract. It is the natural M11.4.

## Security model

Three separate trust boundaries, each least-privilege:

1. **Node/GitHub → Cloudflare boundary (public HTTPS, bearer).**
   `worldcons-ops-write` is a dedicated Worker with a **publicly reachable
   workers.dev endpoint** (`workers_dev=true`) and **preview URLs disabled**
   (`preview_urls=false`). It declares no `routes`/`route` and no custom domain,
   so the workers.dev endpoint is the only entry point. This is intentional:
   Node/GitHub cannot use a Worker Service Binding, so the boundary must be
   externally reachable. Its only network entries are `POST /v1/ops/heartbeat`
   and `GET /health`, both authenticated by a constant-time comparison of a
   bearer `OPS_WRITE_TOKEN` secret. There is no unauthenticated diagnostic
   endpoint: `GET /health` also requires the bearer and cannot be used as a
   public probe. The endpoint is therefore publicly reachable but
   bearer-authenticated and narrow — not private and not internal-only.
2. **Cloudflare boundary → D1 or Supabase.** The boundary resolves the write
   authority from its own `WORLDCONS_OPS_HEARTBEAT_WRITE_AUTHORITY` var,
   independent of the caller. `d1-canary` selects only the explicit canary run
   id; `d1` routes every heartbeat to `worldcons_ops` with one parameterized
   upsert (no caller value enters SQL text); `supabase` relays to the internal
   `worldcons-search` compatibility bridge. A D1 failure returns 503 and is
   **never** silently downgraded to Supabase.
3. **`worldcons-search` bridge → Supabase.** The bridge calls the
   `ops_workflow_heartbeat_v1` RPC with the existing M9 temporary Supabase
   credential, so the credential stays exactly where it already lives and is not
   copied into the GitHub caller path or the new Worker. `worldcons-search`
   remains internal-only (`workers_dev=false`, Service Binding only) and is not
   publicly reachable.

The new Worker reuses the existing M8 `BROWSER_RUN_TOKEN` constant-time bearer
pattern and the M9 private-bridge pattern. It does **not** broaden any existing
permission: the boundary can only upsert one heartbeat row and has no read API.
Its workers.dev endpoint is public but every path is behind the constant-time
bearer, so no unauthenticated caller can write or probe readiness.

## Preserved authority and rollback

- Default/resolving authority is `supabase`, so `recordWorkflowHeartbeat`
  returns early from the seam and keeps calling the existing local RPC. With the
  default, Node/GitHub sends nothing to the boundary at all, so leaving the
  boundary deployed is inert.
- Rollback is a single var change back to `supabase` (which disables the seam
  and restores the local RPC), with no schema or data change. Unsetting
  `WORLDCONS_OPS_WRITE_BASE_URL` alone is **not** a rollback: with the authority
  still `d1-canary`/`d1` the seam is enabled but unconfigured, so it fails closed
  rather than falling back. The boundary Worker and the D1 table can remain in
  place harmlessly.
- No old migration was edited; no D1/Postgres schema change was made.

## Files

- `lib/cloudflare/ops-write/heartbeat.ts` — shared contract: authority
  resolution, canary selector, RPC-equivalent validation, parameterized D1
  upsert.
- `lib/cloudflare/ops-write/boundary-client.ts` — Node/GitHub client seam.
- `workers/ops-write/{wrangler.jsonc,tsconfig.json,src/index.ts}` — publicly
  reachable, bearer-authenticated boundary Worker.
- `workers/search-service/src/index.ts` — new internal
  `/internal/ops-heartbeat/write` Supabase RPC bridge.
- `lib/ops/workflow-heartbeat.ts` — the real Node/GitHub call path now routes
  through the seam before falling back to the local RPC.
- `tests/m11-ops-heartbeat-write-boundary.test.ts` — 15 focused tests,
  including ones that assert the deployed `wrangler.jsonc` is externally
  reachable only via workers.dev with preview URLs disabled and mandatory bearer
  auth, and that `worldcons-search` stays internal-only.
- `package.json`, `tsconfig.json`, `.env.example` — scripts, excludes, docs.

## Verification (local, no live proof)

- `pnpm test:m11`: 35/35 (15 M11.3 + 20 existing M11).
- `pnpm test:m9`: 8/8.
- `pnpm test:ops`: 10/10.
- root `pnpm typecheck`: pass.
- `pnpm m11:ops-write:typecheck`: pass; `:types:check`: up to date.
- `pnpm m9:typecheck`: pass.
- `pnpm lint`: pass (0 errors, 0 warnings).
- `pnpm m11:ops-write:dry-run`: pass (bindings: `WORLDCONS_OPS` D1,
  `WORLDCONS_SEARCH_SERVICE`, authority var).
- `git diff --check`: clean.
- `pnpm check`: still fails only on the pre-existing, unrelated
  `summary drain workflow must run on its own schedule` assertion that also
  fails on the clean base checkout.

## Live-canary prerequisites (controller-owned; NOT performed here)

1. Deploy `worldcons-search` with `/internal/ops-heartbeat/write` (existing M9
   Supabase secret already present). It stays internal-only.
2. Deploy `worldcons-ops-write` with a set `OPS_WRITE_TOKEN` and resting
   `WORLDCONS_OPS_HEARTBEAT_WRITE_AUTHORITY=supabase`. Confirm the deployed
   workers.dev endpoint answers `/health` only with the bearer, and that
   `preview_urls` is disabled.
3. Set `WORLDCONS_OPS_WRITE_BASE_URL` (the workers.dev base URL)/
   `WORLDCONS_OPS_WRITE_TOKEN` on the GitHub/Node runner and hold the Node-side
   authority at `supabase`; capture baseline counts (D1 / Supabase).
4. **Coordinate both authority vars for the canary.** Switch the Node-side
   `WORLDCONS_OPS_HEARTBEAT_WRITE_AUTHORITY` to `d1-canary` *and* set the
   boundary Worker's own `WORLDCONS_OPS_HEARTBEAT_WRITE_AUTHORITY` to
   `d1-canary`; then drive one heartbeat whose `run_id` is exactly
   `m11-ops-heartbeat-canary` and confirm D1 +1 / Supabase unchanged. If the two
   vars disagree, the boundary applies its own var, so an unset boundary var
   would silently relay to the Supabase bridge.
   - **Reachability caveat.** `recordWorkflowHeartbeat` always derives `run_id`
     from `GITHUB_RUN_ID || VERCEL_DEPLOYMENT_ID || local-<pid>` and offers no
     override, so the real Node/GitHub call path cannot emit the canary run id.
     The canary is therefore driven by a controller-issued authenticated request
     to `POST /v1/ops/heartbeat` (or an equivalent one-off canary driver) that
     sets `run_id=m11-ops-heartbeat-canary`; the Node-side writer is only used to
     prove the seam routes to the boundary at all. This mirrors M11.0–M11.2,
     where the canary selector keys on caller-controlled input.
5. **Coordinate both authority vars for full `d1`.** Switch both the Node-side and
   boundary Worker authority vars to `d1` with an ordinary heartbeat; confirm
   D1 +1 / Supabase unchanged (the execution environment may block outbound
   calls, as it did for M11.1/M11.2 — if so, record the block and do not claim
   full `d1`).
6. Roll both authority vars back to `supabase`; confirm the ordinary RPC path
   resumes (Node sends nothing to the boundary under `supabase`).
7. Delete the canary row and restore pre-canary counts.

## Blockers

- Live canary requires Cloudflare/DB credential access not available in this
  environment; a controller owns it. No live write proof is claimed.
- **Read/write split.** Only the write authority is migrated here. Readers
  (`getWorkflowHeartbeats` → `lib/ops/watchdog.ts` and
  `app/api/masterdash/health/route.ts`) still read `ops_workflow_heartbeats`
  from Supabase, so a full `d1` write authority would leave those reads stale.
  That is acceptable for the bounded `d1-canary` row (which is never read) and
  is why a production `d1` cutover additionally requires an M11 read-authority
  parity step; no full-D1 ops read authority is claimed.
- `admin_ops_events` remains the next deferred target (M11.4), needing a
  bounded read+dedupe+prune compatibility contract.
- M11 is not globally complete: ingest and core/publication remain pending, and
  no full-D1 ops authority cutover is claimed.
