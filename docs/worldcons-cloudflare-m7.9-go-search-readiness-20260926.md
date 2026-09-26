# WorldCons Cloudflare M7.9 — GO-SEARCH readiness closure

Date: 2026-09-26

## Status

**GO-SEARCH READINESS PASS; PRODUCTION AUTHORITY UNCHANGED.**

M7.8-B is closed. The product owner selected the non-numeric
`candidate-coverage-equivalence` policy, signed as `product-owner`, and the
first effective read-only disjoint v5 holdout passed. No production authority,
DNS, route or traffic change has been made.

The bearer-authenticated run through the actually deployed
`worldcons-search-canary` Worker passed on 2026-09-26. Together with the signed
lexical policy/holdout, semantic/hybrid `oracleDrift=0`, and the 1,258/1,258
projection/provenance checks, this closes the M7 readiness gate. The older
p50/p95 161/386 ms local-runtime evidence is retained as history but is not used
as the deployed-Worker SLO evidence.

This is a readiness decision only. `SearchRepository`, production search
authority, DNS, routes and traffic remain unchanged; cutover is a separate
reversible operation.

## 1. Closed lexical gate

- Decision record:
  `docs/operations/worldcons-m7.8b-rank-policy-decision.json`
- Policy: `candidate-coverage-equivalence`
- Signer role: `product-owner`
- Decision hash: `82962c60e602e2fc`
- Holdout hash: `1452c95c29fba160`
- Holdout cases: 18, disjoint from sealed v4
- Production/local scope: 1,258/1,258, missing 0, extra 0
- Oracle available: true
- E1: 8/8
- E2: 15/15
- E3: 18/18
- E4: 18/18
- Errors/failures/blockers: 0/0/0
- Evidence:
  `artifacts/cloudflare-m7/m7.8b-fts-parity-holdout.{json,md}`

The `fulltext_rank_threshold_unagreed` blocker is retired. Exact order,
same-set and overlap remain informational under this signed policy; no numeric
threshold was derived from the sealed v4 result.

## 2. Current deployed canary facts

Read-only checks on 2026-09-26 confirmed:

- Worker: `worldcons-search-canary`
- endpoint: `worldcons-search-canary.cclib.workers.dev`
- deployed version after the authorized secret rotation:
  `626305dd-ef8f-4a1e-99aa-a6d626c17151`, 100%
- unauthenticated `GET /health`: HTTP 401
- deployed secret name: `WORLDCONS_SEARCH_CANARY_TOKEN`
- isolated D1: `search_documents=100`, `search_fts=100`
- isolated Vectorize: dimensions 1536, vector count 100

The HTTP 401 timing is only an authentication rejection check and is not search
runtime evidence.

## 3. Deployed-runtime operator

`pnpm m7.9:deployed-runtime` is dry-run by default. It performs no query or
artifact write until an authorized operator supplies `--run` and injects the
existing bearer value into the process environment.

```text
pnpm m7.9:deployed-runtime

# authorized human/operator terminal only
pnpm m7.9:deployed-runtime -- --run --report
```

The runner:

- pins the only allowed target to
  `https://worldcons-search-canary.cclib.workers.dev`;
- reads the bearer from `WORLDCONS_SEARCH_CANARY_TOKEN` without printing or
  persisting it;
- uses linked Supabase SELECT/RPC reads only to reproduce the frozen 100-row
  canary case set;
- calls only the deployed Worker's `POST /canary/run` route;
- sends two semantic and two hybrid cases plus the bounded lexical exact/title
  cases used by the existing canary builder;
- persists no query text, document text, top ids, URL, vector or bearer value;
- has no `--apply`, D1 schema/write, Vectorize mutation, deploy or authority
  switch path.

Final evidence:

- `artifacts/cloudflare-m7/m7.9-deployed-search-canary-runtime.json`
- `artifacts/cloudflare-m7/m7.9-deployed-search-canary-runtime.md`

Each of fulltext, semantic and hybrid must independently satisfy:

- at least one evaluated case;
- mismatch rate 0;
- error rate 0;
- p50 <= 500 ms;
- p95 <= 1,500 ms.

The final content-free report has `state=pass`, no blockers and
`stableHash=cb2f07f86f76a074`:

| mode | passed | mismatch/error rate | p50 | p95 |
| --- | ---: | ---: | ---: | ---: |
| fulltext | 4/4 | 0/0 | 131 ms | 479 ms |
| semantic | 2/2 | 0/0 | 143 ms | 160 ms |
| hybrid | 2/2 | 0/0 | 453 ms | 461 ms |

The source projection was 100 documents / 100 vector records with zero missing
or stale artifacts. Aggregate runtime was p50 160 ms / p95 479 ms.

The automation/agent must not retrieve, display or transmit the deployed bearer
secret. Execution belongs to an authorized human/operator terminal. A missing
secret fails before any Worker request and creates no evidence.

## 4. Final M7 gate

| Condition | Evidence | State |
| --- | --- | --- |
| lexical policy + disjoint holdout | signed decision + M7.8-B report | PASS |
| semantic/hybrid oracle drift | M7.8-A smoke 4/4, `oracleDrift=0` | PASS |
| projection/provenance | 1,258/1,258, embedding NULL 0, mismatch 0 | PASS |
| isolated canary data | D1 100/100, Vectorize 100 | PASS |
| deployed bearer-path runtime | M7.9 runtime report, `cb2f07f86f76a074` | PASS |

All rows pass, so **`GO-SEARCH` readiness is recorded**. This does not switch
`SearchRepository`, production authority, DNS, routes or traffic. Cutover
remains a separate reversible step.

## 5. After GO-SEARCH readiness

When M7 is ready, proceed to M8 Async pipeline migration without combining the
search authority cutover into M8:

1. inventory GitHub/Vercel scheduled operational paths;
2. map each path to Cron, Queues or Workflows;
3. preserve request governor and idempotency contracts;
4. add retry, DLQ, restart/recovery and no-duplicate-publication evidence;
5. keep Browser Run versus Container selection explicit per crawler.
