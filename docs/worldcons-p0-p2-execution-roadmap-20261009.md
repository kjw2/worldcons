# WorldCons P0–P2 실행 계획 및 핸드오프 (2026-10-09 KST)

> **이 파일이 P0/P1/P2 작업 번호의 기준 문서다.** 새 대화에서 사용자가 `P2-1 진행`, `다음 진행` 등으로 지시하면 먼저 이 파일과 Production 상태를 확인한다. 이미 정해진 번호를 다시 묻지 않는다. 과거 대화의 표가 운영 현실보다 오래됐을 수 있으므로 `progress.md`, Git HEAD, Cloudflare Production을 함께 대조한다.

## 1. 번호별 작업·현재 상태

| 번호 | 작업 | 상태 (2026-10-09) | 완료 기준 및 비고 |
| --- | --- | --- | --- |
| P0-1 | 프랑스 staged-ingest Production 최초 E2E | **완료** | `2026-335 L`, article `16b4fc11-d9cc-4e5b-b8e5-acf687ab760e`: 7단계 성공, search 재투영 포함 8/8 stage jobs·outbox 성공, 실패/DLQ/redrive 0 |
| P0-2 | 잔여 회귀 수정 커밋·`main` 푸시·Production 반영 | **완료** | 과거 회귀 검사 복구 및 Production 배포 이력 검증. 이후 변경을 수행할 때도 새 테스트가 통과해야 함 |
| P0-3 | 스페인 adapter/canary 안전 보완·Production 배포 | **완료** | `Show/0` 제외, 공식 JSON 정규화 연계, 1건 제한, staged 소유권과 M8 제외를 함께 적용 (`0368905` 등) |
| P1-1 | **스페인 실제 Production 7단계 E2E 검증** | **대기** | 첫 2026-10-10 06:00 KST 정기 Discovery 이후 stage jobs/events/outbox/DLQ, 공식 HJ ID/JSON 원문(충분한 본문), R2, Core, 번역, Public Judgment, P3, Search를 판례 단위로 추적. 장애 시 false publish 없이 원인 수정 |
| P1-2 | 독일 BVerfG 공식 원문 URL/ECLI identity gate | **완료** | `9fa36e2`: 공식 판결 본문·정확한 ECLI·리다이렉트 최종 URL 검증, 잘못된 HTML 및 불일치 차단 |
| P1-3 | 독일 M8 후보 404 head-of-line/백오프 개선 | **구현·배포 완료, 실운영 효과 미검증** | `4b384be`: D1 상태 기반 bounded 후보 순환, 백오프 중 후보 defer, D1 장애 시 fail-closed, `degraded` 진단. 다음 M8 실행의 실제 fetch를 별도 확인 |
| **P2-1** | **미국 SCOTUS 공식 PDF 원문 추출 구현** | **구현·검증·Production 배포 완료, 실원문 E2E 대기** | 코드 `cc6059e`, Worker 버전 `4189c105-43db-4800-b557-9571c8ba6ee7`. `unpdf` Worker-safe 텍스트 추출, 공식 PDF/redirect/robots/docket/용량 검증, R2 원본 SHA-256 및 Core provenance 연결. 미국 M8 소유권 유지·공개 발행 보류. 실제 SCOTUS 판례 원문 처리는 추후 확인 |
| P2-2 | 검증된 국가별 staged-ingest 확대 및 M8 중복 수집 책임 정리 | **단계적 진행** | 프랑스+스페인 이미 staged 소유. 독일·미국은 readiness와 live E2E를 통과한 후 각각 staged allowlist/M8 제외를 **같은 배포에서 쌍으로** 변경. 무제한 동시 활성화 금지. 미국 term 경계 Discovery 보완은 로컬 검증 중이며 Production 반영과 별개 |

## 2. 현재 운영 상태의 기준

- Production-only: Cloudflare `worldcons`와 `worldcons-ingest` Workers, D1(`worldcons_ingest`, `worldcons_core` 등), R2, Queues. **preview/staging 생성 금지**.
- `NATIVE_CRAWLER_SOURCES`: `de-bverfg`, `us-scotus`, `fr-conseil-constitutionnel`, `es-tribunal-constitucional`.
- staged-ingest 소유: **프랑스+스페인**. `WORLDCONS_INGEST_STAGE_SOURCE_ALLOWLIST=fr-conseil-constitutionnel,es-tribunal-constitucional`.
- 기존 M8 `crawler-daily` 소유: **독일+미국**. `M8_CRAWLER_SOURCE_EXCLUDE=fr-conseil-constitutionnel,es-tribunal-constitucional`. 나머지 M8 종류는 유지.
- staged 7단계: Discovery → Crawl → Normalize → Translate → Public Judgment → Publish → Search. Bootstrap **source당 1건**, dispatch **stage당 1건/15분**, 일일 Discovery `0 21 * * *` UTC = 다음날 06:00 KST.
- 2026-10-09 P2-1 배포 기준: `worldcons-ingest` version `4189c105-43db-4800-b557-9571c8ba6ee7`; P2-1 코드 커밋 `cc6059e401dae6daae530aa0350f72543f64b524`가 GitHub `main`에 반영됨.
- 프랑스 Production E2E는 성공했지만, **스페인/독일/미국 전체 E2E를 의미하지 않는다**. 프랑스 1개 소스 제한은 원래 사용자의 정책이 아니라 이전 assistant의 임시 카나리였다.

## 3. P2-1 — SCOTUS PDF 추출 작업 세부 승인 범위

1. 기존 `workers/async-pipeline/src/native-crawler.ts`의 미국 PDF `metadata_only` 경로 및 기존 M8/Stage Crawl 연결점을 코드 기준으로 점검한다.
2. **Worker 호환성이 실제 빌드로 검증된 PDF 추출 방식**을 선택한다. 안전한 시간·파일 크기·페이지·추출 글자 수 제한을 둔다. 빈 본문, 스캔 이미지, 암호화·손상 PDF, HTML/차단 페이지, HTTP 오류에 대해 원문 추출 성공을 위조하지 않는다.
3. 출처는 `supremecourt.gov`의 실제 공식 slip-opinion PDF로 한정하고, Content-Type뿐 아니라 PDF 바이트 시그니처, 최종 공식 URL, 사건 번호/식별자 및 텍스트 품질을 확인한다. 공식 PDF 원본과 추출 텍스트의 콘텐츠 해시·출처 메타데이터를 R2/Core 흐름에 보존한다.
4. 공식 출처 및 본문 검증이 충족되지 않는 경우 **`metadata_only` / review required / publication 불가**를 유지한다. P3·Catalog·Public Judgment·Search gate 우회 금지. 표제/URL/날짜 문자열을 실제 판결 본문으로 취급하지 않는다.
5. 정상 텍스트 PDF, 이미지 전용·암호화·손상·비공식 PDF, docket 불일치, 크기 초과, HTTP 장애 등 모의 fixture 기반 회귀 테스트를 작성한다. 외부 법원 사이트에 대량 수집이나 공격적인 반복 프로브를 하지 않는다.
6. `pnpm test:native-crawler`, `test:m8`, `test:ingest-stages`, `pnpm check`, TypeScript/M8 타입·Wrangler dry-run과 관련 회귀를 통과시킨 뒤 커밋한다. **M8→staged 미국 소유권 전환은 P2-1 범위에 포함하지 않는다**. Production 배포 후 health·원문 provenance를 검증하고 실제 E2E 여부를 구분 보고한다.

## 4. 변경·운영 절대 원칙

### P2-2 국가별 source readiness 중간 감사 (2026-10-09 18:21 KST)

| Source | Discovery / Crawl 공식 원문 | Normalize / Translate | Public Judgment / P3 / Search | 확대 판단 |
| --- | --- | --- | --- | --- |
| `fr-conseil-constitutionnel` | 공식 HTML 수집 및 Production 원문 검증 완료 | 실제 E2E 성공 | P3/Search 포함 8/8 jobs 성공 | **staged 운영 확인 완료** |
| `es-tribunal-constitucional` | 공식 HJ 검색·tail 및 JSON 본문 adapter 구현; `Show/0` 제외 | 공통 Normalize/Translate 연계 구현 | 공통 gate 및 검색 경로 구현, 실제 E2E 미확인 | **bounded staged canary 유지**, 2026-10-10 06:00 KST 이후 실증 필요 |
| `de-bverfg` | 공식 HTML + 정확한 ECLI identity gate, D1-aware 404 후보 백오프 구현 | 공통 Normalize/Translate 경로 연결 | 공통 gate는 존재하나 독일 판례 실전 P3/Search 미검증 | **M8 유지**, 실제 공식 fetch/번역/발행 readiness 후 staged 전환 |
| `us-scotus` | 공식 PDF URL·robots·MIME·docket 검증과 R2 원본 보존 구현, 모의 PDF 통과 | 수집 텍스트는 보존하나 `articleStatus`가 의도적으로 `needs_review` 반환 | `collection.publishable=false` 및 review gate로 공개·검색 자동 승격 차단 | **M8 유지**, 실제 PDF E2E 및 별도 공개 정책 검토 전 staged 전환 금지 |

- 공통 staged 핸들러는 7단계를 모두 지원하지만 **핸들러가 존재한다는 것과 해당 국가가 실제 Production 발행까지 검증됐다는 것은 별개**다.
- 국가별 staged 전환 시 `WORLDCONS_INGEST_STAGE_SOURCE_ALLOWLIST` 추가와 `M8_CRAWLER_SOURCE_EXCLUDE` 추가를 같은 검증 배포에서 쌍으로 수행한다. 미검증 상태에서 전체 allowlist를 풀지 않는다.
- 운영 접근 진단: 2026-10-09 18시 KST 전후 Cloudflare D1 REST/CLI가 때때로 `7403`을 반환. 같은 계정의 `d1 list`·`d1 info`, ingest/core SELECT도 성공했으므로 영구 권한 차단으로 단정 불가. **19시 KST 후속 검사에서도 `worldcons_core`의 PRAGMA 성공 직후 SELECT가 `7403`으로 실패했지만, 동일 계정·DB·OAuth scope(`d1:write`)에서 재조회 성공. 즉 간헐 재발하며 근본 원인은 미확정.** credentials 변경/권한 우회 없이 오류 빈도·Cloudflare 장애/지원 경로를 계속 조사한다.
- 복구 후 Production D1 실측: France staged jobs 8/8 `succeeded` (search 2건), events 30건, pending/failed dispatch outbox 0, dead-letter 0, redrive 0. Spain은 첫 2026-10-10 06:00 KST Discovery 전이므로 staged job 아직 없음. 가장 최근 M8 US 2026-10-09 06:02 KST 수집은 discovered/fetched 0/0, 독일은 discovered/fetched 1/0; 두 나라 모두 실원문 완료 아님.
- 다음 확인 순서: (1) Cloudflare D1 접근 권한 복구, (2) 스페인 stage jobs/events/outbox/DLQ 및 원문→P3→Search 실증, (3) 미국 M8 PDF R2/Core 원문·review 상태 확인, (4) 독일 M8 후보 처리 실증, (5) 검증된 source만 단계적으로 소유권 이관.

### 2026-10-09 후속 운영 진단 및 코드 보완 (현재 로컬, 아직 Production 미반영)

- SCOTUS 공식 `opinions/slipopinion/26`은 새 October Term 2026의 표가 빈 상태다. 따라서 2026-10-09 06:02 KST M8 `discovered=0` 자체는 PDF extractor 장애가 아니라 **현재 term만 보는 Discovery 로직의 예상 결과**다. 이전 October Term `opinions/slipopinion/25`의 최근 원문 또는 revisions를 조회하지 않아 가을 학기 전환기의 누락 가능성이 확인됨.
- `native-crawler.ts`: 새 term 시작 후 UTC 90일 동안만 공식 current + immediate prior slip-opinion 목록을 각 1회 조회, 원래의 14일 기본 공개일/90일 수정일 필터와 `limit+100` 한도, URL 중복 제거 및 robots/request-governor 유지. 필요한 이전 목록이 실패하면 조용한 성공(0건)으로 처리하지 않음. 기존 미국 M8 ownership·PDF 검증·`publishable=false`·review gate에는 변경 없음.
- `tests/native-crawler.test.ts`: 새 term 목록이 비어 있고 이전 term 판결이 10월 수정된 사례, 이전 목록 HTTP 503 fail-closed, 90일 겹침 종료 후 1페이지만 조회되는 사례 추가. **이 변경은 로컬 테스트·리뷰 후에만 별도 배포 판단**하고, 실제 미국 PDF Production E2E 완료라고 부르지 않는다.
- 독일 D1 최신 후보는 `2 BvR 1702/26`, `rk20260917_2bvr170226.html`로 `BVERFG_OFFICIAL_VARIANTS_404`, `retrying` 및 누적 시도 20회. 일부 제3자 색인에는 같은 ECLI가 존재하지만 **공식 원문 URL/본문은 검증되지 않았으므로** M8·review hold 유지. 최신 M8은 1건 발견·원문 0건.
- 스페인 `0 21 * * *` UTC 최초 cron 전에는 staged jobs 0건이 정상일 수 있다. `worldcons-ingest`에 수동 Discovery POST 운영 API가 없음을 코드로 확인; ad-hoc D1 job 삽입이나 우회 경로로 조기 실행하지 않는다. 2026-10-10 06:00 KST 이후 실제 7단계/DLQ/R2/Core/P3/Search를 확인한다.
- 요청된 `opencode::hive-ai::deepseek-ai/deepseek-v4.1-flash` 작업 호출은 실행 전 `INVALID_REQUEST`로 실패해 작업 세션 자체가 생성되지 않았으며 Orca는 사용하지 않았다. 보완 코드는 직접 처리하고 테스트 결과를 별도 기록한다.
- SCOTUS term rollover 보완은 2026-10-09 로컬 `42ee7e3`로 커밋 완료. native crawler **28/28**, M8 **48/48**, staged **51/51**, `pnpm check`, `tsc --noEmit`, Worker Wrangler dry-run 통과; 변경 파일 ESLint 오류 0, 기존 경고 2. **GitHub main 푸시 및 Production 배포는 아직 수행하지 않음.**

### 2026-10-09 19시 KST Production 독일 및 P3 공개 안전 추가 감사

- `worldcons_ingest.source_url_candidates` 독일: 과거 `fetched` **40**, `BVERFG_OFFICIAL_VARIANTS_404`로 `retrying` **9**, 같은 코드의 `ignored` **1**. 최신 `2 BvR 1702/26`은 2026-10-09 06:01 KST 시각에 누적 20번째 실패. 재시도 10회 이상 규칙은 3일(-cron grace 6시간)로, 다음 일일 M8 eligibility는 별도 신규 후보가 없다면 **2026-10-12 06:00 KST 이후**. 최신 세 번의 M8 수집은 각 `discovered=1, fetched=0, outcome=degraded`. 공식 사이트는 외부 도구에서 403/접근불가, 현재 URL 변형은 Production에서 404; 제3자 ECLI만으로 원문 verified 처리하지 않음.
- `worldcons_core.articles` 독일 **1,430**건. 그중 `source_metadata.catalog.sourceOnly=true` **1,101**건(legacy `cleaned` 997, `summarized` 104). 이 중 104건은 P3 `published` 상태라 검증 필요성이 제기됨.
- 104건 전수 SQL 교차 확인: **104/104 모두** `summary_json` 존재, `translation_status=translated`, source URL verified=true, sourceTextAvailable=true, publishable=true, 별도 `case_catalog_publications_v1`는 withdrawn. 즉 *미처리 source-only 104건이 무조건 발행된 사례*로 단정할 수 없고, legacy enrichment 후 `catalog.sourceOnly` 원본 표식이 남은 상태. 수동 철회·원장 변경은 하지 않음. 향후 `catalog.sourceOnly` 및 `case_metadata_v1.enrichment_status=source_only`의 의미/갱신 시점은 별도 점검.
- 전체 Production P3 `published` 총 **1,388**건(독일 433, 스페인 424, 프랑스 395, 미국 136): D1 metadata 기준 **각 source 모두 published 전건** `collection.publishable=true`, `sourceUrlVerified=true`, `sourceTextAvailable=true`. `summarized + translated + publishable`인데 source URL/본문 검증 플래그가 아닌 미발행 후보도 **0건**. 단, D1의 자기기록 확인으로 외부 공식 원문 E2E를 대신하지 않으며 미래 gate 강화 필요성을 별도 검토.
- 감사 중 D1 `7403` 간헐 재발을 다시 관측했으나 `wrangler whoami`는 해당 Cloudflare 계정의 OAuth `d1:write` scope를 확인했고, 재조회는 정상 성공. **권한 문제 완치 판정 금지**, 보안 약화/대체 키 발급 없이 원인 추적을 지속한다.

### P2-1 구현 검증 메모 (2026-10-09)

- `workers/async-pipeline/src/scotus-pdf.ts` 및 `native-crawler.ts`: HTTPS 공식 slip-opinion PDF만 수집, robots 응답 200/허용 필요, 공식 redirect 2회 이하, 8 MiB 파일·80쪽·100만 글자 한도, PDF 시그니처·MIME·정확한 docket 헤더를 검증.
- 추출 성공 시 R2 `artifacts/scotus_pdf/<sha256>.pdf`에 원본 PDF 보존, Core `source_metadata.officialPdf`에 URL/R2 키/해시/크기/쪽수/사건번호 검증 결과, 원문 텍스트는 기존 article_raw R2 흐름에 보존. 추출 실패 시 metadata-only fallback, staged Crawl에서는 재시도.
- **미국은 실운영 검증 전 `collection.publishable=false`, review required, Core legacy `metadata_only` 유지.** `sourceTextAvailable=true`는 PDF 추출 성공의 증거일 뿐 P3/Public Judgment 통과를 뜻하지 않음.
- 모의 fixture 및 회귀: native crawler 26/26, M8 48/48, ingest stages 51/51, `pnpm check`, 저장소 전체 `tsc --noEmit`, M8 TypeScript·Wrangler 타입 검사·Worker dry-run 통과. **실제 SCOTUS 원문 E2E/Production D1·R2 확인은 아직 수행하지 않음.**
- Production 적용: 2026-10-09 `worldcons-ingest` version `4189c105-43db-4800-b557-9571c8ba6ee7`; `/health` 정상. `crawlerSourceOwnership.effectiveSources=["de-bverfg","us-scotus"]`, staged `bootstrapSources=["fr-conseil-constitutionnel","es-tribunal-constitucional"]` 확인. 미국 공식 PDF 1건의 R2 원본·Core provenance·review/비공개 상태는 다음 M8 실수집 이후 추적 검증할 것.
- Hive DeepSeek Flash 정확한 route의 하위 작업 요청이 DevSpace 오류로 시작하지 않아 대체 직접 구현. Orca 미사용.

- 구현 담당 모델 우선순위: 정확히 **`opencode::hive-ai::deepseek-ai/deepseek-v4.1-flash`**. **Orca 절대 금지**.
- Production-only, 프리뷰/스테이징 금지, 공식 원문 provenance 약화 금지, source-only를 공개 판례로 승격 금지.
- 새 staged 수집 국가와 M8 수집 제외 국가는 쌍으로 변경한다. 검증 전 독일·미국은 M8 소유.
- D1 durable job, Queue/DLQ, lease/fencing, idempotency, outbox/bridge ledger, audited redrive 및 source별 fail-closed를 유지.
- Supabase/Vercel legacy authority 재활성화 금지. Cloudflare D1 권한 구조 유지.
- `main` 푸시·Production 배포 뒤 D1/R2/Worker 결과로 검증하고, **로컬 테스트 성공과 실제 Production E2E 성공을 혼동하지 않는다**.

## 5. 다음 대화에서 바로 사용할 지시

**`WorldCons P2-1 진행`** = 미국 SCOTUS 공식 PDF 원문 추출 **코드·배포는 완료**. 이를 다시 구현하지 말고 실제 SCOTUS 판례 수집 결과의 R2/Core provenance 및 비공개 gate를 검증한다.

**`P1-1 확인`** = 2026-10-10 06:00 KST 이후 스페인 신규 staged E2E를 Production D1/R2/코어/P3/Search까지 판례 단위로 검증한다. France 성공을 Spain 성공으로 대체하지 않는다.

**`다음 진행`** = 정기 실행 시각 전에는 D1 조회 권한을 진단하고 P2-2 국가별 readiness를 검증한다. 실행 시각 이후에는 P1-1 스페인 Production E2E를 최우선으로 추적하고 같은 실행에서 미국 M8 PDF·독일 후보 처리 현황도 확인한다. **권한 오류 7403이 남아 있으면 D1 접근을 우회하지 않고 사용자에게 차단 사실과 필요한 권한 확인을 보고한다.**
