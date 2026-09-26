# WorldCons Cloudflare M7.5 — remote search materialization operator

Status: **operator tooling + local verification only**.
Supabase remains the sole search authority. M7.5 adds the operator-only,
dry-run-by-default tooling to materialize the M7.1 `worldcons_search` D1
projection and the M7.4 `worldcons-search` Vectorize projection from the current
Supabase authority. It performs **no Worker deploy, binding change,
`SearchRepository` switch, DNS change, push, commit or remote mutation** by
itself, and makes **no `GO-SEARCH` / `GO-D1-READ` claim**. `search_m7` remains a
blocker in the M6.5 global gate.

Related: `docs/worldcons-cloudflare-full-migration-plan-20260920.md` (M7, 11.2),
`docs/worldcons-cloudflare-m7.1-search-projection-foundation-20260925.md`,
`docs/worldcons-cloudflare-m7.2-fts5-fulltext-foundation-20260925.md`,
`docs/worldcons-cloudflare-m7.3-ranked-page-local-foundation-20260925.md`,
`docs/worldcons-cloudflare-m7.4-vectorize-semantic-hybrid-foundation-20260925.md`.

## 1. Preflight facts (dated observations, not permanent assumptions)

Recorded 2026-09-25 against clean HEAD `2a7be3e2921260836461c9fb263ce1e0c68ee511`.
These are observations for the reviewer; the operator re-reads every value at
run time and fails closed on drift.

- Supabase remains the sole production authority for public search, publications
  and article content.
- Remote D1 `worldcons_search` exists with UUID
  `1d74ebba-918b-4f8c-9c5c-9013479df809`; the `search_documents` table and the
  `search_fts` FTS5 index both exist but are empty.
- Vectorize v2 has **no** `worldcons-search` index.
- The deployed `worldcons-m3-spike` currently exposes **no** D1 or Vectorize
  bindings. The repository `wrangler.jsonc` nonetheless records the four D1
  databases (including `worldcons_search`), so the operator treats the recorded
  id as a *check*, not as proof the deployed binding exists.
- The generic `d1:reconcile` path is not the M7 source path: wide canonical rows
  and its Wrangler/CLI output surface are fragile for this projection. M7.5
  sources directly from the current Supabase authority with narrowly authored
  fields instead.
- Cloudflare D1 `batch` is transactional per batch; multiple batches are **not**
  globally atomic, which is why M7.5 persists a pre-apply snapshot and never
  reports a partial run as success.

## 2. Narrow Supabase loader (`lib/cloudflare/search-materialize/source.ts`)

The loader reuses the existing linked runner and SQL/parse helpers
(`createSupabaseLinkedQueryRunner`, `buildPostgresSelectSql`,
`parseSupabaseLinkedRows`), but it never issues `select *` and never uses a
generic full-table projection. Each relation selects exactly the fields the
M7.1/M7.4 builders consume:

| relation | page size | notes |
| --- | --- | --- |
| `article_publications_p3` | 25 | publication authority fields |
| `article_content_versions_p3` | 25 | **no** `raw_text` / `search_vector` / `embedding`; includes `content_hash` |
| `articles` | 200 | `id`, `review_state` only |
| `tags` | 200 | `id`, `slug`, `name`, `normalized_name`, `type` |
| `article_tags` | 200 | `article_id`, `tag_id` |
| `article_embedding_artifacts` | 25 | the only reader of `embedding` |

- deterministic primary-key order; safe per-relation row ceiling;
- a failed page fails closed with the relation and offset only (no raw CLI
  output);
- after collection, every relation's **full authored column set** is read a
  second time and the count + fingerprint are compared; a change to any projected
  field fails closed with `source_mutation_detected`.

## 3. Desired projection (`lib/cloudflare/search-materialize/build.ts`)

`buildSearchProjection` (M7.1) and `buildVectorProjection` (M7.4) are reused
unchanged. The added value is the safe manifest: source counts, published count,
search count/hash, vector count/hash and missing/stale artifact counts. No
document text, embeddings, URLs, raw metadata or secrets are emitted.

## 4. Cloudflare preflight (`lib/cloudflare/search-materialize/cloudflare.ts`)

- account id from `CLOUDFLARE_ACCOUNT_ID` or `wrangler whoami --json`; API token
  from `CLOUDFLARE_API_TOKEN` or `wrangler auth token --json` (existing safe
  parsing from `scripts/d1-copy-data.ts`, reused). Neither value is ever printed.
- the exact `worldcons_search` D1 database is resolved from exactly one
  `d1 list --json` entry; when the repository `wrangler.jsonc` records an id it
  must match, otherwise the run refuses.
- Vectorize v2 indexes are listed; the target is exactly `worldcons-search`. If
  it exists its dimensions must be 1536 and its metric cosine, otherwise the run
  refuses. A dry-run creates nothing.

## 5. D1 remote materialization (`lib/cloudflare/search-materialize/d1.ts`)

- reads the compact current `search_documents` (`article_id`, `checksum`,
  `projection_version`) and `search_fts` (`article_id`) identity; duplicate ids
  and any `search_documents`/`search_fts` identity mismatch fail closed;
- plans with `planSearchProjectionIncrementalSync`; an empty remote therefore
  yields additions only and a matching remote is a true no-op. A destructive full
  rebuild is never selected by default;
- apply requires **both** `--apply-d1` and
  `--confirm-search-db=worldcons_search`;
- statements are grouped into conservative REST `batch` bodies
  `{ batch: [{ sql, params }, ...] }`, each statement hard-scoped to
  `search_documents`/`search_fts`;
- because multiple batches are not globally atomic, a deterministic pre-apply
  snapshot of **both** tables is persisted before the first write; an apply with
  no snapshot writer fails closed and writes nothing;
- a mid-run failure stops immediately and marks `rollback_required`; there is no
  false success; a snapshot read/write failure happens before any write, so it is
  a plain `failed` apply and never claims `rollback_required`;
- `--rollback-d1=<snapshot>` is an explicit restore mode; there is no hidden
  automatic rollback;
- after apply, both tables are re-read and an exact count/hash/checksum/version
  and FTS identity match is required; a rerun after success plans zero writes.

## 6. Vectorize materialization (`lib/cloudflare/search-materialize/vectorize.ts`)

- target exactly `worldcons-search`, 1536 dimensions, cosine metric;
- dry-run with an absent index reports `needs_provision`;
- index creation requires `--apply-vector` + `--provision-vector-index` +
  `--confirm-vector-index=worldcons-search`;
- metadata indexes are exactly `sourceKey: string`, `jurisdiction: string`,
  `contentType: string`, `language: string`, `publishedEpoch: number`; a wrong
  type always refuses and missing ones are created only during an explicit apply
  (via `metadata_index/create`, polling the returned mutation id) and then
  verified through `metadata_index/list` (`indexType`);
- current vector ids are listed with `GET .../list?count=&cursor=` pagination;
  the endpoint returns identifiers only, so no vector value is ever received,
  persisted or logged;
- an absent/empty index upserts the desired set; an existing index idempotently
  upserts every desired vector and deletes remote-only ids via `delete_by_ids`
  (exact value fingerprints are not assumed readable, so change detection is not
  pretended);
- upserts use `application/x-ndjson` bounded batches; the NDJSON is built
  transiently, handed to `fetch` once and never logged or persisted;
- every mutation `mutationId` (upsert, delete and metadata-index creation) is
  captured and `/info` (`processedUpToMutation`) is polled until it equals that
  mutation id or the timeout fails closed;
- verification re-lists exact ids/`vectorCount` and the metadata index
  manifest/dimensions;
- vector apply requires zero missing/stale artifacts. D1 apply is independent and
  may still proceed when the vector projection is incomplete: it is never rolled
  back by a vector refusal.

## 7. CLI (`scripts/d1-search-materialize.ts`)

```
pnpm d1:search-materialize                       # dry-run (default)
pnpm d1:search-materialize --json
pnpm d1:search-materialize --apply-d1 --confirm-search-db=worldcons_search
pnpm d1:search-materialize --apply-vector --confirm-vector-index=worldcons-search
pnpm d1:search-materialize --apply-vector --provision-vector-index --confirm-vector-index=worldcons-search
pnpm d1:search-materialize --rollback-d1=artifacts/.../snapshot.json --confirm-search-db=worldcons_search
```

Options include source/linked overrides (`--linked-max-stdout-bytes`,
`--linked-timeout-ms`), page/ceiling overrides (`--versions-page-size`,
`--artifacts-page-size`, `--relations-page-size`, `--*-max-rows`), REST/Vectorize
batching and timeout overrides, `--snapshot`, `--report`, `--json`, the two
explicit apply confirmation pairs, and `--rollback-d1`. A bare `--apply` and any
`--deploy` / `--binding` flag are refused. There are no deploy or binding flags.

## 8. Deterministic safe report

The report includes only `dryRun`/`applied` components, source counts and
fingerprint, D1 current/desired counts and hashes plus plan change/statement/
batch counts, Vectorize state/config/current/desired id counts plus mutation plan
counts and metadata index status, omission counts, verification and errors. It
never contains row JSON, search text, URLs, embeddings, auth output, token/account
secrets or raw Supabase output. `blockedBy` always records `search_m7`.

## 9. Tests (`tests/d1-search-materialize.test.ts`, `pnpm test:d1-search-materialize`)

All network boundaries are mocked. Coverage includes: narrow source SQL (no
`raw_text`/`search_vector`/version `embedding`, bounded pages, deterministic
order), bounded-page failure (relation+offset only), source mutation detection,
safe max; desired safe manifest; D1 initial/incremental/no-op, duplicate and
identity fail-closed, bounded batch groups, a mandatory persisted snapshot before
apply, per-batch transaction failure and `rollback_required`, explicit restore,
statement scope refusal, REST batch body shape; D1 confirmation gates; Vectorize
absent/present/config mismatch, metadata index assessment, completeness refusal,
provision/upsert/verify, the exact v2 request/response shapes (`GET .../list` with
`count`/`cursor` and `totalCount`, `metadata_index/list` with `indexType`,
`metadata_index/create` with `{ propertyName, indexType }`, `/info` string
`processedUpToMutation` equality, NDJSON upsert and `delete_by_ids`), malformed
shapes failing closed, mutation polling success/timeout; dry-run zero mutations;
SearchRepository remains Supabase; Worker config/bindings untouched; `search_m7`
blocker; safe report redaction.

## 10. Explicit non-goals

- **No remote mutation is performed by this worker**: no D1 apply, no Vectorize
  index or metadata index creation, no upsert/delete, no rollback.
- **No Worker deploy, binding change, DNS change, push or commit.**
- **No `SearchRepository` switch**: Supabase remains the sole search authority.
- **No production parity threshold** and **no `GO-SEARCH` / `GO-D1-READ`** until
  live materialization, parity and latency evidence exist.
- `search_m7` remains a blocker in the M6.5 global gate.

## 11. Provenance

Clean HEAD `2a7be3e2921260836461c9fb263ce1e0c68ee511`.
Verification: `pnpm test:d1-search-materialize`, `pnpm test:d1-search-projection`,
`pnpm test:d1-fts-search`, `pnpm test:d1-ranked-search`,
`pnpm test:d1-vector-search`, `pnpm test:search-repository`, `pnpm test:d1-schema`,
`pnpm test:d1-shadow-parity`, `pnpm typecheck`, `pnpm check`, targeted eslint and
`git diff --check`.
