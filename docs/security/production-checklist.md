# Production Security Checklist

## 배포 전 필수

- `ADMIN_PASSWORD`가 6자 이상인지 확인
- `ADMIN_SESSION_SECRET`, `CRON_SECRET`, `LLM_SETTINGS_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`가 모두 32바이트 이상인지 확인
- 위 5개 secret 값이 서로 다른지 확인
- server secret이 `NEXT_PUBLIC_` 환경변수로 노출되지 않는지 확인
- Vercel production 환경변수에 `LLM_SETTINGS_SECRET`이 설정되어 있는지 확인
- cron 호출은 `Authorization: Bearer <CRON_SECRET>` 또는 `x-cron-secret: <CRON_SECRET>` 헤더만 사용
- URL `?secret=` 방식 호출 제거
- GitHub Actions secret `CRON_SECRET`이 `.github/workflows/crawlee-worker.yml`과 `.github/workflows/admin-job-worker.yml` 양쪽에서 사용할 수 있는지 확인
- `LLM_SETTINGS_SECRET` 신규 도입 후 기존 DB 저장 LLM API key가 복호화되지 않을 수 있습니다. 배포 후 관리자 LLM 설정 화면에서 DB 저장 키 상태를 확인하고, 필요하면 키를 재등록하세요.

## 배포 전 DB migration 확인

운영 DB에 직접 변경을 적용하지 말고, 배포 절차에서 다음 additive migration이 적용됐는지 확인합니다. 특히 `admin_jobs` 계열 migration이 없으면 production 관리자 큐 등록, drain, 취소, 재시도가 정상 동작하지 않습니다.

- dashboard summary views/RPC migration: `supabase/migrations/20260709120000_admin_dashboard_summary_views.sql`
- admin audit/edit history migration: `supabase/migrations/20260709130000_admin_audit_and_edit_history.sql`
- article triage columns migration: `supabase/migrations/20260709140000_admin_article_triage_columns.sql`
- admin jobs/admin job events/RPC migration: `supabase/migrations/20260709150000_admin_jobs.sql`
- admin job claim RPC parameter fix: `supabase/migrations/20260710100000_fix_claim_admin_job_parameter_references.sql`
- P5 additive governance/aggregate health migration: `supabase/migrations/20260712230000_admin_governance_p5.sql` (implementation-ready; production evidence pending)

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
- 관리자 수집 버튼 클릭 시 HTTP 202 queued 응답이 표시되고 `/admin/jobs` 작업 큐에 job이 보이는지 확인
- `/admin/jobs`가 로그인 후 열리고 queued/running/failed 상태와 최근 이벤트를 표시하는지 확인
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
- CSP Report-Only 위반이 실제 사용자 화면 기능 장애를 가리키는지 모니터링
- P5 health workflow와 governance UI는 명시적 feature flag 전에는 비활성인지 확인
- Gate 5/compatibility removal은 최소 관찰 기간, 복원 리허설, 소유자 승인과 별도 파괴적 변경 승인이 있기 전에는 승인으로 표시하지 않음
