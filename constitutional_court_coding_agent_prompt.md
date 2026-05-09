# 구현 요청 프롬프트: 세계 헌법재판 뉴스·판례 큐레이션 플랫폼

너는 시니어 풀스택 엔지니어이자 Next.js/Supabase/AI 파이프라인 구현 전문가다.

다음 요구사항에 따라 “세계 각국 헌법재판소·헌법재판기관의 최신 뉴스와 최신 판례/결정을 자동 수집하고, AI 기반 한국어 번역·요약·태깅 후 카드형 UI로 제공하는 큐레이션 플랫폼”을 구현해줘.

---

## 1. 프로젝트 목표

세계 각국의 헌법재판기관 공식 홈페이지에서 최신 뉴스, 보도자료, 판례, 결정을 자동 수집한다.

초기 소스는 다음 3개다.

1. 독일 연방헌법재판소  
   - https://www.bundesverfassungsgericht.de

2. 미국 연방대법원  
   - https://www.supremecourt.gov  
   - 단, 헌법 관련 뉴스·판례·결정 위주로 필터링

3. 프랑스 헌법위원회  
   - https://www.conseil-constitutionnel.fr

수집된 콘텐츠는 다음 파이프라인을 거친다.

```text
뉴스/판례 수집
  ↓
본문 추출 및 정제
  ↓
중복 제거
  ↓
LLM 기반 한국어 제목 재작성
  ↓
LLM 기반 한국어 요약
  ↓
참조 조문, 배경, 사건 구조, 시사점 추출
  ↓
엔티티 태그 자동 분류
  ↓
PostgreSQL/Supabase 저장
  ↓
pgvector 임베딩 저장
  ↓
검색 인덱스 및 태그 카운트 갱신
  ↓
Next.js UI에서 제공
```

---

## 2. 기술 스택

필수 스택:

- Next.js App Router
- TypeScript
- Tailwind CSS
- shadcn/ui 스타일의 유틸리티 기반 UI
- PostgreSQL / Supabase
- pgvector
- PostgreSQL full-text search
- pg_trgm
- Playwright
- Cheerio 또는 Readability 계열 본문 추출
- RSS parser
- LLM API 추상화
  - OpenAI 우선
  - 추후 Anthropic, Gemini, OpenRouter 등으로 교체 가능하게 설계
- Vercel 배포를 전제로 구현

렌더링 전략:

- 홈: SSR 또는 ISR
- 기사 상세: SSG/ISR
- 태그 페이지: SSG/ISR
- 검색 페이지: SSR + 클라이언트 상호작용
- 관리자/수집 상태 페이지: 보호된 SSR 또는 CSR

---

## 3. 핵심 기능

### 3.1 홈 화면

홈은 카드형 레이아웃으로 구현한다.

각 카드에는 다음 정보를 표시한다.

- 국가
- 기관명
- 콘텐츠 유형
  - news
  - press_release
  - decision
  - opinion
  - order
- 원문 발행일
- 한국어 제목
- 한 줄 요약
- 주요 태그 3~5개
- 원문 언어
- 요약 상태
- 원문 링크
- 상세 페이지 링크

필터:

- latest
- today
- week
- month
- 국가
- 기관
- 콘텐츠 유형
- 태그

### 3.2 기사 상세 페이지

경로:

```text
/articles/[slug]
```

상세 페이지는 SEO 친화적으로 생성한다.

상세 페이지에는 다음 섹션을 포함한다.

1. 원문 메타데이터
2. 한국어 제목
3. 핵심 요약
4. 참조 조문
5. 배경
6. 사건·논증 구조
7. 시사점
8. 실무상 참고 포인트
9. 엔티티 태그
10. 관련 기사
11. 원문 링크
12. AI 요약 참고 고지

AI 요약 참고 고지는 반드시 표시한다.

```text
이 요약은 AI 언어 모델을 사용해 생성된 참고용 정보입니다. 정확한 법적 판단이나 인용을 위해서는 반드시 원문과 공식 자료를 확인해야 합니다.
```

### 3.3 태그 허브

경로:

```text
/tags
/tags/[slug]
```

AI 요약 파이프라인에서 추출한 엔티티 태그를 기준으로 자동 그룹화한다.

태그 페이지에는 다음 정보를 표시한다.

- 태그명
- 태그 유형
- 누적 기사 수
- 최근 업데이트 일시
- 관련 기사 목록
- 관련 태그

태그 노출 순서는 기본적으로 기사 수가 많은 순서이며, 최신 업데이트 일시도 함께 반영한다.

태그 유형 예시:

- country
- court
- law
- article
- right
- doctrine
- topic
- institution
- party
- procedure
- case_type

### 3.4 통합 검색

경로:

```text
/search
```

검색 대상:

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
2. pg_trgm 기반 유사 검색
3. pgvector 기반 의미 검색
4. 필터 검색

검색 필터:

- latest
- today
- week
- month
- 국가
- 기관
- 콘텐츠 유형
- 태그
- 언어

---

## 4. 데이터베이스 스키마

Supabase PostgreSQL migration을 작성해줘.

필수 extension:

```sql
create extension if not exists vector;
create extension if not exists pg_trgm;
```

### 4.1 sources

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

### 4.2 articles

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

status 값:

```text
discovered
fetched
cleaned
summarizing
summarized
failed_fetch
failed_summary
needs_review
```

### 4.3 tags

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

### 4.4 article_tags

```sql
create table article_tags (
  article_id uuid references articles(id) on delete cascade,
  tag_id uuid references tags(id) on delete cascade,
  confidence numeric,
  created_at timestamptz not null default now(),
  primary key (article_id, tag_id)
);
```

### 4.5 ingestion_runs

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

### 4.6 glossary_terms

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

인덱스도 함께 작성해줘.

필수 인덱스:

- articles.slug
- articles.source_key
- articles.jurisdiction
- articles.content_type
- articles.original_published_at
- articles.status
- articles.search_vector GIN
- articles.korean_title trigram
- articles.original_title trigram
- articles.embedding vector index
- tags.slug
- tags.type
- tags.article_count
- article_tags.article_id
- article_tags.tag_id

---

## 5. 추천 폴더 구조

다음 구조를 기준으로 구현해줘.

```text
app/
  page.tsx
  articles/
    [slug]/
      page.tsx
  tags/
    page.tsx
    [slug]/
      page.tsx
  search/
    page.tsx
  glossary/
    page.tsx
    [slug]/
      page.tsx
  sources/
    page.tsx
    [sourceKey]/
      page.tsx
  admin/
    page.tsx
    ingestion-runs/
      page.tsx
  api/
    articles/
      route.ts
      [slug]/
        route.ts
    search/
      route.ts
    tags/
      route.ts
      [slug]/
        route.ts
    admin/
      ingest/
        route.ts
      cron/
        ingest/
          route.ts

components/
  article-card.tsx
  article-grid.tsx
  filter-bar.tsx
  search-box.tsx
  time-range-tabs.tsx
  source-badge.tsx
  jurisdiction-badge.tsx
  tag-pill.tsx
  summary-section.tsx
  referenced-provision-list.tsx
  related-articles.tsx
  tag-hub-list.tsx
  ingestion-status-panel.tsx

lib/
  db/
    client.ts
    queries.ts
    types.ts
  sources/
    types.ts
    bundesverfassungsgericht.ts
    supremecourt.ts
    conseilconstitutionnel.ts
    index.ts
  ingest/
    discover.ts
    fetch.ts
    normalize.ts
    dedup.ts
    extract-text.ts
    run.ts
  ai/
    client.ts
    summarize.ts
    schema.ts
    embeddings.ts
    prompts.ts
  search/
    fulltext.ts
    vector.ts
    filters.ts
  seo/
    metadata.ts
    jsonld.ts
  utils/
    slug.ts
    hash.ts
    dates.ts
    canonical-url.ts

scripts/
  ingest.ts
  summarize-pending.ts
  refresh-tag-counts.ts

supabase/
  migrations/
```

---

## 6. SourceAdapter 설계

각 소스는 공통 인터페이스를 구현해야 한다.

```ts
export interface DiscoveredItem {
  sourceKey: string;
  url: string;
  canonicalUrl: string;
  title?: string;
  publishedAt?: string;
  contentType: ArticleContentType;
  metadata?: Record<string, unknown>;
}

export interface RawArticle {
  sourceKey: string;
  url: string;
  canonicalUrl: string;
  title?: string;
  publishedAt?: string;
  contentType: ArticleContentType;
  html?: string;
  text?: string;
  pdfBuffer?: Buffer;
  metadata?: Record<string, unknown>;
}

export interface NormalizedArticle {
  sourceKey: string;
  jurisdiction: string;
  institutionName: string;
  contentType: ArticleContentType;
  originalUrl: string;
  canonicalUrl: string;
  originalLanguage: string;
  originalTitle?: string;
  originalPublishedAt?: string;
  rawText?: string;
  cleanedText?: string;
  metadata?: Record<string, unknown>;
}

export interface SourceAdapter {
  sourceKey: string;
  displayName: string;
  jurisdiction: string;
  baseUrl: string;
  defaultLanguage: string;

  discover(): Promise<DiscoveredItem[]>;
  fetchItem(item: DiscoveredItem): Promise<RawArticle>;
  normalize(raw: RawArticle): Promise<NormalizedArticle>;
}
```

콘텐츠 타입:

```ts
export type ArticleContentType =
  | "news"
  | "press_release"
  | "decision"
  | "opinion"
  | "order"
  | "other";
```

초기 소스 어댑터:

```text
lib/sources/bundesverfassungsgericht.ts
lib/sources/supremecourt.ts
lib/sources/conseilconstitutionnel.ts
```

---

## 7. 소스별 수집 전략

### 7.1 독일 연방헌법재판소

대상:

- 보도자료
- 최신 결정
- 영어 번역 결정이 있으면 보조 정보로 저장

전략:

- 공식 사이트 목록 페이지를 우선 파싱
- RSS 또는 구조화된 endpoint가 발견되면 우선 사용
- 없으면 Cheerio 기반 HTML 목록 파싱
- 상세 페이지 본문 추출
- 독일어 원문 기준으로 한국어 요약 생성
- 사건번호, 결정일, 재판부, 사건 유형을 metadata에 저장

sourceKey:

```text
de-bverfg
```

jurisdiction:

```text
Germany
```

institutionName:

```text
Federal Constitutional Court of Germany
```

### 7.2 미국 연방대법원

대상:

- Opinions of the Court
- Orders of the Court
- Press Releases
- 헌법 관련 사건만 선별

전략:

- opinions, orders, press releases 페이지에서 신규 항목 탐색
- PDF 문서가 많으므로 PDF 텍스트 추출 구현
- 헌법 관련성 필터 적용
- 1차 키워드 필터
- 2차 LLM 분류 가능하도록 구조 마련

헌법 관련 키워드 예시:

```text
U.S. Constitution
First Amendment
Second Amendment
Fourth Amendment
Fifth Amendment
Fourteenth Amendment
Due Process
Equal Protection
Free Speech
Establishment Clause
Separation of Powers
Federalism
Commerce Clause
Takings Clause
```

sourceKey:

```text
us-scotus
```

jurisdiction:

```text
United States
```

institutionName:

```text
Supreme Court of the United States
```

주의:

- 모든 연방대법원 판례가 헌법 사건은 아니다.
- MVP에서는 키워드 필터 + LLM 분류 훅을 구현한다.
- 헌법 관련성이 낮으면 `needs_review` 또는 수집 제외 처리한다.

### 7.3 프랑스 헌법위원회

대상:

- Décisions
- QPC 결정
- Communiqués de presse

전략:

- 결정 목록, QPC, 보도자료 목록을 분리 수집
- RSS가 있으면 우선 사용
- 없으면 HTML 목록 파싱
- 프랑스어 원문 기준으로 한국어 요약 생성
- 결정번호, 결정일, 사건 유형, 관련 법률·조문을 metadata에 저장

sourceKey:

```text
fr-conseil-constitutionnel
```

jurisdiction:

```text
France
```

institutionName:

```text
Conseil constitutionnel
```

---

## 8. AI 요약 JSON 스키마

LLM 출력은 반드시 다음 스키마를 따른다.

Zod schema를 작성하고, LLM 응답을 validation 해줘.

```ts
export const SummarySchema = z.object({
  koreanTitle: z.string(),
  originalTitle: z.string().optional(),
  summary: z.object({
    coreSummary: z.array(z.string()),
    referencedProvisions: z.array(
      z.object({
        jurisdiction: z.string(),
        lawName: z.string(),
        article: z.string(),
        description: z.string(),
        confidence: z.enum(["high", "medium", "low"]),
      })
    ),
    background: z.string(),
    caseStructure: z.string(),
    implications: z.string(),
    practicalNotes: z.string(),
  }),
  entities: z.array(
    z.object({
      name: z.string(),
      type: z.enum([
        "court",
        "country",
        "law",
        "article",
        "right",
        "party",
        "institution",
        "topic",
        "doctrine",
        "procedure",
        "case_type",
      ]),
      normalizedName: z.string(),
    })
  ),
  tags: z.array(z.string()),
  categories: z.array(z.string()),
  riskFlags: z.array(
    z.enum([
      "translation_uncertain",
      "source_text_incomplete",
      "provision_reference_uncertain",
      "constitutional_relevance_uncertain",
    ])
  ),
});
```

---

## 9. LLM 프롬프트

다음 시스템 프롬프트를 사용해줘.

```text
You are a legal news summarization assistant for Korean readers.

You summarize official constitutional court news, constitutional decisions, court opinions, and related press releases.

Your task:
- Rewrite the title in natural Korean.
- Summarize the source accurately in Korean.
- Extract referenced legal provisions only when they are present or strongly supported by the source text.
- Explain the background, case/procedural structure, implications, and practical notes.
- Extract entity tags and categories.
- Do not invent legal provisions, holdings, facts, dates, parties, or procedural history.
- If uncertain, mark confidence as low or add an appropriate risk flag.
- Return only valid JSON matching the provided schema.
```

사용자 프롬프트 템플릿:

```text
Source jurisdiction: {{jurisdiction}}
Institution: {{institutionName}}
Content type: {{contentType}}
Original language: {{originalLanguage}}
Original URL: {{originalUrl}}
Original title: {{originalTitle}}
Published date: {{originalPublishedAt}}

Cleaned source text:
{{cleanedText}}

Required output:
Return valid JSON with:
- koreanTitle
- originalTitle
- summary.coreSummary
- summary.referencedProvisions
- summary.background
- summary.caseStructure
- summary.implications
- summary.practicalNotes
- entities
- tags
- categories
- riskFlags
```

JSON 파싱 실패 시 repair prompt를 1회 실행한다.

---

## 10. 임베딩

OpenAI embedding을 기본으로 구현하되 provider를 교체 가능하게 작성해줘.

대상 텍스트:

```text
koreanTitle
summary.coreSummary
summary.background
summary.implications
tags
entities
```

결과를 articles.embedding에 저장한다.

---

## 11. 수집 워커

다음 명령을 구현한다.

```bash
pnpm ingest
pnpm summarize-pending
pnpm refresh-tag-counts
```

### 11.1 ingest 동작

```text
1. ingestion_run 생성
2. active source 목록 조회
3. 각 SourceAdapter discover 실행
4. canonical URL 생성
5. URL/title/hash 기반 중복 제거
6. 신규 article row 생성
7. fetchItem 실행
8. 본문 추출 및 정제
9. articles 상태 fetched/cleaned로 갱신
10. ingestion_run 카운트 갱신
```

### 11.2 summarize-pending 동작

```text
1. status = cleaned 또는 failed_summary 재시도 대상 조회
2. LLM 요약 실행
3. SummarySchema validation
4. JSON repair 1회
5. embedding 생성
6. articles.summary_json 저장
7. articles.korean_title 저장
8. articles.status = summarized
9. tags upsert
10. article_tags upsert
11. search_vector 갱신
```

### 11.3 refresh-tag-counts 동작

```text
1. tags별 article_count 재계산
2. latest_article_at 갱신
3. orphan tag 정리 옵션 제공
```

---

## 12. API 구현

다음 API를 구현해줘.

### 기사 목록

```http
GET /api/articles
```

query params:

```text
q
range=latest|today|week|month
source
jurisdiction
type
tag
page
pageSize
```

### 기사 상세

```http
GET /api/articles/[slug]
```

### 검색

```http
GET /api/search
```

query params:

```text
q
range
source
jurisdiction
type
tag
page
pageSize
mode=fulltext|semantic|hybrid
```

### 태그 목록

```http
GET /api/tags
```

query params:

```text
type
sort=count|latest|name
```

### 태그 상세

```http
GET /api/tags/[slug]
```

### 수집 실행

```http
POST /api/admin/ingest
```

`CRON_SECRET` 또는 관리자 인증으로 보호해줘.

---

## 13. UI 구현

Tailwind CSS 기반으로 깔끔하고 신뢰감 있는 법률 정보 서비스 느낌으로 구현해줘.

필수 컴포넌트:

```text
ArticleCard
ArticleGrid
FilterBar
SearchBox
TimeRangeTabs
SourceBadge
JurisdictionBadge
TagPill
SummarySection
ReferencedProvisionList
RelatedArticles
TagHubList
IngestionStatusPanel
```

홈 카드 예시 레이아웃:

```text
[Germany] [Federal Constitutional Court] [Decision]

독일 연방헌법재판소, ○○ 사안에 대한 헌법적 판단 제시

핵심: 재판소는 ...에 대해 ...라고 판단했다.

#표현의자유 #비례원칙 #독일기본법

2026-05-07 · 원문 보기
```

---

## 14. SEO 구현

다음 항목을 구현해줘.

- `generateMetadata`
- canonical URL
- Open Graph metadata
- Article JSON-LD
- tag page metadata
- glossary page metadata
- sitemap.xml
- robots.txt

기사 상세 title:

```text
{{koreanTitle}} | 세계 헌법재판 큐레이션
```

태그 페이지 title:

```text
{{tagName}} 관련 헌법재판 뉴스·판례
```

---

## 15. 환경변수

`.env.example`을 작성해줘.

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
APP_BASE_URL=http://localhost:3000
```

---

## 16. 에러 처리 기준

다음 실패 상태를 명확히 처리해줘.

- fetch 실패
- PDF 추출 실패
- 본문이 너무 짧음
- LLM JSON 파싱 실패
- schema validation 실패
- embedding 생성 실패
- tag upsert 실패
- 중복 article 감지

상태값:

```text
failed_fetch
failed_summary
needs_review
```

에러 메시지는 `ingestion_runs.metadata` 또는 article-level metadata에 저장한다.

---

## 17. 중복 제거 기준

다음 순서로 중복 제거한다.

1. canonical_url
2. normalized URL
3. original_title + original_published_at hash
4. cleaned_text 앞부분 hash
5. 사건번호 또는 결정번호

중복이면 새 article을 만들지 말고 기존 row를 유지한다.

---

## 18. 관리자 페이지

간단한 관리자 페이지를 구현해줘.

경로:

```text
/admin
/admin/ingestion-runs
```

표시 항목:

- 최근 ingestion run
- source_key
- 시작 시각
- 종료 시각
- status
- discovered_count
- fetched_count
- summarized_count
- failed_count
- error_message

---

## 19. MVP 완료 조건

다음이 모두 동작해야 한다.

- Next.js 앱이 로컬에서 실행된다.
- Supabase/PostgreSQL migration이 제공된다.
- 3개 소스 어댑터 파일이 존재한다.
- 최소 1개 이상의 소스에서 실제 항목 discovery가 가능하다.
- `pnpm ingest` 명령이 실행된다.
- article raw/cleaned text가 DB에 저장된다.
- `pnpm summarize-pending` 명령이 실행된다.
- LLM 요약 JSON이 schema validation을 통과한다.
- 태그가 자동 생성되고 article_tags에 연결된다.
- 홈에서 카드형 article 목록이 보인다.
- 카드 클릭 시 상세 페이지가 열린다.
- 상세 페이지에 핵심 요약, 참조 조문, 배경, 구조, 시사점이 표시된다.
- latest/today/week/month 필터가 동작한다.
- 검색 페이지가 동작한다.
- 태그 페이지와 태그 상세 페이지가 동작한다.
- AI 요약 참고 고지가 표시된다.
- Vercel 배포 가능한 구조다.

---

## 20. 구현 순서

다음 순서대로 작업해줘.

### Step 1. 프로젝트 초기화

- Next.js App Router + TypeScript 프로젝트 구성
- Tailwind CSS 설정
- shadcn/ui 스타일의 기본 컴포넌트 준비
- `.env.example` 작성
- Supabase client 작성

### Step 2. DB migration

- schema 작성
- extension 작성
- index 작성
- seed sources 작성

초기 sources seed:

```text
de-bverfg
us-scotus
fr-conseil-constitutionnel
```

### Step 3. Mock UI

- mock article 데이터로 홈, 상세, 태그 페이지 먼저 구현
- UI 구조를 확정

### Step 4. 실제 DB 연결

- `/api/articles`
- `/api/articles/[slug]`
- `/api/tags`
- `/api/tags/[slug]`
- `/api/search`

### Step 5. 수집 파이프라인

- SourceAdapter interface
- 각 source adapter skeleton
- 최소 1개 source 실제 discover/fetch 구현
- dedup 구현
- cleaned_text 저장

### Step 6. LLM 요약 파이프라인

- LLM client abstraction
- prompt 작성
- SummarySchema validation
- JSON repair
- tag upsert
- embedding 저장

### Step 7. 검색

- full-text search
- trigram search
- semantic search
- hybrid search option

### Step 8. SEO

- metadata
- JSON-LD
- sitemap
- robots

### Step 9. 관리자 페이지

- ingestion run 목록
- 실패 상태 확인

### Step 10. 정리

- README 작성
- 실행 방법 작성
- 배포 방법 작성
- known limitations 작성

---

## 21. README에 반드시 포함할 내용

README에는 다음을 포함해줘.

```text
1. 프로젝트 설명
2. 기술 스택
3. 로컬 실행 방법
4. 환경변수 설명
5. Supabase migration 적용 방법
6. 수집 명령 실행 방법
7. 요약 명령 실행 방법
8. Vercel 배포 방법
9. 소스 어댑터 추가 방법
10. LLM provider 교체 방법
11. 검색 구조 설명
12. 한계 및 향후 개선 사항
```

---

## 22. 코드 품질 기준

- TypeScript strict 모드 기준으로 작성
- any 사용 최소화
- 서버/클라이언트 컴포넌트 구분 명확히
- DB query 함수는 `lib/db/queries.ts`에 모으기
- LLM 관련 코드는 `lib/ai`에 격리
- source adapter는 플러그인처럼 추가 가능하게 설계
- 크롤러는 사이트별 selector가 깨져도 전체 앱이 죽지 않게 작성
- 실패는 throw만 하지 말고 DB status에 반영
- UI는 빈 상태, 로딩 상태, 에러 상태를 처리
- 중요한 함수에는 간단한 주석 추가
- README와 `.env.example` 필수

---

## 23. 우선순위

MVP에서는 다음을 우선한다.

1. 데이터 모델
2. 카드형 홈 UI
3. 기사 상세 페이지
4. SourceAdapter 구조
5. 최소 1개 소스 실제 수집
6. LLM 요약 JSON 저장
7. 태그 생성
8. 검색/필터
9. SEO
10. 관리자 페이지

초기부터 모든 소스의 완벽한 크롤링을 목표로 하지 말고, 확장 가능한 구조와 안정적인 파이프라인을 우선 구현해줘.

---

## 24. 최종 산출물

다음 파일과 기능을 최종 산출물로 제공해줘.

```text
- Next.js 프로젝트 전체 코드
- Supabase migration SQL
- SourceAdapter 3개
- ingest script
- summarize-pending script
- refresh-tag-counts script
- API routes
- UI components
- SEO metadata
- sitemap/robots
- README
- .env.example
```

---

## 25. 중요한 구현 원칙

- 공식 소스 링크를 항상 보존한다.
- AI 요약은 원문을 대체하지 않는다.
- 요약이 불확실한 경우 confidence 또는 riskFlags로 표시한다.
- 미국 연방대법원 콘텐츠는 헌법 관련성을 필터링한다.
- 신규 기사가 요약 완료되면 태그 허브와 관련 목록이 자동 갱신되어야 한다.
- latest/today/week/month 필터는 서버 쿼리 기준으로 동작해야 한다.
- 검색엔진이 기사 상세·태그·용어사전 페이지를 크롤링할 수 있어야 한다.
- 추후 소스 사이트가 3개에서 여러 국가로 늘어나도 SourceAdapter만 추가하면 확장 가능해야 한다.

---

## 26. 추가 구현 세부 지시

### 26.1 패키지 구성

가능하면 다음 패키지를 사용해줘.

```bash
pnpm add @supabase/supabase-js zod cheerio rss-parser playwright
pnpm add openai
pnpm add reading-time
pnpm add clsx tailwind-merge
pnpm add lucide-react
pnpm add date-fns
pnpm add slugify
pnpm add pdf-parse
pnpm add @mozilla/readability jsdom
pnpm add -D tsx
```

필요 시 shadcn/ui는 프로젝트 설정에 맞게 추가해줘.

```bash
pnpm dlx shadcn@latest init
```

### 26.2 package.json scripts

다음 scripts를 구성해줘.

```json
{
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "next lint",
    "ingest": "tsx scripts/ingest.ts",
    "summarize-pending": "tsx scripts/summarize-pending.ts",
    "refresh-tag-counts": "tsx scripts/refresh-tag-counts.ts"
  }
}
```

### 26.3 DB seed

migration 또는 별도 seed 파일에 초기 source 3개를 삽입해줘.

```sql
insert into sources (
  source_key,
  name,
  jurisdiction,
  base_url,
  language,
  is_active
) values
(
  'de-bverfg',
  'Federal Constitutional Court of Germany',
  'Germany',
  'https://www.bundesverfassungsgericht.de',
  'de',
  true
),
(
  'us-scotus',
  'Supreme Court of the United States',
  'United States',
  'https://www.supremecourt.gov',
  'en',
  true
),
(
  'fr-conseil-constitutionnel',
  'Conseil constitutionnel',
  'France',
  'https://www.conseil-constitutionnel.fr',
  'fr',
  true
)
on conflict (source_key) do nothing;
```

### 26.4 Article slug 생성 규칙

기사 slug는 다음 우선순위로 생성해줘.

```text
1. jurisdiction
2. source_key
3. original_published_at yyyy-mm-dd
4. korean_title 또는 original_title
5. 짧은 hash
```

예시:

```text
germany-de-bverfg-2026-05-07-freedom-of-expression-a1b2c3
```

slug 충돌 시 hash 길이를 늘리거나 suffix를 붙여줘.

### 26.5 canonical URL 정규화

canonical URL은 다음 처리를 거쳐 생성해줘.

```text
- protocol/host lowercase
- trailing slash 정규화
- utm_source, utm_medium, utm_campaign 등 tracking query 제거
- fragment 제거
- 상대 URL은 baseUrl 기준 absolute URL로 변환
```

### 26.6 본문 추출 우선순위

HTML 문서:

```text
1. @mozilla/readability
2. Cheerio selector 기반 추출
3. body text fallback
```

PDF 문서:

```text
1. pdf-parse
2. 실패 시 needs_review
```

Playwright:

```text
- JS 렌더링이 필요한 목록 또는 상세 페이지만 fallback으로 사용
- 기본 수집은 fetch + Cheerio 우선
- timeout, user-agent, rate limit을 설정
```

### 26.7 수집 제한

MVP에서는 source별 discover 결과를 기본 20개로 제한해줘.

환경변수로 조정 가능하게 해줘.

```bash
INGEST_LIMIT_PER_SOURCE=20
```

### 26.8 rate limit

source별 요청 간격을 둬줘.

기본값:

```text
1000ms ~ 3000ms 사이
```

간단한 sleep utility를 작성해 사용해줘.

### 26.9 미국 연방대법원 헌법 관련성 필터

MVP에서는 다음 2단계로 구현해줘.

#### 1차 keyword score

본문 또는 제목에 다음 키워드가 있으면 점수를 부여한다.

```text
constitution
constitutional
first amendment
second amendment
fourth amendment
fifth amendment
sixth amendment
eighth amendment
fourteenth amendment
due process
equal protection
free speech
religion clause
establishment clause
free exercise
separation of powers
federalism
commerce clause
takings clause
sovereign immunity
standing
executive power
congressional power
```

#### 2차 threshold

```text
score >= 1이면 요약 대상
score = 0이면 needs_review 또는 제외
```

구현 시 함수명:

```ts
isConstitutionallyRelevant(article: NormalizedArticle): boolean
```

향후 LLM 분류기로 교체 가능하게 별도 파일에 둬줘.

### 26.10 LLM 호출 실패 처리

LLM 호출 실패 시:

```text
1. articles.status = failed_summary
2. error metadata 저장
3. 다음 summarize-pending 실행에서 재시도 가능하게 유지
```

JSON validation 실패 시:

```text
1. repair prompt 1회 실행
2. 그래도 실패하면 failed_summary
3. 원본 LLM 응답 일부를 error metadata에 저장
```

### 26.11 태그 정규화 규칙

태그 저장 전 다음 처리를 해줘.

```text
- trim
- lowercase slug 생성
- 동일 의미 태그 normalization
- 공백은 hyphen으로 변환
- 특수문자 제거 또는 안전하게 치환
```

예시:

```text
Free Speech → free-speech
First Amendment → first-amendment
표현의 자유 → 표현의-자유
```

### 26.12 태그 카운트 갱신

요약 완료 후 즉시 해당 태그의 article_count, latest_article_at을 갱신해줘.

또한 `pnpm refresh-tag-counts` 명령으로 전체 재계산 가능하게 해줘.

### 26.13 검색 구현 세부

검색 결과 ranking은 MVP에서 다음 순서로 단순화해줘.

```text
1. exact title match
2. full-text rank
3. trigram similarity
4. original_published_at desc
```

semantic mode에서는 pgvector cosine distance를 사용한다.

hybrid mode에서는 full-text 결과와 vector 결과를 합쳐 중복 제거 후 정렬한다.

### 26.14 기간 필터 정의

기간 필터는 서버 기준으로 다음처럼 처리한다.

```text
latest: 제한 없음, original_published_at desc
today: 현재 날짜 00:00 이후
week: 최근 7일
month: 최근 30일
```

날짜 기준은 가능하면 UTC로 저장하고, UI에서는 사용자의 로케일에 맞게 표시한다.

### 26.15 빈 상태 UI

각 페이지에는 빈 상태를 구현해줘.

예시:

```text
아직 수집된 기사가 없습니다.
검색 결과가 없습니다.
이 태그와 연결된 기사가 없습니다.
요약이 아직 생성되지 않았습니다.
```

### 26.16 관리자 보안

MVP에서는 간단히 `CRON_SECRET` 기반으로 보호한다.

```text
Authorization: Bearer ${CRON_SECRET}
```

보호 대상:

```text
POST /api/admin/ingest
GET /admin
GET /admin/ingestion-runs
```

Next.js middleware 또는 서버 컴포넌트에서 처리해줘.

### 26.17 Vercel Cron

Vercel Cron을 사용할 수 있도록 endpoint를 구현해줘.

```text
GET /api/admin/cron/ingest
```

요청 헤더 또는 query secret으로 보호한다.

동작:

```text
1. ingest 실행
2. summarize-pending 실행
3. refresh-tag-counts 실행
4. JSON 결과 반환
```

단, Vercel 함수 timeout이 있을 수 있으므로 MVP에서는 source별 limit을 낮게 유지한다.

장기적으로는 별도 worker로 분리할 수 있게 README에 적어줘.

### 26.18 테스트 또는 검증 스크립트

최소한 다음 검증을 작성해줘.

```text
- canonical URL normalization
- slug generation
- SummarySchema validation
- tag normalization
- date range filter
- constitutional relevance keyword filter
```

테스트 프레임워크를 추가하기 어렵다면 `scripts/check.ts` 형태의 간단한 검증 스크립트라도 작성해줘.

### 26.19 README의 Known Limitations

README에 다음 한계를 명시해줘.

```text
- 공식 사이트 구조 변경 시 selector 수정이 필요할 수 있음
- 일부 PDF는 텍스트 추출이 실패할 수 있음
- AI 요약은 참고용이며 법률 자문이 아님
- 미국 연방대법원 콘텐츠의 헌법 관련성 필터는 MVP에서 키워드 기반임
- 대량 수집에는 Vercel Cron보다 별도 queue worker가 적합함
```

### 26.20 Definition of Done

최종 완료 시 다음을 확인해줘.

```text
pnpm install 성공
pnpm dev 성공
pnpm build 성공
Supabase migration 적용 가능
.env.example 존재
홈 페이지 렌더링
기사 상세 페이지 렌더링
태그 페이지 렌더링
검색 페이지 렌더링
관리자 ingestion run 페이지 렌더링
pnpm ingest 실행 가능
pnpm summarize-pending 실행 가능
pnpm refresh-tag-counts 실행 가능
최소 1개 source에서 실제 article discovery 가능
LLM API key가 없을 때도 mock/fallback 모드로 UI 확인 가능
README에 실행·배포 방법 존재
```

---

## 27. LLM API key가 없을 때의 fallback

개발 환경에서 `OPENAI_API_KEY`가 없으면 앱이 죽지 않게 해줘.

대신 다음 mock summary를 생성하는 fallback을 둬줘.

```json
{
  "koreanTitle": "요약 대기 중인 헌법재판 관련 게시물",
  "originalTitle": "Original title",
  "summary": {
    "coreSummary": [
      "LLM API 키가 없어 임시 요약이 생성되었습니다."
    ],
    "referencedProvisions": [],
    "background": "개발 환경용 임시 데이터입니다.",
    "caseStructure": "원문 분석이 아직 수행되지 않았습니다.",
    "implications": "실제 배포 환경에서는 LLM 요약으로 대체됩니다.",
    "practicalNotes": "OPENAI_API_KEY를 설정한 뒤 다시 요약을 실행하세요."
  },
  "entities": [],
  "tags": ["요약대기"],
  "categories": ["development"],
  "riskFlags": ["source_text_incomplete"]
}
```

단, production 환경에서는 API key가 없으면 명확한 에러를 발생시켜줘.

---

## 28. UI 카피

가능하면 UI 텍스트는 한국어를 기본으로 해줘.

예시:

```text
세계 헌법재판 큐레이션
최신 소식
오늘
이번 주
이번 달
전체
국가
기관
유형
태그
검색어를 입력하세요
원문 보기
자세히 보기
핵심 요약
참조 조문
배경
사건 구조
시사점
실무상 참고
관련 기사
관련 태그
수집 상태
요약 완료
요약 대기
수집 실패
```

---

## 29. 최종 응답 형식

구현을 마치면 다음 형식으로 보고해줘.

```md
# 구현 완료 보고

## 완료한 작업

## 주요 파일

## 실행 방법

## 환경변수

## DB migration 적용 방법

## 수집 실행 방법

## 요약 실행 방법

## 검색 동작 방식

## 배포 방법

## 남은 한계

## 다음 개선 제안
```
