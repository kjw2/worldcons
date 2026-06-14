# Phase 1 P0 보안 패치 검토

검토일: 2026-06-14

## 결론

P0 차단 항목은 코드 수정과 회귀 테스트 기준으로 해소되었습니다.

## 확인 결과

| 항목 | 결과 |
| --- | --- |
| URL query secret 인증 제거 | `?secret=` 인증 제거 완료. `scripts/check.ts`에서 query secret 거부 검증 |
| secret 헤더 비교 | `Authorization: Bearer`와 `x-cron-secret` 모두 timing-safe 비교 적용 |
| 관리자 쿠키와 cron secret 분리 | `/api/admin/cron/ingest`는 secret 헤더만 허용. 관리자 쿠키 단독 실행 거부 테스트 추가 |
| 관리자 state-changing POST CSRF | ingest, review, llm-settings, glossary-candidates, logout에 CSRF 검증 적용 |
| logout GET | `GET /api/admin/logout`은 405와 `Allow: POST` 반환 |
| LLM_SETTINGS_SECRET fallback | production에서는 전용 `LLM_SETTINGS_SECRET`만 허용. 다른 server secret fallback 제거 |
| 운영 secret 강도/분리 | 32바이트 이상, 값 재사용 금지, `NEXT_PUBLIC_` 노출 금지 검사 추가 |
| production 배포 차단 | Vercel production build에서 `assertProductionSecurityConfig` 실행 |
| 테스트 실효성 | 라우트 핸들러와 인증 helper를 직접 호출해 실패 케이스 검증 |

## 주요 파일

- `lib/utils/auth.ts`
- `lib/security/production-config.ts`
- `app/api/admin/cron/ingest/route.ts`
- `app/api/admin/ingest/route.ts`
- `app/api/admin/review/route.ts`
- `app/api/admin/llm-settings/route.ts`
- `app/api/admin/glossary-candidates/route.ts`
- `app/api/admin/logout/route.ts`
- `scripts/check.ts`

## 남은 후속 항목

P0 이후 방어층으로 P1 보안 헤더, 공개 API validation, XSS 회귀 테스트를 추가했습니다. CSP는 운영 화면 호환성을 위해 `Content-Security-Policy-Report-Only`로 시작합니다.
