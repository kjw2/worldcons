# WorldCons Cloudflare M3.2 Runtime Seam

Date: 2026-09-21

Baseline: commit `ca666d5` (M3.1 vinext runtime foundation) plus the M3.2 working
tree. This checkpoint completes the two runtime boundaries that the M3.1 spike
deferred to M3.2. It does not deploy a remote Worker.

## 1. Scope and safety boundary

M3.2 finished the explicit Cloudflare Worker runtime seam and removed
Worker-facing filesystem state. It did not:

- deploy a remote Worker or change production DNS,
- change Supabase production authority,
- clear inline corpus data or delete any storage,
- add long-lived R2 S3 credentials to the web runtime,
- change the existing Next/Vercel production build path.

Rollback remains repository-only: keep using the Next/Vercel build, do not invoke
the vinext deployment scripts, and remove the M3 Worker configuration if the
compatibility branch is abandoned.

## 2. Runtime platform seam

`lib/runtime/platform.ts` provides the runtime-neutral platform slot:

- `setRuntimePlatform("cloudflare-worker")` is called once per request by
  `worker/index.ts`,
- `runtimePlatform()` defaults to `"node"` for Next/Vercel and every CLI/script,
- `isCloudflareWorkerRuntime()` is the single predicate the execution seams use.

Because the default is `"node"`, Node/Vercel and operator CLI behaviour is
unchanged unless the Worker entry explicitly announces the Worker runtime.

## 3. Goal 1 — Node-only execution is bounded

### 3.1 Admin ingest / job execution seam

`lib/admin/admin-worker-execution.ts` is the Worker-facing entry point. It never
statically imports the Node executors; it only `import type`s them and loads them
through `await import(...)` on the inline path.

- `inlineAdminExecutionAllowed()` returns `false` inside the Cloudflare Worker
  runtime, regardless of `ADMIN_INGEST_INLINE_FALLBACK`.
- `runAdminJobWorkerForRuntime()` returns
  `{ mode: "external_worker_required", error: "admin.external_worker_required" }`
  in the Worker runtime instead of importing `admin-job-runner`.
- `runScheduledIngestForRuntime()` returns the same bounded result instead of
  importing `lib/ingest/run`, `lib/ingest/summary`, and retention.

Callers map that result to HTTP `503` and keep the existing bounded
admin-job / external-worker contract.

Migrated routes:

| Route | Worker behaviour |
| --- | --- |
| `app/api/admin/jobs/run/route.ts` | fails closed `503 external_worker_required` |
| `app/api/admin/cron/jobs/route.ts` | fails closed `503 external_worker_required` |
| `app/api/admin/cron/ingest/route.ts` | fails closed `503 external_worker_required` |
| `app/api/admin/ingest/route.ts` | queues through the admin job contract; inline fallback blocked in Workers |
| `app/api/admin/review/route.ts` | `retry-source-ingest` fails closed; review loads its executor dynamically |

### 3.2 Inline Crawlee guard

`lib/ingest/run.ts` now blocks inline collection in the Worker runtime:

```text
isCloudflareWorkerRuntime() && process.env.CRAWLEE_WORKER !== "true"
  -> inline crawler blocked, use the external collection worker
```

This is a defense-in-depth guard: even if a path reached `runIngest` inside the
Worker, it returns a blocked result instead of attempting Crawlee/Playwright.

### 3.3 Public/read-only route boundary

The public route graph does not import Crawlee, Playwright, jsdom, pdf-parse,
`got-scraping`, or `rss-parser` directly. The only Node dependency reachable from
the public search path was `lib/ai/gemini-router.ts`'s filesystem state, which is
removed in section 4. The remaining admin execution paths that can start
Crawlee/Playwright work all fail closed or dispatch through the bounded contract
above.

## 4. Goal 2 — runtime-neutral persistent state

`lib/ai/gemini-router.ts` previously resolved `process.cwd()`/`os.tmpdir()` paths
and read/wrote JSON through `node:fs`. That dynamic filesystem resolution is what
the M3.1 spike flagged.

`lib/runtime/persistent-state.ts` now owns that concern:

- `readRuntimeJsonState()` / `writeRuntimeJsonState()` are the neutral API.
- Node/Vercel keeps its existing filesystem behaviour, including the in-process
  fallback that keeps the router working when the cache directory is unwritable
  (still covered by `assertGeminiRouterSurvivesUnwritableStorage` in `pnpm check`).
- The Cloudflare Worker runtime uses an isolate-scoped in-memory store and never
  resolves or writes a filesystem path.
- `worker/index.ts` explicitly calls `setRuntimeJsonStateStore(...)`, so the
  Worker backend choice is explicit rather than incidental.
- Node/Vercel relative state-path overrides keep the same semantics through
  `path.resolve(value)`. This avoids feeding `process.cwd()` plus an arbitrary
  runtime value into Turbopack's filesystem tracer, which had caused the whole
  project to be traced during `next build`.
- `setRuntimeJsonStateStore()` is the extension point for a future KV/R2/Durable
  Object backend; callers do not change.

`lib/ai/gemini-router.ts` no longer imports `node:fs`, `node:os`, or `node:path`.
It keeps the model-catalog and router-state contracts unchanged; only the storage
backend is runtime-selected.

Production authority is unchanged: on Node the same paths, the same JSON shape,
and the same write-then-read semantics are preserved.

## 5. Build-output evidence

After `pnpm build:vinext`:

- the generated `gemini-router-*.js` chunk contains no `node:fs`, `node:os`, or
  `node:path` import and references the persistent-state module,
- the compiled `dist/server/index.js` Worker entry references
  `cloudflare-worker` and the persistent-state module,
- the `WORLDCONS_RAW` R2 binding wiring from M3.1 is unchanged.

## 6. Verification

| Check | Result |
| --- | --- |
| `pnpm exec tsx --test tests/runtime-persistent-state.test.ts tests/cloudflare-runtime-boundary.test.ts` | Pass, 9/9 |
| `pnpm typecheck` | Pass |
| `pnpm check` | Pass, includes new M3.2 boundary assertions and the Gemini unwritable-storage check |
| `pnpm lint` | Pass |
| `pnpm check:vinext` | Pass, 100% compatible, 0 issues |
| `pnpm build:vinext` | Pass |
| `pnpm build` (existing Next/Vercel path) | Pass, 0 dynamic-filesystem whole-project tracing warnings |
| `pnpm test:public-regression` | Pass, 15/15 |
| `pnpm test:artifact-blob-provider` | Pass, 34/34 |
| `pnpm test:embeddings` | Pass, 10/10 |
| `git diff --check` | Pass |

The focused tests assert that the Cloudflare runtime returns
`admin.external_worker_required` before importing Node executors, that the
Worker-facing routes stay behind the runtime seams, that `gemini-router` holds no
filesystem imports, and that the worker runtime keeps Gemini router state in
memory without writing a file.

## 7. Remaining blockers and canary readiness

M3.2 resolves the two M3.1 blockers at the repository/build boundary:

1. Admin Crawlee/Playwright/jsdom/pdf-parse execution can no longer run inside the
   web Worker; it fails closed with `admin.external_worker_required` or dispatches
   through the existing bounded admin-job contract.
2. `lib/ai/gemini-router.ts` no longer depends on filesystem state; the Worker uses
   a runtime-selected in-memory store.

Residual items that are not part of the M3.2 boundary but should be tracked:

- Admin **summary/review AI** actions still execute inside the Worker. They are AI
  calls (not Node-only crawlers) and now run on runtime-neutral state, but their
  CPU/latency profile should be measured during the canary.
- The Worker state store is in-memory per isolate. If cross-isolate persistence of
  Gemini route state becomes necessary, wire a KV/R2 backend through
  `setRuntimeJsonStateStore` (no caller changes).
- The actual remote non-production Worker canary and the representative public
  page/API smoke suite were **not** run here, because this checkpoint performs no
  deployment.

**Canary readiness:** M3.2 is ready for a non-production Worker canary (no
production DNS switch) to repeat the M3.1 public smoke suite and observe admin
`503 external_worker_required` behaviour. It is not a production cutover.
