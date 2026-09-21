# WorldCons Cloudflare M3 Remote Canary

Date: 2026-09-21

## 1. Result

M3 remote non-production Worker canary passed.

- Worker: `worldcons-m3-spike`
- URL: `https://worldcons-m3-spike.cclib.workers.dev`
- deployed Worker version observed after the final health fix: `c9347023-fb8a-4f7d-accb-bf15eba95017`
- production DNS: unchanged
- Supabase production authority: unchanged
- Worker secrets: none (`wrangler secret list` returned `[]`)
- bindings: private `WORLDCONS_RAW` R2 bucket, Images, Assets
- upload size: about 4.7 MiB, about 1.49 MiB gzip
- Worker startup time on the final deploy: 35 ms

The canary intentionally runs without production secrets. Public database reads
therefore exercise the repository's existing mock fallback rather than production
Supabase data. This checkpoint validates the remote Workers/vinext runtime and
route graph, not database migration parity; D1/Supabase parity is handled by later
milestones.

## 2. Public smoke

All representative remote requests returned HTTP 200 after the final deploy:

| Route | HTTP | observed total time |
| --- | ---: | ---: |
| `/` | 200 | 0.114 s |
| `/list` | 200 | 0.457 s |
| `/search` | 200 | 0.447 s |
| `/tags` | 200 | 0.065 s |
| `/sources` | 200 | 0.064 s |
| `/glossary` | 200 | 0.120 s |
| `/guide` | 200 | 0.060 s |
| `/rss.xml` | 200 | 0.065 s |
| `/sitemap.xml` | 200 | 0.064 s |
| `/robots.txt` | 200 | 0.045 s |
| `/api/articles` | 200 | 0.051 s |
| `/api/tags` | 200 | 0.053 s |
| `/api/sources` | 200 | 0.034 s |
| `/api/mcp/health` | 200 | 0.047 s |
| representative article detail | 200 | 0.087 s |
| representative article print view | 200 | 0.077 s |
| representative article API | 200 | 0.038 s |
| representative source-text API | 200 | 0.103 s |
| `/api/search?q=QPC` | 200 | 0.076 s |
| `/api/search?q=expression` | 200 | 0.070 s |

These are single canary observations from the operator host and are not a
production SLO benchmark.

## 3. Runtime health correction found by the canary

The first remote canary revealed that `/api/mcp/health` always reported
`deployment: "vercel"` and `version: "local"`, even when running in Cloudflare
Workers. The route was corrected to use the M3.2 runtime platform seam.

Final remote response:

```json
{
  "status": "ready",
  "service": "worldcons-plugin-mcp",
  "deployment": "cloudflare-workers",
  "version": "worker",
  "checks": {
    "database": "ok",
    "search": "ok"
  }
}
```

The fix is commit `495d4ad` (`fix: report cloudflare worker deployment health`).

## 4. Security / fail-closed evidence

The canary carries no Worker secrets. Remote probes therefore confirmed that
privileged paths do not become usable accidentally:

- admin login POST: 404 in the production-mode Worker configuration
- unauthenticated admin job drain POST: 401
- unauthenticated cron job drain: 401
- portal latest API without portal token: 503

The authenticated `admin.external_worker_required` branch was not opened by
injecting a temporary canary secret. Its runtime behaviour remains covered by the
M3.2 focused test suite, which passes 9/9 and verifies that the Worker returns the
external-worker-required result before importing Node-only executors.

## 5. M3 GO gate

M3 acceptance is satisfied:

- vinext compatibility/build passed,
- Node-only admin/ingest execution is isolated from the web Worker,
- Worker-facing Gemini router state no longer depends on filesystem persistence,
- a remote non-production Worker deployed successfully,
- representative public pages and APIs rendered successfully,
- no production DNS switch occurred,
- no production data authority changed,
- no production secret was copied into the canary,
- a remote runtime observability defect found during canary was fixed and
  revalidated.

**M3 status: GO / complete.**

The next milestone is M4 repository/data abstraction. Production authority stays
on Supabase while direct Supabase coupling is moved behind platform-neutral
repository/service contracts so a D1 implementation can be added later.
