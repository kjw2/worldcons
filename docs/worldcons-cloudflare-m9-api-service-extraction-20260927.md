# WorldCons Cloudflare M9.0 — API/Hono service extraction foundation

Date: 2026-09-27
Base checkpoint: `fd4e14dbcbbf717fb71a259bfba032387b7ac3f2`

## Status

**M9.0 SEARCH SERVICE FOUNDATION IMPLEMENTED AND VERIFIED; PUBLIC CUTOVER OFF;
INTERNAL WORKER DEPLOYMENT PENDING REQUIRED SECRET INJECTION.**

This step begins M9 without changing the current public API authority. The first
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
- Required runtime configuration:
  - `SUPABASE_URL`
  - `SUPABASE_SERVICE_ROLE_KEY`
  - `GEMINI_API_KEY`
  - bounded non-secret provider vars from the Worker config

The internal Worker intentionally reuses the existing provider implementation.
M9.0 does not fork search semantics or create a second result mapper.

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

## Contract preservation

M9.0 deliberately keeps the existing provider payload, headers, request ids,
cache policy and current `transport` field unchanged. The first canary is about
execution location, not a public contract version change.

The Service Binding is internal transport only. Client IP/rate-limit policy
stays at the public adapter, so extracting the search service cannot bypass the
current distributed/local rate-limit boundary.

## Verification

Completed:

- `pnpm test:m9`: 5/5 pass
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

The raw root `wrangler.jsonc` cannot be bundled directly after a vinext build
because `vinext/server/fetch-handler` depends on the virtual
`virtual:vinext-worker-entry`. The correct generated
`dist/server/wrangler.json` path passes and includes the Service Binding.

## Deployment status and blocker

`worldcons-search` did not previously exist in the Cloudflare account. The
first real deploy correctly refused because the Worker config declares three
required secrets and Wrangler requires those secrets during creation.

An attempt to construct a temporary three-key secrets file from the existing
operator `.env` was blocked by the host safety layer before execution. That
safety check was not bypassed. No secret value was printed, copied into the
repository, or sent through another channel.

Therefore:

- `worldcons-search` is **not deployed yet**;
- the main Worker is **not redeployed**;
- `WORLDCONS_SEARCH_SERVICE_ENABLED` remains **false**;
- Vercel/direct provider behavior remains authoritative;
- M8 scheduler remains unrelated and disabled as recorded in M8.

## Next M9 sequence

1. Inject the three required secrets through an authorized Cloudflare secret
   path and deploy internal `worldcons-search`.
2. Exercise `/health` and the internal search contract through a Service
   Binding canary, not a public workers.dev URL.
3. Deploy the vinext Worker with the binding still disabled and verify no public
   contract change.
4. Enable only `WORLDCONS_SEARCH_SERVICE_ENABLED=true` for cclrag2, then run
   the provider/plugin/cclrag2/cclmetasearch/MasterDash parity suite.
5. After a stable canary, extract the next Worker-neutral API boundary. Do not
   move MasterDash/admin mutation surfaces before their auth/ops dependencies
   have an equally explicit Service Binding contract.
