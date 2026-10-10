# WorldCons 자동수집 E2E 정합성 결함 분석 및 P0 개선 계획

> **작성·검증일:** 2026-10-11 (KST)  
> **범위:** `worldcons` / `worldcons-ingest` / Production D1 Core·Ingest·Search  
> **분류:** P0 운영 결함 분석 및 재발 방지 계획  
> **중요:** 이 문서는 진단 기록이며 **잔여 데이터 복구 또는 E2E 정상화 완료 선언이 아니다.**

## 1. 결론

Discovery → Crawl → Normalize → Translate/요약 → Public Judgment → Publish(P3) → Search/FTS **7단계 구현과 실제 Production 실행 이력은 존재한다.** 따라서 파이프라인 자체가 미구현된 것은 아니다.

그러나 **단계별 Job `succeeded`가 최신 Core, 공개 P3, Search/FTS 간의 현재 정합성을 지속적으로 보증하지 못한다.** 이미 완료된 작업 이후 Core 또는 공개 버전이 바뀌거나 검색 자격(freshness)이 누락되면, 성공 이력과 공개·검색 상태가 달라질 수 있다. 이것이 확인된 E2E 보장 결함이다.

**요구 완료 계약:** Discovery가 발견한 공개 가능한 판례는 출처 검증·번역·요약·P3 발행·검색 투영과 버전 일치 검사까지 하나의 논리적 처리 단위로 완료되어야 한다. 공식 원문 부재·비공개 정책·검토 필요 건은 성공 게시가 아닌 명확한 차단/검토 상태로 기록한다.

## 2. Production 실측 증거 — 2026-10-11

| 항목 | 결과 | 판단 |
|---|---:|---|
| 공개 P3 판례 | **1,428건** | Core `article_publications_p3.state='published'` |
| 최신 Core ↔ P3 콘텐츠 불일치 | **3건** | 본문·요약·한글 제목 비교 |
| 게시 P3 버전 freshness `current` 누락 | **1건** | 공개 검색 자격 정보 없음 |
| 해당 누락 판례 Search/FTS | **0건 / 0건** | 실제 검색 누락 |
| 최근 자동수집 단계 Job | Discovery부터 Search까지 단계별 **2건 성공** | 실행 체인이 존재함; 이후 정합성의 증거는 아님 |

### 확인된 판례

| 판례 | Article ID | 현재 관측된 상태 |
|---|---|---|
| FR 2026-1223 QPC | `0e25c3b4-3449-46b5-b8e5-acf687ab760e` | 본문·요약·제목 drift. Search/FTS 존재 |
| FR 2026-335 L | `16b4fc11-d9cc-4e5b-b8e5-acf687ab760e` | P3 revision 2로 개정, Core와 내용 일치. **freshness 누락 및 Search/FTS 0건** |
| ES AUTO 43/2026 | `15560a96-c510-427c-aaf4-a5d57ef5bd50` | 본문·요약·제목 drift. Search/FTS 존재 |
| ES SENTENCIA 59/2026 | `d31eecc5-4e74-440f-ba6e-1561911bd68c` | 요약·제목 drift, 과거 출처 메타데이터 충돌. Search/FTS 존재 |

**주의:** 콘텐츠 불일치 3건과 freshness 누락 1건은 **서로 다른 결함 유형**이다. 검색 문서가 존재하는 세 건도 최신 P3 콘텐츠가 반영됐는지 별도 확인이 필요하다.

`worldcons_ingest.ingest_stage_jobs`의 FR `16b4…` / ES `d31e…` 관련 `translate → public-judgment → publish → search` 작업에 성공 기록이 있다. 최근 7단계 Job 2건 성공 집계도 확인했다. **이는 각 단계의 당시 성공 기록만 입증한다.** 문제가 최초 실행 중에 발생했는지, 이후 재처리/관리자 변경으로 발생했는지는 추가 추적이 필요하므로 인과를 단정하지 않는다.

## 3. 현재 구현 구조 및 보장 범위

| 구성 요소 | 책임 및 확인된 동작 |
|---|---|
| `lib/cloudflare/ingest-stages/contracts.ts` | Discovery→Crawl→Normalize→Translate→Public Judgment→Publish→Search 단계와 다음 단계 계약 |
| `workers/async-pipeline/src/ingest-stage-handlers.ts` | 출처 후보 fan-out, Core ID 매핑, 번역 완료 재조회, 공개 적격 심사, 게시 및 검색 단계별 성공/차단 처리 |
| `lib/cloudflare/ingest-stages/dispatcher.ts` | Ingest D1에서 이전 Job 완료와 다음 Job 생성을 원자적 batch 처리; idempotency / fencing 지원 |
| `workers/async-pipeline/src/ingest-stage-consumer.ts` | Queue lease, retry, dead letter, 단계별 Job 성공 기록 |
| `workers/async-pipeline/src/index.ts` | `worldcons` 서비스 바인딩 사용. 15분 dispatch cron; 운영 `DISPATCH_LIMIT=1`, 출처별 Discovery `BOOTSTRAP_LIMIT=1` |
| `lib/cloudflare/publication/d1-publication-drain.ts` 및 `lib/cloudflare/core-write/authority.ts` | P3 개별 발행, immutable version, revision, freshness 및 감사 처리 |
| `lib/cloudflare/search-projection/d1-sync.ts` | 검색 문서·FTS 증분 투영과 각 0/1행 일치 검사 |

**제약:** Ingest D1, Core D1, Search D1은 별도 물리 DB다. 전체를 단일 DB 트랜잭션으로 묶을 수 없으므로 **내구성 있는 Job/outbox, 멱등 재시도, 최종 교차 DB 검증**으로 논리적 E2E 완료를 구현해야 한다.

## 4. 확인된 결함과 원인/미확인 사항

| 코드 | 결함 또는 위험 | 증거 수준 | 영향 |
|---|---|---|---|
| **P0-A** | 단계별 `succeeded` 이후 **현재 Core/P3/Search 일치에 대한 최종·사후 보장 부족** | 운영 증상 및 단계별 코드 확인 | 성공 처리된 판례가 나중에 최신 공개·검색 상태와 불일치 |
| **P0-B** | 신규 P3 버전 freshness 누락 시 검색 투영이 비적격 처리 | FR 2026-335 L 실제 P3 rev2 / freshness 없음 / Search·FTS 0 | 게시 성공인데 검색에서 사라짐 |
| **P0-C** | Core 내용 변경 후 P3 자동 재개정·재검색 보장 미흡 | Production 콘텐츠 drift 3건 | 과거 P3 내용 노출 및 검색 불일치 |
| **P0-D** | 관리자 발행 경로와 자동수집 경로가 공유 완료 계약을 일관되게 검증하지 않음 | 관리자 P3 개정 후 검색 누락 실제 발생 | 한 경로 수정이 다른 경로에 적용되지 않을 위험 |
| **P1-E** | 15분 cron / stage별 dispatch 1건으로 종단 지연 증가 | 배포 설정과 7단계 실행 시각 확인 | 백로그·완료 지연 위험 |
| **P1-F** | 스페인 과거 `sourceTextStatus=not_available` 메타데이터가 새 공식 본문과 충돌 | ES SENTENCIA 59/2026, Core 본문 66,952자 | 출처 안전 판단 왜곡 및 자동 재발행 차단 |

### 수정이 반영됐지만 완료 판정을 내릴 수 없는 사항

- 신규 P3 버전 생성 시 freshness를 **같은 Core D1 발행 batch**로 기록하도록 보완한 코드가 GitHub `main`의 `31603a3` 커밋과 Production Worker에 반영됐다. **기존 누락된 1건은 별도 수리 전까지 미해결이다.**
- 공식 HJ 원문 검증/관리자 `refresh-p3` 및 검색 재투영 경로가 추가됐다. **관리자 수동 갱신이 가능하다는 사실은 무인 자동수집 E2E 검증을 대체하지 않는다.**
- Core 사후 변경에 대한 전자동 재개정·검색 복구, 중앙 완료 원장, 신규 판례 end-to-end 실증이 완료됐다는 증거는 아직 없다.

## 5. P0 수정 계획 및 완료 기준

### P0-1 — 종단 완료 계약 정의

기존 단계별 Job 상태 외에 `articleId + sourceVersion/contentHash + publicationVersionId`를 연결한 **최종 상태 원장**을 둔다. `completed_verified`는 검증 당시 아래가 모두 참일 때만 기록한다.

1. 공식 원문에 대한 수집·공개 허용 근거와 버전 해시가 존재한다.
2. 해당 원문 버전의 번역·요약과 한국어 제목이 Core에 저장돼 있다.
3. 최신 승인 Core와 공개 P3 버전의 본문·요약·제목·canonical URL이 일치한다.
4. P3 version ID의 freshness가 `current`이며 revision·감사 이력이 유효하다.
5. Search 문서 1건과 FTS 1건이 존재하고 **실제 공개 P3 버전/콘텐츠와 일치**한다.

정책상 비공개, 원문 없음, 검토 대기는 `blocked`/`review_required`로 명확히 구분한다. 각 단계 `succeeded`만으로 `completed_verified`를 만들지 않는다.

### P0-2 — Core 변경 후 자동 재처리

공개 판례에 Core 내용이 새로 기록되면 최신 source/content hash와 P3 revision의 차이를 감지하여 정식 새 P3 immutable version 생성 → Search 재투영을 예약한다. 공개 안전 정책이 바뀌었거나 공식 원문이 불확실하면 게시하지 않고 재심사 상태로 보낸다. **중복 Queue 재전달에도 P3 중복 개정이 없어야 한다.**

### P0-3 — 게시 이후 Search 장애 자동 회복

P3 개정과 freshness·감사·outbox 등록을 Core D1에 일관되게 기록하고, Search D1 호출이 실패하면 Job/outbox를 유지해 재시도한다. 이미 최신 P3가 발행돼 있으면 **버전을 다시 만들지 않고 freshness·Search/FTS만 복구**하는 경로가 있어야 한다.

### P0-4 — 사후 정합성 감사 및 알림

주기적으로 Core↔P3 snapshot, freshness, 검색 문서/FTS **수량과 버전 식별자**를 대조한다. mismatch 시 재개정, 검색 복구, 정책 차단 중 적합한 경로로 자동 분기하고 장애·재시도·dead-letter를 관측 가능하게 기록한다. MasterDash 관리자 SSO 경로의 수동 갱신도 같은 검사에 포함한다.

### P0-5 — E2E 실운영 검증 및 기존 잔여 건 해결

실제 신규 공개 가능한 판례 1건을 Discovery부터 Search까지 article/version 기준으로 추적한다. 실패 주입·재시도·중복·검색 장애·Core 사후변경·정책상 차단을 포함한다. 운영 관리자 개입 없이 **신규 공개 가능 판례 `completed_verified`** 확인을 필수로 한다.

**완료 기준:** Production의 Core–P3 콘텐츠 drift **0건**, freshness 누락 **0건**, 공개 검색 대상의 Search/FTS 누락 **0건**을 실측하고, 새 판례 E2E 재현 테스트에 통과한다. 코드 커밋/배포 또는 일부 판례 복구만으로 P0 종료를 선언하지 않는다.

## 6. 재검증 명령 및 읽기 전용 SQL

```bash
pnpm exec tsx scripts/audit-p3-snapshot-drift.ts
pnpm exec tsx scripts/audit-p3-refresh-readiness.ts
```

```sql
-- worldcons_core
SELECT COUNT(*) AS published,
  SUM(CASE WHEN a.cleaned_text IS v.cleaned_text
        AND a.summary_json IS v.summary_json
        AND a.korean_title IS v.korean_title THEN 0 ELSE 1 END) AS snapshot_drift,
  SUM(CASE WHEN f.freshness='current' THEN 0 ELSE 1 END) AS freshness_not_current
FROM article_publications_p3 p
JOIN articles a ON a.id=p.article_id
JOIN article_content_versions_p3 v ON v.id=p.version_id
LEFT JOIN legacy_version_freshness_classifications_v4 f ON f.version_id=v.id
WHERE p.state='published';

-- worldcons_ingest
SELECT stage,status,COUNT(*) AS n,MAX(updated_at) AS last_updated
FROM ingest_stage_jobs
WHERE created_at >= '2026-10-09T00:00:00Z'
GROUP BY stage,status ORDER BY stage,status;

-- worldcons_search (특정 판례 ID마다 각각 수행)
SELECT COUNT(*) AS n FROM search_documents WHERE article_id = ?;
SELECT COUNT(*) AS n FROM search_fts WHERE article_id = ?;
```

Core/Ingest/Search는 서로 다른 DB이므로 각 쿼리를 해당 DB에 실행한다. 동시 조회 결과의 시간 차이를 고려하고, 완료 검증은 P3 **version ID** 및 데이터가 일치하는지도 점검한다.

## 7. 운영 원칙

- 관리자 인증은 **MasterDash → WorldCons SSO** 경로만 사용한다.
- 공개 P3 immutable 원본을 SQL로 직접 덮어쓰지 않는다.
- 출처가 비공개이거나 원문 미검증인 판례는 자동 게시하지 않는다.
- 단계별 처리율과 별개로 **E2E 최종 검증율, Core–P3 drift, freshness 누락, Search/FTS 누락, 최대 처리시간, dead-letter** 지표를 관리한다.
- **핵심 판단:** 7단계는 구현돼 있지만 'Discovery 한 건 → 검색까지 검증 완료'라는 최종 결과를 지속 보증하지 못하는 **P0 정합성 문제**가 남아 있다.
