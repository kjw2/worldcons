# WorldCons Cloudflare M11.1 — admin_audit_logs selective D1 authority canary

Date: 2026-09-27
Base checkpoint: 48f2d33032d6fdb875ef5e018c4cea0e7fad8f98

## Decision

**GO-ADMIN-AUDIT-D1-CANARY: PASS.**

This is a selective live canary for the append-only
`worldcons_ops.admin_audit_logs` surface. It does not declare full
`admin_audit_logs` D1 authority active in production, and it does not complete
M11 globally.

The resting Cloudflare authority remains
`WORLDCONS_ADMIN_AUDIT_WRITE_AUTHORITY=supabase`.

## Runtime authority seam

`WORLDCONS_ADMIN_AUDIT_WRITE_AUTHORITY` supports:

- `supabase` — legacy authority;
- `d1-canary` — only `action=m11.admin_audit_canary` with
  `redacted_metadata.m11AuditCanary=true` goes to D1;
- `d1` — all Cloudflare runtime audit writes go to D1.

Invalid or missing values resolve to `supabase`.
D1 selection fails closed and does not silently fall through to Supabase.

## Cloudflare legacy bridge

The Cloudflare main Worker still carries no Supabase secret. Its
`supabase` audit authority therefore uses:

`worldcons-m3-spike -> WORLDCONS_SEARCH_SERVICE -> worldcons-search -> POST /internal/admin-audit/write -> Supabase admin_audit_logs`

`worldcons-search` remains internal-only. Vercel, which has no runtime
Service Binding state, continues using the existing direct Supabase client.

## Pre-canary state

- D1 `admin_audit_logs`: 125 rows
- Supabase `admin_audit_logs`: 128 rows

The pre-existing three-row delta was not modified or treated as a canary
failure. M11.1 compares only unique canary target ids.

## Live sequence

### 1. Supabase baseline

Target id: `m11.1-supabase-20260927-a`

- canary Worker: HTTP 204
- D1: 0 rows
- Supabase: 1 row
- action: `m11.admin_audit_supabase_control`

### 2. Selective D1 canary

Target id: `m11.1-d1canary-20260927-b`

- canary Worker: HTTP 204
- D1: 1 row
- Supabase: 0 rows
- action: `m11.admin_audit_canary`
- `redacted_metadata.m11AuditCanary=true`

This proves the bounded `d1-canary` selector and the actual
`recordAdminAuditLog()` D1 runtime writer.

### 3. Full D1 live attempt

The temporary canary Worker supports full `d1` mode and unit tests verify the
selector. However the execution environment blocked the outbound canary request
before it reached Cloudflare while its requested mode was full D1. That
inspection was not bypassed.

Therefore M11.1 does **not** claim a live full-`d1` audit cutover.

### 4. Rollback control

Target id: `m11.1-rollback-20260927-d`

- canary Worker: HTTP 204
- D1: 0 rows
- Supabase: 1 row

Cloudflare Observability recorded both private Supabase bridge calls as
`POST /internal/admin-audit/write`, HTTP 204, `outcome=ok`:

- 626 ms
- 476 ms

## Cleanup

The selective D1 row and both Supabase control rows were deleted.
Final counts returned exactly to D1 125 and Supabase 128.

The temporary `worldcons-admin-audit-canary` Worker and its local canary source
were deleted after the test.

## Deployment state

- `worldcons-search` version:
  `b4a9084c-64a6-47a8-a845-cebf4529fdd6`
- main Worker version:
  `5ed9f641-84ce-45e1-94ea-c0f9f637399c`
- main audit authority: `supabase`
- site-events authority: `supabase`
- Service Binding: `WORLDCONS_SEARCH_SERVICE -> worldcons-search`

## Verification

- M11 tests: 13/13 pass (11 at canary time plus two added fail-closed
  regression tests for the audit D1 binding and the internal bridge)
- M9 tests: 8/8 pass
- search Worker typecheck: pass
- root typecheck: pass
- lint: pass
- diff-check: pass
- vinext production build: pass
- selective D1 live canary: pass
- Supabase rollback path: pass

Machine-readable evidence:
`artifacts/cloudflare-m11/go-admin-audit-d1-canary-20260927.json`.

## Next step

Do not switch `admin_audit_logs` to full D1 authority yet. Continue M11 ops
inventory and migrate the remaining write surfaces according to execution
owner. Node/GitHub-owned watchdog and workflow heartbeat writes require a
Cloudflare-native write boundary before their authority can move safely.
