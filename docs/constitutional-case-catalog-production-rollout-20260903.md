# 헌법판례 Catalog schema-only 운영 이행 증거 — 2026-09-03

## 판정

`PASS (schema-only)`.

Gate 1~5와 Catalog 보안 보정 migration을 운영 Supabase에 적용하고, 전체 release gate를 통과한 동일 커밋을 Vercel production에 배포했다. 모든 Catalog·국가별 실행 flag는 기본 비활성 상태이며 승인된 source policy가 없으므로, 실제 inventory 생성·후보 import·Catalog publication·public cutover는 수행하지 않았다.

## 변경 식별자

- Git commit: `284105f5ae41f0a3e03d7836fb3e771cd3f45426`
- Vercel deployment: `dpl_GNviMjQxjDm4idfF5o3dPbfvqnp6`
- Deployment URL: `https://worldcons-ltl2pojvo-jwkms-projects.vercel.app`
- Canonical alias: `https://worldcons.vercel.app`
- Supabase migrations: `20260903120000`~`20260903181000`

## 백업과 migration

운영 migration 전에 public schema와 data dump를 별도 디렉터리에 보존했다.

| artifact | bytes | SHA-256 |
|---|---:|---|
| `worldcons-prod-public-schema-pre-catalog-20260903.sql` | 352,157 | `5af9aa56920edc46015407dd0d47f034ab90edaae08459cac0ad4be288ad1a11` |
| `worldcons-prod-public-data-pre-catalog-20260903.sql` | 554,596,445 | `d8117f14be53d8fd602cbb31211c0cb82afff506caab8b7a8a3e8d9580919c28` |

Supabase CLI의 linked migration 목록에서 local/remote가 `20260903175000`까지 일치했다. 적용 뒤 기존 공개 P3 row와 통합 detail row는 각각 1,258건으로 동일했고, Catalog publication·source policy·미국 candidate는 모두 0건이었다.

후속 DB lint에서 기존 `append_admin_job_event`의 PL/pgSQL 블록 라벨을 SQL relation으로 해석하는 오류를 발견했다. `20260903180000_fix_append_admin_job_event_parameter_references.sql`에서 RPC 입력 이름은 유지하고 위치 인수 alias로 교체했으며, fixed `search_path`와 service-role-only 실행 권한을 적용했다. 실제 PostgreSQL에서 이벤트 기록과 ACL을 확인한 뒤 운영에 적용했고, `supabase db lint --linked --schema public --level error --fail-on error` 결과는 빈 `results`로 통과했다.

## 보안 보정 증거

초기 사후 점검에서 신규 Catalog 뷰 두 개가 owner 권한으로 실행되는 상태를 발견해 배포를 중단하고 `20260903175000_constitutional_case_catalog_view_security.sql`을 추가 적용했다.

운영 DB에서 다음을 직접 확인했다.

- `public_case_catalog_projection_v1`, `public_article_detail_v4`, `public_case_search_documents_v1`: `security_barrier=true`, `security_invoker=true`
- 세 뷰에 대한 `anon`/`authenticated` 직접 `SELECT`: 모두 `false`
- 세 뷰에 대한 `service_role` `SELECT`: 모두 `true`
- service-role 실제 조회: detail 1,258건, search document 1,258건
- service-role의 immutable version 원장 직접 권한은 공개 투영에 필요한 열로 제한하며 `raw_text`, `summary_json`, `embedding` 직접 열 권한은 부여하지 않음

공개 사용자는 Supabase 뷰에 직접 접속하지 않는다. 인증 없는 홈페이지와 ChatGPT 플러그인 MCP 요청은 Vercel 서버가 bounded 공개 계약으로 중개한다.

## 배포 전·후 검증

실제 disposable PostgreSQL을 연결한 `pnpm verify:release` 전체가 통과했다.

- Gate 1/backfill: 59/59
- Catalog: 27/27
- ChatGPT plugin: 11/11
- typecheck, repository check, lint, public regression, plugin validation, Next.js production build: 통과

운영 배포 뒤 확인 결과:

- `/`: HTTP 200
- `/guide/chatgpt-plugin`: HTTP 200
- `/api/masterdash/health`: `healthy`, version `284105f5ae41`
- `/api/mcp/health`: `ready`, database/search `ok`, full commit SHA 일치
- MCP initialize, tools/list, `search("표현의 자유")`: 성공, 공개 도구 5개, 결과 10건
- 익명 `/api/auth/masterdash`: HTTP 401
- 직접 `/admin/login`: HTTP 404
- 직접 `POST /api/admin/login`: HTTP 404
- 배포 후 오류 로그 조회: 오류 없음

사용자가 앞선 운영 브라우저 검증에서 MasterDash SSO 왕복 성공을 확인했다. 이번 배포는 기존 SSO 계약 테스트와 직접 로그인 차단 경계를 다시 통과했다.

## 현재 비활성 상태와 다음 승인 경계

현재 운영 상태는 다음과 같다.

```text
source_corpus_policies = 0
us_conan_case_candidates_v1 = 0
case_catalog_publications_v1 = 0
CASE_CATALOG_* = unset/false
country execution flags = unset/false
```

Spain HJ의 첫 검토 결과는 `docs/spain-hj-source-policy-review-20260903.md`에 기록했다. 공식 scope와 판결문 제공은 확인됐지만 robots가 404이고 법적 고지 경로가 403이다. 요청 지연·동시성의 분산 런타임 강제 구현과 PostgreSQL 경쟁 검증을 완료하고 `20260903181000`도 운영에 적용했다. 판정은 `BLOCKED`이며 source policy row와 실데이터는 0건을 유지한다.

다음 단계는 운영자·법적 검토다. robots 관측, 공식 scope, 이용조건·원문 egress, replay field, 보존기간, 요청 지연·동시성, `review_due_at`을 실제 근거로 검토한 immutable policy version이 승인되기 전에는 어떠한 실데이터 실행 flag도 켜지 않는다.

첫 승인 후 실행 순서는 Spain 2024 `SENTENCIA` inventory canary → fetch → normalize → verify → reconcile → private shadow publication이다. public/search/plugin cutover와 Gemini 작업은 별도 승인으로 유지한다.

## Source request governor 후속 운영 이행

2026-09-03에 commit `2578ecc828f9`의 source request governor를 후속 적용했다.

- Supabase migration `20260903181000`: local/remote 일치, public schema error-level DB lint 0건
- Vercel deployment: `dpl_ASbdbBEmZB6x5m3Moqy18se3MYmU`, production `Ready`
- canonical health/MCP version: `2578ecc828f9`, MCP database/search `ok`
- MCP initialize/tools/search smoke: 5개 read-only 도구, 검색 10건
- 익명 경계: `/admin/login` 404, `POST /api/admin/login` 404, token 없는 `/api/auth/masterdash` 401
- 배포 후 error log: 0건
- 운영 원장: `source_corpus_policies=0`, `source_request_permits=0`, `source_request_governor_states=0`

전체 릴리스 게이트는 실제 disposable PostgreSQL을 연결해 backfill 60/60, Catalog 27/27, ChatGPT plugin 11/11과 production build까지 통과했다. 배포 smoke 중 watchdog heartbeat가 선언된 15분 주기와 달리 약 1시간 갱신되지 않아 top-level health가 `degraded`인 별도 운영 결함을 발견했다. 새 request governor와 database/MCP 기능은 정상이며, watchdog 스케줄·route heartbeat 정합성은 다음 교정 단계에서 다룬다.

## Watchdog heartbeat 교정

배포 smoke에서 발견한 별도 운영 결함은 commit `61709558f2cf5342ef350deb94b4fd32c92e51a0`으로 교정했다. GitHub Actions의 `*/15` schedule은 실제 최근 실행 간격이 2~5시간으로 불규칙했고, Vercel의 03:00/15:00 UTC 보조 cron route는 watchdog 평가만 하고 workflow heartbeat를 기록하지 않았다.

- Vercel Hobby에서 보장 가능한 두 daily cron의 12시간 간격을 watchdog health 기준으로 사용하고, 2.5배인 30시간을 stale 경계로 둔다.
- GitHub의 15분 schedule은 더 빠른 관측을 위한 best-effort 실행으로 계속 유지한다.
- 인증된 `/api/ops/watchdog` route는 평가 전에 `running`, 정상 완료 후 `success`, 예외 시 `failed` heartbeat를 필수 기록한다.
- 인증 확인이 heartbeat보다 먼저 실행되는 순서와 성공/실패 lifecycle을 회귀 테스트로 고정했다.

운영 검증 결과:

- Vercel deployment: `dpl_DaGQqCpCmiWMLfCHEfQwKzbgguH9`, production `Ready`
- GitHub manual run: `33754715915`, commit `6170955`, success
- `vercel cron run /api/ops/watchdog`: 2026-09-03T12:23:48.974Z 호출 성공
- durable watchdog heartbeat: 2026-09-03T12:23:50.891Z, `success`
- `/api/masterdash/health`: `healthy`, `stalledWorkflows=[]`, version `61709558f2cf`
- `/api/mcp/health`: `ready`, database/search `ok`, full commit SHA 일치
- MCP 실제 검색 smoke와 SSO-only 직접 로그인 404 경계: 통과
- 배포 후 error-level runtime log: 0건

교정 커밋도 실제 disposable PostgreSQL을 연결한 전체 `pnpm verify:release`를 통과했다. 국가별 Catalog 실행 flag와 source policy 상태는 변경하지 않았다.
