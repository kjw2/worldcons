# WorldCons Cloudflare M9 — API/Hono service extraction and canary completion

Date: 2026-09-27
Base checkpoint: `fd4e14dbcbbf717fb71a259bfba032387b7ac3f2`
M9.0 checkpoint: `ffc8e2e477797a94b597de04d5960d48a54a2c68`
M9.1 checkpoint: `1cd40a9f7e745a6b9b81d733a1c0d8aa64bf2c34`
Cross-repository cclmetasearch checkpoint: `c3a73253d7480d688c59d32cc42ae5010e23a878`

## Status

**M9 SERVICE EXTRACTION IMPLEMENTED, DEPLOYED AND CANARY-PROVEN; RESTING
SERVICE-BINDING FLAGS OFF; PUBLIC CUTOVER OFF.**

M9 was completed without changing the current public API authority. The first
extracted boundary is the existing cclrag2 provider because its core handler was
already Web-standard `Request -> Response`, explicitly environment-injected,
and covered by a stable contract suite.

The current Vercel/Next route remains the public compatibility adapter. It still
applies the existing `publicApi` rate limit first. Only after that gate does it
optionally call the internal search Worker through a Service Binding. The
Service Binding is default-off, so the current direct provider handler remains
the runtime path until a later canary explicitly enables it.

## Architecture added

### Internal Hono Worker

- Worker: `worldcons-search`
- Entry: `workers/search-service/src/index.ts`
- Framework: Hono `4.13.9`
- Public exposure: none
  - `workers_dev=false`
  - no routes/custom domains
- Internal routes:
  - `GET /health`
  - `/api/*` -> existing `handleWorldconsSearchRequest()`
  - `POST /internal/cclmetasearch/search`
  - `GET /internal/upstream-probe` for bounded secret-free upstream readiness
- Required runtime configuration:
  - `SUPABASE_URL`
  - `SUPABASE_SERVICE_ROLE_KEY`
  - `GEMINI_API_KEY`
  - bounded non-secret provider vars from the Worker config

The internal Worker intentionally reuses the existing provider implementation.
M9 does not fork cclrag2 search semantics. The cclmetasearch internal endpoint
returns only the bounded raw page required by the consumer adapter.

### Service Binding seam

The vinext Worker now declares:

```text
WORLDCONS_SEARCH_SERVICE -> worldcons-search
WORLDCONS_SEARCH_SERVICE_ENABLED=false
```

`lib/cloudflare/services/search-service-binding.ts` owns the runtime seam.
The top-level Cloudflare Worker injects the binding once per request. The
cclrag2 compatibility route then:

1. applies the existing public rate limiter;
2. rewrites `/api/cclrag2/*` to the provider's existing `/api/*` contract;
3. forwards through the Service Binding only when the explicit runtime flag is
   true;
4. otherwise executes the existing provider handler directly.

If the flag is explicitly enabled but the binding is unavailable, the route
fails closed with the existing provider-style 503 response instead of silently
falling back. This prevents a broken canary from being hidden by the old path.

## M9.1 cclmetasearch data-plane extraction

The cclmetasearch public authentication/rate-limit boundary remains unchanged.
WorldCons can route its validated search executor through
`worldcons-search`, and the separate cclmetasearch Cloudflare Worker now has
its own private Service Binding:

```text
WORLDCONS_SEARCH_SERVICE -> worldcons-search
WORLDCONS_SEARCH_SERVICE_ENABLED=false
```

When the cclmetasearch flag is OFF, its existing
`WORLDCONS_SEARCH_TOKEN` public HTTPS path remains authoritative. When the
flag is ON, the cclmetasearch Worker calls
`POST /internal/cclmetasearch/search` directly and reconstructs the existing
`items + meta` public adapter envelope locally. An enabled-but-missing binding
fails closed instead of silently falling back.

The cclmetasearch repository checkpoint for this seam is
`c3a73253d7480d688c59d32cc42ae5010e23a878`.

## Contract preservation

M9.0 deliberately keeps the existing provider payload, headers, request ids,
cache policy and current `transport` field unchanged. The first canary is about
execution location, not a public contract version change.

The Service Binding is internal transport only. Client IP/rate-limit policy
stays at the public adapter, so extracting the search service cannot bypass the
current distributed/local rate-limit boundary.

## Runtime issue found and fixed

The first cclrag2 Service Binding canary reached `worldcons-search`, but the
main vinext Worker returned Cloudflare 1101 while passing the downstream
`Response` object through unchanged. Observability showed that the downstream
Worker itself had completed successfully. The runtime seam now materializes the
bounded downstream body and constructs a new local `Response` before returning
through the vinext/Next route boundary.

After that fix, the internal upstream probe returned 200 through the main
Service Binding with:

- all three required secret/config presence booleans true;
- Supabase REST 200 in 995 ms;
- `worldcons_provider_sources_v1` RPC 200 in 80 ms;
- no secret values emitted.

The temporary public-forward probe alias used during diagnosis was removed.
Only the internal-only probe remains.

## Verification

Completed:

- `pnpm test:m9`: 8/8 pass
  - direct provider vs Hono response contract parity
  - internal-only Worker config
  - default-off binding behavior
  - fail-closed enabled-without-binding behavior
  - public rate-limit ordering before Service Binding
- `pnpm m9:types`: generated current Worker ambient types
- `pnpm m9:types:check`: pass
- `pnpm m9:typecheck`: pass
- `pnpm m9:dry-run`: pass, 109.12 KiB upload / 27.26 KiB gzip
- `pnpm test:cclrag2`: 19/19 pass
- `pnpm test:provider:search`: 20/20 pass
- `pnpm test:security`: 6/6 pass
- root `pnpm typecheck`: pass
- `pnpm lint`: pass
- `git diff --check`: pass
- `pnpm build:vinext`: pass
- generated `dist/server/wrangler.json` preserves
  `WORLDCONS_SEARCH_SERVICE -> worldcons-search` and
  `WORLDCONS_SEARCH_SERVICE_ENABLED=false`
- `wrangler deploy --dry-run --config dist/server/wrangler.json`: pass
- `pnpm test:plugin`: 12/12 pass
- `pnpm plugin:validate`: pass
- `pnpm test:masterdash`: 22/22 pass
- Cloudflare plugin health: HTTP 200 `ready`, database/search both `ok`
- Cloudflare MasterDash health: HTTP 200 degraded when the collector DB is not
  configured, matching the established 2xx degraded contract

### cclrag2 live canary

- Vercel baseline, `gerrymandering`, fulltext: HTTP 200, total 1.
- Cloudflare Service Binding canary, same request: HTTP 200, same contract
  version 2.0, same single US Supreme Court result, `degraded=false`.
- Hybrid German freedom-of-expression canary: HTTP 200,
  `effectiveMode=hybrid`, `degraded=false`, total 4.
- The Vercel baseline for that hybrid request degraded to fulltext because its
  embedding key was not configured; Cloudflare exercised the intended Gemini
  embedding path successfully.

### cclmetasearch live canary

- Existing public-HTTPS baseline: `worldcons` source completed with one result.
- Private-binding query `gerrymandering gerrymandering` created a fresh search
  session and completed with one result.
- Cloudflare Observability recorded
  `POST https://worldcons-search.internal/internal/cclmetasearch/search` on
  `worldcons-search` version
  `4c30ae13-a5ed-4602-80c1-6bda9b23c86c`, HTTP 200, outcome `ok`,
  wall time 4819 ms.
- The search Worker was then hardened to remove the temporary public-forward
  probe alias and redeployed as
  `881574e8-f145-483b-96af-4a34a0ead469`.

The raw root `wrangler.jsonc` cannot be bundled directly after a vinext build
because `vinext/server/fetch-handler` depends on the virtual
`virtual:vinext-worker-entry`. The correct generated
`dist/server/wrangler.json` path passes and includes the Service Binding.

## Deployment and resting state

- `worldcons-search` is deployed internal-only at version
  `881574e8-f145-483b-96af-4a34a0ead469`.
- `workers_dev=false` and preview URLs are disabled for the search Worker.
- Required `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and
  `GEMINI_API_KEY` secrets are present and were validated only through
  secret-free readiness evidence.
- `worldcons-m3-spike` has
  `WORLDCONS_SEARCH_SERVICE -> worldcons-search`.
- At rest:
  - `WORLDCONS_SEARCH_SERVICE_ENABLED=false`
  - `WORLDCONS_CCLMETASEARCH_SERVICE_ENABLED=false`
- `cclmetasearch` also has
  `WORLDCONS_SEARCH_SERVICE -> worldcons-search` and rests with
  `WORLDCONS_SEARCH_SERVICE_ENABLED=false`.
- The existing public Vercel/provider paths remain authoritative and available
  as rollback paths.
- M8 scheduler remains unrelated and disabled as recorded in M8.

## M9 acceptance decision

**GO-SERVICE-BINDING: PASS.**

The Hono search service, cclrag2 binding, cclmetasearch binding, plugin contract
and MasterDash contract have all been verified. Both production-facing binding
flags intentionally rest OFF after canary, so this decision does **not** claim
the M12 public frontend/API cutover and does not change Supabase write
authority.

Next milestone: M10 bounded D1 write canary.
