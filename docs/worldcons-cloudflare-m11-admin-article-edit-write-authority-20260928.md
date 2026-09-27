# WorldCons Cloudflare M11.2 — admin_article_edit_history write authority seam

Date: 2026-09-28
Base checkpoint: `12c424a` (M11.1 admin audit D1 canary)

## Decision

**M11.2 code/deployment seam is ready and the controller has now deployed it;
the live write canary was attempted but not achieved, so no live write proof is
claimed.**

This adds the same explicit `supabase|d1-canary|d1` authority seam used by
M11.0 (`site_events`) and M11.1 (`admin_audit_logs`) to the append-only
`worldcons_ops.admin_article_edit_history` surface.

The resting Cloudflare authority remains Supabase:
`WORLDCONS_ADMIN_ARTICLE_EDIT_WRITE_AUTHORITY=supabase`.

The controller deployed the seam to Cloudflare production and attempted the
live canary. The temporary canary Worker deployed successfully, but the
outbound invocation was blocked by the execution environment **before reaching
Cloudflare**. The inspection was not bypassed, so no live write canary may be
claimed and this document deliberately contains no fabricated live proof.

## Controller deployment record (2026-09-28)

| Artifact | Deployed version ID |
| --- | --- |
| `worldcons-search` | `1ce8b477-f8d8-40b6-a389-52630e41451d` |
| `worldcons-m3-spike` (main Worker) | `4b6119dd-c293-44ce-9430-2b91f3d7f605` |

Deployed authority values (all resting at Supabase):

- `WORLDCONS_ADMIN_ARTICLE_EDIT_WRITE_AUTHORITY=supabase`
- `WORLDCONS_ADMIN_AUDIT_WRITE_AUTHORITY=supabase`
- `WORLDCONS_SITE_EVENTS_WRITE_AUTHORITY=supabase`

The `WORLDCONS_SEARCH_SERVICE` Service Binding on the main Worker resolves to
`worldcons-search`. The vinext production build passed.

## Canary attempt result

- A temporary `worldcons-admin-article-edit-canary` Worker deployed
  successfully.
- The outbound invocation was blocked by the execution environment **before
  reaching Cloudflare**. The inspection was not bypassed, so the live write
  canary did not run and **no live write canary may be claimed**.
- `admin_article_edit_history` count was D1=0 and Supabase=0 before and after
  the attempt; no accidental row remained.
- The temporary canary Worker was deleted and its local source was removed.

## Selected surface and rationale

Inventory of remaining `worldcons_ops` write surfaces and their execution
owners (from the M11 plan and current code):

| Surface | Primary writer | Execution owner | Notes |
| --- | --- | --- | --- |
| `admin_article_edit_history` | `recordAdminArticleEditHistory` (`lib/db/admin-audit.ts`) | Node admin API route (`app/api/admin/articles/[articleRef]/summary`) + Vercel/Cloudflare Worker runtime | append-only, one bounded insert, no read-before-write, no RPC |
| `admin_audit_logs` | `recordAdminAuditLog` | Node/Worker runtime | M11.1 complete (selective canary) |
| `site_events` | `recordSiteEvent` | Worker/Vercel runtime | M11.0 complete |
| `admin_ops_events` | `recordAdminOpsEvent` / `recordWatchdogEvents` (`lib/ops/watchdog.ts`) | Node: GitHub Actions (`admin-watchdog.yml` → `pnpm ops:watchdog`) and `app/api/ops/watchdog/route.ts` | needs Cloudflare-native heartbeat/watchdog boundary first |
| `ops_workflow_heartbeats` | `recordWorkflowHeartbeat` (`lib/ops/workflow-heartbeat.ts`) | Node: GitHub Actions workflows, Vercel fallback route | same Node/GitHub ownership gap |
| `admin_job_events`, `admin_jobs` | `lib/db/admin-jobs.ts` | Node admin routes / `scripts/admin-command-worker-p1.ts` | coupled queue state, not append-only-only |
| `admin_command_*`, P5 evidence/observations | command control plane, `lib/admin/p5/*` | Node worker/scripts | higher-risk state machine |
| MasterDash control/SSO, `llm_settings` | `lib/masterdash/store.ts`, `lib/ai/llm-settings.ts` | Node API routes | mutable upsert state, not append-only |
| `security_rate_limit_buckets_v1` | rate limiter | runtime hot path | plan defers to Cloudflare-native controls |

`admin_article_edit_history` was selected because it is the next safest
append-only operational surface:

- it is a single bounded `INSERT` with no read-modify-write;
- it is already written from the Cloudflare Worker runtime today via
  `recordAdminArticleEditHistory` on the manual summary edit path, so the seam
  applies to real runtime traffic and not only to a script;
- the D1 table and ownership are already modeled (`worldcons_ops`,
  `d1/worldcons_ops/0001_init.sql`, `lib/cloudflare/d1/schema/worldcons-ops.ts`);
- it needs no RPC and no cross-table transaction, unlike the command queue and
  P5 surfaces.

`admin_ops_events` and `ops_workflow_heartbeats` were deliberately **not**
selected: their writers are primarily Node/GitHub-owned, and switching their
authority now would be a half-migration. They require a minimal private
Cloudflare-native compatibility/write boundary (comparable to the M8 async
pipeline) before their writers can migrate safely. That boundary is the next
logical M11 step and is out of scope for this slice.

## Runtime authority modes

`WORLDCONS_ADMIN_ARTICLE_EDIT_WRITE_AUTHORITY` supports:

- `supabase` — legacy authority;
- `d1-canary` — only rows whose `article_slug` equals
  `m11-admin-article-edit-canary`;
- `d1` — all Cloudflare runtime article-edit writes go to `worldcons_ops`.

Invalid or missing values resolve to `supabase`.
D1 selection fails closed and does not silently fall through to Supabase.

## Cloudflare legacy bridge

The Cloudflare main Worker carries no Supabase secret. Its `supabase`
authority therefore uses:

```text
worldcons-m3-spike
  -> WORLDCONS_SEARCH_SERVICE Service Binding
  -> worldcons-search
  -> POST /internal/admin-article-edit/write
  -> Supabase admin_article_edit_history
```

`worldcons-search` remains internal-only (`workers_dev=false`, no route), so
the route is not publicly reachable. Vercel, which has no runtime Service
Binding state, continues using the existing direct Supabase client. The bridge
is transitional and should move to `worldcons-api` when that boundary exists.

## Verification

- `pnpm test:m11`: 20/20 pass (7 new M11.2 + 13 existing M11)
- `pnpm test:m9`: 8/8 pass
- search Worker typecheck: pass
- root typecheck: pass
- lint: pass
- `git diff --check`: pass
- vinext production build: pass (controller)
- live write canary: attempted, blocked by the execution environment before
  reaching Cloudflare; not achieved, not claimed

`pnpm check` fails on a pre-existing, unrelated `summary drain workflow must run
on its own schedule` assertion that also fails on the clean base checkout.

## Live-canary prerequisites

The controller completed steps 1–2 below (deploy `worldcons-search` and the main
Worker, both resting at `supabase`, with the `WORLDCONS_SEARCH_SERVICE` binding
confirmed). The temporary canary Worker for step 4 deployed, but the outbound
invocation was blocked by the execution environment before reaching Cloudflare,
so steps 3–7 were not completed.

1. Deploy `worldcons-search` with the new internal
   `/internal/admin-article-edit/write` route. **Done**
   (`1ce8b477-f8d8-40b6-a389-52630e41451d`).
2. Deploy the main Worker with
   `WORLDCONS_ADMIN_ARTICLE_EDIT_WRITE_AUTHORITY=supabase` (resting) and confirm
   the `WORLDCONS_SEARCH_SERVICE` binding. **Done**
   (`4b6119dd-c293-44ce-9430-2b91f3d7f605`).
3. Insert a control row via a real manual summary edit or a bounded canary path
   under `supabase`; confirm D1 0 / Supabase 1. **Not completed (blocked).**
4. Switch to `d1-canary`, write with canary slug
   `m11-admin-article-edit-canary`; confirm D1 1 / Supabase 0. **Temporary
   canary Worker deployed, outbound call blocked.**
5. Optionally verify full `d1` with an ordinary slug; record whether the
   execution environment allows the outbound call (M11.1 showed it may not).
   **Not completed (blocked).**
6. Roll back to `supabase`; confirm D1 0 / Supabase 1. **Not completed.**
7. Delete all test rows and verify counts return to their pre-canary values.
   **Counts remained D1 0 / Supabase 0 before and after; no row was written.**

## Blockers

- The execution environment blocks outbound canary invocation before it reaches
  Cloudflare; the block was not bypassed. The live write canary therefore
  remains pending, owned by the controller.
- `admin_ops_events` and `ops_workflow_heartbeats` remain blocked on a
  Cloudflare-native Node/GitHub compatibility write boundary.

## Next step

Continue M11 ops inventory. The next safest target is to introduce the minimal
private Cloudflare-native compatibility/write boundary for the Node/GitHub-owned
`ops_workflow_heartbeats` (or `admin_ops_events`) writer before migrating its
authority. Do not switch `admin_audit_logs` or `admin_article_edit_history` to
full `d1` authority until the broader M11 GO gate.
