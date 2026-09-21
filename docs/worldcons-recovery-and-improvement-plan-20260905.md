# WorldCons 중단 작업 복구 및 개선 통합 구현 계획

작성: 2026-09-05. 코드 기준 `f6fa71f9ef8e8c2860dcaa13696d4264d25f8263`.

대상: [worldcons_opus](codex://threads/01a0524d-16db-79e2-8abd-d665b2aa89e0)의 중단 작업과 [프로젝트 분석 보고서](F:/dev/worldcons/artifacts/reports/worldcons-analysis-20260905.md)의 개선안. 이번 요청은 계획 작성이며, 이 문서 작성 중 수집 재시작·DB 수정·자동화 변경·커밋·배포는 수행하지 않았다.

## 1. 목표와 완료 범위

우선 독일 2024년 private-shadow 작업을 기존 승인 범위에서 복구하고, 같은 중단이 반복돼도 감지·재개·완료 판단이 정확하도록 만든다. 그다음 긴 원문 요약, 검색 장애 표시, 검증 자동화와 기존 경로 정리를 진행한다. 국가별 과거 판례 확대와 Catalog AI 처리는 별도 후속 단계로 구분한다.

이 계획의 1차 완료는 **독일 snapshot의 private-shadow canary PASS + 재시작 검증 + 모니터 정상화**다. Catalog 공개나 신규 AI 생성이 1차 완료 조건에 포함되는 것은 아니다.

## 2. 중단 작업에서 이어받을 사실

### 이미 완료된 작업: 재구현하지 않음

| 작업 | 확인 근거 | 후속 처리 |
|---|---|---|
| 출처별 inventory·artifact·리스·검증·Catalog 기반 | 현재 마이그레이션·코드와 기존 설계 문서 | 기존 기반 재사용 |
| 독일 2024 목록 288→287 정정 | supersession 기록, 교체 snapshot | 교체본만 재개, 재발견하지 않음 |
| 독일 비공개 수직 canary | fetch→normalize→verify 7건 | 완료 산출물 보존 |
| 독일 fetch 배치 2건 제한 | `62d0360`, operation-policy.ts | 유지 |
| fetch drain 및 canary 감사 기록 | `058f921`, `efa3bd6` | 새 수집기를 만들지 않고 보완 |
| cclrag2 검색 timeout·응답 조립 개선 | `c235a51`, migration `20260904100000` | 운영 계약 회귀만 재확인 |
| 한국어 관할 추론 보정 | `74f3511` | 기존 회귀 테스트 유지 |
| 기존 공개 자료 Gemini 임베딩 보충 | 오전 분석에서 누락 두 지표 모두 0 | 과거 “263건 남음” 기록을 현 상태로 재사용하지 않음 |
| Cloudflare 검색 제거·Vercel 통합·한국어 플러그인 안내 | 기존 작업 완료 기록과 현재 코드 | 현 구조 유지 |

cclrag2 소비자 측 Phase 6 재평가 최종 결과는 확인한 중단 기록에 남아 있지 않다. WorldCons 수정 완료와 소비자 전체 평가 완료를 동일시하지 않으며, 검색 단계에서 최신 결과를 확인한다.

### 2026-09-05 16:17 KST 재확인 결과

| 항목 | 현재 증거 |
|---|---|
| snapshot | `d6c7b404-2252-4369-a719-8e17d2dfaba2` |
| scope | de-bverfg / 2024-01-01~2024-12-31 / DECISION |
| policy | `bverfg-unattended-canary-v1`, 검토 기한 2027-03-03 |
| 항목 | verified 7 + fetched 223 + fetching 1 + discovered 56 = 287 |
| fetch artifact 연결 | 230건 |
| normalization·verification 연결 | 각각 7건 |
| 마지막 성공 로그 | fetch pass 117 |
| 중단 pass | 118 |
| command | `0c2b0207-3d6f-4a07-9fa2-4e92d81f39c9` |
| run | `3354b79f-44d7-4428-9d5f-570d12e08e0c`, DB 상태 running |
| 항목 claim attempt | `0b365886-d23e-46e9-b964-6b90ac297503` |
| 항목 lease 만료 | 2026-09-05 06:47:58 KST |
| 현재 관련 node 수집 프로세스 | 조회 결과 없음 |
| 마지막 로그 갱신 | 2026-09-05 06:44:25 KST |
| 읽기 전용 canary | blocked: `private_shadow_items_incomplete`, `active_claims_present` |
| canary terminal failure / retry wait | 0 / 0 |
| canary article link / Catalog publication / AI payload | 0 / 0 / 0 |

따라서 현재는 정상 실행을 기다릴 상태가 아니라 **멈춘 실행과 만료 claim을 기존 P1 복구 계약으로 정리할 상태**다. 미완료 fetch는 discovered 56건과 중단 항목 1건을 합친 57건이다. 이전 drain 로그의 `claimed=1`은 P1 attempt 집계일 수 있으므로 수집 항목 수로 쓰지 않는다.

기존 `bverfg` heartbeat 자동화는 ACTIVE이며 고장 난 원래 작업을 대상으로 한다. 저장된 프롬프트는 이미 종료된 PID 93532를 우선 확인하도록 돼 있다. 이전 작업에서는 93532 종료 후 13376으로 교체한 기록이 있으므로 고정 PID만으로 정상 여부를 판정할 수 없다.

작업 대화 자체에는 사용량 제한·연결 오류·압축 내용 복호화 오류가 기록돼 있다. 이 오류와 수집 프로세스 종료의 직접 인과관계는 확인하지 않았으며, 각각 독립적으로 진단한다.

## 3. 구현 원칙과 재사용 경계

- 이미 승인된 동일 snapshot의 private-shadow 재개는 기존 승인·정책·소유권을 확인해 수행한다. 같은 범위를 새 작업처럼 다시 승인받는 절차를 추가하지 않는다.
- `CASE_CATALOG_WRITE_ENABLED`, `CASE_CATALOG_PUBLIC_ENABLED`, `CASE_CATALOG_PLUGIN_ENABLED`는 false, 해당 private-shadow 작업의 Gemini 호출은 0으로 유지한다. 공개·검색·AI 범위의 임의 확대가 없어야 한다.
- snapshot 발견을 다시 실행하거나 superseded 목록을 재사용하지 않는다. 기존 fetch·normalized artifact와 감사 원장을 보존한다.
- 만료 claim은 기존 P1 claim/reclaim·fencing·종결 RPC를 통해 처리한다. 테이블 상태를 직접 덮어쓰거나 coordinator DB를 수정하지 않는다.
- 운영자·자동 모니터·다른 worker가 동시에 재개하지 않도록 snapshot/phase의 실행 소유권을 확인한다.
- 긴 문서 AI 개선은 기존 공개·처리 허용 자료의 경로부터 적용한다. 비공개 독일 자료를 AI 평가 입력에 섞지 않는다.
- 실행 직전에 기준 커밋·작업 트리·관련 coordinator task·리스·정책을 다시 확인한다. 이 문서의 숫자는 재개 시점의 최신 상태를 대신하지 않는다.

## 4. 구현 단위와 의존성

| ID | 우선순위 | 구현 단위 | 선행 조건 | 완료 산출물 |
|---|---|---|---|---|
| R0 | 최우선 | 중단 지점·소유권·자동화 이관 계획 고정 | 없음 | 복구 체크포인트 JSON·감사 문서 |
| V1 | 최우선 | 실제 PostgreSQL 검증과 PR CI | R0 | skip 없는 DB 검증·CI workflow |
| R1 | 최우선 | 재개·완료 판정·감시 보완 | R0, V1 | 재시작 회귀 테스트·단일 실행자·정확한 상태 |
| R2 | 최우선 | 남은 독일 fetch 57건 복구·완료 | R1 검증 | fetch backlog·claim·실패 0 |
| R3 | 높음 | normalize→verify→reconcile | R2 | private-shadow canary PASS |
| O1 | 높음 | 별도 일상 수집 후보 7건 분류 | V1 | 후보별 재시도·검토·제외 근거 |
| A1 | 높음 | 긴 문서 요약 범위 계측·분할 | V1 | 범위 provenance·긴 문서 평가 |
| S1 | 높음 | 검색 실제 모드·장애 응답·소비자 확인 | V1 | 계약 테스트·품질/지연 평가 |
| C1 | 중간 | 플래그 행렬·기존 경로 수렴 | R3, A1, S1 | parity 증거·단계적 단순화 |
| E1 | 후속 | 국가별 확대·Catalog 공개·장기 AI | 국가별 정책·선행 canary | 국가별 별도 rollout |

R0 이후 V1을 먼저 확보한다. R2 수집 대기 중에는 운영 수집 코드를 바꾸지 않는 문서·평가 fixture 작업을 할 수 있다. A1/S1 변경은 실행 중 worker와 같은 checkout의 코드를 바꾸지 않도록 별도 작업 공간 또는 worker 종료 시점에 진행한다.

## 5. R0/R1: 중단 복구와 재발 방지

**대상:** [drain-bverfg-fetch.ts](F:/dev/worldcons/scripts/drain-bverfg-fetch.ts), [backfill-corpus.ts](F:/dev/worldcons/scripts/backfill-corpus.ts), [P1 worker](F:/dev/worldcons/lib/admin/command-control-plane/p1-worker.ts), [backfill repository](F:/dev/worldcons/lib/backfill/repository.ts), [workflow heartbeat](F:/dev/worldcons/lib/ops/workflow-heartbeat.ts).

1. process ID뿐 아니라 command line의 snapshot·phase, 시작 시각, 최신 heartbeat, run/attempt/item lease를 함께 기록한다. 본문·토큰·환경변수 비밀값은 증거 파일에 저장하지 않는다.
2. pass 118의 command/run/attempt 관계와 source-backfill run·request permit까지 조회한다. 살아 있는 다른 실행자가 있으면 관측 모드로 유지하고 신규 drain을 제출하지 않는다.
3. 기존 CLI의 결정적 pass 선택과 멱등 키를 사용해 같은 미완료 작업을 재개한다. 운영 재개 전 disposable PostgreSQL에서 오래된 attempt가 거부되고 새 fencing token만 성공하는지 확인한다.
4. drain의 완료 조건을 `due backlog=0`, `retry=0`뿐 아니라 미완료 fetch·잔여 claim·진행 중 pass 없음과 대조한다. 유효한 다른 worker claim은 `waiting`, 만료된 claim은 `recoverable interruption`으로 구분한다.
5. 시작·진행·종료·bounded stop·비정상 종료를 구조화해 기록한다. `max-passes` 도달은 성공 완료가 아니라 이어서 처리할 중단점으로 표현한다.
6. 응답 성공 횟수와 실제 저장 artifact 수를 구분한다. 로그의 고정된 `publicCatalogWrites=0` 같은 값만을 감사 증명으로 쓰지 않고 canary의 DB 증거와 작업 실행 계측을 함께 사용한다.
7. 기존 `bverfg` 자동화 하나를 정상 작업으로 이관·갱신한다. 기존 설정을 보존하고 고정 PID 의존을 제거한다. 동일 상태에서는 조용히 유지하고 중단·실패·필요한 조치·단계 완료에서만 알린다. 이번 계획 작성에서는 자동화를 변경하지 않았다.
8. 종료·재개 횟수를 제한하고 반복 실패는 근거가 있는 오류 상태로 전환한다. snapshot 전체 재생성이나 무제한 자동 재시작을 복구 수단으로 사용하지 않는다.

**검증:** 프로세스 강제 종료 후 재claim, 종료 직전 일부 artifact만 저장된 경우, 만료 token 쓰기 거부, 이중 worker, retry 시각 미도달, backlog 0이지만 claim 1, 정상적인 bounded stop, 오래된 로그만 남은 경우. 완료 기준은 중복 side effect 없이 미완료 항목만 이어서 처리하고 감시가 잘못된 “정상 진행”을 보고하지 않는 것이다.

## 6. R2/R3: 기존 백필의 실제 마무리

### Fetch 복구

- 현재 230개 fetch 산출물과 검증 완료 7건을 보존한다.
- 기존 2건 배치와 source request governor 정책을 유지해 중단 항목 포함 57건을 처리한다.
- 각 pass의 run/attempt 종결, 저장 산출물 증가, retry·terminal failure·request permit 상태를 대조한다.
- 수집 실패가 남으면 원인을 해결하거나 정책상 허용된 명시적 제외를 증거와 함께 처리한다. 단순히 상태만 성공으로 바꾸지 않는다.
- 완료 기준: fetch가 필요한 항목 0, 활성·고아 claim 0, retry·terminal failure 0. 287건 전체의 항목별 결과가 설명돼야 한다.

### Normalize → Verify → Reconcile

- fetch 완료 gate 뒤에 bounded normalize를 실행한다. 먼저 작은 배치로 저장된 approved replay evidence에서 정규화 결과를 확인한 뒤 범위를 늘린다.
- 기존 정상 검증 7건은 parser·계약 버전과 산출물 유효성이 유지되는 한 불필요하게 다시 처리하지 않는다.
- 정규화가 공식 네트워크를 다시 호출하거나 AI를 부르는 경로가 없는지 fixture와 실행 계측으로 검증한다.
- authority URL, 사건 식별자, 출처 정책 버전, payload hash, current/verified normalization pointer를 확인한다.
- 최종 reconcile 후 `pnpm verify:bverfg-shadow-canary -- --snapshot=d6c7b404-2252-4369-a719-8e17d2dfaba2`를 실행한다.
- 완료식: **verified + 명시적 excluded = 287**, retry/terminal failure/claim 0, inventory·enumeration digest 일치, 잘못된 authority 0, article link·Catalog publication·AI payload 0. 현재 canary는 waiver를 통과 결과로 인정하지 않으므로 이를 우회 완료 수단으로 추가하지 않는다.
- `external_index_assisted`를 유지한다. 287건 완료는 승인된 목록 처리 완료이며 독일 공식 판례 전체 확보율 100%가 아니다.

완료 단계마다 snapshot·정책·parser·커밋·관측 시각·결과·변경 전후 집계를 감사 문서에 남긴다. 기존 작업에서 승인된 커밋·main 푸시 절차를 이어받되 실제 변경과 검증을 갖춘 단계만 반영한다.

## 7. V1: 실제 DB 검증과 릴리스 자동화

**대상:** 새 PR 검증 workflow, [package.json](F:/dev/worldcons/package.json), [PostgreSQL 테스트](F:/dev/worldcons/tests).

- disposable PostgreSQL과 pgvector 환경을 구성하고 P0/P1/P2/P3/P5/BACKFILL/CATALOG 전용 환경변수를 제공한다. 기존 테스트의 전용 DB 이름·격리 조건에 맞춰 테스트 DB를 분리한다.
- DB가 없는 일반 로컬 테스트는 현재처럼 구분할 수 있지만, release 검증은 필수 통합 테스트의 skip를 실패로 처리한다.
- 타입·린트·검사·실행 테스트·실제 마이그레이션/ACL/RPC 검증·플러그인 검증·빌드를 PR/push에서 실행한다. 외부 AI·운영 credentials를 쓰지 않는 fixture 경로를 사용한다.
- 테스트 순서와 전용 DB 사이의 간섭을 제거한다. migration 전부 적용, 이전 DB에서 순차 업그레이드, 권한 경계와 fencing을 확인한다.
- 변경된 파일명 문자열만 검사하는 테스트를 핵심 동작 검증으로 보완한다. 소스 계약 검사는 필요한 부분에 남긴다.
- GitHub 필수 상태 검사 지정은 실제 branch protection을 조회한 뒤 적용한다. workflow 생성만으로 필수화됐다고 보고하지 않는다.

완료 기준: 새 환경에서 운영 비밀값 없이 재현, 필수 PostgreSQL skip 0, 테스트 결과와 배포 커밋 일치. 오전의 338 pass/7 skip 결과는 비교 기준이며 이 gate를 통과한 증거는 아니다.

## 8. O1: 일상 수집의 장기 후보 7건

이 7건은 독일 2024 snapshot의 287건과 다른 큐다. 하나의 완료율이나 backlog로 합치지 않는다.

- 404 후보 5건과 공식 본문 미검증 2건을 분리하고 마지막 시도·공식 식별자·URL 변형·기존 article 연결을 확인한다.
- 일시적 실패, 재발견 필요, 운영자 검토 필요, 명시적 제외로 분류한다. 최대 시도 횟수와 경과 기간을 함께 사용한다.
- 수동 검토 대상을 더 이상 “계속 재시도 가능한 정상 대기”로 표시하지 않도록 관리 화면·health 집계를 보완한다.
- 일상 수집 중복 삽입·품질 하락 방지 테스트를 유지한다.

완료 기준: 7건 모두 다음 행동과 근거가 존재하고, 회복 불가능한 후보가 무제한 재시도하지 않음. 모든 후보의 원문을 반드시 확보했다는 결과를 강제하지 않는다.

## 9. A1: 긴 판결문 요약 개선

**대상:** [prompts.ts](F:/dev/worldcons/lib/ai/prompts.ts), [summarize.ts](F:/dev/worldcons/lib/ai/summarize.ts), [schema.ts](F:/dev/worldcons/lib/ai/schema.ts), 수집 요약 저장·공개 버전 경로.

1. 본문 전체 길이, 입력 길이, 포함 범위, 절단 여부, source hash, prompt/pipeline 버전을 산출물에 기록한다. 기존 요약의 정보는 추정해 채우지 않고 unknown으로 구분한다.
2. 짧은 문서는 기존 흐름을 보존하고, 긴 문서는 문단·판결 구조를 기준으로 나눠 범위가 겹치거나 빠지지 않게 처리한다. 각 구간 근거를 결합하는 최종 요약 단계에 출처 위치를 전달한다.
3. 일부 구간 실패·할당량 소진 시 부분 처리임을 저장한다. 불완전한 새 요약으로 기존 정상 공개 버전을 덮어쓰지 않는다.
4. UI·외부 계약에 처리 범위를 additive 필드로 제공하고, 기존 소비자가 누락 필드를 처리할 수 있는지 확인한다.
5. 앞부분 사실과 후반 주문·별개의견이 다른 긴 문서, 구간 재시도, 원문 개정, stale 산출물, 공급자 제한을 테스트한다.
6. 재요약은 영향받는 표본부터 실행하고 비용·응답 길이·근거 누락을 평가한 뒤 점진적으로 확대한다.

완료 기준: 입력 범위 누락이 계측되고, 표본의 핵심 판단에 확인 가능한 source 구간이 연결되며, 부분 실패가 완전 요약으로 표시되지 않음. 현재 비공개 독일 자료의 AI 금지는 그대로 유지한다.

## 10. S1: 검색 품질·장애 표현·소비자 검증

**대상:** [vector.ts](F:/dev/worldcons/lib/search/vector.ts), [queries.ts](F:/dev/worldcons/lib/db/queries.ts), [검색 API](F:/dev/worldcons/app/api/search/route.ts), [검색 UI](F:/dev/worldcons/app/search/page.tsx), 외부 provider 계약.

- 기존 cclrag2 SQL timeout 수정은 유지하고 동일 비교질의의 순차·동시 요청 회귀를 실행한다. cache HIT 결과만으로 개선을 판정하지 않는다.
- `/api/search`와 UI에 requestedMode/effectiveMode/degraded/reason을 일관되게 제공한다. 의미 검색 실패가 전문 검색으로 전환되면 실제 처리 모드를 표시한다.
- 정상 0건, 의미 검색만 사용 불가, DB 검색 전체 실패를 구분한다. fallback DB 오류를 정상 빈 결과로 숨기지 않는다.
- 혼합 검색 fallback에서 쿼리 임베딩을 중복 생성하는지 확인하고 가능한 경우 동일 요청의 결과를 재사용한다.
- 국가별 사건번호, 한국어·영어·독일어·프랑스어·스페인어 법률 개념, 긴 비교질의, 오타·0건, 다음 페이지·만료 커서를 평가 집합에 넣는다.
- 최소 4개국 × 정확 식별/개념/비교 질의의 기준 fixture를 마련하고, top-k 적합성·중복·국가 조건·p50/p95·fallback 비율을 변경 전후 비교한다. 성능 목표는 실측으로 고정하며 소비자 8초 예산은 회귀 경계로 유지한다.
- cclrag2의 Phase 6 최종 평가를 확인하고 provider 검색→상세 hydration→인용 근거까지 소비자 측 결과를 확보한다. 소비자 장애를 WorldCons 쿼리 범위 확대만으로 숨기지 않는다.

외부 응답 계약 변경은 구현 전에 coordinator에서 관련 활성 세션을 확인한다. cclrag2·cclmetasearch·WorldLaws와 의견을 조율하고 구현 후 검토를 받는다. 비활성 프로젝트에는 근거와 질문을 남기며, 현재 계획에는 상대 프로젝트가 승인했다고 가정한 설계를 넣지 않는다.

## 11. C1/E1: 구조 정리와 후속 확장

**기존 경로 정리:** P3/legacy/Catalog 읽기·쓰기·검색 플래그의 지원 조합을 명시하고 off→shadow→read 전환·롤백을 실행 테스트로 고정한다. public count·identity·stale AI 제외·cache invalidation parity를 확인한 뒤 책임별 모듈을 분리한다. 기존 retirement의 관측기간·보존·owner 근거를 만족하기 전 호환 테이블·writer를 제거하지 않는다.

**운영 보강:** 분산 rate-limit fallback 비율을 계측하고 DB 장애 시 로컬 제한이 선택됐음을 운영자가 알 수 있게 한다. nonce CSP 같은 추가 변경은 별도 작은 변경으로 브라우저 회귀를 통과시킨다. README·progress에는 기준 커밋·현황 날짜·실제 네 국가를 반영한다.

**국가별 확대:** 기존 설계 Gate 5의 코드와 실제 실행을 나눈다. 독일 2024 private-shadow 완료 후, 승인된 국가·연도·유형별 snapshot으로 진행한다. 프랑스 QPC/DC, 스페인 Sentencia, 미국 Constitution Annotated의 policy·authority·review 계약을 재사용한다. source 정책이 없는 국가를 새 데이터 실행 대상으로 자동 활성화하지 않는다. 기존 문서의 국가 순서는 현재 정책 준비도와 검증 결과를 기준으로 재평가한다.

**Catalog 공개:** private-shadow PASS 후에도 공개는 별도 단계다. source-only 소규모 공개, `/articles/{slug}`·통합 검색·MCP의 중복 제거·본문 정책·stale AI 제외·롤백을 먼저 검증한다.

**장기 AI/임베딩:** 기존 설계 Gate 6의 light/full artifact·수요 기반 우선순위·Gemini retrieval embedding은 별도 후속 작업이다. 원문 출처 정책이 허용하는 자료에 한정하고 provenance·quota·원문 hash 변경을 검증한다. 기존 공개 1,258건의 임베딩 누락 해소를 Catalog AI 완료로 간주하지 않는다.

## 12. 변경 단위·릴리스·인수 기준

권장 변경 분리는 다음과 같다. 아래 명칭은 계획용이며 아직 PR·커밋을 생성하지 않았다.

1. `test: enforce postgres release gates` — V1.
2. `fix: recover and observe interrupted backfill` — R1, RPC 변경이 꼭 필요한 경우에만 additive migration.
3. `docs: record bverfg fetch completion` — R2 운영 증거.
4. `docs: record bverfg private shadow completion` — R3 증거와 canary 결과.
5. `fix: classify persistent source candidates` — O1.
6. `feat: track summary input coverage` 및 `feat: summarize long source documents` — A1을 계측과 생성 전략으로 분리.
7. `fix: expose effective search mode` 및 `test: verify comparative retrieval` — S1.
8. `refactor: consolidate supported publication paths` — C1. 국가별 확대는 국가별 별도 변경.

각 구현 변경은 관련 실행 테스트와 타입·린트 검사를 거치고, DB/API/공개 경로 변경이면 실제 PostgreSQL·소비자 계약·프로덕션 빌드까지 검증한다. 배포 전 백업과 적용할 migration을 확인하고, 배포 후 health·검색·MCP·관리자 경계와 커밋 일치를 확인한다. 문서만 바뀐 변경에 전체 AI 생성이나 전체 수집을 다시 실행하지 않는다.

실패 시 앱 플래그·이전 배포의 지원 범위로 복귀하고 새 private artifact는 감사 증거로 보존한다. 공개 상태 변경은 기존 publication 전이·outbox 계약을 사용한다. 운영 중인 worker를 낡은 PID만 보고 종료하거나 기존 작업 디렉터리를 정리하지 않는다.

**1차 인수:** 287개 목록의 결과가 설명되고 private-shadow canary PASS, 잔여 claim·retry·terminal failure 0, 공개·AI 경계 유지, 감시 정상화, DB 통합 검증 skip 0.

**개선 인수:** 장기 후보별 조치 완료, 긴 문서 처리 범위 표시·평가, 실제 검색 모드·오류 구분, 소비자 회귀 확인, 지원 플래그 조합과 운영 문서 일치.

## 13. 재개 시 사용할 읽기 전용 확인 명령

```powershell
pnpm backfill:corpus status -- --snapshot=d6c7b404-2252-4369-a719-8e17d2dfaba2
pnpm verify:bverfg-shadow-canary -- --snapshot=d6c7b404-2252-4369-a719-8e17d2dfaba2
```

`status`가 실제 CLI 명령이다. 중단 작업에 등장한 `inspect`는 현재 CLI의 지원 목록에 없으므로 그대로 복사하지 않는다. canary의 exit code 1은 현재 미완료 상태를 정확하게 검출한 결과이며 그 자체로 검사 도구의 장애는 아니다. 실행 명령의 최종 인수는 재개 시점의 지원 옵션·정책·리스 상태를 확인해 확정한다.

근거: [기존 backfill 설계](F:/dev/worldcons/docs/worldcons-constitutional-case-backfill-design-20260903.md), [독일 정책·운영 증거](F:/dev/worldcons/docs/germany-bverfg-source-policy-review-20260904.md), [canary 구현](F:/dev/worldcons/lib/backfill/germany-shadow-canary.ts), [기존 분석](F:/dev/worldcons/artifacts/reports/worldcons-analysis-20260905.md).
