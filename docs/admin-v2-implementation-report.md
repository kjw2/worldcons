# Admin v2 Implementation Report

## Scope

This report summarizes the admin v2 P0-P3 implementation state. No production database migration was applied directly during this work, and no push was performed.

## Phase Summary

### P0

- Scoped `/api/admin/ingest` summary runs by `sourceKey` so selected-source summarize actions do not process unrelated sources.
- Centralized admin mutation validation with zod schemas for ingest, review, bulk article actions, candidates, LLM settings, LLM tests, and job worker/action payloads.
- Added recursive audit redaction before admin event metadata is persisted through `site_events` and admin audit dual-write paths.
- Enforced manual summary edit boundaries so raw/cleaned snapshot fields, original URLs, canonical URLs, and content hashes are rejected instead of silently dropped.
- Removed raw IP and raw User-Agent display from default admin analytics UI.

### P1

- Added `/admin/operations` as the operator triage home while preserving `/admin`.
- Added additive dashboard summary views/RPC migration files with legacy query fallback in code.
- Added additive `admin_audit_logs`, `admin_article_edit_history`, and article triage column migrations with safe fallback behavior.
- Added responsive card views for major admin operation tables.
- Added explicit LLM health/test call UI and API with audit logging and error-class classification.

### P2

- Added additive `admin_jobs` and `admin_job_events` schema/RPC migration.
- Converted admin ingest actions to enqueue jobs by default; production no longer defaults to long inline execution when the queue is unavailable.
- Added bounded worker executor and `/api/admin/jobs/run`.
- Added secret-only production drain endpoint `/api/admin/cron/jobs`.
- Added `.github/workflows/admin-job-worker.yml`, which calls the production queue drain endpoint with `Authorization: Bearer`.
- Added `/admin/jobs` for queue monitoring, manual drain, selected job events, cancel, and retry.
- Added queue helper unavailable fallbacks and redaction on stored/read job payloads.

### P3

- Updated README and production checklist for admin queue operations, migration prerequisites, and smoke checks.
- Added `pnpm admin:readiness` via `scripts/admin-ops-readiness.ts` for read-mostly DB readiness verification.
- Final integration review found and fixed a queue helper regression: `markAdminJobSucceeded` and `markAdminJobFailed` had inherited cancel-only guard text/status constraints. They now update completed worker jobs normally, while cancel-only atomic guards remain in cancel helpers.

## Main Surfaces

Pages:

- `/admin/operations`
- `/admin/jobs`
- Existing admin pages: `/admin`, `/admin/articles`, `/admin/ingestion-runs`, `/admin/candidates`, `/admin/audit`, `/admin/analytics`, `/admin/llm`, `/admin/glossary-candidates`

Admin endpoints:

- `POST /api/admin/ingest`
- `POST /api/admin/jobs/run`
- `GET /api/admin/cron/jobs`
- `POST /api/admin/jobs/[jobId]`
- `POST /api/admin/llm-settings/test`
- Existing review/articles/candidates/LLM settings routes retain auth, CSRF, validation, and audit behavior.

Automation:

- `.github/workflows/crawlee-worker.yml`: existing daily official-site collection workflow, preserved.
- `.github/workflows/admin-job-worker.yml`: queued admin job drain every 15 minutes, production endpoint only, secret header only.

Readiness:

- `pnpm admin:readiness`

## Migration Files

The following additive migrations were applied to the production database on 2026-07-10. The final migration corrects the admin job claim RPC parameter references found by the live readiness check.

- `supabase/migrations/20260709120000_admin_dashboard_summary_views.sql`
- `supabase/migrations/20260709130000_admin_audit_and_edit_history.sql`
- `supabase/migrations/20260709140000_admin_article_triage_columns.sql`
- `supabase/migrations/20260709150000_admin_jobs.sql`
- `supabase/migrations/20260710100000_fix_claim_admin_job_parameter_references.sql`

## Verification Results

Code/build verification:

- `pnpm exec tsc --noEmit`: passed
- `pnpm check`: passed
- `pnpm lint`: passed
- `pnpm build`: passed
- `git diff --check`: passed, with Windows CRLF conversion warnings only
- `git status --short`: showed P3-2 working tree changes plus pre-existing untracked `design-drafts/`

Readiness verification:

- The initial production readiness check after applying the four admin v2 migrations exposed an invalid `fn.job_types` PL/pgSQL parameter reference in `claim_admin_job`.
- `supabase/migrations/20260710100000_fix_claim_admin_job_parameter_references.sql` replaced those references with unambiguous positional aliases.
- The final `pnpm admin:readiness` run passed every dashboard view/RPC, audit/edit history table, triage column, admin job table/event table, and live `claim_admin_job` RPC check.
- Local and remote migration history match through `20260710100000`.

## Deployment Prerequisites

- Keep every target environment migrated through `20260710100000`; production is already current.
- Keep Vercel production admin environment variables configured, including admin session, LLM settings, Supabase, and cron secrets.
- Ensure GitHub secret `CRON_SECRET` is available to `.github/workflows/admin-job-worker.yml`.
- Run `pnpm admin:readiness` against the target production database before relying on `/admin/jobs` or queued ingest.
- Confirm smoke checks from `docs/security/production-checklist.md`, especially:
  - `/admin/jobs` opens after admin login.
  - `/api/admin/cron/jobs` returns 401 without a secret header.
  - `/api/admin/jobs/run` returns 405 for GET.
  - `POST /api/admin/ingest` returns queued job information when queue schema/RPC are available.
  - failed/cancelled jobs show retry controls, and queued/running/cancel-requested jobs show cancel controls.

## Notes

- No secret values are stored in this report.
- No production DB migration was applied directly.
- No Vercel deploy, preview deploy, branch deploy, PR operation, or git push was performed.
