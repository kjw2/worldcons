# WorldCons E2E P0 M5 수정·배포 — 2026-10-12

기준: 원격 main e797b8bc06cf5f51551efa2dbd709293bc766d78. 이전 실패 증거는 artifacts/e2e-p0-m5-verification-20261012-091629129에 그대로 보존한다. 이번 코드와 운영 증거는 artifacts/e2e-p0-m5-fix-deploy-20261012112148857에 저장한다.

## 수정 계약

- 수집: articles의 fetched_at/content_hash/source_metadata/updated_at/review_state/status와 lifecycle_revision을 쓰기 시점에 비교한다. 실패하는 SQL assertion, 원문 갱신, lifecycle 갱신과 이벤트를 동일 Core D1 batch에 넣어 전부 롤백한다. CAS 패배는 최신 Core 식별자로 preserved를 반환하고 Normalize는 후속 번역·승인 작업을 등록하지 않는다. 일시적인 DB 실패는 재시도한다.
- URL: 승인 P3와 API originalUrl 비교에 기존 canonicalOfficialArticleUrl 정책만 재사용한다. 스페인 HJ 동일 판례의 ACTION·언어·경로 별칭은 허용하고 다른 호스트·판례 번호는 거부한다. P3와 승인 해시는 수정하지 않는다.
- 메타데이터: Core 0011의 원장·트리거는 article_tags, tag 표시 필드, 검토 상태, publication, freshness와 catalog eligibility 변경을 같은 Core 트랜잭션에서 기록한다. revision과 fencing token, 120초 lease, revision별 8회 시도 예산, 제한된 backoff, dead-letter와 시도 이력을 보존한다.
- Search 0003은 legacy 메타데이터 revision/fence를 보호한다. 문서와 FTS, guard, 일회성 쓰기 권한을 동일 Search batch에서 갱신한다. 오래된 legacy 작업과 전수 동기화는 더 최신 metadata 또는 E2E generation을 덮어쓰거나 지울 수 없다. E2E Consumer는 기존 보호 트랜잭션으로 legacy guard를 승계한다.
- 전수·개별 동기화와 분당 전용 cron이 원장을 처리한다. metadata 수리는 기존 승인 P3를 재투영하며 콘텐츠 승인이나 completed_verified를 만들어내지 않는다. 비공개 검토 상태는 기존 Core authority를 통한 철회로 처리한다.
- 공개 검색은 결과를 묶어 Core revision과 Search guard를 비교하고 Core를 다시 읽는다. 공개 상세 읽기도 pending metadata를 차단한다. 세대가 없는 metadata 보호 대상도 기존 불변 승인 P3의 원문·요약·제목을 읽고 변경 중인 Core 초안을 노출하지 않는다. 캐시된 eligibility를 사용하지 않는다. 두 DB를 아우르는 전역 원자성을 주장하지 않는다.

## 배포 순서와 복구

1. 전체 verify:release와 실제 workerd D1 회귀 검사를 통과시킨다.
2. Core 0011 및 Search 0003을 적용하고 모든 객체를 검증한다. public_read_required는 기본 0이다.
3. Vinext build 결과의 Root Worker와 Async Worker를 배포한다. Async의 검증 deployment ref를 실제 Root 버전에 고정한다.
4. 기존 불일치 5개를 공식 invalidateSearchMetadata와 drainSearchMetadataRepairs로 수리한다. 승인 P3·publication revision 불변 여부와 실제 Search/FTS 내용을 확인한다.
5. e2e.api_identity_mismatch 대상만 expected fence를 확인한 redriveSearchVerification으로 다시 열고 기존 실패 예산을 이력 원장에 보관한다.
6. 호환 Worker 배포와 수리 검증 후 public_read_required=1을 활성화한다. 전수 감사, 공개 API, 현재 세대 상태를 확인한다.

구형 guard 미지원 Worker로 롤백하면 공개 읽기 방어가 빠질 수 있으므로 guard를 지원하는 버전으로만 전진 수정 또는 롤백한다. 스키마·원장·실패 증거와 철회 tombstone은 삭제하지 않는다.

## 종료 판정

이번 수정·배포 성공과 P0 종료는 구분한다. P0 종료에는 프랑스 실제 신규 판례의 무인 Discovery→Search/FTS→completed_verified 증거, 의미 검토, 마지막 런타임 배포 이후 48시간 관측 및 실제 일일 Discovery 두 회가 필요하다. 수리한 legacy metadata나 운영자 redrive를 신규 무인 처리 성공으로 세지 않는다. 배포로 관측 기준 시각을 갱신한다.

## 실행 결과

수정·커밋·푸시·운영 배포와 즉시 검증을 완료했다. P0 종료 판정은 보류한다.

- 코드: 33a12e8 (수집 CAS·metadata 원장·URL 검증), fce2b83 (legacy 공개 읽기 불변 P3), 최종 Async pin 55122b1.
- 전체 release: 1,673건 실행, 1,666 통과, PostgreSQL 7건 skip, 실패 0. 최종 보호 경로 173건 및 공개 읽기 보완 72건 모두 통과. 격리된 실제 workerd D1의 전체 롤백·FTS guard와 별도 metadata 회귀도 통과했다. 타입 검사·Async 타입·lint·Vinext 빌드·생성 타입 검사 통과.
- Core 0011/Search 0003 적용 후 기존·신규 보호 객체 78개를 실제 원격 sqlite_master에서 검증했다. Root 4a85bedb-9394-40cd-8b3d-3856785d31b6, Async 680c8507-2b05-40a2-bc04-55db79a52606 각각 100% 활성 상태다. Async 검증 참조는 git:fce2b831fb2ed767b3f64161e821d999230517f8;worldcons:4a85bedb-9394-40cd-8b3d-3856785d31b6와 일치한다.
- 최초 5개 수리 이후 전수 감사에서 다른 태그·검토 상태 불일치 5개를 추가 발견했다. 총 10개를 동일한 원장으로 수리했고 승인 P3와 publication revision은 유지했다. 운영 처리 중 생긴 원장까지 최종 11건 verified다.
- 배포 전 URL 오류 10개의 원래 generation이 모두 completed_verified/verified로 회복됐다. 정식 redrive 9건은 이전 시도 예산·오류를 원장에 보존했고 1건은 새 Consumer에서 자연 회복됐다.
- Search/FTS 전수 감사: 적격 1,511건, 문서 1,511건, FTS 1,511건. 안정된 Core 입력 경계에서 누락·초과·중복·내용 불일치 및 P3 참조 오류 모두 0건이다.
- 독립 외부 API 검사에서 legacy 7건의 Core 초안 노출을 확인했다. 이를 metadata 보호 대상의 불변 P3 읽기로 수정·재배포했으며 최종 23개 게시물의 검색·상세 46회 검사에서 식별자·제목·URL·승인 원문·요약을 검증했다. 실패 0, Root/Async health 200이다.
- 현재 세대는 completed_verified 16건, 기존 blocked 11건이다. 현재 검증 retry_wait/dead_letter는 0건이다. 과거 오류와 blocked 이력을 지우지 않았다.

최초 실패 감사·API 증거와 수정 후 성공 증거를 함께 보존한다. corpus-audit.json과 public-api-proof.json은 실패 진단이며, 최종 판정은 corpus-post-final-deploy/corpus-audit.json, public-api-proof-final.json, deployment-contract-final.json, url-target-final-status.json 및 completion-summary.json을 따른다.

마지막 런타임 기준 시각은 2026-10-12T11:50:16.263573Z (2026-10-12 20:50:16 KST)다. 48시간 조건을 충족하는 가장 이른 시각은 2026-10-14T11:50:16.263Z (2026-10-14 20:50:16 KST)이며 이것만으로 종료할 수 없다. 프랑스 신규 판례 무인 실증, 실제 일일 Discovery 두 회, 원문·번역·요약 의미 검토 및 Core/P3 초안 차이 12건의 분류가 남아 있다. 이번 감사는 이 차이를 승인 콘텐츠 오류 또는 정상 draft로 자동 판정하지 않는다.
