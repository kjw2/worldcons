# 추가 구현 요청: 독일/프랑스 공식 사이트 대응 크롤러·스크래퍼 레이어 강화

현재 프로젝트에는 TypeScript 기반 SourceAdapter가 존재한다.

현재 구조:

- `lib/sources/types.ts`
- `lib/sources/supremecourt.ts`
- `lib/sources/bundesverfassungsgericht.ts`
- `lib/sources/conseilconstitutionnel.ts`
- `lib/ingest/run.ts`
- `scripts/ingest.ts`

현재 문제:

- 미국 SCOTUS는 공식 사이트에서 일부 실제 수집이 가능하다.
- 독일 `bundesverfassungsgericht.de`와 프랑스 `conseil-constitutionnel.fr`, `qpc360.conseil-constitutionnel.fr`는 현재 실행 환경에서 fetch/cheerio 기반 수집이 불안정하다.
- timeout, 403, redirect, selector mismatch, 0건 파싱 문제가 발생한다.
- 따라서 공식 URL과 공개 메타데이터 seed에 의존하는 임시 방식이 사용되고 있다.

목표는 seed 방식이 아니라, 공식 사이트에서 가능한 한 자동으로 최신 목록과 본문을 수집하는 안정적인 crawler/scraper layer를 추가하는 것이다.

---

## 1. 핵심 목표

기존 SourceAdapter 구조는 유지하되, 각 어댑터 내부에서 다음 수집 전략을 단계적으로 시도하도록 개선해줘.

```text
1. 공식 RSS/API/JSON endpoint 탐색
2. 일반 HTTP fetch + Cheerio 파싱
3. Readability/jsdom 본문 추출
4. Playwright browser rendering fallback
5. sitemap.xml / 검색 페이지 fallback
6. 실패 시 structured error와 diagnostics 저장
```

즉, 단순 `fetch(url)` 하나에 의존하지 말고, 사이트별로 다중 fallback을 가진 수집 체계를 만들어줘.

---

## 2. 추가할 크롤러 공통 모듈

다음 파일들을 추가하거나 개선해줘.

```text
lib/crawler/
  http-client.ts
  playwright-client.ts
  extract-links.ts
  extract-readable-text.ts
  extract-metadata.ts
  robots.ts
  sitemap.ts
  diagnostics.ts
  retry.ts
  rate-limit.ts
  user-agents.ts
  types.ts
```

---

## 3. Crawler 인터페이스

다음 타입을 기준으로 공통 crawler client를 만들어줘.

```ts
export interface CrawlRequest {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  timeoutMs?: number;
  usePlaywright?: boolean;
  waitUntil?: "load" | "domcontentloaded" | "networkidle";
  waitForSelector?: string;
}

export interface CrawlResponse {
  url: string;
  finalUrl: string;
  status: number;
  contentType?: string;
  html?: string;
  text?: string;
  buffer?: Buffer;
  headers: Record<string, string>;
  fetchedAt: string;
  strategy: "fetch" | "playwright" | "rss" | "sitemap" | "seed";
  diagnostics?: CrawlDiagnostics;
}

export interface CrawlDiagnostics {
  redirected?: boolean;
  redirectChain?: string[];
  blocked?: boolean;
  timeout?: boolean;
  selectorMatched?: boolean;
  selectorMatchCount?: number;
  errorCode?: string;
  errorMessage?: string;
}
```

---

## 4. HTTP client 개선

`lib/crawler/http-client.ts`를 작성해줘.

요구사항:

- Node fetch 기반
- timeout 지원
- retry 지원
- user-agent 설정
- accept-language 설정
- redirect follow
- response status 기록
- HTML, PDF, XML, JSON content-type 구분
- 403, 404, 429, 5xx를 명확히 diagnostics에 기록

기본 headers:

```ts
{
  "User-Agent": "Mozilla/5.0 compatible; ConstitutionalCourtCurationBot/0.1; +https://example.com/bot",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf;q=0.8,*/*;q=0.7",
  "Accept-Language": "en-US,en;q=0.8,de;q=0.7,fr;q=0.7,ko;q=0.6",
  "Cache-Control": "no-cache"
}
```

환경변수로 user-agent를 바꿀 수 있게 해줘.

```bash
CRAWLER_USER_AGENT=
CRAWLER_TIMEOUT_MS=30000
CRAWLER_RETRY_COUNT=2
CRAWLER_DELAY_MS=1500
```

---

## 5. Playwright fallback

`lib/crawler/playwright-client.ts`를 작성해줘.

사용 조건:

- 일반 fetch가 timeout
- 일반 fetch가 403
- HTML은 받았지만 목록 selector가 0건
- JS 렌더링이 필요한 페이지
- redirect 후 예상 구조가 나오지 않는 경우

요구사항:

- chromium 사용
- headless true
- timeout 설정
- waitUntil 설정
- optional waitForSelector
- HTML snapshot 반환
- 최종 URL 반환
- title, meta description 추출
- 실패 시 diagnostics 반환
- 과도한 동시 실행 방지

환경변수:

```bash
PLAYWRIGHT_ENABLED=true
PLAYWRIGHT_TIMEOUT_MS=45000
PLAYWRIGHT_HEADLESS=true
```

---

## 6. robots.txt와 예의 있는 크롤링

`lib/crawler/robots.ts`를 작성해줘.

MVP에서는 엄격한 robots parser가 아니어도 된다.

최소 요구사항:

- `/robots.txt` fetch
- User-agent 규칙 일부 확인
- disallow path면 수집하지 않고 `needs_review` 처리
- README에 “공식 사이트 정책을 존중하며 과도한 요청을 하지 않는다” 명시

---

## 7. sitemap fallback

`lib/crawler/sitemap.ts`를 작성해줘.

역할:

- `https://domain/sitemap.xml`
- `https://domain/sitemap_index.xml`
- robots.txt 내 sitemap 경로

위 경로를 확인해서 URL 후보를 얻는다.

필터링 키워드:

독일:

```text
entscheidung
entscheidungen
presse
pressemitteilung
press
decision
```

프랑스:

```text
decision
decisions
qpc
communique
communiques
actualite
```

미국:

```text
opinions
orders
press
```

---

## 8. 독일 BVerfG 어댑터 개선

파일:

```text
lib/sources/bundesverfassungsgericht.ts
```

sourceKey:

```text
de-bverfg
```

개선 목표:

- 기존 URL 구조가 바뀌거나 redirect되어도 수집 가능하게 만든다.
- 목록 URL을 여러 후보로 관리한다.
- 각 후보를 순차적으로 시도한다.
- fetch 실패 시 Playwright fallback을 사용한다.
- 목록 selector가 실패하면 sitemap fallback으로 후보 URL을 찾는다.

목록 URL 후보를 배열로 관리해줘.

```ts
const LIST_URL_CANDIDATES = [
  "https://www.bundesverfassungsgericht.de",
  "https://www.bundesverfassungsgericht.de/DE/Presse/Pressemitteilungen/pressemitteilungen_node.html",
  "https://www.bundesverfassungsgericht.de/DE/Entscheidungen/entscheidungen_node.html",
  "https://www.bundesverfassungsgericht.de/SiteGlobals/Forms/Suche/Entscheidungensuche_Formular.html",
];
```

selector 후보도 배열로 관리해줘.

```ts
const LIST_SELECTORS = [
  "a[href*='Pressemitteilungen']",
  "a[href*='Entscheidungen']",
  "a[href*='SharedDocs']",
  "main a[href]",
  "article a[href]",
];
```

본문 selector 후보:

```ts
const BODY_SELECTORS = [
  "main",
  "article",
  ".content",
  "#content",
  ".c-content",
];
```

필수 metadata 추출:

- originalTitle
- originalPublishedAt
- decision date
- case number
- senate/chamber
- contentType: `press_release` 또는 `decision`
- originalLanguage: `de`

---

## 9. 프랑스 Conseil constitutionnel 어댑터 개선

파일:

```text
lib/sources/conseilconstitutionnel.ts
```

sourceKey:

```text
fr-conseil-constitutionnel
```

개선 목표:

- `conseil-constitutionnel.fr`와 `qpc360.conseil-constitutionnel.fr`를 모두 후보로 관리한다.
- 403/timeout 발생 시 Playwright fallback을 시도한다.
- 목록 selector 실패 시 sitemap fallback을 시도한다.
- QPC 결정과 일반 결정을 구분한다.
- 보도자료와 결정을 구분한다.

목록 URL 후보:

```ts
const LIST_URL_CANDIDATES = [
  "https://www.conseil-constitutionnel.fr/les-decisions",
  "https://www.conseil-constitutionnel.fr/actualites",
  "https://www.conseil-constitutionnel.fr/communiques",
  "https://qpc360.conseil-constitutionnel.fr",
];
```

selector 후보:

```ts
const LIST_SELECTORS = [
  "a[href*='/decision/']",
  "a[href*='decisions']",
  "a[href*='qpc']",
  "a[href*='communique']",
  "main a[href]",
  "article a[href]",
];
```

본문 selector 후보:

```ts
const BODY_SELECTORS = [
  "main",
  "article",
  ".field--name-body",
  ".content",
  "#content",
];
```

필수 metadata 추출:

- originalTitle
- originalPublishedAt
- decision number
- decision date
- qpc 여부
- contentType: `decision`, `press_release`, `news`
- originalLanguage: `fr`

---

## 10. seed는 fallback으로만 사용

현재 독일/프랑스 seed 기반 처리는 완전히 제거하지 말고 fallback으로 내려줘.

우선순위는 다음과 같아야 한다.

```text
1. official RSS/API/JSON
2. official HTML list via fetch
3. official HTML list via Playwright
4. sitemap
5. configured seed URLs
```

seed를 사용한 경우 article metadata에 반드시 표시한다.

```json
{
  "collectionStrategy": "seed",
  "warning": "Collected from configured official URL seed because live discovery failed."
}
```

UI 또는 admin 페이지에서도 seed 기반 수집임을 확인할 수 있으면 좋다.

---

## 11. diagnostics 저장

수집 실패 원인을 알 수 있게 ingestion_runs.metadata에 source별 diagnostics를 저장해줘.

예시:

```json
{
  "sourceKey": "fr-conseil-constitutionnel",
  "attempts": [
    {
      "url": "https://www.conseil-constitutionnel.fr/les-decisions",
      "strategy": "fetch",
      "status": 403,
      "error": "Access Denied"
    },
    {
      "url": "https://www.conseil-constitutionnel.fr/les-decisions",
      "strategy": "playwright",
      "status": 200,
      "selectorMatched": false,
      "selectorMatchCount": 0
    },
    {
      "strategy": "sitemap",
      "discoveredCount": 12
    }
  ]
}
```

관리자 페이지에서 최근 수집 실패 원인을 볼 수 있게 해줘.

---

## 12. CLI 옵션 추가

`scripts/ingest.ts`에 다음 옵션을 추가해줘.

```bash
pnpm ingest -- --source=de-bverfg --limit=10 --debug
pnpm ingest -- --source=fr-conseil-constitutionnel --limit=10 --debug
pnpm ingest -- --source=us-scotus --limit=5 --debug
```

옵션:

```text
--source
--limit
--debug
--use-playwright
--no-playwright
--strategy=fetch|playwright|sitemap|seed|auto
```

debug 모드에서는 다음을 출력해줘.

- 시도한 URL
- 사용한 strategy
- HTTP status
- 최종 URL
- selector match count
- discovered item count
- 실패 사유

---

## 13. crawler diagnostics 명령 추가

별도 진단 명령을 추가해줘.

```bash
pnpm crawl:diagnose -- --source=de-bverfg
pnpm crawl:diagnose -- --source=fr-conseil-constitutionnel
pnpm crawl:diagnose -- --url=https://www.conseil-constitutionnel.fr/les-decisions
```

package.json:

```json
{
  "scripts": {
    "crawl:diagnose": "tsx scripts/crawl-diagnose.ts"
  }
}
```

진단 결과는 다음을 출력한다.

```text
URL
strategy
status
content-type
final URL
HTML length
title
selector candidates
selector match counts
links discovered
robots status
sitemap availability
recommended next action
```

---

## 14. 관리자 UI 개선

`/admin/ingestion-runs`에 diagnostics를 표시해줘.

표시 항목:

- sourceKey
- strategy
- URL
- status
- errorCode
- errorMessage
- selectorMatchCount
- discoveredCount
- fallback 사용 여부

실패한 source에 대해 다음 메시지를 보여줘.

```text
공식 사이트에 접근했지만 현재 수집 전략으로 목록을 안정적으로 파싱하지 못했습니다.
fetch, Playwright, sitemap, seed fallback 결과를 확인하세요.
```

---

## 15. 수집 신뢰도 필드 추가

articles.summary_json 또는 article metadata에 collection confidence를 저장해줘.

예시:

```json
{
  "collection": {
    "strategy": "fetch | playwright | sitemap | seed",
    "confidence": "high | medium | low",
    "diagnosticsId": "...",
    "sourceUrlVerified": true
  }
}
```

기준:

```text
fetch로 공식 상세 페이지 본문까지 수집: high
Playwright로 공식 상세 페이지 본문까지 수집: high
sitemap으로 URL 발견 후 공식 본문 수집: medium
seed URL 기반 수집: low 또는 medium
본문 없이 메타데이터만 seed: low
```

---

## 16. 구현 우선순위

우선순위는 다음과 같다.

1. 공통 crawler client
2. diagnostics 저장
3. CLI debug 옵션
4. 독일 adapter fallback 개선
5. 프랑스 adapter fallback 개선
6. sitemap fallback
7. Playwright fallback
8. 관리자 UI diagnostics
9. seed fallback 명시
10. README 업데이트

---

## 17. 완료 조건

다음 조건을 만족해야 한다.

```text
pnpm build 성공
pnpm ingest -- --source=us-scotus --limit=5 --debug 성공
pnpm ingest -- --source=de-bverfg --limit=5 --debug 실행 시 fetch/playwright/sitemap/seed 중 어떤 전략이 사용됐는지 출력
pnpm ingest -- --source=fr-conseil-constitutionnel --limit=5 --debug 실행 시 fetch/playwright/sitemap/seed 중 어떤 전략이 사용됐는지 출력
독일/프랑스가 seed fallback을 쓰더라도 diagnostics에 이유가 남음
수집된 article에 collection.strategy와 confidence가 남음
관리자 페이지에서 수집 실패/성공 전략을 확인 가능
README에 crawler troubleshooting 섹션 추가
```

---

## 18. README에 추가할 섹션

README에 다음 섹션을 추가해줘.

````md
## Crawler and Scraper Troubleshooting

### 수집 전략

1. RSS/API
2. fetch + Cheerio
3. Readability
4. Playwright fallback
5. sitemap fallback
6. seed fallback

### 독일/프랑스 수집이 실패하는 경우

- 사이트 구조 변경
- selector mismatch
- redirect
- timeout
- 403
- bot protection
- 실행 환경의 네트워크 제한

### 진단 명령

```bash
pnpm crawl:diagnose -- --source=de-bverfg
pnpm crawl:diagnose -- --source=fr-conseil-constitutionnel
```

### seed fallback의 의미

seed fallback은 공식 URL을 기반으로 한 임시 보완 수집이며, live discovery보다 신뢰도가 낮다.
따라서 article metadata에 collection.strategy = seed로 표시한다.
````

---

## 19. 중요한 원칙

- 비공식 사이트나 무단 복제 사이트를 source로 쓰지 않는다.
- 공식 URL만 수집한다.
- 수집 실패를 숨기지 말고 diagnostics에 남긴다.
- seed fallback은 임시 방편으로만 사용한다.
- Playwright는 무조건 사용하지 말고 fallback으로만 사용한다.
- robots.txt와 rate limit을 존중한다.
- 독일/프랑스 수집 실패를 “사이트가 막았다”라고 단정하지 말고, 정확한 status와 diagnostics로 표현한다.

---

## 20. 핵심 요약

지금 필요한 건 “크롤러를 하나 더 붙이는 것”이라기보다 **기존 SourceAdapter 아래에 진단 가능한 다단계 crawler/scraper 계층을 추가하는 것**이다.

그래야 독일/프랑스가 실패해도 원인이 다음 중 무엇인지 명확해진다.

- `403`
- `timeout`
- `selector 0건`
- `redirect`
- `sitemap fallback`
- `seed fallback`
