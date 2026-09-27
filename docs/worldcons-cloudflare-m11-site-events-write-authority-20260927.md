# WorldCons Cloudflare M11.0 — site_events runtime write authority seam

Date: 2026-09-27
Base checkpoint: `a6597e6e263d338d41d91b7438b42a30dec29bbe`

## Decision

**GO-SITE-EVENTS-WRITE-AUTHORITY-CANARY: PASS.**

This completes the first M11 ops-domain runtime authority slice for
`worldcons_ops.site_events`. It does not complete M11 as a whole: ingest and
core/publication write authority remain pending, and the public production
frontend/API cutover remains M12.

The resting Cloudflare main Worker authority is intentionally returned to
`supabase` after the canary.

## Runtime authority modes

`WORLDCONS_SITE_EVENTS_WRITE_AUTHORITY` supports:

- `supabase` — existing authority path;
- `d1-canary` — only an explicit M11 canary path with
  `metadata.m11Canary=true` is written to D1;
- `d1` — all `site_events` writes handled by the Cloudflare runtime go to
  `worldcons_ops`.

Invalid or missing values resolve to `supabase`.

When a D1 mode is selected, a D1 write failure is logged as a structured
`worldcons_site_events_d1_write_failed` event and does not silently fall
through to Supabase.

## Cloudflare legacy-write bridge

The first runtime canary exposed an important migration gap: the
`worldcons-m3-spike` Worker itself has no Supabase secrets, so its historical
direct Supabase analytics path is a no-op. This was existing spike behavior,
but it meant that merely switching the flag back to `supabase` would not prove
a usable rollback path.

M11.0 therefore adds an internal-only compatibility bridge:

```text
worldcons-m3-spike
  -> WORLDCONS_SEARCH_SERVICE Service Binding
  -> worldcons-search
  -> POST /internal/site-events/write
  -> Supabase site_events
```

The bridge is used only when a Service Binding exists. Vercel has no runtime
binding state and therefore retains the existing direct Supabase client path.

`worldcons-search` already owns the temporary Supabase credentials required by
M9, so this avoids copying or exposing another service-role secret. The route is
not public: `worldcons-search` still has `workers_dev=false` and no route.
This bridge is transitional and should move to `worldcons-api` when that
service boundary is introduced.

## Live canary sequence

### 1. Legacy authority baseline

Resting authority: `supabase`.

Control path:
`/__m11/supabase-control-20260927-2230-b1`

Result:

- public analytics API: HTTP 204;
- D1: 0 rows;
- Supabase: 1 row.

Cloudflare Observability recorded
`POST https://worldcons-search.internal/internal/site-events/write` with
HTTP 204, outcome `ok`.

### 2. Selective D1 canary

Authority: `d1-canary`.

Canary path:
`/__m11/d1-runtime-canary-20260927-2232-c1`

Payload included `metadata.m11Canary=true`.

Result:

- public analytics API: HTTP 204;
- D1: 1 row;
- Supabase: 0 rows.

This verifies the selective M11 runtime gate.

### 3. Full site_events D1 authority canary

Authority: `d1`.

Ordinary test path:
`/__m11/d1-full-20260927-2233-c1`

The payload did not contain the selective canary marker.

Result:

- public analytics API: HTTP 204;
- D1: 1 row;
- Supabase: 0 rows.

This proves that full-mode routing does not depend on the canary marker.

### 4. Rollback rehearsal

Authority was switched back to `supabase`.

Rollback control path:
`/__m11/rollback-control-20260927-2234-c1`

Result:

- public analytics API: HTTP 204;
- D1: 0 rows;
- Supabase: 1 row.

Observability again recorded the private legacy bridge as HTTP 204 / outcome
`ok`.

All four test rows were then removed. D1 returned to 15,516 rows, matching its
pre-M11 count. Both Supabase control rows were deleted and verified absent.

## Deployment evidence

- `worldcons-search` code version:
  `d2e28047-3606-4313-9225-5e1693e9dda3`
- current main Worker deployment after rollback:
  `255f401e-522f-4952-9806-26d4ebb99f49`
- current main authority:
  `WORLDCONS_SITE_EVENTS_WRITE_AUTHORITY=supabase`
- main Service Binding:
  `WORLDCONS_SEARCH_SERVICE -> worldcons-search`

The legacy bridge was observed twice during the final proof:

- HTTP 204 / outcome `ok` / 718 ms
- HTTP 204 / outcome `ok` / 457 ms

## Code verification

- `pnpm test:m11`: 6/6 pass
- `pnpm test:m9`: 8/8 pass
- `pnpm m9:typecheck`: pass
- root `pnpm typecheck`: pass
- root `pnpm lint`: pass
- `git diff --check`: pass
- vinext production build: pass
- both Workers redeployed successfully

Machine-readable evidence:
`artifacts/cloudflare-m11/go-site-events-write-authority-canary-20260927.json`.

## Remaining M11 work

M11 is not globally complete. The next safe sequence is:

1. keep `site_events` defaulted to Supabase until the broader M11 GO gate;
2. migrate another low-risk `worldcons_ops` append-only/operational write
   surface;
3. establish ops-domain reconciliation/observability;
4. only then expand to ingest;
5. core/publication write authority remains last.

No M12 DNS/public production cutover occurred in this step.
