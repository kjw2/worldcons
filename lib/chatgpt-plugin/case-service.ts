import {
  getArticleBySlug,
  getArticleSourceTextBySlug,
  listSources,
} from "@/lib/db/queries";
import type {
  ArticleDetail,
  ArticleListFilters,
  ArticleListItem,
  ArticleListResult,
  SourceRecord,
} from "@/lib/db/types";
import { hybridSearch } from "@/lib/search/vector";
import { catalogCaseSearch } from "@/lib/search/case-catalog";
import { caseCatalogPluginEnabled } from "@/lib/case-catalog/flags";
import { WorldconsToolError } from "@/lib/chatgpt-plugin/errors";

const CANONICAL_SITE_URL = "https://worldcons.vercel.app";
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export type SearchFilters = {
  query?: string;
  jurisdiction?: string;
  source?: string;
  range?: "latest" | "today" | "week" | "month";
  limit?: number;
  cursor?: string;
};

export type WorldconsCaseRepository = {
  search(filters: ArticleListFilters): Promise<ArticleListResult>;
  getArticle(slug: string): Promise<ArticleDetail | null>;
  getSourceText(slug: string): Promise<{ slug: string; cleanedText?: string | null; contentHash?: string | null } | null>;
  getSources(): Promise<SourceRecord[]>;
};

export type WorldconsCaseServiceOptions = {
  repository?: WorldconsCaseRepository;
  siteBaseUrl?: string;
  detailTextLimit?: number;
  sourceTextPageLimit?: number;
  environment?: Record<string, string | undefined>;
};

function productionRepository(environment: Record<string, string | undefined>): WorldconsCaseRepository {
  return {
    search: (filters) => caseCatalogPluginEnabled(environment)
      ? catalogCaseSearch(filters, { environment })
      : hybridSearch(filters, { useCatalog: false }),
    getArticle: (slug) => getArticleBySlug(slug),
    getSourceText: (slug) => getArticleSourceTextBySlug(slug),
    getSources: listSources,
  };
}

export class WorldconsCaseService {
  private readonly repository: WorldconsCaseRepository;
  private readonly siteBaseUrl: string;
  readonly detailTextLimit: number;
  readonly sourceTextPageLimit: number;

  constructor(options: WorldconsCaseServiceOptions = {}) {
    const environment = options.environment ?? process.env;
    this.repository = options.repository ?? productionRepository(environment);
    this.siteBaseUrl = normalizedHttpsBaseUrl(options.siteBaseUrl ?? CANONICAL_SITE_URL);
    this.detailTextLimit = boundedInteger(options.detailTextLimit, 16_000, 1, 350_000);
    this.sourceTextPageLimit = boundedInteger(options.sourceTextPageLimit, 12_000, 1, 50_000);
  }

  async search(filters: SearchFilters) {
    return (await this.searchPage(filters)).results;
  }

  async searchPage(filters: SearchFilters) {
    const limit = boundedInteger(filters.limit, 10, 1, 10);
    const result = await this.repository.search({
      q: filters.query?.trim() || undefined,
      jurisdiction: filters.jurisdiction,
      source: filters.source,
      range: filters.range ?? "latest",
      page: 1,
      pageSize: limit,
      cursor: filters.cursor,
      count: "none",
    });
    return {
      results: result.items.slice(0, limit).map((article) => this.mapSearchItem(article)),
      nextCursor: result.pageInfo.nextCursor ?? null,
      hasMore: result.pageInfo.hasMore ?? false,
      retrievalMode: result.retrievalMode ?? null,
      rankingVersion: result.rankingVersion ?? null,
    };
  }

  async fetchArticle(slug: string) {
    assertSlug(slug);
    const article = await this.repository.getArticle(slug);
    if (!article) {
      throw new WorldconsToolError("NOT_FOUND", "요청한 공개 판례를 찾을 수 없습니다.");
    }

    const item = this.mapSearchItem(article);
    const summary = article.summaryJson?.summary;
    const enrichmentStatus = article.enrichmentStatus ?? (summary ? "full" : "source_only");
    const enrichmentFreshness = article.enrichmentFreshness ?? (summary ? "current" : null);
    const summaryStatus = article.summaryStatus ?? (summary ? "available" : "pending");
    const summaryAvailable = (article.summaryAvailable ?? Boolean(summary)) && enrichmentFreshness !== "stale";
    const sourceText = article.cleanedText?.trim() || article.rawText?.trim() || "";
    const returnedChars = Math.min(sourceText.length, this.detailTextLimit);
    return {
      ...item,
      koreanSummary: summaryAvailable && summary ? {
        coreSummary: summary?.coreSummary ?? [],
        background: normalizedOptionalString(summary?.background),
        caseStructure: normalizedOptionalString(summary?.caseStructure),
        implications: normalizedOptionalString(summary?.implications),
        practicalNotes: normalizedOptionalString(summary?.practicalNotes),
        referencedProvisions: (summary?.referencedProvisions ?? []).map(formatProvision),
      } : null,
      enrichmentStatus,
      enrichmentFreshness,
      summaryStatus,
      summaryAvailable,
      officialMetadataAvailable: true,
      sourceExcerpt: sourceText.slice(0, this.detailTextLimit) || null,
      originalLanguage: normalizedOptionalString(article.originalLanguage),
      contentType: article.contentType,
      bodyChecksum: normalizedOptionalString(article.contentHash),
      textPage: {
        offset: 0,
        returnedChars,
        totalChars: sourceText.length,
        hasMore: sourceText.length > returnedChars,
        nextOffset: sourceText.length > returnedChars ? returnedChars : null,
      },
    };
  }

  async listSources() {
    const sources = await this.repository.getSources();
    return sources.map((source) => ({
      sourceKey: source.sourceKey,
      name: source.name,
      jurisdiction: source.jurisdiction,
      language: source.language,
      officialUrl: requiredHttpsUrl(source.baseUrl, "source baseUrl"),
    }));
  }

  async fetchSourceText(slug: string, offset: number, limit: number) {
    assertSlug(slug);
    const snapshot = await this.repository.getSourceText(slug);
    const fullText = snapshot?.cleanedText?.trim();
    if (!snapshot || !fullText) {
      throw new WorldconsToolError("NOT_FOUND", "요청한 판례의 공개 원문을 찾을 수 없습니다.");
    }

    const effectiveOffset = boundedInteger(offset, 0, 0, 10_000_000);
    const effectiveLimit = boundedInteger(limit, this.sourceTextPageLimit, 1, this.sourceTextPageLimit);
    const text = fullText.slice(effectiveOffset, effectiveOffset + effectiveLimit);
    const nextOffset = effectiveOffset + text.length;
    return {
      id: snapshot.slug,
      text,
      bodyChecksum: normalizedOptionalString(snapshot.contentHash),
      offset: effectiveOffset,
      returnedChars: text.length,
      totalChars: fullText.length,
      hasMore: nextOffset < fullText.length,
      nextOffset: nextOffset < fullText.length ? nextOffset : null,
      url: this.articleUrl(slug),
    };
  }

  async health() {
    await this.repository.getSources();
  }

  private mapSearchItem(article: ArticleListItem) {
    assertSlug(article.slug);
    const officialUrl = article.originalUrl || article.canonicalUrl;
    const summaryAvailable = article.summaryAvailable ?? Boolean(article.summaryJson);
    const enrichmentStatus = article.enrichmentStatus ?? (summaryAvailable ? "full" : "source_only");
    return {
      id: article.slug,
      title: article.koreanTitle || article.originalTitle || "제목 미상",
      url: this.articleUrl(article.slug),
      originalTitle: normalizedOptionalString(article.originalTitle),
      summary: summaryAvailable ? normalizedOptionalString(article.oneLineSummary) : null,
      snippet: summaryAvailable ? normalizedOptionalString(article.oneLineSummary) : null,
      sourceKey: article.sourceKey,
      jurisdiction: article.jurisdiction,
      court: article.institutionName,
      caseNumber: normalizedOptionalString(article.caseNumber) ?? metadataString(article.sourceMetadata),
      decisionDate: normalizedOptionalString(article.originalPublishedAt),
      officialUrl: requiredHttpsUrl(officialUrl, "official URL"),
      tags: article.tags.map((tag) => tag.name).filter(Boolean).slice(0, 20),
      enrichmentStatus,
      enrichmentFreshness: article.enrichmentFreshness ?? (summaryAvailable ? "current" : null),
      summaryStatus: article.summaryStatus ?? (summaryAvailable ? "available" : "pending"),
      summaryAvailable,
      officialMetadataAvailable: true,
    };
  }

  private articleUrl(slug: string) {
    return `${this.siteBaseUrl}/articles/${encodeURIComponent(slug)}`;
  }
}

function normalizedHttpsBaseUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("The site base URL must be a public HTTPS URL.");
  }
  url.pathname = url.pathname.replace(/\/+$/u, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/u, "");
}

function requiredHttpsUrl(value: string, label: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error(`${label} must be HTTPS.`);
  }
  return url.toString();
}

function assertSlug(value: string) {
  if (!SLUG_PATTERN.test(value)) {
    throw new WorldconsToolError("INVALID_REQUEST", "판례 식별자가 올바르지 않습니다.");
  }
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number) {
  return Number.isSafeInteger(value) && value !== undefined && value >= min && value <= max ? value : fallback;
}

function normalizedOptionalString(value: string | null | undefined) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function metadataString(metadata: Record<string, unknown> | null | undefined) {
  for (const key of ["caseNumber", "case_number", "docketNumber", "docket_number", "decisionNumber", "resolutionNumber"]) {
    const value = metadata?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function formatProvision(provision: {
  jurisdiction: string;
  lawName: string;
  article: string;
  description: string;
}) {
  return [provision.lawName, provision.article, provision.description]
    .map((value) => value.trim())
    .filter(Boolean)
    .join(" · ");
}
