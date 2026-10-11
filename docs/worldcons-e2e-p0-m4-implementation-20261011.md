# WorldCons E2E-P0/M4 구현 및 로컬 E2E 검증 — 2026-10-11

M4의 승인 증거, 최종 검증기, staged 경로 연결을 실제 코드로 구현했다. 합성 신규 프랑스 판례가 Discovery → Crawl → Normalize → Translate → Public Judgment → P3 Publish → Search/FTS → 공개 API 검증 → `completed_verified`까지 진행했다. 별도 workerd 테스트에서는 실제 공개 Search Worker 번들과 분리된 로컬 Core/Search D1 API를 사용했다.

**판정: M4 코드와 로컬 검증 완료. 운영 M1–M4 첫 cohort 완료는 아직 미충족. Production 미배포, 신규 실판례 무인 처리 증거 없음, P0 종료 불가.**

## 1. 기준과 변경 범위

- 작업 트리: `C:/Users/jaeth/.codex/worktrees/e2e-p0-m1/worldcons`
- 브랜치: `codex/e2e-p0-m1`
- 기준 커밋: `a415860362877bafef579cab0c18133dcdb877d3`
- 이번 단계에서 `git ls-remote origin refs/heads/main`으로 동일 원격 main을 재확인했다.
- M4 코드 diff: [implementation-m4-only.diff](../artifacts/e2e-p0-m4/implementation-m4-only.diff), 21개 파일, 884줄 추가·40줄 삭제.
- M1–M4 누적 diff: [implementation-from-main.diff](../artifacts/e2e-p0-m4/implementation-from-main.diff).
- 커밋·push·원격 migration 적용·Worker 배포·Queue provisioning·Production API 호출을 수행하지 않았다. Wrangler 실행은 모두 `--dry-run`이다.

M4-only diff는 별도의 임시 bare 저장소와 읽기 전용 object alternate로 재구성했다. 기준 main에 보존된 M3 누적 patch와 M4-only patch를 적용한 결과가 현재 코드와 일치함을 확인했다. 이 과정에서 공유 Git index는 변경되지 않았다.

## 2. 구현한 동작

### 승인 당시 원문과 콘텐츠 증거

Core migration `0007_e2e_verification.sql`에 승인 증거, 검증 작업, 검증 완료 증거 테이블을 추가했다. Production에는 적용하지 않았다.

`recordAutomaticApproval()`은 FR/ES 공식 호스트, 수집 원문과 저장 본문의 일치, 공개 가능 수집 신호, 처리·번역 완료, 한국어 요약 스키마와 위험 신호, 검토 차단 상태, 후보 사건번호를 확인한다. 승인 증거에 후보 ID, public-judgment 작업 ID, 원문 아티팩트 참조·해시와 승인 콘텐츠 해시를 함께 보존한다. 위험 신호나 비공개·검토 상태가 있으면 자동 발행하지 않는다.

정책은 `worldcons.fr-es-staged-approval.v1`이다. 이 정책의 P3 발행은 기존 Core authority의 최초 CHECK에서 정확히 대응하는 승인 증거를 요구한다. 기존 P3 버전 해시 동작은 유지하고, 같은 콘텐츠의 시간 필드 변경은 승인 proof·P3 버전·generation을 재사용한다.

보호 cohort의 crawl 아티팩트 키는 전체 JSON의 canonical hash를 사용한다. 같은 본문이라도 `fetchedAt`이 바뀌면 별도 아티팩트로 보존되어, 기존 승인 증거가 참조하는 원문을 덮어쓰지 않는다. 기존 비보호 수집 경로의 키 계약은 유지했다.

이 승인은 기존 소스·요약의 정책 신호와 provenance를 확인한다. 별도의 법적 의미 평가 모델이나 실제 번역 품질 실증을 추가한 것은 아니다. 현재 최종 검증의 승인 proof 형식은 이 FR/ES 자동 승인 cohort를 대상으로 한다. 다른 정책·수동 승인 형식의 확대는 별도 구현이 필요하다.

### 실제 저장 내용과 공개 응답 검증

`verifySearchRepair()`는 다음 조건이 모두 충족되어야 완료 증거를 쓴다.

1. 현재 generation·P3·publication·정책·태그·검토 상태와 Search apply receipt가 일치한다.
2. 승인된 P3로 기대 Search 문서와 FTS를 다시 계산한다.
3. 실제 저장된 각 필드의 fingerprint를 다시 계산하고 해당 Article의 문서/FTS 집합을 확인한다. 공개 상태는 1/1, 철회 상태는 0/0이어야 한다. 저장된 checksum만 신뢰하지 않는다.
4. 설정된 공개 API에서 상세·검색 응답의 Article ID, slug, 사건번호, 제목, 원본/정규 URL, detail API URL과 해당 기사 ID의 검색 포함 여부를 확인한다.
5. 상세 API의 본문 앞 4,000 code point와 요약 JSON을 승인 P3와 비교한다. API 응답이 계약대로 제공되지 않거나 요약이 잘리면 실패한다. HTTP 요청은 8초 timeout, redirect 차단, no-cache 요청, 최대 500KB stream 읽기를 사용한다.
6. API 확인 후 실제 Search 내용을 다시 읽고 Core 현재성을 재확인한다.
7. 마지막 Core batch의 CHECK가 현재 head·owner·유효 lease·검증 fence·P3 전체 저장 필드·승인 proof·태그·검토 상태·apply receipt를 다시 검사한다. 실패하면 증거·진행 상태·outbox 완료를 전부 롤백한다.

실제 workerd 테스트에서 큰 CHECK의 SQL 표현식 깊이 제한 100을 발견했다. 비교 조건을 균형 트리로 결합하고, 현재성 CHECK와 콘텐츠/proof CHECK를 같은 원자적 Core batch의 두 구문으로 분리해 해결했다. 두 D1 데이터베이스 사이에 전역 트랜잭션을 가정하지 않는다.

완료 증거에는 Article·generation·seq·P3 version/revision·publication revision·정책·적용/검증 fence·기대/실제 fingerprint·집합 건수·API URL/status/응답 해시·관측 시각·deployment reference가 포함된다. 검증 범위는 **단일 Article의 당시 상태**다. 전수 corpus 감사나 이후 상태의 연속 모니터링을 뜻하지 않는다.

공개 성공은 `completed_verified`, 철회 성공은 `withdrawal_verified`로 분리한다. 이후 개정이 발생해도 이전 완료 증거를 보존한다. 같은 generation의 공개 가능 입력이 나중에 차단되면 과거 증거를 새 처리의 완료 허가로 사용하지 않는다.

### 검증 재시도와 단계 연결

검증은 Search 적용과 별도 owner·300초 lease·fence·시도 예산을 사용한다. API 장애는 Search 재투영 시도를 소비하지 않는다. 60초부터 최대 900초까지 backoff하며 8회 또는 최초 실패 이후 120분 예산을 사용한다. 소진 시 검증 작업·outbox·진행 원장을 같은 Core batch에서 dead-letter 처리하고 dispatch lease도 철회한다. 최종 시도 중 Worker 중단 후 lease 만료도 종료 대상이다.

보호된 staged 경로는 원문 payload를 번역 이후까지 전달하고, 승인 proof → P3/generation receipt → 보호 Consumer/검증기로 연결한다. 발행은 기존 Core P3 authority를 호출한다. Search stage는 단순 적용 성공으로 완료하지 않고 최종 검증 결과를 요구한다. 전용 Search repair Queue도 검증기를 호출해 API 실패는 retry하고, 완료·중복·종료 결과를 처리한다.

E2E 보호 기능은 기본 OFF이며 Wrangler 설정은 변경하지 않았다. 활성화 설정은 다음과 같다.

| 설정 | 역할 |
| --- | --- |
| `WORLDCONS_E2E_STAGED_APPROVAL_ENABLED` | 보호 승인/P3/Search 경로 선택 |
| `WORLDCONS_E2E_STAGED_SOURCES` | FR/ES 중 명시적인 최소 cohort |
| `WORLDCONS_E2E_VERIFIER_ENABLED` | 최종 공개 API 검증 |
| `WORLDCONS_E2E_VERIFIER_API_BASE_URL` | 실제 배포의 HTTPS `/api` 또는 `/api/cclrag2` |
| `WORLDCONS_E2E_DEPLOYMENT_REF` | 검증 대상 배포를 식별하는 운영 값 |
| 기존 E2E Consumer/Dispatcher flags·전용 Queue binding | 내구성 있는 별도 Search 수리 경로 |

보호 승인 flag만 켜고 검증기를 끄거나 cohort/API/배포 식별자가 잘못되면 설정 오류로 차단한다. 보호 경로를 조용히 기존 writer로 바꾸지 않는다. Queue의 검증 schema gate는 새 테이블 3개를 확인한다.

## 3. 검증 결과

| 검사 | 결과 |
| --- | --- |
| M1–M4 및 수집·발행·Search·공개 조회 회귀 | **492/492 통과**, 실패·skip 0 |
| 그중 M4 전용 테스트 | **18건 통과** |
| 루트 TypeScript | 통과 |
| Async Worker TypeScript | 통과 |
| 변경 경로 ESLint | 오류 0, 기존 미사용 변수 경고 5 |
| Async/Core/public Search Worker Wrangler dry-run | 모두 통과 |
| diff 공백 검사 및 M4 patch 재구성 | 통과 |

M4 회귀에는 저장 문서·FTS 변조/중복/누락, HTTP 200의 잘못된 기사 정보, API 장애와 Queue 재시도, 동시 검증, lease 만료, Core batch 실패, 검증 중 개정, 마지막 CHECK 직전 P3/proof/검토 상태 변경, 철회, 위험 요약, 예산 소진, 동일 콘텐츠 재수집과 원문 아티팩트 보존을 포함한다.

- [verification.json](../artifacts/e2e-p0-m4/verification.json): 실행 명령, 코드·로그 SHA-256, 배포 상태와 보존 확인.
- [synthetic-staged-evidence.json](../artifacts/e2e-p0-m4/synthetic-staged-evidence.json): 신규 합성 FR 후보의 7개 단계·Core UUID·generation·승인 proof·완료 증거.
- [local-workerd-evidence.json](../artifacts/e2e-p0-m4/local-workerd-evidence.json): 실제 로컬 공개 Worker와 분리 D1에서 확인한 응답·기대/실제 fingerprint.

첫 증거는 공식 사이트 응답과 번역기를 fixture로 대체했고 R2는 메모리 bucket이다. 단계 핸들러·Core authority·Search·공개 provider는 실제 코드/SQL이다. 두 번째 증거는 실제 Wrangler 번들과 workerd/D1을 실행하고 로컬 Worker fetch로 HTTP 경로를 검증했다. 재시도 시험에는 제어된 시계를 사용했다. 두 증거 모두 외부 공식 사이트의 신규 실판례, 외부 LLM 번역, Production API 검증을 의미하지 않는다. ES는 승인부터 Search/공개 검증까지 확인했으며 전체 Discovery 경로 증거는 FR fixture다.

전체 release gate와 Next/Vinext Production build는 이번 단계에서 실행하지 않았다.

## 4. 보존 및 남은 운영 조건

원본 `F:/dev/worldcons`의 `app/admin/ops/page.tsx`, `scripts/ops-watchdog.ts` 미커밋 변경을 건드리지 않았다. 원본 승인 계획·기존 incident JSON의 SHA-256과 M3 보고서/아티팩트 해시가 유지됐다. 기존 M1–M3 증거를 이번 구현의 Production 검증으로 재사용하지 않았다. Orca를 사용하지 않았다.

실제 활성화 전에는 migration·호환 Worker·공개 읽기 보호를 먼저 준비하고, 과거/raw FTS-only writer를 차단하거나 호환화해야 한다. 전용 Queue/DLQ, 실제 dispatch 주기, 외부 경보와 수동 redrive, 기존 staged job/dispatcher 예산과의 운영 연동은 아직 필요하다. 현재 15분 cron으로 60초 실제 재실행 보장을 주장하지 않는다.

다음 구현 범위는 M5의 모든 발행·수정·철회·삭제 writer 및 롤백 호환성 점검이다. 제한된 실제 배포에서 정상 신규 FR/ES 판례가 사람 개입 없이 처리되고 해당 generation의 `completed_verified`가 기록돼야 M1–M4 첫 구현 단위의 운영 완료로 판정할 수 있다. 그 이후에도 전체 경로 확대와 48시간/두 일일 주기 관측 없이는 P0를 종료하지 않는다.
