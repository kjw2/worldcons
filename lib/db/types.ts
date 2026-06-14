export const ARTICLE_CONTENT_TYPES = [
  "news",
  "press_release",
  "decision",
  "opinion",
  "order",
  "other",
] as const;

export type ArticleContentType = (typeof ARTICLE_CONTENT_TYPES)[number];

export type ArticleStatus =
  | "discovered"
  | "metadata_only"
  | "robots_disallowed"
  | "blocked"
  | "timeout"
  | "fetched"
  | "cleaned"
  | "summarizing"
  | "summarized"
  | "failed_fetch"
  | "failed_summary"
  | "needs_review";

export type TagType =
  | "court"
  | "country"
  | "law"
  | "article"
  | "right"
  | "party"
  | "institution"
  | "topic"
  | "doctrine"
  | "procedure"
  | "case_type";

export type RiskFlag =
  | "translation_uncertain"
  | "source_text_incomplete"
  | "provision_reference_uncertain"
  | "constitutional_relevance_uncertain";

export interface ReferencedProvision {
  jurisdiction: string;
  lawName: string;
  article: string;
  description: string;
  confidence: "high" | "medium" | "low";
}

export interface SummaryJson {
  koreanTitle: string;
  originalTitle?: string;
  summary: {
    coreSummary: string[];
    referencedProvisions: ReferencedProvision[];
    background: string;
    caseStructure: string;
    implications: string;
    practicalNotes: string;
  };
  entities: Array<{
    name: string;
    type: TagType;
    normalizedName: string;
  }>;
  tags: string[];
  categories: string[];
  riskFlags: RiskFlag[];
  aiMetadata?: {
    provider: string;
    model: string;
    generatedAt?: string;
  };
}

export interface TagSummary {
  id?: string;
  slug: string;
  name: string;
  normalizedName: string;
  type: TagType;
  description?: string | null;
  articleCount?: number;
  latestArticleAt?: string | null;
  confidence?: number | null;
}

export interface ArticleListItem {
  id?: string;
  slug: string;
  sourceKey: string;
  jurisdiction: string;
  institutionName: string;
  contentType: ArticleContentType;
  originalUrl: string;
  canonicalUrl: string;
  originalLanguage: string;
  originalTitle?: string | null;
  koreanTitle?: string | null;
  originalPublishedAt?: string | null;
  discoveredAt?: string | null;
  fetchedAt?: string | null;
  summarizedAt?: string | null;
  status: ArticleStatus;
  summaryJson?: SummaryJson | null;
  sourceMetadata?: Record<string, unknown> | null;
  tags: TagSummary[];
  oneLineSummary: string;
}

export interface ArticleDetail extends ArticleListItem {
  rawText?: string | null;
  cleanedText?: string | null;
  contentHash?: string | null;
  errorMetadata?: Record<string, unknown> | null;
}

export interface ArticleListFilters {
  ids?: string[];
  q?: string;
  range?: "latest" | "today" | "week" | "month";
  source?: string;
  jurisdiction?: string;
  type?: ArticleContentType;
  tag?: string;
  language?: string;
  includeUnpublished?: boolean;
  page?: number;
  pageSize?: number;
}

export interface PageInfo {
  page: number;
  pageSize: number;
  total: number;
}

export interface ArticleListResult {
  items: ArticleListItem[];
  pageInfo: PageInfo;
}

export interface SourceRecord {
  id?: string;
  sourceKey: string;
  name: string;
  jurisdiction: string;
  baseUrl: string;
  language: string;
  isActive: boolean;
}

export interface IngestionRunRecord {
  id?: string;
  sourceKey: string;
  startedAt: string;
  finishedAt?: string | null;
  status: string;
  discoveredCount: number;
  fetchedCount: number;
  summarizedCount: number;
  failedCount: number;
  errorMessage?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface GlossaryTerm {
  slug: string;
  term: string;
  koreanTerm?: string | null;
  definition: string;
  jurisdiction?: string | null;
  relatedTags: string[];
}
