# WorldCons T3 service-binding adapters

Provider-owned T3 candidates for CCLRAG2. Public HTTPS search stays the current contract. This change does not provision, deploy, or enable a live Cloudflare service binding.

## Surfaces

| Surface | Owner behavior | Trust |
| --- | --- | --- |
| Public HTTPS `GET /api/cclrag2/*` | Unchanged Next.js/Worker route, existing public rate limit, Contract V2 JSON | Public published-only search; `authentication: none` |
| Fetch adapter candidate | CCLRAG2 may later call `WorldconsSearchService.fetch` against the existing HTTP handlers. Provider mints only `https://worldcons.t3.invalid/api/search` internally; callers cannot supply a URL | Same handlers as HTTPS. Same-account binding is not tenant trust and does not add privilege |
| RPC `searchV1` | Typed `WorkerEntrypoint` method plus a Node-testable adapter | Fail-closed until T1 is owner-signed, `WORLDCONS_CCLRAG2_T3_BINDING_ENABLED=true`, and `Authorization: Bearer` matches `WORLDCONS_CCLRAG2_S2S_TOKEN` |

`searchV1` argument:

```ts
{
  operation: "search" | "capabilities";
  scope: "published_foreign_constitutional";
  query: string;
  limit: number; // 1..20
  contractVersion: "2.0";
  authorization?: string; // Bearer S2S only; not a query semantic
}
```

Capabilities through T3 are metadata-only: no D1, R2, Vectorize, or network. Search reuses `handleWorldconsSearchRequest` and the Contract V2 success/error envelope (`contractVersion`, `schemaVersion`, `requestId`, `service`, `error.code`).

## Safety gates

- Default disabled. T1 remains unsigned until the owner sets `WORLDCONS_CCLRAG2_T1_CONTRACT_STATUS=signed`.
- Cloudflare same-account binding alone is not authentication.
- Anonymous RPC is rejected (`AUTH_REQUIRED` / `BINDING_DISABLED`).
- `WORLDCONS_PORTAL_TOKEN` cannot authorize case search. Catalog-only worldlaw is never primary case or statute evidence; `scope` must be `published_foreign_constitutional`.
- No arbitrary URLs, proxy/fetch operations, raw D1/R2 handles, or private index access.
- Timeout 8s, page size ≤ 20, query ≤ 200 characters, response byte limits from Contract V2.
- `wrangler.jsonc` has no T3 enable flag, no S2S secret, and no `services` binding. Do not add them in this task.

## Adaptation

1. Keep public HTTPS consumers on `/api/cclrag2`.
2. After the owner signs T1, configure Worker secrets `WORLDCONS_CCLRAG2_S2S_TOKEN` and set `WORLDCONS_CCLRAG2_T1_CONTRACT_STATUS=signed` plus `WORLDCONS_CCLRAG2_T3_BINDING_ENABLED=true` in a later owned change.
3. CCLRAG2 should call existing paths through `binding.fetch` without weakening those endpoints, and may call `searchV1` only with the dedicated bearer.
4. Align the CCLRAG2 routing selector to `searchV1` later; this provider side is independent.

Live Cloudflare invocation, search-provider calls, performance benchmarks, and holdout tests are deferred.

## Rollback

1. Leave or restore unset T3 env vars. Unset/false `WORLDCONS_CCLRAG2_T3_BINDING_ENABLED` or unsigned T1 returns `BINDING_DISABLED` and executes no search.
2. Do not add or keep a wrangler `services` entry for CCLRAG2.
3. Public HTTPS routes require no rollback; they were not switched.
4. Remove `searchV1` from `WorldconsSearchService` only if the typed candidate itself must be withdrawn. Existing `fetch` and `searchCclMetasearch` stay.

## Local checks

```powershell
pnpm exec tsx --test tests/cclrag2-t3-service-binding.test.ts
pnpm exec tsc --noEmit -p tests/tsconfig.cclrag2-t3.json
```

These checks use local fixtures. They do not deploy, bind Cloudflare services, or certify live RPC.
