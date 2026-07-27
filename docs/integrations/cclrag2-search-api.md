# cclrag2 Search API

## Production boundary

WorldCons owns the foreign constitutional-case records, publication state, search index, summaries, and preserved source snapshots. The provider Worker reads the published Supabase projection through service-role-only RPC functions. It does not call or proxy the WorldCons web application.

- Cloudflare Worker service: `worldcons-search-api`
- Public base URL: `https://worldcons-search-api.cclib.workers.dev`
- Recommended cclrag2 binding: `WORLDCONS`
- Service Binding target: `worldcons-search-api`
- Authentication: none for consumers; only published read-only data is exposed
- Internal data access: encrypted Worker secrets and service-role-only Supabase RPCs

```jsonc
{
  "services": [
    {
      "binding": "WORLDCONS",
      "service": "worldcons-search-api"
    }
  ]
}
```

## Endpoints

| Method and path | Purpose |
| --- | --- |
| `GET /api/search` | Bounded published-case search |
| `GET /api/sources` | Active source inventory and health probe |
| `GET /api/articles/{slug}` | Structured summary and preserved cleaned source text |
| `GET /api/articles/{slug}/source-text` | Small source-text-only response |

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
| `mode` | `fulltext`, `semantic`, or `hybrid`; cclrag2 uses `hybrid` |
| `page` | Integer from 1 through 500 |
| `pageSize` | Integer from 1 through 20; default 10 |
| `count` | `none`, `exact`, `planned`, or `estimated`; the edge contract reports a bounded lower-bound total |
| `jurisdiction` | Optional jurisdiction label, such as `Germany` |
| `source` | Optional stable source key, such as `de-bverfg` |
| `range` | `latest`, `today`, `week`, or `month`; `latest` means the full published archive |

The Worker fetches only `pageSize + 1` rows. It never preloads the full result set.

```json
{
  "schemaVersion": 1,
  "service": "worldcons",
  "transport": "cloudflare-worker",
  "mode": "hybrid",
  "items": [
    {
      "id": "stable UUID",
      "slug": "stable-slug",
      "title": "한국어 제목",
      "koreanTitle": "한국어 제목",
      "originalTitle": "원문 제목",
      "summary": "한국어 구조화 요약",
      "snippet": "한국어 한줄 요약",
      "summaryJson": {},
      "sourceType": "foreign_constitutional",
      "sourceKey": "de-bverfg",
      "jurisdiction": "Germany",
      "institutionName": "Bundesverfassungsgericht",
      "caseNumber": "1 BvR 2656/18",
      "contentType": "decision",
      "decisionDate": "2021-03-24T00:00:00Z",
      "originalLanguage": "de",
      "officialUrl": "https://www.bundesverfassungsgericht.de/...",
      "detailApiUrl": "https://worldcons-search-api.cclib.workers.dev/api/articles/stable-slug",
      "sourceTextUrl": "https://worldcons-search-api.cclib.workers.dev/api/articles/stable-slug/source-text",
      "tags": ["기후보호", "미래세대"]
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

`id`, `slug`, `title`, `sourceType`, `sourceKey`, `jurisdiction`, `institutionName`, `contentType`, `originalLanguage`, `officialUrl`, `detailApiUrl`, and `sourceTextUrl` are non-null for published results. `koreanTitle`, `originalTitle`, `caseNumber`, `decisionDate`, `summary`, and `score` may be null.

## Ranking and full content

The compatibility modes share the same edge implementation: recognized case references are ranked first, then PostgreSQL full-text relevance and decision date are used. BVerfG docket references such as `1 BvR 2656/18` are recognized independently of surrounding Korean or English text. `Neubauer` and `Klimabeschluss` resolve to that docket.

`GET /api/articles/{slug}` returns `summaryJson` plus `cleanedText`. cclrag2 should hydrate only selected search hits. `GET /api/articles/{slug}/source-text` returns:

```json
{
  "slug": "stable-slug",
  "cleanedText": "preserved official source text"
}
```

## Operations

- Search cache directive: `s-maxage=60, stale-while-revalidate=300`
- Detail/source cache directive: `s-maxage=300, stale-while-revalidate=900`
- Worker-to-Supabase timeout: 8 seconds
- Consumer timeout recommendation: 8 seconds
- `400`: invalid query or unsupported parameter
- `404`: unknown endpoint, article, or source snapshot
- `429`: upstream rate limit; honor `Retry-After`
- `503`: temporary data dependency failure; retry with bounded backoff

## Examples

```bash
curl --fail-with-body \
  "https://worldcons-search-api.cclib.workers.dev/api/search?q=1%20BvR%202656%2F18%20climate&mode=hybrid&pageSize=10&count=none"

curl --fail-with-body \
  "https://worldcons-search-api.cclib.workers.dev/api/sources"

curl --fail-with-body \
  "https://worldcons-search-api.cclib.workers.dev/api/articles/{slug}/source-text"
```
