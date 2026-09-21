# Worldcons Cloudflare M3.1 Runtime Compatibility Spike

Date: 2026-09-21

## 1. Scope and safety boundary

M3.1 tested whether the existing worldcons Next.js application can build and run
on Cloudflare Workers through vinext without changing production authority.

This checkpoint did not:

- deploy a remote Worker,
- change production DNS,
- change Supabase production authority,
- clear inline corpus data,
- delete legacy Blob or R2 objects, or
- add long-lived R2 S3 credentials to the web runtime.

The remote non-production deployment gate is intentionally deferred until the
remaining Node-only admin/ingest paths are isolated in M3.2.

## 2. Runtime baseline

Validated dependency set:

- Next.js 16.3.5
- React 19.2.6
- React DOM 19.2.6
- react-server-dom-webpack 19.2.6
- vinext 1.0.0-beta.10
- Vite 8.3.0
- @cloudflare/vite-plugin 1.56.0
- Wrangler 4.135.0

`react-server-dom-webpack` is pinned to 19.2.6 so its React/React DOM peer range
matches the installed 19.2.6 runtime exactly.

The original Next/Vercel scripts remain available. Separate vinext scripts were
added for check, development, build, and local Worker start.

## 3. Next 16 migration changes

The bounded Next 16 migration required:

- `revalidateTag(tag, "max")` for the current cache invalidation contract,
- removal of obsolete Next 15 webpack-worker experimental options,
- Next 16 generated TypeScript settings and route declarations,
- `next typegen` before TypeScript checking because vinext beta and Next 16 both
  write `.next/types` using different route declaration formats,
- conversion of the PostCSS config to `.cjs` after enabling package ESM mode,
- direct Next 16 flat ESLint configuration rather than FlatCompat, and
- preservation of the prior lint policy by leaving the new
  `react-hooks/set-state-in-effect` advisory rule disabled for existing UI code.

## 4. vinext compatibility result

Initial compatibility scan: 89%.

After the bounded migration and ESLint configuration cleanup:

- imports: 5/5 supported,
- config options: 2/2 supported,
- libraries: 3/3 compatible,
- App Router: supported,
- 28 pages detected,
- 2 layouts detected,
- 44 route handlers detected,
- 2 loading boundaries detected,
- 1 error boundary detected,
- final result: **100% compatible, 0 issues**.

## 5. Actual build blocker and runtime boundary

The first real `vinext build` failed even though the static compatibility scan was
mostly clean. The first hard blocker was the admin/ingest dependency chain:

`playwright-core -> chromium-bidi`.

The following Node-only ingest packages are therefore externalized from the
Workers web bundle during M3.1:

- `@mozilla/readability`
- `crawlee`
- `got-scraping`
- `jsdom`
- `pdf-parse`
- `playwright`
- `playwright-core`
- `rss-parser`
- `chromium-bidi`

After establishing this boundary, the full vinext client/RSC/SSR build succeeds.

This externalization is not treated as proof that admin ingest can execute inside
Workers. The local ingest modules still exist in generated server chunks. M3.2 must
move execution of these operations behind an explicit asynchronous/Container
boundary rather than depending on externalized Node packages at Worker runtime.

## 6. R2 application-runtime binding

The Workers runtime uses the private binding:

- binding: `WORLDCONS_RAW`
- bucket: `worldcons-artifacts`

`worker/index.ts` is a custom vinext Worker entry. On each request it forwards the
Cloudflare R2 binding into a platform-neutral runtime slot. The shared artifact
store factory uses that slot when present and forces the R2 binding transport.

Consequences:

- Workers do not need R2 access-key/secret-key credentials,
- Node/Vercel and maintenance CLIs retain their existing provider factory,
- Workers disable legacy provider fallback in the binding-backed store, and
- storage refs, hashing, ledger, and inline-clear contracts remain unchanged.

The generated Worker bundle was inspected and contains the runtime binding slot and
binding-backed R2 transport selection. `@vercel/blob` is absent from the generated
Worker bundle.

### Local R2 binding proof

A temporary local-only probe was added during validation and removed immediately
afterward. Through local workerd it performed:

1. R2 binding put,
2. get round-trip,
3. head verification.

Result:

`HTTP 200`, `ok=true`, `provider=r2-binding`, payload size 19 bytes.

The probe wrote only to local Wrangler R2 state. It did not write production R2 or
the production database. After removal and final rebuild, the probe path returned
404.

## 7. Local Workers smoke

Representative custom-entry local workerd responses were successful:

- `/`: 200
- `/list`: 200
- `/search`: 200
- `/tags`: 200
- `/sources`: 200
- `/glossary`: 200
- `/guide`: 200
- `/rss.xml`: 200
- `/sitemap.xml`: 200
- `/robots.txt`: 200
- `/api/articles`: 200
- full-text search API: 200
- tags/sources/home APIs: 200
- `/api/mcp/health`: 200
- representative article detail: 200
- representative article print view: 200
- representative article API: 200
- representative source-text API: 200

Observed sample latency on the local host included approximately 913 ms for the
first root request, 700 ms for `/list`, 348 ms for `/search`, and 3.6 s for the
full-text QPC search request. These are local spike measurements, not production
SLO baselines.

`/api/portal/latest` and `/api/portal/latest-by-country` returned 503 with
`Portal token is not configured`, which is the route's intended behavior when the
local portal token is absent and is not a vinext compatibility regression.

## 8. Regression gates

The M3.1 checkpoint passed:

- `pnpm typecheck`
- `pnpm lint`
- `pnpm check`
- `pnpm check:vinext` — 100% compatible, 0 issues
- artifact/R2 provider/runtime-binding tests — 31/31
- public regression tests — 15/15
- `pnpm build:vinext`
- `pnpm build` for the existing Next/Vercel path
- `git diff --check`

No production deployment was performed.

## 9. Remaining blockers for M3.2

M3.2 must address two runtime boundaries before a remote non-production Worker is
treated as a meaningful deployment gate:

1. **Admin ingest/browser execution**
   - move Crawlee/Playwright/jsdom/pdf-parse execution out of the web Worker,
   - expose a bounded dispatch contract suitable for Queue/Workflow -> Container,
   - leave read-only/public Workers routes independent of these Node packages.

2. **AI router filesystem state**
   - `lib/ai/gemini-router.ts` uses dynamic filesystem resolution,
   - Next 16/Turbopack warns that this can trace the entire project into server
     output,
   - replace Worker-facing filesystem state with an explicit runtime-neutral
     configuration/state interface; use KV/R2 or another Cloudflare service where
     persistent runtime state is required.

After those boundaries are explicit, M3.2 should run a remote non-production
Worker canary with no production DNS change and repeat the representative public
page/API smoke suite.

## 10. Rollback

M3.1 does not change production authority. Rollback is therefore repository-only:

- continue using the existing Next/Vercel build path,
- do not invoke vinext deployment scripts,
- remove the M3 Worker configuration if the compatibility branch is abandoned.

M2 R2 data and all retained inline/legacy recovery protections are unaffected.
