import type {
  ArticleDetail,
  IngestionRunRecord,
  SourceRecord,
  SummaryJson,
  TagSummary,
} from "@/lib/db/types";
import { glossaryTermsSeed } from "@/lib/glossary/terms";

const germanySummary: SummaryJson = {
  koreanTitle: "독일 연방헌법재판소, 표현의 자유와 비례원칙 심사 기준 재확인",
  originalTitle: "Bundesverfassungsgericht clarifies proportionality review",
  summary: {
    coreSummary: [
      "재판소는 공적 표현에 대한 제한이 헌법상 정당화되려면 명확한 법적 근거와 엄격한 비례성 심사를 통과해야 한다고 보았다.",
      "결정은 표현의 자유 사건에서 국가가 제시해야 할 구체적 위험과 절차적 보장의 중요성을 강조한다.",
    ],
    referencedProvisions: [
      {
        jurisdiction: "Germany",
        lawName: "Basic Law",
        article: "Article 5",
        description: "표현의 자유와 정보의 자유에 관한 조항",
        confidence: "medium",
      },
    ],
    background: "공공질서 목적의 표현 제한이 기본권 보호 범위와 어떻게 충돌하는지가 쟁점이었다.",
    caseStructure: "재판소는 제한의 법률상 근거, 목적의 정당성, 수단의 적합성, 최소침해성, 법익균형을 순서대로 검토했다.",
    implications: "향후 독일 표현의 자유 사건에서 비례원칙의 구조화된 심사가 다시 중요한 기준점으로 작동할 수 있다.",
    practicalNotes: "요약은 개발용 mock 데이터다. 실제 법적 인용은 원문과 공식 자료 확인이 필요하다.",
  },
  entities: [
    { name: "Federal Constitutional Court of Germany", type: "court", normalizedName: "Federal Constitutional Court of Germany" },
    { name: "Basic Law Article 5", type: "article", normalizedName: "Basic Law Article 5" },
    { name: "Freedom of Expression", type: "right", normalizedName: "Freedom of Expression" },
  ],
  tags: ["표현의 자유", "비례원칙", "독일 기본법"],
  categories: ["decision", "fundamental_rights"],
  riskFlags: ["translation_uncertain"],
};

const usSummary: SummaryJson = {
  koreanTitle: "미국 연방대법원, 수정헌법 제1조 관련 당사자적격 판단",
  originalTitle: "First Choice Women’s Resource Centers, Inc. v. Davenport",
  summary: {
    coreSummary: [
      "연방대법원은 문서와 기부자 정보 제출 요구가 수정헌법 제1조상 결사의 자유에 현재적 침해를 발생시킬 수 있다고 보았다.",
      "그 결과 원고는 Article III상 당사자적격을 충족한다고 판단했다.",
    ],
    referencedProvisions: [
      {
        jurisdiction: "United States",
        lawName: "U.S. Constitution",
        article: "First Amendment",
        description: "표현 및 결사의 자유와 관련된 헌법 조항",
        confidence: "high",
      },
      {
        jurisdiction: "United States",
        lawName: "U.S. Constitution",
        article: "Article III",
        description: "연방법원의 사법권과 당사자적격 논의의 근거",
        confidence: "medium",
      },
    ],
    background: "주 법무장관의 소환장 집행이 단체의 결사 활동을 위축시키는지가 문제 되었다.",
    caseStructure: "다수의견은 현재적 손해, 인과관계, 구제가능성의 순서로 당사자적격을 분석했다.",
    implications: "헌법상 권리 침해 위험이 수사·조사 단계의 정보 제출 요구에서도 소송 가능성을 열 수 있음을 보여준다.",
    practicalNotes: "MVP에서는 헌법 관련 키워드 필터로 우선 선별하고, 운영 환경에서는 LLM 분류기로 정교화한다.",
  },
  entities: [
    { name: "Supreme Court of the United States", type: "court", normalizedName: "Supreme Court of the United States" },
    { name: "First Amendment", type: "article", normalizedName: "First Amendment" },
    { name: "Standing", type: "doctrine", normalizedName: "Standing" },
  ],
  tags: ["First Amendment", "Standing", "Free Speech"],
  categories: ["opinion", "constitutional_law"],
  riskFlags: [],
};

const franceSummary: SummaryJson = {
  koreanTitle: "프랑스 헌법위원회, QPC 절차에서 권리 보장 범위 검토",
  originalTitle: "Décision QPC relative aux garanties constitutionnelles",
  summary: {
    coreSummary: [
      "헌법위원회는 QPC 절차에서 법률 조항이 헌법상 보장된 권리와 자유를 과도하게 제한하는지 검토했다.",
      "관련 조항의 적용 범위와 절차적 보장을 함께 고려했다.",
    ],
    referencedProvisions: [
      {
        jurisdiction: "France",
        lawName: "Constitution of 1958",
        article: "Article 61-1",
        description: "우선적 위헌심사절차(QPC)의 헌법상 근거",
        confidence: "medium",
      },
    ],
    background: "하급심 절차에서 제기된 QPC가 헌법위원회에 회부된 사안이다.",
    caseStructure: "위원회는 심판대상 조항, 청구인의 주장, 헌법상 기준, 합헌성 판단을 순차적으로 제시했다.",
    implications: "프랑스식 사후적 위헌심사에서 절차 보장의 실제 작동 방식을 추적하는 데 의미가 있다.",
    practicalNotes: "프랑스어 원문과 결정번호 확인 후 인용해야 한다.",
  },
  entities: [
    { name: "Conseil constitutionnel", type: "court", normalizedName: "Conseil constitutionnel" },
    { name: "QPC", type: "procedure", normalizedName: "QPC" },
    { name: "Article 61-1", type: "article", normalizedName: "Article 61-1" },
  ],
  tags: ["QPC", "프랑스 헌법", "절차적 보장"],
  categories: ["decision", "procedure"],
  riskFlags: ["provision_reference_uncertain"],
};

export const mockTags: TagSummary[] = [
  { slug: "first-amendment", name: "First Amendment", normalizedName: "First Amendment", type: "article", articleCount: 1, latestArticleAt: "2026-04-29T00:00:00.000Z" },
  { slug: "standing", name: "Standing", normalizedName: "Standing", type: "doctrine", articleCount: 1, latestArticleAt: "2026-04-29T00:00:00.000Z" },
  { slug: "free-speech", name: "Free Speech", normalizedName: "Free Speech", type: "right", articleCount: 1, latestArticleAt: "2026-04-29T00:00:00.000Z" },
  { slug: "표현의-자유", name: "표현의 자유", normalizedName: "표현의 자유", type: "right", articleCount: 1, latestArticleAt: "2026-05-07T00:00:00.000Z" },
  { slug: "비례원칙", name: "비례원칙", normalizedName: "비례원칙", type: "doctrine", articleCount: 1, latestArticleAt: "2026-05-07T00:00:00.000Z" },
  { slug: "qpc", name: "QPC", normalizedName: "QPC", type: "procedure", articleCount: 1, latestArticleAt: "2026-05-02T00:00:00.000Z" },
];

export const mockSources: SourceRecord[] = [
  {
    sourceKey: "de-bverfg",
    name: "Federal Constitutional Court of Germany",
    jurisdiction: "Germany",
    baseUrl: "https://www.bundesverfassungsgericht.de",
    language: "de",
    isActive: true,
  },
  {
    sourceKey: "us-scotus",
    name: "Supreme Court of the United States",
    jurisdiction: "United States",
    baseUrl: "https://www.supremecourt.gov",
    language: "en",
    isActive: true,
  },
  {
    sourceKey: "fr-conseil-constitutionnel",
    name: "Conseil constitutionnel",
    jurisdiction: "France",
    baseUrl: "https://www.conseil-constitutionnel.fr",
    language: "fr",
    isActive: true,
  },
  {
    sourceKey: "es-tribunal-constitucional",
    name: "Tribunal Constitucional de España",
    jurisdiction: "Spain",
    baseUrl: "https://hj.tribunalconstitucional.es",
    language: "es",
    isActive: true,
  },
];

export const mockArticles: ArticleDetail[] = [
  {
    slug: "germany-de-bverfg-2026-05-07-expression-review-a1b2c3",
    sourceKey: "de-bverfg",
    jurisdiction: "Germany",
    institutionName: "Federal Constitutional Court of Germany",
    contentType: "decision",
    originalUrl: "https://www.bundesverfassungsgericht.de",
    canonicalUrl: "https://www.bundesverfassungsgericht.de",
    originalLanguage: "de",
    originalTitle: germanySummary.originalTitle,
    koreanTitle: germanySummary.koreanTitle,
    originalPublishedAt: "2026-05-07T00:00:00.000Z",
    discoveredAt: "2026-05-08T00:00:00.000Z",
    fetchedAt: "2026-05-08T00:10:00.000Z",
    summarizedAt: "2026-05-08T00:20:00.000Z",
    status: "summarized",
    summaryJson: germanySummary,
    tags: mockTags.filter((tag) => ["표현의-자유", "비례원칙"].includes(tag.slug)),
    oneLineSummary: germanySummary.summary.coreSummary[0],
    cleanedText: "Mock source text for German constitutional court decision.",
    readingMinutes: 3,
  },
  {
    slug: "united-states-us-scotus-2026-04-29-first-choice-standing-d4e5f6",
    sourceKey: "us-scotus",
    jurisdiction: "United States",
    institutionName: "Supreme Court of the United States",
    contentType: "opinion",
    originalUrl: "https://www.supremecourt.gov/opinions/25pdf/24-781_pok0.pdf",
    canonicalUrl: "https://www.supremecourt.gov/opinions/25pdf/24-781_pok0.pdf",
    originalLanguage: "en",
    originalTitle: usSummary.originalTitle,
    koreanTitle: usSummary.koreanTitle,
    originalPublishedAt: "2026-04-29T00:00:00.000Z",
    discoveredAt: "2026-05-08T00:00:00.000Z",
    fetchedAt: "2026-05-08T00:10:00.000Z",
    summarizedAt: "2026-05-08T00:20:00.000Z",
    status: "summarized",
    summaryJson: usSummary,
    tags: mockTags.filter((tag) => ["first-amendment", "standing", "free-speech"].includes(tag.slug)),
    oneLineSummary: usSummary.summary.coreSummary[0],
    cleanedText: "Mock source text for a Supreme Court opinion involving First Amendment associational rights and Article III standing.",
    readingMinutes: 5,
  },
  {
    slug: "france-fr-conseil-constitutionnel-2026-05-02-qpc-procedure-a7b8c9",
    sourceKey: "fr-conseil-constitutionnel",
    jurisdiction: "France",
    institutionName: "Conseil constitutionnel",
    contentType: "decision",
    originalUrl: "https://www.conseil-constitutionnel.fr",
    canonicalUrl: "https://www.conseil-constitutionnel.fr",
    originalLanguage: "fr",
    originalTitle: franceSummary.originalTitle,
    koreanTitle: franceSummary.koreanTitle,
    originalPublishedAt: "2026-05-02T00:00:00.000Z",
    discoveredAt: "2026-05-08T00:00:00.000Z",
    fetchedAt: "2026-05-08T00:10:00.000Z",
    summarizedAt: "2026-05-08T00:20:00.000Z",
    status: "summarized",
    summaryJson: franceSummary,
    tags: mockTags.filter((tag) => tag.slug === "qpc"),
    oneLineSummary: franceSummary.summary.coreSummary[0],
    cleanedText: "Mock source text for a Conseil constitutionnel QPC decision.",
    readingMinutes: 4,
  },
];

export const mockIngestionRuns: IngestionRunRecord[] = [
  {
    sourceKey: "us-scotus",
    startedAt: "2026-05-08T00:00:00.000Z",
    finishedAt: "2026-05-08T00:02:31.000Z",
    status: "completed",
    discoveredCount: 12,
    fetchedCount: 4,
    summarizedCount: 2,
    failedCount: 0,
    metadata: { mode: "mock" },
  },
];

export const mockGlossaryTerms = glossaryTermsSeed;
