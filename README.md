# 헌법재판소도서관 헌법판례요약시스템

세계 헌법재판 큐레이션을 위한 Next.js/Supabase 기반 MVP입니다. 미국, 독일, 프랑스 헌법재판기관의 공식 자료를 수집하고, 한국어 요약·태그·검색·용어사전으로 정리합니다.

## 기술 스택

- Next.js App Router, React Server Components, TypeScript strict
- Tailwind CSS, shadcn/ui 스타일의 로컬 컴포넌트
- Supabase PostgreSQL, pgvector, full-text search, pg_trgm
- Crawlee 기반 CheerioCrawler/PlaywrightCrawler, Readability, pdf-parse
- OpenAI/Gemini 요약 abstraction, OpenAI embedding
- Vercel 배포와 Cron endpoint 전제

## 로컬 실행

```bash
pnpm install
cp .env.example .env
pnpm dev
```

Supabase 환경변수가 없으면 UI는 mock 데이터로 렌더링됩니다. DB에 mock summary를 저장하려면 `ALLOW_MOCK_SUMMARY=true`를 명시해야 합니다.

## 핵심 환경변수

최소 운영 구성은 `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `LLM_PROVIDER`, LLM API key, `CRON_SECRET`, `APP_BASE_URL`입니다.

Gemini 사용 시 `LLM_PROVIDER=gemini`와 `GEMINI_API_KEY` 또는 `GEMINI_API_KEYS`만 지정하면 됩니다. 모델명은 기본적으로 Gemini 3, 2.5, 2 순서로 후보를 잡고 라우터가 남은 사용량과 cooldown을 반영해 선택합니다.

추가 옵션:

- `ALLOW_MOCK_SUMMARY=false`: LLM 실패 시 mock summary 저장 방지
- `OPENAI_EMBEDDING_MODEL=text-embedding-3-small`: embedding 모델
- `CRON_SUMMARY_LIMIT=20`: cron 요약 처리량
- `INGEST_FETCH_TIMEOUT_MS=30000`: 공식 사이트 fetch timeout
- `INGEST_ENABLE_PLAYWRIGHT_FALLBACK=false`: 403/차단 대응용 브라우저 fallback
- `SEARCH_MAX_CANDIDATES=1000`: 앱 레벨 상세 검색 후보 상한
- `CRAWLER_USER_AGENT`: 공식 사이트 요청 User-Agent
- `CRAWLER_TIMEOUT_MS=30000`: crawler fetch timeout
- `CRAWLER_RETRY_COUNT=2`: fetch retry count
- `CRAWLER_DELAY_MS=1500`: 같은 origin 요청 사이의 기본 지연
- `CRAWLEE_DISCOVER_LIMIT_PER_SOURCE=20`: Crawlee spider의 source별 discovery 상한
- `CRAWLEE_MAX_CONCURRENCY=2`: CheerioCrawler 동시성
- `CRAWLEE_PLAYWRIGHT_MAX_CONCURRENCY=1`: PlaywrightCrawler 동시성
- `CRAWLEE_MAX_RETRIES=2`: Crawlee RequestQueue retry 횟수
- `CRAWLEE_SAME_DOMAIN_DELAY_SECS=1.5`: 같은 domain 요청 간격
- `CRAWLEE_STORAGE_DIR=.crawlee-storage`: Crawlee local storage 위치
- `ENABLE_VERCEL_CRAWLING=false`: Vercel 함수 내 무거운 크롤링 차단
- `PLAYWRIGHT_ENABLED=true`: fallback browser rendering 사용
- `PLAYWRIGHT_TIMEOUT_MS=45000`: Playwright timeout

## Supabase migration

```bash
supabase db push
```

적용 대상:

```text
supabase/migrations/20260508000000_initial_schema.sql
supabase/migrations/20260508001000_search_and_glossary.sql
```

초기 schema는 source/article/tag/ingestion/glossary 테이블, `search_vector`, pgvector index를 만듭니다. 검색·용어 migration은 `match_articles` RPC와 핵심 용어 seed를 추가합니다.

## 수집과 요약

```bash
pnpm ingest
pnpm ingest -- --source=us-scotus --limit=5
pnpm ingest -- --source=de-bverfg --limit=10 --debug
pnpm ingest -- --source=fr-conseil-constitutionnel --limit=10 --debug --strategy=auto
pnpm crawl:worker -- --source=de-bverfg --limit=5 --strategy=auto --use-playwright --debug
pnpm crawl:worker -- --source=fr-conseil-constitutionnel --limit=5 --dry-run
pnpm summarize-pending
pnpm summarize-pending -- --limit=5
pnpm refresh-tag-counts
pnpm refresh-tag-counts -- --delete-orphans
```

수집은 DB의 `sources.is_active=true`인 source만 기본 실행합니다. 중복 제거는 canonical URL, source별 content hash, source별 title/date를 함께 확인합니다.

## Crawler and Scraper Troubleshooting

### 수집 전략

1. Crawlee `CheerioCrawler` 목록/본문 수집
2. Crawlee `PlaywrightCrawler` 렌더링 fallback
3. sitemap fallback
4. seed fallback

독일 BVerfG와 프랑스 Conseil constitutionnel/QPC360은 전용 Crawlee spider를 사용합니다. 기존 `SourceAdapter`는 spider를 호출하는 wrapper로 유지되며, discovery 중 확보한 본문은 어댑터 내부 캐시에 보관해 `fetchItem()`에서 재요청하지 않습니다.

수집 결과는 article metadata에 다음 정보를 저장합니다.

- `source_metadata.collection.strategy`: `cheerio`, `playwright`, `sitemap`, `seed`
- `source_metadata.collection.confidence`: `high`, `medium`, `low`
- `source_metadata.diagnostics`: URL, 최종 URL, status, selector match, discovered count, retry/fallback/error 신호

### Worker 실행 원칙

무거운 크롤링은 Next.js 요청 처리와 분리합니다. Vercel 함수에서는 `ENABLE_VERCEL_CRAWLING=true`를 명시하지 않는 한 `runIngest()`가 `mode=blocked`로 종료됩니다. 운영 수집은 `pnpm crawl:worker`를 GitHub Actions, Cloud Run, Apify Actor 같은 별도 worker에서 실행하는 것을 전제로 합니다. 예시 workflow는 `.github/workflows/crawlee-worker.yml`에 포함되어 있습니다.

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
- `cleaned_text` 충분
- robots.txt 위반 없음
- LLM 요약 완료
- `collection.publishable=true`
- strategy가 seed가 아님

### seed fallback의 의미

seed fallback은 공식 URL 후보를 저장하는 임시 보완 수단이다. seed만으로는 기사 발행 또는 AI 요약을 하지 않는다.

### robots.txt disallow의 의미

robots.txt에서 원문 또는 PDF fetch가 disallow된 경우 우회하지 않는다. 해당 항목은 `robots_disallowed` 또는 `metadata_only`로 저장하고, 공식 링크만 제공한다. SCOTUS는 PDF 전체를 금지로 취급하지 않고 `https://www.supremecourt.gov/robots.txt`를 실행 시 확인해 URL path별 Allow/Disallow를 판단한다. `/opinions/`, `/orders/`처럼 허용된 path는 공식 원문으로 fetch와 PDF 텍스트 추출을 시도하고, `/images/`, `/rss/`, `/cdn/`처럼 금지된 path는 요청하지 않는다. SCOTUS 수집은 `maxConcurrency=1`과 robots `Crawl-delay`를 적용하며, 기본 운영 delay는 2초 이상이다.

### 진단 명령

```bash
pnpm crawler:diagnose -- --source=de-bverfg
pnpm crawler:diagnose -- --source=de-bverfg --debug
pnpm crawler:diagnose -- --source=fr-conseil-constitutionnel
pnpm crawler:diagnose -- --source=fr-qpc360
pnpm crawler:diagnose -- --source=us-scotus
pnpm crawler:diagnose -- --url=https://www.bundesverfassungsgericht.de
```

### BVerfG timeout 진단

BVerfG는 목록 selector보다 sitemap-first를 우선한다. 기본값은 `BVERFG_CRAWL_DELAY_MS=3000`, `BVERFG_TIMEOUT_MS=60000`, `BVERFG_MAX_CONCURRENCY=1`, `BVERFG_RETRY_COUNT=2`, `BVERFG_USE_IPV4_FIRST=true`이다. `pnpm crawler:diagnose -- --source=de-bverfg --debug`는 DNS, IPv4/IPv6, TCP, TLS, robots.txt, sitemap, 상세 fetch, Playwright navigation, timeout phase를 한 번에 출력한다.

추가 네트워크 확인:

```bash
curl -I --max-time 30 https://www.bundesverfassungsgericht.de
curl -L -I --max-time 30 https://www.bundesverfassungsgericht.de
curl -L --max-time 60 https://www.bundesverfassungsgericht.de/robots.txt
curl -4 -L -I --max-time 30 https://www.bundesverfassungsgericht.de
curl -4 -L --max-time 60 https://www.bundesverfassungsgericht.de/robots.txt
curl -6 -L -I --max-time 30 https://www.bundesverfassungsgericht.de
openssl s_client -connect www.bundesverfassungsgericht.de:443 -servername www.bundesverfassungsgericht.de
curl -4 -L --max-time 60 https://www.bundesverfassungsgericht.de/sitemap.xml
```

`curl -4`는 성공하고 `curl -6`이 timeout이면 `NODE_OPTIONS=--dns-result-order=ipv4first` 또는 `BVERFG_USE_IPV4_FIRST=true`로 worker를 실행한다. 현재 네트워크에서 TCP connect 자체가 timeout이면 Cloud Run `europe-west3`/`europe-west1`, Fly.io Frankfurt/Amsterdam, Apify Actor, Hetzner 독일 VPS 같은 EU worker를 우선 사용한다.

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
pnpm crawl:diagnose -- --url=https://www.conseil-constitutionnel.fr/les-decisions
```

`pnpm ingest -- --debug`와 `pnpm crawl:worker -- --debug`는 시도 URL, strategy, HTTP status, 최종 URL, selector match count, discovered count, 실패 사유를 출력합니다.

### seed fallback의 의미

seed fallback은 공식 URL을 기반으로 한 임시 보완 수집이며, live discovery보다 신뢰도가 낮습니다. 따라서 article metadata에 `collection.strategy = seed`, `collection.confidence = low`로 표시합니다.

### 크롤링 정책

이 프로젝트는 공식 사이트 정책을 존중하며 과도한 요청을 하지 않습니다. `robots.txt`를 확인하고, disallow path는 원문 수집을 건너뛰어 검수 대상으로 남깁니다. `CRAWLER_DELAY_MS`와 `CRAWLER_RETRY_COUNT`로 요청 빈도와 retry를 조절할 수 있습니다.

## 검색

UI와 `/api/search`는 `mode=fulltext|semantic|hybrid`를 지원합니다.

- `fulltext`: 제목, 요약 JSON, 원문, URL, 국가, 기관, 태그 앱 레벨 검색
- `semantic`: query embedding과 Supabase `match_articles` RPC 사용, 실패 시 fulltext fallback
- `hybrid`: fulltext 결과와 semantic 결과를 병합

필터는 기간, 기관, 국가, 유형, 태그, 원문 언어를 지원합니다.

## API

- `GET /api/articles`
- `GET /api/articles/[slug]`
- `GET /api/search`
- `GET /api/tags`
- `GET /api/tags/[slug]`
- `GET /api/sources`
- `GET /api/sources/[sourceKey]`
- `GET /api/admin/ingestion-runs`
- `POST /api/admin/ingest`
- `GET /api/admin/cron/ingest`

관리 API와 관리자 페이지는 `Authorization: Bearer ${CRON_SECRET}` 또는 `?secret=`로 보호됩니다. `POST /api/admin/ingest`는 `sourceKey`, `limit`, `summarize`, `summarizeLimit`, `refreshTags` body 옵션을 받습니다.

## LLM 고지

요약 상세 페이지에는 “AI 요약 참고 고지”와 실제 사용된 provider/model이 표시됩니다. 이 값은 `summary_json.aiMetadata`에 저장됩니다.

## 검증

```bash
pnpm check
pnpm exec tsc --noEmit
pnpm lint
pnpm build
```

## 어댑터 추가

`lib/sources/types.ts`의 `SourceAdapter`를 구현하고 `lib/sources/index.ts`의 `sourceAdapters`에 추가합니다.

필수 메서드:

- `discover()`: 목록/RSS/PDF 링크 탐색
- `fetchItem()`: 원문 fetch 및 text 추출
- `normalize()`: DB 저장 가능한 `NormalizedArticle` 생성
