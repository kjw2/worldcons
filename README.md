# 헌법재판소도서관 헌법판례요약시스템

세계 여러 나라의 헌법재판 자료를 모아서, 한국어로 읽기 쉽게 정리해 주는 웹 서비스입니다.

아주 쉽게 말하면 이렇습니다.

1. 미국, 독일, 프랑스 헌법재판 관련 공식 사이트에 새 판례나 결정문이 올라옵니다.
2. 이 프로젝트가 공식 사이트의 규칙을 지키면서 자료를 천천히 가져옵니다.
3. 같은 자료가 두 번 들어가지 않게 확인합니다.
4. 원문을 깨끗하게 정리합니다.
5. AI가 한국어 제목, 핵심 요약, 태그, 참고 조문을 만듭니다.
6. 사용자는 웹 화면에서 검색하고 읽습니다.

이 문서는 두 사람을 동시에 돕기 위해 작성되었습니다.

- 사용자: 웹사이트에서 자료를 찾고 읽는 사람
- 개발자/운영자: 수집, 요약, 배포, 오류 확인을 맡는 사람

어려운 말이 나오면 바로 옆에 쉬운 설명을 붙였습니다.

## 목차

- [이 프로젝트가 하는 일](#이-프로젝트가-하는-일)
- [사용자 관점: 화면에서 무엇을 할 수 있나](#사용자-관점-화면에서-무엇을-할-수-있나)
- [개발자 관점: 전체 구조](#개발자-관점-전체-구조)
- [자료가 들어오는 흐름](#자료가-들어오는-흐름)
- [데이터가 화면에 보이는 조건](#데이터가-화면에-보이는-조건)
- [수집 대상 국가와 기관](#수집-대상-국가와-기관)
- [절대 지켜야 하는 수집 원칙](#절대-지켜야-하는-수집-원칙)
- [로컬에서 실행하기](#로컬에서-실행하기)
- [환경변수 설명](#환경변수-설명)
- [데이터베이스 준비](#데이터베이스-준비)
- [자주 쓰는 명령어](#자주-쓰는-명령어)
- [자동 수집 일정](#자동-수집-일정)
- [기간별 수집 방법](#기간별-수집-방법)
- [요약과 태그 갱신](#요약과-태그-갱신)
- [관리자 화면과 API](#관리자-화면과-api)
- [검색 방식](#검색-방식)
- [폴더 구조](#폴더-구조)
- [새 수집원을 추가하는 방법](#새-수집원을-추가하는-방법)
- [검증 방법](#검증-방법)
- [문제 해결](#문제-해결)
- [현재 수집 상태 예시](#현재-수집-상태-예시)

## 이 프로젝트가 하는 일

이 프로젝트는 헌법재판 자료를 위한 작은 도서관입니다.

책을 도서관에 넣는 과정을 생각하면 쉽습니다.

| 도서관에서 하는 일 | 이 프로젝트에서 하는 일 |
| --- | --- |
| 새 책이 나왔는지 확인한다 | 공식 사이트에서 새 결정문 URL을 찾는다 |
| 같은 책이 이미 있는지 본다 | 같은 URL, 같은 본문, 같은 제목/날짜인지 확인한다 |
| 책 표지를 붙인다 | 제목, 날짜, 국가, 기관 정보를 붙인다 |
| 책 내용을 정리한다 | 원문 텍스트를 추출하고 깨끗하게 만든다 |
| 요약 카드를 만든다 | AI가 한국어 요약과 태그를 만든다 |
| 책장에 꽂는다 | 웹사이트 목록과 검색에 보이게 한다 |

이 서비스의 목표는 다음과 같습니다.

- 미국, 독일, 프랑스 헌법재판기관의 공식 자료를 한곳에서 보기
- 원문 언어가 영어, 독일어, 프랑스어여도 한국어 요약으로 먼저 이해하기
- 사건, 권리, 조문, 쟁점 태그로 빠르게 찾기
- 원문 링크를 항상 남겨 두어 공식 자료를 직접 확인할 수 있게 하기
- 공식 사이트에 부담을 주지 않고 안전하게 수집하기

## 사용자 관점: 화면에서 무엇을 할 수 있나

### 첫 화면

첫 화면은 최신 자료 목록입니다.

사용자는 여기서 다음을 할 수 있습니다.

- 최신 헌법재판 자료 보기
- 국가별 자료 보기
- 기관별 자료 보기
- 기간별 자료 보기
- 검색창으로 원하는 말 찾기
- 태그를 눌러 비슷한 자료 모아 보기

예를 들어 “표현의 자유”를 찾고 싶으면 검색창에 입력하면 됩니다.

목록에서 자료를 눌러 상세 화면을 본 뒤 브라우저의 뒤로 가기를 누르면, 방금 눌렀던 카드 위치로 돌아갑니다.

무한 스크롤로 아래쪽 자료까지 내려간 경우에도 이미 불러온 카드 목록과 스크롤 위치를 잠시 저장합니다. 그래서 다시 목록 맨 위부터 찾아 내려가지 않아도 됩니다.

### 검색 화면

검색 화면에서는 더 넓게 찾을 수 있습니다.

검색 대상은 다음을 포함합니다.

- 한국어 제목
- 원문 제목
- 한국어 요약
- 원문 텍스트
- URL
- 국가
- 기관 이름
- 태그
- 조문 이름

검색 방식은 세 가지입니다.

| 방식 | 쉬운 설명 | 개발자용 설명 |
| --- | --- | --- |
| Full-text | 글자 그대로 찾기 | DB와 앱 레벨 텍스트 검색 |
| Semantic | 뜻이 비슷한 자료 찾기 | embedding 기반 벡터 검색 |
| Hybrid | 둘을 섞어서 찾기 | full-text 결과와 semantic 결과 병합 |

### 상세 화면

자료 하나를 누르면 상세 화면으로 갑니다.

상세 화면에는 보통 다음이 있습니다.

- 한국어 제목
- 원문 제목
- 국가와 기관
- 원문 날짜
- 읽는 데 걸리는 시간
- AI 요약
- 참조 조문
- 사건 배경
- 사건 구조
- 시사점
- 실무상 참고
- 태그
- 원문 보기 버튼
- 보존된 원문 스냅샷

중요합니다. AI 요약은 참고용입니다. 법적 인용이나 정확한 판단이 필요하면 반드시 원문을 확인해야 합니다.

### 태그 화면

태그는 자료에 붙는 이름표입니다.

예를 들어 다음 같은 태그가 있을 수 있습니다.

- 표현의 자유
- 평등권
- 선거
- QPC
- First Amendment
- 비례원칙

태그를 누르면 그 주제와 관련된 자료를 모아서 볼 수 있습니다.

### 기관 화면

기관 화면에서는 어느 공식 기관에서 자료를 가져오는지 볼 수 있습니다.

현재 기본 수집 기관은 다음 세 곳입니다.

- 미국 연방대법원
- 독일 연방헌법재판소
- 프랑스 헌법위원회

## 개발자 관점: 전체 구조

이 프로젝트는 Next.js 앱입니다.

크게 보면 네 덩어리입니다.

| 덩어리 | 하는 일 | 주요 위치 |
| --- | --- | --- |
| 웹 화면 | 사용자가 보는 페이지 | `app`, `components` |
| 데이터 조회 | DB에서 article, tag, source를 읽음 | `lib/db` |
| 수집 파이프라인 | 공식 사이트에서 자료를 가져옴 | `lib/sources`, `lib/crawler`, `lib/crawlee`, `lib/ingest` |
| AI 처리 | 요약, 태그, embedding 생성 | `lib/ai`, `lib/search` |

사용 기술은 다음과 같습니다.

- Next.js App Router
- React Server Components
- TypeScript strict
- Tailwind CSS
- Supabase PostgreSQL
- pgvector
- Crawlee
- Cheerio
- Playwright fallback
- Readability 스타일 본문 추출
- `pdf-parse`
- OpenAI 또는 Gemini 기반 요약
- OpenAI embedding 기반 semantic search

## 자료가 들어오는 흐름

자료 하나가 화면에 보이기까지의 길은 다음과 같습니다.

```text
공식 사이트
  -> URL 발견
  -> robots.txt 확인
  -> 원문 가져오기
  -> 본문 추출
  -> 중복 확인
  -> DB 저장
  -> AI 요약
  -> 태그 저장
  -> 공개 목록 노출
```

조금 더 자세히 쓰면 이렇습니다.

1. `discover`
   공식 사이트의 목록, sitemap, RSS, 공개 인덱스 등에서 후보 URL을 찾습니다.

2. `robots.txt` 확인
   공식 사이트가 “여기는 가져오지 마세요”라고 한 곳은 가져오지 않습니다.

3. `fetchItem`
   허용된 URL만 천천히 요청합니다.

4. 본문 추출
   HTML이면 본문 영역을 뽑고, PDF면 PDF 텍스트를 뽑습니다.

5. 정규화
   국가, 기관, 제목, 날짜, 원문 URL, 본문 텍스트를 같은 모양으로 맞춥니다.

6. 중복 제거
   같은 canonical URL, 같은 content hash, 같은 제목/날짜 조합을 확인합니다.

7. 저장
   `articles` 테이블에 저장합니다.

8. 요약
   LLM이 한국어 요약 JSON을 만듭니다.

9. 태그 갱신
   AI가 만든 태그를 저장하고 tag count를 다시 계산합니다.

10. 공개
   `status='summarized'`이고 `collection.publishable=true`인 자료만 일반 목록에 보입니다.

## 데이터가 화면에 보이는 조건

자료가 DB에 있다고 바로 사용자 화면에 보이는 것은 아닙니다.

일반 사용자 목록에 보이려면 두 조건을 만족해야 합니다.

```text
status = summarized
source_metadata.collection.publishable = true
```

쉬운 말로 풀면 이렇습니다.

- 원문을 제대로 가져왔다.
- 본문 길이가 충분하다.
- robots.txt를 어기지 않았다.
- seed 후보만으로 만든 자료가 아니다.
- AI 요약이 끝났다.

상태값은 다음처럼 이해하면 됩니다.

| 상태 | 쉬운 뜻 | 화면 노출 |
| --- | --- | --- |
| `cleaned` | 원문은 가져왔고 깨끗하게 정리했다 | 아직 일반 노출 안 됨 |
| `summarizing` | AI 요약 중이다 | 일반 노출 안 됨 |
| `summarized` | 요약까지 끝났다 | publishable이면 노출 |
| `failed_summary` | 요약하다가 실패했다 | 재시도 필요 |
| `needs_review` | 사람이 확인해야 한다 | 일반 노출 안 됨 |
| `metadata_only` | URL 같은 정보만 있다 | 일반 노출 안 됨 |
| `robots_disallowed` | robots.txt 때문에 원문 수집 불가 | 일반 노출 안 됨 |
| `blocked` | 접근이 막혔다 | 일반 노출 안 됨 |
| `timeout` | 요청 시간이 초과됐다 | 일반 노출 안 됨 |

데이터가 안 보일 때는 보통 다음 중 하나입니다.

- 수집은 됐지만 아직 요약이 안 됨
- AI API quota가 부족해서 `failed_summary`로 남음
- `publishable=false`라서 비공개 처리됨
- `source_metadata.collection` 정보가 부족함
- `CRON_SECRET` 또는 DB 환경변수가 잘못됨
- 앱이 오래된 빌드/캐시를 보고 있음

이 프로젝트는 DB 의존 화면과 API를 동적 렌더링으로 설정합니다. 그래서 새로 요약된 자료는 다음 요청부터 바로 반영됩니다.

## 수집 대상 국가와 기관

| 국가 | source key | 기관 | 기본 언어 | 주 자료 |
| --- | --- | --- | --- | --- |
| 미국 | `us-scotus` | Supreme Court of the United States | 영어 | opinions, orders, press releases |
| 독일 | `de-bverfg` | Bundesverfassungsgericht | 독일어 | decisions |
| 프랑스 | `fr-conseil-constitutionnel` | Conseil constitutionnel | 프랑스어 | decisions, QPC |

## 절대 지켜야 하는 수집 원칙

이 프로젝트에서 가장 중요한 운영 원칙입니다.

공식 사이트에 부담을 주면 안 됩니다.

그래서 다음을 지킵니다.

1. `robots.txt`를 확인합니다.
2. 금지된 경로는 요청하지 않습니다.
3. 요청 간격을 둡니다.
4. 동시 요청 수를 낮게 유지합니다.
5. 차단이 보이면 우회하지 않습니다.
6. seed URL은 후보로만 저장합니다.
7. 공식 원문이 확인되지 않으면 공개하지 않습니다.

특히 독일 BVerfG는 중요합니다.

- `/SiteGlobals/` 검색 페이지는 robots.txt에서 금지됩니다.
- 따라서 해당 검색 페이지를 직접 수집하지 않습니다.
- 허용된 공식 상세 결정문 URL만 가져옵니다.
- BVerfG가 `Crawl-delay: 30`을 주면 30초 이상 기다립니다.

프랑스 Conseil constitutionnel도 중요합니다.

- `/recherche/` 검색 경로는 robots.txt에서 금지됩니다.
- 따라서 검색 페이지를 긁지 않습니다.
- 공식 sitemap과 `/decision/` 상세 URL을 사용합니다.

미국 SCOTUS도 중요합니다.

- `robots.txt`를 실행 시 확인합니다.
- `/opinions/`, `/orders/`처럼 허용된 경로만 처리합니다.
- 금지된 asset 경로는 요청하지 않습니다.

## 로컬에서 실행하기

처음 개발 환경을 만드는 순서입니다.

### 1. 필요한 도구

필요한 것은 다음입니다.

- Node.js
- pnpm
- Supabase 프로젝트
- LLM API key

### 2. 패키지 설치

```bash
pnpm install
```

### 3. 환경변수 파일 만들기

```bash
cp .env.example .env
```

Windows PowerShell에서는 이렇게 해도 됩니다.

```powershell
Copy-Item .env.example .env
```

### 4. `.env` 채우기

최소한 다음은 채워야 운영 DB를 쓸 수 있습니다.

```env
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
LLM_PROVIDER=gemini
GEMINI_API_KEY=
CRON_SECRET=
ADMIN_USERNAME=admin
ADMIN_PASSWORD=
ADMIN_SESSION_SECRET=
APP_BASE_URL=http://localhost:3000
```

Supabase 환경변수가 없으면 앱은 mock 데이터로 화면을 보여줍니다.

### 5. 개발 서버 실행

```bash
pnpm dev
```

기본 주소는 다음입니다.

```text
http://localhost:3000
```

### 6. 프로덕션 빌드 확인

```bash
pnpm build
pnpm start
```

## 환경변수 설명

환경변수는 프로그램에게 알려 주는 설정값입니다.

예를 들어 “DB 주소는 여기야”, “AI 키는 이거야”, “수집은 몇 초 쉬면서 해” 같은 값입니다.

### 꼭 필요한 값

| 이름 | 쉬운 설명 | 개발자 설명 |
| --- | --- | --- |
| `SUPABASE_URL` | DB 집 주소 | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | DB 관리자 열쇠 | Server-side Supabase service role key |
| `LLM_PROVIDER` | 어떤 AI를 쓸지 | `openai` 또는 `gemini` |
| `OPENAI_API_KEY` | OpenAI 열쇠 | OpenAI summary/embedding key |
| `GEMINI_API_KEY` | Gemini 열쇠 | Gemini 단일 key |
| `GEMINI_API_KEYS` | Gemini 열쇠 여러 개 | comma-separated keys |
| `CRON_SECRET` | 자동 실행용 비밀값 | cron/API bearer or query secret |
| `ADMIN_USERNAME` | 관리자 아이디 | 기본값은 `admin` |
| `ADMIN_PASSWORD` | 관리자 비밀번호 | 브라우저 로그인용 비밀번호 |
| `ADMIN_SESSION_SECRET` | 로그인 쿠키 서명 열쇠 | 비워 두면 `ADMIN_PASSWORD` 또는 `CRON_SECRET` 사용 |
| `APP_BASE_URL` | 서비스 주소 | canonical, sitemap URL base |

### AI 관련 값

| 이름 | 기본값 | 설명 |
| --- | --- | --- |
| `ALLOW_MOCK_SUMMARY` | `false` | `true`이면 API key가 없어도 개발용 대체 요약을 저장할 수 있음 |
| `OPENAI_EMBEDDING_MODEL` | `text-embedding-3-small` | embedding 모델 |
| `GEMINI_PINNED_MODEL` | 비어 있음 | 특정 Gemini 모델만 쓰고 싶을 때 |
| `GEMINI_ALLOW_MODEL_OVERRIDE` | `false` | `GEMINI_SUMMARY_MODELS` 같은 override 허용 여부 |
| `GEMINI_REQUEST_TIMEOUT_MS` | `30000` | Gemini 요청 timeout |
| `GEMINI_TEMPERATURE` | `0.2` | 요약 생성의 변동성 |
| `GEMINI_ROUTER_STATE_PATH` | `.cache/gemini-router-state.json` | Gemini cooldown 상태 저장 파일 |

### 수집 관련 값

| 이름 | 기본값 | 설명 |
| --- | --- | --- |
| `CRAWLER_USER_AGENT` | 비어 있음 | 공식 사이트에 보낼 User-Agent |
| `CRAWLER_TIMEOUT_MS` | `30000` | 일반 fetch timeout |
| `CRAWLER_RETRY_COUNT` | `2` | fetch 재시도 횟수 |
| `CRAWLER_DELAY_MS` | `2000` | 같은 origin 요청 사이 최소 지연 |
| `CRAWLER_ROBOTS_ENABLED` | `true` | robots.txt 확인 여부 |
| `CRAWLEE_MAX_CONCURRENCY` | `2` | CheerioCrawler 동시성 |
| `CRAWLEE_PLAYWRIGHT_MAX_CONCURRENCY` | `1` | Playwright 동시성 |
| `CRAWLEE_PLAYWRIGHT_ENABLED` | `true` | Crawlee Playwright fallback 사용 여부 |
| `CRAWLEE_STORAGE_DIR` | `.crawlee-storage` | Crawlee 로컬 저장소 |
| `ENABLE_VERCEL_CRAWLING` | `false` | Vercel 함수 안에서 무거운 수집 허용 여부 |

### BVerfG 관련 값

| 이름 | 기본값 | 설명 |
| --- | --- | --- |
| `BVERFG_CRAWL_DELAY_MS` | `3000` | 독일 공식 사이트 요청 간격 |
| `BVERFG_TIMEOUT_MS` | `60000` | 독일 fetch timeout |
| `BVERFG_MAX_CONCURRENCY` | `1` | 독일 수집 동시성 |
| `BVERFG_RETRY_COUNT` | `2` | 독일 fetch retry |
| `BVERFG_USE_IPV4_FIRST` | `true` | IPv6 timeout 환경에서 IPv4 우선 |

운영에서 BVerfG가 `Crawl-delay: 30`을 주면 코드가 더 큰 값인 30초를 따릅니다.

## 데이터베이스 준비

Supabase migration을 적용합니다.

```bash
supabase db push
```

현재 migration 파일은 다음입니다.

```text
supabase/migrations/20260508000000_initial_schema.sql
supabase/migrations/20260508001000_search_and_glossary.sql
supabase/migrations/20260509000000_publishable_collection_policy.sql
supabase/migrations/20260509001000_source_url_candidates.sql
```

각 migration이 하는 일은 다음과 같습니다.

| 파일 | 하는 일 |
| --- | --- |
| `initial_schema` | sources, articles, tags, article_tags, ingestion_runs 기본 테이블 생성 |
| `search_and_glossary` | 검색 RPC, glossary seed, pgvector 관련 구조 추가 |
| `publishable_collection_policy` | 공개 가능성 정책을 위한 metadata/index 보강 |
| `source_url_candidates` | seed 후보 URL 저장 테이블 추가 |

## 자주 쓰는 명령어

### 개발 서버

```bash
pnpm dev
```

### 프로덕션 빌드

```bash
pnpm build
pnpm start
```

### 타입 검사

```bash
pnpm exec tsc --noEmit
```

### 린트

```bash
pnpm lint
```

### 프로젝트 자체 검사

```bash
pnpm check
```

### 일반 수집

```bash
pnpm ingest
```

특정 source만 수집하려면 이렇게 합니다.

```bash
pnpm ingest -- --source=us-scotus --limit=5
pnpm ingest -- --source=de-bverfg --limit=5 --debug
pnpm ingest -- --source=fr-conseil-constitutionnel --limit=5 --debug
```

### Crawlee worker 수집

```bash
pnpm crawl:worker -- --source=de-bverfg --limit=5 --strategy=auto --debug
pnpm crawl:worker -- --source=fr-conseil-constitutionnel --limit=5 --dry-run
```

## 자동 수집 일정

정기 수집은 GitHub Actions의 `.github/workflows/crawlee-worker.yml`에서 실행합니다.

GitHub cron은 UTC 기준입니다. 한국시간 기준으로는 다음 시간에 매일 실행됩니다.

| 한국시간 | UTC cron 실행 시각 |
| --- | --- |
| 06:00 | 전날 21:00 UTC |
| 09:00 | 00:00 UTC |
| 12:00 | 03:00 UTC |
| 15:00 | 06:00 UTC |
| 18:00 | 09:00 UTC |
| 21:00 | 12:00 UTC |

workflow cron 표현식은 다음과 같습니다.

```yaml
0 0,3,6,9,12,21 * * *
```

동시에 두 수집이 겹치지 않도록 `concurrency`를 사용합니다. 공식 사이트에 부담을 줄이기 위해 worker 동시성은 1로 제한하고, 같은 도메인 요청 사이에 쉬는 시간을 둡니다.

### 진단

```bash
pnpm crawler:diagnose -- --source=de-bverfg
pnpm crawler:diagnose -- --source=fr-conseil-constitutionnel
pnpm crawler:diagnose -- --source=us-scotus
```

## 기간별 수집 방법

기간을 정해서 수집할 때는 `collect:range`를 사용합니다.

예를 들어 2025년 전체를 수집하려면 다음처럼 합니다.

```bash
pnpm collect:range -- --sources=us-scotus --from=2025-01-01 --to=2025-12-31 --delay-ms=12000 --list-delay-ms=8000
```

독일 BVerfG는 더 천천히 해야 합니다.

```bash
pnpm collect:range -- --sources=de-bverfg --from=2025-01-01 --to=2025-12-31 --delay-ms=30000 --list-delay-ms=8000 --bverfg-use-dejure-index --bverfg-dejure-pages=60
```

프랑스 Conseil constitutionnel은 공식 sitemap 기반으로 수집합니다.

```bash
pnpm collect:range -- --sources=fr-conseil-constitutionnel --from=2025-01-01 --to=2025-12-31 --delay-ms=12000 --list-delay-ms=8000
```

여러 source를 한 번에 지정할 수도 있습니다.

```bash
pnpm collect:range -- --sources=us-scotus,de-bverfg,fr-conseil-constitutionnel --from=2025-01-01 --to=2025-12-31 --delay-ms=12000 --list-delay-ms=8000
```

하지만 운영에서는 한 나라씩 순서대로 하는 것을 권장합니다.

이유는 단순합니다. 공식 사이트에 부담을 덜 주기 위해서입니다.

### 기간 수집 옵션

| 옵션 | 예 | 설명 |
| --- | --- | --- |
| `--sources` | `us-scotus,de-bverfg` | 수집할 source key |
| `--from` | `2025-01-01` | 시작일 |
| `--to` | `2025-12-31` | 종료일 |
| `--delay-ms` | `12000` | 상세 요청 사이 지연 |
| `--list-delay-ms` | `8000` | 목록/sitemap 요청 사이 지연 |
| `--max-candidates` | `10` | 테스트용 후보 수 제한 |
| `--bverfg-use-dejure-index` | flag | BVerfG 공식 상세 URL 후보를 얻기 위한 공개 인덱스 사용 |
| `--bverfg-dejure-pages` | `60` | dejure index 확인 page 수 |
| `--bverfg-detail-url` | URL | 특정 BVerfG 공식 상세 URL 직접 지정 |

## 요약과 태그 갱신

수집만 끝난 자료는 보통 `cleaned` 상태입니다.

사용자 목록에 보이게 하려면 요약을 실행해야 합니다.

```bash
pnpm summarize-pending
```

한 번에 최대 100건까지 처리할 수 있습니다.

```bash
pnpm summarize-pending -- --limit=100
```

요약 후 태그 카운트를 다시 계산합니다.

```bash
pnpm refresh-tag-counts
```

사용하지 않는 태그도 지우려면 다음을 사용합니다.

```bash
pnpm refresh-tag-counts -- --delete-orphans
```

Gemini quota가 부족하면 다음 같은 오류가 날 수 있습니다.

```text
All Gemini routes are exhausted or cooling down.
```

이 말은 “AI 사용량이 잠시 꽉 찼다”는 뜻입니다. 원문 수집이 실패한 것이 아닙니다. 시간이 지난 뒤 다시 `pnpm summarize-pending`을 실행하면 됩니다.

## 관리자 화면과 API

관리자 화면은 수집 상태와 실행 기록을 확인하는 곳입니다.

관리자 페이지:

```text
/admin
/admin/ingestion-runs
```

브라우저로 `/admin`에 들어가면 `/admin/login`으로 이동합니다.

로그인 정보는 다음 환경변수를 사용합니다.

| 항목 | 값 |
| --- | --- |
| 아이디 | `ADMIN_USERNAME`, 없으면 `admin` |
| 비밀번호 | `ADMIN_PASSWORD`, 없으면 기존 `CRON_SECRET` |

자동화나 cron API는 기존처럼 `Authorization: Bearer YOUR_SECRET` 또는 `?secret=YOUR_SECRET` 방식도 계속 사용할 수 있습니다.

관리자 화면에서 할 수 있는 일은 다음과 같습니다.

| 기능 | 설명 |
| --- | --- |
| 수집 실행 | 공식 사이트에서 새 자료를 천천히 가져옵니다 |
| 수집 후 요약 | 수집 뒤 요약 대기 자료를 함께 처리합니다 |
| 요약 실행 | `cleaned`, `failed_summary` 자료를 다시 요약합니다 |
| 태그 갱신 | 공개 자료 기준으로 태그 개수를 다시 계산합니다 |
| 검토 목록 | 실패, 차단, timeout, 검토 필요 자료를 확인합니다 |
| 요약 실패 1건 재시도 | 검토 목록의 `요약 실패` 뱃지를 눌러 해당 자료만 다시 요약합니다 |

`요약 실패` 뱃지 재시도가 성공하면 해당 자료는 즉시 검토 목록에서 사라집니다. 실패하면 같은 줄에 실패 메시지가 표시됩니다.

관리 API는 다음과 같습니다.

| Method | Path | 설명 |
| --- | --- | --- |
| `GET` | `/api/articles` | 기사 목록 |
| `GET` | `/api/articles/[slug]` | 기사 상세 |
| `GET` | `/api/search` | 검색 |
| `GET` | `/api/tags` | 태그 목록 |
| `GET` | `/api/tags/[slug]` | 태그 상세 |
| `GET` | `/api/sources` | 수집 기관 목록 |
| `GET` | `/api/sources/[sourceKey]` | 기관 상세 |
| `GET` | `/api/admin/ingestion-runs` | 관리자 수집 기록 |
| `POST` | `/api/admin/ingest` | 관리자 수동 수집 |
| `GET` | `/api/admin/cron/ingest` | cron 수집 endpoint |

`POST /api/admin/ingest` body 예시:

```json
{
  "sourceKey": "de-bverfg",
  "limit": 5,
  "summarize": true,
  "summarizeLimit": 5,
  "refreshTags": true
}
```

요약 실패 자료 1건만 다시 시도하려면 다음처럼 보냅니다.

```json
{
  "action": "retry-summary",
  "articleId": "ARTICLE_UUID"
}
```

또는 `slug`를 사용할 수 있습니다.

```json
{
  "action": "retry-summary",
  "slug": "article-slug"
}
```

## 검색 방식

검색 API와 화면은 다음 mode를 지원합니다.

```text
fulltext
semantic
hybrid
```

예시는 다음과 같습니다.

```text
/api/search?q=표현의 자유&mode=hybrid
/api/search?q=QPC&mode=fulltext
/api/search?q=First Amendment&mode=semantic
```

검색 필터는 다음을 지원합니다.

| 필터 | 예 | 설명 |
| --- | --- | --- |
| `q` | `freedom` | 검색어 |
| `range` | `today`, `week`, `month` | 기간 |
| `source` | `de-bverfg` | 수집 기관 |
| `jurisdiction` | `Germany` | 국가 |
| `type` | `decision` | 자료 유형 |
| `tag` | `qpc` | 태그 |
| `language` | `fr` | 원문 언어 |
| `page` | `2` | 페이지 |
| `pageSize` | `20` | 한 페이지 개수 |

## 폴더 구조

```text
app/
  화면과 API route

components/
  재사용 UI 컴포넌트

lib/ai/
  AI 요약, Gemini/OpenAI client, 태그 정규화, embedding

lib/crawler/
  robots.txt, HTTP fetch, retry, rate limit, sitemap, diagnostics

lib/crawlee/
  Crawlee 기반 독일/프랑스 spider

lib/db/
  Supabase client, query 함수, mock data, 타입

lib/ingest/
  수집 결과 정규화, 중복 제거, 저장, 요약 실행

lib/search/
  fulltext/semantic/hybrid 검색

lib/sources/
  국가별 source adapter

lib/utils/
  날짜, slug, hash, 인증, 숫자 helper

scripts/
  CLI 명령

supabase/migrations/
  DB schema 변경 파일

.github/workflows/
  GitHub Actions worker/diagnose 예시
```

## 새 수집원을 추가하는 방법

새 국가나 기관을 추가하려면 `SourceAdapter`를 만듭니다.

위치는 보통 다음입니다.

```text
lib/sources/new-source.ts
```

그리고 여기에 등록합니다.

```text
lib/sources/index.ts
```

필수 메서드는 세 개입니다.

| 메서드 | 쉬운 설명 | 반환 |
| --- | --- | --- |
| `discover()` | 후보 URL 찾기 | `DiscoveredItem[]` |
| `fetchItem()` | 원문 가져오기 | `RawArticle` |
| `normalize()` | DB 저장 모양으로 바꾸기 | `NormalizedArticle` |

새 adapter를 만들 때 꼭 확인해야 할 것:

- 공식 사이트의 `robots.txt`
- 허용된 목록 URL
- 허용된 상세 URL
- 날짜 형식
- 본문 CSS selector
- PDF인지 HTML인지
- 중복 제거 기준
- 공개해도 되는 자료인지

seed fallback을 넣을 때도 주의해야 합니다.

seed는 “나중에 다시 시도할 후보”입니다. seed만으로 일반 공개 article을 만들면 안 됩니다.

## 검증 방법

작업 후 최소한 다음은 실행합니다.

```bash
pnpm exec tsc --noEmit
pnpm lint
pnpm check
pnpm build
```

각 명령의 뜻은 다음과 같습니다.

| 명령 | 쉬운 설명 |
| --- | --- |
| `pnpm exec tsc --noEmit` | TypeScript가 화내는 곳이 없는지 확인 |
| `pnpm lint` | 코드 스타일과 위험한 패턴 확인 |
| `pnpm check` | 프로젝트 핵심 규칙 테스트 |
| `pnpm build` | 실제 배포용 빌드가 되는지 확인 |

보안 취약점 확인:

```bash
pnpm audit --prod --audit-level moderate
```

## 문제 해결

### 화면에 데이터가 안 보여요

확인할 것:

1. DB에 article이 있는지 확인합니다.
2. `status`가 `summarized`인지 확인합니다.
3. `source_metadata.collection.publishable`이 `true`인지 확인합니다.
4. `pnpm summarize-pending -- --limit=100`을 실행합니다.
5. `pnpm refresh-tag-counts -- --delete-orphans`를 실행합니다.
6. `pnpm build` 후 실행 중인 서버가 오래된 빌드를 보고 있지 않은지 확인합니다.

### 수집은 됐는데 요약이 안 돼요

가능한 이유:

- AI API key가 없음
- Gemini/OpenAI quota 초과
- 모델 cooldown 중
- 원문이 너무 길어 timeout
- JSON repair도 실패

해결:

```bash
pnpm summarize-pending -- --limit=20
```

너무 많이 한 번에 돌리지 말고 작은 단위로 재시도합니다.

### 독일 BVerfG가 timeout이 나요

확인:

```bash
pnpm crawler:diagnose -- --source=de-bverfg --debug
```

추가 네트워크 확인:

```bash
curl -4 -L -I --max-time 30 https://www.bundesverfassungsgericht.de
curl -4 -L --max-time 60 https://www.bundesverfassungsgericht.de/robots.txt
curl -6 -L -I --max-time 30 https://www.bundesverfassungsgericht.de
```

`curl -4`는 되고 `curl -6`이 안 되면 IPv4 우선 설정을 사용합니다.

```bash
set NODE_OPTIONS=--dns-result-order=ipv4first
```

또는:

```env
BVERFG_USE_IPV4_FIRST=true
```

### robots.txt 때문에 막혀요

우회하지 않습니다.

그 경로는 수집하지 않습니다.

대신 할 수 있는 것:

- 허용된 sitemap 찾기
- 허용된 공식 상세 URL만 사용하기
- metadata-only 후보로 남기기
- 사람이 직접 검토하기

### 중복이 생겨요

이 프로젝트는 다음 기준으로 중복을 줄입니다.

- canonical URL
- source별 content hash
- source별 title/date
- case number
- slug unique constraint

중복 URL이 이미 DB에 있으면 건너뜁니다.

### 빌드가 느리거나 멈춘 것 같아요

생성물과 크롤러 저장소는 빌드/린트 대상에서 제외되어야 합니다.

현재 제외 대상:

- `.cache`
- `.crawlee-storage`
- `.next`
- `node_modules`
- `coverage`
- `playwright-report`
- `test-results`
- `logs`
- `*.tsbuildinfo`

## 현재 수집 상태 예시

현재 DB 스냅샷 기준 수집 결과는 다음과 같습니다.

| 국가 | source | 수집 건수 | 원문 확보 | 요약 완료 | 요약 재시도 대기 | 검토 대기 | 중복 URL |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 미국 | `us-scotus` | 93 | 93 | 81 | 6 | 6 | 0 |
| 독일 | `de-bverfg` | 270 | 270 | 270 | 0 | 0 | 0 |
| 프랑스 | `fr-conseil-constitutionnel` | 342 | 342 | 181 | 159 | 0 | 0 |
| 합계 | US/DE/FR | 705 | 705 | 532 | 165 | 6 | 0 |

요약 재시도 대기는 원문 수집 실패가 아닙니다.

대부분 AI quota 또는 cooldown 때문에 생깁니다. 나중에 `pnpm summarize-pending`을 다시 실행하거나, 관리자 검토 목록에서 `요약 실패` 뱃지를 눌러 1건씩 다시 처리할 수 있습니다.

## 마지막으로 기억할 것

사용자에게 중요한 것:

- 검색해서 읽으면 됩니다.
- AI 요약은 참고용입니다.
- 중요한 판단은 원문을 확인해야 합니다.

개발자에게 중요한 것:

- 공개 목록은 `summarized + publishable=true`만 보입니다.
- robots.txt는 반드시 지킵니다.
- 수집은 천천히, 중복 없이, 검증 가능하게 합니다.
- 수집과 요약은 다른 단계입니다.
- LLM quota 문제는 원문 수집 문제와 구분해야 합니다.
