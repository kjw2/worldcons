# WorldCons Cloudflare M11.4 ??admin_ops_events Node/GitHub authority seam

Date: 2026-09-28
Base checkpoint: `015397f869d261bebd2857305d64ad0c8dee8fcb` (M11.3R live D1 read parity)

## Decision

**M11.4 implements the bounded, fail-closed Cloudflare D1 compatibility path
for `worldcons_ops.admin_ops_events` that M11.3 deliberately deferred.**

Code and focused tests are complete. The Cloudflare authority rests at
`WORLDCONS_ADMIN_OPS_EVENTS_WRITE_AUTHORITY=supabase` and
`WORLDCONS_ADMIN_OPS_EVENTS_READ_AUTHORITY=supabase`, so the Node/GitHub watchdog
behavior is byte-for-byte unchanged. No deploy, commit or push was performed and
**no live canary is claimed**; a controller with Cloudflare credentials owns it.
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

## Verification

`test:m11` 106/106, `test:ops` 10/10, `test:masterdash` 22/22, `test:gate0` 4/4,
M9 8/8, M10 5/5, admin-ops-reads 16/16, admin-ops-read-shadow 23/23, root and
ops-write/search-service typechecks, worker types check, lint (0 warnings),
ops-write dry-run with both admin-ops-events vars at `supabase`, and
`git diff --check` pass. The `test:postgres:release:static` (`test:d1-schema`)
failure is a **pre-existing** Windows CRLF artifact (`\n` emitter vs `\r\n`
working copy) reproduced at clean HEAD.

## What is NOT claimed

- No live canary, no deploy, no commit/push.
- No combined full-`d1` read/write cutover.
- No M11 completion: ingest and core/publication remain pending.

## Safest next live canary sequence (controller)

1. Deploy `worldcons-search` with `/internal/admin-ops-events*`; confirm it stays
   internal-only (`workers_dev=false`, Service Binding only).
2. Deploy `worldcons-ops-write` with both admin-ops-events vars at `supabase`;
   confirm the four new paths return 401 without auth and the boundary remains
   workers.dev-only with preview URLs disabled.
3. Capture baseline `admin_ops_events` counts on Supabase and on `worldcons_ops`
   D1.
4. Write canary: coordinate both write vars to `d1-canary` and set
   `WORLDCONS_ADMIN_OPS_EVENTS_CANARY_MARKER` for one dispatched `admin-watchdog`
   run. Confirm the marked event lands in D1 only, the Supabase count is
   unchanged, and the dedupe read + prune both hit D1. Re-run with an unchanged
   signature to prove dedupe skips the D1 insert while still pruning.
5. Full write window: coordinate both write vars to `d1` with an ordinary run;
   confirm insert, dedupe read and prune all resolve to D1 and Supabase is
   unchanged.
6. Read parity: set `WORLDCONS_ADMIN_OPS_EVENTS_READ_AUTHORITY=d1` and confirm
   `app/admin/ops/page.tsx`'s `listAdminOpsEvents(20)` equals the Supabase
   projection (same ids/order/fields).
7. Roll every write/read var and binding back to `supabase`; confirm the direct
   Supabase writer/reader resumes.
8. Delete the canary event(s) and restore pre-canary counts.

See `artifacts/cloudflare-m11/m11.4-admin-ops-events-authority-seam-20260928.json`.
