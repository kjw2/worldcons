# MasterDash integration

WorldCons exposes three production adapter endpoints:

- `GET /api/auth/masterdash?masterdash_token=...` validates a one-minute HS256 JWT for issuer
  `masterdash`, audience `worldcons-admin`, and system `worldcons`. The token must carry an `owner`
  or `admin` identity whose `email` or `sub` matches the configured, password-enabled local
  `ADMIN_USERNAME` or an identity listed in `MASTERDASH_ADMIN_IDENTITIES`. Allowlist entries are
  comma-separated, trimmed, case-insensitive, and empty entries are ignored. No account is created
  and an `operator` token is never elevated to the local administrator. The final session always
  uses the existing `ADMIN_USERNAME`. A consumed `jti` is stored only as a SHA-256 digest, then the normal
  `worldcons_admin_session` cookie is created and the browser is redirected to the fixed `/admin`
  path.
- `POST /api/masterdash/control` accepts only `incremental_collect`, `pause_collection`, and
  `resume_collection`. It validates the raw-body HMAC contract and persists every request ID before
  applying an action. Operators may request incremental collection; changing pause state requires
  an `admin` or `owner` role.
- `GET /api/masterdash/health` returns collection freshness, queue, error, and pause metrics without
  credentials or row-level content.
  `failureTarget`, `failureReason`, and `failureObservedAt` describe only a failure observed within
  the last 168 hours, and the per-source signal that drives `status: "degraded"` is aged the same way.
  Without that bound the newest run stays failed forever once collection stops, so a consumer would
  keep showing a failure nobody can act on. `lastRunStatus` still reports what actually happened, and
  `failureObservedAt` lets a consumer apply its own recency rule.
  `summaryBacklogCount` and `oldestSummaryBacklogAt` report material that has verified source text but
  no summary yet. Collection freshness cannot express this: source text keeps arriving while nothing
  reaches the public listing, so a stalled summariser would otherwise be invisible. A backlog whose
  oldest entry has waited more than 24 hours, longer than the six-hourly drain needs, sets
  `status: "degraded"` on its own. `pendingItems` is queue depth and never covered this gap.
  `pendingItems` remains backward compatible, while `pendingAdminJobs`, `openCandidateCount`,
  `retryableCandidateCount`, `exhaustedCandidateCount`, and `oldestOpenCandidateAt` identify what
  is actually waiting and whether candidate retries are progressing.
  `missingEmbeddingCount` is the count of summarized rows that lack the pinned Gemini provenance;
  `missingPublishedEmbeddingArtifactCount` independently proves that every currently published P3
  version has a matching derived Gemini artifact. Either non-zero count degrades health.
  Collection, summary, embedding, and watchdog workflows also report their latest run time and
  status. `stalledWorkflows` contains a scheduled workflow whose heartbeat is missing, failed, or
  older than 2.5 times its declared interval. Summary/embedding staleness affects health only while
  their corresponding backlog is non-empty; collection and watchdog heartbeats are always required.

Apply `supabase/migrations/20260801090000_masterdash_integration.sql` before configuring either
MasterDash secret. The migration adds service-role-only replay, request ledger, and collection
pause tables. Code fails closed for new collection starts when the control secret is enabled but
the durable state cannot be read.

Before deploying the expanded health payload, apply
`supabase/migrations/20260831130000_gemini_embedding_provenance.sql` and
`supabase/migrations/20260831140000_workflow_heartbeats.sql` in that order. After deployment, run
the collection and summary workflows once so their first durable heartbeats exist. The watchdog
records its own heartbeat every 15 minutes.

Configure these Vercel production secrets without committing their values:

```text
MASTERDASH_SSO_SECRET=<same value as MasterDash PORTAL_SSO_SECRET>
MASTERDASH_CONTROL_SECRET=<same value as MasterDash PORTAL_CONTROL_SECRET>
MASTERDASH_ADMIN_IDENTITIES=admin,admin2
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
