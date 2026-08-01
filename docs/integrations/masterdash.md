# MasterDash integration

WorldCons exposes three production adapter endpoints:

- `GET /api/auth/masterdash?masterdash_token=...` validates a one-minute HS256 JWT for issuer
  `masterdash`, audience `worldcons-admin`, and system `worldcons`. A consumed `jti` is stored only
  as a SHA-256 digest, then the normal `worldcons_admin_session` cookie is created and the browser
  is redirected to the fixed `/admin` path.
- `POST /api/masterdash/control` accepts only `incremental_collect`, `pause_collection`, and
  `resume_collection`. It validates the raw-body HMAC contract and persists every request ID before
  applying an action.
- `GET /api/masterdash/health` returns collection freshness, queue, error, and pause metrics without
  credentials or row-level content.

Apply `supabase/migrations/20260801090000_masterdash_integration.sql` before configuring either
MasterDash secret. The migration adds service-role-only replay, request ledger, and collection
pause tables. Code fails closed for new collection starts when the control secret is enabled but
the durable state cannot be read.

Configure these Vercel production secrets without committing their values:

```text
MASTERDASH_SSO_SECRET=<same value as MasterDash PORTAL_SSO_SECRET>
MASTERDASH_CONTROL_SECRET=<same value as MasterDash PORTAL_CONTROL_SECRET>
MASTERDASH_SSO_ISSUER=masterdash
```

MasterDash target configuration uses:

```text
ssoUrl=https://worldcons.vercel.app/api/auth/masterdash
ssoAudience=worldcons-admin
controlUrl=https://worldcons.vercel.app/api/masterdash/control
healthUrl=https://worldcons.vercel.app/api/masterdash/health
```

Pause blocks cron ingestion, collection queue drain, manual ingest requests, and fresh calls to
`runIngest`. It deliberately does not abort an invocation that already passed the start guard, and
its response says so. Queued collection jobs remain durable and become eligible again after resume.

Local verification:

```bash
pnpm test:masterdash
pnpm exec tsc --noEmit
```
