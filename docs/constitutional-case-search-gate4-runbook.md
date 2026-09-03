# 헌법판례 다국어 recall Gate 4 운영 런북

상태: 로컬 구현·production-shaped PostgreSQL 계약 검증 완료, 운영 별칭 검토·migration·p95 canary 전

## 범위

Gate 4는 Gate 3의 exact identity 우선순위를 유지하면서 검토된 한국어·영어·독일어·프랑스어·스페인어 법률개념 별칭으로 recall을 확장한다. 검색 순서는 다음과 같다.

```text
exact identity
→ original lexical branch
→ reviewed alias OR branches
→ versioned weighted RRF
→ relevance-preserving jurisdiction demotion
→ deterministic keyset cursor
```

semantic retrieval과 Gemini embedding은 Gate 6 범위다. Gate 4 검색 요청은 Gemini를 호출하지 않는다.

## 1. 별칭 검토와 불변성

- `draft` alias set만 concept와 alias를 추가·수정할 수 있다.
- concept 하나에는 승인된 별칭이 최소 2개 있어야 한다.
- 지원 언어는 `ko`, `en`, `de`, `fr`, `es`다.
- `reviewed` 전환에는 검토자와 검토 시각이 필요하며 DB가 canonical content hash를 계산한다.
- reviewed set과 그 하위 concept/alias는 수정·삭제할 수 없다. 변경은 새 set version을 작성해 대체한다.
- migration에는 운영 별칭을 자동 seed하지 않는다. 법률 검토를 마친 별칭 세트만 별도 승인 절차로 등록한다.

새 reviewed set이 생기면 ranking version이 바뀐다. 과거 cursor는 `WORLDCONS_CASE_SEARCH_CURSOR_RANKING_VERSION_EXPIRED`로 거부되며, 홈페이지와 플러그인은 cursor를 제거하고 첫 페이지부터 다시 검색하도록 안내한다.

## 2. 폭발 상한과 순위 규칙

```text
감지 concept        최대 5
concept당 alias     최대 8
전체 alias branch   최대 12
branch당 candidate  최대 50
fusion candidate    최대 250
```

original lexical contribution은 `2/(60+rank)`, alias contribution은 `1/(60+rank)`다. 여러 번역 별칭이 같은 article을 찾더라도 alias-only 기여는 최댓값 하나로 제한한다. 따라서 alias-only 후보는 50위 original-query 후보를 단독으로 역전하지 못한다. exact identity 후보가 있으면 RRF branch 자체를 실행 결과에 포함하지 않는다.

국가 다양화는 후보를 추가하거나 점수를 올리지 않는다. 같은 관할의 세 번째 이후 결과만 8% 감점해 이미 relevance가 가까운 다른 관할 결과가 앞설 수 있게 한다. 0건이나 무관한 결과를 다양성 때문에 채우지 않는다.

## 3. 적용 전 검증

```text
CATALOG_TEST_DATABASE_URL=<disposable-postgres-url> pnpm test:catalog
pnpm test:plugin
pnpm test:public-regression
pnpm typecheck
pnpm check
pnpm lint
pnpm build
```

PostgreSQL 계약 테스트는 다음을 고정한다.

- 5개 언어 fixture가 같은 reviewed concept의 관련 판례를 찾는다.
- exact identity가 alias/RRF보다 항상 우선한다.
- original-query 후보 우선순위가 alias-only 후보 때문에 역전되지 않는다.
- 첫 결과군에서 relevance가 가까운 다른 관할만 제한적으로 올라온다.
- 무관한 질의는 0건을 유지한다.
- query/filter/ranking version에 묶인 cursor가 중복 없이 이어진다.
- alias set 변경 후 과거 cursor가 명시적으로 만료된다.
- reviewed row와 내부 검색 입력 테이블은 공개 role에서 읽거나 변조할 수 없다.
- 검색 함수는 service role 전용, 고정 `search_path`, 3초 statement timeout이다.

## 4. canary와 p95

1. 운영 migration 적용 전 백업과 migration dry run을 완료한다.
2. 법률 검토된 alias set 하나를 `draft`로 적재하고 hash·표본을 대조한 뒤 `reviewed`로 전환한다.
3. 한국어 원질의와 각 원어 질의의 top 20 precision/recall 표본을 비교한다.
4. exact 사건번호, 0건 질의, 국가·source·언어 filter, 3페이지 cursor를 확인한다.
5. 실제 운영 데이터에서 cold/warm p50·p95를 측정하고 p95가 3초 statement timeout보다 충분히 낮은지 확인한다.
6. slow query가 있으면 alias 수를 늘리지 말고 plan과 FTS index 경로를 먼저 교정한다.
7. 홈페이지와 ChatGPT 플러그인에서 같은 `rankingVersion`, `retrievalMode=rrf`, `nextCursor`를 확인한다.
8. 검색 중 Gemini 호출이 0회인지 확인한다.

## 5. 롤백

애플리케이션 기능 flag는 Gate 3와 동일하게 `CASE_CATALOG_PLUGIN_ENABLED` 후 `CASE_CATALOG_SEARCH_ENABLED` 순서로 끈다. reviewed alias row를 수정하거나 삭제하지 않는다. 잘못된 set은 새 reviewed replacement를 만들고, 과거 cursor가 만료되는 것을 정상 전환으로 취급한다. Catalog publication과 stale AI fail-closed 불변식은 유지한다.

## 6. 완료 증거

- 검토자·시각·content hash가 있는 운영 alias set
- 5개 언어 precision/recall 표본
- exact 우선·0건 보존·국가 다양화 결과
- 3페이지 이상 cursor 연속성과 alias version 만료 결과
- 운영 p50·p95와 timeout 비율
- 홈페이지·플러그인 동일 ranking metadata
- Gemini 호출 0회

이 증거가 모이기 전에는 Gate 4를 운영 완료로 표시하지 않는다.
