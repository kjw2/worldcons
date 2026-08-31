# Production Security Checklist

## 배포 전 필수

- `ADMIN_PASSWORD`가 12자 이상인지 확인 (`lib/security/production-config.ts`가 빌드 시 강제)
- `ADMIN_SESSION_SECRET`, `CRON_SECRET`, `LLM_SETTINGS_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`가 모두 32바이트 이상인지 확인
- MasterDash 연동을 활성화할 때 `MASTERDASH_SSO_SECRET`, `MASTERDASH_CONTROL_SECRET`가 각각 32바이트 이상이며 기존 관리자/cron secret과 다른지 확인
- MasterDash SSO의 `email` 또는 `sub`가 비밀번호가 설정된 기존 `ADMIN_USERNAME` 또는 명시적 `MASTERDASH_ADMIN_IDENTITIES` allowlist와 일치하는지 확인하며, 별도 계정 생성이나 `operator`의 관리자 승격은 허용하지 않음
- 위 5개 secret 값이 서로 다른지 확인
- server secret이 `NEXT_PUBLIC_` 환경변수로 노출되지 않는지 확인
- Vercel production 환경변수에 `LLM_SETTINGS_SECRET`이 설정되어 있는지 확인 (미설정이면 프로덕션 빌드가 실패)
- 임베딩을 Gemini로 운영할 때 `EMBEDDING_PROVIDER`가 `openai`로 고정돼 있지 않은지 확인. 코드 기본값이 `gemini`이므로 미설정도 허용되며, 명시된 `openai` 값은 Gemini 설정을 덮어씀
- `GEMINI_API_KEY`가 Vercel과 GitHub Actions 양쪽에 설정되어 있는지 확인
- cron 호출은 `Authorization: Bearer <CRON_SECRET>` 또는 `x-cron-secret: <CRON_SECRET>` 헤더만 사용
- URL `?secret=` 방식 호출 제거
- GitHub Actions secret `CRON_SECRET`이 `.github/workflows/crawlee-worker.yml`과 `.github/workflows/admin-job-worker.yml` 양쪽에서 사용할 수 있는지 확인
- `LLM_SETTINGS_SECRET` 신규 도입 후 기존 DB 저장 LLM API key가 복호화되지 않을 수 있습니다. 배포 후 관리자 LLM 설정 화면에서 DB 저장 키 상태를 확인하고, 필요하면 키를 재등록하세요.


## MasterDash 연동 확인 (허브와 대조 완료: 2026-08-31)

양쪽 코드 계약은 일치가 확인되어 코드 변경이 필요하지 않습니다. 남은 것은 시크릿 값 대조뿐입니다.

로컬/CI에서 실행할 수 있는 확인 명령:

```bash
pnpm masterdash:readiness
```

이 명령은 시크릿 값을 출력하지 않고 존재 여부와 바이트 길이만 보고하며, 허브의 공개 readiness 응답도 함께 조회합니다.

두 시크릿이 설정된 환경에서는 계약 왕복 검증까지 수행합니다. 허브가 발급하는 형태의 SSO 토큰을 만들어 실제 검증기를 통과시키고 관리자 매핑 결과를 확인하며, 제어 요청도 같은 방식으로 서명해 검증합니다. `blocking`이 빈 배열이면 이 쪽 계약 이행이 증명된 상태입니다. 허브가 같은 시크릿 값을 갖고 있는지는 증명할 수 없으므로 최종 확인은 실제 SSO 왕복으로 해야 합니다.

### 확인 항목

- 허브(Cloudflare) 측 `PORTAL_SSO_SECRET`, `PORTAL_CONTROL_SECRET`은 프로덕션에 설정 완료. `pnpm masterdash:readiness`가 허브 `/api/ready`의 `checks.portalSecrets`를 읽어 상시 확인 (2026-08-31 두 항목 모두 true 확인)
- Vercel production에 `MASTERDASH_SSO_SECRET`, `MASTERDASH_CONTROL_SECRET`이 설정되어 있는지 확인
- 위 두 값이 각각 허브의 `PORTAL_SSO_SECRET`, `PORTAL_CONTROL_SECRET`과 **동일한 값**인지 확인. 변수 이름이 다른 것은 정상이며 값만 같아야 함
- 두 시크릿이 각각 32바이트 이상이고 서로 다른 값이며 다른 관리자/cron secret과도 겹치지 않는지 확인
- 허브 배포가 `pnpm deploy:prod`로 수행됐는지 확인. 일반 `pnpm deploy`는 `PORTAL_SYSTEMS_CONFIG` 주입을 건너뛰어 `ssoUrl`/`controlUrl`이 미설정으로 처리되고, 시크릿이 정상이어도 SSO와 제어가 조용히 비활성화됨
- `supabase/migrations/20260801090000_masterdash_integration.sql`의 `masterdash_sso_jtis`, `masterdash_control_requests`, `masterdash_collection_control` 세 테이블이 원격 DB에 존재하는지 확인 (2026-08-31 적용 확인)

### 검증된 계약 (변경 금지)

- SSO 토큰: HS256, 유효기간 60초, `iss=masterdash`, `aud=worldcons-admin`, `systemId=worldcons`
- 관리자 매핑: 허브는 `sub`에 내부 ID(`user_<uuid>`)를, `email`에 실제 이메일을 담아 보냄. WorldCons는 `sub`과 `email` 양쪽을 검사하므로 `email`이 `ADMIN_USERNAME`과 일치하면 통과. `MASTERDASH_ADMIN_IDENTITIES`에 UUID를 등록할 필요 없음
- 제어 서명: `HMAC-SHA256(secret, "<x-masterdash-timestamp>.<raw body>")`를 base64url로 인코딩. raw body를 재직렬화하면 서명이 깨짐
- 로컬 허브는 `iss=masterdash-local`이라 프로덕션 검증에서 401. 로컬 통합 테스트가 필요하면 WorldCons 로컬 `.env`에 `MASTERDASH_SSO_ISSUER=masterdash-local`을 설정 (코드 수정 불필요)

### 배포 후 확인

- `GET /api/masterdash/health`가 무인증으로 200과 `status`를 반환하는지 확인
- 허브 `GET https://masterdash-prod.cclib.workers.dev/api/ready`의 `checks.portalSecrets`로 허브 측 시크릿 존재를 상시 확인 (허브가 해당 커밋을 배포한 이후부터 노출)
- 허브 UI에서 worldcons SSO 진입 후 `/admin`으로 리다이렉트되고 관리자 세션이 생성되는지 확인
- 동일한 SSO 토큰 재사용이 409로 거부되는지 확인 (`jti` replay 방어)
- `POST /api/masterdash/control`이 서명 없이 401, 잘못된 서명으로 403을 반환하는지 확인

## 배포 전 DB migration 확인

운영 DB에 직접 변경을 적용하지 말고, 배포 절차에서 다음 additive migration이 적용됐는지 확인합니다. 특히 `admin_jobs` 계열 migration이 없으면 production 관리자 큐 등록, drain, 취소, 재시도가 정상 동작하지 않습니다.

- dashboard summary views/RPC migration: `supabase/migrations/20260709120000_admin_dashboard_summary_views.sql`
- admin audit/edit history migration: `supabase/migrations/20260709130000_admin_audit_and_edit_history.sql`
- article triage columns migration: `supabase/migrations/20260709140000_admin_article_triage_columns.sql`
- admin jobs/admin job events/RPC migration: `supabase/migrations/20260709150000_admin_jobs.sql`
- admin job claim RPC parameter fix: `supabase/migrations/20260710100000_fix_claim_admin_job_parameter_references.sql`
- P5 additive governance/aggregate health migration: `supabase/migrations/20260712230000_admin_governance_p5.sql` (implementation-ready; production evidence pending)
- P5 concurrent operational indexes, outside a transaction: `supabase/migrations/20260712231000_admin_governance_p5_indexes.sql`
- P5 digest/owner-binding corrective migration: `supabase/migrations/20260712233000_admin_governance_p5_acceptance_corrections.sql`
- MasterDash replay/idempotency/pause state migration: `supabase/migrations/20260801090000_masterdash_integration.sql`
- distributed rate-limit bucket/RPC migration: `supabase/migrations/20260826500000_distributed_rate_limit.sql`

read-mostly readiness check:

```bash
pnpm admin:readiness
```

이 명령은 secret 값을 출력하지 않고, 누락된 DB 객체와 관련 migration 파일명을 표시합니다.

## 배포 전 명령

```bash
pnpm exec tsc --noEmit
pnpm lint
pnpm check
pnpm admin:readiness
pnpm admin:health:p5
pnpm build
```

## 배포 후 확인

- 관리자 수집 실행 버튼이 정상 동작하는지 확인
- 관리자 수집 버튼 클릭 시 HTTP 202 queued 응답이 표시되고 `/admin/work?type=execution` 통합 업무 큐에 작업이 보이는지 확인
- `/admin/work`가 로그인 후 열리고 실행·기사·후보·공개·호환 작업 상태를 표시하는지 확인
- `/admin/operations`는 `/admin`, `/admin/jobs`는 `/admin/work?type=execution`으로 영구 이동하는지 확인
- 실패 또는 취소된 작업에 재시도 UI가 보이고, queued/running/cancel_requested 작업에 취소 UI가 보이는지 확인
- 관리자 상세 화면 재요약 버튼이 정상 동작하는지 확인
- `/admin/audit`가 로그인 없이 열리지 않고, 로그인 후 관리자 작업 이벤트를 읽기 전용으로 보여주는지 확인
- 감사 로그와 실행 결과 화면에 LLM/API key, cron secret, session secret 값이 노출되지 않는지 확인
- `/api/admin/logout` GET이 405인지 확인
- `/api/admin/cron/ingest`가 secret 헤더 없이 401인지 확인
- `/api/admin/cron/jobs`가 secret 헤더 없이 401인지 확인
- `/api/admin/jobs/run` GET이 405인지 확인
- 공개 검색 API에서 비정상 `pageSize`, `mode`, `tag` 입력이 400인지 확인
- `/api/security/csp-report`가 정상 CSP report payload에는 204, 과대 payload에는 413을 반환하는지 확인
- production 응답이 `Content-Security-Policy` enforcement 헤더를 사용하고 `script-src`에 `unsafe-eval`이 없는지 확인
- 기능 장애가 확인된 비상 rollback에서만 `CSP_REPORT_ONLY_ENABLED=true`를 사용하고 정상화 후 즉시 제거
- rate-limited 응답의 `X-RateLimit-Backend`가 정상 운영에서 `distributed`인지 확인하고 지속적인 `local` fallback은 DB/RPC 장애로 취급
- P5 health workflow와 governance UI는 명시적 feature flag 전에는 비활성인지 확인
- P5 operations/data/security owner binding 환경변수는 서로 겹치지 않는 별도 운영자에 연결하고 값 자체는 로그/문서/UI에 출력하지 않음
- Gate 5/compatibility removal은 최소 관찰 기간, 복원 리허설, 소유자 승인과 별도 파괴적 변경 승인이 있기 전에는 승인으로 표시하지 않음
