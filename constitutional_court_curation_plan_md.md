# 세계 헌법재판 뉴스·판례 큐레이션 플랫폼 구축 계획서

## 1. 프로젝트 개요

세계 각국 헌법재판기관의 공식 홈페이지에서 최신 뉴스, 보도자료, 판례·결정을 자동 수집하고, AI 기반 한국어 번역·요약·태깅을 거쳐 한 페이지에서 탐색할 수 있는 큐레이션 플랫폼을 구축한다.

초기 버전은 다음 3개 공식 소스를 대상으로 한다.

1. 독일 연방헌법재판소  
   - https://www.bundesverfassungsgericht.de
2. 미국 연방대법원  
   - https://www.supremecourt.gov
3. 프랑스 헌법위원회  
   - https://www.conseil-constitutionnel.fr

핵심 흐름은 다음과 같다.

```text
소스 사이트 수집
  ↓
본문 추출·정제
  ↓
중복 제거
  ↓
LLM 번역·요약·구조화
  ↓
엔티티 태그·카테고리 분류
  ↓
PostgreSQL/Supabase 저장
  ↓
검색 인덱스·태그 카운트·벡터 임베딩 갱신
  ↓
Next.js SSR/SSG 웹앱에서 제공
```

---

## 2. 제품 목표

### 2.1 사용자 가치

- 여러 국가 헌법재판기관의 최신 소식과 판례를 한 화면에서 확인한다.
- 외국어 원문을 읽지 않아도 한국어 제목, 핵심 요약, 배경, 시사점을 빠르게 파악한다.
- 국가, 기관, 사건 유형, 조문, 권리, 쟁점, 태그 기준으로 탐색한다.
- `latest`, `today`, `week`, `month` 필터로 최신 흐름을 확인한다.
- 특정 키워드, 조문, 기관, 사건명, 인물, 주제를 통합 검색한다.

### 2.2 운영 목표

- 신규 게시물을 자동 수집한다.
- AI 요약이 완료되면 기사 상세, 태그 허브, 관련 기사 목록, 검색 인덱스를 자동 갱신한다.
- 초기 3개 소스로 시작하되, 이후 다른 국가 헌법재판기관을 플러그인 방식으로 확장할 수 있게 설계한다.
- SEO 친화적인 상세 페이지, 태그 페이지, 용어사전 페이지를 생성한다.

---

## 3. 핵심 기능 범위

## 3.1 홈 화면

홈은 카드형 목록 중심으로 구성한다.

각 카드는 다음 정보를 포함한다.

- 국가
- 기관명
- 콘텐츠 유형
  - 뉴스
  - 보도자료
  - 판례·결정
  - 명령·절차 관련 문서
- 원문 발행일
- 한국어 제목
- 한 줄 요약
- 주요 태그 3~5개
- 원문 언어
- 요약 상태
- 원문 링크

카드 클릭 시 기사 상세 페이지로 이동한다.

## 3.2 상세 페이지

각 기사·판례 상세 페이지는 SEO 친화적인 정적 또는 서버 렌더링 페이지로 제공한다.

상세 페이지의 AI 요약 구조는 다음 스키마를 따른다.

```json
{
  "koreanTitle": "string",
  "originalTitle": "string",
  "summary": {
    "coreSummary": ["string"],
    "referencedProvisions": [
      {
        "jurisdiction": "string",
        "lawName": "string",
        "article": "string",
        "description": "string",
        "confidence": "high | medium | low"
      }
    ],
    "background": "string",
    "caseStructure": "string",
    "implications": "string",
    "practicalNotes": "string"
  },
  "entities": [
    {
      "name": "string",
      "type": "court | country | law | article | right | party | institution | topic | doctrine",
      "normalizedName": "string"
    }
  ],
  "tags": ["string"],
  "categories": ["string"],
  "riskFlags": [
    "translation_uncertain",
    "source_text_incomplete",
    "provision_reference_uncertain"
  ]
}
```

상세 페이지에는 다음 섹션을 표시한다.

1. 원문 메타데이터
2. 한국어 제목 및 요약
3. 핵심 요약
4. 참조 조문
5. 배경
6. 사건·논증 구조
7. 시사점
8. 실무상 참고 포인트
9. 관련 태그
10. 관련 기사·결정
11. 원문 링크 및 보존된 원문 스냅샷

## 3.3 태그 허브

AI 파이프라인에서 추출된 엔티티 태그를 기준으로 자동 생성한다.

태그 페이지는 다음 정보를 포함한다.

- 태그명
- 태그 유형
  - 국가
  - 기관
  - 권리
  - 조문
  - 법률명
  - 쟁점
  - 절차
  - 사건 유형
  - 헌법 원칙
- 누적 기사 수
- 최근 업데이트 일시
- 관련 기사 목록
- 관련 태그
- 태그 설명 또는 용어사전 연결

노출 순서는 기본적으로 태그별 기사 수와 최신 업데이트 시점을 함께 반영한다.

## 3.4 검색

초기 검색은 PostgreSQL 기반으로 구현한다.

검색 대상 필드:

- 한국어 제목
- 원문 제목
- 한국어 요약
- 원문 본문
- 태그
- 국가
- 기관
- 조문
- 사건번호
- 원문 URL

검색 방식:

1. PostgreSQL full-text search
2. trigram 유사 검색
3. pgvector 기반 의미 검색
4. 필터 검색
   - latest
   - today
   - week
   - month
   - 국가
   - 기관
   - 콘텐츠 유형
   - 태그
   - 언어

향후 필요 시 Meilisearch, Typesense, Algolia 중 하나를 추가한다.

---

## 4. 기술 스택

## 4.1 프론트엔드

- Next.js App Router
- React Server Components
- TypeScript
- Tailwind CSS
- shadcn/ui 스타일의 컴포넌트 구조
- 서버 렌더링과 클라이언트 상호작용 혼합

렌더링 전략:

- 홈: SSR 또는 ISR
- 상세 페이지: SSG/ISR
- 태그 페이지: SSG/ISR
- 검색 결과: SSR + 클라이언트 필터
- 관리자·수집 상태 페이지: CSR 또는 보호된 SSR

## 4.2 백엔드

선택지 1: Next.js API Routes / Route Handlers 중심

- `/api/articles`
- `/api/articles/[slug]`
- `/api/tags`
- `/api/tags/[slug]`
- `/api/search`
- `/api/sources`
- `/api/admin/ingestion-runs`

선택지 2: 별도 Worker/API 서버

- Next.js는 웹 렌더링 담당
- 수집·요약·임베딩은 별도 Node.js 워커 또는 Python 워커 담당

초기 MVP는 Next.js + 별도 worker script 조합을 권장한다.

## 4.3 데이터베이스

- PostgreSQL
- Supabase
- pgvector
- `tsvector` full-text index
- `pg_trgm` trigram index

## 4.4 크롤링·수집

- RSS parser
- HTTP fetch
- Cheerio
- Readability 계열 본문 추출
- Playwright fallback
- URL canonicalization
- title/hash 기반 dedup
- cron 또는 GitHub Actions
- 장기적으로 queue worker 도입

## 4.5 AI 파이프라인

LLM 제공자는 교체 가능하도록 추상화한다.

지원 후보:

- OpenAI
- Anthropic
- Gemini
- OpenRouter
- 자체 라우터

처리 단계:

```text
raw article
  ↓
본문 정제
  ↓
언어 감지
  ↓
LLM 번역·요약·태깅
  ↓
JSON schema validation
  ↓
임베딩 생성
  ↓
DB 저장
  ↓
태그 카운트 갱신
  ↓
검색 인덱스 갱신
```

---

## 5. 초기 소스 설계

## 5.1 공통 Source Adapter 인터페이스

각 소스는 같은 인터페이스를 구현한다.

```ts
export interface SourceAdapter {
  sourceKey: string;
  displayName: string;
  jurisdiction: string;
  baseUrl: string;

  discover(): Promise<DiscoveredItem[]>;
  fetchItem(item: DiscoveredItem): Promise<RawArticle>;
  normalize(raw: RawArticle): Promise<NormalizedArticle>;
}
```

## 5.2 독일 연방헌법재판소

대상 콘텐츠:

- 최신 보도자료
- 공개 결정
- 영어 번역 결정은 보조 데이터로 활용

수집 전략:

1. 공식 사이트의 결정·보도자료 목록 페이지 확인
2. RSS 또는 구조화된 목록이 있으면 우선 사용
3. 목록 HTML 파싱
4. 상세 페이지 본문 추출
5. 독일어 원문 기준으로 한국어 요약 생성
6. 영어 번역본이 존재하면 참고 자료로 함께 저장

주의사항:

- 독일어 원문과 영어 번역본이 서로 다른 URL에 있을 수 있다.
- 판례번호, 결정일, 재판부, 사건 유형을 구조화해야 한다.

## 5.3 미국 연방대법원

대상 콘텐츠:

- Opinions of the Court
- Orders of the Court
- Press Releases
- 헌법 관련 사건만 선별

수집 전략:

1. 의견·명령·보도자료 페이지에서 신규 항목 탐색
2. PDF가 많으므로 PDF 텍스트 추출 파이프라인 필요
3. 원문 본문에서 헌법 관련성 필터 적용
4. 헌법 관련성이 높은 경우에만 요약 파이프라인 실행

헌법 관련성 필터 예시:

- U.S. Constitution
- First Amendment
- Second Amendment
- Fourth Amendment
- Fifth Amendment
- Fourteenth Amendment
- Due Process
- Equal Protection
- Free Speech
- Establishment Clause
- Separation of Powers
- Federalism

주의사항:

- 모든 Supreme Court 판례가 헌법 사건은 아니다.
- 초기에는 키워드 기반 필터 + LLM 분류를 함께 사용한다.
- PDF 원문은 텍스트 추출 실패 가능성이 있으므로 fallback 처리한다.

## 5.4 프랑스 헌법위원회

대상 콘텐츠:

- Décisions
- QPC 결정
- Communiqués de presse
- QPC360 관련 최신 결정

수집 전략:

1. 결정 목록, 보도자료 목록, QPC 관련 페이지를 분리 수집
2. RSS가 확인되는 경우 RSS 우선 사용
3. HTML 목록 파싱 fallback
4. 프랑스어 원문 기준으로 한국어 요약 생성
5. 결정번호, 결정일, 사건 유형, 관련 법률·조문을 구조화

주의사항:

- `conseil-constitutionnel.fr`와 `qpc360.conseil-constitutionnel.fr`의 콘텐츠가 분리되어 있을 수 있다.
- QPC 결정은 별도 카테고리로 관리하는 것이 좋다.

---

## 6. 데이터 모델 초안

## 6.1 sources

```sql
create table sources (
  id uuid primary key default gen_random_uuid(),
  source_key text unique not null,
  name text not null,
  jurisdiction text not null,
  base_url text not null,
  language text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

## 6.2 articles

```sql
create table articles (
  id uuid primary key default gen_random_uuid(),
  source_id uuid references sources(id),
  source_key text not null,
  jurisdiction text not null,
  institution_name text not null,
  content_type text not null,
  original_url text not null,
  canonical_url text not null,
  original_language text not null,
  original_title text,
  korean_title text,
  original_published_at timestamptz,
  discovered_at timestamptz not null default now(),
  fetched_at timestamptz,
  summarized_at timestamptz,
  status text not null default 'discovered',
  slug text unique not null,
  raw_text text,
  cleaned_text text,
  summary_json jsonb,
  search_vector tsvector,
  embedding vector(1536),
  content_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

권장 status:

- `discovered`
- `fetched`
- `cleaned`
- `summarizing`
- `summarized`
- `failed_fetch`
- `failed_summary`
- `needs_review`

## 6.3 tags

```sql
create table tags (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  name text not null,
  normalized_name text not null,
  type text not null,
  description text,
  article_count integer not null default 0,
  latest_article_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

## 6.4 article_tags

```sql
create table article_tags (
  article_id uuid references articles(id) on delete cascade,
  tag_id uuid references tags(id) on delete cascade,
  confidence numeric,
  created_at timestamptz not null default now(),
  primary key (article_id, tag_id)
);
```

## 6.5 ingestion_runs

```sql
create table ingestion_runs (
  id uuid primary key default gen_random_uuid(),
  source_key text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null,
  discovered_count integer not null default 0,
  fetched_count integer not null default 0,
  summarized_count integer not null default 0,
  failed_count integer not null default 0,
  error_message text,
  metadata jsonb
);
```

## 6.6 glossary_terms

```sql
create table glossary_terms (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  term text not null,
  korean_term text,
  definition text,
  jurisdiction text,
  related_tags text[],
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

---

## 7. API 설계 초안

## 7.1 기사 목록

```http
GET /api/articles?range=latest&source=de-bverfg&type=decision&tag=federalism&q=...
```

응답:

```json
{
  "items": [],
  "pageInfo": {
    "page": 1,
    "pageSize": 20,
    "total": 240
  }
}
```

## 7.2 기사 상세

```http
GET /api/articles/:slug
```

## 7.3 검색

```http
GET /api/search?q=equal protection&range=month&jurisdiction=us
```

## 7.4 태그 목록

```http
GET /api/tags?type=right&sort=count
```

## 7.5 태그 상세

```http
GET /api/tags/:slug
```

## 7.6 수집 실행

```http
POST /api/admin/ingest
```

관리자 인증이 필요하다.

---

## 8. 페이지 구조

```text
/
/articles/[slug]
/tags
/tags/[slug]
/search
/sources
/sources/[sourceKey]
/glossary
/glossary/[slug]
/admin
/admin/ingestion-runs
```

## 8.1 홈

- 상단 검색창
- 기간 필터
  - latest
  - today
  - week
  - month
- 소스 필터
- 국가 필터
- 콘텐츠 유형 필터
- 카드형 기사 목록

## 8.2 기사 상세

- SEO title
- canonical URL
- Open Graph metadata
- 구조화된 Article schema
- AI 요약 스키마 기반 본문
- 관련 태그
- 관련 기사

## 8.3 태그 페이지

- 태그 그룹별 목록
- 기사 수 기준 정렬
- 최근 업데이트 기준 정렬
- 태그별 허브 링크

## 8.4 용어사전

- 헌법 원칙
- 권리명
- 절차 용어
- 국가별 제도 용어
- 조문·법률명

---

## 9. LLM 프롬프트 설계 초안

## 9.1 요약 프롬프트 목적

LLM은 원문을 한국어 독자가 이해할 수 있도록 재구성하되, 원문에 없는 내용을 확정적으로 만들어내지 않아야 한다.

## 9.2 출력 요구사항

- 반드시 JSON으로 출력한다.
- 원문에서 확인되지 않는 참조 조문은 `confidence: low`로 표시한다.
- 판례번호, 결정일, 기관명, 국가명은 원문 기준으로 보존한다.
- 한국 법률 용어와 비교가 필요할 때는 “유사하게 이해할 수 있음” 정도로 제한한다.
- 실무 조언은 법률 자문이 아니라 참고용 시사점으로 작성한다.

## 9.3 시스템 메시지 초안

```text
You are a legal news summarization assistant for Korean readers.
Summarize official constitutional court news and decisions.
Do not invent legal provisions, holdings, or procedural facts.
Return only valid JSON matching the schema.
When uncertain, mark confidence as low.
```

## 9.4 사용자 메시지 구성

```text
Source jurisdiction: {{jurisdiction}}
Institution: {{institution}}
Content type: {{contentType}}
Original language: {{language}}
Original URL: {{url}}
Original title: {{title}}
Published date: {{publishedAt}}

Cleaned source text:
{{cleanedText}}

Required output:
- Korean title rewrite
- Core summary
- Referenced provisions
- Background
- Case structure
- Implications
- Practical notes
- Entity tags
- Categories
```

---

## 10. 수집·요약 워커 설계

## 10.1 수집 주기

MVP 권장:

- 매 6시간: 소스 목록 탐색
- 매 1시간: 실패 건 재시도
- 매일 1회: 태그 카운트 재계산
- 매일 1회: 오래된 draft/failed 상태 점검

## 10.2 워커 단계

```text
1. create ingestion_run
2. run source.discover()
3. normalize discovered URLs
4. check duplicates
5. insert discovered articles
6. fetch original pages/PDFs
7. extract and clean text
8. run LLM summary
9. validate JSON schema
10. create embedding
11. upsert tags
12. update article_tags
13. update search_vector
14. close ingestion_run
```

## 10.3 실패 처리

- fetch 실패: 3회 재시도 후 `failed_fetch`
- PDF 추출 실패: Playwright 또는 OCR 검토 상태로 전환
- LLM JSON 오류: repair prompt 1회 시도
- 참조 조문 불확실: `needs_review` 또는 confidence low
- 원문 너무 김: chunking 후 map-reduce 요약

---

## 11. 중복 제거 전략

중복 판단 기준:

1. canonical URL
2. normalized URL
3. 원문 제목 + 발행일 hash
4. 본문 앞부분 hash
5. 사건번호 또는 결정번호

중복 후보가 있으면 새 레코드 생성 대신 기존 레코드에 `source_metadata`만 업데이트한다.

---

## 12. SEO 전략

## 12.1 기사 상세 페이지

- `/articles/[slug]`
- 서버에서 메타데이터 생성
- title: `{{koreanTitle}} | 세계 헌법재판 큐레이션`
- description: 핵심 요약 첫 문장
- canonical URL 설정
- Article JSON-LD 적용

## 12.2 태그 페이지

- `/tags/[slug]`
- title: `{{tagName}} 관련 헌법재판 뉴스·판례`
- description: 태그 설명 + 누적 기사 수
- 관련 기사 목록 SSR/ISR 렌더링

## 12.3 용어사전 페이지

- `/glossary/[slug]`
- 헌법 용어, 권리, 원칙, 절차 설명 페이지 생성
- 관련 기사와 태그 연결

---

## 13. UI 방향

## 13.1 디자인 톤

- 법률 정보 서비스에 맞는 신뢰감 있는 미니멀 스타일
- 카드 기반 레이아웃
- 국가·기관·유형 배지를 명확히 표시
- 긴 요약은 접기/펼치기
- 태그는 작은 pill 형태로 노출

## 13.2 주요 컴포넌트

- `ArticleCard`
- `ArticleGrid`
- `FilterBar`
- `SearchBox`
- `TimeRangeTabs`
- `SourceBadge`
- `JurisdictionBadge`
- `TagPill`
- `SummarySection`
- `ReferencedProvisionList`
- `RelatedArticles`
- `TagHubList`
- `IngestionStatusPanel`

## 13.3 홈 카드 예시

```text
[Germany] [Federal Constitutional Court] [Decision]

독일 연방헌법재판소, ○○ 사안에 대한 헌법적 판단 제시

핵심: 재판소는 ...에 대해 ...라고 판단했다.

#표현의자유 #비례원칙 #독일기본법

2026-05-07 · 원문 보기
```

---

## 14. 보안·품질·컴플라이언스 고려사항

## 14.1 법률 정보 고지

모든 AI 요약 하단에 다음 고지를 표시한다.

```text
이 요약은 AI 언어 모델을 사용해 생성된 참고용 정보입니다. 정확한 법적 판단이나 인용을 위해서는 반드시 원문과 공식 자료를 확인해야 합니다.
```

## 14.2 원문 보존

- 원문 URL 저장
- 원문 제목 저장
- 원문 발행일 저장
- 원문 텍스트 저장
- 가능하면 원문 HTML 일부 또는 추출 텍스트 스냅샷 저장

## 14.3 Hallucination 방지

- LLM 출력 JSON schema validation
- 참조 조문 confidence 필드 적용
- 원문에 없는 내용은 `확인 필요` 또는 `low confidence` 표시
- 관리자 검수 플래그 제공

## 14.4 크롤링 예의

- robots.txt 확인
- User-Agent 명시
- 과도한 요청 방지
- 소스별 rate limit 설정
- 공식 RSS/API 우선 사용

---

## 15. 배포 구조

## 15.1 Vercel

- Next.js 웹앱 배포
- ISR 사용
- Route Handler API 제공
- Cron Jobs 또는 외부 스케줄러 연동

## 15.2 Supabase

- PostgreSQL
- pgvector
- 인증
- Storage 선택적 사용
- Edge Functions 선택적 사용

## 15.3 Worker 실행 옵션

초기 권장:

- GitHub Actions cron으로 `pnpm ingest` 실행
- 또는 Vercel Cron으로 `/api/admin/cron/ingest` 호출

확장 후:

- 별도 queue worker
- BullMQ + Redis
- Cloud Run/Fly.io/Render worker
- Supabase Edge Function 일부 활용

---

## 16. MVP 개발 단계

## Phase 0. 프로젝트 세팅

목표:

- Next.js 프로젝트 생성
- Tailwind CSS 구성
- Supabase 연결
- 기본 DB schema migration
- 환경변수 구성

산출물:

- 실행 가능한 웹앱 skeleton
- DB 연결 확인
- 기본 홈 페이지

## Phase 1. 데이터 모델·목업 UI

목표:

- ArticleCard 기반 홈 UI
- Article 상세 페이지
- Tag 페이지 기본 구조
- mock 데이터 기반 렌더링

산출물:

- 카드형 홈
- 상세 페이지 템플릿
- 태그 허브 템플릿

## Phase 2. 수집 파이프라인 MVP

목표:

- SourceAdapter 구조 구현
- 3개 소스의 discover/fetch/normalize 구현
- URL dedup
- raw article 저장

산출물:

- `pnpm ingest` 명령
- `ingestion_runs` 기록
- DB에 raw article 저장

## Phase 3. AI 요약·태깅

목표:

- LLM client abstraction
- JSON schema validation
- 한국어 제목·요약·참조 조문·태그 생성
- summary_json 저장
- tags/article_tags 갱신

산출물:

- AI 요약이 포함된 상세 페이지
- 자동 태그 생성

## Phase 4. 검색·필터

목표:

- latest/today/week/month 필터
- full-text search
- trigram 검색
- pgvector 의미 검색 기초

산출물:

- `/search`
- 홈 필터
- 태그별 기사 목록

## Phase 5. SEO·ISR·배포

목표:

- metadata generation
- Article JSON-LD
- tag page SEO
- sitemap.xml
- robots.txt
- Vercel 배포
- Supabase production 연결

산출물:

- 공개 가능한 MVP

## Phase 6. 운영 도구

목표:

- 관리자 수집 상태 페이지
- 실패 항목 재시도
- 요약 검수 플래그
- 소스별 on/off 설정

산출물:

- 운영 가능한 베타 버전

---

## 17. 추천 폴더 구조

```text
app/
  page.tsx
  articles/
    [slug]/page.tsx
  tags/
    page.tsx
    [slug]/page.tsx
  search/page.tsx
  glossary/
    page.tsx
    [slug]/page.tsx
  api/
    articles/route.ts
    search/route.ts
    tags/route.ts
    admin/
      ingest/route.ts
components/
  article-card.tsx
  article-grid.tsx
  filter-bar.tsx
  search-box.tsx
  tag-pill.tsx
  summary-section.tsx
  referenced-provision-list.tsx
lib/
  db/
    client.ts
    queries.ts
  sources/
    types.ts
    bundesverfassungsgericht.ts
    supremecourt.ts
    conseilconstitutionnel.ts
  ingest/
    discover.ts
    fetch.ts
    normalize.ts
    dedup.ts
    run.ts
  ai/
    client.ts
    summarize.ts
    schema.ts
    embeddings.ts
  search/
    fulltext.ts
    vector.ts
  seo/
    metadata.ts
scripts/
  ingest.ts
  summarize-pending.ts
supabase/
  migrations/
```

---

## 18. 환경변수 초안

```bash
DATABASE_URL=
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
GEMINI_API_KEY=
LLM_PROVIDER=openai
EMBEDDING_PROVIDER=openai
CRON_SECRET=
APP_BASE_URL=
```

---

## 19. 주요 리스크와 대응

## 19.1 소스 사이트 구조 변경

대응:

- SourceAdapter 단위 테스트
- HTML selector fallback
- RSS/API 우선 사용
- 수집 실패 알림

## 19.2 PDF 텍스트 추출 실패

대응:

- PDF parser 1차
- Playwright 다운로드 fallback
- 추출 실패 시 needs_review
- OCR은 최후 수단

## 19.3 LLM 환각

대응:

- 원문 기반 프롬프트
- JSON schema validation
- confidence 필드
- 참조 조문 검증 로직
- 원문 링크 상시 노출

## 19.4 번역 품질

대응:

- 법률 용어 glossary 구축
- 국가별 용어 매핑
- 반복 출현 태그·용어 normalization

## 19.5 비용 증가

대응:

- 신규 콘텐츠만 요약
- 긴 문서는 chunking
- 캐싱
- 저비용 모델과 고성능 모델 라우팅
- 요약 실패 건만 재처리

---

## 20. 코딩 에이전트 전달 전 필요한 결정 사항

다음 프롬프트 작성 전에 확정하면 좋은 사항이다.

1. LLM 기본 제공자
   - OpenAI 우선 여부
2. MVP 배포 범위
   - 공개 사이트인지 내부 베타인지
3. 수집 주기
   - 1시간, 6시간, 12시간, 1일 중 선택
4. 관리자 페이지 포함 여부
5. pgvector 의미 검색을 MVP에 포함할지, Phase 2로 미룰지
6. 미국 연방대법원의 “헌법 관련” 필터 기준
   - 키워드 기반 우선인지, LLM 분류 기반 우선인지
7. 원문 전체 저장 여부
   - DB 저장
   - Supabase Storage 저장
   - URL·추출 텍스트만 저장

---

## 21. MVP 기준 완료 정의

MVP는 다음 조건을 만족하면 완료로 본다.

- 3개 공식 소스에서 신규 항목을 자동 탐색한다.
- 중복 URL을 제거한다.
- 원문 텍스트를 추출해 DB에 저장한다.
- LLM이 한국어 제목, 핵심 요약, 참조 조문, 배경, 구조, 시사점, 태그를 JSON으로 생성한다.
- 홈에서 카드형 목록을 볼 수 있다.
- 카드를 클릭하면 상세 페이지가 열린다.
- 태그 페이지에서 태그별 기사 수와 관련 목록을 볼 수 있다.
- latest/today/week/month 필터가 동작한다.
- 기본 검색이 동작한다.
- Vercel에 배포된다.
- Supabase PostgreSQL과 연결된다.
- AI 요약 참고용 고지가 표시된다.

---

## 22. 다음 단계

이 계획서를 바탕으로 다음 문서를 작성한다.

1. 코딩 에이전트용 구현 프롬프트
2. DB migration SQL
3. Next.js 프로젝트 초기 scaffold 지시서
4. SourceAdapter별 수집 구현 지시서
5. LLM JSON schema 및 프롬프트 명세
6. UI 컴포넌트 구현 지시서

