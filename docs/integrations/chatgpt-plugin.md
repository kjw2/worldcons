# 헌법판례요약시스템 ChatGPT 플러그인

## 목적

웹사이트에 공개된 헌법판례를 ChatGPT 대화에서 검색하고, 한국어 AI 요약과 공식 원문을 함께 확인하게 하는 읽기 전용 플러그인이다. OpenAI 플러그인 디렉터리에는 제출하지 않고 홈페이지에서 소개와 직접 연결 방법을 제공한다.

## 구성

```text
ChatGPT 사용자 지정 앱
  → worldcons.vercel.app/api/mcp (Next.js Route Handler)
    → Vercel 애플리케이션의 검색·판례 조회 서비스
      → 운영 PostgreSQL
```

- 사용자 인증과 API 키가 없다.
- MCP는 홈페이지와 같은 Vercel 프로젝트에서 실행한다.
- MCP 구현은 공개 API를 다시 HTTP로 호출하지 않고 서버 내부의 검색·판례 조회 함수를 직접 사용한다.
- 외부에서 데이터베이스 자격 증명이나 서비스 키에 접근하지 않는다.
- 운영·관리·수집 제어 경로는 도구에 포함하지 않는다.
- 도구 실행 로그는 요청 식별자, 도구명, 성공 여부, 소요 시간만 기록하고 검색어와 응답 본문은 기록하지 않는다.

## 공개 도구

| 도구 | 용도 |
| --- | --- |
| `search` | 자연어로 판례를 찾고 표준 `id`, `title`, `url` 결과 반환 |
| `fetch` | 선택 판례의 사건 정보, 한국어 AI 요약, 원문 발췌, 공식 URL 조회 |
| `search_cases` | 국가·기관·최근 기간을 명시한 조건 검색 |
| `list_sources` | 현재 수록 국가·기관·언어와 공식 사이트 조회 |
| `fetch_source_text` | 필요한 원문 구간만 페이지 단위로 조회 |

모든 도구는 `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`로 선언한다.

## 엔드포인트

- MCP: `https://worldcons.vercel.app/api/mcp`
- 상태: `https://worldcons.vercel.app/api/mcp/health`
- 홈페이지 안내: `https://worldcons.vercel.app/guide/chatgpt-plugin`

## 로컬 검증

```bash
pnpm typecheck
pnpm plugin:validate
pnpm test:plugin
pnpm plugin:smoke http://localhost:3000/api/mcp
```

## 배포

MCP는 기존 Vercel 애플리케이션과 함께 배포한다. 배포 후 `/api/mcp/health`가 `ready`인지 확인하고 `pnpm plugin:smoke https://worldcons.vercel.app/api/mcp`로 초기화·도구 스캔·검색 왕복을 검증한다. 마지막으로 ChatGPT의 사용자 지정 앱 생성 화면에서 MCP 주소를 등록해 `search` → `fetch` 왕복을 확인한다.

## 이용 고지

한국어 번역·요약·태그·참조 조문 후보는 참고용 AI 생성 정보다. 법적 판단, 논문, 소송 문서 또는 정식 인용에는 각 재판기관의 공식 원문과 해당 관할의 인용 규칙을 확인해야 한다.
