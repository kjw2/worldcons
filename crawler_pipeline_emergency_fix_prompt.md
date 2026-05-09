# 긴급 수정 요청: 공식 원문 기반 수집 파이프라인 재설계 및 외부 크롤러 도입

현재 수집 결과는 다음과 같다.

| Source | Count | Summary | Status | Strategy | 비고 |
|---|---:|---:|---|---|---|
| 미국 SCOTUS | 5 | 5 | needs_review | fetch | PDF 원문은 robots.txt disallow로 원문 fetch 차단 |
| 독일 BVerfG | 5 | 5 | needs_review | seed | 공식 사이트가 현재 환경에서 timeout |
| 프랑스 Conseil/QPC360 | 5 | 5 | needs_review | seed | 공식/QPC360이 timeout 또는 403 |

이 상태는 “수집 성공”이 아니다.

`needs_review`, `seed`, `robots.txt disallow`, `timeout`, `403` 상태의 항목은 운영 UI에서 정상 기사처럼 노출하면 안 된다.  
AI 요약도 “정상 요약 완료”로 계산하면 안 된다.

현재 문제는 단순 selector 수정이나 어댑터 구현 보완으로 끝낼 수 있는 문제가 아니다.  
공식 법원·헌법재판기관 사이트에 맞는 전문 크롤러/스크래퍼 계층을 도입하고, 정상 발행 기준을 엄격하게 재정의해야 한다.

---

## 1. 가장 중요한 원칙

다음 상태는 정상 발행 대상으로 간주하지 마라.

```text
needs_review
failed_fetch
failed_summary
seed
robots_disallowed
metadata_only
blocked
timeout
```

정상 발행 조건은 다음을 모두 만족해야 한다.

```text
1. 공식 출처 URL에서 수집됨
2. 원문 본문 또는 공식 제공 전문/요약을 실제로 확보함
3. robots.txt 또는 접근 정책을 위반하지 않음
4. cleaned_text가 충분한 길이를 가짐
5. LLM 요약이 원문 본문 기반으로 생성됨
6. collection.strategy가 seed가 아님
7. article.status = summarized
8. collection.publishable = true
```

---

## 2. 현재 성공 기준은 잘못되었다

잘못된 성공 기준:

```text
5건 row 생성
5건 Gemini 요약 생성
needs_review 상태지만 UI에 표시
seed 기반 데이터를 기사처럼 표시
robots.txt disallow인데 Summary Count에 포함
```

올바른 성공 기준:

```text
공식 사이트에서 live discovery 성공
공식 상세 본문 확보
본문 기반 cleaned_text 생성
LLM 요약 생성
status = summarized
publishable = true
seed 아님
robots disallow 아님
홈에 정상 노출 가능
```

지금 상태는 “15건 수집”이 아니라 다음처럼 봐야 한다.

```text
0건 정상 발행
15건 검토/실패/메타데이터 후보
```

---

## 3. 상태값 재정의

현재 `needs_review`가 너무 넓게 쓰이고 있다. 상태값을 더 세분화해라.

추가 또는 정리할 상태값:

```text
discovered
metadata_only
robots_disallowed
blocked
timeout
fetched
cleaned
summarizing
summarized
failed_fetch
failed_summary
needs_review
```

각 상태의 의미:

```text
metadata_only:
공식 목록에서 제목, 날짜, URL만 확보했지만 본문은 확보하지 못함

robots_disallowed:
robots.txt 정책상 해당 원문 fetch를 하지 않음

blocked:
403, Access Denied, bot protection 등으로 접근 실패

timeout:
공식 사이트 요청이 제한 시간 내 완료되지 않음

needs_review:
자동 판단이 불확실해서 사람이 확인해야 함

summarized:
공식 원문 기반 요약까지 완료됨
```

---

## 4. seed fallback 정책 변경

현재 독일/프랑스는 seed로 5건을 넣고 Gemini 요약까지 생성했다.

이 방식은 MVP 데모용으로는 가능하지만, 실제 서비스 수집으로 인정하면 안 된다.

seed 정책을 다음처럼 변경해라.

```text
seed는 공식 URL 후보 등록용으로만 사용한다.
seed만으로 article을 summarized 처리하지 않는다.
seed 기반 항목은 metadata_only 또는 needs_review 상태로 둔다.
seed 기반 항목은 기본 홈 목록에 노출하지 않는다.
관리자 페이지에서만 보이게 한다.
```

seed 기반 항목 metadata:

```json
{
  "collection": {
    "strategy": "seed",
    "confidence": "low",
    "publishable": false,
    "sourceTextAvailable": false,
    "reason": "Live discovery or source text fetch failed. Seed URL was stored for later retry."
  }
}
```

---

## 5. 미국 소스 처리 수정

미국은 “SCOTUS가 틀렸다”가 아니라, SCOTUS 공식 사이트에서 robots.txt가 허용하는 범위만 사용해야 한다.

현재 문제:

```text
PDF 원문 fetch가 robots.txt disallow인데도 fetch strategy로 Count/Summary 처리됨
```

수정 방향:

```text
1. PDF URL은 robots.txt disallow면 fetch하지 않는다.
2. 공식 목록 페이지에서 허용되는 메타데이터만 수집한다.
3. 본문 확보가 안 된 PDF 사건은 metadata_only 또는 robots_disallowed로 둔다.
4. metadata_only 상태에서는 LLM 요약을 생성하지 않는다.
5. AI 요약 대신 “원문 전문 자동 수집 불가, 공식 링크 확인 필요” 상태를 표시한다.
```

SCOTUS 어댑터는 다음을 구분해야 한다.

```text
official_listing_collected: true
official_pdf_url_discovered: true
official_pdf_fetch_allowed: false
source_text_available: false
publishable: false
```

예시 metadata:

```json
{
  "collection": {
    "source": "https://www.supremecourt.gov",
    "strategy": "official-listing",
    "confidence": "medium",
    "sourceTextAvailable": false,
    "robotsDisallowed": true,
    "publishable": false
  }
}
```

중요:

```text
robots.txt가 disallow한 PDF를 우회해서 가져오지 마라.
비공식 사이트에서 전문을 가져와 공식 수집처럼 표시하지 마라.
본문이 없으면 요약하지 마라.
```

---

## 6. “원래 소스” 기준 명확화

미국의 원래 소스는 다음 중 하나로 처리해야 한다.

```text
1. 공식 SCOTUS 웹사이트에서 허용되는 목록/메타데이터
2. 공식 SCOTUS가 허용하는 HTML/보도자료 페이지
3. 원문 PDF는 robots.txt가 허용하는 경우에만 fetch
```

제3자 사이트는 기본 소스로 쓰지 마라.

금지:

```text
CourtListener
Justia
Oyez
Wikipedia
언론 기사
무단 복제 PDF
```

단, 향후 보조 링크로 사용하려면 `secondary_source`로 명확히 분리하고, 공식 원문 대체로 쓰지 않는다.

---

## 7. 외부 크롤러/스크래퍼 라이브러리 도입

독일/프랑스가 timeout/403/seed에 머물러 있으므로 기존 `fetch + cheerio` 방식으로 해결하려 하지 마라.

다음 중 하나를 도입해라.

### 1순위: TypeScript 기반 Crawlee

```text
Crawlee + PlaywrightCrawler + CheerioCrawler
```

설치:

```bash
pnpm add crawlee playwright got-scraping
```

Crawlee를 우선 추천하는 이유:

```text
현재 프로젝트가 Next.js + TypeScript + Supabase 기반이다.
Crawlee는 TypeScript/Node 생태계에 잘 맞는다.
RequestQueue, retry, session, rate limit, diagnostics, Playwright fallback을 체계적으로 제공한다.
기존 SourceAdapter를 wrapper로 유지하면서 내부 수집 엔진만 교체할 수 있다.
```

### 2순위: Python 기반 Scrapy

```text
Scrapy + scrapy-playwright + trafilatura
```

Python worker 분리가 가능할 때 검토한다.

설치 예시:

```bash
pip install scrapy scrapy-playwright trafilatura beautifulsoup4 lxml pymupdf pypdf
```

Scrapy는 장기적으로 강력하지만, 현재 프로젝트와 언어 스택이 달라지므로 1차 개선은 Crawlee를 우선한다.

---

## 8. 외부 crawler worker 구조로 분리

Next.js API route 안에서 무거운 크롤링을 돌리지 마라.

다음 구조로 분리해라.

```text
apps/web
  - Next.js UI
  - API
  - SEO
  - Supabase queries

workers/crawler
  - Crawlee
  - CheerioCrawler
  - PlaywrightCrawler
  - BVerfG spider
  - Conseil spider
  - QPC360 spider
  - SCOTUS official listing spider
  - sitemap crawler
  - diagnostics logger
  - Supabase writer

workers/ai
  - summarize-pending
  - tag extraction
  - embeddings
  - refresh tag counts
```

실행 명령:

```bash
pnpm crawler:run -- --source=de-bverfg --limit=5 --debug
pnpm crawler:run -- --source=fr-conseil-constitutionnel --limit=5 --debug
pnpm crawler:run -- --source=fr-qpc360 --limit=5 --debug
pnpm crawler:run -- --source=us-scotus --limit=5 --debug
```

---

## 9. 기존 SourceAdapter의 역할 변경

기존 SourceAdapter는 제거하지 말고 wrapper로 유지한다.

기존:

```text
SourceAdapter.discover()
  → fetch()
  → cheerio()
  → URL 후보 반환
```

개선:

```text
SourceAdapter.discover()
  → Crawlee spider 실행 또는 crawler worker 호출
  → 목록/검색/sitemap/상세 페이지 순회
  → 구조화된 DiscoveredItem 반환
```

즉, SourceAdapter는 source별 설정과 결과 변환을 담당하고, 실제 크롤링 안정성은 Crawlee spider가 담당한다.

---

## 10. Crawlee 기반 공통 crawler 모듈

다음 구조를 추가해라.

```text
workers/crawler/src/
  index.ts
  cli.ts
  config.ts
  types.ts
  queue.ts
  supabase-writer.ts
  diagnostics.ts
  robots.ts
  sitemap.ts
  extractors/
    html.ts
    readability.ts
    pdf.ts
    metadata.ts
  spiders/
    bverfg/
      index.ts
      routes.ts
      selectors.ts
      extractors.ts
      url-patterns.ts
      diagnostics.ts
    conseil/
      main.ts
      qpc360.ts
      routes.ts
      selectors.ts
      extractors.ts
      diagnostics.ts
    scotus/
      official-listing.ts
      routes.ts
      selectors.ts
      diagnostics.ts
```

공통 타입 예시:

```ts
export type CollectionStrategy =
  | "official-listing"
  | "cheerio"
  | "playwright"
  | "sitemap-detail"
  | "rss"
  | "api"
  | "seed";

export type CollectionStatus =
  | "discovered"
  | "metadata_only"
  | "robots_disallowed"
  | "blocked"
  | "timeout"
  | "fetched"
  | "cleaned"
  | "summarizing"
  | "summarized"
  | "failed_fetch"
  | "failed_summary"
  | "needs_review";

export interface CollectionMetadata {
  strategy: CollectionStrategy;
  confidence: "high" | "medium" | "low";
  publishable: boolean;
  sourceTextAvailable: boolean;
  robotsDisallowed?: boolean;
  diagnosticsId?: string;
  reason?: string;
}
```

---

## 11. 독일 BVerfG는 전용 spider로 구현

단일 `bundesverfassungsgericht.ts` 어댑터 안에서 해결하려 하지 말고, 전용 spider를 만든다.

```text
workers/crawler/src/spiders/bverfg/
  index.ts
  routes.ts
  selectors.ts
  extractors.ts
  sitemap.ts
  diagnostics.ts
```

수집 순서:

```text
1. robots.txt 확인
2. sitemap.xml / sitemap index 확인
3. Entscheidungen 관련 URL 후보 수집
4. Pressemitteilungen 관련 URL 후보 수집
5. 목록 페이지는 CheerioCrawler로 먼저 시도
6. 실패 시 PlaywrightCrawler로 렌더링
7. 상세 페이지 본문 추출
8. 결정번호, 결정일, 사건번호, 제목, 본문 추출
9. 본문이 없으면 metadata_only 또는 blocked/timeout
10. seed fallback은 최후 수단
```

BVerfG URL 후보/패턴:

```text
entscheidung
entscheidungen
presse
pressemitteilung
press
decision
SharedDocs
```

정상 수집으로 인정하는 조건:

```text
official_url = true
cleaned_text length >= 1000
collection.strategy in ["cheerio", "playwright", "sitemap-detail"]
collection.sourceTextAvailable = true
collection.publishable = true
status = summarized
```

---

## 12. 프랑스 Conseil/QPC360도 전용 spider로 구현

프랑스는 본 사이트와 QPC360을 분리한다.

```text
workers/crawler/src/spiders/conseil/
  main.ts
  qpc360.ts
  routes.ts
  selectors.ts
  extractors.ts
  diagnostics.ts
```

수집 대상:

```text
conseil-constitutionnel.fr
- décisions
- actualités
- communiqués

qpc360.conseil-constitutionnel.fr
- QPC décisions
- QPC metadata
```

프랑스 URL 후보/패턴:

```text
decision
decisions
qpc
communique
communiques
actualite
```

수집 실패 시 seed 요약을 만들지 말고 다음 상태로 저장한다.

```text
403 → blocked
timeout → timeout
본문 없음 → metadata_only
자동 판단 불확실 → needs_review
```

---

## 13. sitemap fallback 구현

공식 사이트의 sitemap을 적극 활용해라.

확인 대상:

```text
https://domain/sitemap.xml
https://domain/sitemap_index.xml
robots.txt 내 Sitemap 경로
```

sitemap에서 URL을 찾은 뒤 반드시 상세 페이지 본문 fetch를 다시 시도한다.

sitemap URL만으로는 publishable=true로 만들지 않는다.

정책:

```text
sitemap에서 URL 발견 + 상세 본문 확보 → collection.strategy = sitemap-detail, publishable = true
sitemap에서 URL만 발견 + 본문 없음 → metadata_only, publishable = false
```

---

## 14. Playwright fallback 정책

Playwright는 무조건 사용하지 말고 fallback으로만 사용한다.

사용 조건:

```text
fetch timeout
fetch 403
HTML은 받았지만 selector match 0건
JS 렌더링이 필요한 목록 페이지
redirect 후 예상 구조가 나오지 않는 경우
```

Playwright 결과도 다음을 기록한다.

```text
finalUrl
status
title
htmlLength
selectorMatchCount
linksDiscovered
waitUntil
waitForSelector
screenshot optional
```

---

## 15. robots.txt와 접근 정책 준수

robots.txt를 반드시 확인한다.

원칙:

```text
Disallow된 PDF 또는 원문은 fetch하지 않는다.
우회하지 않는다.
robots_disallowed 상태로 저장한다.
원문 본문 없이 LLM 요약하지 않는다.
공식 링크는 보존한다.
```

관리자 UI에는 다음처럼 보여준다.

```text
공식 목록은 확인했지만 robots.txt 정책상 원문 자동 수집을 수행하지 않았습니다.
공식 링크에서 직접 확인이 필요합니다.
```

---

## 16. LLM 요약 조건 강화

LLM 요약은 다음 조건을 만족할 때만 실행한다.

```ts
function canSummarize(article) {
  return (
    article.status === "cleaned" &&
    article.cleaned_text &&
    article.cleaned_text.length >= 1000 &&
    article.collection?.publishable === true &&
    article.collection?.strategy !== "seed" &&
    article.collection?.sourceTextAvailable === true &&
    article.collection?.robotsDisallowed !== true
  );
}
```

금지:

```text
metadata_only 상태에서 요약 생성 금지
robots_disallowed 상태에서 요약 생성 금지
seed 상태에서 요약 생성 금지
needs_review 상태에서 요약 완료 처리 금지
timeout 또는 blocked 상태에서 요약 생성 금지
```

---

## 17. UI 표시 수정

홈에는 기본적으로 다음만 표시한다.

```text
status = summarized
collection.publishable = true
```

관리자 페이지에는 전체 표시한다.

관리자 페이지에서 상태별로 구분한다.

```text
정상 요약 완료
본문 수집 대기
robots.txt로 원문 자동 수집 불가
공식 사이트 접근 차단
공식 사이트 timeout
seed URL 등록됨
사람 검토 필요
```

---

## 18. Summary Count 수정

현재 `Summary 5`라고 표시되는 것은 잘못이다.

다음처럼 분리해라.

```text
discovered_count
metadata_only_count
fetched_count
cleaned_count
summarized_count
publishable_count
needs_review_count
blocked_count
timeout_count
seed_count
robots_disallowed_count
```

표시 예:

```text
미국 SCOTUS
- discovered: 5
- metadata_only: 5
- summarized: 0
- publishable: 0
- robots_disallowed: 5

독일 BVerfG
- seed: 5
- summarized: 0
- publishable: 0
- timeout: 5

프랑스 Conseil/QPC360
- seed: 5
- summarized: 0
- publishable: 0
- blocked/timeout: 5
```

---

## 19. diagnostics 저장

수집 실패 원인을 숨기지 말고 ingestion_runs.metadata 또는 별도 diagnostics 테이블에 저장한다.

예시:

```json
{
  "sourceKey": "fr-conseil-constitutionnel",
  "attempts": [
    {
      "url": "https://www.conseil-constitutionnel.fr/les-decisions",
      "strategy": "cheerio",
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

관리자 페이지에서 최근 수집 실패 원인을 볼 수 있어야 한다.

---

## 20. 관리자 UI 개선

`/admin/ingestion-runs`에 diagnostics를 표시해라.

표시 항목:

```text
sourceKey
strategy
URL
status
errorCode
errorMessage
selectorMatchCount
discoveredCount
fallback 사용 여부
publishable_count
robots_disallowed_count
seed_count
timeout_count
blocked_count
```

실패한 source에 대해 다음 메시지를 보여줘.

```text
공식 사이트에 접근했지만 현재 수집 전략으로 목록 또는 본문을 안정적으로 파싱하지 못했습니다.
fetch, Crawlee CheerioCrawler, PlaywrightCrawler, sitemap, seed fallback 결과를 확인하세요.
```

---

## 21. 배포 방식

Vercel 함수에서 무거운 크롤링을 돌리지 마라.

선택지:

```text
1. GitHub Actions cron
2. Cloud Run
3. Fly.io worker
4. Render worker
5. Apify Actor
6. 별도 VPS cron
```

MVP에서는 GitHub Actions cron 또는 Apify Actor를 우선 검토한다.

Vercel은 UI/API/SEO 중심으로 유지한다.

---

## 22. package.json scripts 추가

다음 scripts를 추가해라.

```json
{
  "scripts": {
    "crawler:run": "tsx workers/crawler/src/cli.ts",
    "crawler:diagnose": "tsx workers/crawler/src/diagnose.ts",
    "crawler:bverfg": "tsx workers/crawler/src/cli.ts --source=de-bverfg",
    "crawler:conseil": "tsx workers/crawler/src/cli.ts --source=fr-conseil-constitutionnel",
    "crawler:qpc360": "tsx workers/crawler/src/cli.ts --source=fr-qpc360",
    "crawler:scotus": "tsx workers/crawler/src/cli.ts --source=us-scotus"
  }
}
```

진단 명령:

```bash
pnpm crawler:diagnose -- --source=de-bverfg
pnpm crawler:diagnose -- --source=fr-conseil-constitutionnel
pnpm crawler:diagnose -- --source=fr-qpc360
pnpm crawler:diagnose -- --source=us-scotus
pnpm crawler:diagnose -- --url=https://www.bundesverfassungsgericht.de
```

---

## 23. 지금 당장 해야 할 수정

우선 다음을 즉시 수정해라.

```text
1. seed 기반 독일/프랑스 article을 publishable=false로 변경
2. seed 기반 article의 summarized 상태 제거
3. metadata_only/seed/robots_disallowed 상태에서는 LLM 요약 실행 금지
4. 홈에서 needs_review 항목 숨김
5. Summary count를 실제 summarized_count로 수정
6. SCOTUS PDF robots disallow 항목은 robots_disallowed 또는 metadata_only로 변경
7. Crawlee worker 도입 브랜치 생성
8. 독일 BVerfG spider를 최우선 구현
9. 프랑스 Conseil/QPC360 spider를 다음 순서로 구현
10. 관리자 diagnostics UI 개선
```

---

## 24. 완료 조건

이번 수정의 완료 조건은 다음이다.

```text
홈 화면에는 seed/needs_review/metadata_only/robots_disallowed 항목이 보이지 않는다.
관리자 화면에는 왜 수집 실패했는지 diagnostics가 보인다.
summary_count는 실제 원문 기반 요약 건수만 계산한다.
독일/프랑스 seed 데이터는 정상 기사로 표시되지 않는다.
미국 SCOTUS PDF robots disallow 건은 요약 완료로 표시되지 않는다.
Crawlee 기반 worker가 추가된다.
BVerfG spider가 최소 1건 이상의 공식 상세 본문을 수집하거나, 실패 시 정확한 diagnostics를 남긴다.
Conseil/QPC360 spider가 최소 1건 이상의 공식 상세 본문을 수집하거나, 실패 시 정확한 diagnostics를 남긴다.
pnpm build가 성공한다.
```

---

## 25. README에 추가할 내용

README에 다음 섹션을 추가해라.

```md
## Crawler Architecture

이 프로젝트는 Next.js 앱 내부의 단순 fetch가 아니라 별도 Crawlee 기반 crawler worker를 사용한다.

### 수집 전략

1. 공식 RSS/API/JSON endpoint
2. Crawlee CheerioCrawler
3. Crawlee PlaywrightCrawler
4. sitemap fallback
5. seed fallback

### 정상 발행 조건

- 공식 원문 본문 확보
- cleaned_text 충분
- robots.txt 위반 없음
- LLM 요약 완료
- publishable=true
- strategy가 seed가 아님

### seed fallback의 의미

seed fallback은 공식 URL 후보를 저장하는 임시 보완 수단이다.
seed만으로는 기사 발행 또는 AI 요약을 하지 않는다.

### robots.txt disallow의 의미

robots.txt에서 원문 또는 PDF fetch가 disallow된 경우 우회하지 않는다.
해당 항목은 robots_disallowed 또는 metadata_only로 저장하고, 공식 링크만 제공한다.

### 진단 명령

```bash
pnpm crawler:diagnose -- --source=de-bverfg
pnpm crawler:diagnose -- --source=fr-conseil-constitutionnel
pnpm crawler:diagnose -- --source=fr-qpc360
pnpm crawler:diagnose -- --source=us-scotus
```
```

---

## 26. 보고 형식

작업 완료 후 다음 형식으로 보고해라.

```md
# 수집 파이프라인 수정 보고

## 수정 전 문제

## 수정한 상태 모델

## seed 데이터 처리 변경

## SCOTUS robots.txt 처리 변경

## Crawlee worker 도입 현황

## 독일 BVerfG spider 구현 현황

## 프랑스 Conseil/QPC360 spider 구현 현황

## 실제 수집 결과

| Source | Discovered | Metadata Only | Cleaned | Summarized | Publishable | Blocked | Timeout | Seed | Robots Disallowed |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|

## 홈 노출 기준

## 관리자 diagnostics 예시

## 아직 남은 문제

## 다음 조치
```

---

## 27. 핵심 판단

지금 문제는 “독일 사이트가 막혔다”가 아니라, 법원/정부 사이트에 맞는 전문 크롤링 계층이 아직 없다는 것이다.

따라서 다음 개발 목표는 다음처럼 바꿔야 한다.

```text
기존 목표:
소스 어댑터 구현 완료

새 목표:
공식 원문 기반 정상 발행 기준을 만족하는 Crawlee 기반 수집 파이프라인 완성
```

특히 독일 BVerfG는 다음을 최우선 목표로 한다.

```text
독일 BVerfG 판례 수집을 위한 Crawlee 기반 site-specific spider 완성
```

그 다음 프랑스 Conseil/QPC360, 미국 SCOTUS official listing spider를 같은 패턴으로 정리한다.
