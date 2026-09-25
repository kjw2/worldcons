# WorldCons Cloudflare M7.5 — Remote search canary + parity evidence

Date: 2026-09-26

## Status

M7.5 remote canary tooling and bounded remote evidence are implemented. **M7 is still blocked and no `GO-SEARCH` / `GO-D1-READ` is claimed.** Supabase remains the sole production search/read authority and `SearchRepository` selection is unchanged.

The final bounded canary uses isolated non-production resources only:

- Vectorize: `worldcons-search-canary-v2`
- D1: `worldcons_search_canary_v2`
- corpus: 15 current published P3 articles with provenance-locked Gemini artifacts
- Vectorize records: 15
- D1 `search_documents`: 15
- D1 `search_fts`: 15
- Vectorize metadata indexes: `sourceKey`, `jurisdiction`, `contentType`, `language`, `publishedEpoch`

No production binding, DNS, traffic, Supabase mutation, destructive D1 rebuild, Vectorize delete, or authority switch was performed.

## Implemented

M7.5 adds `lib/cloudflare/search-canary/*`, `scripts/d1-search-canary.ts`, `tests/d1-search-canary.test.ts`, and package scripts for a dry-run-by-default remote search canary.

The operator now provides:

- bounded P3 search + Vectorize projection planning;
- isolated Vectorize bootstrap with dimension/metric validation and five metadata indexes;
- mutation-progress waiting using `processedUpToMutation` instead of assuming a fixed short ingestion delay;
- Wrangler-version compatibility for commands that do not support `--json` (`d1 create`, `vectorize query`);
- safe parsing of Wrangler human preamble + JSON query output;
- isolated D1 schema/application with **insert-only initial population**; an existing non-empty canary is reused only when document checksum/projection version and FTS identities match exactly;
- a 100 KB D1 SQL-statement preflight that refuses literalized oversized writes rather than truncating source content;
- frozen exact-case/fulltext/semantic/hybrid cases, row-read accounting, explicit correctness/latency thresholds and deterministic JSON/Markdown evidence;
- bounded production-oracle comparison: fulltext oracle results are restricted to the materialized canary ids before comparison;
- semantic/hybrid oracle eligibility detection. If `public_article_projection_p3.embedding` is NULL for an artifact-backed query article, the production RPC is not treated as a valid semantic parity oracle and the drift is reported explicitly;
- `--reuse-vector` for repeat evidence runs without unnecessary Vectorize upserts.

## Remote evidence

Final evidence run:

```text
pnpm d1:search-canary -- --apply --reuse-vector --oracle --report \
  --index-name=worldcons-search-canary-v2 \
  --database=worldcons_search_canary_v2 \
  --max-articles=15 --max-cases-per-mode=1 --json
```

Observed correctness:

| mode | cases | correctness | production oracle | operator latency | D1 rows read |
| --- | ---: | --- | --- | ---: | ---: |
| fulltext (exact-case + lexical) | 2 | 2/2 pass | exact-case 1/1 match; bounded generic lexical oracle had no canary id in the production top-100 window | p50 1784 ms / p95 1794 ms | 28 |
| semantic | 1 | 1/1 pass; self-vector ranked first | skipped as invalid oracle for this artifact-backed row | 2334 ms | 0 |
| hybrid | 1 | 1/1 pass | skipped as invalid oracle for this artifact-backed row | 5090 ms | 42 |

All four frozen correctness expectations passed with zero mismatch/error/timeout. The overall evidence verdict remains `fail` because the provisional operator latency thresholds are 2000 ms p50 / 5000 ms p95 and because production semantic parity is not yet a valid comparison for artifact-backed rows.

The latency values above are **Wrangler operator latency**, including local child-process startup and multiple remote CLI calls. They are not a production Worker binding SLO. M7.6 must measure D1 + Vectorize through actual Cloudflare bindings before any runtime latency gate can be accepted.

## Blocker 1 — production semantic authority drift

The M7.4 target projection correctly uses provenance-locked `article_embedding_artifacts` (`gemini` / `gemini-embedding-001`, 1536 dimensions, current P3 version/content hash).

However, the current production `public_article_projection_p3` definition from `20260903130000_constitutional_case_catalog_gate2.sql` exposes `v.embedding` from `article_content_versions_p3`; it no longer uses the earlier `coalesce(e.embedding, v.embedding)` definition introduced by `20260831130000_gemini_embedding_provenance.sql`.

Remote verification on the two semantic/hybrid canary query articles found:

- `article_embedding_artifacts.embedding`: present;
- `public_article_projection_p3.embedding`: NULL.

Therefore `worldcons_ranked_search_page_v1` does not search the same semantic corpus as the M7.4 Vectorize projection. Treating that RPC as the semantic parity oracle would create false failures. This authority drift must be resolved explicitly before `GO-SEARCH`: either restore artifact-backed production projection semantics or formally approve the artifact projection as the new semantic authority with a separate reference regression corpus.

## Blocker 2 — D1 literal SQL statement ceiling

The current operator's Wrangler `d1 execute --file` path must literalize bound values. Cloudflare D1 limits individual SQL statements to 100 KB.

Measured against the first 100 current published articles:

- 100-document projection: 10 oversized INSERT statements;
- largest literalized statement: 272,048 bytes;
- 50 documents: 4 oversized statements;
- 25 documents: 4 oversized statements;
- 17 documents: 2 oversized statements, maximum 220,119 bytes;
- 16 documents: 2 oversized statements, maximum 220,119 bytes;
- 15 documents: no oversized statements and all four canary modes available.

Source text was **not truncated** to make the canary fit. M7.6 must replace literalized remote writes with a parameterized D1 API/binding path. D1's `/query` API supports `sql` plus `params`; the connected Cloudflare app account is not the same account used by this repository's Wrangler login, so live API execution through that connector returned account authorization error 7403 and was not used for worldcons.

## Blocker 3 — runtime latency not yet measured

The bounded remote canary establishes result correctness, row-read evidence, and remote resource compatibility, but the current operator crosses process boundaries for every Wrangler D1/Vectorize call. The provisional 2 s / 5 s thresholds therefore gate the **operator**, not the eventual Worker runtime.

M7.6 must exercise the same queries through Cloudflare D1 and Vectorize bindings (or an equivalent authenticated parameterized API path) and record binding/runtime latency separately from operator latency.

## Verification

Latest local verification after all M7.5 fixes:

- `pnpm test:d1-search-canary`: 29/29 pass
- `pnpm test:d1-vector-search`: 32/32 pass (last combined regression run during M7.5)
- `pnpm typecheck`: pass
- `git diff --check`: pass

The evidence files under `artifacts/cloudflare-m7/` contain ids/counts/latencies only and no vector values, document text, credentials, or URLs.

## M7.6 next step

M7.6 should be additive and keep production authority unchanged:

1. implement a parameterized remote D1 writer so large `search_text` values never become part of SQL statement text;
2. run a larger bounded projection including the previously oversized rows without truncation;
3. add an isolated Cloudflare binding canary for D1 + Vectorize and measure runtime latency independent of Wrangler process startup;
4. resolve/document the Supabase semantic authority drift before using `worldcons_ranked_search_page_v1` as a semantic oracle;
5. rerun the frozen exact-case/fulltext/semantic/hybrid suite with agreed production-facing latency/row-read thresholds;
6. keep `search_m7` blocked until those gates pass. No `GO-SEARCH` / `GO-D1-READ` before then.
