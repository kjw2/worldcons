# Phase 1 P1 보안 하드닝 리뷰

검토일: 2026-06-14

## 적용 사항

| 영역 | 적용 내용 |
| --- | --- |
| Security headers | `Content-Security-Policy-Report-Only`, HSTS, nosniff, Referrer-Policy, Permissions-Policy, X-Frame-Options 추가 |
| Public API validation | `/api/search`, `/api/articles`, `/api/articles/[slug]`, `/api/tags`, `/api/tags/[slug]`, `/api/sources/[sourceKey]`, `/api/analytics/event` 입력 검증 |
| PostgREST query 조립 | tag 필터의 `.or(...)` 문자열 조립 제거. tag id 조회 후 `article_tags.tag_id in (...)` 방식으로 변경 |
| Analytics body 제한 | content-length 16KB 초과 413, metadata shallow scalar 제한, key 20개 제한 |
| XSS 회귀 테스트 | script/img/svg/javascript fixture에 대한 React text escaping, source snapshot escaping, JSON-LD escaping, safe external URL 검증 |
| External URL sink | 원문/기관 외부 링크는 `http:`/`https:`만 렌더링 |

## 차단한 위험

- URL query secret 노출과 로그 잔존
- CSRF 기반 관리자 state-changing POST 실행
- cron GET을 관리자 쿠키만으로 실행하는 혼합 인증
- PostgREST `.or(...)` 문자열 metacharacter 주입
- 과도한 pageSize와 긴 검색어를 통한 비용 확대
- analytics metadata에 큰 객체나 중첩 객체를 밀어 넣는 저장소 오염
- `javascript:`/`data:` URL이 외부 링크로 렌더링되는 XSS
- JSON-LD `</script>` break-out

## 검증

다음 명령을 통과해야 합니다.

```bash
pnpm exec tsc --noEmit
pnpm lint
pnpm check
pnpm build
```

`pnpm check`에는 P0 인증 회귀, P1 보안 헤더, 공개 API validation, XSS fixture 회귀 검사가 포함됩니다.

## P2 적용 완료

- CSP Report-Only 위반은 `/api/security/csp-report`로 수집합니다.
- CSP report endpoint는 16KB 초과 payload를 413으로 거부하고 전용 rate limit profile(`RATE_LIMIT_CSP_REPORT_*`)을 사용합니다.
- CSP report는 `site_events`에 `security_event`로 저장하며, directive, blocked URI, document URI, source file, sample 등 표시 가능한 범위의 메타데이터만 남깁니다.
- 관리자 대시보드의 수집원/후보 표에서 기사 관리와 후보 URL 관리 화면으로 바로 이동할 수 있게 했습니다.
- 관리자 API의 과도한 입력 길이 제한과 `비공개 종결` 명시 확인, 감사 로그 redaction은 `pnpm check` 회귀 테스트에 포함됩니다.

## 남은 인프라 P2 후보

- CSP Report-Only 관찰 후 enforcement 전환
- public API별 더 촘촘한 rate limit profile 분리
- 운영 WAF 규칙과 bot challenge 정책 정리
