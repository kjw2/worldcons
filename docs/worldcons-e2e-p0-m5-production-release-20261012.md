# WorldCons E2E P0 M5 구현·운영 검증 기록 — 2026-10-12

판정: **구현·운영 배포 진행, P0 미종료**. 실제 코드와 Production 증거를 기록한다. 계획 승인, 테스트 통과, 과거 작업 성공을 전체 P0 완료로 대체하지 않는다.

## 구현 결과

- Discovery가 제한된 공식 목록 창에서 관측한 후보 전체를 R2 manifest와 Ingest 원장에 먼저 고정하고, 재시작 가능한 예약 작업으로 Crawl에 연결한다. 한 번의 처리 한도 밖 후보를 성공 처리로 버리지 않는다.
- FR/ES source ownership 정책과 Core D1 가드가 첫 발행 및 기존 head 변경을 보호한다. 승인 snapshot, P3 transition, generation, Search outbox는 같은 Core batch에서 CAS로 결합한다. 시간·AI 회계 정보만 변한 재처리는 승인 해시와 기존 P3 콘텐츠 해시의 역할을 구분한다.
- 사람 승인은 관리자 세션의 실제 주체, 전체 원문·요약 preview와 정확한 snapshot hash를 요구한다. 비공개 제거 권한은 콘텐츠·법률 의미 승인으로 취급하지 않는다.
- 신규 Consumer 외에도 단일 Search sync, 전수 sync, 관리자 갱신·철회 경로에 현재 세대, receipt, 실제 저장 fingerprint와 tombstone 검사를 적용했다. 완료 후 물리 손상은 기존 콘텐츠 버전을 보존하고 별도 수리·검증 epoch로 처리한다.
- 스페인 HJ URL의 언어·ACTION alias를 같은 공식 사건 identity로 정규화하고 가장 오래된 Core 소유자를 재사용한다. 공식 제목·본문이 일치하는 사건번호 보완은 기존 QA·출처 검증·Core CAS를 유지한다. 긴 LIKE 패턴은 literal prefix instr 검사로 교체했다.
- 실제 workerd fetch의 redirect 옵션, Root service binding URI와 cold R2 초기화를 수정했다. 검증 증거는 내부 provider binding과 외부 공개 HTTP 검사를 구분한다. verifier backoff/lease를 존중해 중복 Queue 재전달 폭주를 줄였다.
- verifier redrive는 Core 0010 원장에 이전 실패·예산·fence를 보존한 뒤 현재 승인 세대만 재개한다. 과거 완료 증거를 덮어쓰거나 새 콘텐츠 승인을 만들지 않는다.
- 최종 검사에서 발견한 공유 태그 이름 덮어쓰기 경로를 수정했다. D1 요약 작업은 기존 slug의 이름·정규화명·유형을 보존하고 링크만 연결한다. 신규 태그 생성과 별도 집계 갱신은 유지한다. 과거 태그 의미의 정확성을 재승인했다는 뜻은 아니다.

## 검사·배포

최종 검사 결과와 Root/Async Worker 버전은 아래 자동 고정 구간에 기록한다.

- pnpm verify:release: exit 0, 총 1,658건 / 통과 1,651건 / 실패 0건 / PostgreSQL 환경 의존 skip 7건. post-build typecheck와 Async pin 타입 검사도 exit 0.
- Root source SHA: d9f8e1bf2f1494705bdf1a4d18ca5347d98c0d95; Worker version: 8f5b1d18-b92d-421d-9f8c-962be214bda1; 100% 배포: 2026-10-12T07:41:41.12743Z.
- Async source SHA: c35bb37e98a8c51daf3bfc50f719f0d16fa7e7b1; Worker version: ae506de6-7698-47f5-af71-b8b551d0d378; 100% 배포: 2026-10-12T07:42:30.489035Z.
- verifier deploymentRef: git:d9f8e1bf2f1494705bdf1a4d18ca5347d98c0d95;worldcons:8f5b1d18-b92d-421d-9f8c-962be214bda1.
- 최소 48시간 관측 경계: **2026-10-14 16:42:30 KST** (2026-10-14T07:42:30.489Z). 두 번의 일일 Discovery 주기와 다른 종료 조건도 별도로 통과해야 한다.
- 코드 및 pin 커밋은 main과 codex/e2e-p0-m1에 atomic fast-forward push했다. 보고서·증거는 후속 기록 커밋에 포함한다.


검사는 실제 Vinext 빌드와 Worker 타입 검사까지 포함한다. 기본 Next/Turbopack의 작업 트리 junction 빌드 문제가 해결됐다고 주장하지 않는다. 환경 의존 PostgreSQL 검사는 실행된 회귀 검사와 구분한다.

FR/ES 정책 required=1, staged approval·Search dispatch/consumer/verifier를 활성화했다. M8 크롤러는 FR/ES를 제외하고 DE/US 기존 소유권을 유지한다. E2E Search Queue concurrency는 2, 다른 Queue는 1이다. Catalog public/search/plugin 플래그는 false다. Core 0009·0010, Ingest 0005는 additive migration이며 과거 원장은 보존한다.

## 실제 Production 관측

- ES SENTENCIA 55/2026: article 4c80e563-7dbc-4db1-8101-34d14adbe1fb, completed_verified 2026-10-12T05:48:32.851Z.
- ES AUTO 53/2026: article f2d0716e-c7d6-4f0b-9e3f-90c7289fd7cb, completed_verified 2026-10-12T06:02:30.365Z.
- ES SENTENCIA 56/2026: article cbe99053-ee25-4596-93bf-b949b10d0bdc, completed_verified 2026-10-12T06:16:41.428Z.
- 중복 alias 11건을 정식 철회했다. withdrawal_verified 중 1건은 operator diagnostic, 10건은 Queue 실행 증거다. 원래 소유자와 과거 immutable P3 버전은 보존했다.
- 공개 상세·정확한 article 검색의 외부 HTTP 응답도 확인했다. 내부 verifier proof의 transport는 root-public-provider-service-binding이며 외부 네트워크 HTTP 검증과 동일하다고 표현하지 않는다.
- 실제 source→Core→승인→P3→Search 계보를 저장했다. 기존 오류 작업 5건 redrive, normalize prefix 오류 복구, AUTO 53 publish dispatcher 1회 수동 실행, verifier 복구가 포함됐다. **전체 기간의 완전 무인 일일 체인 실증으로 인정하지 않는다.**
- Discovery FR 창은 관측 10/기록 10/기존 처리 10, ES 창은 관측 167/기록 167/예약 115/기존 처리 52/미예약 0이다. 115건은 URL alias를 포함한 예약 수이며 신규 판례 수가 아니다. 국가 전체 역사 corpus coverage는 false다.
- Core 최신 참조 검사에서 published head 1,501, 누락 article/version 0, legacy freshness 누락·비현재 0을 확인했다. 그중 DE Catalog 공개 head 1건은 legacy 일반 Search 적격 집합에서 제외된다. 제외의 의미·정책 승인 검토는 별도 종료 과제로 남긴다.

- 최종 읽기 전용 전수 감사: 2026-10-12T07:49:36.936Z–2026-10-12T07:50:16.740Z, 적격/Search/FTS 각 **1,500건**. 누락·추가·중복·실제 저장 내용 mismatch·P3 참조 오류 모두 0건, 감사 전후 Core 입력 경계 동일, corpusVerified=true.
- CLI 프로세스 대신 SELECT만 허용하는 D1 Query API adapter를 사용했다. 선택 SQL·투영 생성·문서/FTS 논리 fingerprint·감사 전후 Core boundary 알고리즘은 원래 감사 스크립트와 같다. 복제 출처 hash와 실제 실행 파일을 증거에 저장했다.
- 이번 태그 수정 후 마지막 정식 full sync는 legacy 문서 53건을 갱신했고, 보호 세대는 별도 guarded 경로로 처리했다. 앞선 시간 제한 중단도 실패/중단 기록으로 보존했다.
- 실제 판례는 3건이다. 해당 판례들의 metadata refresh 세대 3건까지 포함해 completed_verified 역사 원장은 6건이며, 신규 판례 6건으로 집계하지 않는다. 현재 head 3건은 모두 최종 Root 참조로 2026-10-12T07:44:34.735Z–07:44:50.541Z에 Queue 검증됐다. withdrawal_verified 11건과 합쳐 verification job/outbox 17건이 verified다.
- raw Core/P3 차이는 **13건**이다. 이는 승인 최신 콘텐츠 drift 13건이라는 뜻이 아니며, 기존 미해결 3건과 진행 중 초안 차이를 검토 원장·lineage에 연결해 분류해야 한다. Search 일치만으로 이 차이를 해결했다고 보고하지 않는다.
- tag-final-external-public-probes.json: AUTO 53 상세와 검색 모두 HTTP 200이며 정확한 article ID가 포함된다. 이전 FR L 후검사와 관리자 preview 미인증 401/private no-store 검사도 별도 증거로 보존했다.


이 수치는 각각 기록된 시각의 관측이다. 작업 PC 시계는 Cloudflare HTTP Date보다 약 52–54초 뒤처져 있으므로 감사 시작·종료는 client 관측 시각이고, 완료 DB verified_at과 배포 created_on은 각 서버의 시각이다. 48시간 경계는 provider 배포 시각으로 계산했다. 서로 다른 D1 사이 전역 원자 snapshot을 보증하지 않는다. 과거 proof의 deploymentRef를 최신 배포로 소급 수정하지 않는다. CLI 인증 오류·중단된 검사도 증거에 보존하고 성공 검사와 구분한다.

## P0 종료까지 남은 조건

1. 원래 drift 3건의 공식 출처·번역 의미·안전 신호를 검토하고 필요한 정식 개정을 승인해야 한다. 현재 추가 raw Core/P3 차이는 진행 중 초안과 연결해 분류해야 한다. 미승인 내용을 P3에 복사해 drift를 0으로 만들지 않는다.
2. FR L의 공개 검색 후검사 증거는 확보했으나 실제 신규 FR 공개 가능 판례의 전체 무인 E2E 증거는 아직 없다. ES의 이번 복구를 수동 개입 없는 두 번의 일일 Discovery 주기 관측으로 대체하지 않는다.
3. Catalog 제외 의도, 모든 게시·철회·Search writer 적용, source-age 동시 경합, pending age·policy review·unresolved dead-letter를 포함한 전체 종료 조건을 확인해야 한다. source-age pre-read 보호만으로 모든 동시 쓰기 경합이 해결됐다고 주장하지 않는다.
4. 최종 runtime 배포 이후 최소 48시간 및 두 번의 일일 Discovery 주기를 관측해야 한다. 최소 시각 경과만으로 자동 종료하지 않는다. 지연·새 내용 불일치·미해결 실패가 있으면 P0를 유지한다.

새 쓰기 범위를 줄이는 롤백은 원장·pending outbox·tombstone을 보존한다. guard 없는 구버전 writer로 되돌리지 않는다. 이 기록은 Codex의 예약 모니터링을 생성하지 않는다.

## 증거와 재검증

[SHA-256 manifest](../artifacts/e2e-p0-m5-20261012/sha256-manifest.json)에 이 작업의 증거 파일을 고정한다. 원래 checkout의 변경과 과거 artifacts/e2e-p0-release 증거는 덮어쓰지 않았다.

주요 증거: tag-final-verification-evidence.json, production-verification-latest.json, corpus-after-tag-preservation-audit/corpus-audit.json, final-deployment.json, m5-tag-final-release-result.json, real-case-lineage.json, real-case-external-public-probes.json, source-ownership-current.json, discovery-production-final.json, duplicate-removal-result.json, verifier-runtime-recovery.json, closure-core-after-auth-refresh.json, catalog-excluded-current.json, 최종 배포 및 코퍼스 검사 파일. Operator 스크립트는 당시 fence·계획을 고정한 실행 기록이며 현재 상태에 무조건 재실행하는 도구가 아니다.

코퍼스 읽기 전용 재검증은 최신 작업 트리에서 실행하고 **새 output-dir**을 지정한다.

```powershell
pnpm exec tsx scripts/audit-e2e-p0-production.ts --output-dir=artifacts/e2e-p0-observation-YYYYMMDD-HHMM
```

진짜 종료 판정은 계획 문서 7.2절의 모든 조건과 해당 시각의 운영 증거를 함께 확인한다.
