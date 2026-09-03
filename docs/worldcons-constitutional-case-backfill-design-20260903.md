# WorldCons 세계 헌법판례 전수 백필·검색 확장 설계 v2.2

- 최초 작성: 2026-09-03
- 심층 검토·개정: 2026-09-03
- 대상 프로젝트: `worldcons`
- 상태: Gate 1~3 로컬 구현과 production-shaped PostgreSQL 검증 완료, 운영 migration·source policy 승인·Spain canary 전
- 운영 스택: Vercel + Supabase/PostgreSQL
- AI·임베딩 공급자: Gemini 전용

---

## 0. 문서 목적과 개정 결론

WorldCons를 “AI 요약이 완료된 일부 판례 모음”에서 다음 구조로 확장한다.

> 공식 기관이 공개한 판례의 식별자·메타데이터·허용된 원문을 먼저 검증 가능한 Catalog로 만들고, Gemini 번역·요약·임베딩은 검색 가능 여부와 분리하여 점진적으로 부가한다.

기존 설계의 방향은 타당했지만, 그대로 구현하면 다음 문제가 생길 수 있었다.

| 기존 제안 | 문제 | v2 결정 |
|---|---|---|
| `source_backfill_runs`와 cursor만 저장 | 개별 항목 누락·재시도·완료 증명이 불가능 | 불변 inventory snapshot + 항목별 ledger 추가 |
| `source_record_id`, `ecli` 전역 unique | 국가·기관·표기 변형 간 충돌 위험 | `case_identifiers`에서 source scope와 정규화 버전을 함께 관리 |
| `corpus_visibility=enriched` | 공개 상태와 AI 처리 상태가 섞임 | authority, publication, enrichment, text policy를 독립 상태로 분리 |
| 별도 `case_enrichment_queue` | 기존 P1 `admin_commands`의 lease/fencing/retry와 중복 | 실행 큐는 P1을 재사용하고 도메인 상태만 별도 저장 |
| `/cases/{slug}` 신설 | 기존 `/articles/{slug}`와 canonical URL 중복 | `/articles/{slug}` 하나를 유지하고 내용만 점진적으로 확장 |
| Catalog가 mutable `articles`를 직접 공개 | 변경 이력·철회·감사 경계가 약함 | 기존 불변 `article_content_versions_p3`를 공용 revision chain으로 재사용하고 Catalog publication pointer만 분리 |
| `collect-range.ts` 재사용 | 현재는 전 후보 메모리 적재, 제한값, durable checkpoint 부재 | adapter/parser만 추출하고 오케스트레이션은 새로 작성 |
| “전수”를 행 수로 판단 | 공식 모집단과 누락 여부를 증명하지 못함 | source/year/type별 닫힌 snapshot과 reconciliation으로 완료 판정 |

v2.1은 구현 전 검토에서 확인된 다음 결함도 닫는다.

| 검토 항목 | v2.1 결정 |
|---|---|
| 독일 docket/Aktenzeichen 재사용 | docket과 `case_key`에는 UNIQUE를 적용하지 않고 decision-unique 식별자에만 partial UNIQUE 적용 |
| P1 command와 item 멱등성 혼합 | P1 command는 “한 phase의 한 batch pass”, item 멱등성은 ledger UNIQUE로 분리 |
| P1 attempt와 item lease 관계 불명확 | `claimed_attempt_id`와 `claimed_fencing_token`을 저장하고 P1 lease를 상한으로 강제 |
| inventory 처리율과 공식 coverage 혼동 | `coverage_assurance`를 추가하여 두 지표를 분리 |
| Constitution Annotated 인용 즉시 verified | SCOTUS identity와 constitutional essay context 검증 전에는 candidate 유지 |
| 닫힌 snapshot의 manifest 변경 가능 | snapshot close 후 discovery 필드 insert/update/delete 방지 trigger 적용 |
| AI claim-evidence 저장 위치 부재 | `case_enrichment_artifacts.claim_evidence_map`에 경로별 evidence ref 저장 |
| P3/Catalog flag 조합 불명확 | 기존 P3 read flag가 Catalog public/search의 선행 조건이 되도록 fail-closed matrix 확정 |

v2.2는 기존 P3 관리자 전환 코드까지 대조하여 다음 마지막 경계 문제를 닫는다.

| 검토 항목 | v2.2 결정 |
|---|---|
| 공용 version chain이 기존 P3 head를 전진시킴 | global revision head를 신설하고 기존 P3 candidate head, Catalog pointer, P3 publication pointer를 분리 |
| 공식 원문 변경 후 기존 AI 요약이 계속 우선됨 | `enrichment_freshness`와 source hash 일치 gate를 추가하고 stale AI를 공개 요약·랭킹에서 제외 |
| normalize item phase는 있으나 P1 command/CLI가 없음 | `p1.case-backfill.normalize`와 `backfill:corpus normalize`를 독립 재실행 단계로 추가 |
| source policy 만료를 언급하지만 schema에 기한이 없음 | immutable policy row에 `review_due_at`을 추가하고 기한 경과 시 신규 publish를 fail-closed |

v2.2 최종 검토에서 구현 DDL 전에 필요한 두 계약을 추가로 고정한다.

| 최종 보정 | v2.2 확정 계약 |
|---|---|
| AI artifact의 source version과 Catalog display version 의미가 혼재 | Catalog publication은 authoritative source anchor만 가리키고 AI/P3 version은 그 anchor를 참조 |
| published item 재-normalize 시 terminal outcome과 진행 상태가 충돌 | `published`를 유지하고 artifact pointer 차이에서 `needs_reverify`·`needs_republish`를 계산 |

구현 검증에서 추가로 확인한 안전 계약도 설계의 일부로 고정한다.

| 구현 검증 항목 | 확정 계약 |
|---|---|
| Catalog source correction 뒤 feature flag rollback이 legacy `articles`의 stale AI를 되살릴 수 있음 | `articles.catalog_ai_stale_v4`를 기능 플래그와 독립된 fail-closed 불변식으로 유지하고 모든 legacy 공개 읽기에서 제외 |
| source-only revision capture를 위해 mutable `articles`를 덮어쓰면 기존 P3 콘텐츠가 손상될 수 있음 | 기존 article은 변경하지 않고 normalization snapshot을 immutable `authoritative_source` revision에 직접 capture |
| Catalog와 P3가 서로 다른 역할의 version을 공유할 위험 | DB trigger로 Catalog는 self-anchored `authoritative_source`, P3는 현재 anchor/hash와 일치하는 `enrichment_full`만 허용 |
| P3 withdraw가 global head로 version pointer까지 이동할 수 있음 | withdraw는 현재 publication version을 보존하고 state만 전환하며 다른 version 지정은 DB에서 거부 |

Gate 2 구현 증거는 `20260903130000_constitutional_case_catalog_gate2.sql`과 PostgreSQL 계약 테스트에 고정한다. 로컬 검증 완료는 운영 활성화를 뜻하지 않는다. 운영 migration, immutable source policy 승인, Spain canary reconciliation을 각각 별도 승인 gate로 유지한다.

Gate 3 구현은 `public_article_detail_v4`를 유일한 대표 문서 입력으로 사용한다. exact identity가 있으면 lexical보다 우선하고, 없으면 original lexical FTS로 전환한다. `gate3-exact-lexical-v1` cursor는 질의·filter fingerprint와 마지막 score/date/article ID를 묶으며 offset pagination을 사용하지 않는다. alias, RRF, 국가 다양화, Catalog semantic embedding은 Gate 4 이후로 남겨 범위를 섞지 않는다.

Gate 4 로컬 구현은 reviewed alias set을 immutable ranking input으로 고정하고 5개 언어 bounded OR expansion, weighted RRF, 관할별 제한적 감점, ranking-version cursor 만료를 추가한다. 운영 별칭은 migration에 seed하지 않으며 별도 법률 검토 후 등록한다. PostgreSQL 계약 검증은 완료됐지만 운영 migration·별칭 검토·실데이터 p95 canary 전이므로 운영 Gate 4 완료로 간주하지 않는다. semantic/Gemini retrieval은 여전히 Gate 6 범위다.

이 문서에서 “전수”는 전 세계 모든 헌법판례를 뜻하지 않는다.

> **특정 시점에 선언된 공식 원천·기간·문서 유형의 inventory snapshot 안에서 누락 없이 처리되었음을 증명하는 것**을 뜻한다.

공식 기관 자체가 전체 판결이 아닌 선별 공개만 제공하는 경우에는 `공식 공개 집합 전수`라고 표시한다. 예를 들어 독일 연방헌법재판소 사이트는 1998년 이후의 “모든 주요 결정과 일부 과거 결정”을 공개한다고 설명하므로, 이를 독일 법원 전체 결정 전수로 표현하지 않는다.

---

## 1. 목표, 비목표, 성공 조건

### 1.1 목표

1. 미국·독일·프랑스·스페인의 선언된 공식 판례 범위를 재현 가능한 inventory로 만든다.
2. Gemini 호출 여부와 무관하게 검증된 공식 판례를 키워드·식별자·메타데이터로 검색할 수 있게 한다.
3. 기존 P3 publication은 “검증된 한국어 AI 가공 콘텐츠” 계층으로 유지한다.
4. 홈페이지와 ChatGPT 플러그인이 같은 공개 검색 계약과 같은 canonical URL을 사용하게 한다.
5. 백필을 중단·재개·재시도·감사·철회할 수 있게 한다.
6. 수집률, 공개율, AI 처리율을 분리하여 관측한다.

### 1.2 비목표

- P3 공개 적격 기준 완화
- AI 요약 100% 완료를 Catalog 공개의 선행 조건으로 만들기
- 외부 검색 인덱스를 공식 원문으로 재배포하기
- 원천의 robots 정책이나 이용 조건을 우회하기
- 공개되지 않은 판결의 존재를 추정해 “완료”로 계산하기
- Cloudflare Worker, D1, R2 등 별도 Cloudflare 실행 계층 도입
- OpenAI 디렉터리 게시 또는 별도 인증 체계 도입

### 1.3 최종 성공 조건

- 공식 snapshot의 각 항목이 `published`, `excluded`, `duplicate`, `withdrawn`, `waived_failure` 중 하나의 설명 가능한 종결 상태를 가진다.
- 처리 완료율과 `coverage_assurance`가 별도 표시되어 낮은 assurance의 100% 처리율을 공식 corpus 100%로 오인하지 않는다.
- Catalog에 AI 미처리 판례가 실제 검색되고 `/articles/{slug}`에서 공식 정보로 표시된다.
- 기존 P3 결과의 URL, 검색, publication 적격성, Gemini 임베딩이 회귀하지 않는다.
- 같은 판례가 Catalog와 P3에 동시에 존재해도 검색 결과는 하나만 나오며, 현재 Catalog source anchor ID/hash와 일치하는 P3 표현만 우선한다.
- 공식 원문이 바뀌면 최신 Catalog 정보는 계속 공개하되 stale AI 요약·태그·embedding은 공개 대표 표현과 검색 랭킹에서 제외된다.
- parser 재실행은 기존 terminal publication outcome을 지우지 않으며 새 normalization의 검증·재발행 필요 상태를 별도로 드러낸다.
- 플러그인은 AI 요약이 없는 판례를 AI 요약이 있는 것처럼 표시하지 않는다.
- 기능 플래그를 끄는 것만으로 current P3-only 동작으로 즉시 롤백할 수 있으며 stale AI freshness guard는 롤백 후에도 유지된다.

---

## 2. 현재 구현에서 확인된 기준선

### 2.1 저장·공개 구조

현재 `articles`에는 다음 핵심 필드가 있다.

```text
source_key, jurisdiction, institution_name, content_type
original_url, canonical_url, original_language
original_title, korean_title, original_published_at
raw_text, cleaned_text, summary_json
search_vector, embedding, content_hash
source_metadata, error_metadata
```

`article_content_versions_p3`와 `article_publications_p3`는 불변 콘텐츠 버전과 publication 전환을 관리한다. `public_article_projection_p3`는 현재 published version만 공개한다.

`article_content_versions_p3.summary_json`은 nullable이고 version row에는 이미 source text, title, URL, metadata, parent revision과 immutable trigger가 있다. 따라서 Catalog를 위해 두 번째 content version 계보를 만들 필요는 없으며, version capture와 P3 publication transition의 결합만 분리하면 된다.

`article_publication_eligible_p3()`는 대략 다음을 요구한다.

```text
lifecycle_collection_state = source_text_ready
lifecycle_processing_state = complete
review state = 공개 허용
attention state = clear
summary_json IS NOT NULL
cleaned_text 길이 >= 500
collection.publishable = true
sourceTextAvailable = true
sourceUrlVerified = true
robotsDisallowed != true
seed strategy가 아님
```

따라서 P3를 약화하지 않고 별도 Catalog publication을 추가하는 것이 맞다.

### 2.2 기존 식별키

`supabase/migrations/20260826400000_case_keys_and_ranked_pagination.sql`에는 `worldcons_case_key_v1()`과 generated `case_key`가 이미 있다. 이 값은 국가별 제목·URL·메타데이터 정규식에서 파생되며 `(source_key, case_key)` 인덱스는 있지만 unique 제약은 아니다.

결론:

- `case_key`는 조회·후보 매칭에 계속 사용한다.
- authoritative identity의 유일한 근거로 승격하지 않는다.
- ECLI, docket, decision number, HJ ID처럼 복수 식별자를 별도 테이블에 저장한다.

### 2.3 기존 작업 큐

P1 `admin_commands`, `admin_command_runs`, `admin_command_attempts`, `admin_command_events`에는 이미 다음 기능이 있다.

```text
idempotency key
priority
lease와 heartbeat
fencing token
abort
재시도와 backoff
불변 event 기록
```

새 백필·enrichment 실행 큐가 이 기능을 다시 구현하면 두 종류의 lease와 재시도 규칙이 생긴다. 실행 예약과 worker 소유권은 P1을 재사용한다.

현재 TypeScript authority allowlist는 `p1.collect`, `p1.summarize`, `p1.candidate.retry`, `p1.refresh-derived`, `p1.public-cache.revalidate`만 허용하고 cohort도 `daily`, `candidate-retry`, `manual`뿐이다. 신규 command와 cohort는 DB 문자열 제약만 통과시키는 것으로 끝나지 않으며 이 allowlist와 실제 handler를 함께 확장해야 한다.

### 2.4 현재 범위 수집 스크립트의 한계

`scripts/collect-range.ts`는 source adapter와 parser 검증 자산으로는 유용하지만 durable backfill 엔진은 아니다.

- discovery 결과를 프로세스 메모리에 모두 모은 뒤 fetch한다.
- run/item checkpoint가 없다.
- 프로세스 종료 후 개별 항목 상태로 재개할 수 없다.
- 스페인은 기본 500건 제한이 있다.
- Open Legal Data 경로는 최대 10페이지에서 중단한다.
- dejure 경로는 기본 2페이지만 본다.
- `MAX_CANDIDATES_PER_SOURCE`가 결과를 자를 수 있다.
- canonical URL·정규화 콘텐츠 중복은 검사하지만 inventory 대비 누락은 증명하지 않는다.

따라서 adapter의 `discover/fetch/normalize` 로직은 공유하되, 백필 오케스트레이션은 DB ledger 기반으로 새로 만든다.

### 2.5 현재 Gemini 임베딩 계약

- 공급자: Gemini만 허용
- 모델: `gemini-embedding-001`
- 차원: 1536
- 문서: `RETRIEVAL_DOCUMENT`
- 질의: `RETRIEVAL_QUERY`
- P3 문서 입력: `summary_json`에서 만든 한국어 요약·태그·엔터티 중심 텍스트
- provenance: provider/model/dimensions/input hash/generated_at

Catalog 원문 기반 retrieval input은 P3 summary 기반 input과 의미가 다르므로 같은 artifact를 덮어쓰지 않는다.

### 2.6 현재 분석·하트비트 계약

- 사이트 분석은 검색어를 120자로 정규화하고 이메일·URL·전화·식별자 패턴을 가린다. retention 기본값은 90일이고 운영 설정은 30~365일 범위이므로 실제 보관 기간은 배포 설정과 purge 실행 상태를 함께 확인한다.
- 검색 수요 우선순위는 원문 검색어를 직접 복제하지 않고, 판례 단위 노출·클릭·플러그인 fetch의 일별 집계만 사용한다.
- 현재 workflow heartbeat key는 `collection`, `summary`, `embedding`, `watchdog`이다.
- Catalog 백필은 별도 `catalog_backfill` heartbeat와 source별 run 신호가 필요하다.

---

## 3. 불변 설계 원칙

1. **권위 확인 전 공개 금지**: discovery 성공은 publication 권한이 아니다.
2. **공개와 AI 상태 분리**: 공식 판례 공개 상태와 enrichment 완료 상태는 서로 독립이다.
3. **공개 snapshot 불변성**: 공개 후 원천이 바뀌면 기존 행을 덮지 않고 새 version을 발행한다.
4. **단일 canonical URL**: Catalog와 P3 모두 `/articles/{slug}`를 사용한다.
5. **식별자 우선, URL 보조**: URL 변경이 새 판례 생성을 뜻하지 않는다.
6. **항목 단위 멱등성**: 같은 snapshot과 stable item key를 반복 실행해도 중복되지 않는다.
7. **항목 단위 재시도**: 한 항목 실패가 전체 partition 재수집을 강제하지 않는다.
8. **완료는 분모로 증명**: 발견 건수와 저장 행 수가 아니라 inventory reconciliation으로 완료를 판단한다.
9. **공식성과 재배포 권한 분리**: 공식 자료라고 해서 원문 전체 재배포가 자동 허용되는 것은 아니다.
10. **AI는 근거를 소비하는 파생 작업**: 원천 텍스트를 명령으로 취급하지 않으며 결과는 provenance와 evidence를 가진다.
11. **Gemini 전용**: 번역·요약·임베딩에서 다른 공급자로 자동 전환하지 않는다.
12. **기존 P3 보존**: 새 Catalog 장애가 기존 공개 판례를 가리지 않는다.
13. **version chain과 head 분리**: 공용 revision 순서, Catalog authoritative source anchor, P3 후보, P3 publication은 서로 다른 pointer다.
14. **AI 최신성 fail-closed**: 공식 source hash와 다른 AI artifact는 존재하더라도 공개 current 요약으로 사용하지 않는다.

---

## 4. 목표 아키텍처

```text
공식 목록/검색/내보내기 ── discovery ──> inventory snapshot
외부 허용 인덱스 ───────── discovery only ─┘
                                           │
                                           ▼
                                source_backfill_items
                                  │ fetch/normalize
                                  ▼
                           articles + case metadata
                                  │ authority verify
                                  ▼
                 shared immutable article version + global revision head
                                  │
                  ┌───────────────┴────────────────┐
                  ▼                                ▼
          Catalog publication              Gemini enrichment
                  │                       source anchor binding
                  │                                │
          lexical/alias search                     ▼
                  │                         light/full artifact
                  │                                │
                  │                                ▼
                  │                  P3 candidate + publication pointer
                  └───────────────┬────────────────┘
                                  ▼
                      unified public search/read model
                                  ▼
                홈페이지 + ChatGPT 플러그인 + /articles/{slug}
```

실행 인프라는 Vercel 작업/관리 API와 Supabase/PostgreSQL을 사용한다. 로컬 수집 도구는 유지하되 같은 DB 계약과 P1 command를 사용한다.

---

## 5. 상태 모델

하나의 문자열로 모든 상태를 표현하지 않는다.

### 5.1 권위 상태 `authority_status`

```text
candidate   발견했으나 공식 식별·원천 검증 전
verified    공식 URL과 식별 근거 검증 완료
rejected    잘못된 후보, 비판례, 또는 공식성 검증 실패
withdrawn   과거에는 유효했으나 원천 철회·교정으로 공개 중단
```

미국 헌법 관련성은 별도 `constitutional_relevance_status`로 둔다.

```text
candidate | verified | rejected | uncertain
```

boolean 하나로 두면 판정 전과 비헌법 판례를 구분할 수 없다.

### 5.2 Catalog publication 상태 `catalog_state`

```text
private | published | withdrawn
```

직접 UPDATE하지 않고 transition RPC를 통해서만 바꾼다. transition마다 actor, reason, 이전·새 version, 시각을 기록한다.

### 5.3 AI 상태 `enrichment_status`

```text
source_only | light | full
```

- `source_only`: 공식 정보만 존재
- `light`: 공식 abstract/descriptors의 제한적 한국어 변환 artifact 존재
- `full`: 현재 `SummaryJson` 검증을 통과하고 P3 처리 대상이 됨

`light` 결과를 기존 `summary_json`에 억지로 넣지 않는다.

가공 수준과 최신성은 다른 축이다. `light` 또는 `full` artifact에는 다음 최신성 상태를 함께 계산한다.

```text
enrichment_freshness
  current  artifact.source_anchor_version_id = 현재 Catalog source_anchor_version_id
           AND artifact.source_content_hash = source anchor의 source_content_hash
  stale    anchor ID 또는 source content hash가 다르거나 비교 근거를 증명할 수 없음

freshness_basis
  source_hash_match | legacy_same_version | source_hash_mismatch | unknown_fail_closed
```

`source_only`에는 비교할 AI artifact가 없으므로 `enrichment_freshness`는 `null`이다. `light | full`인데 freshness가 `null`인 상태와 `source_only`인데 freshness가 채워진 상태는 DB constraint로 거부한다.

`case_index_metadata.enrichment_status`와 `enrichment_freshness`는 조회 최적화를 위한 projection 값이다. artifact, Catalog source anchor, P3 publication의 anchor/version/hash에서 transition RPC가 같은 transaction 안에서 계산하며 일반 application code가 임의로 갱신하지 않는다. 정합성 검사는 저장된 projection과 재계산값을 주기적으로 대조한다.

공식 원문이 변경되면 가공 수준은 `full`에서 `source_only`로 되돌리지 않는다. 이력상 artifact가 존재한다는 뜻의 `full + stale`로 보존하고, 공개 가능성은 freshness gate로 별도 통제한다.

### 5.4 텍스트 사용 정책 `text_access_policy`

```text
metadata_only  제목·식별자·날짜·공식 URL만 공개/색인
index_only     서버 검색에는 사용하지만 원문·excerpt는 외부 반환 금지
excerpt        길이 제한 공식 excerpt 공개 가능
full           허용 범위에서 정제 원문 공개 가능
```

이 값은 source 정책 버전과 검토 근거를 가져야 한다. 공개 projection은 이 정책보다 많은 텍스트를 절대 반환하지 않는다.

---

## 6. 데이터 모델

아래 SQL은 계약 수준의 초안이다. 실제 migration에서는 기존 naming convention, helper, RLS, revoke/grant 패턴을 따른다.

DDL 적용 순서는 17절의 `source_corpus_policies` → article 복합키 → case metadata/identifiers → inventory/run/item → Catalog publication 순서다.

### 6.1 `case_index_metadata`

```sql
alter table articles
  add constraint articles_id_source_key_key unique (id, source_key);

create table case_index_metadata (
  article_id uuid primary key,
  source_key text not null,

  decision_type text,
  official_abstract text,
  official_keywords text[] not null default '{}',
  official_topics text[] not null default '{}',
  constitutional_provisions text[] not null default '{}',

  authority_status text not null default 'candidate',
  authority_evidence jsonb not null default '{}'::jsonb,
  constitutional_relevance_status text,
  constitutional_relevance_basis text,

  enrichment_status text not null default 'source_only',
  enrichment_freshness text,
  freshness_basis text,
  text_access_policy text not null default 'metadata_only',
  source_policy_version text not null,

  discovery_source text not null,
  authority_source text not null,
  source_last_modified_at timestamptz,
  source_etag text,
  source_snapshot_hash text,

  ai_priority integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  foreign key (article_id, source_key)
    references articles(id, source_key) on delete restrict,
  foreign key (source_key, source_policy_version)
    references source_corpus_policies(source_key, policy_version) on delete restrict,
  check (authority_status in ('candidate','verified','rejected','withdrawn')),
  check (constitutional_relevance_status is null or
    constitutional_relevance_status in ('candidate','verified','rejected','uncertain')),
  check (enrichment_status in ('source_only','light','full')),
  check (enrichment_freshness is null or enrichment_freshness in ('current','stale')),
  check (freshness_basis is null or freshness_basis in (
    'source_hash_match','legacy_same_version','source_hash_mismatch','unknown_fail_closed'
  )),
  check ((enrichment_status = 'source_only' and enrichment_freshness is null) or
    (enrichment_status in ('light','full') and enrichment_freshness is not null)),
  check ((enrichment_status = 'source_only' and freshness_basis is null) or
    (enrichment_status in ('light','full') and freshness_basis is not null)),
  check (text_access_policy in ('metadata_only','index_only','excerpt','full')),
  check (jsonb_typeof(authority_evidence) = 'object'),
  check (pg_column_size(authority_evidence) <= 16384)
);
```

`authority_evidence`에는 비밀값, 전체 원문, 임의 crawler dump를 넣지 않는다. 허용 키를 schema 또는 검증 함수로 제한한다.

### 6.2 `case_identifiers`

```sql
create table case_identifiers (
  id uuid primary key default gen_random_uuid(),
  article_id uuid not null references articles(id) on delete restrict,
  source_key text not null,
  identifier_type text not null,
  identifier_scope text not null,
  raw_value text not null,
  normalized_value text not null,
  normalization_version integer not null default 1,
  is_primary boolean not null default false,
  provenance_url text,
  created_at timestamptz not null default now(),

  foreign key (article_id, source_key)
    references articles(id, source_key) on delete restrict,
  check (identifier_type in (
    'source_record_id','ecli','docket','decision_number',
    'reporter_citation','hj_id','case_key'
  )),
  check (identifier_scope in ('decision','proceeding','lookup')),
  check (length(normalized_value) between 1 and 300)
);

-- 문서 하나를 안정적으로 지칭하는 식별자에만 유일성을 적용한다.
create unique index case_identifiers_decision_unique_idx
  on case_identifiers(source_key, identifier_type, normalized_value)
  where identifier_type in (
    'source_record_id','ecli','hj_id','reporter_citation'
  );

-- docket/Aktenzeichen, decision_number, case_key는 같은 절차의 복수 결정을
-- 가리킬 수 있으므로 조회 인덱스만 둔다.
create index case_identifiers_proceeding_lookup_idx
  on case_identifiers(source_key, identifier_type, normalized_value)
  where identifier_type in ('docket','decision_number','case_key');

create unique index case_identifiers_one_primary_per_article_idx
  on case_identifiers(article_id)
  where is_primary;
```

규칙:

- 원문 표기는 `raw_value`, 비교에는 `normalized_value`를 쓴다.
- normalization 규칙 변경 시 version을 올리고 충돌 보고서를 먼저 만든다.
- `identifier_scope='decision'`은 하나의 결정문, `proceeding`은 계속되는 사건·절차, `lookup`은 검색 보조를 뜻한다.
- source policy가 identifier type별 허용 scope를 고정한다. application 입력만으로 scope를 승격할 수 없다.
- 동일 source의 decision-unique 식별자가 충돌하면 자동 merge하지 않고 검토 대상으로 격리한다.
- docket/Aktenzeichen는 절차 식별자다. 독일 `2 BvR 547/21`처럼 같은 docket으로 2021-03-26, 2021-04-15 및 후속 결정이 존재하므로 UNIQUE를 적용하지 않는다.
- `decision_number`도 source별 조합 규칙이 검증되기 전에는 non-unique다. 필요하면 type/year가 포함된 별도 normalized decision identity를 `source_record_id`로 발급한다.
- 기존 generated `case_key`는 `identifier_type='case_key'` 후보로 복제할 수 있지만 primary authority는 아니다.
- URL은 식별자가 아니라 provenance다.

### 6.3 `source_inventory_snapshots`

```sql
create table source_inventory_snapshots (
  id uuid primary key default gen_random_uuid(),
  source_key text not null,
  scope_from date,
  scope_to date,
  document_type text not null,
  discovery_method text not null,
  parser_version text not null,
  source_policy_version text not null,
  coverage_assurance text not null,
  expected_count integer,
  expected_count_basis text,
  coverage_evidence jsonb not null default '{}'::jsonb,
  discovered_count integer not null default 0,
  manifest_hash text,
  status text not null default 'open',
  exclusions jsonb not null default '[]'::jsonb,
  opened_at timestamptz not null default now(),
  closed_at timestamptz,

  foreign key (source_key, source_policy_version)
    references source_corpus_policies(source_key, policy_version) on delete restrict,
  check (status in ('open','closed','superseded','failed')),
  check (coverage_assurance in (
    'authoritative_enumerated','authoritative_counted',
    'authoritative_crosschecked','external_index_assisted','best_effort'
  )),
  check (expected_count is null or expected_count >= 0),
  check (jsonb_typeof(coverage_evidence) = 'object'),
  check (pg_column_size(coverage_evidence) <= 16384),
  check (expected_count is null or expected_count_basis is not null),
  check (status <> 'closed' or (manifest_hash is not null and closed_at is not null)),
  check (scope_to is null or scope_from is null or scope_to >= scope_from)
);
```

`expected_count`는 공식 검색 결과 총수·연도별 공식 목록처럼 재현 가능한 분모가 있을 때만 기록한다. 분모가 없으면 null을 0으로 해석하지 않는다. `coverage_evidence`에는 공식 count/list URL, 관측 시각, 공식 응답 hash와 보조 교차검증 결과를 저장한다.

`coverage_assurance` 의미:

| 값 | 의미 | “공식 corpus 100%” 주장 |
|---|---|---|
| `authoritative_enumerated` | 공식 기관이 안정적인 전체 목록/manifest를 직접 제공 | 닫힌 scope에서 가능 |
| `authoritative_counted` | 공식 결과 총수가 있고 모든 공식 pagination을 수집해 수량·경계를 대조 | 대조 성공 시 가능 |
| `authoritative_crosschecked` | 둘 이상의 공식 목록/집계를 상호 대조 | 대조 범위에서 가능 |
| `external_index_assisted` | 외부 index로 열거하고 각 항목만 공식 원천에서 검증 | 처리율만 100%, 공식 coverage 100% 주장은 금지 |
| `best_effort` | 신뢰 가능한 공식 분모가 없음 | 금지 |

대시보드는 항상 두 값을 분리한다.

```text
processing_completion = 종결 item / discovered item
corpus_coverage = expected_count 근거 + coverage_assurance
```

### 6.4 `source_backfill_runs`

```sql
create table source_backfill_runs (
  id uuid primary key default gen_random_uuid(),
  snapshot_id uuid not null references source_inventory_snapshots(id) on delete restrict,
  command_run_id uuid references admin_command_runs(id) on delete set null,
  phase text not null,
  pass_number integer not null,
  status text not null,
  claimed_count integer not null default 0,
  succeeded_count integer not null default 0,
  retryable_failed_count integer not null default 0,
  terminal_failed_count integer not null default 0,
  cursor_in jsonb,
  cursor_out jsonb,
  page_manifest_hash text,
  heartbeat_at timestamptz,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  last_error_code text,
  last_error_summary text,

  unique (snapshot_id, phase, pass_number),
  check (pass_number > 0),
  check (cursor_in is null or jsonb_typeof(cursor_in) = 'object'),
  check (cursor_out is null or jsonb_typeof(cursor_out) = 'object'),
  check (phase in ('discover','fetch','normalize','verify','publish','reconcile')),
  check (status in ('queued','running','deferred','succeeded','degraded','failed','aborted'))
);
```

run 집계는 관측 편의를 위한 값이고 항목 ledger에서 재계산 가능해야 한다.

### 6.5 `source_backfill_items`

```sql
create table source_backfill_items (
  id uuid primary key default gen_random_uuid(),
  snapshot_id uuid not null references source_inventory_snapshots(id) on delete restrict,
  source_key text not null,
  stable_item_key text not null,
  source_record_id text,
  discovered_url text not null,
  authority_url text,
  document_type text,
  discovered_decision_date_hint date,

  status text not null default 'discovered',
  attempt_count integer not null default 0,
  next_attempt_at timestamptz,
  claimed_attempt_id uuid references admin_command_attempts(id) on delete restrict,
  claimed_fencing_token bigint,
  claimed_phase text,
  lease_expires_at timestamptz,

  http_status integer,
  source_etag text,
  source_last_modified_at timestamptz,
  payload_hash text,
  parser_version text,
  current_fetch_artifact_id uuid,
  current_normalization_artifact_id uuid,
  verified_normalization_artifact_id uuid,
  published_normalization_artifact_id uuid,
  article_id uuid references articles(id) on delete restrict,
  duplicate_of_item_id uuid references source_backfill_items(id) on delete restrict,
  exclusion_code text,
  error_code text,
  error_summary text,
  waived_by text,
  waived_at timestamptz,
  waiver_reason text,
  waiver_expires_at timestamptz,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (snapshot_id, stable_item_key),
  check (status in (
    'discovered','queued','fetching','fetched','normalized','verified',
    'published','retry_wait','terminal_failure','waived_failure',
    'excluded','duplicate','withdrawn'
  )),
  check (attempt_count >= 0),
  check (claimed_phase is null or claimed_phase in ('fetch','normalize','verify','publish')),
  check (
    (claimed_attempt_id is null and claimed_fencing_token is null
      and claimed_phase is null and lease_expires_at is null)
    or
    (claimed_attempt_id is not null and claimed_fencing_token is not null
      and claimed_phase is not null and lease_expires_at is not null)
  ),
  check (
    status <> 'waived_failure'
    or (waived_by is not null and waived_at is not null and waiver_reason is not null)
  )
);
```

P1 command attempt가 worker 소유권의 유일한 기준이다. item에는 worker 문자열이나 별도 fencing sequence를 만들지 않고 `admin_command_attempts.id`와 그 attempt의 fencing token을 기록한다.

필수 RPC 계약:

```text
source_backfill_items_claim_v1(
  snapshot_id, phase, batch_limit,
  p1_attempt_id, p1_fencing_token, requested_lease_seconds
)

source_backfill_item_complete_v1(
  item_id, phase, p1_attempt_id, p1_fencing_token,
  next_status, result_metadata
)

source_backfill_item_fail_v1(
  item_id, phase, p1_attempt_id, p1_fencing_token,
  disposition, error_code, retry_at
)
```

세 RPC는 한 transaction 안에서 다음을 모두 검증한다.

1. `admin_command_attempts.id`가 현재 run의 `current_attempt_id`다.
2. 전달된 token이 현재 P1 attempt의 `fencing_token`과 같다.
3. P1 attempt lease가 아직 만료되지 않았다.
4. item의 `claimed_attempt_id`, `claimed_fencing_token`, `claimed_phase`가 호출자와 일치한다.
5. `item.lease_expires_at <= p1_attempt.lease_expires_at`이다.
6. 상태 전이가 phase별 허용 전이표에 맞는다.

claim RPC는 `FOR UPDATE SKIP LOCKED`로 bounded item을 선택하고 item lease를 P1 lease보다 길게 만들지 않는다. P1 heartbeat 후 item 처리가 계속되면 별도 extend RPC가 위 조건을 재검사해 item lease를 연장한다. attempt 종료 전에는 그 attempt가 보유한 item claim이 모두 완료·실패 처리되어 해제됐는지 검사한다. 오래된 attempt의 complete/fail은 `40001` 계열 stale lease 오류로 거부한다.

### 6.5.1 Fetch·normalize 재실행 artifact

fetch와 normalize를 독립적으로 재실행하려면 item의 `payload_hash` 하나만으로는 부족하다. source policy가 허용한 입력과 parser 출력을 append-only artifact로 보존한다.

```text
source_fetch_artifacts
  id, item_id, source_policy_version
  authority_url, http_status, response_headers_allowlist
  source_etag, source_last_modified_at
  payload_hash, payload_size
  replayability: full_snapshot | bounded_evidence | non_replayable
  immutable_storage_ref 또는 bounded_replay_payload
  fetched_at, fetch_contract_version
  append-only
  unique(item_id, payload_hash, fetch_contract_version)

source_normalization_artifacts
  id, item_id, fetch_artifact_id
  parser_version, normalization_contract_version
  normalized_output jsonb, normalized_output_hash
  validation_status, validation_errors
  created_at
  append-only
  unique(fetch_artifact_id, parser_version, normalization_contract_version)
```

`source_backfill_items`에는 다음 processing pointer를 둔다. FK는 artifact 테이블 생성 뒤 적용한다.

```text
current_fetch_artifact_id
current_normalization_artifact_id
verified_normalization_artifact_id
published_normalization_artifact_id
```

fetch/normalize/verify/publish complete RPC만 fencing 검증 후 각 pointer를 바꿀 수 있고 과거 artifact를 수정하거나 삭제하지 않는다. `status=published`는 terminal publication outcome이므로 유지보수 fetch/normalize/verify 중에 이전 단계로 되돌리지 않는다.

재처리 projection은 pointer 차이에서 계산한다.

```text
needs_renormalize = current_fetch_artifact_id != current normalization의 fetch_artifact_id
needs_reverify    = current_normalization_artifact_id IS NOT NULL
                    AND current_normalization_artifact_id != verified_normalization_artifact_id
needs_republish   = status = published
                    AND verified_normalization_artifact_id IS NOT NULL
                    AND verified_normalization_artifact_id != published_normalization_artifact_id
```

`work_state`는 저장된 terminal outcome을 덮지 않는 projection이다. 우선순위는 `claimed → retry_wait → needs_normalize → needs_reverify → needs_republish → failed → idle`이다. 따라서 published item도 `resolution=published, work_state=needs_reverify`처럼 표현할 수 있다. phase별 오류와 retry 시각은 최신 phase attempt에 연결하고 publication 상태를 실패 상태로 바꾸지 않는다.

`full_snapshot`은 정책상 허용된 원문 snapshot, `bounded_evidence`는 parser 재현에 충분하다고 source policy가 명시한 최소 입력이다. `non_replayable` source는 독립 normalize 성공을 기록할 수 없으며 fetch+normalize 결합 예외로 표시한다. 운영 대시보드는 replayable 비율을 source별로 표시한다. storage ref에는 서명 URL·credential·임시 query token을 저장하지 않고 immutable object key와 checksum만 저장한다.

### 6.5.2 Phase별 허용 전이

초기 처리와 published 유지보수 전이를 구분한다.

| 현재 상태/조건 | phase | 성공 후 상태·pointer | 자동 실행 |
|---|---|---|---|
| `discovered`, `queued`, `retry_wait` | fetch | `fetched`, current fetch 전환 | 허용 |
| `fetched` | normalize | `normalized`, current normalization 전환 | 허용 |
| `normalized` | verify | `verified`, verified normalization 전환 | 허용 |
| `verified` | publish | `published`, published normalization과 Catalog source anchor 전환 | 허용 |
| `published` + 새 fetch | fetch refresh | `published` 유지, current fetch만 전환, `needs_renormalize=true` | 허용 |
| `published` + `needs_renormalize` | normalize | `published` 유지, current normalization 전환, `needs_reverify=true` | 허용 |
| `published` + `needs_reverify` | verify | `published` 유지, verified normalization 전환, 변경 시 `needs_republish=true` | 허용 |
| `published` + `needs_republish` | publish correction | `published` 유지, 새 source anchor/version과 published normalization 전환 | 허용 |
| `terminal_failure` | fetch/manual retry | `fetched`, 오류 해제 | 명시적 operator 승인만 |
| `waived_failure` | 모든 자동 phase | 변화 없음 | 금지; waiver 취소 또는 새 snapshot 필요 |
| `excluded`, `duplicate` | 모든 자동 phase | 변화 없음 | 금지; 판정 취소의 감사 transition 필요 |
| `withdrawn` | 모든 자동 phase | 변화 없음 | 금지; 새 snapshot 검증과 명시적 republish 승인 필요 |

초기 item만 fetch claim 중 `status=fetching`을 사용할 수 있다. terminal outcome이 있는 item은 `claimed_phase`와 `work_state=claimed`로 실행 중임을 표시하고 `published` 등을 `fetching/normalized`로 낮추지 않는다. parser 결과가 validation에 실패하면 normalization artifact는 실패 이력으로 append하되 current normalization pointer는 전환하지 않는다.

published item의 verify 결과가 기존 published normalization과 동일한 authoritative output hash라면 새 source revision을 만들지 않는다. `verification.noop` event를 남기고 verified/published normalization pointer를 새 artifact로 함께 정렬하여 `needs_republish=false`로 닫는다. public payload에 영향을 주는 hash가 달라진 경우에만 published pointer는 이전 artifact에 남겨 `needs_republish=true`가 되게 한다.

### 6.6 닫힌 inventory 불변성

`source_backfill_items` 한 테이블에 manifest 필드와 처리 상태를 함께 두되, snapshot이 `closed`가 된 뒤에는 manifest 부분을 trigger로 동결한다.

동결 필드:

```text
snapshot_id, source_key, stable_item_key, source_record_id
discovered_url, document_type, discovered_decision_date_hint
first_seen_at, last_seen_at
```

규칙:

- open snapshot에서만 item INSERT/DELETE와 discovery 필드 수정이 가능하다.
- closed/superseded snapshot에서는 processing 필드만 수정할 수 있다.
- claim/error/artifact pointer와 derived work projection은 processing 필드이며 published maintenance 중에도 수정할 수 있지만 manifest 필드는 바꾸지 않는다.
- close RPC가 stable item key로 정렬한 canonical manifest의 SHA-256을 계산해 `manifest_hash`에 저장한다.
- close 전에 `expected_count`, discovered 실제 count, duplicate stable key, parser/source policy version을 검증한다.
- close 후 발견된 항목이나 URL 변경은 기존 snapshot을 수정하지 않고 새 snapshot에 기록한다.
- discovery에서 알 수 없던 authoritative identifier와 검증된 decision date는 닫힌 manifest를 수정하지 않고 `case_identifiers`, `articles`, 공용 article version에 기록한다.
- manifest hash 재검증 실패는 해당 snapshot의 모든 publication을 중단하는 stop-the-line 오류다.

### 6.7 공용 article version과 Catalog publication

```text
article_content_versions_p3                 기존 공용 불변 revision chain
  + version_document_schema                 기존/확장 snapshot schema 구분
  + version_role                            authoritative_source | enrichment_light | enrichment_full
  + case_metadata_snapshot jsonb            공개 가능 공식 metadata snapshot
  + case_identifiers_snapshot jsonb         해당 revision의 식별자 snapshot
  + authority_evidence_hash
  + source_snapshot_id / source_snapshot_hash / source_content_hash
  + source_anchor_version_id                 이 revision이 근거로 삼은 authoritative source revision
  + enrichment_source_content_hash           AI artifact 생성 시점의 공식 원문 hash
  + text_access_policy / source_policy_version

article_revision_heads_v4                    모든 source/light/full revision의 global latest
  article_id, current_version_id, current_revision, updated_at

article_version_heads_p3                     기존 이름과 관리자 호환성 유지
  P3 publish 후보로 명시 선택된 최신 full·eligible version만 가리킴

case_catalog_publications_v1
  article_id
  source_anchor_version_id -> article_content_versions_p3(id)
  state: private | published | withdrawn
  revision
  updated_at

case_catalog_publication_events_v1
  publication_id, previous_source_anchor_version_id, next_source_anchor_version_id
  previous_state, next_state, reason, actor, occurred_at
  append-only

article_publications_p3
  기존 P3 state와 명시적으로 선택된 full version pointer
```

v2의 별도 `case_catalog_versions_v1` 제안은 채택하지 않는다. 기존 `article_content_versions_p3`는 `summary_json`이 nullable이고 이미 parent revision, immutable trigger, audit ledger를 제공하므로 source-only와 full version이 하나의 계보를 공유할 수 있다. 테이블명의 `p3`는 역사적 이름으로 유지하고 즉시 rename하지 않는다.

```text
v1 authoritative_source (source anchor v1)
  -> v2 authoritative_source 공식 원문 교정 (source anchor v2)
  -> v3 enrichment_light  (source anchor v2 참조)
  -> v4 enrichment_full   (source anchor v2 참조)
```

Catalog publication은 display version과 AI version을 선택하지 않는다. 항상 `version_role=authoritative_source`인 `source_anchor_version_id`만 가리킨다. authoritative source revision은 자신의 ID를 `source_anchor_version_id`로 가지며, light/full revision과 AI artifact는 생성 당시의 authoritative source anchor를 참조한다. AI-only revision 생성, global head 전진, P3 candidate/publication 전환은 Catalog source anchor를 바꾸지 않는다. 공식 source의 검증된 metadata/text/hash가 변경될 때만 새 authoritative source revision을 만들고 Catalog source anchor를 전환한다.

교차 article anchor를 막기 위해 version에 `(id, article_id)` unique를 두고 Catalog publication, AI version, enrichment artifact는 `(source_anchor_version_id, article_id)` 복합 FK로 같은 article의 anchor만 참조한다. constraint/transition trigger는 `authoritative_source → self anchor`, `enrichment_light/full → authoritative_source anchor`를 강제한다.

공용 chain과 공용 head는 같은 뜻이 아니다. 기존 `article_version_heads_p3`는 관리자 publish/withdraw 경로가 P3 대상 version을 찾는 데 사용하므로 Catalog capture가 이 head를 전진시키면 안 된다. 모든 revision의 순서와 parent를 관리하는 `article_revision_heads_v4`를 새로 만들고, 기존 P3 head는 **P3 candidate head**로 의미를 보존한다.

마이그레이션은 article별 가장 높은 기존 revision을 `article_revision_heads_v4`에 넣고 기존 `article_version_heads_p3`는 그대로 둔다. 두 head의 version이 같은 article에 속하는지, global head revision이 P3 head revision보다 작지 않은지 검증한다. 이후 revision 번호는 global head에서만 발급한다.

기존 `p3.article.v1`은 공식 source와 AI summary가 한 immutable row에 결합되어 있고 별도 anchor/hash가 없을 수 있다. 과거 row를 UPDATE하지 않고 `legacy_version_freshness_classifications_v4` sidecar와 새 v4 revision으로 이행한다.

1. 같은 legacy version의 source text와 AI 입력 provenance로 `source_content_hash_v1`을 재현할 수 있으면 `source_hash_match`로 분류한다.
2. AI 입력 hash까지 재현되지 않지만 source와 summary가 같은 legacy transaction에서 capture된 것이 증명되면 `legacy_same_version`으로 분류한다.
3. 두 분류 모두 legacy source 필드로 새 `authoritative_source` revision을 capture하고, 기존 summary를 동일하게 담은 새 `enrichment_full` revision을 그 source anchor에 연결한 뒤 P3 publication pointer를 idempotent compatibility transition으로 새 full version에 옮긴다. Catalog source anchor는 public gate 전까지 private로 둔다.
4. 결합 관계를 증명할 수 없으면 `unknown_fail_closed`로 분류하고 P3 공개 AI를 숨긴다. 임의 source anchor를 만들어 current로 가장하지 않는다.
5. 기존 `p3.article.v1` row는 `version_role/source_anchor_version_id`가 null인 유효한 legacy 상태로 남고 새 `v4.article-case.v1` row만 role/anchor를 필수로 가진다.
6. 공개 P3 전량이 `source_hash_match | legacy_same_version | source_hash_mismatch | unknown_fail_closed` 중 하나로 분류되고, 새 pointer 대상의 payload 동등성·건수·digest reconciliation이 통과하기 전에는 freshness guard와 Catalog public flag를 활성화하지 않는다.

publication과 분리된 `article_version_capture_v4()`는 다음 계약을 따른다.

1. `articles`, `case_index_metadata`, 현재 identifiers를 같은 transaction에서 읽는다.
2. 공개 가능한 case snapshot을 allowlist schema로 만든다.
3. article payload, case snapshot, `version_role`, `source_anchor_version_id`를 포함한 canonical version document hash를 계산한다.
4. `article_revision_heads_v4`를 잠그고 global revision을 하나 증가시킨다.
5. `article_content_versions_p3`와 audit ledger를 append하고 global head만 전환한다.
6. `article_version_heads_p3`, Catalog pointer, P3 publication pointer는 자동 변경하지 않는다.

`authoritative_source` capture는 미리 생성한 자신의 version ID를 self anchor로 저장한다. `enrichment_light | enrichment_full` capture는 같은 article의 published Catalog source anchor를 요구하고, 전달된 source content hash가 anchor row와 다르면 거부한다. parent version은 global chain 순서를 나타낼 뿐 source provenance를 대신하지 않는다.

Catalog transition은 명시적인 authoritative source anchor를 받아 Catalog 적격성·`version_role`·self-anchor를 검사하고 Catalog pointer만 전환한다. source-only Catalog capture는 기존 P3 head와 P3 publication pointer를 절대 바꾸지 않는다.

P3 전환은 다음처럼 고친다.

- `publish`/`republish`: 호출자가 `p_version_id`를 명시하고, 그 version이 `enrichment_full`, P3 적격이며 version의 source anchor ID/hash가 현재 Catalog source anchor ID/hash와 일치하는지 검사한 뒤 P3 candidate head와 publication pointer를 전환한다.
- `withdraw`: 새 version을 선택하지 않는다. 현재 `article_publications_p3.version_id`를 그대로 유지하고 state만 `withdrawn`으로 전환한다. 다른 `p_version_id`를 보내면 거부한다.
- `draft`/`in_review`: 명시적 version 선택이 필요하면 P3 적격 후보만 허용하고 global head를 암묵적으로 사용하지 않는다.
- optimistic concurrency는 global revision, P3 candidate revision, P3 publication revision을 혼용하지 않고 RPC 목적에 필요한 revision을 별도 인자로 받는다.

기존 `article_publication_transition_p3()`의 capture 부분은 `article_version_capture_v4()`를 호출하는 호환 wrapper로 refactor하되, P3 candidate 선택과 publication transition은 위 규칙을 적용한다. `app/api/admin/work/[kind]/[id]/route.ts`, P3 reconciliation/correction migration, 운영 스크립트에서 `article_version_heads_p3.current_version_id`를 withdraw 대상처럼 사용하는 call site를 모두 수정한다. 기존 P3 version은 `version_document_schema='p3.article.v1'`, 새 공용 version은 `version_document_schema='v4.article-case.v1'`로 구분한다. 새 hash는 case snapshot까지 포함하며 기존 row를 다시 쓰지 않는다.

현재 version의 `provenance_actor_type` 제약은 `human | llm | import`이므로 v4 migration에서 `backfill | system`을 추가하거나 P1 backfill을 `import`로 명시 매핑해야 한다. 감사 의미가 더 정확한 전자를 채택한다.

기존 `article_publication_content_hash_p3()`는 과거 version 검증용으로 보존하고, v4 capture는 schema marker와 case snapshot을 포함하는 새 hash 함수를 사용한다. capture를 수행하는 모든 production call site가 v4 함수로 전환됐는지 정적 검사하며, 기존 row의 새 snapshot 컬럼이 null인 것은 유효한 `p3.article.v1` 상태로 해석한다.

Catalog와 P3는 같은 article의 공용 chain을 사용하지만 서로 다른 역할의 version을 가리킨다. Catalog pointer와 P3 pointer가 같은 version을 가리키는 상태는 금지한다.

```text
article_content_versions_p3
  ├─ article_revision_heads_v4     모든 revision 중 global latest
  ├─ article_version_heads_p3      명시 선택된 P3 full candidate
  ├─ case_catalog_publications_v1  authoritative_source anchor만
  └─ article_publications_p3       enrichment_full version만
```

Catalog publication RPC는 P3 적격 함수를 호출하지 않고 Catalog 적격 함수만 적용하며 AI-only version을 거부한다. 반대로 P3 publication은 authoritative source version을 거부하고 기존 엄격한 `article_publication_eligible_p3()`와 source anchor freshness 검사를 모두 적용한다. lock 순서는 `articles → global head → P3 head → Catalog publication → P3 publication`으로 고정하여 교착을 방지한다.

`public_case_catalog_v1`은 `security_barrier=true` view로 published version의 허용 필드만 노출한다.

여기서 `published version`은 `case_catalog_publications_v1.source_anchor_version_id`가 가리키는 authoritative source revision이다. 한국어 AI display 필드는 이 view의 source row를 바꾸지 않고 unified read model에서 current P3/light artifact로만 결합한다.

```text
id, slug, source_key, jurisdiction, institution_name
original_title, korean_title, decision_date, decision_type
공개 허용 식별자
official_abstract, official_keywords, official_topics
constitutional_provisions
official_url
enrichment_status, enrichment_freshness, summary_available, summary_status
source_text_available, text_access_policy
catalog_revision
```

`summary_available`은 current artifact에만 true다. `summary_status`는 `available | processing | reprocessing | unavailable` 중 하나이며 `full + stale`은 `summary_available=false`, `summary_status=reprocessing`으로 반환한다. `raw_text`, `cleaned_text`, crawler diagnostics, error metadata, 외부 index 원문과 stale AI 본문은 기본 projection에 포함하지 않는다.

### 6.8 AI artifact

```text
case_enrichment_artifacts
  id, article_id, target_level
  source_anchor_version_id, source_content_hash
  provider='gemini', model
  prompt_version, schema_version
  evidence_pack_hash, input_hash, output_hash
  output_json
  claim_evidence_map jsonb
  validation_status, review_status
  generated_at, supersedes_artifact_id
  append-only
```

`claim_evidence_map`은 공개 SummaryJson을 바꾸지 않고 claim별 근거를 보존한다.

```json
{
  "claims": [
    {
      "path": "summary.coreSummary[0]",
      "evidenceRefs": ["para-41", "para-43"]
    }
  ]
}
```

`claim_evidence_map`은 JSON object, 최대 크기, 허용 path prefix, claim 수, claim당 ref 수를 제약하고 secret-like key 검사를 적용한다. Light output은 이 테이블에 남긴다. Full output이 현재 `SummaryJson` schema와 정책 검증을 통과하고 모든 필수 claim path에 유효한 evidence ref를 가질 때만 기존 articles/P3 처리 흐름으로 승격한다. evidence ref는 해당 artifact의 evidence pack hash에 속한 paragraph ID만 참조할 수 있다.

---

## 7. P1 command와 실행 모델

별도 범용 queue를 만들지 않고 기존 P1 naming convention에 맞춰 다음 command type을 추가한다.

```text
p1.case-backfill.discover
p1.case-backfill.fetch
p1.case-backfill.normalize
p1.case-backfill.verify
p1.case-backfill.publish
p1.case-backfill.reconcile
p1.case-enrichment.light
p1.case-enrichment.full
p1.case-embedding.catalog
```

현재 `lib/admin/command-control-plane/p1-authority.ts`의 TypeScript allowlist는 기존 5종만 허용하므로 command 이름만 DB에 넣어서는 worker가 claim하지 못한다. 다음을 함께 변경한다.

```text
ADMIN_QUEUE_P1_COMMAND_TYPES에 위 9종 추가
ADMIN_QUEUE_P1_COHORTS에 catalog-backfill, catalog-enrichment 추가
command별 payload validator와 handler 등록
ADMIN_QUEUE_V3_WORKER_COMMAND_TYPES/COHORTS 운영 allowlist 반영
관리자 P4 command stage/label 반영
```

### 7.1 command batch와 item 멱등성

P1 command 하나는 item 하나가 아니라 **한 snapshot phase의 한 bounded batch pass**다.

```text
P1 command/attempt
  -> snapshot + phase에서 최대 25~100 item claim
  -> item별 처리와 ledger 갱신
  -> 보유 claim 전부 해제
  -> attempt 성공
  -> backlog가 남으면 다음 pass command 제출
```

command-level idempotency 예:

```text
backfill-pass:{snapshot_id}:{phase}:{pass_number}
enrichment-pass:{snapshot_id}:{target_level}:{pass_number}
embedding-pass:{snapshot_id}:{input_contract_version}:{pass_number}
```

`pass_number`는 snapshot/phase별 DB sequence 또는 원자적 scheduler counter에서 발급하며 임의 UUID로 중복 의미를 숨기지 않는다. 같은 pass 제출은 P1 idempotency로 합쳐진다.

item-level 멱등성:

```text
unique(snapshot_id, stable_item_key)
상태 전이 + claimed_attempt_id + claimed_fencing_token
article/version content hash
```

`fetch:{snapshot}:{stable_item_key}`처럼 1 command = 1 item 모델은 사용하지 않는다. 30,000건이면 command도 30,000개가 되어 control plane과 운영 화면을 불필요하게 팽창시키기 때문이다.

실행 규칙:

- worker는 command attempt 하나에서 25~100건의 bounded item batch만 claim한다.
- P1 heartbeat와 lease를 갱신하고, fencing token이 바뀌면 즉시 쓰기를 중단한다.
- abort 요청을 batch 사이와 네트워크 요청 전에 확인한다.
- retryable 오류는 `next_attempt_at`과 지수 backoff + jitter를 사용한다.
- `Retry-After`가 있으면 이를 하한으로 사용한다.
- validation, authority mismatch, robots 금지는 terminal 또는 excluded로 분류한다.
- phase claim은 `status='published'`를 제외하는 단순 조건이 아니라 6.5.2의 허용 전이와 `needs_renormalize/needs_reverify/needs_republish` projection을 사용한다.
- 한 pass 종료 시 item 상태에서 집계를 다시 계산하고, backlog가 남았을 때만 다음 pass를 제출한다.

오류 분류:

| 종류 | 예 | 처리 |
|---|---|---|
| transient transport | timeout, 연결 종료 | 제한 재시도 |
| upstream 5xx | 공식 사이트 일시 장애 | 제한 재시도 |
| throttling/quota | 429, quota | Retry-After 후 deferred |
| not found | 404 | URL 후보 재계산 후 terminal/excluded |
| policy | robots disallow, 이용 조건 제한 | excluded, 자동 우회 금지 |
| parser/schema | 필수 식별자 없음 | 격리 후 parser 수정 |
| authority mismatch | 외부 후보와 공식 상세 불일치 | 공개 금지, 수동 검토 |

Gemini circuit breaker는 전역 boolean이 아니라 `provider + task type + credential bucket` 단위로 둔다. Gemini quota 장애가 공식 원천 수집까지 멈추게 해서는 안 된다.

---

## 8. CLI 설계

새 진입점은 DB ledger를 기준으로 동작한다.

```bash
pnpm backfill:corpus plan \
  --source=es-tribunal-constitucional \
  --from=2020-01-01 \
  --to=2024-12-31 \
  --type=sentencia

pnpm backfill:corpus discover --snapshot=<SNAPSHOT_ID>
pnpm backfill:corpus fetch --snapshot=<SNAPSHOT_ID> --batch=50
pnpm backfill:corpus normalize --snapshot=<SNAPSHOT_ID> --batch=100 --parser-version=<VERSION>
pnpm backfill:corpus verify --snapshot=<SNAPSHOT_ID> --batch=100
pnpm backfill:corpus reconcile --snapshot=<SNAPSHOT_ID>
pnpm backfill:corpus publish --snapshot=<SNAPSHOT_ID> --batch=50
pnpm backfill:corpus status --snapshot=<SNAPSHOT_ID>
```

요구사항:

- `plan`은 기본적으로 write하지 않는 dry-run이며 예상 partition과 원천 정책을 출력한다.
- `discover`는 pass별 `cursor_in`, `cursor_out`, page hash와 item을 원자적으로 저장한다. 공식 pagination의 terminal cursor까지 성공한 뒤에만 snapshot을 닫는다.
- fetch 중 새 항목을 암묵적으로 추가하지 않는다. 새 발견은 새 snapshot에 기록한다.
- `fetch`는 정책이 허용한 raw snapshot 또는 재현 가능한 source evidence와 content hash를 저장하고 parser 결과를 확정하지 않는다.
- `normalize`는 저장된 fetch artifact만 읽어 네트워크 요청 없이 parser를 재실행한다. parser bug 수정 시 새 parser version과 output hash를 append하고 기존 결과를 덮어쓰지 않는다.
- published item 재처리는 `normalize --refresh-published --parser-version=<VERSION>`처럼 명시적으로 요청하고 대상 snapshot·source·기존/목표 parser version과 예상 건수를 plan 단계에서 출력한다.
- raw snapshot 보존이 금지된 source는 정책에 허용된 최소 evidence/extracted input으로 normalize 재현 가능성을 입증하지 못하면 fetch와 normalize를 결합했다는 사실과 한계를 run metadata에 기록하며, 별도 normalize 완료로 가장하지 않는다.
- 재개는 로컬 cursor가 아니라 DB item status로 결정한다.
- 동일 snapshot을 병렬 실행해도 `skip locked`/claim RPC와 fencing으로 중복 쓰기를 막는다.
- `--max-items`는 시험 실행에서만 허용하고 snapshot 완료 판정에는 사용하지 않는다.
- 범위 끝 날짜가 미래이면 거부한다.
- 모든 destructive withdrawal은 `--confirm-snapshot`과 명시적 reason을 요구한다.

`scripts/collect-range.ts`는 즉시 삭제하지 않는다. 국가별 adapter/parser fixture 생성과 소규모 진단 도구로 유지하며, 장기적으로 orchestration 코드를 공유 모듈로 옮긴다.

---

## 9. 원천별 범위와 권위 정책

각 source adapter는 다음 계약을 구현한다.

```ts
interface CorpusSourceAdapter {
  plan(scope): Promise<SourcePlan>;
  discoverPage(cursor): Promise<DiscoveryPage>;
  stableItemKey(item): string;
  fetchAuthority(item): Promise<FetchedAuthorityDocument>;
  normalize(document): Promise<NormalizedCase>;
  verify(normalized, item): Promise<AuthorityDecision>;
  sourcePolicyVersion: string;
  parserVersion: string;
}
```

### 9.1 스페인 Tribunal Constitucional

공식 HJ 검색은 1980년 이후 헌법재판소 doctrine 전체를 검색할 수 있다고 설명하고, Sentencia·Auto·Declaración 유형, ECLI, 원문·기술 정보·분석 색인을 제공한다.

공식 원천:

```text
https://hj.tribunalconstitucional.es/es/Resolucion/Show/viewmatches.aspx
/HJ/es/Resolucion/List
/HJ/Resolucion/Api/json/{id}
/HJ/es/Resolucion/Show/{id}
/HJ/es/Resolucion/GetDocumentResolucion/{id}
```

partition:

```text
year × Sentencia
year × Auto
year × Declaración
```

식별 우선순위:

```text
HJ ID > ECLI > resolution type/year/number
```

수집 필드:

```text
FECHA_REGISTRO, FECHA_FIRMA, ECLI, ANNO_RESOLUCION
Síntesis descriptiva, Síntesis analítica
descriptores semánticos, Fallo, votos particulares
```

완료 조건:

- 공식 결과 총수와 snapshot manifest 수가 일치한다.
- 페이지 경계의 첫·마지막 식별자와 중복을 검증한다.
- 기본 500건 제한을 제거하고 server pagination 종료 조건을 사용한다.
- 연도·유형별 0건도 정상인지 공식 결과와 함께 기록한다.
- 이 조건을 모두 충족한 partition은 `coverage_assurance=authoritative_counted`로 표시한다. 공식 export manifest가 별도로 제공되고 hash까지 고정할 수 있으면 `authoritative_enumerated`로 승격할 수 있다.

### 9.2 프랑스 Conseil constitutionnel / QPC360

QPC360은 jurisprudence뿐 아니라 기사·행사 등 다른 콘텐츠도 검색하며 JSON/CSV export UI를 제공한다. 따라서 일반 콘텐츠 검색 총수를 판례 분모로 사용하면 안 된다.

discovery:

```text
QPC360 jurisprudence 검색/export
Conseil constitutionnel 공식 sitemap
연도·결정 유형별 공식 검색 결과 수
```

authority:

```text
Conseil constitutionnel 또는 QPC360의 해당 공식 판례 상세
공식 decision identity와 canonical URL
```

정책:

- export 자동화 가능 여부와 이용 조건을 source policy에 기록한다.
- export endpoint가 비공개 내부 API이면 안정 계약으로 가정하지 않고 fixture와 변경 감지를 둔다.
- QPC360의 Conseil d'État, Cour de cassation 등 QPC 관련 jurisprudence를 포함할지 별도 scope로 선언한다.
- 1차 scope는 Conseil constitutionnel 결정으로 제한하고 `QPC`, `DC`, `L/LP`, 기타 유형을 분리한다.
- sitemap은 발견 보완과 reconciliation에 사용하고, `lastmod`를 decision date로 오인하지 않는다.
- 판례 전용 공식 결과 count/export와 manifest가 일치한 scope만 `authoritative_counted` 또는 `authoritative_enumerated`로 표시한다. 일반 콘텐츠가 섞인 3,000여 건/판례 전체 6,000여 건 같은 UI 총수를 Conseil 결정 분모로 재사용하지 않는다.

식별 우선순위:

```text
decision number + decision type > source record ID > canonical URL
```

### 9.3 독일 Bundesverfassungsgericht

공식 사이트의 공개 범위는 “1998년 이후 모든 주요 결정과 일부 과거 결정”이다. 따라서 scope 명칭은 다음처럼 쓴다.

```text
BVerfG 공식 웹사이트 공개 결정 집합(1998~snapshot date) 전수
```

`/SiteGlobals/` 검색이 robots 정책상 자동 discovery에 적합하지 않으면 이를 우회하지 않는다.

```text
공식 detail seed / 허용된 공식 목록
또는 dejure / Open Legal Data
        ↓ discovery only
ECLI·docket으로 공식 BVerfG detail URL 후보 생성
        ↓
공식 상세 fetch와 내용·식별자 검증
```

필수 정책:

```text
authority_source = official BVerfG
source_text = official BVerfG only
canonical_url = official BVerfG
external index text = 공개 projection 및 AI evidence에서 제외
```

외부 index와 공식 상세가 일치하지 않으면 `authority_status=candidate/rejected`이고 공개하지 않는다. 기존 10페이지/2페이지 제한은 exhaustive run에서 금지한다. 외부 인덱스 자체의 coverage와 이용 조건도 snapshot에 기록한다.

공식 검색의 표시 count를 수동·운영 증거로 저장할 수 있어도, robots 정책 때문에 그 공식 목록을 실제로 전수 열거·대조하지 못하고 외부 index가 enumeration을 담당하면 `coverage_assurance=external_index_assisted`다. 이 경우 “발견한 항목 처리율 100%”는 표시할 수 있지만 “BVerfG 공식 공개 결정 coverage 100%”는 표시하지 않는다.

식별 우선순위:

```text
ECLI > docket + decision date + decision type > official URL
```

### 9.4 미국 Supreme Court

미국 연방대법원 판결 전체가 헌법판례는 아니다. 두 track을 명시적으로 분리한다.

#### Track A: 고정밀 헌법판례

Congress.gov의 Constitution Annotated는 헌법을 해석한 대법원 판례를 지속적으로 정리하고, 인용 판례 목록을 제공한다. 이를 고정밀 seed와 판정 근거로 사용한다.

```text
Constitution Annotated essay/table citation
        ↓
constitutional_candidate=true + citation context 저장
        ↓
SCOTUS 사건인지 court/reporter identity 확인
        ↓
해당 citation이 놓인 constitutional essay 문맥 확인
        ↓
U.S. Reports / Supreme Court 공식 원문과 holding 대조
        ↓
constitutional_relevance_status=verified | uncertain | rejected
```

Constitution Annotated의 Table of Cases는 헌법 주석에서 인용된 모든 사건의 목록이지 SCOTUS 헌법판례 목록이 아니다. 실제로 `103 F. Supp. 569 (D.D.C. 1952)` 같은 하급 연방법원 판결도 포함한다. 따라서 citation은 강한 candidate seed이지만 자동 verified 근거가 아니다.

검증 규칙:

- reporter/court를 먼저 확인해 SCOTUS가 아니면 Track A의 SCOTUS Catalog에서 제외하거나 별도 후보 scope로 이동한다.
- citation이 사용된 essay/footnote 위치와 사용 목적을 provenance로 저장한다.
- 단순 역사적 배경·하급심 경과·반대의견 인용인지, 헌법적 holding 또는 doctrine 설명인지 구분한다.
- 공식 판례 identity와 원문을 확인한 뒤에만 `verified`로 전환한다.
- preemption, qualified immunity, habeas 등 경계 영역은 `uncertain`을 허용하고 근거를 기록한다.
- Constitution Annotated가 모든 헌법 경계 사건을 기계적으로 포함한다고 가정하지 않는다.

#### Track B: 전체 SCOTUS metadata 후보

```text
모든 공식 SCOTUS metadata
        ↓
constitutional_relevance_status=candidate
        ↓
공식/규칙 기반 판정
        ↓
verified만 Catalog 공개
```

원문 우선순위:

```text
공식 U.S. Reports/Library of Congress bound volume
> 공식 Supreme Court slip opinion
> 허용된 외부 사본(발견·복구용, authority 아님)
```

slip opinion은 수정될 수 있으므로 `provisional=true`로 발행하고 bound/최종판 확인 작업을 예약한다. 원문 hash 변경은 새 Catalog version을 만들며 조용히 덮어쓰지 않는다.

게리맨더링 landmark seed는 우선순위만 높인다. authority·identity·publication gate를 우회하는 수동 seed 경로는 만들지 않는다.

Constitution Annotated snapshot 자체의 citation 처리율과 “미국 헌법판례 전체 coverage”도 구분한다. 전자는 닫힌 Table/essay snapshot에 대해 계산할 수 있지만, 후자는 `best_effort` 또는 별도 검증된 scope이며 100%로 표시하지 않는다.

---

## 10. Catalog publication 계약

### 10.1 공개 적격 조건

최소 조건:

```text
authority_status = verified
공식 canonical URL 검증됨
source policy version 존재 + review_due_at 미경과
primary identifier 최소 1개
original title 또는 공식 표시명 존재
decision date 검증 또는 명시적 unknown reason
source snapshot/item provenance 존재
robots·이용 조건 위반 없음
text_access_policy 결정됨
withdrawal/retraction 아님
```

원문 전체 확보는 `metadata_only` Catalog의 필수 조건이 아니다. 그러나 `source_text_available=true`를 표시하려면 실제 공식 텍스트 hash와 추출 검증이 있어야 한다.

### 10.2 공개 전환

1. metadata와 identifiers 검증
2. 공개 whitelist payload 생성
3. canonical JSON으로 content hash 계산
4. `article_version_capture_v4()`로 `authoritative_source` self-anchor version 생성 또는 재사용
5. transition RPC에서 적격성 재검사
6. Catalog `source_anchor_version_id` 전환과 event append
7. 이전 P3/light artifact의 source hash와 비교해 enrichment freshness 재계산
8. stale 전환·재처리 command·검색 cache/tag 무효화를 같은 outbox 경계에 기록

service-role만 version 생성과 transition 실행 권한을 가진다. `anon`과 `authenticated`에는 내부 테이블 권한을 주지 않고 공개 view/RPC만 허용한다.

### 10.3 수정·철회·삭제

- 원천 교정: 새 version 발행
- URL 변경: identity 유지, canonical URL만 새 version으로 전환
- 원천 철회: `withdrawn` 전환, 이유와 관측 시각 보존
- 중복 병합: primary article을 정하고 이전 slug는 영구 redirect
- 물리 삭제: 법적·보안상 필수인 별도 승인 절차 외 금지

### 10.4 공식 원문 변경과 stale AI 처리

공식 원문 교정은 새 `authoritative_source` revision을 만들고 Catalog `source_anchor_version_id`를 전환한다. 공개 P3/light artifact의 source anchor ID와 hash 중 하나라도 현재 Catalog anchor와 다르면 `full + stale` 또는 `light + stale`로 판정한다.

```text
Catalog source anchor v10 / source hash A
  + P3 full v11 / source anchor v10 / source hash A -> full + current

공식 교정 수집
Catalog source anchor v12 / source hash B
  + 기존 P3 full v11 / source anchor v10 / source hash A -> full + stale
```

stale 판정 시 정책은 fail-closed다.

1. 최신 Catalog metadata, identifier, 공식 링크와 허용된 원문/excerpt는 계속 공개한다.
2. stale AI 요약, 한국어 제목·태그·분류·AI excerpt는 공개 상세와 플러그인 응답에서 제외한다.
3. stale P3 lexical/semantic branch와 summary embedding을 대표 검색 후보·랭킹에서 제외하고 현재 Catalog lexical/embedding만 사용한다.
4. 사용자에게 `공식 원문이 갱신되어 한국어 요약 재처리 중` 상태를 표시한다. 과거 AI 본문은 service/admin 감사 화면에서만 접근한다.
5. `p1.case-enrichment.full` 또는 `light`를 높은 우선순위로 멱등 제출한다. idempotency에는 article ID와 새 source content hash를 포함한다.
6. 새 artifact가 현재 source anchor ID/hash, schema, evidence gate를 통과해야만 `current`로 전환하고 P3 candidate/publication 대상이 될 수 있다.

Catalog source anchor 전환, stale projection 기록, outbox 생성은 한 transaction에서 처리하여 최신 공식 정보와 오래된 AI가 함께 current로 보이는 구간을 만들지 않는다. 기존 `public_article_projection_p3`도 published Catalog가 있는 article에 대해서는 current anchor ID/hash를 모두 통과한 P3 version만 노출하도록 갱신한다. Catalog 기능을 롤백하더라도 stale AI가 다시 공개되는 것보다 해당 P3 표현을 숨기는 fail-closed 동작을 우선한다.

---

## 11. 단일 상세 URL과 점진적 렌더링

새 `/cases/{slug}`를 만들지 않는다.

```text
/articles/{slug}
```

하나의 상세 페이지가 상태별로 렌더링한다.

| 상태 | 표시 |
|---|---|
| source_only | 공식 판례명, 기관, 날짜, 식별자, 허용된 abstract/excerpt, 공식 원문 링크 |
| light | source_only + “공식 메타데이터 기반 한국어 안내” |
| full | 기존 P3 한국어 요약과 태그, 공식 원문 링크 |
| light/full + stale | 최신 source-only 공식 정보 + “공식 원문 갱신으로 한국어 안내 재처리 중”; 과거 AI 본문 미표시 |

규칙:

- source_only 페이지에 빈 “한국어 AI 요약” 섹션을 출력하지 않는다.
- light를 판결문 전체 요약으로 표현하지 않는다.
- full 승격 후에도 URL은 바뀌지 않는다.
- SEO canonical도 항상 같은 `/articles/{slug}`다.
- 동일 article의 Catalog/P3 중 **current인 P3**가 있으면 P3 snapshot을 우선 표시하되 최신 공식 metadata를 결합한다. stale P3는 Catalog를 덮어쓰지 못한다.

---

## 12. 통합 검색 설계

### 12.1 공개 read model

`public_case_search_v1` RPC 또는 동등한 service는 다음 두 계층을 합친다.

```text
public_article_projection_p3
UNION
public_case_catalog_v1
```

동일 `article_id`는 하나로 dedupe한다. P3 branch는 publication version의 `source_anchor_version_id`와 `enrichment_source_content_hash`가 현재 Catalog publication의 source anchor ID/hash와 모두 일치할 때만 우선한다. 불일치하면 P3 요약·AI 태그·summary embedding을 후보에서 제거하고 Catalog anchor branch를 대표 결과로 사용한다. 두 projection의 원본 행을 앱에서 단순 이어 붙이지 않는다.

### 12.2 검색 순서

```text
1. exact identity: ECLI, docket, decision number, case_key
2. original query lexical FTS
3. bounded legal concept alias lexical FTS
4. semantic retrieval(해당 corpus의 embedding coverage가 준비된 경우)
5. versioned RRF
6. relevance threshold
7. jurisdiction diversification
8. deterministic cursor pagination
```

filter는 후보를 대량 생성한 뒤가 아니라 가능한 한 rank 전에 적용한다.

### 12.3 alias schema와 확장 제한

```text
legal_concepts
  id, stable_key, label_ko, status, version

legal_concept_aliases
  concept_id, language, raw_alias, normalized_alias
  alias_type, provenance, review_status
  unique(language, normalized_alias, concept_id)
```

질의당 제한 예:

```text
감지 concept 최대 5개
concept당 alias 최대 8개
검색 branch 최대 12개
branch당 candidate 최대 50개
전체 fusion candidate 최대 250개
```

alias는 OR recall 확장에 사용한다. 사용자가 입력한 여러 핵심어를 무조건 AND로 좁히지 않는다. exact identity와 original query 결과의 우선순위를 alias가 역전하지 못하게 한다.

### 12.4 RRF와 pagination

- ranking weight와 alias set에 version을 부여한다.
- 동률 정렬은 `fused_score DESC, decision_date DESC NULLS LAST, article_id ASC`로 고정한다.
- cursor에는 ranking version, 마지막 score/date/id를 포함하고 서명 또는 불투명 encoding을 사용한다.
- ranking version이 바뀐 cursor는 명시적으로 만료시킨다.
- offset 기반 10,000 제한을 새 Catalog의 기본 pagination으로 사용하지 않는다.

### 12.5 국가 다양성

다양성은 관련성이 낮은 판례를 억지로 끼우는 quota가 아니다.

- exact identity 결과는 다양화하지 않는다.
- relevance threshold를 넘은 후보에만 적용한다.
- 첫 상위 결과의 강한 관련성은 보존한다.
- 같은 국가 연속 노출에 bounded penalty를 주고, 부족한 국가를 위해 낮은 관련성 결과를 생성하지 않는다.

---

## 13. ChatGPT 플러그인 계약

플러그인은 공개·무인증·읽기 전용을 유지한다. OpenAI에 게시하지 않고 홈페이지에서 한국어 연결 안내와 MCP 주소 복사 기능을 제공한다.

### 13.1 `search`/`search_cases`

기존 `id`, `title`, `url`은 유지하고 다음 필드를 additive하게 추가한다.

```json
{
  "id": "...",
  "title": "Rucho v. Common Cause",
  "url": "https://worldcons.vercel.app/articles/...",
  "jurisdiction": "United States",
  "source": "us-scotus",
  "enrichmentStatus": "source_only",
  "enrichmentFreshness": null,
  "summaryStatus": "unavailable",
  "summaryAvailable": false,
  "officialMetadataAvailable": true
}
```

### 13.2 `fetch`

- `full`: 기존 한국어 AI 요약과 법적 고지 반환
- `light`: 공식 metadata 기반 제한적 한국어 안내임을 명시
- `source_only`: 공식 판례 정보와 공식 URL만 반환하고 AI 요약 heading을 만들지 않음
- `light/full + stale`: 최신 공식 정보와 `summaryStatus=reprocessing`만 반환하고 과거 AI 요약 본문은 반환하지 않음
- 모든 상태에서 공식 출처와 enrichment 상태를 구조화 응답에도 포함

### 13.3 `fetch_source_text`

`text_access_policy`를 서버에서 강제한다.

| 정책 | 반환 |
|---|---|
| metadata_only | 원문 미제공 + 공식 URL |
| index_only | 원문 미제공 + 공식 URL |
| excerpt | 길이 제한 excerpt + 공식 URL |
| full | 허용된 정제 원문 + 공식 URL |

클라이언트 인자만으로 정책을 올릴 수 없다.

### 13.4 공개 endpoint 보호

인증이 없어도 다음 보호는 필요하다.

- 입력 길이, limit, 필터 개수, 실행 시간 상한
- query와 fetch에 서로 다른 rate limit
- 비정상 반복 요청과 bot의 demand score 제외
- 내부 오류, SQL, 원천 credential, crawler metadata 비노출
- timeout 시 bounded partial result 또는 안정된 오류 코드

---

## 14. AI enrichment 설계

### 14.1 Level 0: Source only

```text
original title
official abstract/keywords/topics
case identifiers
constitutional provisions
허용된 official text/excerpt
```

Gemini 호출이 없다.

### 14.2 Level 1: Light

공식 abstract, descriptors, disposition 같은 짧은 근거만 Gemini로 한국어 변환한다.

```json
{
  "koreanTitle": "...",
  "shortSummary": "...",
  "issues": [],
  "keywordsKo": [],
  "provisions": [],
  "evidenceRefs": []
}
```

이 결과는 `case_enrichment_artifacts`에 저장하고 P3 `summary_json`으로 간주하지 않는다.

### 14.3 Level 2: Full

현재 WorldCons `SummaryJson` schema를 생성한다.

```text
coreSummary, background, caseStructure, implications
practicalNotes, referencedProvisions
entities, tags, categories, riskFlags
```

schema·근거·금칙어를 검증하고 artifact의 source anchor ID/hash가 현재 Catalog source anchor와 모두 일치한 경우에만 기존 P3 version/publication 절차를 사용한다.

### 14.4 Evidence pack

국가별 parser가 다음처럼 구조화한다.

```text
[Source identity and immutable source hash]
[Title / case identifiers / date]
[Official abstract, syllabus, Leitsätze or síntesis]
[Constitutional provisions]
[Disposition / Fallo]
[Paragraph-numbered important excerpts]
```

- 입력 길이는 기본 8,000~15,000자 범위에서 source별로 정한다.
- 근거 문단 ID와 hash를 artifact에 저장한다.
- HTML/PDF 본문은 신뢰할 수 없는 데이터로 취급하며 prompt instruction으로 실행하지 않는다.
- 출력의 주요 주장에 evidence ref가 없으면 full 승격을 막는다.

### 14.5 Gemini quota와 재시도

```text
BACKFILL_AI_DAILY_TARGET
BACKFILL_AI_BATCH_LIMIT
BACKFILL_AI_MAX_INPUT_CHARS
```

quota는 enrichment 속도만 제한한다. Catalog discovery/fetch/verify/publish는 계속 진행한다. `429`, transport, 5xx, safety, schema validation을 서로 다른 오류 코드로 보관한다.

---

## 15. Gemini 임베딩 설계

### 15.1 두 artifact 공간 분리

1. 기존 P3 summary embedding
   - 기존 `article_embedding_artifacts` 사용
   - full `SummaryJson` 기반
2. Catalog retrieval embedding
   - 새 `case_retrieval_embedding_artifacts` 사용
   - 공식 title/abstract/keywords/provisions/허용 excerpt 기반

둘 다 Gemini `gemini-embedding-001`, 1536차원을 사용하더라도 input contract가 다르므로 같은 벡터 컬럼을 덮어쓰지 않는다.

Catalog input 예:

```text
[title]
[official abstract]
[official keywords]
[constitutional provisions]
[bounded official excerpt]
```

artifact 필수 provenance:

```text
provider='gemini'
model='gemini-embedding-001'
dimensions=1536
task_type='RETRIEVAL_DOCUMENT'
input_contract_version
source_anchor_version_id
source_content_hash
input_hash
generated_at
```

질의 embedding은 `RETRIEVAL_QUERY`를 사용한다. 다른 모델·차원·input contract vector를 같은 distance query에 혼합하지 않는다.

### 15.2 활성화 gate

- 1차 공개는 FTS + identity + alias만으로 가능해야 한다.
- source/partition별 embedding coverage가 선언한 기준에 미달하면 semantic branch를 끈다.
- semantic 미사용이 결과 0건을 뜻하지 않아야 한다.
- 모델 교체는 새 artifact namespace에서 canary recall 평가 후 전환한다.

---

## 16. 검색 수요 기반 우선순위

`case_demand_daily`는 원문 질의를 저장하지 않는다.

```text
day, article_id
search_impressions
detail_views
plugin_fetches
qualified_clicks
bot_filtered_count
```

보호 규칙:

- 익명 client/day/article별 기여 상한
- 알려진 bot과 prefetch 제외
- 같은 요청의 중복 event dedupe
- 최근성 decay
- demand boost 상한
- 법적·헌법적 중요도 minimum floor
- demand가 authority 판단에 영향을 주지 않음

예시 점수:

```text
authority/importance base       0..100
official abstract bonus        0..15
provision evidence bonus       0..10
bounded demand boost           0..20
source/type adjustment        -30..40
freshness/maintenance need     0..10
```

점수 공식과 weight는 versioning하고 재계산 가능하게 한다. 공개 endpoint 트래픽만으로 AI 예산 전체를 특정 판례에 몰 수 없게 한다.

---

## 17. 저장·저작권·원천 보존 정책

공식 URL은 provenance이지 archive가 아니다.

```text
Supabase/PostgreSQL
  metadata, identifiers, normalized searchable text
  source headers, hashes, policy/version, publication history

허용된 object storage
  원본 HTML/PDF snapshot
  immutable key + checksum + retention policy

원본 저장이 허용되지 않는 source
  official URL + ETag/Last-Modified + content hash + 추출 텍스트 정책만 저장
```

object storage가 필요하면 현재 Vercel/Supabase 운영 경계 안에서 선택한다. Cloudflare 저장소나 Worker를 추가하지 않는다.

source별 정책 문서에는 다음을 기록한다.

```text
공식 범위 설명
robots 확인 시각과 규칙
이용 조건/라이선스 확인 URL과 버전
재배포 허용 수준
요청 간격/동시성
원본 보존 허용 여부
외부 인덱스 사용 범위
검토 완료 시각과 다음 의무 재검토 시각
```

구현 schema는 immutable version row로 둔다.

```text
source_corpus_policies
  source_key, policy_version                     unique
  scope_definition, official_scope_url
  discovery_methods, authority_hosts, redirect_hosts
  robots_url, robots_observed_at, robots_rules_hash
  terms_url, terms_observed_at, license_basis
  default_text_access_policy
  allow_raw_snapshot, normalize_replay_policy, bounded_replay_fields, retention_days
  min_request_delay_ms, max_concurrency
  external_index_hosts, external_index_usage
  reviewed_by, reviewed_at, review_due_at, supersedes_policy_version
  immutable
```

`review_due_at`은 `timestamptz not null`이며 `review_due_at > reviewed_at`을 강제한다. immutable row의 기한을 UPDATE로 연장하지 않고 재검토 결과를 새 `policy_version`으로 추가해 `supersedes_policy_version`으로 연결한다.

snapshot은 policy row를 외래키로 참조한다. 최신 정책이 바뀌어도 과거 snapshot의 판단 근거는 바뀌지 않는다. Catalog publication transition은 transaction 시점에 참조 policy의 `review_due_at > transaction_timestamp()`를 다시 검사하고, 경과했으면 `SOURCE_POLICY_REVIEW_OVERDUE`로 신규 publish·version 전환을 거부한다. 만료는 기존 공개 version을 자동 철회하지 않지만 critical alert와 재검토 queue를 생성하며, 공식 robots/terms hash 변경은 fetch와 신규 publish를 즉시 중단한다.

---

## 18. 보안 경계

### 18.1 DB

- 신규 내부 테이블 모두 RLS 활성화
- public/anon/authenticated 직접 권한 revoke
- service_role에 필요한 최소 권한만 grant
- public view는 `security_barrier=true`
- `security definer` 함수는 고정 `search_path = public, extensions, pg_temp`
- RPC limit, cursor, 문자열 길이, filter 수를 DB와 앱 양쪽에서 검증
- JSON 크기 제한과 secret-like key 검사 적용
- append-only/version 테이블에 update/delete 방지 trigger 적용

### 18.2 네트워크·수집

- source별 HTTPS host allowlist
- redirect마다 host와 scheme 재검증
- localhost, 사설 IP, link-local, metadata endpoint 차단
- DNS rebinding 방어와 응답 크기 상한
- 압축 해제 크기와 PDF 페이지/텍스트 상한
- Content-Type 불일치 격리
- robots와 crawl delay 준수

### 18.3 AI

- 원천 문서를 untrusted input으로 구분
- source text 안의 지시문을 따르지 않도록 prompt와 구조 분리
- evidence 범위를 벗어난 사실 생성 검출
- 모델 응답을 HTML로 직접 렌더하지 않음
- 개인정보·비밀값 형태 검사 후 저장

---

## 19. 완료 판정과 reconciliation

### 19.1 snapshot 처리 완료식

```text
discovered_total
= published
+ excluded
+ duplicate
+ withdrawn
+ waived_failure
```

이 식은 **발견된 inventory의 처리 완료율**만 증명한다. 공식 모집단 coverage는 별도로 다음 조건을 만족해야 한다.

published item의 maintenance가 시작돼도 위 terminal 처리 완료율은 되돌리지 않는다. 대신 현재 parser/policy에 대한 별도 적합률을 계산한다.

```text
current_conformance
= (terminal outcome item 중
   needs_renormalize = false
   AND needs_reverify = false
   AND needs_republish = false
   AND verified parser/source policy가 현재 target과 일치하는 item 수)
  / terminal outcome item 수
```

따라서 `processing_completion=100%`, `current_conformance<100%`가 동시에 가능하다. parser v2 rollout 완료나 correction publication 완료를 주장하려면 current conformance도 100%여야 한다.

```text
coverage_assurance in (
  authoritative_enumerated,
  authoritative_counted,
  authoritative_crosschecked
)
+ expected_count와 discovered_count 일치
+ coverage evidence 검증 성공
+ closed manifest hash 검증 성공
```

`external_index_assisted`와 `best_effort`는 처리 완료율이 100%여도 공식 corpus coverage를 100%로 표시하지 않는다.

다음은 완료로 보지 않는다.

- `expected_count`가 있는데 discovered 수가 다름
- `candidate`, `queued`, `fetching`, `retry_wait` 항목이 남음
- terminal failure에 waiver reason/actor/expiry가 없음
- parser version이 run 중 혼합됨
- 공식 목록 페이지 일부가 timeout인데 빈 페이지로 처리됨
- max item/page 제한으로 잘린 run
- coverage assurance보다 강한 문구로 완료 상태를 표시한 run

### 19.2 waiver

불가피한 실패는 숨기지 않고 다음을 기록한다.

```text
item_id, error_code, evidence
waived_by, waived_at, waiver_reason
waiver_expires_at 또는 permanent 근거
```

waiver는 성공률 계산과 별도로 표시한다.

### 19.3 snapshot 간 diff

새 snapshot은 이전 snapshot과 다음을 비교한다.

```text
added
changed source hash
canonical URL changed
identifier changed/conflicted
missing from current source
withdrawn/redirected
```

“현재 목록에서 사라짐”만으로 즉시 삭제하지 않는다. 재확인 후 withdrawal transition을 실행한다.

---

## 20. 관측성·대시보드·알림

### 20.1 heartbeat

`WORKFLOW_KEYS`와 health 집계에 `catalog_backfill`을 추가한다. 기대 주기는 실제 scheduler 설정에서 파생하거나 명시적 runtime config로 관리한다.

heartbeat detail에는 민감 정보 없이 다음 집계만 허용한다.

```text
snapshotId, sourceKey, phase
claimed, succeeded, retryableFailed, terminalFailed
needsNormalize, needsReverify, needsRepublish
oldestPendingAt
```

### 20.2 source/year/type 지표

```text
expected / discovered / fetched / normalized / verified / published
excluded / duplicate / retry_wait / terminal_failure / waived_failure
processing completion ratio
current conformance ratio + needs_normalize/reverify/republish
coverage_assurance + corpus coverage status
source_only / light / full
enrichment current / stale, oldest stale age
oldest pending age
items/hour, success rate, retry rate, ETA
last successful reconciliation
parser/source policy version
```

건수만으로 정체를 판단하지 않고 최고령 대기 시간과 기대 실행 주기를 함께 본다. UI 문구도 `발견 항목 처리 완료 100%`와 `공식 범위 coverage 증명됨`을 별도 badge로 표시하며, assurance가 낮으면 “공식 전체”라는 표현을 사용하지 않는다.

### 20.3 경보

- heartbeat가 기대 주기의 1.5배: warning
- 2.5배 또는 failed: critical
- official expected/discovered 불일치: publication stop
- authority mismatch 급증: source adapter stop
- parser field missing 비율 임계 초과: 해당 partition stop
- retry queue oldest age 초과: warning/critical
- stale enrichment 재처리 지연이 기대 AI 처리 주기의 1.5배/2.5배 초과: warning/critical
- source policy `review_due_at` 임박: warning, 경과: 신규 publish stop + critical
- Catalog public 5xx·검색 p95 회귀: public flag rollback 검토

---

## 21. 단계별 구현 계획과 승인 gate

### Gate 0 — 계약 확정

작업:

1. source별 범위·재배포·robots 정책 문서화
2. 단일 `/articles` URL, P1 queue 재사용, 상태 모델 ADR 확정
3. identifier type별 decision/proceeding/lookup scope와 partial UNIQUE 확정
4. coverage assurance와 공식 분모 증거 계약 확정
5. P1 batch pass/item claim RPC와 lease 상한 확정
6. 공용 article version chain과 global/P3/Catalog head·pointer 분리 ADR 확정
7. source hash 기반 AI freshness와 stale 공개 precedence 확정
8. normalize 독립 재실행 계약과 source policy `review_due_at` 확정
9. authoritative source anchor와 AI/P3 anchor reference 계약 확정
10. published re-normalize pointer·phase 전이 계약 확정
11. feature flag precedence와 rollback 절차 확정
12. DDL과 RPC threat review

완료 조건:

- v2.1 식별자·coverage·fencing 보정과 v2.2 head·freshness·normalize·policy 기한 보정이 문서·DDL 테스트에 반영됨
- 아래 “구현 전 확정 필요 사항”이 모두 결정됨
- migration/권한/transition 계약 테스트 설계 승인

### Gate 1 — Durable ledger와 private shadow

작업:

1. inventory/run/item migration과 closed-manifest trigger
2. `coverage_assurance`와 두 종류 coverage 집계
3. P1 command/cohort TypeScript allowlist·validator·handler 확장
4. P1 attempt와 item claim/extend/complete/fail RPC 연결
5. `collect-range.ts`에서 adapter/parser 추출
6. fetch artifact와 append-only normalized artifact 계약
7. current/verified/published normalization pointer와 phase 전이 RPC
8. `plan/discover/fetch/normalize/verify/reconcile/status` CLI
9. `catalog_backfill` heartbeat

구현 보정:

- P1 pass의 `batchLimit`은 한 command가 처리할 총 item 상한이다. DB claim RPC는 그 상한 이하만 허용하고 worker는 item을 하나씩 claim한다. 아직 처리하지 않은 항목의 lease가 순차 처리 대기 중 만료되는 일을 피하고, 현재 item은 checkpoint마다 lease를 갱신한다.
- `source_backfill_runs`는 현재 P1 attempt ID와 fencing token을 보존한다. matching run이 `running`이 아니면 item claim을 거부하고, source run이 종결되지 않은 P1 attempt의 성공도 거부한다. P1 failure/abort/lease expiry는 item claim과 source run을 함께 종결한다.
- 유효기간이 지난 source policy로 snapshot을 열거나 새 fetch artifact를 기록할 수 없다. migration은 법적·운영 판단값을 임의 seed하지 않는다.
- Gate 1 release 검증은 PostgreSQL URL이 없는 skip을 승인 증거로 인정하지 않는다. disposable PostgreSQL에서 실제 migration·RPC·trigger를 실행한다.

canary:

```text
Spain, 한 연도, Sentencia, 공개 flag OFF
```

완료 조건:

- 강제 종료 후 정확히 재개
- 중복 worker에서 fencing 검증
- item lease가 유효한 P1 attempt lease를 초과하지 않음
- 공식 분모와 manifest 일치 및 coverage assurance 증거 존재
- closed manifest hash와 discovery field 불변성 검증
- 저장된 fetch artifact로 네트워크 없이 normalize 재실행 및 parser version 비교 가능
- published 재-normalize 중 terminal outcome 유지 + `needs_reverify/needs_republish`와 current conformance 하락 확인
- item 100% 종결 또는 승인된 waiver

### Gate 2 — 공용 article version과 Catalog publication

작업:

1. case metadata/identifiers
2. `article_revision_heads_v4` backfill + `article_version_capture_v4`
3. 기존 P3 candidate head와 Catalog/P3 publication pointer 분리
4. 명시적 P3 version 선택 및 version을 유지하는 withdraw RPC
5. authoritative source anchor 전용 Catalog publication/event
6. AI/P3 source anchor FK와 ID/hash freshness transition
7. `review_due_at` publication gate
8. public view와 progressive article detail
9. source-only/source-correction/stale-full fixture

완료 조건:

- Gemini를 호출하지 않은 verified case가 `/articles/{slug}`에서 공개
- raw/error/internal metadata가 공개되지 않음
- Catalog source-only capture가 기존 P3 candidate/publication pointer를 바꾸지 않음
- AI-only revision과 P3 publication이 Catalog source anchor를 바꾸지 않음
- P3 withdraw가 publication version_id를 바꾸지 않음
- 원문 hash 변경 직후 stale AI가 모든 public projection에서 제외됨
- P3 URL과 충돌 없음
- flag OFF 시 stale을 제외한 current P3-only로 즉시 복귀

### Gate 3 — 통합 검색과 플러그인

작업:

1. current P3 + Catalog dedupe read model과 stale fail-closed projection
2. exact identity 검색
3. plugin additive contract와 상태별 fetch
4. 한국어 홈페이지 사용 안내 유지
5. rate limit·timeout·cursor 적용

완료 조건:

- source_only/light/full과 light/full+stale 모두 계약 테스트 통과
- 같은 article이 한 번만 반환
- source-only와 stale 상태에 AI 요약 heading·본문 없음
- 기존 plugin smoke test와 공개 URL 회귀 없음

### Gate 4 — 다국어 recall

상태: 로컬 DB·앱·플러그인 접합 구현 및 격리 PostgreSQL 검증 완료. 운영 alias review, migration, precision/recall 표본과 p95 canary는 미완료.

작업:

1. reviewed legal concept/alias schema
2. bounded OR expansion
3. ranking version과 RRF
4. deterministic cursor
5. relevance 보존형 국가 다양화

완료 조건:

- 한국어·영어·독일어·프랑스어·스페인어 fixture
- exact identity 우선순위 불변
- 0건/저관련성 결과를 다양성 때문에 부풀리지 않음
- p95와 DB statement timeout 기준 충족

### Gate 5 — 국가별 확대

상태: Spain 2020~2023 Sentencia와 France 2010~현재 Conseil QPC/DC의 연도·유형별 scope, 공식 count reconciliation, P1 이중 잠금은 로컬 구현·테스트 완료. 미국 Constitution Annotated는 Table citation을 `candidate`로만 정규화하고 하급법원 인용·공식 페이지 challenge·landmark priority 우회를 차단하는 parser 계약, 불변 snapshot·essay provenance·append-only CAS review를 갖춘 비공개 durable graph, source policy·flag·payload hash 잠금 import CLI까지 구현했다. `U.S.` reporter 후보를 GovInfo U.S. Reports의 예측 가능한 granule에 결속하는 robots fail-closed resolver는 라이브 검증했고, candidate ID 기반 probe와 별도 append-only authority artifact 기록 경로도 구현했다. `verified` 전환은 최신 GovInfo authority artifact, 같은 candidate의 공식 essay evidence, 공식 details/PDF에 결속된 constitutional question·holding locator를 모두 요구하는 `us_conan_candidate_review_v2`와 전용 review CLI로만 허용한다. 구 v1 RPC의 verified 전환, stale authority 관측, 다른 candidate의 essay, 비공식 holding URL은 DB에서 거부하며 v1/v2 revision append는 같은 advisory lock으로 직렬화한다. 최신 verified review를 Constitution Annotated discovery policy와 별도 `us-scotus` GovInfo publication policy로 재검증하여 metadata-only authoritative source anchor를 만드는 DB bridge와 운영 publication CLI도 구현했다. 계획 모드는 현재 review/Catalog CAS와 결정적 idempotency key를 무쓰기 조회하고, 실행은 Catalog write와 미국 publication 전용 flag를 모두 요구한다. bridge는 review·authority·candidate manifest·article version·Catalog publication revision을 불변 event와 복합 FK로 결속하며, 재검토만으로 source anchor를 전진시키지 않고 Gemini/P3 pointer를 만들지 않는다. 발행 후에는 service-role 전용 read-only canary RPC/CLI가 최신 review·authority·manifest·policy·anchor·public detail·P3 분리를 하나의 DB snapshot에서 검증한다. 실제 승인된 production source policy 등록, canary 실데이터 PASS와 운영 migration은 아직 남아 있으므로 국가별 history flag 기본값은 false이며 실데이터 실행은 미완료.

권장 순서:

```text
1. Spain 2020~2024 Sentencia
2. France 2010~현재 Conseil QPC/DC
3. US Constitution Annotated 고정밀 graph와 선거구획정 landmark
4. Spain 1980~2019 Sentencia + Declaración
5. Germany 공식 공개 결정 집합 1998~현재
6. France 기타 Conseil decision 유형
7. Spain Auto
8. US 전체 SCOTUS candidate metadata
```

각 단계는 별도 snapshot과 gate를 가진다. 앞 국가의 parser 결함을 안고 다음 국가로 넘어가지 않는다.

### Gate 6 — 장기 AI·임베딩

작업:

1. light artifact
2. full enrichment → 기존 P3 승격
3. demand aggregate와 bounded priority
4. Catalog Gemini retrieval embedding
5. semantic canary와 coverage gate

완료 조건:

- quota 소진 중에도 Catalog 수집·검색 정상
- provenance 없는 AI/embedding artifact 0건
- source anchor ID/hash가 바뀐 stale artifact 식별, 공개 제외, 재처리 우선순위 상승
- Gemini 외 provider 사용 0건

---

## 22. 배포·롤백 전략

additive migration과 단계적 flag를 사용한다.

```text
ADMIN_PUBLICATION_V4_READ_ENABLED
CASE_CATALOG_WRITE_ENABLED
CASE_CATALOG_PUBLIC_ENABLED
CASE_CATALOG_SEARCH_ENABLED
CASE_CATALOG_PLUGIN_ENABLED
CASE_CATALOG_SEMANTIC_ENABLED
```

`ADMIN_PUBLICATION_V4_READ_ENABLED`가 공개 read authority의 선행 조건이다. Catalog write는 private shadow로 독립 실행할 수 있지만, Catalog public/search/plugin은 P3 read가 켜진 뒤에만 유효하다.

| P3 read | Catalog public | Catalog search/plugin | 유효 동작 |
|---:|---:|---:|---|
| OFF | OFF | OFF | legacy public read + 항상 켜진 AI freshness guard |
| ON | OFF | OFF | P3 projection + stale AI 제외 |
| ON | ON | OFF | P3 + Catalog 상세 공개, 검색은 P3-only |
| ON | ON | ON | unified P3 + Catalog |
| OFF | ON | 임의 | **configuration error**, Catalog를 fail-closed하고 readiness 실패 |
| 임의 | OFF | ON | **configuration error**, search/plugin을 fail-closed하고 readiness 실패 |

추가 의존성:

```text
CASE_CATALOG_PLUGIN_ENABLED -> CASE_CATALOG_SEARCH_ENABLED
CASE_CATALOG_SEMANTIC_ENABLED -> CASE_CATALOG_SEARCH_ENABLED
CASE_CATALOG_SEARCH_ENABLED -> CASE_CATALOG_PUBLIC_ENABLED
CASE_CATALOG_PUBLIC_ENABLED -> ADMIN_PUBLICATION_V4_READ_ENABLED
```

서버 시작·readiness·`scripts/check.ts`가 이 matrix를 검증한다. invalid 조합을 암묵적으로 legacy나 Catalog-only로 해석하지 않는다.

AI freshness guard는 rollout flag가 아니라 데이터 정합성 불변조건이다. `ADMIN_PUBLICATION_V4_READ_ENABLED`와 Catalog flag가 꺼져도 legacy/P3 service가 stale marker와 source anchor ID/hash를 검사한다. 필요한 schema가 불완전하거나 freshness를 판정할 수 없으면 AI 요약을 숨기는 `unknown-as-stale` 정책을 사용한다.

순서:

1. migration 적용, Catalog flag OFF, 기존 P3 flag 상태 보존
2. private shadow write
3. reconciliation·권한·누출 검사
4. admin/내부 shadow read 비교
5. Catalog detail canary
6. search 일부 트래픽 canary
7. plugin 활성화
8. semantic 별도 활성화

롤백:

- public/search/plugin/semantic flag를 역순으로 끈다.
- 기존 P3 read path는 유지한다.
- Catalog flag를 끄더라도 source anchor ID/hash가 불일치한 stale P3 summary를 다시 노출하지 않는다. 안전한 current P3가 없으면 해당 P3 표현은 숨긴다.
- migration과 수집 데이터는 삭제하지 않는다.
- 잘못 공개된 version은 withdrawal event로 닫고 감사 이력을 보존한다.
- schema rollback이 필요한 경우에도 먼저 app compatibility release를 배포한다.

---

## 23. 필수 테스트

### 23.1 migration·권한

- 신규 constraint와 composite FK
- anon/authenticated 내부 테이블 접근 거부
- service-role RPC 허용
- security-definer search path
- immutable trigger와 event append-only
- oversized/secret-like JSON 거부
- `article_revision_heads_v4`가 기존 article별 최고 revision으로 정확히 backfill됨
- global head/P3 candidate head가 서로 다른 version을 안전하게 가리킴
- 기존 공개 P3 전량이 freshness basis로 분류되고 count/digest reconciliation 전 guard 활성화가 거부됨
- hash 재현 불가 legacy P3가 `unknown_fail_closed + stale`로 격리되고 공개 AI가 숨겨짐
- 기존 immutable `p3.article.v1`을 수정하지 않고 authoritative/full v4 쌍을 생성해 P3 pointer를 payload 동등 version으로 이행
- legacy 이행 전후 public payload digest가 같고 source anchor와 P3 version role이 분리됨
- `review_due_at <= reviewed_at` policy row 거부
- `review_due_at` 경과 policy로 신규 Catalog publish 거부

### 23.2 identity·dedupe

- 같은 source/ECLI 재수집 멱등
- 같은 ECLI의 대소문자·공백·구두점 정규화
- source가 다른 동일 문자열 충돌 없음
- 같은 독일 docket의 날짜가 다른 복수 결정 저장 성공
- decision-unique identifier 중복은 거부하고 docket/case_key 중복은 허용
- URL 변경 시 기존 article 유지
- identifier 충돌 시 자동 merge 금지
- generated `case_key` 오탐 시 authority identity 보존

### 23.3 실행 내구성

- batch 중간 강제 종료·재개
- lease 만료 후 새 worker 인수
- 오래된 fencing token write 거부
- item claim attempt/token/phase 불일치 거부
- item lease가 P1 attempt lease를 초과하면 거부
- P1 lease 만료 후 item complete/fail 거부
- 같은 command idempotency 재실행
- 한 batch pass가 최대 item 수만 처리하고 backlog에 다음 pass 제출
- fetch와 normalize가 별도 command/pass/idempotency key로 재개됨
- published item의 refresh/normalize/verify 중 `status=published` 유지
- current normalization 전환 후 `needs_reverify=true`, 검증 후 변경이 있으면 `needs_republish=true`
- 같은 normalized output 재검증은 no-op event와 pointer 정렬만 수행하고 새 Catalog version을 만들지 않음
- `waived_failure`, `excluded`, `duplicate`, `withdrawn`의 자동 reopen 거부
- 429/5xx/timeout/parser/robots 오류별 상태
- abort 후 새 항목 claim 중지

### 23.4 source parser

- 공식 응답 fixture와 parser version
- 빈 페이지와 마지막 페이지 구분
- pagination 중복·누락 탐지
- HTTP 200 오류 페이지 탐지
- source lastmod와 decision date 구분
- PDF/HTML 변경 hash
- 같은 fetch artifact를 parser v1/v2로 normalize해 version별 output을 보존하고 네트워크 재호출 0회
- raw snapshot 비보존 source의 재현 가능 evidence 부족 시 독립 normalize 완료 거부
- 독일 외부 index와 공식 detail 불일치
- 미국 slip opinion 수정
- Constitution Annotated 하급법원 citation이 SCOTUS verified로 자동 승격되지 않음
- closed snapshot discovery 필드 INSERT/UPDATE/DELETE 거부
- closed snapshot processing 필드의 허용된 상태 전이 성공
- manifest hash 재계산 불일치 탐지

### 23.5 publication·페이지

- summary 없는 verified case 공개
- authority candidate/rejected 공개 거부
- text policy별 egress
- 새 version 전환과 이전 version 불변
- source-only → source correction → full이 하나의 `article_content_versions_p3` parent chain을 형성
- authoritative source version은 self anchor, light/full version은 published Catalog source anchor를 참조
- Catalog pointer가 AI-only version을 거부하고 P3 pointer가 authoritative source version을 거부
- AI/P3 version 생성·전환 후에도 Catalog source anchor가 불변
- Catalog source-only capture가 `article_version_heads_p3`와 `article_publications_p3.version_id`를 전진시키지 않음
- P3 withdraw 전후 `article_publications_p3.version_id`가 동일함
- P3 publish/republish가 명시된 full·eligible·current version 외 global head를 선택하지 않음
- global/P3/publication optimistic revision을 바꾸어 전달했을 때 stale write 거부
- source hash A→B 교정 시 `full + stale`, `summaryAvailable=false`, `summaryStatus=reprocessing`
- source hash가 같아도 source anchor ID가 바뀌면 기존 AI를 stale로 판정
- 새 hash B 기반 full artifact 승격 후에만 `full + current` 복구
- freshness join/schema가 불완전한 unknown 상태에서 AI 요약을 숨김
- withdrawal과 redirect
- source_only/light/full progressive 렌더
- canonical URL 하나
- full artifact의 필수 SummaryJson claim마다 유효한 `claim_evidence_map` 존재

### 23.6 검색

- ECLI/docket/decision number exact 검색
- 한국어 `게리맨더링`, 영어 `gerrymandering`
- 독일어 `Wahlkreiseinteilung`
- 프랑스어 `découpage électoral`
- 스페인어 `delimitación electoral`
- alias OR recall과 exact 우선순위
- P3/Catalog dedupe
- stale P3 lexical/semantic/AI tag 후보 제외와 current Catalog 대표 결과 확인
- stale summary embedding 제외, current Catalog embedding만 허용
- cursor 결정성·ranking version 만료
- semantic OFF fallback
- 국가 다양성의 relevance threshold

### 23.7 플러그인

- source_only/light/full search response
- source-only fetch에 AI 요약 섹션 없음
- stale fetch에 과거 AI 본문 없음, `summaryStatus=reprocessing`과 최신 공식 정보만 존재
- `fetch_source_text` 정책 우회 불가
- malformed/과대 입력 거부
- public no-auth smoke
- 홈페이지 한국어 연결 안내와 주소 복사

### 23.8 운영

- heartbeat success/failed/deferred/stale
- expected/discovered mismatch 경보
- oldest pending 경보
- stale enrichment 수·최고령 stale age·재처리 queue 경보
- source policy review due 사전 경고와 overdue critical
- feature flag rollback
- 모든 Catalog/P3 flag OFF rollback에서도 stale·unknown AI가 다시 노출되지 않음
- P3 OFF + Catalog public/search ON 조합 readiness 실패
- Catalog public OFF + search/plugin ON 조합 readiness 실패
- 기존 P3 publication/search/detail/plugin 회귀 없음

---

## 24. 성능·운영 기준

초기 목표값이며 실제 baseline 측정 후 조정한다.

| 항목 | 목표 |
|---|---:|
| 공개 검색 p95 | 1.0초 이하 |
| 상세 조회 p95 | 500ms 이하(cache hit 기준) |
| DB 검색 statement timeout | 2초 이하 |
| worker batch | 25~100건 |
| 공개 검색 최대 결과 | 50건 |
| plugin 기본 결과 | 10건 |
| source별 동시성 | source policy가 허용한 값, 기본 1 |
| 실패 재시도 | 오류 종류별 제한, 무한 재시도 금지 |

성능 때문에 snapshot 분모, authority 검증, publication 불변성을 생략하지 않는다. 검색 부하는 index, keyset cursor, bounded expansion, cache로 해결한다.

---

## 25. 위험과 대응

| 위험 | 영향 | 대응 |
|---|---|---|
| 공식 UI/API 변경 | discovery 누락 | parser version, fixture, expected count, stop-the-line |
| 외부 인덱스 불완전 | 독일 누락 | external coverage 명시, 다중 discovery, 공식 검증 |
| 식별자 충돌 | 잘못된 병합 | source-scoped 복수 식별자, 자동 merge 금지 |
| 원문 재배포 제한 | 법적·정책 위험 | text_access_policy, source policy review |
| mutable article 직접 공개 | 감사·철회 불가 | 공용 immutable article version + Catalog publication |
| global head와 P3 head 혼용 | withdraw pointer 오염·republish 실패 | global revision head, P3 candidate head, publication pointer 분리 |
| Catalog anchor와 AI display version 혼용 | 정상 AI가 stale 처리되거나 공식 pointer가 AI version으로 이동 | Catalog는 authoritative self-anchor만, AI/P3는 anchor FK 사용 |
| 원문 교정 후 stale AI 노출 | 최신 공식 원문과 한국어 요약 불일치 | source hash binding, stale 공개 제외, 우선 재처리 |
| published item 상태 demotion | 완료율 왜곡·재처리 상태 은폐 | terminal status 유지, artifact pointer 기반 current conformance |
| 공개 endpoint 남용 | 비용·랭킹 조작 | rate limit, bot filter, demand cap |
| Gemini quota | AI backlog | Catalog와 분리, deferred retry |
| 모델/input 변경 | vector space 혼합 | artifact namespace, provenance, canary |
| 장기 작업 정지 | 조용한 미완료 | heartbeat + oldest pending + expected interval |
| 국가 다양성 과보정 | 저관련성 결과 | relevance threshold 후 bounded penalty |

### Stop-the-line 조건

다음 상황에서는 해당 source의 publish를 자동 중단한다.

- 공식 expected count와 manifest가 불일치
- parser 필수 필드 누락률이 기준 초과
- authority URL host 또는 redirect 정책 위반
- 식별자 충돌 급증
- source policy version 미설정/만료
- P3/light artifact source anchor ID/hash와 현재 Catalog source anchor 불일치를 current로 노출
- 원문 hash가 광범위하게 비결정적으로 변경
- 공개 projection에서 금지 필드가 탐지됨
- 오래된 fencing token의 write 수락

---

## 26. 구현 전 확정 필요 사항

다음은 코드로 추정하지 말고 운영·정책 결정으로 확정한다.

1. 국가별 최초 공식 scope의 시작일·문서 유형
2. France QPC360에서 Conseil 외 QPC 관련 법원 결정의 포함 여부
3. source별 원문 저장·index·excerpt·full egress 허용 수준
4. 허용된 object storage와 retention 기간
5. terminal failure waiver 승인자와 만료 정책
6. Catalog 공개 전 수동 표본 검토 비율
7. source별 expected schedule와 alert 임계값
8. semantic 활성화에 필요한 최소 embedding coverage
9. source별 정책 재검토 주기와 `review_due_at` 최초 값

이 항목이 확정되지 않은 source는 `candidate/private`까지 구현할 수 있으나 public publish를 시작하지 않는다.

---

## 27. 첫 구현 단위와 커밋 분리

첫 구현은 공개 UI가 아니라 **완료를 증명하는 ledger와 상태 경계**부터 시작한다.

권장 커밋 순서:

```text
1. docs: source policy/ADR와 fixture 계약
2. db: inventory/run/item + RLS/RPC
3. ops: P1 command integration(fetch/normalize 분리) + heartbeat
4. ingest: Spain adapter를 durable discovery/fetch/normalize에 연결
5. test: interruption/fencing/reconciliation/parser replay
6. db: case metadata/identifiers + global/P3 head 분리 + Catalog publication
7. db: source hash freshness/stale transition + policy review gate
8. web: /articles progressive detail와 stale 안내
9. search: current P3 + Catalog exact/lexical read model
10. plugin: additive enrichment/freshness contract
11. search: aliases/RRF/diversification
12. ai: Gemini light/full artifacts
13. ai: Gemini Catalog retrieval embeddings
```

첫 vertical slice:

```text
Spain 2024 Sentencia
→ 공식 inventory snapshot
→ item ledger
→ fetch artifact + 독립 normalize
→ authority verify
→ immutable Catalog publish
→ /articles 상세
→ 홈페이지·플러그인 exact/lexical 검색
→ Gemini 호출 0회
```

이 slice가 Gate 1~3을 통과한 뒤에만 국가·기간을 확대한다.

---

## 28. 최종 결론

WorldCons의 확장 원칙은 다음 한 문장으로 정리한다.

> **공식 원천의 선언된 범위를 불변 inventory와 항목별 원장으로 증명하고, 검증된 최신 판례를 단일 URL의 Catalog source anchor로 먼저 공개한 뒤, 같은 anchor ID/hash에 결속된 Gemini light/full enrichment와 retrieval embedding만 current 표현으로 점진 적용한다.**

우선순위는 다음과 같다.

```text
완료 증명 가능한 ledger
→ authority/identity/text policy
→ global revision/P3 candidate/Catalog source anchor·P3 publication pointer 분리
→ immutable Catalog publication
→ source hash freshness와 stale fail-closed
→ 단일 URL과 통합 검색·플러그인
→ 다국어 recall
→ 국가별 범위 확대
→ Gemini enrichment·embedding 장기 처리
```

이 순서를 지키면 Gemini 무료 quota, 장기 백필 중단, 원천 URL 변경, 외부 인덱스 불완전, 공개 정책 변경이 발생해도 기존 P3와 공개 검색을 보존하면서 안전하게 재개·철회·확장할 수 있다.

---

## 부록 A. 공식 원천 검토 링크

- Spain Tribunal Constitucional HJ 검색: <https://hj.tribunalconstitucional.es/es/Resolucion/Show/viewmatches.aspx>
- Spain Tribunal Constitucional jurisprudencia: <https://www.tribunalconstitucional.es/es/jurisprudencia/Paginas/default.aspx>
- France QPC360 검색 도움말: <https://qpc360.conseil-constitutionnel.fr/aide-recherche>
- France QPC360 jurisprudence: <https://qpc360.conseil-constitutionnel.fr/recherche/jurisprudence>
- Germany BVerfG 결정 안내: <https://www.bundesverfassungsgericht.de/DE/Entscheidungen/entscheidungen_node.html>
- Germany `2 BvR 547/21` 2021-03-26 결정: <https://www.bundesverfassungsgericht.de/SharedDocs/Entscheidungen/DE/2021/03/rs20210326_2bvr054721.html>
- Germany `2 BvR 547/21` 2021-04-15 결정: <https://www.bundesverfassungsgericht.de/SharedDocs/Downloads/DE/2021/04/rs20210415_2bvr054721.html>
- U.S. Constitution Annotated 소개: <https://constitution.congress.gov/about/constitution-annotated/>
- U.S. Constitution Annotated 판례 자료: <https://constitution.congress.gov/resources/>
- U.S. Constitution Annotated Table of Cases: <https://constitution.congress.gov/resources/cases-cited/>
- U.S. Supreme Court opinions: <https://www.supremecourt.gov/opinions/>
- U.S. Reports와 공식 판례집 설명: <https://www.supremecourt.gov/opinions/usreports.aspx>

공식 사이트의 구조·robots·이용 조건은 구현 시점에 다시 확인하고 `source_policy_version`에 검토 시각과 근거를 고정한다.
