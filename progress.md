# Progress

프로젝트 전수 조사 기준으로 발견한 미구현, 부분 구현, 미연결, 오류 가능성, 개선 사항을 모두 처리했다. 이후 긴급 수집 파이프라인 수정 기준으로 공개 가능성 정책을 재정의했고, seed/blocked/timeout/robots_disallowed 데이터가 요약 또는 홈 노출되지 않도록 추가 보강했다.

| ID | Priority | Area | 발견 사항 | 처리 내용 | Status | Progress |
| --- | --- | --- | --- | --- | --- | --- |
| P0-01 | P0 | AI summary | LLM completion이 없을 때 DB에 개발용 mock summary가 저장될 수 있음 | `ALLOW_MOCK_SUMMARY=true`일 때만 mock 저장, mock metadata 명시, 실제 실패는 `failed_summary` 유지 | Done | 100% |
| P0-02 | P0 | Search | `/api/search?mode=semantic|hybrid`가 mode를 반환만 하고 실제 분기하지 않음 | API와 `/search` UI 모두 fulltext/semantic/hybrid 분기 연결, 실패 시 graceful fallback | Done | 100% |
| P0-03 | P0 | Search | 검색 대상이 요약 JSON, 태그, 국가/기관, 조문까지 충분히 포함되지 않음 | 제목, 요약 JSON, 원문, URL, 국가, 기관, 태그명/정규명/유형까지 검색 대상 확장 | Done | 100% |
| P0-04 | P0 | API | `/api/sources`, `/api/sources/[sourceKey]`, `/api/admin/ingestion-runs` 미구현 | 세 API 추가, admin runs는 bearer와 `?secret=` 인증 적용 | Done | 100% |
| P0-05 | P0 | Ingest | 독일/프랑스 어댑터가 현재 공식 사이트 구조 또는 차단 상황에서 0건이 되기 쉬움 | fetch retry/header/Playwright fallback, 공식 URL 패턴 보강, QPC360 경로, BVerfG numbered fallback, DE/FR 날짜 파싱 추가 | Done | 100% |
| P0-06 | P0 | Ingest | 수집 파이프라인이 DB `sources.is_active`를 반영하지 않음 | Supabase 연결 시 active source만 기본 실행 | Done | 100% |
| P0-07 | P0 | Dedup | 중복 제거가 canonical URL 중심이라 title/date/hash 중복 방지가 약함 | source별 content hash와 title/date 중복 확인 추가 | Done | 100% |
| P0-08 | P0 | Detail UI | 상세 페이지에 보존 원문 스냅샷, risk flag, 요약 상태 정보가 부족함 | 상태, 읽기 시간, 검수 신호, 보존 원문 스냅샷 표시 | Done | 100% |
| P1-01 | P1 | Admin | 관리자 페이지 인증이 브라우저 쿼리 secret을 지원하지 않음 | admin 페이지 `?secret=` 허용 및 내부 링크 secret 유지 | Done | 100% |
| P1-02 | P1 | Cron/Admin | cron/admin ingest가 요약 limit/태그 갱신 옵션이 제한적 | `CRON_SUMMARY_LIMIT`, admin body의 `summarize`, `summarizeLimit`, `refreshTags` 지원 | Done | 100% |
| P1-03 | P1 | Embedding | embedding abstraction이 OpenAI 전용이고 검색용 query embedding helper가 없음 | `createTextEmbedding` 추가, semantic search 연결, embedding 부재 시 요약 실패하지 않도록 처리 | Done | 100% |
| P1-04 | P1 | Date parsing | 독일/프랑스 날짜 문자열 파싱 지원이 부족함 | `dd.MM.yyyy`, French/German long month date 파싱 추가 | Done | 100% |
| P1-05 | P1 | Filters | UI/API 필터에 원문 언어 필터가 없음 | 목록, 검색, `/api/articles`, `/api/search`에 language 필터 연결 | Done | 100% |
| P1-06 | P1 | Pagination | 목록/검색 페이지에 페이지 이동 UI가 없음 | 공용 pagination 컴포넌트 추가 및 쿼리 유지 | Done | 100% |
| P1-07 | P1 | Glossary | DB migration에 용어사전 초기 seed가 없어 DB 환경에서 빈 페이지가 됨 | 핵심 용어 seed migration 추가 및 현재 DB upsert 적용 | Done | 100% |
| P1-08 | P1 | SEO | sources/glossary/list pages 일부 metadata가 기본값에 의존 | sources, source detail, tags, glossary metadata/canonical 보강 | Done | 100% |
| P1-09 | P1 | Sitemap | sitemap article limit이 100으로 제한됨 | article sitemap 상한 1000으로 확대 | Done | 100% |
| P2-01 | P2 | Docs | README가 mock summary 동작, Gemini, 브랜드명, API 범위와 일부 불일치 | README 전면 최신화 | Done | 100% |
| P2-02 | P2 | Tests | `pnpm check`가 새 날짜/필터/Gemini/mock metadata 동작을 검증하지 않음 | check coverage 확장 | Done | 100% |
| P2-03 | P2 | Tag maintenance | orphan tag 정리 옵션이 없음 | `refresh-tag-counts -- --delete-orphans` 추가 및 실행 | Done | 100% |
| P2-04 | P2 | Cleanup | placeholder 검색 함수와 문서 불일치가 남아 있음 | 실제 semantic/hybrid 함수로 교체, README placeholder 설명 제거 | Done | 100% |

## Verification

| Check | Result |
| --- | --- |
| `pnpm check` | Pass |
| `pnpm exec tsc --noEmit` | Pass |
| `pnpm lint` | Pass |
| `pnpm build` | Pass |
| DB summary smoke | 총 15건, 미국 5건, 독일 5건, 프랑스 5건, summarized 0건, publishable 0건, 홈 노출 0건 |
| DB glossary seed | 4건 |
| Runtime smoke | `/`, `/api/search`, `/api/sources`, `/api/admin/ingestion-runs` 200 |

## Crawler/Scraper Layer Progress

| ID | Priority | Requirement | Status | Progress |
| --- | --- | --- | --- | --- |
| C0-01 | P0 | 공통 crawler 타입과 `CrawlRequest`/`CrawlResponse`/diagnostics 인터페이스 | Done | 100% |
| C0-02 | P0 | HTTP client timeout, retry, headers, redirect, status diagnostics | Done | 100% |
| C0-03 | P0 | Playwright fallback client와 concurrency guard | Done | 100% |
| C0-04 | P0 | link/readable text/metadata extractor | Done | 100% |
| C0-05 | P0 | robots.txt 확인과 disallow 시 robots_disallowed/비공개 경로 | Done | 100% |
| C0-06 | P0 | sitemap fallback과 source별 keyword filtering | Done | 100% |
| C0-07 | P0 | BVerfG RSS/fetch/Playwright/sitemap/seed 단계형 discovery | Done | 100% |
| C0-08 | P0 | Conseil/QPC360 RSS/fetch/Playwright/sitemap/seed 단계형 discovery | Done | 100% |
| C0-09 | P0 | seed fallback metadata warning과 collection confidence 저장 | Done | 100% |
| C0-10 | P0 | ingestion_runs.metadata diagnostics 저장 | Done | 100% |
| C1-01 | P1 | `pnpm ingest -- --debug --strategy=...` CLI 옵션 | Done | 100% |
| C1-02 | P1 | `pnpm crawl:diagnose` 진단 명령 | Done | 100% |
| C1-03 | P1 | `/admin/ingestion-runs` diagnostics 표시 | Done | 100% |
| C1-04 | P1 | 상세 페이지 collection strategy/confidence 표시 | Done | 100% |
| C1-05 | P1 | README crawler troubleshooting 섹션 | Done | 100% |
| C1-06 | P1 | Gemini task routing이 `provisions` 문자열을 vision 작업으로 오분류할 수 있음 | Done | 100% |
| C1-07 | P1 | `needs_review` 저신뢰 수집본이 요약 재시도 후 `summarized`로 바뀔 수 있음 | Done | 100% |
| C1-08 | P1 | 메인 화면을 국가 그룹이 아닌 시간순 10건 단위 목록으로 고정 | Done | 100% |

## Crawler Verification

| Check | Result |
| --- | --- |
| `pnpm crawl:diagnose -- --source=de-bverfg` | Pass |
| `pnpm crawl:diagnose -- --source=fr-conseil-constitutionnel` | Pass |
| `pnpm crawl:diagnose -- --source=us-scotus` | Pass |
| `pnpm ingest -- --source=us-scotus --limit=5 --debug` | Pass |
| `pnpm ingest -- --source=de-bverfg --limit=5 --debug` | Pass, timeout diagnostics와 seed fallback 기록 |
| `pnpm ingest -- --source=fr-conseil-constitutionnel --limit=5 --debug` | Pass, timeout/403 diagnostics와 seed fallback 기록 |
| Data reset and reprocess | Pass, 미국 5건/독일 5건/프랑스 5건 총 15건 |
| Gemini summary processing | Emergency policy applied, source_text 미확보/seed/blocked/timeout/robots_disallowed 데이터는 요약 대상에서 제외 |
| Main listing query | Pass, `pageSize=10`, `original_published_at desc nulls last` 시간순 |
| Article collection metadata | 15/15 articles have `collection.strategy` |

## Emergency Crawler Pipeline Progress

| ID | Priority | Requirement | 처리 내용 | Status | Progress |
| --- | --- | --- | --- | --- | --- |
| E0-01 | P0 | `needs_review`, `failed_fetch`, `failed_summary`, `seed`, `robots_disallowed`, `metadata_only`, `blocked`, `timeout`을 정상 기사로 취급하지 않음 | `canSummarizeArticle`, `isPublishableListItem`, `deriveCollectionStatus`, `finalizeCollectionMetadata` 추가 | Done | 100% |
| E0-02 | P0 | publishable 조건을 공식 URL, 원문 확보, robots 준수, 충분한 cleaned_text, seed 제외, summarized 상태로 제한 | ingest insert, summarize pending, 목록 query, semantic search 필터에 `collection.publishable=true` 적용 | Done | 100% |
| E0-03 | P0 | 새 상태 `metadata_only`, `robots_disallowed`, `blocked`, `timeout` 추가 | DB 타입, migration, UI status label, ingestion diagnostics count 반영 | Done | 100% |
| E0-04 | P0 | seed fallback은 후보 저장만 하고 요약/홈 노출 금지 | seed collection을 `publishable=false`, `sourceTextAvailable=false`, `reason` 포함으로 고정 | Done | 100% |
| E0-05 | P0 | SCOTUS PDF robots disallow는 fetch/summary 금지 | SCOTUS listing은 official PDF URL만 보존하고 robots disallow collection metadata와 비공개 상태 기록 | Done | 100% |
| E0-06 | P0 | Admin diagnostics에서 실패 원인과 counts 표시 | ingestion status panel에 publishable, metadata, robots, blocked, timeout, seed counts 추가 | Done | 100% |
| E0-07 | P1 | crawler worker 명령 체계 추가 | `crawler:run`, `crawler:diagnose`, `crawler:bverfg`, `crawler:conseil`, `crawler:qpc360`, `crawler:scotus` 추가 | Done | 100% |
| E0-08 | P1 | Supabase migration 준비 | `20260509000000_publishable_collection_policy.sql` 추가, initial/search migrations도 공개 가능 조건으로 보강 | Done | 100% |

## Emergency Pipeline Verification

| Check | Result |
| --- | --- |
| `pnpm exec tsc --noEmit` | Pass |
| `pnpm lint` | Pass |
| `pnpm check` | Pass, publishable/seed summarization guard 포함 |
| `pnpm build` | Pass |
| `pnpm crawler:diagnose -- --source=us-scotus --limit=1 --strategy=auto` | Pass, official listing 후보는 `metadata_only_candidate`, `publishable=false` |
| Current DB article rows | 총 15건, 미국 5건/독일 5건/프랑스 5건 |
| Current DB publishable rows | 0건 |
| Current DB summarized rows | 0건 |
| Current home listing query | `pageSize=10`, `total=0` |
| SCOTUS current collection status | 5건 robots disallowed, summary cleared |
| BVerfG current collection status | 5건 timeout + seed fallback, summary cleared |
| Conseil current collection status | 5건 blocked + seed fallback, summary cleared |
| Remote DB status compatibility | Supabase direct migration은 현재 실행 환경의 IPv6 DB 접속 제한으로 미적용, 실제 row status는 legacy `needs_review`로 유지하고 fine-grained status는 metadata에 보존 |

## BVerfG Timeout Diagnostics Progress

| ID | Priority | Requirement | 처리 내용 | Status | Progress |
| --- | --- | --- | --- | --- | --- |
| B0-01 | P0 | timeout phase를 DNS/TCP/TLS/header/body/Playwright 등으로 분리 | `lib/crawler/network-diagnostics.ts` 추가, `crawler:diagnose -- --source=de-bverfg --debug`에 phase별 출력 연결 | Done | 100% |
| B0-02 | P0 | IPv4 우선 실행 지원 | `applyIpv4FirstForSource`, `BVERFG_USE_IPV4_FIRST=true`, worker/ingest CLI 적용 | Done | 100% |
| B0-03 | P0 | BVerfG sitemap-first discover | BVerfG config `preferSitemap=true`, sitemap detail fetch 후 Playwright fallback, list parsing은 fallback | Done | 100% |
| B0-04 | P0 | 보수적 크롤링 기본값 | `BVERFG_CRAWL_DELAY_MS=3000`, `BVERFG_TIMEOUT_MS=60000`, `BVERFG_MAX_CONCURRENCY=1`, `BVERFG_RETRY_COUNT=2` 기본 적용 | Done | 100% |
| B0-05 | P0 | seed를 article이 아닌 재시도 후보로 저장 | `source_url_candidates` migration/helper 추가, BVerfG seed article fallback 비활성화 | Done | 100% |
| B0-06 | P1 | 관리자 diagnostics에 timeout/action 노출 | timeout phase, text length, recommended action 표시 추가 | Done | 100% |

## BVerfG Timeout Verification

| Check | Result |
| --- | --- |
| `pnpm crawler:diagnose -- --source=de-bverfg --debug` | Pass, 현재 환경 DNS IPv4 resolved, IPv6 DNS failed, IPv4 TCP connect timeout, robots/sitemap/detail 미확보 |
| `pnpm crawl:worker -- --source=de-bverfg --limit=1 --strategy=auto --dry-run --no-playwright` | Pass, discovered 0, seed article 생성 없음, seed는 `source_url_candidates` 후보 저장 시도 |
| `pnpm exec tsc --noEmit` | Pass |
| `pnpm check` | Pass |
| `pnpm lint` | Pass |
| `pnpm build` | Pass |

## External Crawlee Layer Progress

| ID | Priority | Requirement | 처리 내용 | Status | Progress |
| --- | --- | --- | --- | --- | --- |
| X0-01 | P0 | TypeScript 기반 Crawlee 도입 | `crawlee@3.16.0` 추가, `lib/crawlee/*` spider 계층 구성 | Done | 100% |
| X0-02 | P0 | CheerioCrawler와 PlaywrightCrawler 모두 사용 | 공통 runner에서 CheerioCrawler 기본 수집, PlaywrightCrawler 렌더링 fallback 구현 | Done | 100% |
| X0-03 | P0 | 독일 BVerfG 전용 spider | `lib/crawlee/bverfg-spider.ts` 추가, 결정 URL 필터/본문 selector/seed 판례 정의 | Done | 100% |
| X0-04 | P0 | 프랑스 Conseil constitutionnel/QPC360 전용 spider | `lib/crawlee/france-spider.ts` 추가, Conseil/QPC360 목록/결정 필터/seed 정의 | Done | 100% |
| X0-05 | P0 | RequestQueue, retry, rate limit, diagnostics, sitemap fallback | RequestQueue 기반 pass, max retries, same-domain delay, timeout, sitemap fallback diagnostics 저장 | Done | 100% |
| X0-06 | P0 | 기존 SourceAdapter wrapper 유지 | 독일/프랑스 SourceAdapter를 Crawlee spider 호출 wrapper와 raw cache로 교체 | Done | 100% |
| X0-07 | P0 | seed fallback 최후 수단 유지 | `auto` 순서를 Cheerio -> Playwright -> sitemap -> seed로 고정 | Done | 100% |
| X0-08 | P0 | collection.strategy/confidence/diagnostics 저장 | raw metadata에 collection, confidence, diagnostics, crawlee transport 기록 | Done | 100% |
| X0-09 | P0 | crawler worker를 Next.js 요청 처리와 분리 | `pnpm crawl:worker` CLI 추가, Vercel inline crawling 기본 차단 | Done | 100% |
| X0-10 | P0 | Vercel 함수가 아닌 별도 worker/GitHub Actions/Cloud Run/Apify 설계 | `.github/workflows/crawlee-worker.yml` 추가, README 운영 지침 반영 | Done | 100% |

## External Crawlee Verification

| Check | Result |
| --- | --- |
| `pnpm exec tsc --noEmit` | Pass |
| `pnpm lint` | Pass |
| `pnpm check` | Pass |
| `pnpm build` | Pass |
| `pnpm crawl:worker -- --source=de-bverfg --limit=1 --strategy=seed --dry-run --no-playwright` | Pass, BVerfG 공식 사이트 timeout diagnostics와 seed metadata fallback 기록 |
| `pnpm crawl:worker -- --source=fr-conseil-constitutionnel --limit=1 --strategy=seed --dry-run --no-playwright` | Pass, QPC360 403 diagnostics와 seed metadata fallback 기록 |
| `pnpm crawl:worker -- --source=fr-conseil-constitutionnel --limit=1 --strategy=playwright --dry-run --use-playwright` | Pass, 브라우저 미설치 환경에서 PlaywrightCrawler launch diagnostics 기록 |
