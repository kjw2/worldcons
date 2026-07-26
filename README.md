# 헌법판례요약시스템

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
- AI API quota, 모델 전환, 로컬 라우터 상태 때문에 `failed_summary`로 남음
- `publishable=false`라서 비공개 처리됨
- `source_metadata.collection` 정보가 부족함
- `CRON_SECRET` 또는 DB 환경변수가 잘못됨
- 앱이 오래된 빌드/캐시를 보고 있음

이 프로젝트는 DB 의존 화면과 API를 동적 렌더링으로 설정합니다. 그래서 새로 요약된 자료는 다음 요청부터 바로 반영됩니다.

## 수집 대상 국가와 기관

| 국가 | source key | 기관 | 기본 언어 | 주 자료 |
| --- | --- | --- | --- | --- |
| 미국 | `us-scotus` | Supreme Court of the United States | 영어 | Opinions of the Court |
| 독일 | `de-bverfg` | Bundesverfassungsgericht | 독일어 | decisions |
| 프랑스 | `fr-conseil-constitutionnel` | Conseil constitutionnel | 프랑스어 | decisions, QPC |
| 스페인 | `es-tribunal-constitucional` | Tribunal Constitucional de España | 스페인어 | HJ resolutions |

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
- 목록 후보 수집은 `dejure.org` 공개 인덱스를 기준으로 합니다.
- Open Legal Data API는 항상 가능한 보조 후보로만 취급합니다.
- Open Legal Data API가 최신 BVerfG 목록 기준을 대체하지 않습니다.
- 허용된 공식 상세 결정문 URL만 가져옵니다.
- BVerfG가 `Crawl-delay: 30`을 주면 30초 이상 기다립니다.

프랑스 Conseil constitutionnel도 중요합니다.

- `/recherche/` 검색 경로는 robots.txt에서 금지됩니다.
- 따라서 검색 페이지를 긁지 않습니다.
- 공식 sitemap과 `/decision/` 상세 URL을 사용합니다.

미국 SCOTUS도 중요합니다.

- `robots.txt`를 실행 시 확인합니다.
- 현재 정기 수집은 SCOTUS 공식 `Opinions of the Court` 목록을 기준으로 합니다.
- `Opinions of the Court`는 대법원이 사건에 대한 판단과 이유를 밝히는 본안 판결·법정 의견이므로 일반적인 헌법판례 큐레이션의 핵심 자료로 봅니다.
- `Opinions Relating to Orders`는 상고허가 거부나 절차명령 등에 붙은 개별 대법관의 동의·반대 의견입니다. 헌법 쟁점 흐름을 읽는 보조 자료가 될 수 있지만, 일반 본안 판결과 성격이 달라 현재 수집 대상에는 섞지 않습니다.
- `In-Chambers Opinions`는 긴급정지, 임시명령, 집행정지 같은 신청을 개별 대법관이 처리하면서 작성하는 의견입니다. 임시구제 성격이 강해 현재 일반 헌법판례 수집 대상에는 넣지 않습니다.
- 금지된 경로와 asset 경로는 요청하지 않습니다.

스페인 Tribunal Constitucional은 HJ 시스템을 기준으로 수집합니다.

- canonical 원문 URL은 `https://hj.tribunalconstitucional.es/HJ/es/Resolucion/Show/{hjId}`입니다.
- 목록 수집은 HJ 검색의 일반 `Fechas Desde/Hasta`를 사용합니다.
- 날짜 기준은 HJ JSON의 `FECHA_REGISTRO` 하나입니다.
- `publishedAt`, `original_published_at`, 정렬, 기간 필터는 모두 `FECHA_REGISTRO` 결정일 기준입니다.
- `FECHA_BOE`, `NUMERO_BOE`, `REFERENCIA_BOE`는 `source_metadata`의 보조 메타데이터로만 저장합니다.
- BOE 날짜나 BOE 번호는 v1 수집 필터로 쓰지 않습니다.
- 백필 시작 결정일은 `2025-01-01` date-only inclusive입니다.
- HJ JSON이 실패해 HTML/OpenXML fallback을 쓰면 `needs_review`로 남기고 자동 요약 큐에 넣지 않습니다.
- `CONTENIDO_IRRELEVANTE_PARA_INTERNET=true`이면 `publishable=false`와 review required로 저장합니다.

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
LLM_SETTINGS_SECRET=
ADMIN_USERNAME=ap570@naver.com
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
| `CRON_SECRET` | 자동 실행용 비밀값 | cron/API `Authorization: Bearer` 또는 `x-cron-secret` 헤더 |
| `LLM_SETTINGS_SECRET` | LLM 키 암호화 열쇠 | 관리자 화면에 저장한 LLM API key 암호화용 전용 secret |
| `ADMIN_USERNAME` | 관리자 아이디 | 기본값은 `ap570@naver.com` |
| `ADMIN_PASSWORD` | 관리자 비밀번호 | 브라우저 로그인용 비밀번호. 운영 환경에서는 6자 이상 필요 |
| `ADMIN_SESSION_SECRET` | 로그인 쿠키 서명 열쇠 | 운영 환경에서는 필수. `ADMIN_PASSWORD`와 다른 32자 이상 값 |
| `APP_BASE_URL` | 서비스 주소 | canonical, sitemap URL base |

운영 환경에서는 `ADMIN_PASSWORD`를 6자 이상으로 설정하고, `ADMIN_SESSION_SECRET`, `CRON_SECRET`, `LLM_SETTINGS_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`는 모두 32자 이상으로 설정해야 합니다. 위 값은 서로 달라야 하며, 서버 secret은 `NEXT_PUBLIC_` 환경변수로 노출하지 않습니다.

### AI 관련 값

| 이름 | 기본값 | 설명 |
| --- | --- | --- |
| `ALLOW_MOCK_SUMMARY` | `false` | `true`이면 API key가 없어도 개발용 대체 요약을 저장할 수 있음 |
| `OPENAI_EMBEDDING_MODEL` | `text-embedding-3-small` | embedding 모델 |
| `STALE_SUMMARIZING_MINUTES` | `30` | 이 시간보다 오래된 `summarizing` 자료를 중단된 요약 작업으로 보고 재시도 대기로 복구 |
| `GEMINI_PINNED_MODEL` | 비어 있음 | 특정 Gemini 모델만 쓰고 싶을 때 |
| `GEMINI_ALLOW_MODEL_OVERRIDE` | `false` | `GEMINI_SUMMARY_MODELS` 같은 override 허용 여부 |
| `GEMINI_REQUEST_TIMEOUT_MS` | `30000` | Gemini 요청 timeout |
| `GEMINI_TEMPERATURE` | `0.2` | 요약 생성의 변동성 |
| `GEMINI_AUTO_DISCOVER_MODELS` | `true` | Gemini models.list API로 사용 가능한 모델 목록을 캐시해 route 후보 자동 갱신 |
| `GEMINI_MODEL_CATALOG_PATH` | `.cache/gemini-model-catalog.json` | Gemini 모델 catalog 캐시 파일 |
| `GEMINI_MODEL_CATALOG_TTL_MS` | `43200000` | Gemini 모델 catalog 재조회 간격 |
| `GEMINI_MODEL_DISCOVERY_TIMEOUT_MS` | `10000` | Gemini 모델 catalog 조회 timeout |
| `GEMINI_ROUTER_STATE_PATH` | `.cache/gemini-router-state.json` | Gemini cooldown 상태 저장 파일 |
| `GEMINI_ENFORCE_LOCAL_RPD_LIMITS` | `false` | `true`이면 로컬 추정 RPD 한도로 route를 사전 차단 |

### 수집 관련 값

| 이름 | 기본값 | 설명 |
| --- | --- | --- |
| `CRAWLER_USER_AGENT` | 비어 있음 | 공식 사이트에 보낼 User-Agent |
| `CRAWLER_TIMEOUT_MS` | `30000` | 일반 fetch timeout |
| `CRAWLER_RETRY_COUNT` | `2` | fetch 재시도 횟수 |
| `CRAWLER_DELAY_MS` | `2000` | 같은 origin 요청 사이 최소 지연 |
| `CRAWLER_ROBOTS_ENABLED` | `true` | robots.txt 확인 여부 |
| `INGEST_RANGE_DAYS` | `14` | 정기 수집에서 미국과 프랑스가 기본으로 다시 확인하는 날짜 범위 |
| `CRAWLEE_MAX_CONCURRENCY` | `2` | CheerioCrawler 동시성 |
| `CRAWLEE_PLAYWRIGHT_MAX_CONCURRENCY` | `1` | Playwright 동시성 |
| `CRAWLEE_PLAYWRIGHT_ENABLED` | `true` | Crawlee Playwright fallback 사용 여부 |
| `CRAWLEE_STORAGE_DIR` | `.crawlee-storage` | Crawlee 로컬 저장소 |
| `ENABLE_VERCEL_CRAWLING` | `false` | Vercel 함수 안에서 무거운 수집 허용 여부 |
| `SITE_ANALYTICS_ENABLED` | `true` | `false`이면 자체 이용 통계 이벤트 저장 비활성화 |
| `ANALYTICS_HASH_SECRET` | 비어 있음 | 접속 IP hash 생성용 secret. 비워 두면 관리자/cron/Supabase secret 중 하나를 사용 |
| `RATE_LIMIT_ENABLED` | `true` | 공개 API, 이용 통계 수집, 관리자 로그인 rate limit 활성화 |
| `RATE_LIMIT_PUBLIC_API_MAX` | `120` | IP 또는 fallback 접속 식별자별 공개 조회 API window당 최대 요청 수 |
| `RATE_LIMIT_PUBLIC_API_WINDOW_MS` | `60000` | 공개 조회 API rate limit window |
| `RATE_LIMIT_ANALYTICS_EVENT_MAX` | `240` | 이용 통계 이벤트 수집 endpoint window당 최대 요청 수 |
| `RATE_LIMIT_ANALYTICS_EVENT_WINDOW_MS` | `60000` | 이용 통계 이벤트 수집 rate limit window |
| `RATE_LIMIT_ADMIN_LOGIN_MAX` | `10` | 관리자 로그인 endpoint window당 최대 시도 수 |
| `RATE_LIMIT_ADMIN_LOGIN_WINDOW_MS` | `600000` | 관리자 로그인 rate limit window |

### BVerfG 관련 값

| 이름 | 기본값 | 설명 |
| --- | --- | --- |
| `BVERFG_CRAWL_DELAY_MS` | `3000` | 독일 공식 사이트 요청 간격 |
| `BVERFG_TIMEOUT_MS` | `60000` | 독일 fetch timeout |
| `BVERFG_MAX_CONCURRENCY` | `1` | 독일 수집 동시성 |
| `BVERFG_RETRY_COUNT` | `2` | 독일 fetch retry |
| `BVERFG_INGEST_RANGE_DAYS` | `60` | 정기 수집에서 독일 BVerfG만 더 넓게 확인하는 최소 날짜 범위. `INGEST_RANGE_DAYS=14`이어도 독일은 이 값 이상을 봅니다 |
| `BVERFG_USE_IPV4_FIRST` | `true` | IPv6 timeout 환경에서 IPv4 우선 |

운영에서 BVerfG가 `Crawl-delay: 30`을 주면 코드가 더 큰 값인 30초를 따릅니다.
독일 BVerfG는 새 결정이 띄엄띄엄 올라오거나 외부 목록 반영이 늦을 수 있어 정기 수집에서도 최근 60일을 다시 확인합니다.

### 스페인 HJ 관련 값

| 이름 | 기본값 | 설명 |
| --- | --- | --- |
| `SPAIN_INGEST_RANGE_DAYS` | `180` | 정기 수집에서 스페인 HJ가 다시 확인하는 최소 결정일 범위 |
| `SPAIN_INGEST_RANGE_DAYS_CAP` | `730` | 마지막 성공 실행 기준 자동 확장 범위 상한 |
| `SPAIN_DISCOVERY_MAX_PAGES` | `20` | 일일 증분 HJ 목록 page 상한 |
| `SPAIN_BACKFILL_MAX_PAGES` | `200` | 초기/수동 백필 HJ 목록 page 상한 |
| `SPAIN_DISCOVERY_STOP_AFTER_OLD_PAGES` | `5` | 오래된 결정만 연속으로 나온 뒤 중단할 page 수 |
| `SPAIN_MIN_SOURCE_TEXT_LENGTH` | `2000` | 실체 섹션이 있는 HJ 원문을 요약 후보로 인정하는 최소 정리 본문 길이 |

스페인은 21:00 UTC, 즉 06:00 KST 일일 worker에서 함께 수집됩니다.
`INGEST_RANGE_DAYS=14`로 worker를 실행해도 스페인은 소스별 기본값 때문에 최소 180일을 다시 확인합니다.

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
supabase/migrations/20260613090000_add_spain_tribunal_constitucional_source.sql
supabase/migrations/20260615093000_public_read_performance_indexes.sql
```

각 migration이 하는 일은 다음과 같습니다.

| 파일 | 하는 일 |
| --- | --- |
| `initial_schema` | sources, articles, tags, article_tags, ingestion_runs 기본 테이블 생성 |
| `search_and_glossary` | 검색 RPC, glossary seed, pgvector 관련 구조 추가 |
| `publishable_collection_policy` | 공개 가능성 정책을 위한 metadata/index 보강 |
| `source_url_candidates` | seed 후보 URL 저장 테이블 추가 |
| `add_spain_tribunal_constitucional_source` | 스페인 Tribunal Constitucional HJ 수집원 등록 |
| `public_read_performance_indexes` | 공개 목록·상세 관련 조회가 커질 때 필요한 부분 인덱스 추가 |

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
pnpm crawl:worker -- --source=es-tribunal-constitucional --limit=5 --strategy=api --dry-run --no-playwright
pnpm crawl:worker -- --source=fr-conseil-constitutionnel --limit=5 --dry-run
```

## 자동 수집 일정

정기 수집은 GitHub Actions의 `.github/workflows/crawlee-worker.yml`에서 실행합니다.

GitHub cron은 UTC 기준입니다. 현재 정기 worker는 한국시간 기준 06:00에 매일 한 번 실행됩니다.

| 한국시간 | UTC cron 실행 시각 |
| --- | --- |
| 06:00 | 전날 21:00 UTC |

workflow cron 표현식은 다음과 같습니다.

```yaml
0 21 * * *
```

동시에 두 수집이 겹치지 않도록 `concurrency`를 사용합니다. 공식 사이트에 부담을 줄이기 위해 worker 동시성은 1로 제한하고, 같은 도메인 요청 사이에 쉬는 시간을 둡니다.

정기 worker는 DB에서 활성화된 4개 source adapter를 순서대로 실행합니다.
기본 실행 옵션은 `strategy=auto`, `--limit=20`, `--range-days=14`, `--refresh-existing`, `--use-playwright`, `--debug`입니다.
수집이 끝나면 `pnpm summarize-pending`이 공개 가능한 요약 후보를 국가별 라운드로빈 순서로 처리합니다. Gemini의 일시적 429가 발생하면 router cooldown보다 긴 65초 후 같은 건을 한 번 재시도하고, 그래도 보류되면 5분 간격으로 후속 pass를 실행합니다. 최대 4개 pass 뒤에도 보류·실패가 남으면 workflow를 실패로 표시해 부분 완료가 성공으로 숨지 않게 합니다. 마지막에는 공개 태그 카운트를 갱신하고, production의 인증된 `/api/admin/public-content/revalidate`를 호출해 홈·목록·기사·포털 캐시를 즉시 갱신합니다.

| 국가 | source key | 정기 수집 범위 | 최대 처리 건수 | 목록/수집 기준 | 비고 |
| --- | --- | ---: | ---: | --- | --- |
| 독일 | `de-bverfg` | 최근 60일 | 20건 | `dejure.org` BVerfG 목록 후보와 공식 BVerfG 상세 원문 | Open Legal Data는 가능한 보조 후보입니다. `BVERFG_DEJURE_PAGES=4`를 사용합니다. |
| 미국 | `us-scotus` | 최근 14일 | 20건 | SCOTUS 공식 Opinions of the Court 목록 | 본안 opinion 자료와 헌법 관련성 필터를 적용합니다. |
| 프랑스 | `fr-conseil-constitutionnel` | 최근 14일 | 20건 | Conseil constitutionnel/QPC360 계열 공식 자료 | `FRANCE_CRAWL_DELAY_MS=3000`, `FRANCE_TIMEOUT_MS=90000`, 동시성 1을 사용합니다. |
| 스페인 | `es-tribunal-constitucional` | 최소 최근 180일 | 20건 | HJ 일반 `Fechas Desde/Hasta` 검색과 HJ JSON 상세 | 기준일은 HJ `FECHA_REGISTRO` 결정일입니다. BOE 날짜는 보조 메타데이터로만 저장합니다. |

스페인은 마지막 `completed` 수집 실행이 오래됐으면 범위를 `마지막 성공 실행 후 경과일 + 30일`까지 자동으로 넓힙니다.
이 자동 확장 범위는 `SPAIN_INGEST_RANGE_DAYS_CAP=730`을 넘지 않습니다.

예를 들어 2026-06-14 06:00 KST 정기 실행은 GitHub Actions 기준 2026-06-13 21:00 UTC에 시작합니다.
이때 코드의 UTC 날짜 경계 계산상 최근 14일은 2026-05-30 00:00 UTC 이후, 최근 60일은 2026-04-14 00:00 UTC 이후, 최근 180일은 2025-12-15 00:00 UTC 이후를 다시 확인합니다.

관리자 화면에서 만든 수집·요약·태그 갱신 작업은 별도 큐에 들어가며, GitHub Actions의 `.github/workflows/admin-job-worker.yml`이 15분마다 production `/api/admin/cron/jobs`를 호출해 처리합니다. 이 workflow는 `${{ secrets.CRON_SECRET }}` 값을 `Authorization: Bearer` 헤더로만 보내며, URL `?secret=` 방식은 금지합니다. repository variable `WORLDCONS_BASE_URL`이 있으면 기본 production URL `https://worldcons.vercel.app` 대신 사용합니다.

두 자동화의 역할은 분리되어 있습니다.

| workflow | 역할 |
| --- | --- |
| `.github/workflows/crawlee-worker.yml` | 공식 사이트 수집, 요약, 태그 갱신을 한국시간 06:00에 실행하는 일일 배치 |
| `.github/workflows/admin-job-worker.yml` | 관리자 화면에서 대기열에 등록된 작업을 15분마다 짧게 drain |

### 진단

```bash
pnpm crawler:diagnose -- --source=de-bverfg
pnpm crawler:diagnose -- --source=es-tribunal-constitucional
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
목록 후보는 `dejure.org`를 기준으로 수집합니다.
Open Legal Data API는 사용할 수 있는 경우에도 항상 가능한 보조 후보일 뿐이며, 최신 BVerfG 목록 기준으로 보지 않습니다.

```bash
pnpm collect:range -- --sources=de-bverfg --from=2025-01-01 --to=2025-12-31 --delay-ms=30000 --list-delay-ms=8000 --bverfg-use-dejure-index --bverfg-dejure-pages=60
```

프랑스 Conseil constitutionnel은 공식 sitemap 기반으로 수집합니다.

```bash
pnpm collect:range -- --sources=fr-conseil-constitutionnel --from=2025-01-01 --to=2025-12-31 --delay-ms=12000 --list-delay-ms=8000
```

스페인 Tribunal Constitucional은 HJ `FECHA_REGISTRO` 결정일 기준으로 수집합니다.
초기 백필도 `2025-01-01`부터 decision date inclusive로 실행합니다.
BOE 일자는 저장만 하고 기간 필터에는 쓰지 않습니다.

```bash
pnpm collect:range -- --sources=es-tribunal-constitucional --from=2025-01-01 --to=2025-12-31 --delay-ms=12000 --list-delay-ms=8000
```

여러 source를 한 번에 지정할 수도 있습니다.

```bash
pnpm collect:range -- --sources=us-scotus,de-bverfg,fr-conseil-constitutionnel,es-tribunal-constitucional --from=2025-01-01 --to=2025-12-31 --delay-ms=12000 --list-delay-ms=8000
```

하지만 운영에서는 한 나라씩 순서대로 하는 것을 권장합니다.

이유는 단순합니다. 공식 사이트에 부담을 덜 주기 위해서입니다.

### 기간 수집 옵션

| 옵션 | 예 | 설명 |
| --- | --- | --- |
| `--sources` | `us-scotus,de-bverfg,es-tribunal-constitucional` | 수집할 source key |
| `--from` | `2025-01-01` | 시작일 |
| `--to` | `2025-12-31` | 종료일 |
| `--delay-ms` | `12000` | 상세 요청 사이 지연 |
| `--list-delay-ms` | `8000` | 목록/sitemap 요청 사이 지연 |
| `--max-candidates` | `10` | 테스트용 후보 수 제한 |
| `--bverfg-use-dejure-index` | flag | BVerfG 목록 기준인 `dejure.org` 공개 인덱스에서 사건번호 후보 수집. 현재 기본 동작 |
| `--bverfg-dejure-pages` | `60` | dejure index 확인 page 수 |
| `--bverfg-disable-dejure-index` | flag | 진단용으로만 dejure 목록 기준을 비활성화 |
| `--bverfg-use-external-index` | flag | Open Legal Data API를 가능한 보조 후보 인덱스로 함께 사용 |
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

Gemini 라우터가 모든 경로를 제외하면 다음 같은 오류가 날 수 있습니다.

```text
No Gemini routes are locally available for Summarize. This is router state, not proof that the Gemini free quota is exhausted.
```

이 말은 실제 무료 한도 소진만 뜻하지 않습니다. `.cache/gemini-router-state.json`의 cooldown 상태, Gemini 모델 전환, 또는 분당 제한 때문에 앱이 호출 전에 모든 route를 제외했다는 뜻일 수 있습니다.

기본값은 Gemini 모델 catalog를 자동 조회해 `generateContent`를 지원하는 텍스트 모델만 route 후보에 반영합니다. 모델 전환 직후에는 `.cache/gemini-model-catalog.json`이 갱신되면서 새 안정 모델을 자동으로 우선 사용합니다. 로컬 추정 RPD 한도로 route를 막고 싶을 때만 `GEMINI_ENFORCE_LOCAL_RPD_LIMITS=true`를 사용합니다.

## 관리자 화면과 API

관리자 화면은 수집 상태와 실행 기록을 확인하는 곳입니다.

관리자 페이지:

```text
/admin
/admin/work
/admin/analytics
/admin/articles
/admin/audit
/admin/candidates
/admin/ingestion-runs
/admin/glossary-candidates
/admin/llm
/admin/governance
```

관리자 화면은 새 운영 셸과 통합 업무 큐만 사용합니다. 기존 `/admin/operations`와 `/admin/jobs` 화면은 제거되었으며 각각 `/admin`, `/admin/work?type=execution`으로 영구 이동합니다.

공개 화면의 상단 메뉴에는 관리자 링크를 노출하지 않습니다. 브라우저 주소창에서 `/admin`에 들어가면 `/admin/login`으로 이동합니다.

로그인 정보는 다음 환경변수를 사용합니다.

| 항목 | 값 |
| --- | --- |
| 아이디 | `ADMIN_USERNAME`, 없으면 `ap570@naver.com` |
| 비밀번호 | `ADMIN_PASSWORD` |

브라우저 관리자 화면은 로그인 세션 쿠키와 CSRF 토큰으로 접근합니다. `CRON_SECRET`은 더 이상 브라우저 로그인 비밀번호로 쓰지 않습니다. 자동화나 cron API는 `Authorization: Bearer YOUR_SECRET` 또는 `x-cron-secret: YOUR_SECRET` 헤더를 사용해야 하며, URL의 `?secret=` 방식은 허용하지 않습니다.

관리자 화면에서 할 수 있는 일은 다음과 같습니다.

| 기능 | 설명 |
| --- | --- |
| 수집 실행 | 공식 사이트에서 새 자료를 천천히 가져옵니다 |
| 수집 후 요약 | 수집 뒤 요약 대기 자료를 함께 처리합니다 |
| 요약 실행 | `cleaned`, `failed_summary` 자료를 다시 요약합니다 |
| 태그 갱신 | 공개 자료 기준으로 태그 개수를 다시 계산합니다 |
| 통합 업무 큐 | 실행·기사 라이프사이클·URL 후보·공개·아웃박스·호환 작업을 한 화면에서 확인하고 허용된 취소·재시도·공개 조치를 실행합니다 |
| 검토 목록 | 실패, 차단, timeout, 검토 필요 자료를 확인하고 검토 유형·권장 다음 절차에 따라 요약/공개/비공개 결정을 실행합니다 |
| 요약 실패 1건 재시도 | 검토 목록의 `요약 실패` 뱃지를 눌러 해당 자료만 다시 요약합니다 |
| 기사 운영 목록 | 전체 기사 상태, 공개 가능 여부, 요약 여부, 국가/기관 필터를 기준으로 운영 자료를 찾고 명시 선택 자료를 일괄 검토 처리합니다 |
| 수집 후보 URL | 공식 404, fallback 후보, 재수집 후보처럼 아직 기사로 확정되지 않은 URL을 추적하고 재시도/무시 상태를 관리합니다 |
| 이용 통계 | 접속 로그, 일별·월별 집계, 인기 자료, 검색어 순위, 검색 결과 0건, 태그 클릭, 국가/기관별 조회, 수집 성공률, 요약 모델별 성공·실패를 확인합니다 |
| 감사 로그 | `site_events`의 관리자 작업 이벤트를 읽기 전용으로 조회하고 action, path, 대상 자료/source, LLM provider/model, 결과/오류를 확인합니다 |
| LLM 관리 | 서버 secret을 화면에 노출하지 않고 요약 provider/model과 DB 저장 key 상태를 확인·저장합니다 |

`요약 실패` 뱃지 재시도가 성공하면 해당 자료는 즉시 검토 목록에서 사라집니다. 실패하면 같은 줄에 실패 메시지가 표시됩니다.

관리자 v2 P0 안전장치는 source별 요약 범위를 고정하고, 관리자 변이 API 입력을 zod schema로 검증하며, 감사 metadata 저장 전에 secret/token/password/query 값을 redaction합니다. 상세 요약 수정은 `summary_json`, `korean_title`, 태그와 검토 이력 같은 요약 산출물만 허용하고, `raw_text`, `cleaned_text`, 원문 URL, content hash 같은 원문 스냅샷 필드는 직접 수정할 수 없습니다.

자체 이용 통계는 `site_events`에 저장하고 관리자 감사 기록은 별도 `admin_audit_logs`에도 분리해 보존합니다. 이용 통계에는 원시 IP와 전체 User-Agent를 저장하지 않으며, IP 파생 식별자는 KST 날짜마다 바뀌고 위치는 국가 수준으로만 보존합니다. Accept-Language는 첫 번째 언어 코드만 저장하고 이메일·전화번호·URL 같은 민감정보가 포함된 검색어는 마스킹합니다. `site_events` 보관기간은 기본 90일이며 일일 작업에서 만료 자료를 정리합니다. 쿠키 기반 사용자 식별자는 저장하지 않습니다.

기존 관리자 v2의 `/admin/operations`와 `/admin/jobs` 화면은 관리자 전면 전환과 함께 폐기했습니다. 새 `/admin` 운영 개요와 `/admin/work` 통합 업무 큐가 수집·요약·검토·공개·실패 복구 흐름을 일관되게 제공합니다. 기존 `admin_jobs` 데이터와 API는 전환 기간의 호환 작업을 안전하게 처리하기 위해 백엔드에만 유지되며 별도 구형 화면으로 노출되지 않습니다.

배포 전 `pnpm admin:readiness`로 dashboard, audit, lifecycle, publication, queue 객체에 대한 운영 DB 접근 상태를 확인합니다.

관리자 v2 운영 연결성도 보강되어 대시보드와 운영 홈의 수집원·URL 후보·실행 기록·감사 로그 링크가 다음 조치 화면으로 이어집니다. CSP Report-Only 위반은 `/api/security/csp-report`에서 수집하고 `site_events`의 `security_event`로 보존합니다. 해당 endpoint는 16KB 초과 요청을 거부하고 `RATE_LIMIT_CSP_REPORT_MAX`, `RATE_LIMIT_CSP_REPORT_WINDOW_MS`로 별도 rate limit을 조정할 수 있습니다.

공개 조회 API, 이용 통계 이벤트 수집 endpoint, 관리자 로그인에는 IP 또는 fallback 접속 식별자 기준의 메모리 rate limit이 적용됩니다. Vercel 같은 서버리스 환경에서는 인스턴스별로 동작하므로 강한 전역 차단이 필요해지면 현재 저장되는 `site_events.client_ip_hash` 기준으로 DB/Redis 기반 차단 정책을 추가하면 됩니다.

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
| `GET` | `/api/admin/articles` | 관리자 기사 운영 목록 |
| `POST` | `/api/admin/articles/bulk` | 명시 선택 기사 일괄 검토 처리 |
| `GET` | `/api/admin/candidates` | 관리자 수집 후보 URL 목록 |
| `POST/PATCH` | `/api/admin/candidates` | 수집 후보 URL 상태 변경 |
| `POST` | `/api/admin/ingest` | 관리자 수동 수집 요청을 작업 큐에 등록 |
| `POST` | `/api/admin/review` | 관리자 검토 결정 |
| `POST` | `/api/admin/jobs/run` | 관리자 작업 큐 수동 worker 실행 |
| `POST` | `/api/admin/jobs/[jobId]` | 관리자 작업 취소 또는 재시도 |
| `GET` | `/api/admin/cron/ingest` | legacy/direct cron 수집 endpoint |
| `GET` | `/api/admin/cron/jobs` | 관리자 작업 큐 production drain endpoint |

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

정상 queue 환경에서 `POST /api/admin/ingest`는 기본적으로 HTTP `202`와 `mode: "queued"`를 반환합니다. 응답의 작업 상태는 `/admin/work?type=execution`에서 확인할 수 있습니다. queue migration이 적용되지 않은 production에서는 장시간 inline 실행으로 fallback하지 않고 명확한 오류를 반환합니다.

`GET /api/admin/cron/ingest`는 기존 공식 사이트 직접 수집용 legacy/direct cron endpoint입니다. 관리자 화면에서 생성된 queued job 처리는 `GET /api/admin/cron/jobs`와 `.github/workflows/admin-job-worker.yml`이 담당하며, 두 endpoint 모두 secret header만 허용하고 URL `?secret=` 방식은 허용하지 않습니다.

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
  Crawlee/API 기반 독일/프랑스/스페인 spider

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
- Gemini 모델 전환 또는 모델 endpoint 미지원
- Gemini 라우터 cooldown 또는 분당 제한 상태
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

대부분 AI quota 또는 cooldown 때문에 생깁니다. 정기 workflow는 짧은 cooldown을 자동 재시도하고, 해소되지 않은 보류가 남으면 성공으로 처리하지 않습니다. 이후에도 남은 건은 관리자 검토 목록에서 재시도할 수 있습니다.

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
