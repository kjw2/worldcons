# WorldCons E2E-P0/M1 구현 결과 — 2026-10-11

판정: **M1 Core 기반 코드 구현 및 로컬 검증 통과. Production 적용·보호 cohort 활성화·E2E 실증은 미완료. P0 종료 불가.**

## 작업 기준과 보존

- 최신 원격 main `a415860362877bafef579cab0c18133dcdb877d3`에서 독립 작업 트리를 만들었다. 결과 기록 때도 원격 main이 같은 commit임을 확인했다.
- 작업 트리: `C:/Users/jaeth/.codex/worktrees/e2e-p0-m1/worldcons`, 브랜치: `codex/e2e-p0-m1`.
- 원본 `F:/dev/worldcons`의 admin 화면·watchdog 미커밋 변경, 승인된 계획 문서와 기존 read-only 증거 JSON을 수정하지 않았다. 원본 상태와 파일 SHA-256을 새 증거 JSON에 기록했다.
- 이번 변경은 미커밋 상태다. 커밋·푸시·Production migration·배포를 실행하지 않았다.

## 실제 코드 변경

| 경로 | 구현 |
|---|---|
| `lib/cloudflare/e2e/contracts.ts` | 승인 snapshot/source-text hash, approval key, 명시적 hash schema, 승인/lineage 입력 및 세대 receipt |
| `d1/worldcons_core/0004_e2e_generations.sql` | 불변 세대 identity 이력, 현재 head, 별도 진행 상태, 요청별 승인/lineage 근거, 트랜잭션 assertion table |
| `lib/cloudflare/e2e/generation-ledger.ts` | article별 정수 seq 할당, projection 입력 hash, 중복 전달 연결, 동일 Core batch용 SQL 계획 |
| `lib/cloudflare/core-write/authority.ts` | 기존 P3 발행 함수에 선택적 M1 처리 및 배치 내부 경합 방어 연결 |
| `lib/article-publication/types.ts`, `service.ts` | 선택적 `e2eApproval` 계약과 입력 검증 |
| `tests/e2e-p0-m1-generations.test.ts`, `package.json` | 실제 SQLite 검증 18개, `test:e2e-p0-m1` 및 release gate 등록 |

### 기존 P3 해시와 승인 해시 분리

기존 `content_hash`의 JSON 직렬화 및 `deterministicVersionId()` 알고리즘은 보존했다. 기존 immutable version을 재작성하거나 hash를 migration으로 바꾸지 않는다. 승인 해시는 운영 시각·오류/재시도 회계·blob 저장 위치를 제외하고, 본문·요약·제목·URL·사건 키·공개 source metadata·role/anchor 관계를 canonical JSON으로 묶는다. source-text hash v1은 schema와 정확한 cleaned text를 canonical JSON으로 해시하며, 원문 증거 참조는 별도로 저장한다.

M1 `captureLegacy`는 현재 head의 승인 snapshot hash가 동일하면 기존 버전을 재사용한다. 수집/처리 시각만 변경한 재수집에서 P3 revision·publication revision·generation seq 증가가 모두 0이다. 기존 cache outbox도 추가하지 않는다. JSON key 순서는 무시하고 배열 순서·본문 공백·Unicode 내용은 보존한다.

정책 변경은 approval key를 바꾸고 태그/review 변경은 projection input hash를 바꾼다. 이 변경들은 동일 P3 version을 유지하면서 새 세대를 만든다. projection 입력에는 정확한 P3/version/publication revision·state, 정렬한 tag 관계/값, review 값, projection/FTS 규칙 버전을 넣었다. 처리 시각만 바뀌면 이 입력도 유지된다.

### Core 배치 안에서의 경합 중단

M1 P3와 v4 head UPSERT에는 사전 관측한 `current_version_id/current_revision` 조건을 추가했다. **조건부 UPDATE의 0-row 결과만으로는 원자성을 보장하지 않는다.** 배치 첫 SQL이 article 전체 snapshot, P3/v4/publication/generation head와 정렬한 태그 snapshot의 동일성을 검사하고, 불일치하면 `e2e_commit_snapshot_match CHECK`를 위반한다. D1 batch가 전체 SQL sequence를 롤백하는 계약을 이용하며 오류는 `stale_revision`으로 반환한다. assertion row는 배치 끝에서 지워진다.

P3 version/head/publication/history/freshness, audit/request/cache outbox, 세대/head/progress/request 근거가 같은 Core batch에 들어간다. SQL 실패가 끝에서 발생해도 어느 테이블에도 부분 쓰기가 남지 않는 것을 실제 SQLite에서 확인했다. 아직 이 배치에 **Search 수리 outbox는 없다**. M2가 이 검증된 트랜잭션에 추가해야 한다.

근거: [Cloudflare D1 batch transaction 계약](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch), [D1 bound parameter 제한](https://developers.cloudflare.com/d1/platform/limits/). assertion의 bound parameter 수는 100 이하로 검사한다.

## 적용 경계와 남은 제한

- `ArticlePublicationTransitionInput.e2eApproval`를 명시한 인증된 Core 발행 호출에서만 M1이 실행된다. 기존 Core boundary/repository가 이 입력을 그대로 전달한다. 기존 stage/drain 호출과 전역 기능 설정은 활성화하지 않았다. 자동 정책 판정을 새로 발급하는 코드가 아니며 승인 owner가 제공한 mode/policy/evidence를 기록한다.
- 초기 automatic 입력은 FR/ES 공식 HTTPS host로 제한하고 source-only, 명시적 provenance 차단, 검토 차단 상태를 거부한다. 의미적 원문/번역/요약 품질 검증은 M4에서 구현해야 한다.
- Catalog role/anchor capture는 M5 소유권 검증까지 기존 owner를 유지한다. 역사적 P3 hash가 현재 head보다 이전인 경우나 legacy hash에서 누락된 semantic field(예: case_key)가 바뀌어 동일 hash로 충돌하는 경우, M1은 잘못된 snapshot을 승인하지 않고 `ineligible`로 중단한다. 관련 version 생성 경로의 확장은 후속 writer 통합 범위다.
- M1 진행 상태는 `publication_committed`까지만 기록한다. Search/FTS 기대 fingerprint와 공개 API 검증 증거는 아직 생성하지 않으며 `completed_verified`로 전환하는 코드도 없다.
- 시각 변경 재수집은 M1 Core 경로에서 새 발행/cache event를 만들지 않는다. 기존 전수 Search 동기화의 불필요한 재투영까지 막았다는 의미는 아니다. 모든 Search writer의 보호는 M3다.

## 검증 결과

| 검사 | 결과 |
|---|---|
| M1 18개 + 기존 P3/Core/D1 schema/migration 회귀 | **84/84 통과**, 실패/skip 0 |
| 프로젝트 `tsc --noEmit` | 통과 |
| 비동기 Worker 타입 검사 | 통과 |
| 변경 runtime 코드 ESLint | 오류 0; 기존 `many/run` unused 경고 2 |
| 비동기 Worker Wrangler dry-run | 번들 빌드 통과 |
| Core 발행 Worker Wrangler dry-run | 격리된 임시 local config로 번들 빌드 통과; Production binding 미설정 |
| diff whitespace 검사 | 저장소 CRLF를 인정하는 `core.whitespace=cr-at-eol` 옵션으로 통과 |

새 테스트는 mock SQL 성공값 대신 실제 SQLite schema/제약/트랜잭션을 실행한다. 같은 head를 읽은 두 전달 중 하나만 commit되고 패자는 재전달 시 기록된 세대를 반환한다. P3/v4/publication/article/tag/generation 경합과 배치 마지막 SQL 실패, 철회→동일 버전 재게시, migration 재적용 및 verify directive를 검증했다. 로컬 Node 24.15.0과 기존 dependency directory의 junction을 사용했으며 dependency/lockfile을 변경하지 않았다. Production D1 binding에서 실행한 결과는 아니다.

검증 JSON과 로그: [verification.json](C:/Users/jaeth/.codex/worktrees/e2e-p0-m1/worldcons/artifacts/e2e-p0-m1/verification.json), [회귀 테스트 로그](C:/Users/jaeth/.codex/worktrees/e2e-p0-m1/worldcons/artifacts/e2e-p0-m1/regression-tests.log), [Core 빌드 로그](C:/Users/jaeth/.codex/worktrees/e2e-p0-m1/worldcons/artifacts/e2e-p0-m1/core-build.log).

## 다음 구현 단계와 완료 판정

| 단계 | 남은 구현/실증 |
|---|---|
| M2 | 같은 Core batch에 Search repair outbox, 내구성 dispatcher, 중단/재전달·lease fencing 검증. 기존 non-M1 head writer 점검 |
| M3 | `applySearchProjectionPlan()`, `runNativeSearchProjectionSync()`, `syncSearchProjectionForArticle()` 모두에 seq/CAS/tombstone 보호. 오래된 전수 snapshot의 overwrite/remove 차단. 공개 latest-head batch 조회 및 cache 무효화 |
| M4 | 승인/P3/Search/FTS 논리 필드 및 실제 공개 API validator. 현재 세대 조건으로 완료 기록. 정상 신규 판례의 무인 Discovery→Search/FTS 실증 |
| M5 | 모든 발행/수정/철회 writer와 cohort로 확대; 구 Worker 및 롤백 차단; 48시간 및 2회 일일 주기 관측 |

M1–M4 보호 cohort에서 실제 신규 판례가 `completed_verified`를 남기는 증거가 있어야 첫 E2E 구현 단위가 완료된다. 이번 결과는 그 기준을 충족하지 않는다. 과거 incident JSON의 Production SELECT 결과를 이번 M1 배포/검증 증거로 재사용하지 않았다.
