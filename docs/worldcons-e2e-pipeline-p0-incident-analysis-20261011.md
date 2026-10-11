# WorldCons 자동수집 E2E 정합성 결함 분석 및 P0 개선 계획

> **작성·재검증일:** 2026-10-11 (KST)  
> **Production 읽기 전용 기준선:** 2026-10-11 00:30:22–00:32:30 KST (`2026-10-10T15:30:22Z`–`15:32:30Z`)  
> **후속 읽기 전용 재조회:** 2026-10-11 00:38:50–00:38:52 KST (`2026-10-10T15:38:50Z`–`15:38:52Z`)  
> **코드 검토 기준:** GitHub `main`의 `a415860362877bafef579cab0c18133dcdb877d3`  
> **범위:** `worldcons` / `worldcons-ingest` / Production D1 Core·Ingest·Search. 신규 staged 자동수집 설정은 현재 **프랑스·스페인** 대상이며 독일·미국 M8 수집과 구분한다.  
> **보완 의견 반영:** 2026-10-11. 1차·추가 계획 검토 반영. 이번 계약 보완은 문서 작업이며 Production 재조회 시각은 위 기준선·후속 관측 그대로 유지한다.  
> **상태:** P0 열림. 문서 및 읽기 전용 증거 보완이며 **잔여 데이터 복구·Production 배포·E2E 정상화 완료 선언이 아니다.**

## 1. 결론과 판단 범위

Discovery → Crawl → Normalize → Translate/요약 → Public Judgment → Publish(P3) → Search/FTS의 **7단계 구현과 Production 실행 이력은 존재한다.** 그러나 단계별 `succeeded`만으로 최신 승인 콘텐츠, 공개 P3, Search/FTS가 같은 처리 버전에 속한다는 최종 결과를 지속 보증하지 못한다.

00:30–00:32 KST 기준선에서는 공개 P3 **1,428건**, Core–P3 콘텐츠 불일치 **3건**, legacy 게시 버전의 freshness 누락 **1건**과 해당 판례 Search/FTS **0/0**을 확인했다. **00:38 KST 후속 조회에서는 공개 P3 1,438건, drift 3건, freshness 누락 0건이며 FR L의 Search/FTS도 1/1로 복구돼 있었다.** 이 작업은 SELECT만 실행했고 복구 쓰기를 수행하지 않았다.

콘텐츠 drift와 검색 자격 누락은 서로 다른 결함이다. FR L의 분류·검색 행 복구를 관측했어도 나머지 drift, 실제 검색 응답, version별 최종 원장까지 해결된 것은 아니다. 정상적인 공개 승인 없이 Core의 모든 변경을 즉시 게시하는 것으로 해결해서는 안 된다.

**요구 완료 계약:** 발견된 후보를 실제 Core ID 및 원문 버전으로 연결하고, 공개 가능한 **승인 콘텐츠**에 대해 번역·요약·P3 발행·검색 투영·교차 DB 검증까지 완료한다. 원문 부재·정책상 비공개·검토 대기는 이유와 재평가 조건을 가진 차단/검토 상태로 남긴다. 완료 이후 원문·승인 콘텐츠·공개 정책·게시 버전이 바뀌면 기존 검증을 과거 기록으로 보존하고 새 처리 세대를 검증한다.

**원인 확정의 한계:** 현재 검색 자격 SQL이 freshness 누락 버전을 제외한다는 점과 해당 판례의 검색 누락은 확인했다. 누가 어떤 배포 버전에서 누락을 만들었는지, 검색 행이 삭제된 정확한 실행, 다른 세 건의 drift 발생 경로는 아직 확정하지 않았다. Job 성공 시점의 코드·입출력 버전과 감사 이력을 연결해야 한다.

## 2. 재현 가능한 Production 증거

### 2.1 증거 위치와 초기 기준선의 집계 범위

읽기 전용 감사 결과 및 추가 SELECT 응답은 [재조회 증거 JSON](../artifacts/incident-analysis/worldcons-e2e-p0-20261011-read-only.json)에 저장했다. 추가 D1 SELECT 응답의 `rows_written=0`, `changed_db=false`를 확인했다. 감사 스크립트·SQL·판정 함수는 위 코드 검토 기준과 줄바꿈 정규화 후 SHA-256이 일치한다.

집계는 서로 다른 DB에서 순차 또는 병렬로 읽은 관측값이며 단일 시점의 전역 트랜잭션 snapshot이 아니다. 판례별 완료 판정에서는 검사 전후 게시 head와 승인 콘텐츠 세대를 재확인해야 한다. 이번 작업은 공식 원문·번역·요약의 의미적 정확성 재심사나 공개 검색 API 응답 검증까지 수행한 것이 아니다.

**다음 표와 국가별 수치는 00:30–00:32 KST 기준선**이다. 00:38 후속 관측은 2.5절에서 구분한다.

| 항목 | 기준선 결과 | 의미 및 제한 |
|---|---:|---|
| P3 `state='published'` head | **1,428건** | 공개 적격 판례 수와 동일한 분모로 취급하지 않음 |
| published head의 Core 행 누락 | **0건** | `LEFT JOIN`으로 누락도 포함해 집계 |
| published head의 P3 버전 누락/타 article 참조 | **0건** | `version_id`와 `article_id`를 함께 검증 |
| Core–P3 snapshot drift | **3건** | 본문·요약 JSON·한국어 제목·canonical URL 중 하나라도 다름 |
| legacy P3 freshness 행 누락 | **1건** | `version_role IS NULL`에 한정 |
| legacy P3 freshness 행은 있으나 `current` 아님 | **0건** | 누락과 별도 지표 |
| 현재 Search gate2 적격 published head | **1,426건** | `d1-sync.ts`의 실제 적격 SQL 기준 |
| FR 2026-335 L의 Search/FTS | **0건 / 0건** | freshness 누락과 함께 관측 |
| 나머지 drift 3건의 Search/FTS | **각 1건 / 1건** | 행 존재만 확인; 최신 콘텐츠/FTS 본문 일치는 별도 검증 필요 |

국가별 published/drift는 독일 **473/0**, 미국 **136/0**, 프랑스 **395/1**, 스페인 **424/2**이다. 본문 drift 2건, 요약 drift 3건, 제목 drift 3건, URL drift 0건이며, 같은 판례가 여러 항목에 포함되므로 필드별 수를 더해 판례 수로 계산하지 않는다. SQL의 JSON 비교는 저장 문자열 비교다. JSON 키 순서·공백 차이와 실제 내용 변경을 복구 전 구분한다.

### 2.2 네 판례의 정확한 식별자와 초기 상태

| 판례 | Article ID | 게시 revision / version ID | 재조회 상태 |
|---|---|---|---|
| FR 2026-1223 QPC | `0e25c3b4-3449-46b5-9270-fd0e37f9e4b7` | 2 / `c1535ad7-e42a-5add-afa7-b977d3e1225c` | 본문 11,879/11,831자(Core/P3), 요약·제목 drift. freshness `current`, Search/FTS 1/1 |
| FR 2026-335 L | `16b4fc11-d9cc-4e5b-b8e5-acf687ab760e` | 2 / `0f1dabb2-2442-546e-a3ec-d2ed5d443cc5` | Core/P3 일치, 관리자 사전검사 `no_drift`. freshness 행 없음, Search/FTS 0/0 |
| ES AUTO 43/2026 | `15560a96-c510-427c-aaf4-a5d57ef5bd50` | 30 / `eebc2367-0f48-5d88-a36a-b4020d5fb0d6` | 본문 14,205/14,206자, 요약·제목 drift. freshness `current`, Search/FTS 1/1 |
| ES SENTENCIA 59/2026 | `d31eecc5-4e74-440f-ba6e-1561911bd68c` | 18 / `017489d5-62ed-5573-a95a-438ced9bbb59` | 본문 66,952자 일치, 요약·제목 drift. 오래된 출처 안전 플래그 충돌. freshness `current`, Search/FTS 1/1 |

FR QPC의 기존 문서 ID는 잘못 기재돼 있었다. 위 ID는 관리자 `P3_DRIFT_REFRESH_CANARY_IDS`와 Production SELECT로 모두 확인했다. revision은 **게시 revision**이며 콘텐츠 version revision, Search `projection_version`과 혼용하지 않는다.

사전검사에서 FR QPC·ES AUTO는 `eligible:true`, FR L은 `eligible:false, reason=no_drift`, ES SENTENCIA는 `eligible:false, reason=provenance_conflict`였다. `eligible`은 복구 경로의 기술적 사전검사 통과이며 번역·요약의 의미적 승인이나 실제 개정 완료를 뜻하지 않는다.

### 2.3 published 1,428건과 검색 적격 1,426건의 차이

검색에서 제외된 두 head는 다음과 같다.

1. **FR 2026-335 L:** legacy 버전에 freshness가 없고 published Catalog도 없음. 현재 SQL상 freshness 누락이 적격 실패 조건이다.
2. **독일 `552950ac-de82-41f5-ae88-411efc5ae9b2`**, `Beschluss vom 24. März 2021`: P3 revision 1 / version `ab74a7d6-1cc8-5fc7-a522-97226a91f7dc`, `version_role IS NULL`, freshness `current`지만 별도 Catalog가 `published`. Catalog anchor는 `cbd5c14b-6278-5f1b-ac03-947589f06ef5`이다. legacy와 published Catalog의 중복 노출을 막는 gate2 조건에 의해 제외되며 Search/FTS도 0/0이다.

두 번째 건은 freshness 누락 장애와 합산하지 않는다. Catalog 전용 공개가 의도된 상태인지, enrichment 전환이 빠졌는지는 별도 정책·출처 확인 대상이다. `published=1428`을 그대로 기대 Search 수로 삼거나, 검색에 없다는 이유만으로 freshness를 `current`로 올려도 해결되지 않는다. **적격 대상 누락, 공개돼야 하나 자격 메타데이터가 빠진 건, 정책상 제외 건**을 각각 집계한다.

### 2.4 Job 집계와 시각 해석

이번 집계 구간은 **2026-10-09 00:00 KST 이상, 2026-10-11 00:30:22.317 KST 미만**이다. UTC SQL 경계는 `2026-10-08T15:00:00Z`와 `2026-10-10T15:30:22.317Z`다. 이 구간의 Discovery/Crawl/Normalize/Translate/Public Judgment/Publish는 각각 **3건 `succeeded`**, Search는 **4건 `succeeded`**였다. 네 건의 Search에는 별도 FR L 수리 Job 한 건이 포함된다.

초판의 단계별 2건 집계는 SQL 하한 `2026-10-09T00:00:00Z`(KST 10월 9일 09:00)와 연결해 해석해야 한다. 날짜·시간대·조회 구간 없이 수치를 비교하지 않는다. **단계별 COUNT가 같아도 동일 판례의 동일 버전 처리 체인이라는 증거가 되지 않는다.**

Discovery Job은 국가별 요청이고 여러 Crawl 후보로 fan-out한다. Crawl/Normalize의 `article_id`는 `native:` 후보 ID이며 Normalize 다음 단계부터 실제 Core UUID로 바뀐다. 모든 단계에서 하나의 UUID를 필터링하면 전반부 이력이 빠진다. Discovery 요청 → 후보 URL/ID → Normalize `result_ref`/다음 article ID → Core UUID → P3 version을 연결해야 한다.

### 2.5 후속 관측: FR L의 분류·검색 행 복구

검증용 SELECT를 실행하는 동안 운영 상태가 바뀌어 00:38:50–00:38:52 KST에 같은 집계를 다시 읽었다.

| 항목 | 초기 기준선 | 후속 관측 |
|---|---:|---:|
| published head | 1,428 | **1,438** |
| Core–P3 raw snapshot drift | 3 | **3** |
| Core/P3 참조 누락 | 0/0 | **0/0** |
| legacy freshness 누락 / not current | 1/0 | **0/0** |
| Search gate2 적격 head | 1,426 | **1,437** |
| FR L Search/FTS | 0/0 | **1/1** |

FR L은 **동일 version `0f1dabb2-2442-546e-a3ec-d2ed5d443cc5` / 게시 revision 2**를 유지했다. freshness는 `current`, `classified_at=2026-10-10T15:34:28.326Z`(KST 00:34:28), `classified_by=m8-publication-drain`으로 나타났다. Search checksum은 `e3df6b65da599b59`, 투영 스키마 버전 1이다.

이는 기존 publication drain의 분류 보정 및 검색 재투영 경로와 일치하는 관측이다. **분류자 이름만으로 정기 cron인지 수동 실행인지, 정확히 어느 작업이 검색 행을 만들었는지 확정하지 않는다.** 자동 회복 기능이 전혀 없다는 진단은 부정확하며, 남은 문제는 version별 수리 의도·완료 증거·지연 보장이다. FR L의 실제 검색 API 응답과 저장 FTS 내용까지 재검증한 것은 아니므로 `completed_verified` 선언은 보류한다.

다른 세 판례의 P3 version/revision은 그대로이고 drift 3건도 남아 있다. 독일 Catalog 제외 건은 별도 정책 확인 대상으로 유지한다. 총 published 증가 10건은 이 재조회에서 관측한 차이일 뿐 모두 신규 Discovery E2E 성공이라고 분류하지 않는다.

## 3. 관측 타임라인과 미확정 원인

| 시각(KST) | 관측 사실 | 가능한 판단 |
|---|---|---|
| 2026-10-09 07:46:17 | FR L 첫 Search Job 성공 | 당시 version ID를 Job 결과만으로 확정할 수 없음 |
| 2026-10-09 08:56:10 | FR L 별도 `repair:2026-10-09:fr-l-suffix` Search Job 성공 | 정규 체인과 구분할 수리 이력 |
| 2026-10-10 07:30:41 | FR L 후속 Search Job 성공 | 이후의 공개 head 변경까지 보증하지 않음 |
| 2026-10-10 07:45:39 | ES SENTENCIA Search Job 성공 | 현재 Core/P3 요약·제목 drift와 동시에 이력 존재 |
| 2026-10-10 23:26:51 | FR L 현재 P3 revision 2의 `updated_at` | 마지막 Search 성공보다 나중에 공개 head 갱신 |
| 2026-10-11 00:30–00:32 | FR L freshness 없음·Search/FTS 0/0, 다른 3건 drift 재확인 | 과거 성공 이력과 현재 정합성이 별개임을 입증 |
| 2026-10-11 00:34:28 | FR L freshness의 후속 `classified_at`, 분류자 `m8-publication-drain` | 같은 P3 version에 분류 보정 기록 |
| 2026-10-11 00:38:50–00:38:52 | FR L freshness `current`·Search/FTS 1/1 | 부분 회복 관측; drift 3건과 최종 검증은 잔여 |

FR L의 시간 순서는 **마지막 Search 성공 이후의 공개 head 변경**을 보여 준다. 다만 `updated_at`만으로 관리자 actor, 요청, 삭제 실행의 인과를 확정하지 않는다. P3 history/audit, 요청 ledger, 당시 Worker deployment ID, Search sync 실행 로그를 대조한다.

ES SENTENCIA는 현재 Core `updated_at`이 2026-10-10 07:00:48이고 P3 head `updated_at`은 2026-09-30 12:34:17이다. 후속 Publish/Search 성공 뒤에도 이전 P3가 남아 있다. 따라서 모든 drift를 단순히 **성공 이후 Core가 바뀐 것**으로 설명할 수 없다. 당시 배포된 replay gate의 동작, mutable Core 재조회 시점, 요약 변경 이력을 추가 확인한다. 검토 기준 코드의 현재 replay gate가 snapshot 불일치를 차단한다는 사실을 과거 실행에 소급하지 않는다.

현재 Publish adapter는 `versionId`를 반환하지만 handler의 성공 `result_ref`에는 article ID만 남긴다. Search adapter도 article ID로 현재 적격 P3를 다시 조회한다. 즉 Job만으로는 **Publish가 만든 특정 version과 Search가 검증한 version의 결합**을 증명할 수 없다.

## 4. 현재 구현의 보장과 한계

| 구성 요소 | 구현돼 있는 보장 | 남은 한계 |
|---|---|---|
| [단계 계약](../lib/cloudflare/ingest-stages/contracts.ts), [dispatcher](../lib/cloudflare/ingest-stages/dispatcher.ts) | 단계별 멱등 키, lease/fencing, 완료와 다음 Job 등록의 Ingest D1 batch, Queue dispatch outbox | 다른 DB의 부수효과와 Ingest 완료를 하나로 commit하지 못함. fencing은 Job 완료 보호이며 다른 DB의 모든 쓰기를 자동 보호하는 것은 아님 |
| [handlers](../workers/async-pipeline/src/ingest-stage-handlers.ts), [consumer](../workers/async-pipeline/src/ingest-stage-consumer.ts) | 실제 수집·정규화, Core ID 채택, 번역 durable effect 재조회, 공개 gate, 재시도/차단 | Publish/Search 결과의 version 결합이 없음. handler `blocked`는 durable Job enum의 별도 상태가 아니며 terminal failure/dead-letter와 이유 코드로 표현됨 |
| [publication drain](../lib/cloudflare/publication/d1-publication-drain.ts) | 첫 발행 및 이미 게시된 동일 snapshot replay, freshness 보정 | batch drain은 이미 `published`인 콘텐츠 drift를 자동 새 버전으로 개정하지 않음 |
| [P3 authority](../lib/cloudflare/core-write/authority.ts) | immutable version, revision, history/audit, cache outbox. 신규 legacy capture 발행의 freshness를 같은 batch에 기록 | 신규 version 생성 조건에 한정. 기존 누락·명시 version 발행·다른 역할의 공개 자격을 모두 자동 수리하는 수정은 아님 |
| [Search sync](../lib/cloudflare/search-projection/d1-sync.ts), [verify](../lib/cloudflare/search-projection/verify.ts) | 적격 P3로부터 기대 투영 생성, Search checksum/투영 스키마 버전, FTS article ID 수량 및 중복 검사, 비적격 시 0/0 정리 | 실제 저장 Search 본문에서 checksum을 재계산하지 않음. FTS title/본문 자체의 일치 검사와 처리 후 P3 head 재조회가 없음 |
| [관리자 refresh 경로](../app/api/admin/work/[kind]/[id]/route.ts), [판정 함수](../lib/admin/p4/p3-drift-refresh.ts) | 네 ID로 제한된 인증·CSRF 수동 복구, 출처 사전검사, 정식 transition, `no_drift` 시 freshness/Search 복구 | 일반 관리자 publish/withdraw까지 동일 종단 계약이 적용된 것은 아님. 검색 실패를 503으로 반환하는 동기 요청만으로 내구성 있는 검색 수리 예약을 증명하지 못함 |

### 4.1 freshness 조건은 버전 역할별로 다르다

- **Legacy (`version_role IS NULL`):** 해당 version의 freshness `current` **및** 같은 article에 `published` Catalog가 없어야 Search 적격이다.
- **`enrichment_full`:** `published` Catalog의 anchor ID가 enrichment의 anchor ID와 같고, anchor의 `source_content_hash`가 enrichment의 `enrichment_source_content_hash`와 같아야 적격이다. legacy freshness 행을 필수 조건으로 쓰지 않는다.
- 그 밖의 역할·원문 전용·철회 상태는 정책상 검색 제외일 수 있다. freshness 누락 0건을 모든 역할의 완료 기준으로 적용하면 오탐이나 잘못된 공개를 유발한다.

freshness `current`는 **해당 P3 version에 대한 분류**이지 현재 mutable Core와의 내용 일치나 번역 품질 인증이 아니다. 지금 drift 세 건에도 `current`가 존재한다.

### 4.2 Git 반영, 배포, 데이터 복구를 분리한다

`31603a37f0eca6ab6009873ab2f55ce836e761c5`는 GitHub main 이력에서 확인했다. 수정 조건은 `versionCreated && captureLegacy === true && targetState === 'published'`이며, freshness INSERT는 `ON CONFLICT(version_id) DO NOTHING`이다. 따라서 이미 존재하는 누락/잘못된 분류를 모두 소급 수리했다고 해석하지 않는다.

해당 commit에는 관리자 `no_drift` 및 개정 후 검색 처리 전에 `reconcilePublishedSearchFreshnessForArticle`를 호출하는 보완도 있다. **FR L은 기존 revision 2를 유지한 채 freshness/Search를 복구할 수 있는 코드 경로가 이미 존재한다.** 이를 새 기능으로 중복 제안하지 않고 실제 운영 복구와 회귀 검증을 남은 작업으로 분류한다.

초판은 Production Worker 반영도 기록했지만, 이번 작업은 Worker deployment ID와 source SHA의 연결을 새로 검증하지 않았다. **Git 반영은 확인, 배포는 기존 기록의 주장, FR L의 분류·검색 행은 후속 복구 관측, drift 3건은 미해결**로 구분한다. cache outbox가 있다는 사실도 P3 version별 Search 수리 outbox가 있다는 뜻은 아니다.

### 4.3 국가 범위, Discovery 누락, 처리 지연

검토 기준 [설정](../workers/async-pipeline/wrangler.jsonc)에서 staged allowlist는 프랑스·스페인, bootstrap은 UTC `0 21 * * *`(**매일 06:00 KST**), dispatch는 `*/15 * * * *`다. bootstrap은 출처당 `limit=1`이고 각 stage의 새 claim도 pass당 1건이다. 독일·미국은 이 staged 성공 집계로 E2E 완료를 판단하지 않는다.

`BOOTSTRAP_LIMIT=1`은 처리 속도뿐 아니라 **한 번의 발견 후보 수를 제한**한다. 공식 목록을 `slice(0, limit)`로 자르므로 같은 상위 후보를 다시 선택하거나, 다수 신규 판례의 뒤쪽 후보가 수집 기간 밖으로 밀릴 가능성을 점검해야 한다. 해당 누락이 실제 발생했다는 전수 증거는 아직 없으며, 출처별 cursor/coverage 감사가 필요하다. 이미 발견된 Job만 검증하는 원장으로 미발견 판례 누락을 탐지할 수 없다.

dispatch 기본 claim 용량은 stage당 시간당 약 4건이다. 동일 pass 중 Queue 실행 시점·기존 백로그·재시도·outbox replay에 따라 실제 처리량과 지연은 달라진다. 발견 자체가 일일 주기라는 점과 발견 후 7단계의 지연을 분리 측정하며 `7×15분`을 고정 보장 시간으로 단정하지 않는다.

### 4.4 이번 수정의 Git 상태와 변경 소유권

보완 의견 검토에서 원격 `main`이 계속 `a415860362877bafef579cab0c18133dcdb877d3`임을 `git ls-remote`로 확인했다. 이번 보완 문서와 증거 JSON은 **로컬 파일이며 미커밋·미푸시·미추적** 상태다. GitHub main에 있는 초판과 현재 보완본을 같은 버전으로 부르지 않는다.

| 대상 | 확인한 상태 | 이번 문서 작업의 범위 |
|---|---|---|
| GitHub main | 초판 E2E 보고서가 포함된 `a415860` | 읽기 및 비교만 수행 |
| 기본 checkout `F:/dev/worldcons`의 main | `92cc7659b5ab032c735034820ab3376447ea772c`, 원격 대비 ahead 0 / behind **60** | branch 전환·reset·merge·commit·push·deploy 없음 |
| 보완 보고서 및 검증 JSON | `git status`에서 `??` | 이번 작업으로 작성한 두 산출물 |
| `app/admin/ops/page.tsx`, `scripts/ops-watchdog.ts` | 작업 시작 전부터 미커밋 변경 | 이번 작업의 코드 수정이 아니며 보존 |
| 다른 Codex/DevSpace worktree 변경 | 보완 의견에 별도 작업으로 보고됨 | 전체 변경의 작성자·반영·배포를 이번 작업 결과로 귀속하지 않음 |

Git에 반영할 때는 **확인한 최신 원격 main 기반의 별도 branch/작업 트리**에서 이 보고서와 증거만 비교·적용한다. 실제 반영 직전 원격 SHA를 다시 확인하고, 같은 문서의 후속 편집이 있으면 그 변경과 병합한다. 뒤처진 기본 checkout의 전체 변경이나 다른 작업의 임시 파일을 함께 올리지 않는다. 문서 PR/commit 및 Production 코드 배포는 각각 별도의 검증 단위다.

Watchdog의 로컬 수집·GitHub Issue 관리 제거 등 다른 작업 변경은 Cloudflare 대체 실행·보정·알림 경로의 구현, 실제 배포 및 장애 동작을 검증한 뒤 별도로 통합해야 한다. 이번 문서에서 그 전환이 구현 완료됐거나 Production에서 검증됐다고 선언하지 않는다. 파일 수정일만으로 작성자나 이번 작업의 변경 여부를 확정하지 않는다.

## 5. 결함 분류와 복구 우선순위

| 코드 | 문제 | 증거 수준 | 다음 조치 |
|---|---|---|---|
| **P0-A** | Publish/Search 버전 결합 및 사후 검증 원장 부족 | 코드 및 운영 불일치 확인 | version을 고정한 최종 검증과 변경 시 새 세대 생성 |
| **P0-B** | FR L legacy freshness 누락과 검색 누락 | 초기 장애와 동일 version 부분 회복 모두 실측 | 쓰기 재수리보다 공개 검색/FTS 내용·회복 실행 증거·지연 확인 우선 |
| **P0-C** | Core–P3 snapshot drift 3건 | 실측 확인; 발생 경로 미확정 | 의미·출처·승인 확인 후 정식 개정 또는 검토 상태 |
| **P0-D** | 수동/자동 발행 및 철회 경로의 공통 완료·복구 계약 미흡 | 경로별 코드 차이 확인 | 같은 내구성 있는 검색 수리·검증 계약 적용 |
| **P1-E** | 후보 유실이 없는 상태의 처리량·느린 dispatch | 설정/코드 확인; 처리 지연 실측 필요 | durable 후보 전체 처리 보장 아래 용량·대기시간 조정 |
| **P0-G 후보** | 상위 후보 반복으로 다른 신규 판례 미발견/기간 이탈 | 구조적 위험; 실제 누락 미입증 | 구현 초기 다수 후보·재시작 회귀 필수. 누락 입증 시 P0, cursor/coverage로 해결 |
| **P0-C 선행 / P1-F** | ES SENTENCIA의 오래된 출처 메타데이터 충돌 | 실제 `provenance_conflict` | drift 복구 전에 공식 원문 재검증·이전 증거 보존 |

### 5.1 운영 잔여 건의 복구 순서

운영 잔여 범위는 **콘텐츠 drift 3건(FR QPC·ES AUTO·ES SENTENCIA) + 이미 1/1 회복된 FR L 후검사 1건**이다. 네 건 모두 아직 검색 누락 상태인 것으로 다루지 않는다.

이 절은 기존 장애 건을 처리하는 운영 절차다. 이를 구조 개선의 선행 완료 조건으로 삼지 않는다. **코드 구현은 P0-1과 P0-3의 공통 계약부터 진행**하고, 세 drift 건의 출처·의미 검토와 FR L 후검사는 별도로 진행한다.

1. **읽기 전용 기준선:** 네 article의 Core `updated_at`, P3 head/version/revision, 역할별 자격, Search/FTS 수량을 저장한다. 복구 직전에 다시 조회해 변경됐으면 재평가한다.
2. **FR L 후속 검증:** 이미 `current`와 1/1을 관측했으므로 먼저 실제 공개 상세·검색 응답, 기대 투영/FTS 내용, 회복 실행 기록을 확인한다. 누락이 재발하면 MasterDash SSO 관리자 화면 `/admin/work/article/16b4fc11-d9cc-4e5b-b8e5-acf687ab760e`의 기존 `refresh-p3` 경로를 사용한다. 계속 `no_drift`이면 P3 version/revision을 그대로 두고 분류·검색만 수리한다. `verified:true`와 함께 `desiredEligible=true` 및 1/1을 확인한다.
3. **FR QPC·ES AUTO 개정:** 본문 차이가 공식 원문 변경인지 가공 차이인지 확인하고 한국어 제목·요약을 검수한다. 승인 후 `articlePublicationService.transition(captureLegacy=true, targetState='published')`로 새 immutable version을 만든다. 사전검사 통과만으로 게시하지 않는다.
4. **ES SENTENCIA 출처 충돌 해소 후 개정:** 기존 관리자 경로의 정확한 HJ JSON record/사건 식별자/공개 제한/본문 일치 검사를 수행한다. 오래된 플래그는 `sourceRevalidation` 증거로 보존한다. 현재 검사 함수는 본문 구간의 **정규화된 앞부분 매칭**을 사용하므로 전체 원문의 완전 동일성이나 번역 정확성 검증으로 과장하지 않는다.
5. **후검사:** version/revision/history/audit/cache outbox, 역할별 자격, Search/FTS 및 실제 공개 상세·검색 결과를 확인한다. 세 DB 비교 중 head가 바뀌면 완료를 기록하지 않고 재검증한다.

이번 문서 작업에서는 위 쓰기 복구를 실행하지 않았다. 다른 worktree의 변경 및 기존 작업 파일도 보존했다.

### 5.2 부분 성공·실패 시 처리

- P3 개정은 성공했지만 검색이 실패하면 **개정 성공/검색 대기**로 기록한다. 전체 rollback을 가정하거나 같은 콘텐츠를 다시 새 version으로 만들지 않는다. 동일 version의 검색 수리 작업을 재시도한다.
- freshness 분류는 출처·공개 정책 확인을 통과한 정확한 version에만 부여한다. 누락과 의도적 `not_current`/차단을 구분하고 전체 published를 무조건 `current`로 승격하지 않는다.
- 새 원문이 검증되지 않았거나 검토가 미완료면 검토 상태로 보낸다. 승인된 과거 P3를 유지할지 철회할지는 공개 정책으로 결정한다. 비공개/철회가 필요한 경우 Search와 공개 상세·캐시에서도 제거됨을 검증한다.
- 공개 snapshot을 되돌릴 때도 승인된 이전 version을 정식 transition으로 선택하고 검색을 재투영한다. immutable P3 직접 UPDATE나 감사·원장 우회는 사용하지 않는다.

## 6. 구조 개선 계약과 구현 순서

**최상위 수용 기준:** WorldCons는 Discovery가 발견한 공개 가능 판례를 정책으로 승인된 콘텐츠 버전 기준으로 수집·번역·요약·P3 발행·Search/FTS 검증까지 자동 완료하고, 장애·중복·역순 실행에도 작업 유실·중복 발행·구버전 공개 검색 없이 복구할 수 있어야 한다. 정책 차단·검토 대기는 이유가 있는 별도 결과이며 성공 게시로 집계하지 않는다.

이 절의 식별자·상태·필드·임계값·M1–M5는 **이번 P0 계획의 제안 계약**이다. 기존 Cloudflare M1–M11 등의 마일스톤과 다른 이름 공간이다. 실행 기록에서는 `E2E-P0/M1`처럼 표기한다. 현재 구현·배포돼 있다는 뜻이 아니다.

| 작업 | 현재 확인 수준 | 구현 시 필요한 증거 |
|---|---|---|
| P0-1 처리 세대별 완료 원장 | 설계 제안 | 후보→승인→P3→Search lineage, 조건부 완료·무효화 |
| P0-3 공통 Search 수리 outbox | 개별 복구 기능 존재, 공통 계약 제안 | Core commit과 예약 원자성, 중단 후 재개, 모든 writer의 세대 검사 |
| Core 승인 변경·자동 재개정 | 설계 제안 | 자동/사람 승인 구분, 이벤트·멱등 개정 |
| Discovery cursor/coverage | 제한과 누락 위험 확인 | 공식 목록 대비 후보 집합, 재시작·상위 후보 반복 회귀 |
| 실제 검색·저장 FTS 검증 | 이번 조사에서 미실시 | 집합·저장 내용·version·공개 API 응답 |
| 프랑스·스페인 신규 무인 E2E | 이번 조사에서 미실시 | 국가별 신규 판례의 전체 처리 세대 완료 |

담당자는 Publication/Core, Ingest, Search, 운영 역할로 지정하고 실명 담당자·검토자·배포 SHA/Worker version·예정 시각을 실행 기록에 채운다. 미지정 상태를 구현 완료로 표시하지 않는다.

### 6.1 P0-1 — 처리 세대 식별자와 최소 완료 원장

#### 식별자와 불변 조건

`source_version`은 기존 단계 Job의 입력/원문 identity이며 E2E 처리 세대를 대신하지 않는다. 승인 전 Crawl/Normalize는 `pipeline_run_id`, Discovery 요청·후보 ID 및 원문 hash로 연결한다. 승인 콘텐츠가 정해진 뒤 Core authority에서 해당 article의 처리 세대를 확정한다.

| 필드 | 제안 계약 |
|---|---|
| `approval_key` | SHA-256(canonical JSON의 article ID, 공식 원문 hash, 승인 snapshot hash, 승인 정책 버전). 동일 승인 입력의 재전달은 같은 key |
| `generation_seq` | Core authority가 article별로 할당하는 단조 증가 정수. 실질적인 발행/철회/역할·정책·투영 입력 변경 때만 새 번호; Queue 재전달·기술적 수리는 번호 유지 |
| `generation_id` | SHA-256(canonical JSON의 article ID, generation seq, approval key, expected P3 version ID, 목표 publication state, projection input hash). 필드 구분·NULL 규칙·해시 스키마 버전을 고정 |
| `expected_version_id` | 정확한 P3 immutable version ID. version을 준비해 ID를 결정한 뒤 head·세대·outbox를 같은 Core commit으로 연결 |
| `expected_publication_revision/state` | 같은 version을 철회·재게시하는 상황도 구별. version ID만으로 최신 여부를 판단하지 않음 |
| `projection_input_hash` | 태그·review 값 등 snapshot 밖의 검색 입력과 투영/FTS 생성 규칙 버전을 포함하는 SHA-256. 관련 입력 변경도 새 세대 생성 |

`generation_seq`는 UUID·timestamp·content hash의 사전순으로 비교하지 않는다. `generation_id`는 유일 identity이며 순서 판정은 `generation_seq`로 한다. 철회/remove는 마지막 승인 snapshot 근거를 참조하되 현재 철회 정책·revision·새 seq를 기록하며, 새로운 콘텐츠 승인으로 가장하지 않는다. 동일 원문이라도 요약·제목·URL·태그 변경으로 승인 snapshot이나 투영 입력이 바뀔 수 있다. Search `projection_version`은 투영 스키마 버전이며 P3 version도 generation도 아니다.

현재 P3 snapshot `content_hash`에 모든 승인/투영 입력이 포함돼 있다고 가정하지 않는다. 승인 snapshot hash v1의 필수 입력은 `article_id`, `source_key`, `jurisdiction`, `institution_name`, `content_type`, `original_language`, `original_title`, `korean_title`, `original_published_at`, `canonical_url`, `cleaned_text`, canonical `summary_json`, 원문 content hash, 공개 관련 provenance/안전 플래그 및 version role/anchor 관계다. 역할에 없는 필드는 명시적 NULL로 표현하고 누락·NULL·빈 문자열 규칙을 고정한다. 수집 시각이나 처리 시각만 바뀌어 같은 승인 콘텐츠의 세대가 늘지 않도록 운영 timestamp는 승인 hash 입력에서 제외한다.

canonical JSON은 key 순서를 고정하고 배열 순서·문자열 내용은 보존한다. JSON 문자열의 단순 공백/key 순서와 의미 변경을 구별하며 본문 공백/Unicode를 임의 정규화해 변경을 숨기지 않는다. 승인 hash 스키마 버전은 명시적으로 기록한다. 검색 입력 hash에는 정확한 P3 identity와 정렬된 article-tag/태그 값, review 값, publication state, 투영/FTS 생성 규칙 버전을 포함하고 검사 동안 이 입력을 고정하거나 변경 감지로 새 세대에 넘긴다. 기존 64-bit Search checksum은 변경 감지 값이며 승인 증거 hash 대신 쓰지 않는다.

최소 원장은 `source_key`, 후보/원문 증거 참조, Core article ID, 위 identity 필드, `approval_mode/policy_version/evidence_ref`, 기대 Search/FTS fingerprint, 상태·오류 코드·검증 시각·증거 참조를 보관한다. 현재 세대 pointer와 각 세대의 불변 이력을 분리한다. 오래된 완료 이력을 덮어쓰지 않고 현재 pointer를 새 세대로 옮긴다.

#### 상태와 완료 전환

제안 상태는 `processing`, `publication_committed`, `search_pending`, `retry_wait`, `review_required`, `blocked`, `completed_verified`, `dead_letter`, `superseded`다. 기존 Job enum과의 매핑·migration을 명시하고 정책 차단을 기술적 실패 재시도로 소진시키지 않는다.

`completed_verified`는 다음을 모두 만족할 때만 전환한다.

1. 원문 provenance·공개 허용·자동 또는 사람 승인 근거가 해당 원문/승인 snapshot 및 정책 버전에 연결돼 있다.
2. 승인 snapshot과 정확한 P3 version의 본문·요약·제목·URL·공개 메타데이터가 일치하고 역할별 gate2 조건이 유효하다.
3. 적격 ID 집합과 Search/FTS ID 집합이 같고 누락·중복·비적격 잔존이 없다. 단일 판례 validator와 전수 감사의 범위를 구분한다.
4. 실제 저장 Search 문서의 논리 필드에서 checksum을 재계산해 기대 투영과 비교하고 FTS title·case_numbers·search_text·tags_text도 비교한다. 저장된 checksum 값을 신뢰해 내용을 생략하지 않는다.
5. 공개 상세·실제 활성 검색 API에서 기대 article ID/사건번호/표시 제목/공개 URL을 확인한다. 응답 HTTP 200이나 총 결과 수만으로 통과시키지 않는다. 내부 generation 필드를 일반 사용자 응답에 노출할 필요는 없으며 검증 증거에 version/세대를 연결한다.
6. Core 현재 세대·정책·P3 head와 Search 적용 세대를 다시 확인한다. **완료 기록 자체도** 같은 Core 세대/head를 조건으로 쓰고 조건 불일치 시 완료를 기록하지 않는다.

검증 시각, `generation_id/seq`, P3 version/revision, 기대/실측 fingerprint, 공개 API probe 결과를 함께 남긴다. 게시 뒤 검색 API 장애면 `search_pending/retry_wait`를 유지한다. 기술적 투영 성공과 공개 API 검증 성공을 원장에서 따로 보관하되 후자까지 끝나야 `completed_verified`다.

완료는 `verified_at` 당시 증거다. 정책·승인 콘텐츠·게시 head·투영 입력 변경 시 기존 검증을 과거 이력으로 남기고 새 세대를 생성한다. 철회·정책 제외는 별도의 제거 검증 결과(`withdrawal_verified` 등)로 기록하며 공개 성공으로 집계하지 않는다.

### 6.2 P0-2 — 국가별 공개 승인과 Core 변경 이벤트

**승인은 관리자 버튼을 항상 기다린다는 뜻이 아니다.** `approval_mode=automatic_policy|human`를 구분한다. 공식 원문·공개 가능성·번역/요약 품질 검사가 국가별 버전 정책을 통과하면 사람 개입 없이 자동 승인한다. 실패·불확실성은 사유별 검토/차단으로 분기한다.

| 국가/상황 | 자동 처리 조건 | 사람 검토 또는 차단 조건 |
|---|---|---|
| 프랑스 신규 staged 판례 | 공식 출처·사건 식별·원문 버전 검증, robots/공개 정책 허용, 번역·요약 검사 통과, review 차단 없음, 적용 역할의 공개 gate 통과 | 원문/사건 불일치, provenance 충돌, 품질 검사 실패·법률 의미상 중대한 충돌 신호는 `review_required`; 명확한 공개 금지는 `blocked` |
| 스페인 신규 staged 판례 | 공식 HJ 사건·본문 검증, 인터넷 공개 제한/관련 안전 플래그 허용, 번역·요약 검사 및 역할별 gate 통과 | 공식 응답과 과거 메타데이터 충돌은 근거 보존 후 재검증. 정책이 해결을 허용하지 않거나 여전히 모호하면 검토; 공식 비공개는 차단 |
| 독일·미국 신규 staged 이관 | 이 계획의 자동 승인 확대 대상이 아님. 기존 M8 ownership 및 개별 공개 정책 유지 | 국가별 실제 원문/품질 검증과 이관 승인 전 staged allowlist 확대 금지. source-only/미국 PDF 검토 hold를 신규 공개 성공으로 승격하지 않음 |
| 원문 부재·수집 일시 실패 | transient는 bounded retry, 공개 가능한 원문이 없으면 게시하지 않음 | 원문 부재 사유·재평가 조건 보관. 출처 허용 없는 대체 자료로 승인하지 않음 |
| 번역·요약 불완전/중대한 충돌 신호 | 일시 처리 실패는 retry | 품질 차단은 `review_required`, 원문·승인 근거를 바꾸기 전 게시 금지 |
| 승인된 동일 콘텐츠의 기술적 재투영 | 현재 정책·head·세대가 유효하면 **관리자 재승인 없이 자동 수리**, P3 새 version 생성 없음 | 내용/정책이 바뀌었으면 기술적 수리가 아니라 새 승인·세대 평가 |

자동 품질 gate의 첫 계약은 summary JSON schema/필수 항목, 실제 한국어 제목·번역 완료, 원문 hash 결합, 사건번호·기관·주요 날짜 identity, 미완성/placeholder 및 정책이 정의한 중대한 충돌 신호를 검사하는 것이다. 단순 `status=summarized`만으로 통과시키지 않는다. 이 검사는 법률 의미의 완전한 정확성 증명은 아니며, 검사 항목·임계값·샘플 검수와 사람 검토 조건을 국가별 정책 fixture로 확정한다.

국가별 정책은 source version/hash, 검사기 버전·판정 근거, 자동/사람 actor, `policy_version`을 기록한다. 사람 승인도 공식 비공개·원문 미검증을 단순 override할 수 없다. 정책 버전 변경 시 관련 세대의 재평가 범위를 정의한다.

관련 Core 쓰기와 재처리 의도는 같은 Core commit에서 기록한다. 승인 콘텐츠가 실제로 달라지면 정식 immutable P3 개정 → 세대/outbox → 최종 검증을 진행한다. 미승인 초안 차이는 검토로 보내고 새 공개 버전으로 바로 승격하지 않는다. 기술적 수리와 재승인을 별도 명령/멱등 키로 구분한다.

### 6.3 P0-3 — P3 원자적 예약과 공통 Search 소비 계약

#### Core DB 원자성 및 outbox 필드

P3 version/head·게시 revision/state·필요한 역할별 자격·세대 현재 pointer·Search outbox를 **같은 Core DB transaction/batch**로 commit한다. version별 예약만 Ingest DB에 따로 기록하는 방식은 이 원자성 계약을 만족하지 않는다. 기존 cache/Ingest outbox를 재사용할 수 있는지 평가하되 물리 DB와 commit 경계가 일치해야 한다.

Core revision/세대 CAS 실패 시 **publication 적용과 새 outbox 등록 모두 실패**해야 한다. batch 안의 UPDATE가 0행이어도 다른 INSERT가 성공할 수 있으므로 commit 후 affected-row 검사만으로 원자성을 주장하지 않는다. 모든 관련 쓰기를 동일 성공 조건으로 묶거나 transaction 내부 실패를 유도하는 지원 방식으로 구현하고 CAS 충돌 fixture로 검증한다.

| 최소 outbox 필드 | 계약 |
|---|---|
| `outbox_id/article_id/generation_id/generation_seq` | 불변 작업 identity. unique(article, generation, operation) |
| `operation` | `project|remove`; 철회/비적격화도 새 세대의 remove 작업 |
| `expected_version_id`, `expected_publication_revision/state` | 정확한 기대 P3 head. Queue에는 outbox identity만 보내고 durable row를 재조회 |
| `policy_version/projection_input_hash`, payload 증거 참조 | 재생성 입력 및 정책 연결. 본문 전체를 Queue에 싣지 않음 |
| `status` | `pending|leased|retry_wait|verified|superseded|dead_letter` |
| `attempt_count/max_attempts/next_attempt_at` | 실제 owner의 처리 시도 기준. 중복 메시지 수로 증가시키지 않음 |
| `claimed_by/lease_expires_at/fencing_token` | claim·재claim fencing. 완료/실패 전환도 현재 fence 조건으로 작성 |
| `created_at/updated_at/last_error_code/verified_at/evidence_ref` | 원인·대기시간·검증 결과 기록 |

동일한 논리 발행 replay는 기존 version/세대/outbox를 반환한다. 수리 replay도 P3 revision을 올리지 않는다. Core commit 뒤 Queue send 전, Queue send 뒤 dispatch 확인 전 Worker가 종료돼도 dispatcher/reconciler가 durable row로 재개한다. Queue ack가 outbox/완료 원장 검증보다 앞서지 않게 하고, 응답 유실·중복 전송을 허용하는 멱등 계약으로 설계한다.

#### Consumer의 최신 세대·CAS 및 철회 tombstone

1. outbox를 claim하고 현재 Core 세대·정책·P3 version/revision/state를 읽는다. 일치하지 않는 A 작업은 `superseded`로 남기고 최신 B의 durable 예약 존재를 보장한다. A를 성공 게시로 기록하지 않는다.
2. Search DB에 article별 **적용 세대 guard**를 유지한다. `generation_seq`, `generation_id`, 정확한 P3 identity와 attempt fencing을 기록하며 낮은 seq는 적용하지 않는다. 같은 seq의 다른 identity는 충돌로 차단한다.
3. guard CAS, `search_documents` 쓰기, FTS 삭제/삽입을 **동일 Search DB transaction**으로 적용한다. CAS 0행인데 FTS가 수정되는 경로는 금지한다. 동세대 stale fence·동세대 중복·역순 세대 적용을 각각 검증한다.
4. withdraw/remove도 더 높은 세대를 반영하고 guard를 **tombstone으로 유지**한다. 행 삭제 뒤 guard까지 지워 과거 publish가 판례를 검색에 부활시키지 못하게 한다.
5. 저장 필드 검증 뒤 Core head/세대를 다시 확인한다. 바뀌면 A를 완료시키지 않고 B 작업을 보장한다. B가 이미 반영돼 있다면 A가 B를 삭제/rollback하지 않는다.
6. Core 완료 원장/outbox 최종 전환도 기대 head/세대/fence 조건으로 commit한다. Search만 성공하고 이 기록 전에 중단돼도 같은 세대 재전달로 검증·전환을 이어 간다.

**별도 DB의 한계:** 쓰기 전후 Core 조회와 Search 로컬 CAS만으로 Core B commit 직후 Search A가 물리적으로 잠시 남는 것을 없앨 수 없다. Search CAS는 B 적용 후 늦은 A의 역행을 막는다. Core head가 B인데 Search는 A인 전환 구간의 **구버전 공개 노출**은 공개 읽기 경로가 현재 Core 공개 head/세대와 Search guard를 비교해 차단해야 한다. 불일치는 검색 대기/일시적 사용 불가로 처리하고 캐시도 현재 세대에 결합한다. 철회된 판례는 즉시 공개 자격 검사에서 제외한다.

여기서 전역 단일 DB 트랜잭션이나 선형화 가능한 snapshot을 주장하지 않는다. 엄격한 무구버전 노출을 수용 기준으로 쓰려면 공개 상세·검색·관련 캐시의 최신성 검사까지 배포돼야 한다. Core 확인 실패 시 검증되지 않은 과거 검색으로 fallback하지 않는다. 이 읽기 보호 없이 M3 구현을 최신 공개 검색 보장 완료로 판정하지 않는다.

자동 staged·M8·관리자 refresh·일반 publish/withdraw·전수 Search sync 등 **모든 Search writer**가 guard 계약을 사용해야 한다. 한 writer가 무조건 upsert/delete를 계속하면 보장이 깨진다. 단계적 적용 중 보호 writer만 사용하고 나머지는 연결하거나 해당 cohort 쓰기를 중지한다.

### 6.4 P0-4 — Discovery coverage, 감사와 회복 시간

역할별 적격 집합과 Search/FTS 집합을 ID 단위로 대조하고 실제 저장 내용·FTS 및 적용 세대를 확인한다. 자격 메타데이터가 잘못 빠진 공개 의도도 따로 검사한다. 같은 잘못된 분모의 count 일치로 종료하지 않는다.

**Discovery 분류:** 모든 후보가 durable 저장돼 나중에 처리된다면 제한된 처리량은 P1이다. 상위 후보 반복으로 뒤쪽 후보가 발견되지 않거나 조회 기간 밖으로 밀리면 **P0 수집 누락**이다. 현재는 실제 누락 미입증이며, 다음 회귀를 구현 초기에 필수 gate로 실행한다.

- 목록에 신규 A/B/C가 있고 limit 1이며 상위 A가 반복되는 경우에도 B/C가 결국 durable 후보로 등록되는가?
- pagination·같은 시각의 복수 사건·목록 순서 변경·수정 원문 재등장·프로세스 재시작을 처리하는가?
- cursor/checkpoint는 **후보 durable 등록과 같은 Ingest commit**에서만 전진하고 중단/재시도로 미등록 후보를 건너뛰지 않는가?
- 공식 목록의 관측 집합과 accepted/blocked/review 후보 집합 차이를 보관하고, 실패한 목록을 빈 정상 결과로 처리하지 않는가?

limit은 목록 자체를 버리는 상한보다 **등록된 후보의 처리 예산**으로 쓰는 방향을 우선 검토한다. 출처가 안정 cursor를 제공하지 않으면 겹친 구간 재조회+URL/사건/version dedupe와 고정 tie-breaker를 설계한다. 단순 limit 확대를 누락 방지 완료로 간주하지 않는다. cursor 도입 여부·공식 목록/API 특성·최대 재조회 구간은 국가별 설계 기록으로 확정한다.

**초기 회복 설정 제안(기존 운영 설정/확정 SLO 아님):**

| 항목 | 제안 값과 판정 |
|---|---|
| 정합성 감사 | 30분마다; 발견한 mismatch의 durable 수리 등록도 확인 |
| claim lease | 기본 300초, 현재 owner만 연장 가능. 만료 시 새 fence로 재claim |
| transient 재시도 | 60초부터 지수 backoff, ±20% jitter 적용 후 15분 cap, 실제 처리 시도 최대 8회 |
| degraded 경보 | 동일 작업 연속 3회 실패 또는 due 작업의 claim 대기 30분 초과 |
| 복구 최대 예산 | 첫 실패 후 120분 또는 8회 실패 중 먼저 도달하면 `dead_letter`와 담당자 알림. 조용히 재시도를 멈추지 않음 |
| 완료 지연 목표 | Discovery 이후 자동 승인 가능한 판례의 검색 검증 p95 120분. 일일 발견 대기 및 사람 검토 시간은 따로 측정 |

dispatcher cadence를 고려해 `next_attempt_at`과 실제 claim 차이를 측정한다. 15분 dispatch 설정에서 60초 재시도를 약속하지 않는다. Queue retry와 durable outbox retry의 owner·중복 방식을 하나로 정하고 실측에 따라 cadence/값을 조정한다. 장기 장애·예산 초과 시 무한 자동 복구를 보장한다고 표현하지 않는다.

정책 차단/사람 검토는 transient 재시도 횟수에 포함하지 않는다. 관리자 redrive는 오류·현재 승인/head/세대를 재평가하고 감사 근거와 추가 예산을 기록한다. 과거 generation을 새 공개 head로 억지 재실행하지 않는다.

### 6.5 P0-5 — M1–M5 구현 단위, 배포와 롤백

P0-1과 P0-3은 통합 결과로 완성하되 코드 작업은 아래 작은 단위로 나눈다. **M1–M4는 선택한 보호 cohort의 최소 E2E 완성 단위**, M5는 모든 게시/철회 경로로의 확장이다. M1–M3 단독 성공은 E2E 완료가 아니다. 운영 잔여 **콘텐츠 drift 3건 + FR L 후검사 1건**은 별도로 처리한다.

| 단위 | 구현 범위 | 필수 검증·완료 판정 | 배포/되돌림 경계 |
|---|---|---|---|
| **E2E-P0/M1** | 승인 key·generation identity·현재 pointer·최소 원장·승인 전 후보 lineage | 한 판례의 Crawl→Core→승인→P3 version 추적, 같은 입력 dedupe 및 실질 변경 seq 증가 | additive schema와 기록 flag. 기존 Worker 동작 검증; flag off 후 원장 보존 |
| **E2E-P0/M2** | Core P3 transition과 세대/outbox 원자적 예약·dispatcher | commit 직후 강제 종료/Queue 응답 유실/CAS 충돌에도 유실 없음, 실패 commit의 고아 작업 없음 | 제한된 기록 시작. consumer 중지 가능하지만 commit된 작업 삭제 금지 |
| **E2E-P0/M3** | version별 Consumer·retry·fencing·Search guard·철회 tombstone·공개 읽기 최신성 검사 | A/B 역순·동세대 stale fence·중단/중복·철회 후 A 재등장 회귀 통과; CAS 실패 시 Search/FTS 불변 | cohort의 모든 writer 보호 후 활성화. 후퇴 시 호환 보호 consumer 유지하거나 cohort 쓰기/노출 중지 |
| **E2E-P0/M4** | 집합·저장 Search/FTS 내용·실제 API validator 및 조건부 완료 원장 전환 | 손상 본문/FTS·검증 중 B 개정/API 실패를 검출, 정확한 세대만 `completed_verified` | 소규모 cohort의 실제 DB/API 증거. validator flag off는 완료 판정 중지이며 검증된 수리 기능은 유지 |
| **E2E-P0/M5** | staged/M8/관리자 refresh/일반 publish/withdraw·전수 sync 공통 적용 | 진입 경로별 같은 세대/outbox/검증 실행, 비적격 제거/캐시까지 증거 | writer inventory의 미보호 0, 단계적 전체 적용; 구버전 무조건 writer로 롤백 금지 |

M1 기록·M2 예약만 활성화할 때 기존 public path를 새 검증 완료로 표시하지 않는다. M3의 공개 읽기 보호가 활성화되기 전에는 물리적 검색 회복만 관측한다. M4의 첫 cohort에서 제외한 writer가 해당 article을 수정할 수 없도록 소유권을 통제한다. M5는 경로별 회귀/배포 gate를 가지며 실제 부분 업데이트·철회를 누락하지 않는다.

**배포 순서와 호환 계약:**

1. **최신 main 기반 준비:** 다른 작업의 변경을 포함하지 않는 별도 branch/작업 트리에서 검토 SHA, writer inventory, additive migration 및 flags를 고정한다.
2. **Schema 선반영:** 새 테이블/nullable 컬럼/index를 추가하고 기존 데이터·Worker와 호환성을 확인한다. 기존 컬럼 삭제/이름 변경/강제 non-null 재작성은 첫 배포에서 하지 않는다. backfill은 역할별 정책을 적용한 재개 가능한 작업으로 수행한다.
3. **읽기 전용/shadow:** generation 예상값·outbox 예약 예정·실제 투영/집합 비교를 쓰기 없이 검사한다. 존재하지 않는 세대의 완료 기록을 backfill하지 않는다.
4. **소규모 적용:** 프랑스·스페인의 명시 cohort와 보호 writer만 활성화한다. schema/read guard/consumer가 준비된 뒤 예약을 활성화하고 M1–M4 gate를 검증한다. 실패 주입은 격리 fixture, Production은 실제 정상·복구 관측으로 확인한다.
5. **경로/전체 적용:** M5 경로별 통과와 drift·pending age·오류 예산·공개 API 검증 후 범위를 확대한다. 실제 Worker version/source SHA·flag 값·DB 세대/증거를 남긴다.
6. **롤백:** 자동 승인/새 예약 범위를 축소하고 이미 commit된 pending 작업·schema·tombstone을 보존한다. 최신 세대를 무시하는 이전 writer를 재활성화하지 않는다. 보호 consumer/read 경로가 없는 버전으로 돌아가야 한다면 cohort 쓰기와 구버전 공개 응답을 중지하고 필요한 수리는 호환 경로로 진행한다. 콘텐츠 rollback도 정식 transition으로 새 세대를 생성한다.

**혼용 검증:** schema 선반영 단계의 구 Worker+신 Schema, 신 Worker+신 Schema, rollback 가능한 구 Worker의 pending/새 guard 대응을 fixture와 실제 배포 증거로 확인한다. 신 Worker+구 Schema는 readiness 실패로 새 기능을 시작하지 않고 명시적 운영 오류로 관측한다. 기존 Worker와 새 보호 writer를 같은 cohort에 동시에 무제약으로 실행하는 혼용은 허용하지 않는다. 호환 Worker version·migration version 표를 구현 PR에 첨부한다.

| 실패/경합 시나리오 | 기대 결과 |
|---|---|
| P3 commit 직후 Worker 종료, Queue send 응답 유실 | durable outbox 재개, P3 version/revision 추가 생성 없음 |
| A 발행→B 발행→늦은 A, B 반영 뒤 A 쓰기, 동세대 stale fence | A superseded/CAS 실패, B 문서·FTS·guard 불변 |
| withdraw(B) 후 publish(A) 재전달 | B tombstone으로 검색 부활 차단, 공개 자격/캐시 검사 |
| Search commit 후 Core 완료 기록 전 중단 | 동일 세대 재전달로 저장 검증과 완료 전환 재개 |
| 실제 Search 본문만 손상, checksum 값 유지 | 재계산 mismatch, 완료 금지·수리 |
| FTS title/본문만 손상 또는 ID 집합이 같은 수량으로 바뀜 | 내용/집합 mismatch, 완료 금지·수리 |
| 검사 중 Core/P3/정책/태그 변경, API 장애 | 완료 CAS 실패 또는 retry, 새 세대 보장 |
| FR/ES 자동 승인 가능 신규 판례 및 품질 차단 사례 | 각 국가 정상 건은 무인 완료, 차단 건은 이유 있는 검토/비공개 |
| 공식 목록 신규 2건 이상·상위 후보 반복·checkpoint 재시작 | 미등록 후보 유실 없음, coverage 차이와 복구 증거 |
| 구/신 Worker·schema 혼용 및 rollback | 미보호 writer 역행 없음, pending 작업/tombstone 보존 |

테스트 통과, 코드 리뷰, additive schema readiness, 실제 Worker 배포 및 cohort DB/API 검증을 각각 기록한다. 어느 단계의 local 성공도 다음 단계의 운영 증거로 대체하지 않는다.

## 7. 첫 구현 단위와 전체 P0 종료 기준

### 7.1 P0-1 + P0-3 첫 구현 단위 완료

**M1–M4 최소 cohort 완료**는 다음 조건을 모두 만족해야 한다.

- 선택한 cohort의 후보→Core→승인 key→generation→P3→Search lineage가 존재하고, 같은 입력 재전달의 generation/version/revision 증분은 0이다.
- P3 commit과 durable Search 예약의 원자성 및 CAS 충돌 테스트가 통과한다. commit 직후 중단·Queue 응답 유실에도 고아/유실 작업이 없다.
- 보호 cohort의 모든 writer가 Search guard를 사용한다. 역순 A/B·동세대 stale fence·철회 tombstone 테스트가 통과하고 공개 읽기에서도 최신 세대 불일치 노출이 차단된다.
- ID 집합·실제 저장 문서 checksum 재계산·FTS 필드·version/head 안정성·실제 API 응답을 함께 검증하며, 실패 시 `completed_verified`가 기록되지 않는다.
- 자동 승인 가능한 신규 판례가 사람 개입 없이 완료되고, 검토/정책 차단 판례는 승인 성공과 구분된다.
- schema/Worker 호환·flag 축소·pending 작업 보존 rollback을 확인하고 코드 commit/Worker version·DB/API 증거를 남긴다.

이 결과는 **보호 cohort의 첫 구현 단위 완료**다. M5의 모든 진입 경로 확장, 잔여 데이터·Discovery 전수 coverage·48시간 운영 관측까지 완료했다는 뜻이 아니다. Production에서 적합한 신규 판례가 아직 발생하지 않았다면 fixture/배포 완료와 신규 판례 실증 대기를 구분해 기록한다.

### 7.2 전체 P0 종료

전체 종료는 위 첫 구현 단위와 M5를 완료하고 다음을 모두 충족한 검증 기록으로 판단한다.

- **잔여 콘텐츠 drift 3건**의 출처·의미·승인 검토와 필요한 정식 개정이 끝나고, 이미 검색 행이 회복된 **FR L 후검사 1건**의 공개 API·FTS 내용·회복 실행 증거가 확인된다. 검토 차단을 성공 게시로 바꾸지 않는다.
- 승인 최신 콘텐츠–P3 drift 0, Core/P3 참조 오류 0, legacy 필수 freshness 누락 0 및 enrichment anchor 오류 0이다. 초안 차이는 검토 원장에 연결하고 미승인 내용을 게시해 raw drift를 억지로 없애지 않는다.
- 공개 의도의 자격 메타데이터 누락 0, 적격 ID 집합과 Search/FTS 집합 차이·중복·저장 내용/세대 mismatch 0, 비적격 잔존 0이다. 정책상 제외는 승인 근거로 설명된다.
- 프랑스·스페인 각각 실제 신규 공개 가능 판례의 무인 전체 체인 및 자동/사람 승인 분기·실패/중복/사후변경을 확인한다. 독일·미국까지 일반화하지 않는다.
- Discovery 다수 후보/상위 반복/재시작의 누락 방지 gate를 통과하고 국가별 coverage를 관측한다. 미발견 누락이 확인되면 P0로 남긴다.
- 모든 게시·철회·Search writer의 공통 세대/outbox/guard 적용을 확인한다. 미보호 writer나 설명 없는 데이터 손상이 남으면 종료하지 않는다.
- 최소 **48시간 및 두 번의 일일 Discovery 주기** 동안 감사·수리 대기·재시도/실패 예산·실제 처리 목표를 관측한다. unresolved dead-letter·유실 예약·수리 누락이 있으면 종료하지 않는다.
- 코드 SHA, schema/flags, 실제 Worker version, 검사 시각·generation/P3 identity·DB/공개 API·rollback 증거를 함께 남긴다. 문서·배포·일부 복구·과거 Job 성공만으로 종료하지 않는다.

## 8. 읽기 전용 재검증 방법

아래 스크립트는 검토 기준 main 코드와 의존성이 있는 checkout에서 실행한다. 오래된 기본 checkout에 파일이 없다면 해당 버전의 checkout을 먼저 준비해야 한다. 이번 작업은 작업 트리를 reset/merge하거나 다른 변경을 덮어쓰지 않았다.

```powershell
pnpm exec tsx scripts/audit-p3-snapshot-drift.ts
pnpm exec tsx scripts/audit-p3-refresh-readiness.ts
```

첫 도구는 snapshot 비교, 둘째 도구는 **지정 네 ID**의 관리자 사전검사다. 둘 다 단독으로 freshness·전수 검색·무인 E2E를 검증하지 않는다. snapshot 감사의 기존 SQL은 Core가 없는 head를 제외할 수 있으므로 아래 head 기준 검사를 함께 사용한다.

### 8.1 Core head 참조·snapshot·legacy freshness

```sql
-- worldcons_core: 집계 중 NULL과 누락 head를 숨기지 않는다.
SELECT COUNT(*) AS published_heads,
  COALESCE(SUM(CASE WHEN a.id IS NULL THEN 1 ELSE 0 END),0) AS missing_article,
  COALESCE(SUM(CASE WHEN v.id IS NULL THEN 1 ELSE 0 END),0) AS missing_or_foreign_version,
  COALESCE(SUM(CASE WHEN a.id IS NOT NULL AND v.id IS NOT NULL
    AND (a.cleaned_text IS NOT v.cleaned_text
      OR a.summary_json IS NOT v.summary_json
      OR a.korean_title IS NOT v.korean_title
      OR a.canonical_url IS NOT v.canonical_url)
    THEN 1 ELSE 0 END),0) AS raw_snapshot_drift,
  COALESCE(SUM(CASE WHEN v.id IS NOT NULL AND v.version_role IS NULL
    AND f.version_id IS NULL THEN 1 ELSE 0 END),0) AS legacy_freshness_missing,
  COALESCE(SUM(CASE WHEN v.id IS NOT NULL AND v.version_role IS NULL
    AND f.version_id IS NOT NULL AND f.freshness<>'current'
    THEN 1 ELSE 0 END),0) AS legacy_freshness_not_current
FROM article_publications_p3 p
LEFT JOIN articles a ON a.id=p.article_id
LEFT JOIN article_content_versions_p3 v
  ON v.id=p.version_id AND v.article_id=p.article_id
LEFT JOIN legacy_version_freshness_classifications_v4 f ON f.version_id=v.id
WHERE p.state='published';
```

`IS`/`IS NOT`는 SQLite의 NULL-safe 비교다. `raw_snapshot_drift`는 승인 여부를 판정하는 쿼리가 아니므로 승인·검토 원장과 연결해야 한다.

### 8.2 실제 Search 적격 집합

```sql
-- worldcons_core: d1-sync.ts의 역할별 gate2 조건.
SELECT p.article_id,p.version_id,p.revision,v.version_role,v.content_hash
FROM article_publications_p3 p
JOIN article_content_versions_p3 v
  ON v.id=p.version_id AND v.article_id=p.article_id
WHERE p.state='published'
  AND (
    (v.version_role IS NULL
      AND EXISTS (SELECT 1 FROM legacy_version_freshness_classifications_v4 f
        WHERE f.version_id=v.id AND f.freshness='current')
      AND NOT EXISTS (SELECT 1 FROM case_catalog_publications_v1 c
        WHERE c.article_id=v.article_id AND c.state='published'))
    OR
    (v.version_role='enrichment_full'
      AND EXISTS (SELECT 1 FROM case_catalog_publications_v1 c
        JOIN article_content_versions_p3 anchor ON anchor.id=c.source_anchor_version_id
        WHERE c.article_id=v.article_id AND c.state='published'
          AND c.source_anchor_version_id=v.source_anchor_version_id
          AND anchor.source_content_hash=v.enrichment_source_content_hash))
  )
ORDER BY p.article_id;
```

이 결과의 ID 집합을 Search/FTS 집합과 외부 verifier에서 대조한다. 역할별로 제외된 published head도 별도로 검토한다. SQL은 별도 D1 간 JOIN을 가정하지 않는다.

### 8.3 Ingest 상태와 lineage

```sql
-- worldcons_ingest: 고정된 KST 관측 구간을 UTC 경계로 표기.
SELECT stage,status,COUNT(*) AS n,MIN(created_at) AS first_created,
  MAX(updated_at) AS last_updated
FROM ingest_stage_jobs
WHERE created_at >= '2026-10-08T15:00:00Z'
  AND created_at < '2026-10-10T15:30:22.317Z'
GROUP BY stage,status ORDER BY stage,status;

-- 실제 Core UUID의 후반부 이력. 새 감사 시 조회 구간/ID를 명시한다.
SELECT id,article_id,source_key,stage,status,source_version,content_hash,
  result_ref,created_at,updated_at,last_error_code
FROM ingest_stage_jobs
WHERE article_id IN (
  '16b4fc11-d9cc-4e5b-b8e5-acf687ab760e',
  'd31eecc5-4e74-440f-ba6e-1561911bd68c'
)
ORDER BY article_id,created_at,stage;
```

전반부 후보 이력은 Normalize의 `result_ref`와 R2 payload 참조로 이어 붙인다. 상태 집계에 더해 dispatch outbox, stage events, Job `dead_letter`와 물리 Queue DLQ를 별도 조회한다. 이번 집계 구간에 terminal Job이 없다는 사실만으로 DLQ가 비었다고 단정하지 않는다.

### 8.4 네 판례의 Search/FTS 존재 및 식별 정보

```sql
-- worldcons_search: 인자 바인딩 도구가 없어도 실행 가능한 고정 cohort.
WITH cohort(article_id) AS (VALUES
  ('0e25c3b4-3449-46b5-9270-fd0e37f9e4b7'),
  ('16b4fc11-d9cc-4e5b-b8e5-acf687ab760e'),
  ('15560a96-c510-427c-aaf4-a5d57ef5bd50'),
  ('d31eecc5-4e74-440f-ba6e-1561911bd68c')
)
SELECT c.article_id,
  (SELECT COUNT(*) FROM search_documents d WHERE d.article_id=c.article_id) AS document_count,
  (SELECT COUNT(*) FROM search_fts f WHERE f.article_id=c.article_id) AS fts_count,
  (SELECT checksum FROM search_documents d WHERE d.article_id=c.article_id) AS checksum,
  (SELECT projection_version FROM search_documents d WHERE d.article_id=c.article_id) AS projection_version
FROM cohort c ORDER BY c.article_id;
```

checksum/수량만으로 내용 검증을 끝내지 않는다. 승인된 정확한 P3 version과 태그·review 입력으로 `buildSearchProjection`을 실행해 기대 문서/FTS를 만들고, 실제 저장 문서의 모든 논리 필드에서 checksum을 재계산한 뒤 FTS 필드도 대조한다. 현재 스키마에 P3 `version_id` 컬럼이 있다고 가정하는 SQL을 작성하지 않는다. 내용 동일성 외에 version lineage는 제안 원장에서 별도로 보증한다.

직접 Wrangler 조회는 같은 config의 해당 DB에 `d1 execute ... --remote --json --command '<SELECT>'`로 실행한다. raw `?` placeholder는 CLI에서 자동 바인딩되지 않는다. 인증 오류가 나면 그 조회를 **미검증**으로 남기고 기존 수치를 현재 값으로 재사용하지 않는다.

## 9. 운영 원칙과 실행 기록

- 관리자 인증은 MasterDash → WorldCons SSO 및 기존 관리자 CSRF 경로를 사용한다.
- 공개 P3 immutable 원본·게시 원장·Search 테이블을 ad-hoc SQL로 고치지 않는다. 정식 transition·분류·투영 수리 경로를 사용한다.
- 공식 원문 미검증·비공개·안전 플래그 충돌을 자동 게시로 해소하지 않는다.
- 실패/검토/정책 차단을 성공률 분모에서 숨기지 않는다. Discovery coverage와 발견 후보의 E2E 검증율을 함께 관리한다.
- 담당자, 후보/원문/승인 snapshot, 전후 P3 version/revision, Worker version/source SHA, 수리 Job, 검증 시각·결과·증거 링크를 각 작업 기록에 남긴다.

**현재 남은 작업:** 부분 회복된 FR L의 실제 공개 검색·FTS 내용 및 회복 이력 검증, 세 drift 건의 출처·의미·승인 검토와 정식 개정, Catalog 제외 건의 의도 확인, version별 내구성 있는 수리·최종 검증 원장, 프랑스·스페인 신규 무인 E2E 실증이다.

## 10. 외부 보완 의견의 반영과 검증 한계

제공된 「WorldCons Codex 수정사항 분석 — 1차 확인」의 핵심 지적을 반영했다. 완료 원장·공통 Search 수리 outbox를 실제 구현의 첫 단위로 묶고, 개별 운영 복구와 구조 개선의 우선순위를 분리했다. 미추적 산출물과 60커밋 뒤처진 checkout, 다른 작업의 Watchdog/운영 UI 변경이 이번 E2E 코드 수정이 아니라는 점도 명시했다.

검토자는 별도 Production 재조회에서 국가별 공개 수 **독일 483·프랑스 395·스페인 424·미국 136**, Search 문서 및 FTS 각각 **1,437**, FR L 1/1 회복과 drift 3건을 보고했다. 이는 이 문서의 후속 관측 총계와 일치하지만, **검토자의 재조회 보고**이며 이번 문서 검토에서 새로 직접 실행한 감사로 취급하지 않는다. 제공된 의견에는 정확한 UTC 조회 시각·원본 SELECT 응답이 첨부되지 않았으므로 기존 증거 JSON의 시각이나 내용을 덮어쓰지 않았다. 독립 검증 증거가 제공되면 별도 시각·쿼리·응답으로 추가한다.

수량 일치는 ID 집합, 저장 본문/FTS 필드, P3 version lineage, 공개 API 노출을 모두 검증한 결과가 아니다. **현재 판정은 분석 보완 완료, 구조 개선 구현·배포 미완료, P0 종료 불가**다.

### 10.1 추가 계획 검토 의견 반영

제공된 「WorldCons P0 개선계획 재검토 결과」의 8개 권고를 6.1–6.5절과 7절에 반영했다. 처리 세대 식별을 기존 `source_version`과 구분하고, Core 발행/outbox 원자성, Search 로컬 CAS·fencing·철회 tombstone, 공개 읽기의 세대 확인을 하나의 계약으로 묶었다. 별도 DB의 조회 전후 검사만으로 구버전 공개 노출이 완전히 차단된다는 주장은 하지 않는다.

자동 승인과 사람 검토를 국가별로 구분해 정상 신규 판례를 모두 관리자 대기로 만들지 않도록 했다. Discovery 후보 유실은 입증 시 P0이고 단순 처리 지연은 P1임을 명시했다. 회복 예산·경보·M1–M5의 테스트/배포/롤백 및 첫 cohort 완료와 전체 P0 종료도 분리했다.

추가 검토자가 다시 보고한 공개 1,438·drift 3·freshness 누락 0·Search/FTS 각 1,437은 외부 재조회 보고로 유지한다. 이번 계약 보완에서 Production 조회/쓰기·코드 구현·배포·commit/push는 수행하지 않았고, 기존 읽기 전용 증거 JSON도 수정하지 않았다.
