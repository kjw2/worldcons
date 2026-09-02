# cclmetasearch Search API

## Integration boundary

WorldCons owns the constitutional-case corpus, publication state, PostgreSQL full-text index, ranking, and pagination. cclmetasearch receives only a normalized response page for its short-lived search session; it does not fetch or replicate the WorldCons result set.

- Production endpoint: `GET https://worldcons.vercel.app/api/cclmetasearch/search`
- Transport: public HTTPS through the canonical Vercel deployment. No private runtime binding is required.
- Authentication header: `X-CCL-Metasearch-Token`
- Provider secret: `CCL_METASEARCH_API_TOKEN` in the WorldCons Vercel Production environment
- Consumer secret: use the same value as `WORLDCONS_SEARCH_TOKEN` in cclmetasearch
- Never place the token in the query string, URL, log, response, or repository.

## Request

| Parameter | Required | Default | Contract |
| --- | --- | --- | --- |
| `q` | Conditional | - | Search text, 1-200 characters after trimming and NFKC normalization |
| `keyword` | Conditional | - | Alias of `q`; at least one of `q` or `keyword` is required |
| `limit` | No | `10` | Integer from 1 through 20 |
| `offset` | No | `0` | Integer from 0 through 10,000 |
| `sort` | No | `relevance` | `relevance` or `latest` |

When both `q` and `keyword` are present, their normalized values must be identical. Unknown or repeated parameters return `400`.

```bash
curl --fail-with-body \
  -H "Accept: application/json" \
  -H "X-CCL-Metasearch-Token: $WORLDCONS_SEARCH_TOKEN" \
  "https://worldcons.vercel.app/api/cclmetasearch/search?q=표현의%20자유&limit=10&offset=0&sort=relevance"
```

## Sorting

- `relevance`: PostgreSQL `ts_rank_cd` descending, then decision date descending, then stable article UUID ascending.
- `latest`: decision date (`original_published_at`) descending, relevance descending, then stable article UUID ascending.
- A relevance score is query-local. Do not compare it across different queries.
- An article without a decision date sorts after dated articles.

## Success response

`total` is an exact count for the query. `hasMore` is true only when a later page exists. A valid query with no matches returns `200`, an empty `items` array, and `total: 0`.

```json
{
  "schemaVersion": 1,
  "service": "worldcons",
  "query": {
    "q": "표현의 자유",
    "sort": "relevance"
  },
  "updatedAt": "2026-07-15T04:30:00.000Z",
  "items": [
    {
      "id": "11111111-1111-4111-8111-111111111111",
      "canonicalId": "worldcons:11111111-1111-4111-8111-111111111111",
      "title": "언론의 자유에 관한 결정",
      "originalTitle": "Décision n° 2026-1213 QPC du 12 juin 2026",
      "countryCode": "FR",
      "countryName": "프랑스",
      "courtName": "프랑스 헌법위원회",
      "sourceKey": "fr-conseil-constitutionnel",
      "caseNumber": "2026-1213 QPC",
      "decisionDate": "2026-06-12",
      "decisionYear": 2026,
      "originalLanguage": "fr",
      "summary": "한국어 핵심 요약 전문입니다.",
      "snippet": "한국어 핵심 요약의 첫 문장입니다.",
      "keywords": ["표현의 자유", "언론"],
      "topics": ["표현의 자유", "기본권"],
      "originalUrl": "https://www.conseil-constitutionnel.fr/decision/...",
      "worldconsUrl": "https://worldcons.vercel.app/articles/example-slug",
      "detailUrl": "https://worldcons.vercel.app/articles/example-slug",
      "updatedAt": "2026-06-13T02:00:00.000Z",
      "relevanceScore": 0.25
    }
  ],
  "meta": {
    "limit": 10,
    "offset": 0,
    "total": 42,
    "hasMore": true
  }
}
```

## Field nullability

| Field | Nullable | Meaning |
| --- | --- | --- |
| `id`, `canonicalId` | No | Stable WorldCons article UUID and namespaced ID |
| `title` | No | Korean title when available, otherwise original title or a fixed fallback |
| `originalTitle` | Yes | Source-language title |
| `countryCode`, `countryName` | No | Normalized jurisdiction code and Korean country label |
| `courtName`, `sourceKey` | No | Korean public institution label and stable WorldCons source key |
| `caseNumber` | Yes | Source metadata first, then source-specific title/URL extraction |
| `decisionDate`, `decisionYear` | Yes | Decision date as `YYYY-MM-DD` and its year |
| `originalLanguage` | No | ISO-style source language code such as `en`, `de`, `fr`, or `es` |
| `summary`, `snippet` | Yes | Plain-text Korean core summary and its first concise point |
| `keywords`, `topics` | No | Deduplicated arrays; empty when no tags are available |
| `originalUrl` | Yes | Validated `http` or `https` official-source URL |
| `worldconsUrl`, `detailUrl` | No | Canonical WorldCons article detail URL |
| `updatedAt` | Yes | Best available summary/fetch/discovery/decision timestamp |
| `relevanceScore` | Yes | PostgreSQL rank for this query |

## Error contract

All managed errors use the same envelope:

```json
{
  "schemaVersion": 1,
  "service": "worldcons",
  "error": {
    "code": "INVALID_REQUEST",
    "message": "limit must be an integer between 1 and 20.",
    "retryable": false
  }
}
```

| HTTP | Code | Meaning |
| --- | --- | --- |
| `400` | `INVALID_REQUEST` | Missing or invalid search parameters |
| `401` | `AUTH_REQUIRED` | Token header missing |
| `403` | `FORBIDDEN` | Token incorrect |
| `404` | `NOT_FOUND` | Unknown path below `/api/cclmetasearch/`; zero search matches are not a 404 |
| `429` | `RATE_LIMITED` | Request limit exceeded; honor `Retry-After` |
| `503` | `SERVICE_UNAVAILABLE` | Integration token, database, RPC, or timeout unavailable; honor `Retry-After` |

## Pagination, timeout, and cache guidance

- The database function searches `public_article_projection_p3`, counts matches, and applies `LIMIT`/`OFFSET` before returning `items`. The application never downloads all matching IDs or rows to paginate them.
- cclmetasearch should use a 10-second request timeout. WorldCons aborts its database request after 8 seconds by default (`CCL_METASEARCH_DB_TIMEOUT_MS`, bounded to 1-15 seconds).
- Successful responses use `Cache-Control: private, max-age=60, stale-while-revalidate=300` and `Vary: X-CCL-Metasearch-Token`.
- Errors use `Cache-Control: no-store`.
- Default rate limit: 120 requests per 60 seconds per client (`RATE_LIMIT_CCL_METASEARCH_MAX` and `RATE_LIMIT_CCL_METASEARCH_WINDOW_MS`).
- cclmetasearch may keep normalized results only for its search-session cache; a five-minute upper bound matches the source stale window.
