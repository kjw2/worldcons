# Production Security Checklist

## 배포 전 필수

- `ADMIN_PASSWORD`가 6자 이상인지 확인
- `ADMIN_SESSION_SECRET`, `CRON_SECRET`, `LLM_SETTINGS_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`가 모두 32바이트 이상인지 확인
- 위 5개 secret 값이 서로 다른지 확인
- server secret이 `NEXT_PUBLIC_` 환경변수로 노출되지 않는지 확인
- Vercel production 환경변수에 `LLM_SETTINGS_SECRET`이 설정되어 있는지 확인
- cron 호출은 `Authorization: Bearer <CRON_SECRET>` 또는 `x-cron-secret: <CRON_SECRET>` 헤더만 사용
- URL `?secret=` 방식 호출 제거
- `LLM_SETTINGS_SECRET` 신규 도입 후 기존 DB 저장 LLM API key가 복호화되지 않을 수 있습니다. 배포 후 관리자 LLM 설정 화면에서 DB 저장 키 상태를 확인하고, 필요하면 키를 재등록하세요.

## 배포 전 명령

```bash
pnpm exec tsc --noEmit
pnpm lint
pnpm check
pnpm build
```

## 배포 후 확인

- 관리자 수집 실행 버튼이 정상 동작하는지 확인
- 관리자 상세 화면 재요약 버튼이 정상 동작하는지 확인
- `/api/admin/logout` GET이 405인지 확인
- `/api/admin/cron/ingest`가 secret 헤더 없이 401인지 확인
- 공개 검색 API에서 비정상 `pageSize`, `mode`, `tag` 입력이 400인지 확인
- CSP Report-Only 위반이 실제 사용자 화면 기능 장애를 가리키는지 모니터링
