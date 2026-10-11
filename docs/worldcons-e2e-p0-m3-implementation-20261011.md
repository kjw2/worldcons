# WorldCons E2E-P0/M3 구현 및 로컬 검증 — 2026-10-11

M3의 Search Consumer, 세대/CAS/철회 보호, 기존 Search 쓰기 경로 방어와 공개 읽기 최신성 보호를 실제 코드로 구현했다. 회귀 439건, 루트·Async 타입 검사, lint, Async·Core·공개 Search Worker dry-run 빌드가 통과했다.

판정은 **M3 코드 구현·로컬 검증 완료, 운영 활성화 미완료, M4 미구현, P0 종료 불가**다. Search 적용 영수증은 completed_verified 증거가 아니다. Production 배포·migration 적용·신규 판례 처리 실증은 수행하지 않았다.

## 작업 위치와 보존

- 작업 트리: C:/Users/jaeth/.codex/worktrees/e2e-p0-m1/worldcons
- 브랜치: codex/e2e-p0-m1
- 기준 main: a415860362877bafef579cab0c18133dcdb877d3; 종료 시 원격 main도 동일함을 읽기로 확인했다.
- M1/M2 미커밋 구현을 이어서 수정했다. 커밋과 push는 하지 않았다.
- F:/dev/worldcons의 기존 변경, 승인 계획 및 incident JSON을 보존했다. 계획 SHA-256과 증거 SHA-256은 M2와 동일하며, M2 artifact의 기존 해시도 모두 일치한다.
- 기존 M1/M2 보고서·검증 JSON은 역사적 기록으로 유지했다. 아래 결과는 M3 현재 코드에 대한 별도 검증이다.

## 실제 변경

### Search 적용과 Consumer 소유권

Search 0002 migration과 search-generation-guard.ts는 article별 generation_seq, 승인된 P3/pub identity, policy/input hash, fencing token을 함께 확인한다. CHECK 실패가 동일 Search D1 batch를 중단하며 guard 갱신, 문서/FTS 교체, 임시 authorization 제거를 모두 롤백한다. 낮은 세대, 낮은 fence, 같은 세대의 다른 identity는 쓸 수 없다. 철회는 문서/FTS를 삭제하고 tombstone을 남긴다.

Core 0006 migration은 e2e_search_apply_receipts_v1을 추가한다. search-repair-consumer.ts는 현재 Core 세대와 승인 snapshot을 확인하고, 실제 처리 owner만 300초 lease·새 fence·attempt를 얻는다. Search 실제 문서와 FTS의 모든 투영 필드를 다시 해시하여 readback을 검증한다. Core 영수증/진행 상태/outbox 해제도 현재 publication·P3·세대·태그·review 상태 및 살아 있는 owner를 CHECK하는 단일 batch다.

Search commit 직후 Core 영수증 쓰기가 중단돼도 재전달로 복구한다. 이미 적용된 영수증과 실제 Search가 같으면 추가 attempt나 P3 revision 없이 중복을 처리한다. 실제 처리 실패는 지수 backoff와 최대 8회/최초 실패 이후 120분 예산을 사용한다. 최종 attempt에서 Worker가 중단된 경우에도 만료된 owner를 fence하고 dead-letter로 정리한다. 이 단계는 search_pending/awaiting_verification에서 멈추며 verified/completed_verified를 쓰지 않는다.

Async Worker에 별도 worldcons-e2e-search-repair Queue 분기를 연결했다. WORLDCONS_E2E_SEARCH_CONSUMER_ENABLED=true일 때만 실행하며, Core 영수증/ Search guard schema 및 3개 document 방어 trigger가 준비되어야 한다. ACK는 Search 적용 영수증의 의미이고 E2E 완료의 의미가 아니다.

### 기존 writer 경로

applySearchProjectionPlan은 각 batch의 첫 SQL에서 보호 Article과 충돌하는 문서·FTS 쓰기를 차단한다. 보호 schema가 있으면 guard/cleanup을 포함해 100개 statement/parameter 범위를 지키도록 batch를 줄인다.

runNativeSearchProjectionSync는 Core 관리 세대를 기존 writer에서 제외하고, stale 제거 직전 새로 관리 세대에 들어온 Article도 다시 확인한다. syncSearchProjectionForArticle은 관리 Article을 fail-closed 처리해 Consumer가 담당하게 한다. staged/M8/admin 경로 중 이 공통 함수들을 호출하는 경로도 같은 방어를 거친다. 보호 Article이 아직 Search에 반영되지 않았거나 동기화 도중 원본이 바뀌면 기존 전수 count 검증은 실패할 수 있다. 이를 정상 완료로 숨기지 않는다.

Persisted trigger는 보호 Article의 raw search_documents INSERT/UPDATE/DELETE도 막는다. **FTS virtual table에는 trigger를 걸 수 없으므로, 구 Worker나 외부 raw SQL의 FTS-only 쓰기까지 DB trigger로 막았다고 주장하지 않는다.** 운영 활성화 전 해당 cohort에서 구 writer를 중지하거나 호환 코드로 배포해야 한다. 모든 Core/Catalog/삭제 writer의 inventory와 롤백 검증은 M5에 남아 있다.

Migration 도구의 sqlite_master 검증에 trigger 타입을 추가했다. Search 0002의 authorization table과 3개 trigger를 verify directive로 명시해, 테이블만 존재하고 trigger가 빠진 배포를 적용 완료로 판정하지 않는다.

### 공개 읽기와 캐시

public-freshness.ts는 결과 ID를 최대 80개씩 묶어 Core 현재 세대/동적 eligibility와 Search guard/fence를 비교한다. Core B/Search A, 철회, review/tag drift, Core 장애는 fail-closed다. Search 조회 도중 최초 enrollment나 세대 변경이 발생하는 경우도 Core 재조회로 확인한다. 결과별 Core HTTP 요청은 사용하지 않는다.

공개 provider, cclmetasearch, 일반 ranked/exact 검색 및 검색 결과 hydration 이후에 검사를 연결했다. Core 상세·목록·원문·top-viewed·sitemap과 provider hydration은 보호 Article의 승인된 immutable P3를 사용하며 mutable draft로 덮어쓰지 않는다. P3 JSON을 기존 read mapper와 같은 객체 형식으로 복원하고, version hydration 도중 세대가 바뀐 행은 내보내지 않는다.

공개 API 응답을 no-store로 바꾸고, 홈페이지/목록 및 관련 API의 unstable_cache를 freshnessAwarePublicCache로 연결했다. Core 세대 schema가 존재하면 content cache를 우회한다. schema 여부와 eligibility는 장기 캐시하지 않으며 Core 부재/장애에서 기존 캐시로 fallback하지 않는다. 기존 tag invalidation은 유지한다.

이 캐시 정책은 현재 보수적으로 전체 공개 읽기에 영향을 준다. Production latency/비용은 측정하지 않았으므로 cohort별 최적화와 성능 예산 확인은 활성화 검증에 남는다. 두 D1 사이 전역 트랜잭션/linearizable 읽기를 보장하지 않는다. 현재 세대 비교와 fail-closed 재확인으로 알려진 지연 구간을 방어한다.

## 검증 결과

| 검증 | 결과 | 증거 |
| --- | --- | --- |
| M1/M2/M3 및 기존 발행·수집·검색·공개 경로 회귀 | 439/439, 실패·skip 0 | artifacts/e2e-p0-m3/regression-tests.log |
| M3 신규 테스트 | 25/25, 그중 실제 local D1 runtime 1건 | 같은 로그 |
| Root TypeScript | exit 0 | root-typecheck.log |
| Async Worker TypeScript | exit 0 | async-typecheck.log |
| 변경 TS/TSX lint | 오류 0, 기존 unused 경고 3 | lint.log |
| Async Worker Wrangler dry-run | exit 0 | async-build.log |
| Core write Worker dry-run | exit 0 | core-build.log |
| 공개 Search service dry-run | exit 0 | public-search-build.log |
| Git whitespace | exit 0 | diff-check.log |

Node SQLite 테스트는 실제 migration, CHECK, trigger, 트랜잭션과 RETURNING을 실행했다. Wrangler에 포함된 Miniflare/workerd 테스트는 독립된 Core/Search local D1 API를 사용해 발행→Consumer→Search/FTS/영수증→공개 최신성 검사→철회/tombstone을 실행했다. provider 응답의 200/no-store, 미승인 초안 배제, 세대 차이 503, 철회 상세 404도 실행해 검증했다. 실제 D1 API 테스트와 SQLite provider 응답 테스트는 구분하며, Production 실행으로 해석하지 않는다.

기존 API 테스트의 cache header를 새 계약에 맞춰 변경했다. P3 조회 fake의 테이블 이름 파서가 숫자를 제외하던 문제와 빠진 publication fixture를 수정했다. 쿼리 수 검사는 Search retrieval과 최신성 확인을 구분하고 bounded 호출 검사를 유지했다.

React 체크리스트 적용 범위는 app/page.tsx와 app/list/page.tsx의 서버 캐시 import 교체다. 새 client component/hook/state를 도입하지 않았고 기존 병렬 fetching/Suspense 흐름을 유지했다. freshness 확인 비용과 cache 우회는 위에 명시한 운영 측정 대상이다.

검증은 pnpm verify:release 전체 실행 또는 Next/vinext 전체 사이트 production build를 뜻하지 않는다. 필요한 회귀 집합, 타입 검사와 3개 Worker 번들을 실행했다.

## Diff와 기계 판독 증거

artifacts/e2e-p0-m3/implementation-m3-only.diff는 보존된 M2 diff로 재구성한 임시 index를 기준으로 만든 **M3 단계만의 코드 diff**다. 실제 작업 index와 branch/ref는 변경하지 않았다.

artifacts/e2e-p0-m3/implementation-from-main.diff는 기준 main부터 현재까지의 **누적 M1+M2+M3 코드 diff**다. 보고서와 artifact 자체는 제외했다. M2 시점 diff는 artifacts/e2e-p0-m2/implementation-from-main.diff에 보존되어 있어 단계 간 변경을 대조할 수 있다.

artifacts/e2e-p0-m3/verification.json에 실행 명령, 결과, 코드/artifact SHA-256, 원본 보존 상태, 운영 활성화 여부를 기록했다. 로그와 코드 diff는 로컬 증거이며 이전 incident Production JSON을 이번 실행 증거로 재사용하지 않았다.

## 남은 실행 범위

1. M4: API/FTS/콘텐츠 최종 verifier, 검증 owner/fence와 현재 세대 조건부 completed_verified, 새 FR/ES 정상 판례의 Discovery부터 무인 처리 실증을 구현한다.
2. 운영 준비: dedicated Queue producer/consumer/DLQ binding을 provision하고, Consumer/read guards 호환 배포를 먼저 확인한 뒤 Dispatcher를 활성화한다. 현재 Wrangler 설정·Production flags는 변경하지 않았다.
3. 최초 60초 재시도는 durable next_attempt_at 계약이다. 기존 15분 cron만으로 실제 60초 dispatch를 보장하지 않는다. Queue/cadence, 외부 경보, dead-letter 점검·redrive를 운영 경로에 연결해야 한다.
4. 롤백: 보호 cohort에 구 document/FTS writer를 다시 투입하지 않는다. enqueue gate를 닫고 outbox/guards/tombstone을 유지한 채 호환 Consumer/read 경로로 복구한다. 외부 raw FTS-only writer까지 중지됐는지 별도 inventory 증거가 필요하다.
5. M5: 모든 게시 경로 확대, Core/Catalog/수동/삭제 writer 전수 점검, 운영 관측 48시간·최소 2개 daily cycle과 P0 종료 기준을 검증한다.

현재 Production deployed=false, migrationsApplied=false, cohortActivated=false, completedVerifiedEvidence=null, p0Closed=false다.
