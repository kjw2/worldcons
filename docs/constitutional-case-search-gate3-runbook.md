# 헌법판례 통합 검색·ChatGPT 플러그인 Gate 3 운영 런북

상태: 로컬 구현·production-shaped PostgreSQL 계약 검증 완료, 운영 migration·Spain Gate 2 canary 승인 전

## 범위

Gate 3는 current P3와 source-only Catalog를 한 공개 검색 계약으로 연결한다. 같은 article은 `public_article_detail_v4`에서 한 번만 대표되며, 최신 Catalog anchor와 맞지 않는 stale P3 요약·제목·태그·embedding은 검색 후보와 플러그인 응답에 들어가지 않는다.

이번 gate의 검색 순서는 다음으로 제한한다.

```text
exact identity
→ original lexical FTS
→ deterministic keyset cursor
```

alias 확장, RRF, 국가 다양화와 Catalog semantic embedding은 Gate 4 이후다. Gate 3 Catalog 검색은 Gemini를 호출하지 않는다.

## 1. 적용 전 검증

```text
CATALOG_TEST_DATABASE_URL=<disposable-postgres-url> pnpm test:catalog
pnpm test:plugin
pnpm test:p3
pnpm test:public-regression
pnpm typecheck
pnpm check
pnpm lint
pnpm build
```

PostgreSQL 실행에서는 다음을 확인한다.

- `case_identifiers_v1.normalized_value`와 기존 source-aware `case_key`가 exact identity 후보를 만든다.
- exact identity 후보가 하나라도 있으면 lexical 후보가 순위를 역전하지 않는다.
- P3와 Catalog가 모두 있어도 article ID는 한 번만 반환된다.
- source-only 결과가 `enrichmentStatus=source_only`, `summaryAvailable=false`로 반환된다.
- cursor는 URL-safe 문자만 사용하고 ranking version, query/filter fingerprint, score, date, ID를 보존한다.
- 다른 질의에 cursor를 재사용하거나 손상된 cursor를 보내면 400 계약으로 거부된다.
- 검색 RPC는 service role만 실행하며 고정 `search_path`와 statement timeout을 가진다.

## 2. API와 무한 스크롤 계약

첫 요청에는 cursor를 보내지 않는다. `hasMore=true`이면 응답의 `pageInfo.nextCursor`를 다음 요청에 그대로 보낸다. Catalog 검색에서 두 번째 페이지부터 cursor가 없으면 fail-closed한다. 클라이언트는 cursor를 해석하거나 수정하지 않는다.

응답은 기존 필드를 유지하고 다음 상태 필드를 additive하게 제공한다.

```text
enrichmentStatus
enrichmentFreshness
summaryStatus
summaryAvailable
officialMetadataAvailable
retrievalMode
rankingVersion
pageInfo.nextCursor
```

`mode=hybrid`는 Catalog semantic flag가 꺼진 Gate 3에서 exact/lexical 검색으로 동작한다. 명시적 `mode=semantic`은 기존 current P3 semantic 경로를 유지하며 Gate 3 cursor를 받지 않는다.

## 3. ChatGPT 플러그인 계약

- `search`와 `search_cases`는 기존 `id`, `title`, `url`을 유지하면서 상태 필드와 `nextCursor`를 추가한다.
- `fetch`는 current full 요약이 있을 때만 `한국어 AI 요약` heading과 본문을 만든다.
- source-only는 공식 정보와 `요약 미제공` 상태만 반환한다.
- stale full/light는 최신 공식 정보와 `summaryStatus=reprocessing`만 반환하고 과거 AI 본문을 반환하지 않는다.
- `fetch_source_text`는 공개 detail projection이 이미 적용한 text policy 범위만 페이지 단위로 반환한다.
- 모든 도구는 공개·무인증·읽기 전용이고 canonical URL은 `/articles/{slug}`다.

홈페이지 `/guide/chatgpt-plugin`은 한국어 연결 절차, MCP 주소 복사 버튼, 인증 불필요 안내와 함께 AI 요약이 항상 존재하지 않는다는 설명을 유지한다.

## 4. 활성화 순서

Gate 2 Spain canary와 source-only 상세 검증을 먼저 완료한다.

1. `CASE_CATALOG_SEARCH_ENABLED=true`를 canary 환경에 적용한다.
2. 홈페이지에서 사건번호 exact, 원문 제목·쟁점 lexical, filter, 2페이지 cursor를 확인한다.
3. source-only/current full/stale correction fixture가 각각 한 번만 나오는지 확인한다.
4. 검색 API rate limit, invalid cursor 400, DB timeout 503을 확인한다.
5. `CASE_CATALOG_PLUGIN_ENABLED=true`를 적용한다.
6. ChatGPT에서 `search → fetch → 필요 시 fetch_source_text`를 실행한다.
7. source-only와 stale 응답에 AI 요약 heading·본문이 없는지 확인한다.
8. 기존 current full 판례의 제목·요약·공식 URL이 회귀하지 않았는지 확인한다.
9. Gemini 호출 수가 0인지 확인한다.

## 5. 롤백

1. `CASE_CATALOG_PLUGIN_ENABLED=false`
2. `CASE_CATALOG_SEARCH_ENABLED=false`

이 순서로 끄면 플러그인과 홈페이지 검색은 기존 current P3 경로로 돌아간다. `CASE_CATALOG_PUBLIC_ENABLED`와 write flag는 Gate 2 판단에 따라 별도로 유지하거나 내린다. DB migration, cursor 함수와 immutable Catalog 데이터는 삭제하지 않는다. `catalog_ai_stale_v4`는 flag와 무관한 불변식이므로 수동 해제하지 않는다.

## 6. Gate 3 완료 증거

- exact identity와 lexical 실데이터 질의 결과
- 동일 article dedupe 결과
- 2페이지 이상 cursor 연속성과 중복 0건
- source-only/current full/stale 플러그인 응답 캡처
- invalid cursor·rate limit·timeout 결과
- 기존 P3 및 공개 URL 회귀 테스트
- Gemini 호출 0회 증거

운영 증거가 모두 모이기 전에는 Gate 4 alias/RRF나 국가 확대를 시작하지 않는다.
