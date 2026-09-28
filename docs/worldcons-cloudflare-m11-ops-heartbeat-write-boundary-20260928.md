# WorldCons Cloudflare M11.3 ??ops_workflow_heartbeats Node/GitHub write boundary

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

The remaining `worldcons_ops` writers selected by M11.0?�M11.2 run from the
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
| `admin_ops_events` | `recordAdminOpsEvent` / `recordWatchdogEvents` (`lib/ops/watchdog.ts`) | GitHub Actions (`admin-watchdog.yml` ??`pnpm ops:watchdog`) + `app/api/ops/watchdog/route.ts` | deferred |
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
  material ??only a bounded key, status, run id, timestamp and a small detail
  object.

`admin_ops_events` is deferred: its writer has a read-before-write dedupe path
(`recordWatchdogEvents` reads the latest signature) and a delete/prune path, so
it needs a slightly broader compatibility contract. It is the natural M11.4.

## Security model

Three separate trust boundaries, each least-privilege:

1. **Node/GitHub ??Cloudflare boundary (public HTTPS, bearer).**
   `worldcons-ops-write` is a dedicated Worker with a **publicly reachable
   workers.dev endpoint** (`workers_dev=true`) and **preview URLs disabled**
   (`preview_urls=false`). It declares no `routes`/`route` and no custom domain,
   so the workers.dev endpoint is the only entry point. This is intentional:
   Node/GitHub cannot use a Worker Service Binding, so the boundary must be
   externally reachable. Its only network entries are `POST /v1/ops/heartbeat`,
   `GET /health` and (from M11.3R) the read-only `GET /v1/ops/heartbeats`, all
   authenticated by a constant-time comparison of a
   bearer `OPS_WRITE_TOKEN` secret. There is no unauthenticated diagnostic
   endpoint: `GET /health` also requires the bearer and cannot be used as a
   public probe. The endpoint is therefore publicly reachable but
   bearer-authenticated and narrow ??not private and not internal-only.
2. **Cloudflare boundary ??D1 or Supabase.** The boundary resolves the write
   authority from its own `WORLDCONS_OPS_HEARTBEAT_WRITE_AUTHORITY` var,
   independent of the caller. `d1-canary` selects only the explicit canary run
   id; `d1` routes every heartbeat to `worldcons_ops` with one parameterized
   upsert (no caller value enters SQL text); `supabase` relays to the internal
   `worldcons-search` compatibility bridge. A D1 failure returns 503 and is
   **never** silently downgraded to Supabase.
3. **`worldcons-search` bridge ??Supabase.** The bridge calls the
   `ops_workflow_heartbeat_v1` RPC with the existing M9 temporary Supabase
   credential, so the credential stays exactly where it already lives and is not
   copied into the GitHub caller path or the new Worker. `worldcons-search`
   remains internal-only (`workers_dev=false`, Service Binding only) and is not
   publicly reachable.

The new Worker reuses the existing M8 `BROWSER_RUN_TOKEN` constant-time bearer
pattern and the M9 private-bridge pattern. It does **not** broaden any existing
permission: the boundary can only upsert one heartbeat row and, from M11.3R,
serve one bounded read of the same row set; both stay behind the same bearer.
Its workers.dev endpoint is public but every path is behind the constant-time
bearer, so no unauthenticated caller can write or probe readiness.

## GitHub Actions / Node environment plumbing

The boundary is only reachable if the GitHub-hosted Node jobs actually receive
its three configuration inputs. All heartbeat-producing workflows now inject
them, without committing any value:

| Workflow | Heartbeat entrypoint | Env blocks |
| --- | --- | --- |
| `.github/workflows/crawlee-worker.yml` | `crawl`: `crawl:worker`/`admin:worker:p1`; `postprocess`: `summarize-pending` | 2 |
| `.github/workflows/summary-drain.yml` | `summarize-pending` | 1 |
| `.github/workflows/embedding-backfill.yml` | `backfill:embeddings` | 1 |
| `.github/workflows/admin-watchdog.yml` | `ops:watchdog` | 1 |
| `.github/workflows/admin-command-worker-p1.yml` | `admin:worker:p1` | 1 |

Each job env block carries exactly:

```yaml
WORLDCONS_OPS_HEARTBEAT_WRITE_AUTHORITY: ${{ vars.WORLDCONS_OPS_HEARTBEAT_WRITE_AUTHORITY || 'supabase' }}
WORLDCONS_OPS_WRITE_BASE_URL: ${{ vars.WORLDCONS_OPS_WRITE_BASE_URL }}
WORLDCONS_OPS_WRITE_TOKEN: ${{ secrets.WORLDCONS_OPS_WRITE_TOKEN }}
```

- **Authority defaults to `supabase`.** The `vars.WORLDCONS_OPS_HEARTBEAT_WRITE_AUTHORITY
  || 'supabase'` expression resolves to `supabase` whenever the repository
  variable is absent or empty, which is the resting mode. Node/GitHub behavior
  is therefore byte-for-byte unchanged until an operator explicitly sets the
  repo variable. `resolveOpsHeartbeatWriteAuthorityConfig` also treats any
  unrecognized value as `supabase`, so a typo fails safe rather than enabling
  the seam.
- **Base URL/token are repository `vars`/`secrets`.** `WORLDCONS_OPS_WRITE_BASE_URL`
  is a (non-secret) repository variable; `WORLDCONS_OPS_WRITE_TOKEN` is a
  repository secret. Neither value appears in a source file: the workflows
  only carry `${{ vars.* }}`/`${{ secrets.* }}` references, and the token is a
  secret so GitHub redacts it from logs. The client only consults URL/token when
  the authority is `d1-canary`/`d1`, so under the resting authority the empty
  token is inert.
- **`backfill-corpus` (`catalog_backfill`).** `scripts/backfill-corpus.ts`
  writes a `catalog_backfill` heartbeat, but it is an operator-run Gate-1 CLI
  with no GitHub Actions workflow, so there is no workflow job to plumb. It
  inherits the same `lib/ops/workflow-heartbeat.ts` seam and reads the same
  three process env vars when an operator sets them.
- **Vercel fallback unchanged.** The fallback route
  `app/api/ops/watchdog/route.ts` reads the same process env; its authority
  stays `supabase`, so it keeps using the local RPC. No Vercel-side change was
  made.
- **Not yet wired: `admin-job-worker.yml`.** `scripts/admin-job-worker.ts`
  currently produces no workflow heartbeat (it uses an internal queue
  heartbeat, not `recordWorkflowHeartbeat`), so it was left unchanged. If it
  later emits a workflow heartbeat it must be added to this table.

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

- `lib/cloudflare/ops-write/heartbeat.ts` ??shared contract: authority
  resolution, canary selector, RPC-equivalent validation, parameterized D1
  upsert.
- `lib/cloudflare/ops-write/boundary-client.ts` ??Node/GitHub client seam.
- `workers/ops-write/{wrangler.jsonc,tsconfig.json,src/index.ts}` ??publicly
  reachable, bearer-authenticated boundary Worker.
- `workers/search-service/src/index.ts` ??new internal
  `/internal/ops-heartbeat/write` Supabase RPC bridge.
- `lib/ops/workflow-heartbeat.ts` ??the real Node/GitHub call path now routes
  through the seam before falling back to the local RPC.
- `.github/workflows/{crawlee-worker,summary-drain,embedding-backfill,admin-watchdog,admin-command-worker-p1}.yml`
  ??each heartbeat-producing job env block wires the authority (repo var,
  defaulting to `supabase`), base URL (repo var) and token (repo secret) into
  the Node process.
- `tests/m11-ops-heartbeat-write-boundary.test.ts` ??17 focused tests,
  including ones that assert the deployed `wrangler.jsonc` is externally
  reachable only via workers.dev with preview URLs disabled and mandatory bearer
  auth, that `worldcons-search` stays internal-only, and that every
  heartbeat-producing workflow wires the boundary env from `vars`/`secrets`
  with a `supabase` default and no committed token value.
- `package.json`, `tsconfig.json`, `.env.example` ??scripts, excludes, docs.

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
3. Set the repository variables/secrets the workflows already reference:
   `WORLDCONS_OPS_WRITE_BASE_URL` (repo **var**, the workers.dev base URL) and
   `WORLDCONS_OPS_WRITE_TOKEN` (repo **secret**, the Worker's `OPS_WRITE_TOKEN`),
   and leave `WORLDCONS_OPS_HEARTBEAT_WRITE_AUTHORITY` (repo var) unset or
   `supabase`; capture baseline counts (D1 / Supabase). The workflow plumbing is
   already in place, so this step is variable/secret creation only.
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
     prove the seam routes to the boundary at all. This mirrors M11.0?�M11.2,
     where the canary selector keys on caller-controlled input.
5. **Coordinate both authority vars for full `d1`.** Switch both the Node-side and
   boundary Worker authority vars to `d1` with an ordinary heartbeat; confirm
   D1 +1 / Supabase unchanged (the execution environment may block outbound
   calls, as it did for M11.1/M11.2 ??if so, record the block and do not claim
   full `d1`).
6. Roll both authority vars back to `supabase`; confirm the ordinary RPC path
   resumes (Node sends nothing to the boundary under `supabase`).
7. Delete the canary row and restore pre-canary counts.

## Blockers

- Live canary requires Cloudflare/DB credential access not available in this
  environment; a controller owns it. No live write proof is claimed.
- **Read/write split was resolved by M11.3R (see below).** Only the write
  authority is migrated here; readers were addressed by the separate M11.3R
  read-authority parity step.
- `admin_ops_events` remains the next deferred target (M11.4), needing a
  bounded read+dedupe+prune compatibility contract.
- M11 is not globally complete: ingest and core/publication remain pending, and
  no full-D1 ops authority cutover is claimed.

## M11.3R ??ops_workflow_heartbeats read-authority parity

Date: 2026-09-28. This is the read-authority parity step M11.3 explicitly
deferred. It is **read-only** and resolves the read authority **independently**
of the write authority, so a staging write canary can never silently change what
a reader sees.

### Decision

Add a separate `WORLDCONS_OPS_HEARTBEAT_READ_AUTHORITY=supabase|d1` seam with a
resting `supabase` default. `d1` selects the migrated `worldcons_ops` read.
There is deliberately **no `d1-canary` read mode**: a partial read is not a
meaningful state, so the only non-resting mode is the full `d1` read.

### Why not couple reads to writes

`getWorkflowHeartbeats` (`lib/ops/workflow-heartbeat.ts`) feeds
`lib/ops/watchdog.ts` and `app/api/masterdash/health/route.ts`. If reads simply
followed the write authority, a `d1-canary` write would leave ordinary
(non-canary) readers reading stale Supabase rows, and a full `d1` write with a
Supabase read would silently diverge. Separating the two authorities makes the
cutover an explicit, individually reversible operator action.

### Architecture

- **Node/GitHub reader (watchdog job, masterdash route on Vercel).** When the
  read authority is `d1`, `getWorkflowHeartbeats` calls
  `readOpsHeartbeatsViaBoundary`, which issues one authenticated
  `GET /v1/ops/heartbeats` to the existing publicly reachable,
  bearer-authenticated `worldcons-ops-write` boundary using the same base URL and
  token as the write path. No new credential, host or unauthenticated surface is
  added.
- **Cloudflare runtime reader (masterdash route on Workers).** The main Worker
  entry resolves its own `WORLDCONS_OPS_HEARTBEAT_READ_AUTHORITY` var into a
  runtime slot; `resolveEffectiveOpsHeartbeatReadAuthorityConfig` prefers that
  slot over `process.env`, and `getWorkflowHeartbeats` reads the isolated
  `WORLDCONS_OPS` D1 binding registered on the runtime slot directly (no HTTP
  hop). In a Node/GitHub process no binding is registered, so the same authority
  is served through the authenticated boundary.
- **Boundary read.** `GET /v1/ops/heartbeats` requires the constant-time bearer.
  It resolves the read authority independently. Under `d1` it runs one
  parameterized `SELECT workflow_key, last_started_at, last_completed_at,
  last_status, run_id FROM ops_workflow_heartbeats WHERE workflow_key IN (?, ...)`
  over the five authored keys ??the exact projection the Supabase reader uses, no
  `detail`/`updated_at`. Under the resting `supabase` it returns a fail-closed
  `503 READ_AUTHORITY_UNAVAILABLE` and **never** relays Supabase, so a caller that
  selected the D1 read authority can never be silently served a Supabase row.

### Fail-closed guarantee

- Selected `d1` with no configured base URL/token, a non-2xx response, a
  malformed body, an unavailable binding or a failed query all **throw**. The
  watchdog already treats an unavailable heartbeat read as a
  `workflow-heartbeat-unavailable` warning and the masterdash route as degraded,
  so the failure is visible rather than masked.
- A malformed D1 envelope or non-object row throws rather than returning a
  silently shorter list, so "no rows" can never be confused with "broken read".

### Column/row parity

The D1 row is mapped to the same `WorkflowHeartbeatRecord` shape
(`workflowKey`, `lastStartedAt`, `lastCompletedAt`, `lastStatus`, `runId`) and
applies the same defensive filter (unknown key, missing start timestamp, invalid
status are dropped). The canonical key list now lives in the runtime-neutral
contract (`OPS_HEARTBEAT_WORKFLOW_KEYS`) so the Worker and the Node reader agree.

### Preserved behavior and rollback

- Resting read authority is `supabase`: `getWorkflowHeartbeats` returns early
  and keeps the existing local Supabase read byte-for-byte. With the default,
  `readOpsHeartbeatsViaBoundary` returns `null` and nothing is sent.
- Rollback is one var change back to `supabase`, with no schema or data change.
- No old migration was edited; no D1/Postgres schema change was made.

### Files (M11.3R)

- `lib/cloudflare/ops-write/heartbeat.ts` ??read authority resolver + runtime
  slot, canonical keys, `parseOpsHeartbeatReadRow/Record`, parameterized
  `readOpsHeartbeatsFromD1`.
- `lib/cloudflare/ops-write/boundary-client.ts` ??`readOpsHeartbeatsViaBoundary`
  Node/GitHub client.
- `lib/ops/workflow-heartbeat.ts` ??`getWorkflowHeartbeats` selects the D1 read
  boundary when the read authority is `d1`, fails closed.
- `workers/ops-write/src/index.ts` ??bearer-authenticated
  `GET /v1/ops/heartbeats`.
- `workers/ops-write/wrangler.jsonc` ??resting `WORLDCONS_OPS_HEARTBEAT_READ_AUTHORITY=supabase`.
- `worker/index.ts`, `wrangler.jsonc` ??Cloudflare runtime read-authority slot.
- `.github/workflows/admin-watchdog.yml` ??read authority repo var (default
  `supabase`); `.env.example` ??documented.
- `tests/m11-ops-heartbeat-read-authority.test.ts` ??12 focused tests.

### M11.3R verification (local, no live proof)

- `pnpm test:m11`: 49/49 (12 new read-authority + 37 existing M11).
- `pnpm test:ops`: 10/10; `pnpm test:masterdash`: 22/22; `pnpm test:m9`: 8/8;
  `pnpm test:m10`: 5/5.
- root `pnpm typecheck`: pass; `pnpm m11:ops-write:typecheck`: pass;
  `pnpm m11:ops-write:types:check`: up to date; `pnpm m9:typecheck`: pass.
- `pnpm lint`: pass (0 errors, 0 warnings).
- `pnpm m11:ops-write:dry-run`: pass (bindings include the resting
  `WORLDCONS_OPS_HEARTBEAT_READ_AUTHORITY ("supabase")`).
- `git diff --check`: clean.

### M11.3R live-read prerequisites (controller-owned; NOT performed here)

1. Deploy `worldcons-ops-write` with the read authority resting at `supabase`
   and confirm `GET /v1/ops/heartbeats` requires the bearer (401 without it).
2. Deploy the main Worker with the read authority resting at `supabase`.
3. Set repo var `WORLDCONS_OPS_HEARTBEAT_READ_AUTHORITY` (`d1`) **and** the
   boundary Worker's own read var (`d1`), mirroring the write-authority
   coordination; confirm `GET /v1/ops/heartbeats` returns the same records the
   Supabase reader returns for the five authored keys (compare
   `workflow_key/last_started_at/last_completed_at/last_status/run_id`).
4. Confirm ordinary Node/GitHub and Cloudflare readers now read D1.
5. Roll the read authority back to `supabase` and confirm the local read resumes.

## M11.3-OIDC ??GitHub Actions OIDC trust for the boundary

Date: 2026-09-28. This step is the direct follow-up to M11.3: the original
design authenticated GitHub-hosted callers with the shared repository secret
`WORLDCONS_OPS_WRITE_TOKEN`. Provisioning that secret was blocked by the
execution environment's credential-transfer safety inspection. M11.3-OIDC
replaces the shared secret with short-lived, per-job GitHub Actions OIDC
tokens, so the boundary and its GitHub callers need **no shared repository
secret at all**.

### Decision

The `worldcons-ops-write` boundary now accepts **either** of two trust paths:

1. **Primary ??GitHub Actions OIDC (secret-free).** A GitHub-hosted job grants
   `id-token: write`, the Node client requests a JWT for the dedicated audience
   `worldcons-ops-write` from the Actions OIDC endpoint at runtime, and the
   boundary verifies it in-Worker before authorizing the request.
2. **Secondary ??optional constant-time `OPS_WRITE_TOKEN` bearer.** Retained
   only for operator canary calls and non-GitHub callers. It is **no longer a
   required Wrangler secret**, so the first Worker creation succeeds without it,
   and it is checked only after OIDC fails.

### Strict verification

`lib/cloudflare/ops-write/github-oidc.ts` (runtime-neutral; no `node:*`/`next/*`)
implements the trust policy. It is fail-closed on every error and never logs or
returns token material.

- **Discovery/JWKS.** Fetched only from the exact issuer
  `https://token.actions.githubusercontent.com`. A discovery document whose
  `issuer` is not exact, or whose `jwks_uri` does not live under the issuer
  origin, is rejected. JWKS keys must be `kty=RSA`, `use=sig` (or unset),
  `alg=RS256` (or unset) and have a modulus of at least 2048 bits.
- **Signature.** Only `RS256` is accepted (`alg: none` and HMAC are rejected);
  the signature is verified with `crypto.subtle` against the discovered key, and
  a `kid` is required.
- **Claims.** `iss` must equal the exact issuer; `aud` must equal the dedicated
  audience; `repository` must equal `kjw2/worldcons`.
- **Workflow/ref binding.** `workflow_ref` must resolve to a
  `.github/workflows/<file>.yml` in the per-operation allowlist and its embedded
  ref must equal the `ref` claim exactly. Write trusts the five heartbeat
  workflows; read trusts only `admin-watchdog.yml`. A brand-new workflow added to
  the repository is rejected even though repository and audience match.
- **Time.** `exp`, `nbf` and `iat` are all required; `nbf <= exp`; each is
  validated against the current time with a bounded skew (default 60s, capped at
  300s).
- **Replay.** A `jti` is required and single-use within its live window. This is
  a bounded, process-local (per-isolate) control; replay is prevented
  "where practical within Workers constraints", not claimed as a globally
  consistent ledger.
- **Caching.** JWKS is cached with a TTL and a bounded refetch for an unknown
  `kid`; the `jti` cache is bounded and swept.

### Node/GitHub client

`lib/cloudflare/ops-write/boundary-client.ts` prefers OIDC: it uses an explicit
`WORLDCONS_OPS_WRITE_OIDC_TOKEN` when present, otherwise requests a live token
from `ACTIONS_ID_TOKEN_REQUEST_URL` for the configured audience, and only then
falls back to the optional `WORLDCONS_OPS_WRITE_TOKEN` bearer. The requested
token is used in the `Authorization` header and is never logged. The dedicated
audience is read from `WORLDCONS_OPS_HEARTBEAT_OIDC_AUDIENCE` (default
`worldcons-ops-write`).

### Workflow wiring

Each of the five heartbeat-producing workflows now declares a top-level
`permissions:` block with `id-token: write` and no longer passes
`WORLDCONS_OPS_WRITE_TOKEN`:

| Workflow | Heartbeat entrypoint | Env blocks |
| --- | --- | --- |
| `.github/workflows/crawlee-worker.yml` | `crawl`: `crawl:worker`/`admin:worker:p1`; `postprocess`: `summarize-pending` | 2 |
| `.github/workflows/summary-drain.yml` | `summarize-pending` | 1 |
| `.github/workflows/embedding-backfill.yml` | `backfill:embeddings` | 1 |
| `.github/workflows/admin-watchdog.yml` | `ops:watchdog` | 1 |
| `.github/workflows/admin-command-worker-p1.yml` | `admin:worker:p1` | 1 |

Each job env block carries exactly:

```yaml
WORLDCONS_OPS_HEARTBEAT_WRITE_AUTHORITY: ${{ vars.WORLDCONS_OPS_HEARTBEAT_WRITE_AUTHORITY || 'supabase' }}
WORLDCONS_OPS_WRITE_BASE_URL: ${{ vars.WORLDCONS_OPS_WRITE_BASE_URL }}
WORLDCONS_OPS_HEARTBEAT_OIDC_AUDIENCE: ${{ vars.WORLDCONS_OPS_HEARTBEAT_OIDC_AUDIENCE || 'worldcons-ops-write' }}
```

`id-token: write` is granted only where a heartbeat boundary use is possible
(the five workflows above); no other permission is broadened and no workflow
receives a shared credentials secret.

### Dual trust model and first deploy

- The boundary's own `OPS_WRITE_TOKEN` is **optional**. Because `wrangler.jsonc`
  no longer lists it as a required secret, `wrangler deploy` succeeds without
  it; GitHub-hosted callers authenticate with OIDC. Operators who want bearer
  access for non-GitHub canary calls may set the secret and the matching Node
  `WORLDCONS_OPS_WRITE_TOKEN`.
- Resting authorities are unchanged (`supabase` for both read and write); the
  OIDC change only affects *how* a non-resting boundary request is authorized.
- No broad permissions, no unauthenticated mutation/read/health surface. Every
  path still rejects a request that satisfies neither trust path.

### Files (M11.3-OIDC)

- `lib/cloudflare/ops-write/github-oidc.ts` ??strict OIDC verification
  (discovery/JWKS, claims, replay, caching).
- `lib/cloudflare/ops-write/boundary-client.ts` ??OIDC-preferred auth resolution
  and runtime token request.
- `workers/ops-write/src/index.ts` ??dual trust auth on `/health`,
  `GET /v1/ops/heartbeats` and `POST /v1/ops/heartbeat`.
- `workers/ops-write/wrangler.jsonc` + `worker-configuration.d.ts` ??audience
  var; `OPS_WRITE_TOKEN` no longer required.
- `.github/workflows/{crawlee-worker,summary-drain,embedding-backfill,admin-watchdog,admin-command-worker-p1}.yml`
  ??`id-token: write`, OIDC audience var, shared token removed.
- `.env.example` ??dual trust model documented.
- `tests/m11-ops-heartbeat-oidc-auth.test.ts` ??17 focused tests.
- `package.json`, `docs/??, `artifacts/?? ??scripts/evidence.

### M11.3-OIDC verification (local, plus live OIDC canary ??see below)

- `pnpm test:m11`: 66/66 (17 new OIDC + 49 existing M11).
- `pnpm test:ops`: 10/10; `pnpm test:masterdash`: 22/22;
  `pnpm test:ingest-workflow`: 18/18; `pnpm test:m9`: 8/8; `pnpm test:m10`: 5/5.
- root `pnpm typecheck`: pass; `pnpm m11:ops-write:typecheck`: pass;
  `pnpm m11:ops-write:types:check`: up to date; `pnpm lint`: pass.
- `pnpm m11:ops-write:dry-run`: pass (the only bindings are the D1 database, the
  search service, the two resting authority vars and the OIDC audience var; no
  required secret).
- `git diff --check`: clean.

## M11.3-OIDC live canary (PASS, 2026-09-28)

The GitHub-Actions-OIDC trust for the boundary is now **live-proven**. On
2026-09-28 the controller ran the canary from branch `codex/m7-go-search` and
captured the following chain:

1. **First live canary attempt ??run `36362320031`.** The canary reached
   `POST /v1/ops/heartbeat` but the boundary returned **401**: the request was
   authenticated neither by OIDC nor by the optional bearer.
2. **Diagnostic ??run `36363873138`.** The boundary logged the stable failure
   code **`jwks_unavailable`** from `worldcons-ops-write`. This was the single
   opaque code that collapsed every discovery/JWKS stage, so it did not yet say
   *which* stage broke.
3. **Root cause reproduced under workerd.** The trust config stores
   `fetcher: fetch`, and the verifier called it as `trust.fetcher(...)`. In
   workerd, invoking the global `fetch` as a method throws
   `TypeError: Illegal invocation` (the `this` receiver is the trust config
   object, not a valid fetch receiver), so every discovery/JWKS read failed and
   the `try/catch` collapsed it to `jwks_unavailable`. The fix calls the
   fetcher **detached** (a plain local reference, `this === undefined`), which
   the Workers runtime accepts; the test fetcher seam is unchanged. The failure
   codes were also split per stage (`discovery_fetch_failed`,
   `discovery_http_error`, `discovery_invalid`, `jwks_uri_invalid`,
   `jwks_fetch_failed`, `jwks_http_error`, `jwks_invalid`,
   `jwks_no_usable_keys`) and the boundary now logs only the operation and the
   stable code (plus a boolean `bearerConfigured`), never token/claim material.
4. **Successful live canary ??run `36365145716`.** On branch
   `codex/m7-go-search`, Worker version
   `0ed20eb2-e71c-46f8-aa29-26792293a3cc`, the canary produced **two
   `POST /v1/ops/heartbeat` responses with status 200**.

### What the live canary proves ??and what it does not

The canary proves the **OIDC-authenticated boundary write path end-to-end**:
GitHub Actions obtained a per-job OIDC JWT for `worldcons-ops-write`, the
boundary verified it in-Worker (discovery 200, exact issuer, JWKS 200, four
RS256 keys imported under workerd), authorized the request, and relayed it to
the **resting Supabase** authority.

- **Supabase watchdog.** `ops_workflow_heartbeats` was updated to run id
  `36365145716` with `last_started_at` `2026-09-28 01:13:28.847+00`,
  `last_completed_at` `2026-09-28 01:13:38.435+00`, status `success`.
- **D1 watchdog.** D1 **remained unchanged** at run id `36079260476`, proving
  the canary Worker relayed to resting Supabase and did **not** write D1.

> **The D1 write authority itself was NOT switched by this canary.** Only the
> OIDC auth path and the Supabase relay were exercised. A deliberate full-`d1`
> ops-heartbeat authority cutover (coordinating both the Node-side and
> boundary-Worker authority vars, as described in M11.3) remains pending and is
> not claimed here.

### Final resting state

- Repo write/read authority vars were **restored to `supabase`** after the
  canary.
- Final resting `worldcons-ops-write` version
  `1024bf85-913c-4759-8d65-ea0a47cd1137`: write authority `supabase`, read
  authority `supabase`, audience `worldcons-ops-write`, **no** temporary OIDC
  allowed-refs binding.
- Unauthenticated requests to `/health`, `GET /v1/ops/heartbeats` and
  `POST /v1/ops/heartbeat` all return **401**.

### Remaining controller-owned prerequisites (unchanged)

1. No live read-authority (`GET /v1/ops/heartbeats` under `d1`) parity is
   claimed.
2. A deliberate full-`d1` ops-heartbeat write cutover is not claimed.
3. A forged foreign repository/audience/workflow token must be confirmed
   rejected with 401.

## M11.3 next live canary ??one real admin-watchdog run, d1-canary only

Date: 2026-09-28. This closes the M11.3 caveat that the `d1-canary` selector
keys only on the fixed literal `m11-ops-heartbeat-canary`, which the real
Node/GitHub writer (whose `run_id` is `GITHUB_RUN_ID`) can never emit. It is
**not** a full-`d1` cutover: only the bounded `d1-canary` authority is used, on
one deliberately dispatched `admin-watchdog` run, and read authority stays
`supabase` throughout.

### Code change (this step)

- `lib/cloudflare/ops-write/heartbeat.ts` ??`shouldWriteOpsHeartbeatToD1` now
  also selects a row whose `detail.m11OpsHeartbeatCanary === true` under
  `d1-canary`; new bounded `resolveOpsHeartbeatCanaryMarker` accepts only
  `true`/`1` (a brief window) or the run's exact id (an exact single-run pin).
- `lib/ops/workflow-heartbeat.ts` ??`recordWorkflowHeartbeat` adds the marker
  only when the write authority is non-resting **and** the canary marker env
  var matches this run; `run_id` stays the real GitHub run id. Under the resting
  `supabase` authority the detail is unchanged.
- `.github/workflows/admin-watchdog.yml` ??explicit `workflow_dispatch`-only
  `ops_heartbeat_canary` boolean input. Only `ops_heartbeat_canary=true` pins
  `WORLDCONS_OPS_HEARTBEAT_CANARY_MARKER` to `${{ github.run_id }}` for that one
  run; scheduled and ordinary manual runs get an empty marker. The shared
  canary-marker repo var and its plumbing were removed, so a lingering value can
  never select an unrelated watchdog run.
- `.env.example`, focused tests ??documented and covered.

### Canary selector env vars

| Side | Env var | Canary value |
| --- | --- | --- |
| Boundary Worker (`worldcons-ops-write`) | `WORLDCONS_OPS_HEARTBEAT_WRITE_AUTHORITY` | `d1-canary` |
| Boundary Worker (OIDC) | `WORLDCONS_OPS_HEARTBEAT_OIDC_ALLOWED_REFS` | `refs/heads/main,refs/heads/codex/m7-go-search` |
| Node/GitHub (repo var) | `WORLDCONS_OPS_HEARTBEAT_WRITE_AUTHORITY` | `d1-canary` |
| Node/GitHub (dispatch input) | `WORLDCONS_OPS_HEARTBEAT_CANARY_MARKER` | `ops_heartbeat_canary=true` pins `${{ github.run_id }}` (no repo var) |
| Node/GitHub (repo var) | `WORLDCONS_OPS_WRITE_BASE_URL` | the workers.dev base URL (already set) |
| Node/GitHub (repo var) | `WORLDCONS_OPS_HEARTBEAT_READ_AUTHORITY` | **unchanged `supabase`** |

### Exact safe controller sequence

Preconditions: the `worldcons-ops-write` Worker and `worldcons-search` bridge
are deployed; `WORLDCONS_OPS_WRITE_BASE_URL` repo var already points at the
workers.dev endpoint. Everything below is one deliberate window; do not leave
any var set.

1. **Baseline.** Record the Supabase and D1 `ops_workflow_heartbeats` watchdog
   rows exactly (workflow `watchdog`, and the other four keys):
   `SELECT workflow_key, last_started_at, last_completed_at, last_status, run_id`.
   Expected baseline (from the M11.3-OIDC canary): D1 watchdog run id
   `36079260476`; Supabase watchdog run id `36365145716`.
2. **Feature-ref allowlist.** Set the boundary Worker var
   `WORLDCONS_OPS_HEARTBEAT_OIDC_ALLOWED_REFS=refs/heads/main,refs/heads/codex/m7-go-search`
   (`wrangler secret`/`vars` + redeploy) so the OIDC `ref` claim for the feature
   branch is accepted. Both entries are well-formed and are the only extension.
3. **Boundary authority.** Set the boundary Worker var
   `WORLDCONS_OPS_HEARTBEAT_WRITE_AUTHORITY=d1-canary` and redeploy. Leave the
   read authority `supabase`.
4. **Repo vars.** Set only the repo var
   `WORLDCONS_OPS_HEARTBEAT_WRITE_AUTHORITY=d1-canary`. Do **not** set any
   canary-marker repo var. Leave `WORLDCONS_OPS_HEARTBEAT_READ_AUTHORITY`
   unset/`supabase`.
5. **Trigger exactly one run.** Dispatch `admin-watchdog.yml` once on
   `codex/m7-go-search` with the `ops_heartbeat_canary` input set to `true`
   (Actions ??Run workflow). The workflow pins the canary marker to that
   dispatch's exact `github.run_id`; note the run id.
6. **Verify during the canary.**
   - Boundary OIDC: the run's `POST /v1/ops/heartbeat` responses are **2xx**
     (200) and the Worker logs show no `worldcons_ops_write_auth_failure`.
   - D1: `ops_workflow_heartbeats` watchdog row `run_id` changes to that exact
     GitHub run id; `detail.m11OpsHeartbeatCanary` is `true`; Supabase watchdog
     `run_id` stays at its baseline value for the whole canary.
7. **Rollback / restore all vars to the resting state.**
   - Repo vars: delete/unset `WORLDCONS_OPS_HEARTBEAT_WRITE_AUTHORITY` (or set
     `supabase`). There is no canary-marker repo var to delete — the marker is
     pinned per dispatch.
   - Boundary Worker: set `WORLDCONS_OPS_HEARTBEAT_WRITE_AUTHORITY=supabase`,
     remove the temporary `WORLDCONS_OPS_HEARTBEAT_OIDC_ALLOWED_REFS` binding,
     and redeploy so the resting version has only the default `refs/heads/main`.
   - Confirm unauthenticated `GET /health`, `GET /v1/ops/heartbeats` and
     `POST /v1/ops/heartbeat` all return **401** again.
8. **Optional cleanup.** The canary overwrote the single `watchdog` row; either
   leave it (no schema/data change, next scheduled run overwrites it) or restore
   the recorded pre-canary row. Do not delete the table.

### Expected evidence fields

- `schemaVersion`, `milestone: "M11.3-canary"`, `date`.
- `canary.branch: "codex/m7-go-search"`, `canary.githubRunId`, the Worker
  version id the boundary was running.
- `canary.boundaryRequests`: method/path/status (expect 200 on
  `/v1/ops/heartbeat`, no auth-failure log).
- `canary.supabaseWatchdog`: `{ runId, lastStartedAt, lastCompletedAt, status }`
  ??expected unchanged from baseline for the whole canary.
- `canary.d1Watchdog`: `{ runId, detail.m11OpsHeartbeatCanary, lastStatus }` ??
  expected `runId === githubRunId` and marker `true`.
- `canary.authorityVars`: write/read/canary-marker values during the window and
  the restored resting values.
- `canary.restingWorker`: version id, `writeAuthority: "supabase"`,
  `readAuthority: "supabase"`, `temporaryAllowedRefsBinding: false`,
  unauthenticated `/health`/read/write = `401`.
- `scope.d1WriteAuthoritySwitched: false` (only `d1-canary`, one run).

## M11.3 real-run d1-canary live result (PASS, 2026-09-28)

Date: 2026-09-28. Head `1e286e2d` on `codex/m7-go-search`. This realizes the
step above: the bounded `d1-canary` authority was live-exercised on **one**
deliberately dispatched `admin-watchdog` run. Live evidence:
`artifacts/cloudflare-m11/m11.3-d1-canary-live-evidence-20260928.json` (the
design record is preserved at
`artifacts/cloudflare-m11/m11.3-d1-canary-real-run-design-20260928.json`).

### Observed facts

- **Baseline.** Supabase watchdog run id `36365145716` (`last_started_at`
  `2026-09-28 01:13:28.847+00`, `last_completed_at` `2026-09-28 01:13:38.435+00`,
  status `success`); D1 watchdog run id `36079260476` (`last_started_at`
  `2026-09-25T00:49:21.138Z`, `last_completed_at` `2026-09-25T00:49:29.943Z`).
- **Canary Worker.** `worldcons-ops-write` version
  `161d73de-0ac1-436b-8392-33c5ef9adc7d`: write authority `d1-canary`, read
  authority `supabase`, audience `worldcons-ops-write`, temporary allowed refs
  `main` + `codex/m7-go-search`.
- **Dispatch.** GitHub run `36367270071` at head `1e286e2d` with
  `ops_heartbeat_canary=true`, completed **success**.
- **Boundary.** Cloudflare Observability recorded two `POST /v1/ops/heartbeat`
  calls, both **200 / outcome ok**, wall times `284ms` and `182ms`;
  auth-failure count **0**.
- **D1 (`d1-canary` write).** The D1 watchdog became run id `36367270071`,
  `last_started_at` `2026-09-28T01:46:50.444Z`, `last_completed_at`
  `2026-09-28T01:47:01.595Z`, status `success`, detail
  `{ "m11OpsHeartbeatCanary": true }`.
- **Supabase (read/resting).** The Supabase watchdog stayed **exactly** at
  baseline run id `36365145716` for the whole canary.
- **Restored.** Repo write/read vars back to `supabase`; Worker redeployed as
  version `2a38e10a-d329-4fa6-8017-a05f21a9f367` with write/read authority
  `supabase`, audience `worldcons-ops-write` and **no** temporary allowed-refs
  binding. Unauthenticated `/health`, `GET /v1/ops/heartbeats` and
  `POST /v1/ops/heartbeat` all return **401**.

### What this proves ??and what it does not

**PASS: the bounded real-run `d1-canary` write path.** The real Node/GitHub
call path (whose `run_id` is `GITHUB_RUN_ID`) was selected by the
`d1-canary` authority through the dispatch-pinned
`detail.m11OpsHeartbeatCanary` marker, the OIDC-authenticated boundary write
landed in D1 with the exact GitHub run id, the Supabase row was untouched, and
every authority/binding was restored.

> **This is NOT a full heartbeat-domain D1 authority and NOT M11 completion.**
> Ordinary, non-canary heartbeats still resolve to Supabase; reads remained
> Supabase throughout and no live `d1` read parity is claimed. `admin_ops_events`
> (M11.4), ingest and core/publication remain pending.

### Next gate ??move heartbeat writes fully to D1 while reads remain Supabase

1. **Coordinate both write authority vars to full `d1`** for one deliberate
   window: set the boundary Worker `WORLDCONS_OPS_HEARTBEAT_WRITE_AUTHORITY=d1`
   **and** the repo var `WORLDCONS_OPS_HEARTBEAT_WRITE_AUTHORITY=d1`. No
   `d1-canary` marker and no canary dispatch input are needed.
2. **Verify an ordinary run.** Dispatch/observe one ordinary `admin-watchdog`
   run; confirm the ordinary heartbeat lands in D1 with the real GitHub run id
   and **no** marker, and that the Supabase watchdog row does not advance.
3. **Keep reads at Supabase.** Leave `WORLDCONS_OPS_HEARTBEAT_READ_AUTHORITY`
   resolved to `supabase` on both the repo and the boundary Worker, so readers
   are unchanged during the write cutover.
4. **Fail-closed check.** Confirm a D1 failure still returns `503` and is never
   silently downgraded to Supabase.
5. **Roll back.** Restore both write vars to `supabase` and confirm the ordinary
   RPC path resumes.
6. **Only then** consider the combined full-`d1` read/write cutover as a
   separate gate (M11.3R live-read parity).

Explicit non-claims for that gate: no full heartbeat-domain D1 write authority,
no D1 read authority/parity, and no M11 completion.

## M11.3 full heartbeat-domain D1 WRITE live result (PASS, 2026-09-28)

Date: 2026-09-28. Head `fae2b83f` on `codex/m7-go-search`. This executes the
gate above: the full heartbeat-domain D1 **WRITE** path was live-exercised on
**one** ordinary (non-canary) `admin-watchdog` dispatch run. Live evidence:
`artifacts/cloudflare-m11/m11.3-full-d1-write-live-evidence-20260928.json`.

### Observed facts

- **Window precondition.** Before the window, all five heartbeat workflows had
  **no** running or queued runs, so no concurrent writer could contaminate the
  observation.
- **Baseline rows.** Supabase: catalog_backfill `local-11948`, collection
  `36216022066`, embedding `36223085744`, summary `36216022066`, watchdog
  `36365145716`. D1: catalog_backfill `local-11948`, collection `35951479432`,
  embedding `36075282131`, summary `36075282131`, watchdog `36367270071`
  (bounded canary marker `true`).
- **Safe ordering.** (1) A temporary feature-ref allowlist was set under the
  resting `supabase` boundary Worker version
  `29831266-ac98-4ac9-a45b-fa0f60792d`; (2) repo write authority was set to `d1`
  and repo read authority kept `supabase`; (3) the boundary Worker write
  authority was set to `d1` and read authority kept `supabase`, version
  `f943ae4f-8485-4f1e-b748-d1cfb0043bfc`.
- **Ordinary dispatch.** `admin-watchdog` run `36367859952` at head `fae2b83f`,
  with **no canary input and no canary marker**, completed **success**.
- **D1 result.** The D1 watchdog became run id `36367859952`,
  `last_started_at` `2026-09-28T01:56:23.596Z`, `last_completed_at`
  `2026-09-28T01:56:32.678Z`, status `success`, detail `{}` — the real GitHub
  run id with **no** marker.
- **Supabase (resting/read).** The Supabase watchdog stayed **exactly** at
  baseline run id `36365145716`.
- **Boundary.** Cloudflare Observability recorded two `POST /v1/ops/heartbeat`
  calls on version `f943ae4f-8485-4f1e-b748-d1cfb0043bfc`, both **200 / outcome
  ok**, wall times `303ms` and `244ms`; auth-failure count **0**.
- **Fail-closed.** No destructive live fault injection was performed; the
  existing fail-closed D1 failure unit test is accepted in lieu of it.
- **Rollback.** Boundary Worker was restored **first** to write/read authority
  `supabase` with no feature-ref binding, final version
  `7e661453-4253-4297-b508-79a7d8ca3749`; then repo write authority was restored
  to `supabase` (repo read stayed `supabase`). Unauthenticated `/health`,
  `GET /v1/ops/heartbeats` and `POST /v1/ops/heartbeat` all return **401**.

### What this proves ??and what it does not

**PASS: the full heartbeat-domain D1 WRITE path for the tested ordinary
run/window.** An ordinary, non-canary heartbeat resolved to D1 through the
coordinated full-`d1` write authority, landed with the real GitHub run id and no
marker, and left the Supabase row untouched.

> **This is NOT M11 completion.** Resting authority is Supabase, and D1 READ
> authority/parity is still not live-proven. `admin_ops_events` (M11.4), ingest
> and core/publication remain pending.

### Next gate ??M11.3R live D1 read parity (no writes)

1. **Confirm resting rejects.** The resting boundary still rejects
   unauthenticated reads (`GET /v1/ops/heartbeats` `401`).
2. **Isolate the read cutover.** Set `WORLDCONS_OPS_HEARTBEAT_READ_AUTHORITY=d1`
   on both the boundary Worker and the repo while the write authority stays
   `supabase`, so the read cutover is isolated and **no writes** are exercised.
3. **Prove parity.** Confirm `GET /v1/ops/heartbeats` returns the same five-field
   records as the Supabase reader for the five authored keys
   (`workflow_key/last_started_at/last_completed_at/last_status/run_id`), i.e.
   live D1 read parity.
4. **Prove ordinary readers.** Confirm ordinary Node/GitHub and Cloudflare
   runtime readers resolve to D1 without any write.
5. **Prove fail-closed read.** Confirm a selected `d1` read still returns `503`
   on a missing URL/token, non-2xx, malformed body or unavailable binding and
   never falls back to Supabase.
6. **Roll back.** Restore the read authority to `supabase` and confirm the local
   read resumes.

Explicit non-claims for that gate: no combined full-`d1` read/write cutover, no
live read parity yet, and no M11 completion.

## M11.3R reconciliation + read-only probe (code, 2026-09-28)

Date: 2026-09-28. Head `deb6172`. Base checkpoint for the live D1 read cutover.
This adds the missing pieces the M11.3R live prerequisites assumed but did not
have: a safe bounded pre-cutover reconciliation and a **no-write** OIDC read
probe. No live cutover was performed and no live read parity is claimed.

### The divergence and the bounded reconciliation

Prior write canaries advanced only the D1 `watchdog` row (and earlier bounded
canary runs), so D1 is **stale/diverged** from the now-authoritative Supabase
`ops_workflow_heartbeats` for `collection`, `summary`, `embedding` and
`watchdog`; `catalog_backfill` is `local-11948` on both. Before a read switch,
those five authored rows must equal the Supabase rows.

- **No code change was needed for reconciliation.** The existing
  `pnpm d1:reconcile --source=supabase-linked --database=worldcons_ops
  --tables=ops_workflow_heartbeats` (M5.2d, `lib/cloudflare/d1/remote/reconcile.ts`)
  already reconciles exactly this shape: it reads the source and remote
  canonically by primary key, refuses the table if the remote has any primary key
  the source lacks (so it **never DELETEs**), emits source-only rows as plain
  INSERTs and changed common-PK rows as full-row parameterized UPDATEs by exact
  PK (PK columns excluded from SET), re-reads and verifies the final canonical
  hash, and is dry-run by default with an explicit `--apply`. It touches only the
  selected table, never schema and never another `ops` row.
- **Field semantics.** The projected columns are `workflow_key`,
  `last_started_at`, `last_completed_at`, `last_status`, `run_id` (plus
  `detail`/`updated_at` for the physical row, which the reader never projects).
  `last_started_at`/`last_completed_at`/`updated_at` are Postgres `timestamptz`
  whose canonical D1 form is normalized UTC ISO-8601 TEXT, so the reconcile
  rewrites them as the same instant in canonical text — the exact format the D1
  reader and the boundary already emit. Run this **before** selecting the `d1`
  read authority; while reads are still Supabase this is a pure D1 write that
  changes nothing a reader sees.

### The read-only probe (code gap closed)

The M11.3-OIDC read allowlist trusted only `admin-watchdog.yml`, which **emits**
`recordWorkflowHeartbeat` writes. There was therefore no existing authenticated
path that could prove a `d1` read without exercising a heartbeat write.

- `lib/cloudflare/ops-write/github-oidc.ts` — the `read` operation now trusts
  `admin-watchdog.yml` **and** the new dedicated
  `.github/workflows/ops-heartbeat-read-parity.yml`. The probe is deliberately
  **not** write-trusted; the write allowlist is unchanged.
- `.github/workflows/ops-heartbeat-read-parity.yml` — `workflow_dispatch`-only,
  `id-token: write`, runs `pnpm ops:heartbeat-read-parity -- --run
  --no-direct-d1 --report --json`. It issues only `GET /v1/ops/heartbeats` plus a
  plain Supabase SELECT; it never calls a heartbeat writer, never runs the
  watchdog and changes no authority. `--no-direct-d1` keeps the GitHub job free
  of any Cloudflare credential.
- `lib/cloudflare/ops-write/read-parity.ts` — the runtime-neutral comparator
  (timestamps compared by instant, key/status/run-id exact, exactly the five
  authored keys) plus the parameterized direct-D1 projection reader.
- `scripts/ops-heartbeat-read-parity.ts` — the read-only probe CLI. It forces
  `WORLDCONS_OPS_HEARTBEAT_READ_AUTHORITY=d1` **only in its own process
  environment**, so no repo/boundary var changes for the probe. It requires the
  boundary's own read var to already be `d1`; otherwise the boundary returns the
  fail-closed `503 READ_AUTHORITY_UNAVAILABLE` and the probe reports a mismatch
  rather than a false pass.
- `lib/ops/workflow-heartbeat.ts` — extracted `readWorkflowHeartbeatsFromSupabase`
  so the probe can compare against the authoritative Supabase projection
  regardless of the selected read authority. `getWorkflowHeartbeats` behavior is
  byte-for-byte unchanged.

### Read-only invariant

The gate exercises **no** heartbeat write. The probe's only statements are
SELECTs; it does not import or call `recordWorkflowHeartbeat`,
`runWithWorkflowHeartbeats` or the watchdog. The admin-watchdog workflow is not
used for the gate, precisely because it cannot prove no writes.

### Files (M11.3R reconciliation + probe)

- `lib/cloudflare/ops-write/github-oidc.ts`, `lib/cloudflare/ops-write/read-parity.ts`,
  `lib/ops/workflow-heartbeat.ts`, `scripts/ops-heartbeat-read-parity.ts`,
  `.github/workflows/ops-heartbeat-read-parity.yml`, `package.json`.
- `tests/m11-ops-heartbeat-read-parity.test.ts` (8 focused tests, including a
  script/workflow scan that asserts no write path).
- `tests/m11-ops-heartbeat-oidc-auth.test.ts` (read-trust assertion updated).

### M11.3R probe verification (local, no live proof)

- `pnpm test:m11`: 83/83 (8 new read-parity + 75 existing M11).
- `pnpm test:ops`: 10/10; `pnpm test:masterdash`: 22/22; `pnpm test:m8`: 23/23;
  `pnpm test:m9`: 8/8; `pnpm test:m10`: 5/5; `pnpm test:ingest-workflow`: 18/18;
  `pnpm test:d1-reconcile`: 29/29.
- root `pnpm typecheck`: pass; `pnpm m11:ops-write:typecheck`: pass;
  `pnpm m11:ops-write:types:check`: up to date; `pnpm lint`: pass.
- `pnpm m11:ops-write:dry-run`: pass (resting authorities unchanged).
- `pnpm ops:heartbeat-read-parity`: dry-run prints no network call.

### Exact controller sequence (READ-only; no writes)

Preconditions: resting write/read authority `supabase` everywhere; the
`worldcons-ops-write` and `worldcons-search` Workers deployed; the
`WORLDCONS_OPS_WRITE_BASE_URL` repo var set; the OIDC `read` allowlist on the
boundary includes `ops-heartbeat-read-parity.yml`. If the probe is dispatched
from a feature branch (for example `codex/m7-go-search`), temporarily set the
boundary `WORLDCONS_OPS_HEARTBEAT_OIDC_ALLOWED_REFS` to include
`refs/heads/<branch>` for the window, exactly as the earlier canaries did, and
remove it on rollback. This is one deliberate window; restore every var at the
end.

1. **Reconcile D1 (before any read switch).** Dry-run, then apply:
   - `pnpm d1:reconcile --source=supabase-linked --database=worldcons_ops --tables=ops_workflow_heartbeats`
   - `pnpm d1:reconcile --source=supabase-linked --database=worldcons_ops --tables=ops_workflow_heartbeats --apply`
   Confirm the manifest reports `exact`/verified for the table and touches only
   `ops_workflow_heartbeats`. Because reads are still Supabase, no reader changes.
2. **Confirm resting rejects.** `GET /v1/ops/heartbeats` without a bearer returns
   `401`.
3. **Isolate the read cutover.** Set the boundary Worker
   `WORLDCONS_OPS_HEARTBEAT_READ_AUTHORITY=d1` and redeploy (write authority stays
   `supabase`). Set the repo var `WORLDCONS_OPS_HEARTBEAT_READ_AUTHORITY=d1` only
   if an ordinary Node/GitHub reader is also being proven.
4. **Prove boundary/Node parity (no writes).** Dispatch
   `ops-heartbeat-read-parity.yml` (workflow_dispatch). It authenticates with
   OIDC and compares the five-field records to Supabase; expect parity. Cross-check
   independently with `pnpm ops:heartbeat-read-parity -- --run --report` using
   operator `CLOUDFLARE_ACCOUNT_ID`/`CLOUDFLARE_API_TOKEN` for the direct-D1 read
   (not in GitHub), and with `GET /v1/ops/heartbeats`.
5. **Prove the Cloudflare runtime read.** With the main Worker's read var `d1`,
   exercise the masterdash health route so `getWorkflowHeartbeats` reads the
   isolated D1 binding directly (no HTTP hop) and reports the same records.
6. **Prove fail-closed from existing tests.** The fail-closed read paths are
   already covered by `tests/m11-ops-heartbeat-read-authority.test.ts` (missing
   URL/token, non-2xx, malformed body, unavailable binding → throw/503, never a
   Supabase fallback). Do **not** perform destructive live fault injection.
7. **Roll back.** Set the boundary Worker and repo read authority back to
   `supabase` and redeploy; confirm the local Supabase read resumes and
   unauthenticated `/health`, `GET /v1/ops/heartbeats` and `POST /v1/ops/heartbeat`
   all return `401`.

Explicit non-claims: no combined full-`d1` read/write cutover, no M11 completion,
and no destructive live fault injection. The D1 read authority is live-proven
only after a controller runs the sequence above and captures its evidence.

## M11.3R feature-branch dispatch caveat + `admin-watchdog` read-only shell

Date: 2026-09-28. Head `8436e127`. **Caveat.** The dedicated
`.github/workflows/ops-heartbeat-read-parity.yml` is intentionally kept for
post-merge/default-branch use, but a brand-new workflow **cannot** be
`workflow_dispatch`-ed before it exists on the repository default branch:
GitHub returns **404** for a dispatch of a workflow ref it does not know. A
feature-branch live read-parity proof therefore needed an already-present
dispatch shell.

`admin-watchdog.yml` exists on the default branch, so it gains a
`workflow_dispatch`-only boolean input `read_parity_only` (default `false`).
When `true`:

- the normal `pnpm ops:watchdog -- --compensate` step is **skipped entirely**
  (`if: ${{ inputs.read_parity_only != true }}`);
- the only job step is the read-only probe
  `pnpm ops:heartbeat-read-parity -- --run --no-direct-d1 --report --json`
  (`if: ${{ inputs.read_parity_only == true }}`), which reuses the same per-job
  OIDC `id-token: write` and the existing Supabase read secrets;
- there is **no** `recordWorkflowHeartbeat`, no watchdog evaluation, no
  compensation and no write path — the probe issues only
  `GET /v1/ops/heartbeats` plus plain Supabase SELECTs.

Scheduled runs and ordinary manual dispatches are byte-for-byte unchanged: they
never set `read_parity_only`, so the watchdog runs exactly as before and the
probe step is skipped. The OIDC read trust already includes `admin-watchdog.yml`
and the write trust is **not** broadened; the dispatch shell does not add any
write trust or any new permission (`contents: read`, `issues: write`,
`id-token: write` are unchanged). The dedicated
`ops-heartbeat-read-parity.yml` remains the intended default-branch workflow.

Focused tests in `tests/m11-ops-heartbeat-read-parity.test.ts` assert the
`read_parity_only` input is a dispatch-only boolean defaulting to `false`, that
the watchdog step is guarded off in that mode, and that only the exact read-only
probe command runs (no write path, no broadened trust).
