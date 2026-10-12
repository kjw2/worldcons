# WorldCons E2E P0 M5 종료 검증 — 2026-10-12

**판정: M5 불합격, P0 미종료.** 검증을 실제 실행했고, 통과 항목과 종료를 막는 세 가지 결함을 구분한다. Production 조회는 읽기 전용이며 데이터 수정·redrive·Worker 재배포는 하지 않았다.

검토 source SHA: af72c27d2edcb76b163cce88f489b8cf99861645. 이 보고서와 증거를 추가하는 커밋은 실행 코드 변경이 아니다. 새 증거 디렉터리는 [artifacts/e2e-p0-m5-verification-20261012-091629129](../artifacts/e2e-p0-m5-verification-20261012-091629129/README.md)이며, 과거 배포·감사 증거는 보존했다.

## 통과한 검사

- M1–M5 및 staged/ownership/summary 보호 회귀 **131건 통과, 실패 0, skip 0**. 실제 workerd/D1 fixture의 CAS·역순·철회·중단/중복·P3/outbox 원자성 검사를 포함한다. 이는 아래 새 경합 재현의 실패를 상쇄하지 않는다.
- 검증 산출물을 포함한 typecheck exit 0.
- Core/Search/Ingest migration의 e2e/discovery **54개 테이블·트리거·필수 SQL 조건이 Production에 실제 적용**돼 있다.
- Core 공개 head 1,501건의 article/version 참조 오류와 legacy freshness 누락·비현재 0. Search 적격 집합은 Catalog 제외 1건 때문에 1,500건이다.
- Search 적격/Search 문서/FTS 각각 1,500건. 누락·추가·중복 0, 감사 전후 Core 입력 경계 동일. **내용 일치는 실패했다.**
- 관측한 Core/Search generation identity는 일치하고, 별도 현재 generation 입력 검사 20건은 identity/input 불일치 0이다. 서로 다른 시각의 조회를 단일 전역 snapshot으로 합치지 않는다.
- FR Discovery 관측 10/기록 10, ES 167/기록 167. 미예약 후보와 orphaned 예약 0. 이는 제한된 공식 목록 창의 보장이고 국가 전체 corpus coverage나 일일 2회 관측 증거가 아니다.

## 결함 1 — 세대 없는 기존 공개 문서의 메타데이터 수리 누락

읽기 전용 전수 감사 2026-10-12T09:19:28.539Z–2026-10-12T09:20:11.374Z에서 **내용 mismatch 5건**을 확인했다. 모두 ES의 기존 공개 Article이며 generation head가 없다. 각 Search/FTS의 tags_text가 현재 적격 입력과 다르고, 세 건은 review_state도 다르다. 실제 문서 checksum 재계산과 FTS 필드 비교로 검출했으며 ID 수량만 비교한 결과가 아니다.

- AUTO 50/2026: 1bb21d1a-abb5-4585-a6ad-e2dd5dbbe20f
- AUTO 26/2026: 8ba82d90-0f28-4731-963b-760805af100d
- AUTO 45/2026: 8f70d967-250d-4935-858f-5b91304b709f
- SENTENCIA 41/2026: dfb04619-3a7f-4b82-8405-24d171b2abd3
- SENTENCIA 35/2026: eccd7fae-7606-42e0-808a-2ade103ca0c9

공유 태그 이름 덮어쓰기를 막는 이전 수정은 통과했지만, 같은 Article의 draft 번역·검토 메타데이터 변경까지 내구성 있는 수리 예약에 연결된 것은 아니다. protected generation 경로의 정상 동작으로 legacy 문서 수리 누락을 해결했다고 볼 수 없다. 승인된 공개 metadata와 draft metadata의 적용 시점, 해당 변경의 durable repair 예약을 정리한 뒤 재검증해야 한다.

## 결함 2 — 공개 API URL 정규화와 verifier 계약 충돌

운영 원장 조회 시점 Mon, 12 Oct 2026 09:22:47 GMT에 신규 세대 5건이 e2e.api_identity_mismatch로 완료되지 못했다. 그중 **dead-letter 1건, retry_wait 4건**이었다. Source/P3 identity와 물리 Search 적용은 유지돼 있지만 completed_verified를 새로 기록하지 못했다.

대상은 SENTENCIA 38/2026, AUTO 37/2026, SENTENCIA 32/2026, SENTENCIA 51/2026, SENTENCIA 33/2026이다. 실제 외부 상세·검색 HTTP는 모두 200이며 동일 Article, 승인 원문 앞 4,000자와 summaryJson까지 일치했다. 실패 필드는 originalUrl이다.

예: 승인 P3는 /HJ/es/Resolucion/Show/32114?ACTION=disposiciones-generales-y-resoluciones-impugnadas, 공개 API는 /HJ/es/Resolucion/Show/32114를 반환한다. checkItem()은 두 문자열의 완전 일치를 요구한다. 공식 HJ alias 정규화 정책과 verifier 계약을 일치시켜야 한다. ID·version·본문·요약 검사나 검증 실패 예산을 제거해서 해결하지 않는다. 수정 후 dead-letter는 기존 실패 원장을 보존하는 정식 redrive가 필요하다.

## 결함 3 — source-age 사전 조회와 쓰기 사이 경합

persistNativeStageRecord()의 실제 SQL을 격리 SQLite fixture에서 실행했다. ES source ownership required=1과 Core 0008/0009 가드를 활성화한 상태로, 사전 조회 후 다른 Worker가 더 최신 fetched_at과 콘텐츠를 저장하는 상황을 주입했다.

- 같은 콘텐츠: 최신 02:00 수집을 늦은 01:00 작업이 덮어썼다.
- 변경 콘텐츠: 최신 콘텐츠·제목·hash를 늦은 이전 원문이 덮어썼다.

**두 시나리오 모두 계약 실패, 재현 프로세스 exit 1.** 기존 131개 회귀 검사에는 이 경합을 막는 검사가 없었다. 현재 UPDATE는 WHERE id만 확인한다. source-age/head 예상값을 쓰기 시점에 조건부 검증하고, CAS 실패·영향 행 수·관련 lifecycle 처리도 함께 확인해야 한다. 이 재현은 Production에서 덮어쓰기를 실행했거나 실제 사고가 발생했다는 증거가 아니다.

## Writer 범위와 남은 종료 조건

[writer-inventory.json](../artifacts/e2e-p0-m5-verification-20261012-091629129/writer-inventory.json)에 게시·철회·관리자·Root Ops 서비스·staged·M8·단일/전수 Search sync·정규화·tag/review·유지보수 경로를 기록했다. 관리되는 새 세대의 방어는 통과했지만 위 메타데이터·source-age 경합 때문에 미보호 경로 0 판정은 불가하다.

원장 조회 당시 FR 공개 395건 중 managed 0, ES 공개 426건 중 managed 8이다. 이후 처리 중 현재 head 수가 증가했다. source policy는 미래 FR/ES 게시 head 쓰기를 보호하지만 기존 공개 문서 전체가 generation을 갖거나 metadata 수리가 예약됐다는 뜻은 아니다. DE/US는 이번 자동 승인 cohort로 일반화하지 않는다. Catalog의 비활성 scope와 제외 의도도 전수 종료 승인으로 취급하지 않는다.

raw Core/P3 차이 **12건**은 추가 검토·진행 중 draft와 연결해 분류해야 한다. 원래 세 건의 출처·번역 의미·안전 신호 검토가 완료됐다고 주장하지 않는다. FR 신규 무인 전체 E2E 증거도 없다.

최종 runtime은 Root 8f5b1d18-b92d-421d-9f8c-962be214bda1와 Async ae506de6-7698-47f5-af71-b8b551d0d378, 각각 100%다. Ops dispatcher는 Root 내부 서비스이며 별도 Ops Worker config가 존재하지 않는다. 잘못된 config를 조회한 실패는 운영 서비스 장애로 집계하지 않았다.

최종 runtime 이후 관측은 원장 서버 시각 기준 약 100.3분이며, 이후 성공 Discovery 주기는 FR/ES 각각 0회다. 최소 48시간 경계는 **2026-10-14 16:42:30 KST**다. 시간 경과와 별개로 세 결함·콘텐츠 검토·FR 무인 체인·일일 2회 관측을 통과해야 한다. 후속 수정 배포 시 새 관측 경계를 다시 고정해야 한다.

## 증거 해석

처음 corpus 감사는 만료 인증으로 실패했고, 인증 갱신 후 별도 디렉터리에서 재실행해 실제 내용 불일치를 확인했다. CLI regex/config 조회 오류와 초기 실패 로그도 보존했다. 작업 PC 시계는 provider HTTP Date와 차이가 있으므로 DB 원장·배포 시각은 각 서버 출처를 사용했다.

[SHA-256 manifest](../artifacts/e2e-p0-m5-verification-20261012-091629129/sha256-manifest.json)는 이 검증의 파일과 보고서를 고정한다. **이 보고서의 완료는 검증 수행 완료이며 M5 구현 완료나 P0 종료가 아니다.**
