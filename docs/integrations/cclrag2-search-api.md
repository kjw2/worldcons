# cclrag2 Search API

## Production boundary

WorldCons owns the foreign constitutional-case records, publication state, search index, summaries, and preserved source snapshots. The Cloudflare Worker reads the published Supabase projection through service-role-only RPC functions. It does not call, proxy, or expose the WorldCons Vercel application.

- Provider contract: `2.0`
- Cloudflare Worker service: `worldcons-search-api`
- Public HTTPS base URL: `https://worldcons-search-api.cclib.workers.dev`
- Authentication: none; only the published read-only projection is exposed
- Internal data access: encrypted Worker secrets and service-role-only Supabase RPCs
- Consumer timeout: 8 seconds
- Request correlation: send `X-Request-Id`; the Worker echoes it in the response body and header

cclrag2 must call the public HTTPS base URL. No Vercel URL, database credential, storage binding, or provider-owned internal RPC is part of the consumer contract.

## Endpoints

| Method and path | Purpose | Maximum response |
| --- | --- | --- |
| `GET /api/search` | Bounded published-case search | 1.5 MB |
| `GET /api/sources` | Active source inventory and health probe | 200 KB |
| `GET /api/articles/{slug}` | Structured summary and the first preserved-text page | 1.9 MB |
| `GET /api/articles/{slug}/source-text` | Offset-based preserved-text page | 1.8 MB |

Only `GET` is accepted. Unknown resources return `404`; unsupported methods return `405`.

## Search request

```text
GET /api/search
  ?q=<query>
  &mode=hybrid
  &page=<optional, default 1>
  &pageSize=<1..20>
  &count=none
  &jurisdiction=<optional>
  &source=<optional>
  &range=<optional>
```

| Parameter | Contract |
| --- | --- |
| `q` | Optional search text, maximum 200 characters |
| `mode` | `fulltext`, `semantic`, or `hybrid`; 각 값이 실제 lexical/vector/RRF retrieval을 선택한다 |
| `page` | Integer from 1 through 500, with a maximum offset of 10,000 |
| `pageSize` | Integer from 1 through 20; default 10 |
| `count` | `none`, `exact`, `planned`, or `estimated`; `exact` requests an exact total, while the others return a bounded lower bound |
| `jurisdiction` | Optional jurisdiction label, such as `Germany` |
| `source` | Optional stable source key, such as `de-bverfg` |
| `range` | `latest`, `today`, `week`, or `month`; `latest` means the full published archive |

The Worker delegates pagination to the DB-native ranked-page contract. The database keeps only the requested page plus one lookahead row; hybrid candidate oversampling grows with the requested offset instead of using the former fixed 100-row preload.

## Contract V2 evidence

Search items expose native Provider Contract V2 evidence:

```json
{
  "contractVersion": "2.0",
  "schemaVersion": 1,
  "requestId": "consumer-request-id",
  "query": "1 BvR 2656/18 climate",
  "service": "worldcons",
  "transport": "cloudflare-worker",
  "mode": "hybrid",
  "requestedMode": "hybrid",
  "effectiveMode": "hybrid",
  "degraded": false,
  "databaseRetrievalMode": "hybrid",
  "items": [
    {
      "id": "stable UUID",
      "slug": "stable-slug",
      "providerId": "worldcons",
      "sourceType": "foreign_constitutional",
      "authorityLevel": "persuasive",
      "title": "한국어 제목",
      "originalTitle": "Beschluss vom 24. Marz 2021",
      "summary": "한국어 구조화 요약",
      "snippet": "한국어 한줄 요약",
      "summaryJson": {},
      "bodyExcerpt": "보존 원문 발췌",
      "excerptKind": "passage",
      "bodyChecksum": "64-character SHA-256",
      "legalIdentity": {
        "documentId": "stable UUID",
        "caseNumber": "1 BvR 2656/18",
        "court": "Bundesverfassungsgericht",
        "jurisdiction": "DE"
      },
      "sectionAnchors": [
        {
          "kind": "passage",
          "label": "보존 원문 발췌",
          "locator": "cleanedText:0-4000",
          "startOffset": 0,
          "endOffset": 4000
        }
      ],
      "temporalValidity": {
        "decisionDate": "2021-03-24",
        "publishedAt": "2021-03-24"
      },
      "sourceKey": "de-bverfg",
      "jurisdiction": "Germany",
      "jurisdictionCode": "DE",
      "countryName": "독일",
      "institutionName": "Bundesverfassungsgericht",
      "courtName": "Bundesverfassungsgericht",
      "caseNumber": "1 BvR 2656/18",
      "decisionDate": "2021-03-24",
      "originalLanguage": "de",
      "officialUri": "https://www.bundesverfassungsgericht.de/...",
      "detailApiUrl": "https://worldcons-search-api.cclib.workers.dev/api/articles/stable-slug",
      "sourceTextUrl": "https://worldcons-search-api.cclib.workers.dev/api/articles/stable-slug/source-text"
    }
  ],
  "meta": {
    "limit": 10,
    "offset": 0,
    "total": 1,
    "hasMore": false,
    "totalIsExact": false
  }
}
```

`id`, `slug`, `providerId`, `sourceType`, `authorityLevel`, `title`, `sourceKey`, jurisdiction and court fields, `contentType`, `originalLanguage`, `officialUri`, `detailApiUrl`, and `sourceTextUrl` are non-null for published results. `koreanTitle`, `originalTitle`, `caseNumber`, `decisionDate`, `summary`, `bodyExcerpt`, `bodyChecksum`, `score`, and date-dependent evidence may be absent or null when the owned record has no verified value.

`officialUri` is accepted only when it is HTTPS and belongs to the configured official court domain for that source. The public WorldCons detail URL is separate from the official court URI.

## Ranking and full content

Recognized case references are handled by an indexed exact-case preflight before ordinary retrieval. The same source-aware canonicalization is used for Germany (`1 BvR 2656/18`), France (`2026-912 QPC`), Spain (`53/2025`), and the US (`24-109`). `Neubauer`/`Klimabeschluss` resolve to the German docket without requiring an embedding request. Published records carry a generated `case_key`, indexed together with `source_key`, so exact lookup does not depend on repeated URL/metadata regex scans.

For ordinary queries, `fulltext` uses PostgreSQL `ts_rank_cd`, `semantic` uses pgvector cosine similarity, and `hybrid` fuses the lexical and semantic ranks with reciprocal rank fusion (RRF, `k=60`). Exact normalized titles sort above the fused score, while decision recency is used only as a tie-breaker after relevance. This matches the Next.js hybrid-search policy introduced in the main application.

`requestedMode` records the caller's requested mode. `effectiveMode` and the legacy-compatible `mode` field record what actually executed. When semantic/hybrid embedding generation is unavailable, the Worker fails soft to `fulltext`, returns `degraded: true`, and includes `degradationReason` (`embedding_not_configured`, `embedding_unavailable`, or `empty_query`). `databaseRetrievalMode` reports the V4 ranked-page path (`fulltext`, `semantic`, `hybrid`, `exact-case`, or `latest`) when supplied by the database response. `totalIsExact` is `true` only when `count=exact` produced an exact total; otherwise `total` is a lower bound consistent with `hasMore`.

`GET /api/articles/{slug}` returns the same identity, source, temporal, and checksum evidence as search, plus `summaryJson`, `bodyExcerpt`, and the first bounded `cleanedText` page. cclrag2 should hydrate only selected search hits.

The complete preserved text remains available as bounded pages:

```text
GET /api/articles/{slug}/source-text?offset=<0..10000000>&limit=<1..350000>
```

```json
{
  "contractVersion": "2.0",
  "requestId": "consumer-request-id",
  "slug": "stable-slug",
  "cleanedText": "preserved official source text page",
  "bodyExcerpt": "short page excerpt",
  "excerptKind": "document_section",
  "bodyChecksum": "64-character SHA-256",
  "textPage": {
    "offset": 0,
    "limit": 350000,
    "returnedChars": 350000,
    "totalChars": 500000,
    "hasMore": true,
    "nextOffset": 350000
  }
}
```

`bodyChecksum` identifies the complete preserved source snapshot, not an individual page. Continue with `nextOffset` until `hasMore` is false.

## Operations

- Search cache directive: `s-maxage=60, stale-while-revalidate=300`
- Detail/source cache directive: `s-maxage=300, stale-while-revalidate=900`
- Worker-to-Supabase timeout: 8 seconds
- Semantic/hybrid embedding timeout: 5 seconds
- Semantic/hybrid mode requires the Worker secret `OPENAI_API_KEY`; the default model is `text-embedding-3-small` and can be changed with `OPENAI_EMBEDDING_MODEL`
- Missing or failed embedding generation does not fail the request; it is surfaced as an explicit degraded full-text fallback
- `400`: invalid query, range, pagination, or unsupported parameter
- `404`: unknown endpoint, article, or source snapshot
- `429`: upstream rate limit; honor `Retry-After`
- `503`: temporary dependency failure or inability to produce a bounded response

## Examples

```bash
curl --fail-with-body \
  -H "X-Request-Id: cclrag2-neubauer-check" \
  "https://worldcons-search-api.cclib.workers.dev/api/search?q=1%20BvR%202656%2F18%20climate&mode=hybrid&pageSize=10&count=none"

curl --fail-with-body \
  "https://worldcons-search-api.cclib.workers.dev/api/sources"

curl --fail-with-body \
  "https://worldcons-search-api.cclib.workers.dev/api/articles/{slug}"

curl --fail-with-body \
  "https://worldcons-search-api.cclib.workers.dev/api/articles/{slug}/source-text?offset=0&limit=350000"
```
