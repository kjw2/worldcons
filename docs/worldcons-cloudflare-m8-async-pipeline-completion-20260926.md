# WorldCons Cloudflare M8 — Async pipeline migration status

Date: 2026-09-26
Branch: `codex/m7-go-search` (in-place; no new branch)
Base HEAD: `4d62f8b` (`feat: record M7 GO-SEARCH readiness`)

## Status

**M8 CODE/VERIFICATION COMPLETE; SCHEDULER SAFELY DISABLED; NO ACTIVATION.**

The M8 async control plane (Cron + Queues + Workflows) and the Browser Run
crawler transport are implemented, deployed as isolated resources, and verified
with the scheduler disabled. `M8_SCHEDULER_ENABLED=false` on the deployed
`worldcons-ingest` Worker is the safety state: every Cron, Queue and Workflow
entry point fails closed or skips/retries without triggering live GitHub
execution.

This milestone deliberately does **not** cut over the existing GitHub Actions
long-running Node executor. GitHub Actions remains the compatibility executor
for full Node/Crawlee/Playwright workloads; a fully Cloudflare-executing
pipeline would require Containers and is documented as a later task
(see "Post-main sequence" and "Current limitations").

This step performed no commit, no push, no `M8_SCHEDULER_ENABLED` change, no
scheduler-enabled redeploy, no live Queue/Workflow/GitHub dispatch, and no
destructive remote action.

## 1. Scope completed in this step

- Re-ran and repaired the full M8 verification set (see section 5).
- Confirmed every legacy scheduled path is retired in this branch (section 4).
- Authored this completion/status record and updated the full migration
  roadmap/checklist with the exact deployed resources, safety state, live
  evidence, limitations and post-commit/post-main sequence.

### Small edits made during this step

1. `eslint.config.mjs` — ignore generated `**/worker-configuration.d.ts`. These
   Wrangler-generated ambient files produced 4 unfixable "unused eslint-disable
   directive" warnings; `pnpm lint` now exits 0 with no output.
2. `tsconfig.json` — the root program previously included
   `workers/async-pipeline/**` and `workers/browser-run/**` sources while
   excluding their generated ambient types, so `pnpm typecheck` failed with
   missing `Env`/`cloudflare:workers`/`ExportedHandler` names. The two Worker
   source directories are now excluded from the root program (each has its own
   `tsconfig.json` used by `pnpm m8:typecheck`). `pnpm typecheck` and
   `pnpm m8:typecheck` both pass.

No runtime behavior changed; the edits are tooling-scope only.

## 2. Exact deployed resources (as reported by the operator/context)

These facts are recorded as supplied; this step did not query or mutate the
remote resources.

### worldcons-ingest (async control plane)

- Worker name: `worldcons-ingest`
- Deployed version: `8988532e-2feb-4675-8b76-52fd54508e30`
- Bindings present: Cron triggers, Queue producer/consumer, Workflow
- `M8_SCHEDULER_ENABLED`: `false` (safety state)
- Secrets required: `GITHUB_ACTIONS_TOKEN` (set)
- Queues that exist:
  - `worldcons-async-v1` (main)
  - `worldcons-async-dlq-v1` (dead-letter queue)

### worldcons-browser-run (browser transport)

- Worker name: `worldcons-browser-run`
- Deployed version: `f324efe7-9912-4b22-8c94-74aab2a3fc6f`
- Secret required: `BROWSER_RUN_TOKEN` (set)
- Browser Run binding: `BROWSER`
- Allowed hosts var: German, US, French and Spanish constitutional-court hosts.

### GitHub Actions configuration

- Cloudflare Browser Run token: set
- GitHub Browser Run token: set
- Cloudflare `GITHUB_ACTIONS_TOKEN`: set
- GitHub Actions variable `CLOUDFLARE_BROWSER_RUN_URL`: set

## 3. Live Browser Run evidence already obtained

A real Supreme Court discovery through the deployed Browser Run transport was
reported to return:

- HTTP/navigation status: `200`
- HTML content length: `127875` characters

This is live remote evidence that the Browser Run Worker navigates a real
constitutional-court target and returns substantial rendered HTML. It is **not**
a full crawler pipeline or search-parity result. No scheduler-enabled execution
was involved.

## 4. Legacy schedule retirement (verified in this branch)

All six operational GitHub workflows had their `schedule:` triggers removed and
retain `workflow_dispatch` plus a new optional `m8_idempotency_key` input; the
Vercel cron list was removed:

| Path | Before | After |
| --- | --- | --- |
| `.github/workflows/admin-job-worker.yml` | `*/15 * * * *` | dispatch + M8 identity |
| `.github/workflows/admin-watchdog.yml` | `*/15 * * * *` | dispatch + M8 identity |
| `.github/workflows/crawlee-worker.yml` | `0 0 * * *` | dispatch + M8 identity |
| `.github/workflows/embedding-backfill.yml` | `30 1 * * *` | dispatch + M8 identity |
| `.github/workflows/summary-drain.yml` | `30 3,9,15,21 * * *` | dispatch + M8 identity |
| `.github/workflows/admin-health-p5.yml` | `17 20 * * *` | dispatch + M8 identity |
| `vercel.json` | two `/api/ops/watchdog` crons | `crons` key removed |

Verified directly in this step:

- `rg "cron:" .github/workflows vercel.json` returns no matches.
- `vercel.json` parses with no `crons` key.
- `M8_CRON_EXPRESSIONS` in `lib/cloudflare/async-pipeline/contracts.ts` matches
  the five retired expressions exactly.
- `admin-command-worker-p1.yml`, `release-gate.yml` and `bverfg-diagnose.yml`
  were never scheduled and keep their existing triggers.

Manual `workflow_dispatch` execution is retained so GitHub Actions stays the
long-running Node compatibility executor when orchestrated by M8.

## 5. Verification results for this step

| Command | Result |
| --- | --- |
| `pnpm test:m8` | 7/7 pass |
| `pnpm m8:types:check` | both Workers "up to date" |
| `pnpm m8:typecheck` | both Worker tsconfigs pass |
| `pnpm lint` | exit 0, no warnings |
| `pnpm m8:dry-run` | both Workers bundle and bind correctly |
| `pnpm typecheck` (root) | pass after the `tsconfig.json` fix |

Dry-run bindings observed:

- `worldcons-ingest`: `ASYNC_WORKFLOW` (Workflow), `ASYNC_QUEUE`
  (`worldcons-async-v1`), `M8_SCHEDULER_ENABLED ("false")`,
  `GITHUB_REPOSITORY ("kjw2/worldcons")`, `GITHUB_REF ("main")`; upload
  6.07 KiB.
- `worldcons-browser-run`: `BROWSER` (Browser Run),
  `BROWSER_ALLOWED_HOSTS`; upload 3088.66 KiB.

## 6. Design summary

### Cron → Queue → Workflow → GitHub executor

1. `scheduled()` maps a Cron expression to deterministic `M8TaskMessage`s
   (`lib/cloudflare/async-pipeline/contracts.ts`).
2. Messages are enqueued to `worldcons-async-v1`.
3. The queue consumer validates each message and creates a `Workflow` instance
   whose id is the message `idempotencyKey`.
4. The Workflow's `dispatch-compatible-executor` step dispatches the mapped
   GitHub Actions workflow with `m8_idempotency_key` as an input.

Idempotency is layered:

- queue replay yields the same Workflow instance id (`m8:<kind>:<minute>`);
- `scripts/admin-command-worker-p1.ts` derives its P1 command identity from
  `M8_IDEMPOTENCY_KEY` when present, falling back to the run id/attempt.

### Safe-disable behavior

- `scheduled()` logs `m8_schedule_skipped` and returns.
- `queue()` retries every message with a bounded delay.
- `Workflow.run()` throws `m8.scheduler_disabled`.

No live GitHub dispatch can occur while `M8_SCHEDULER_ENABLED=false`.

### Browser Run transport

`lib/crawler/cloudflare-browser-run-client.ts` posts to the Browser Run Worker
`/v1/navigate` endpoint over HTTPS with bearer auth, bounds timeout/size, and
maps the response to `CrawlResponse`. Both the Playwright client and the Crawlee
Playwright pass prefer Browser Run when
`CLOUDFLARE_BROWSER_RUN_URL`/`CLOUDFLARE_BROWSER_RUN_TOKEN` are set, and fail
closed when `CLOUDFLARE_BROWSER_RUN_REQUIRED=true` but unconfigured.

## 7. Current limitations

1. **GitHub Actions remains the executor.** M8 orchestrates; it does not yet
   execute long-running Node/Crawlee/Playwright jobs on Cloudflare.
2. **Full Cloudflare execution would require Containers.** Rewriting Crawlee and
   heavy extraction into Workers/Browser Run is not done. This is a later task
   (section 9), not silently implemented here.
3. **Scheduler disabled.** No live Queue, Workflow or GitHub dispatch has been
   exercised end-to-end.
4. **Browser Run evidence is one navigation.** It proves the transport works
   against a real target; it is not a per-source crawler-parity result.
5. **No request-governor parity evidence yet** across the queue/workflow path.
6. **No restart/recovery or no-duplicate-publication evidence** on the deployed
   control plane while disabled.

These limitations mean `GO-ASYNC` is **not** yet recorded; only the code/migration
milestone is complete.

## 8. Post-commit / post-main sequence

After this branch is reviewed and checkpointed by the workflow/controller, and
only after the changes reach `main`:

1. Confirm the deployed `worldcons-ingest`/`worldcons-browser-run` versions
   match the merged config.
2. Keep `M8_SCHEDULER_ENABLED=false` during the first activation rehearsal.
3. Enable one low-risk path first (e.g. manual `workflow_dispatch` of a single
   kind) and confirm dispatch idempotency.
4. Flip `M8_SCHEDULER_ENABLED=true` only on explicit authorization, then observe
   queue backlog, DLQ depth, Workflow success and GitHub run identity.
5. Capture retry/DLQ/restart/recovery/no-duplicate-publication evidence required
   by the `GO-ASYNC` gate.
6. Retire the remaining manual fallbacks only after `GO-ASYNC` passes.

None of steps 2–6 is performed by this document.

## 9. Later task — full Cloudflare execution (Containers)

If the plan requires removing the GitHub Actions compatibility executor, the
remaining work is a Containers-backed crawler job runner (or a per-source
Browser Run + Worker rewrite) plus memory/CPU benchmarking for jsdom/pdf-parse.
That is a separate milestone and must not be started implicitly.

## 10. Related documents

- `docs/worldcons-cloudflare-full-migration-plan-20260920.md` (M8 section and
  checklist updated with this status)
- `docs/worldcons-cloudflare-m7.9-go-search-readiness-20260926.md`
