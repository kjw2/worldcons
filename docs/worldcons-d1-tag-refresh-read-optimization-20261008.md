# worldcons_core D1 rows_read 급증 대응 — 2026-10-08

## 조사 범위

대상 데이터베이스는 `worldcons_core` 한정. `newthesis_prod_db`는 별도 세션에서 조치하며 변경하지 않는다.

운영 규모: `articles=2,381`, `tags=5,372`, `article_tags=14,012`.

## 원인 및 실측

`lib/cloudflare/summary/d1-summary-drain.ts`의 `refreshTagCounts()`에서
`tags`의 매 행에 대해 `article_tags`를 상관 서브쿼리로 `COUNT`/`MAX` 여러 차례 집계했다.
`article_tags` 기본 복합 PK 순서는 `(article_id,tag_id)`로, `tag_id` 단독 조건은
인덱스를 활용할 수 없었으며 D1 `EXPLAIN QUERY PLAN`이 `SCAN at`을 확인했다.

Cloudflare D1 Production 직접 실행 결과 (읽기 전용 샘플):

| 시험 | rows_read |
|---|---:|
| 기존 COUNT 구조, 25개 태그 | 350,325 |
| 기존 COUNT 구조, 100개 태그 | 1,401,300 |
| 신규 집합 기반 집계, 전체 5,372개 태그 | 74,178 |
| 신규 실제 UPDATE, 전체 5,372개 태그 | 74,179 (rows_written=0, changes=0) |

기존 COUNT **하나만** 전체 태그에 적용하면 최소 약 7,527만 행을 읽는다는 외삽이며,
원래 UPDATE에는 이와 유사한 COUNT/MAX 서브쿼리가 여러 개 있었다.
따라서 주기적 증분 번역 후 태그 통계 갱신이 최근 읽기 급증의 가장 유력한 원인이다.
전체 24시간 읽기 중 이 SQL의 정확한 비율은 per-query 추적 없이 확정하지 않는다.

## 개선

`d1-tag-count-refresh.ts`: `MATERIALIZED` CTE로 모든 태그의 요약을 **한 번** 만들고,
`UPDATE ... FROM desired`에서 변동이 있는 태그만 갱신한다.
기존과 같은 `summarized`/`json_valid`/`collection.publishable=1` 자격 조건,
태그에 해당 공개 기사가 없는 경우 `count=0,latest=NULL` 처리를 유지한다.
전체 태그에 대한 각종 상관 전체 스캔과 불필요한 UPDATE를 없앴다.
인덱스 변경이나 신규 마이그레이션은 필요하지 않다.

## 검증 및 배포

- SQLite 테스트: 태그 0건·부적격 기사·비정상 JSON·최신 날짜·idempotence 검증.
- 회귀 테스트 23/23 통과. `tsc --noEmit`, `m8:typecheck`, `m8:dry-run`, Vinext 빌드 통과.
- Production main `worldcons`: `fc1cc45a-c9e8-43f7-a768-b8f6d5513526`.
- Production ingest `worldcons-ingest`: `1512577d-6455-4496-a16d-5ff490ddf459`.
- 운영 D1 신규 UPDATE 실행: 74,179행 읽기, 수정 0건, 소요 약 61ms.

후속 운영 검증은 동일한 기간의 D1 `rows_read`/시간 분포와 번역 배치 수를 비교하여
실제 절감량을 판단한다. 일일 집계는 이미 발생한 과거 사용량을 즉시 소급 제거하지 않는다.
