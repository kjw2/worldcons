# WorldCons provider capabilities (T1)

`GET /api/cclrag2/capabilities` publishes the provider-owned Contract V2 discovery manifest. `GET /api/capabilities` is a public discovery alias. The named internal search service also handles `GET /api/capabilities` using the same source.

The source of truth is `lib/integrations/cclrag2/capabilities.ts`. Its version, supported search parameters/enums, request and response limits, and official source boundaries are shared with the provider handler. The JSON response contains `schemaVersion: 1`, `contractVersion: "2.0"`, `providerId: "worldcons"`, and a correlated `requestId`. `apiBasePath` identifies the public provider prefix; resolve each advertised endpoint `path` against that prefix, including when discovery was requested through the root alias.

The manifest describes supported contracts, rather than live availability, completeness, freshness, or production quality. It performs no database reads, model calls, or upstream requests and requires no credentials. The source list describes supported jurisdiction/official-host boundaries; `/sources` remains the active inventory. Semantic and hybrid modes require configuration and can explicitly degrade to fulltext as described by the manifest and search response. Optional evidence values depend on the owned record.

Discovery accepts no query parameters and only GET. The shared handler returns the existing Contract V2 `400`, `404`, and `405` error envelopes for invalid parameters, unknown resources, and unsupported methods. Public route adapters retain public API rate limiting. Success responses use `no-store`, `nosniff`, `X-Provider-Contract-Version`, and `X-Request-Id`, and are bounded to 32,000 UTF-8 bytes.

Focused local checks:

```powershell
pnpm exec tsx --test tests/cclrag2-capabilities.test.ts tests/cclrag2-provider-route.test.ts
pnpm exec tsc --noEmit -p tests/tsconfig.cclrag2-capabilities.json
```

These checks use local fixtures and rejecting dependency stubs. They do not run production quality, latency, cost, or cross-system integration validation. Deployment and owner commit/push remain with the orchestrator.

T3 service-binding adapter candidates (`searchV1` and fixed-path fetch) are documented in [worldcons-t3-service-binding.md](worldcons-t3-service-binding.md). They stay disabled until this T1 contract is owner-signed and the caller presents a dedicated S2S bearer. Public discovery and search authentication are unchanged.
