# WorldCons Cloudflare M7.4 — Vectorize semantic + hybrid LOCAL foundation

Status: **code + local verification only**.
Supabase remains the sole search authority. M7.4 adds the runtime-neutral
semantic/hybrid foundation for `worldcons_ranked_search_page_v1` on top of the
M7.1 projection, M7.2 FTS5 lexical query and M7.3 ranked page: a
provenance-locked Vectorize projection/mutation *plan* from
`article_embedding_artifacts`, a structural Vectorize binding + semantic query,
and a hybrid RRF orchestrator. It performs **no deployment, push, remote
D1/Supabase mutation, Vectorize index creation, metadata index creation, binding
addition, remote rebuild, DNS change or production-flag change**, does **not**
switch `SearchRepository` authority, and makes **no `GO-SEARCH` / `GO-D1-READ`
claim**. `search_m7` stays a blocker in the M6.5 global gate.

Related: `docs/worldcons-cloudflare-full-migration-plan-20260920.md` (M7, 11.2),
`docs/worldcons-cloudflare-m7.1-search-projection-foundation-20260925.md`,
`docs/worldcons-cloudflare-m7.2-fts5-fulltext-foundation-20260925.md`,
`docs/worldcons-cloudflare-m7.3-ranked-page-local-foundation-20260925.md`,
`docs/worldcons-cloudflare-m6.5-shadow-parity-gate-20260925.md`.

## 1. The gap M7.4 closes

`worldcons_ranked_search_page_v1`
(`supabase/migrations/20260826400000_case_keys_and_ranked_pagination.sql`) has
two branches M7.3 deferred: `semantic` (pgvector cosine over
`public_article_projection_p3.embedding`) and `hybrid` (lexical `ts_rank_cd` +
semantic cosine combined with reciprocal rank fusion). The provenance authority
for the current published P3 vector is `article_embedding_artifacts`
(`supabase/migrations/20260831130000_gemini_embedding_provenance.sql`), whose
constraints already lock the provider (`gemini`), model
(`gemini-embedding-001`), dimensions (`1536`), a 64-lowercase-hex input hash and
the content hash. M7.4 turns that authority into a deterministic Vectorize
projection/plan and a fail-closed semantic/hybrid query foundation without
changing any schema, index, binding or authority.

## 2. Verified Vectorize constraints (2026-09-25 docs)

- V2 maximum dimensions for `float32` is **1536**, exactly matching the
  WorldCons Gemini embeddings (`vector(1536)`).
- `query` `topK` maximum is **100** when `returnValues=false` and
  `returnMetadata` is not `all`; `returnMetadata=indexed` is used here.
- Metadata filters are applied **before** nearest-neighbor `topK`.
- At most **10 metadata indexes** per index; indexable scalar types are
  `string`, `number`, `boolean`.
- Only the first **64 UTF-8 bytes** of an indexed string metadata value are
  filterable.
- Vectorize string arrays can be stored but are **not currently
  indexed/filterable**.
- Metadata filters must be a **non-empty** object (compact JSON < 2048 bytes), so
  an unconstrained request omits the filter instead of sending `{}`.
- Vectorize warns that **high-cardinality range filters** (for example
  millisecond `publishedEpoch` thresholds) can reduce query accuracy on large
  indexes; this is recorded as a limitation, not approximated by post-filtering.
- Vector IDs are limited to **64 bytes**; the article UUID is safe.

No behavior beyond these documented constraints is assumed. No remote setup is
performed by this milestone.

## 3. Vector projection + provenance (`lib/cloudflare/search-vector/projection.ts`)

Records are built ONLY for a current published P3 source selected exactly like
M7.1 (`selectPublishedSearchProjectionSources`, fail-closed authority) whose
`article_embedding_artifacts` row matches ALL of:

- `article_version_id == selected version.id`;
- `article_id == selected version.article_id`;
- `content_hash == selected version.content_hash`;
- `provider == gemini`;
- `model == gemini-embedding-001`;
- `dimensions == 1536`;
- `input_hash` is 64 lowercase hex;
- `embedding` parses to exactly 1536 finite numbers;
- `generated_at` is a valid ISO instant.

Contract for the non-matching cases:

- **Missing artifact** → the published article is omitted and reported
  (`missing_artifact`) in the manifest; nothing is fabricated.
- **Stale provenance** (`article_id`/`content_hash`/`provider`/`model`/
  `dimensions`/`input_hash` mismatch) → omitted and reported (`stale_artifact`).
- **Structurally malformed matching artifact** (bad width, non-finite/zero
  vector, unparseable embedding text, invalid `generated_at`, missing/typed-wrong
  fields) → **fail closed** with `invalid_artifact`.
- **Duplicate artifact for the same `article_version_id`** → fail closed with
  `duplicate_artifact`.
- **Duplicate Vectorize id (`article_id`)** in a plan → fail closed with
  `duplicate_vector_id`.

Vectors are parsed and deterministically L2-normalized with the existing
runtime-neutral `normalizeEmbeddingVector`; wrong width, non-finite values and
zero norms are rejected. The Vectorize ID is the article UUID (well under the
64-byte limit).

### 3.1 Metadata

Each record carries provenance (`articleVersionId`, `contentHash`, `provider`,
`model`, `dimensions`, `inputHash`, `generatedAt`, `projectionVersion`) plus the
scalar query-filter fields (`sourceKey`, `jurisdiction`, `contentType`,
`language`, `publishedEpoch`). Optional scalar fields are **omitted** when
null/blank; no fake placeholder string is encoded.

Recommended metadata index manifest (code/docs only — **no remote creation**):

| property | type |
| --- | --- |
| `sourceKey` | string |
| `jurisdiction` | string |
| `contentType` | string |
| `language` | string |
| `publishedEpoch` | number |

That is 5 of the maximum 10. **Tag is intentionally excluded**: a document can
carry multiple tags, array metadata is not filterable, and an exact `p_tag`
filter is therefore deferred rather than approximated.

### 3.2 Deterministic manifest + mutation plan (plan only)

`vectorProjectionManifest` emits counts + a deterministic non-crypto
`shadowDigest` over `{id, fingerprint}` (no vector values, no content).
`planVectorFullProjection` upserts the desired set. `planVectorIncrementalSync`
compares a stable identity/provenance/vector fingerprint (non-crypto digest over
the canonical metadata + values) and emits `added`/`changed`/`removed`/
`unchanged`, upserts and delete IDs; a version/content/input/model or vector
change forces an upsert and a removal deletes the stale Vectorize ID.
`vectorMutationPlanSummary` emits ids/counts/provenance only — **never vector
values**. There is no `--apply` and no remote call.

## 4. Structural binding + semantic query (`binding`, `semantic.ts`)

The runtime-neutral binding matches current Worker usage and needs no
`@cloudflare` import:

```ts
query(vector, { topK, filter?, returnValues: false, returnMetadata: "indexed" })
  -> { count?, matches: [{ id, score, metadata? }] }
```

- Query embeddings are validated (exactly 1536 finite numbers) and normalized
  deterministically; wrong width, non-finite and zero vectors fail closed with
  `invalid_embedding`.
- The metadata filter builds `sourceKey`/`jurisdiction`/`contentType`/`language`
  equality and a `publishedEpoch >= threshold` `$gte` derived from the same
  M7.2/M7.3 UTC range semantics (`searchFtsRangeThresholdIso`), so the filter is
  applied before `topK`. When the request constrains nothing (for example the
  default `latest` range with no scalar filters) the filter is **omitted entirely
  (null)** rather than sent as `{}`: Vectorize documents that `filter` must be a
  non-empty object, so an empty object is never transmitted.
- `p_tag` fails closed with the stable `tag_filter_deferred` code; the topK
  window is never post-filtered.
- `topK = offset + limit + 1`; anything above 100 fails closed with
  `vector_window_exceeded`. A consequence worth recording: with the current
  no-values/indexed-metadata query, the semantic branch can only serve
  `offset + limit + 1 <= 100` (for example `limit <= 99` at offset 0).
- The response is validated fail-closed (`matches` array, unique non-empty ids,
  finite scores, indexed metadata shape) and re-ordered
  `score desc, publishedEpoch desc nulls last, id asc`.
- `count = exact` is **not** derivable from a Vectorize topK query and fails
  closed with `vector_exact_count_deferred`; `planned`/`estimated`/`none` use the
  RPC lower-bound page semantics.
- No embedding on a non-exact semantic/hybrid request fails closed with the
  RPC-equivalent `embedding_required`.

## 5. Hybrid RRF (`lib/cloudflare/search-vector/hybrid.ts`)

For a non-exact hybrid request: require a 1536 embedding, no tag, `count != exact`,
and the RPC candidate limit
`min(max((offset+limit+1)*3, 100), 30063)`. Because both local candidate lists
are capped at 100, the branch is supported only when that limit is `<= 100`
(typical first page is exactly `100`) and fails closed with
`vector_window_exceeded` otherwise.

1. lexical top `candidateLimit` via the M7.2/M7.3 `buildSearchFtsQuery`
   (safe compiler + bound filters, exact-title priority, offset 0);
2. semantic top `candidateLimit` via Vectorize with the same scalar/range
   pre-filter;
3. union by article id;
4. one/few fully parameterized D1 `IN` metadata lookups (batch <= 100 bound IDs)
   for the encoded `search_fts.title` + `search_documents.original_published_at`;
5. exact-title determination for semantic-only candidates and deterministic
   tie-breaks from that D1 metadata;
6. RRF score exactly `(lexRank ? 1/(60+lexRank) : 0) + (semRank ? 1/(60+semRank) : 0)`;
7. order `exact_title desc, score desc, original_published_at desc nulls last,
   id asc`; trim `offset` and `limit + 1`; lower-bound total.

Entries are `{ id, score, lexicalRank, semanticRank, semanticSimilarity }`
matching the RPC shape; semantic entries also carry `semanticSimilarity = score`.
`exact-case` and empty-query `latest` keep the frozen M7.3 behavior and work
**without** a Vectorize binding even when the requested mode is semantic/hybrid.
If a non-exact semantic/hybrid request has no Vectorize binding the orchestrator
fails closed with `vectorize_unavailable` — there is **no lexical fallback**.

## 6. Orchestrator (`lib/cloudflare/search-vector/ranked.ts`)

`runVectorRankedSearchPage({ d1, vector?, input })` delegates `exact-case`,
empty-query `latest` and `fulltext` to the unchanged M7.3
`runRankedSearchPage`, and adds `semantic`/`hybrid` only through the injected
Vectorize binding. It is **not** selected by `lib/search/repository/index.ts`;
Supabase remains authoritative.

## 7. Local tests

`tests/d1-vector-search.test.ts` (32 tests) uses a deterministic in-memory fake
Vectorize binding (1536-d unit vectors generated programmatically) and the local
`node:sqlite` D1 executor. It covers: projection success; missing/stale/malformed
artifact handling; duplicate artifact/vector-id fail-closed; add/change/remove/
no-op mutation plans with no vector values in the summary; the five-field
metadata manifest; the null-vs-exact metadata filter (no empty `{}` is ever sent);
the exact hybrid candidate-limit formula; exact-case/latest without a binding;
embedding-required; vectorize-unavailable; malformed query embeddings; semantic
DE/FR/ES/US scalar prefilters; today/week/month/latest ranges; semantic
score/date/id tie-breaks; tag deferral; semantic pagination + the exact
`offset + limit + 1` topK and its 100 ceiling (with no query sent once rejected);
semantic exact-count deferral and lower-bound totals; malformed Vectorize
responses; hybrid RRF agreement; the hybrid candidate limit at both the Vectorize
topK (100) and bound FTS limit; a semantic-only exact-title candidate whose
exact-title priority comes from the D1 metadata lookup; parameterized/`IN`-bound
hybrid metadata SQL with one bound value per `?`; unchanged
Supabase-authoritative `SearchRepository` + `search_m7` blocker; and runtime-neutral
`search-vector` / `search-ranked` libraries (no `node:*`, `fetch`, or remote
mutation calls).

## 8. Local operator tooling

```
pnpm d1:vector-local --fixture=corpus.json
pnpm d1:vector-local --fixture=next.json --current=current.json --json
pnpm d1:hybrid-local --fixture=corpus.json --query=constitution --limit=5
pnpm d1:hybrid-local --fixture=corpus.json --query=constitution --mode=semantic --embedding-seed=3 --json
```

Local and dry-run only: in-memory `node:sqlite` + an in-memory fake Vectorize
index. The query embedding is a deterministic local fake, not a Gemini call. No
production credentials, no network, no remote read/write, no `--apply`.

## 9. Explicit non-goals

- **No Vectorize index was created** and **no metadata index was created**.
- **No vectorize binding was added** to any Worker/wrangler config, and no
  remote rebuild was executed.
- **No SearchRepository switch**: Supabase remains the sole search authority.
- **No production parity threshold** and **no `GO-SEARCH` / `GO-D1-READ`**.
- `search_m7` remains a blocker in the M6.5 global gate.
- No schema migration and no D1/Supabase migration change; the only additive
  type change is an optional `content_hash` on the M7.1 version source, which
  does not alter any migration.
- Current limitations recorded: `p_tag` deferred (`tag_filter_deferred`), exact
  semantic/hybrid count deferred (`vector_exact_count_deferred`), the <= 100
  topK/candidate window (`vector_window_exceeded`), and the Vectorize
  high-cardinality-range accuracy caveat for millisecond `publishedEpoch`
  thresholds (recorded, never approximated by post-filtering `topK`).

## 10. Provenance

Clean HEAD `2b17630a709265e77028c25a7547ce35b5b4e02c`.
