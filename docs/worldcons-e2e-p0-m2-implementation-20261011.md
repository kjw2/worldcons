# WorldCons E2E-P0/M2 구현 결과 — 2026-10-11

판정: **M2 Core 원자적 Search 예약·dispatcher 코드 구현과 로컬 검증 통과. Production 적용과 M3–M4 E2E 실증은 미완료. P0 종료 불가.**

## 작업 기준과 보존

- M1의 독립 작업 트리 `C:/Users/jaeth/.codex/worktrees/e2e-p0-m1/worldcons`, 브랜치 `codex/e2e-p0-m1`에서 이어서 구현했다. 기준 main과 이번에 확인한 원격 main은 모두 `a415860362877bafef579cab0c18133dcdb877d3`다.
- 원본 `F:/dev/worldcons`의 admin·watchdog 미커밋 변경, 승인된 계획과 기존 incident 증거 JSON을 보존했다. 계획·incident JSON의 SHA-256은 M1 기록과 같다.
- M1 결과 문서와 증거는 당시 검증 snapshot으로 보존했다. 아래 M2 기록이 현재 코드 상태를 설명한다. M1 문서의 “Search outbox는 아직 없다”는 당시 상태다.
- 커밋·푸시·Production migration·Worker 배포·cohort 활성화를 실행하지 않았다. dependency와 lockfile도 수정하지 않았다.

## M2 실제 변경

| 파일 | 구현 |
|---|---|
| `d1/worldcons_core/0005_e2e_search_repair_outbox.sql` | Core Search repair outbox, 작업 identity·기대 P3/세대·정책·증거, 처리/전송 lease·fence·별도 예산 |
| `lib/cloudflare/e2e/search-repair-reservation.ts` | deterministic outbox ID와 unique(article, generation, operation) 예약; replay에서 기존 작업 상태 유지 |
| `lib/cloudflare/e2e/generation-ledger.ts` | 발행 batch에 outbox 결합, 새 세대에서 구세대 작업의 소유권 무효화, replay receipt 연결, 실제 D1 expression depth 수정 |
| `lib/cloudflare/e2e/contracts.ts` | receipt에 `searchRepairOutboxId` 추가 |
| `lib/cloudflare/e2e/search-repair-dispatcher.ts` | 현재 Core identity 확인, 전송 lease/CAS, 중단 복구, M1 예약 누락 복구, 내구성 retry/dead-letter와 health 조회 |
| `workers/async-pipeline/src/e2e-search-repair-scheduled.ts`, `index.ts` | 기존 15분 scheduled 경로에 기본 비활성 dispatcher 연결; 전용 Queue/보호 Consumer readiness 요구 |
| `tests/helpers/e2e-core-fixture.ts` | M1/M2 공용 실제 SQLite 배치 adapter; RETURNING과 끝단 SQL 실패 지원 |
| `tests/e2e-p0-m2-search-repair.test.ts`, `e2e-p0-m2-d1-runtime.test.ts` | SQLite 장애/경합 19개와 실제 로컬 workerd D1 API 검증 1개 |
| `tests/e2e-p0-m1-generations.test.ts`, `package.json` | M1 rollback 검사에 Search outbox 포함; M2 테스트·release gate 등록 |

### 같은 Core commit에 발행과 Search 의도 기록

선택적 `e2eApproval`가 있는 Core 발행 호출은 기존 M1 batch에 Search 예약을 추가한다. 배치 첫 snapshot CHECK, P3 version/head·publication/history·audit/request/cache outbox, 세대/head/progress/request, Search outbox, 구세대 작업의 supersession, 마지막 CHECK row 정리가 같은 transaction 안에서 실행된다. 첫 CHECK 충돌 또는 마지막 SQL 실패는 새 발행·세대·outbox와 구작업 supersession까지 모두 롤백한다.

기존 P3/v4 head UPSERT의 opt-in 경로는 관측한 `current_version_id/current_revision` 조건을 유지한다. affected-row 사후 검사에 원자성을 의존하지 않는다. 실제 D1 API에서 경합과 마지막 CHECK 실패 모두 `stale_revision`으로 반환되고 기존 작업만 보존되는 것을 확인했다.

`published`는 `project`, 나머지 발행 상태는 `remove`를 예약한다. 동일 승인 재수집·중복 전달은 같은 outbox identity를 재사용하며 lease·attempt·검증 증거를 초기화하지 않는다. 시각만 변경한 재수집은 P3 revision·generation·Search 예약 증가가 모두 0이다. 철회와 동일 버전 재게시에는 서로 다른 세대가 배정된다.

새 세대 commit은 미검증 구세대 outbox를 `superseded`로 바꾸고 Consumer `fencing_token`과 전송 `dispatch_fence`를 증가시켜 소유권을 취소한다. 검증된 과거 작업/완료 증거는 이력으로 남긴다. 이 동작은 Search DB tombstone 구현을 대신하지 않는다.

### 실제 D1 API에서 발견한 M1 결함 수정

기존 SQLite fixture는 통과했지만 로컬 workerd의 D1 API는 M1 snapshot CHECK에 대해 `Expression tree is too large (maximum depth 100)`를 반환했다. article 전체 컬럼 비교가 긴 AND 연결로 만들어진 것이 원인이었다. 모든 비교와 binding 순서를 유지하고 조건을 균형 잡힌 AND 트리로 생성하도록 수정했다. 실제 D1 발행, `UPDATE ... RETURNING` 결과, 경합 CHECK와 끝단 SQL 실패의 전체 batch 롤백이 수정 후 통과했다. Production D1에서 실행한 검증은 아니다.

### 전송 복구와 완료의 경계

- Queue payload는 `{schemaVersion: 1, type: "e2e-search-repair", outboxId}`뿐이다. 본문/승인 snapshot을 전달하지 않으며 Consumer는 M3에서 durable row를 재조회해야 한다.
- dispatcher는 세대 현재 head, 정확한 P3/v4 head와 publication ID/version/revision/state, 정책 및 projection hash가 맞는 due row만 조건부 claim한다.
- 전송 lease는 300초다. 결과 반영은 같은 owner·token·정수 fence·유효 lease·현재 Core identity·비종결 상태를 모두 요구한다. progress 갱신과 lease 해제를 같은 batch에 넣고 각각 원래 소유권을 검사한다.
- commit 직후 send 전에 종료되면 pending row가 남는다. send 수락 뒤 확인 전에 종료되면 lease 만료 후 같은 ID로 다시 보낸다. 응답 유실도 durable retry로 처리한다. 전송 중 새 세대가 commit되거나 더 최신 dispatcher가 소유권을 얻으면 옛 확인 응답은 원장을 바꾸지 못한다.
- Queue 전송 성공은 outbox `verified`나 generation `completed_verified`를 기록하지 않는다. progress는 `search_pending`까지 바뀌고 outbox는 처리 대기 상태로 남는다. 성공했어도 Consumer의 검증 기록이 없으면 재전송할 수 있다.
- 전송 횟수/실패는 `dispatch_*`에 따로 기록한다. 실제 처리용 `attempt_count`는 증가시키지 않는다. 활성 Consumer lease나 종결 상태도 늦은 전송 실패가 덮어쓰지 못한다.
- 전송 실패는 60초부터 지수 backoff와 ±20% jitter를 적용한 뒤 900초로 제한한다. 연속 8회 실패 또는 첫 실패 후 120분이면 전송 `dead_letter`를 기록한다. provider 오류 본문은 저장하지 않고 제한된 오류 코드만 남긴다.
- M1 upgrade 시 현재 유효 세대의 outbox가 빠졌으면 reconciler가 CAS CHECK와 같은 identity로 예약한다. P3나 generation을 새로 만들지 않고, 과거 비현재 세대를 복구 대상으로 승격하지 않는다.

Health 조회는 current pending 수/최장 대기, 반복 전송 실패, Core identity drift, 누락 예약과 dead-letter를 집계한다. 대기 30분·반복 실패 3회·drift/누락/dead-letter는 구조화 error log로 관측한다. **담당자 알림 연결, Consumer 처리 예산/redrive 및 Search 내용 감사는 아직 후속 구현 범위**다. 로그만으로 운영 경보 전달 완료를 주장하지 않는다.

## 활성화·호환·롤백 조건

`WORLDCONS_E2E_SEARCH_DISPATCH_ENABLED=true`, `WORLDCONS_E2E_SEARCH_CONSUMER_READY=true`와 전용 `E2E_SEARCH_REPAIR_QUEUE`가 모두 있어야 dispatch한다. 현재 Wrangler config에 이 flags/binding을 추가하지 않아 기본 비활성이다. 기존 M8/stage Queue에 새 메시지를 보내지 않는다. schema/DB 오류는 명시적 운영 실패로 기록되며 정상 빈 결과로 취급하지 않는다.

스키마 적용 순서는 기존 Core migration → `0004` → `0005`다. legacy opt-out 발행은 새 테이블이 있어도 기존 동작을 유지한다. 새 opt-in 발행의 구 schema 사용은 실패하며 outbox 없는 새 발행 성공으로 처리하지 않는다. 활성화 전에는 M3의 보호 Consumer, 모든 cohort writer 통제 및 공개 읽기 보호를 배포해야 한다. pause/rollback 시 dispatcher flag를 끄고 commit된 원장·pending 작업·증거를 보존한다.

현재 fallback 연결은 **15분 cron**이다. `next_dispatch_at`의 60초 due 시간은 실제 60초 재시도 주기를 보장하지 않는다. M3 활성화 때 전용 dispatch cadence와 Queue retry owner, 실제 due→claim 지연 및 경보 연결을 확정해야 한다.

## 검증 증거

| 검사 | 결과 |
|---|---|
| M1 18개 + M2 20개 + 기존 P3/Core/D1/M8/ingest-stage 회귀 | **183/183 통과**, 실패/skip 0 |
| native SQLite | 실제 schema/제약/transaction으로 응답 유실·중단·중복·lease/fence·구세대·retry/dead-letter·upgrade 경합 확인 |
| 로컬 workerd D1 API | 실제 batch/RETURNING, 발행 성공, CAS CHECK와 마지막 SQL 실패 전체 롤백 통과 |
| 루트 및 async Worker TypeScript | 둘 다 통과 |
| 변경 runtime/test ESLint | 오류 0, 기존 `authority.ts` unused `many/run` 경고 2 |
| async Worker / Core ops-write Worker Wrangler dry-run | 둘 다 번들 빌드 통과; Core 검사는 Production binding 없는 임시 config 사용 후 삭제 |
| CRLF를 인정하는 diff whitespace 검사 | 통과 |

실행 결과·명령·현재 코드 SHA-256: [verification.json](C:/Users/jaeth/.codex/worktrees/e2e-p0-m1/worldcons/artifacts/e2e-p0-m2/verification.json). [전체 회귀 로그](C:/Users/jaeth/.codex/worktrees/e2e-p0-m1/worldcons/artifacts/e2e-p0-m2/regression-tests.log), [현재 코드 diff](C:/Users/jaeth/.codex/worktrees/e2e-p0-m1/worldcons/artifacts/e2e-p0-m2/implementation-from-main.diff). diff는 기준 main 대비 **누적 M1+M2**다. 당시 M1 단독 diff는 기존 M1 artifact에 보존했다.

Production read/write·migration·배포 증거는 없으며 실제 신규 판례의 `completed_verified` 증거도 없다. 테스트에서 Consumer의 완료 전환을 주입한 것은 늦은 dispatcher가 이를 덮어쓰지 않는지 확인하는 fixture다. 기존 incident Production JSON을 이번 M2 증거로 재사용하지 않았다.

## 다음 코드 단계

| 확인된 기존 진입점 | M3–M5에서 필요한 보호 |
|---|---|
| `applySearchProjectionPlan()` | 모든 Search/FTS batch의 세대 guard·fence CAS와 원자성 |
| `runNativeSearchProjectionSync()` | 페이지별 오래된 snapshot upsert와 마지막 비적격 삭제 차단 |
| `syncSearchProjectionForArticle()` | 관리자 단건 수정/재투영, staged 단건 작업의 공통 보호 |
| `workers/async-pipeline/src/index.ts`의 publication/translation/search sync | 기존 M8 workflow와 신규 Consumer의 cohort 소유권 통제 |
| `app/api/admin/work/[kind]/[id]/route.ts` | 관리자 수정·철회 뒤 직접 Search sync 경로 통합 |
| `lib/backfill/d1-repository.ts`의 v4 head 쓰기, Core opt-out 발행 및 hard delete | Catalog/legacy writer와 세대 head의 충돌 방지; 해당 cohort에서 통합 또는 쓰기 중지 |
| 공개 검색/상세/cache 경로 | 결과 ID를 묶어 Core 최신 세대/공개 자격 확인, 실패 시 과거 결과 노출 금지, 세대별 캐시 무효화 |

M3는 보호 Consumer·Search CAS/tombstone·기존 writer·공개 읽기 검사를 함께 구현해야 한다. M4는 저장 Search/FTS와 실제 API 검증, 현재 세대/fence 조건의 완료 기록 및 정상 신규 FR/ES 판례 무인 실증을 수행해야 한다. 그 증거가 있을 때 M1–M4 첫 E2E 단위를 완료로 판정할 수 있다. 전체 P0 종료에는 M5 모든 writer 확대와 계획의 운영 관측 기준이 남는다.
