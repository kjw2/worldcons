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
| **P2-1** | **미국 SCOTUS 공식 PDF 원문 추출 구현** | **미완료 — 다음 구현 작업** | Cloudflare Worker에서 공식 PDF의 실제 판결 본문을 안전하게 추출·검증하고 R2/D1 provenance를 연결. 본문 부족/추출 오류/PDF 아닌 응답은 `metadata_only`와 비공개 상태 유지. 단위·모의 E2E·Worker 빌드 검증 후 Production-only 배포. 미국 M8 소유권은 실전 검증 전 유지 |
| P2-2 | 검증된 국가별 staged-ingest 확대 및 M8 중복 수집 책임 정리 | **단계적 진행** | 프랑스+스페인 이미 staged 소유. 독일·미국은 readiness와 live E2E를 통과한 후 각각 staged allowlist/M8 제외를 **같은 배포에서 쌍으로** 변경. 무제한 동시 활성화 금지 |

## 2. 현재 운영 상태의 기준

- Production-only: Cloudflare `worldcons`와 `worldcons-ingest` Workers, D1(`worldcons_ingest`, `worldcons_core` 등), R2, Queues. **preview/staging 생성 금지**.
- `NATIVE_CRAWLER_SOURCES`: `de-bverfg`, `us-scotus`, `fr-conseil-constitutionnel`, `es-tribunal-constitucional`.
- staged-ingest 소유: **프랑스+스페인**. `WORLDCONS_INGEST_STAGE_SOURCE_ALLOWLIST=fr-conseil-constitutionnel,es-tribunal-constitucional`.
- 기존 M8 `crawler-daily` 소유: **독일+미국**. `M8_CRAWLER_SOURCE_EXCLUDE=fr-conseil-constitutionnel,es-tribunal-constitucional`. 나머지 M8 종류는 유지.
- staged 7단계: Discovery → Crawl → Normalize → Translate → Public Judgment → Publish → Search. Bootstrap **source당 1건**, dispatch **stage당 1건/15분**, 일일 Discovery `0 21 * * *` UTC = 다음날 06:00 KST.
- 2026-10-09 배포 기준: `worldcons-ingest` version `0ad6bb0c-3fc5-49f8-8ad8-55fe3cdcde52`; GitHub `main` HEAD `4b384bed0a489851ad87dd0b214f419aedf0517d`.
- 프랑스 Production E2E는 성공했지만, **스페인/독일/미국 전체 E2E를 의미하지 않는다**. 프랑스 1개 소스 제한은 원래 사용자의 정책이 아니라 이전 assistant의 임시 카나리였다.

## 3. P2-1 — SCOTUS PDF 추출 작업 세부 승인 범위

1. 기존 `workers/async-pipeline/src/native-crawler.ts`의 미국 PDF `metadata_only` 경로 및 기존 M8/Stage Crawl 연결점을 코드 기준으로 점검한다.
2. **Worker 호환성이 실제 빌드로 검증된 PDF 추출 방식**을 선택한다. 안전한 시간·파일 크기·페이지·추출 글자 수 제한을 둔다. 빈 본문, 스캔 이미지, 암호화·손상 PDF, HTML/차단 페이지, HTTP 오류에 대해 원문 추출 성공을 위조하지 않는다.
3. 출처는 `supremecourt.gov`의 실제 공식 slip-opinion PDF로 한정하고, Content-Type뿐 아니라 PDF 바이트 시그니처, 최종 공식 URL, 사건 번호/식별자 및 텍스트 품질을 확인한다. 공식 PDF 원본과 추출 텍스트의 콘텐츠 해시·출처 메타데이터를 R2/Core 흐름에 보존한다.
4. 공식 출처 및 본문 검증이 충족되지 않는 경우 **`metadata_only` / review required / publication 불가**를 유지한다. P3·Catalog·Public Judgment·Search gate 우회 금지. 표제/URL/날짜 문자열을 실제 판결 본문으로 취급하지 않는다.
5. 정상 텍스트 PDF, 이미지 전용·암호화·손상·비공식 PDF, docket 불일치, 크기 초과, HTTP 장애 등 모의 fixture 기반 회귀 테스트를 작성한다. 외부 법원 사이트에 대량 수집이나 공격적인 반복 프로브를 하지 않는다.
6. `pnpm test:native-crawler`, `test:m8`, `test:ingest-stages`, `pnpm check`, TypeScript/M8 타입·Wrangler dry-run과 관련 회귀를 통과시킨 뒤 커밋한다. **M8→staged 미국 소유권 전환은 P2-1 범위에 포함하지 않는다**. Production 배포 후 health·원문 provenance를 검증하고 실제 E2E 여부를 구분 보고한다.

## 4. 변경·운영 절대 원칙

- 구현 담당 모델 우선순위: 정확히 **`opencode::hive-ai::deepseek-ai/deepseek-v4.1-flash`**. **Orca 절대 금지**.
- Production-only, 프리뷰/스테이징 금지, 공식 원문 provenance 약화 금지, source-only를 공개 판례로 승격 금지.
- 새 staged 수집 국가와 M8 수집 제외 국가는 쌍으로 변경한다. 검증 전 독일·미국은 M8 소유.
- D1 durable job, Queue/DLQ, lease/fencing, idempotency, outbox/bridge ledger, audited redrive 및 source별 fail-closed를 유지.
- Supabase/Vercel legacy authority 재활성화 금지. Cloudflare D1 권한 구조 유지.
- `main` 푸시·Production 배포 뒤 D1/R2/Worker 결과로 검증하고, **로컬 테스트 성공과 실제 Production E2E 성공을 혼동하지 않는다**.

## 5. 다음 대화에서 바로 사용할 지시

**`WorldCons P2-1 진행`** = 미국 SCOTUS 공식 PDF 원문 추출 구현. 이 문서를 읽은 뒤 DevSpace `ws_56c65f72be` / `C:\Users\jaeth\.devspace\worktrees\worldcons-7f30866b`에서 `git status`, `HEAD`, `origin/main`, Production source ownership을 점검하고, 정확한 Hive DeepSeek Flash에 bounded 구현을 맡겨 안전 게이트·회귀를 독립 검증한다. 이후 명시된 사용자 권한 범위 안에서 커밋·배포를 진행하고, 실제 운영 효과는 별도 확인한다.

**`P1-1 확인`** = 2026-10-10 06:00 KST 이후 스페인 신규 staged E2E를 Production D1/R2/코어/P3/Search까지 판례 단위로 검증한다. France 성공을 Spain 성공으로 대체하지 않는다.
