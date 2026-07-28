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
| `mode` | `fulltext`, `semantic`, or `hybrid`; compatibility modes use the same provider ranking |
| `page` | Integer from 1 through 500, with a maximum offset of 10,000 |
| `pageSize` | Integer from 1 through 20; default 10 |
| `count` | `none`, `exact`, `planned`, or `estimated`; the response total is a bounded lower bound |
| `jurisdiction` | Optional jurisdiction label, such as `Germany` |
| `source` | Optional stable source key, such as `de-bverfg` |
| `range` | `latest`, `today`, `week`, or `month`; `latest` means the full published archive |

The Worker fetches only `pageSize + 1` rows. It never preloads the full result set.

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
      "excerptKind": "search_snippet",
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

Recognized case references are ranked first, followed by PostgreSQL full-text relevance and decision date. BVerfG docket references such as `1 BvR 2656/18` are recognized independently of surrounding Korean or English text. `Neubauer` and `Klimabeschluss` resolve to that docket.

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
