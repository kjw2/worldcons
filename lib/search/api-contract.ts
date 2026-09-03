import type { ArticleListItem, SourceRecord } from "@/lib/db/types";

export const WORLDCONS_SEARCH_SCHEMA_VERSION = 1;
export const WORLDCONS_SOURCE_TYPE = "foreign_constitutional";

export function mapSearchApiArticle(article: ArticleListItem, baseUrl: string) {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/u, "");
  const encodedSlug = encodeURIComponent(article.slug);
  const worldconsUrl = `${normalizedBaseUrl}/articles/${encodedSlug}`;
  const detailApiUrl = `${normalizedBaseUrl}/api/articles/${encodedSlug}`;
  const sourceTextUrl = `${detailApiUrl}/source-text`;
  const caseNumber = metadataString(article.sourceMetadata, [
    "caseNumber",
    "case_number",
    "docketNumber",
    "docket_number",
    "decisionNumber",
    "resolutionNumber",
  ]);

  return {
    ...article,
    id: article.id ?? article.slug,
    title: article.koreanTitle || article.originalTitle || "제목 미상",
    summary: article.summaryAvailable === false ? null : article.oneLineSummary,
    snippet: article.summaryAvailable === false ? null : article.oneLineSummary,
    sourceType: WORLDCONS_SOURCE_TYPE,
    country: article.jurisdiction,
    courtName: article.institutionName,
    caseNumber,
    decisionDate: article.originalPublishedAt ?? null,
    publishedAt: article.originalPublishedAt ?? null,
    language: article.originalLanguage,
    officialUrl: article.originalUrl || article.canonicalUrl,
    enrichmentStatus: article.enrichmentStatus ?? (article.summaryJson ? "full" : "source_only"),
    enrichmentFreshness: article.enrichmentFreshness ?? null,
    summaryStatus: article.summaryStatus ?? (article.summaryJson ? "available" : "pending"),
    summaryAvailable: article.summaryAvailable ?? Boolean(article.summaryJson),
    officialMetadataAvailable: true,
    url: worldconsUrl,
    worldconsUrl,
    detailUrl: worldconsUrl,
    detailApiUrl,
    sourceTextUrl,
    metadata: {
      slug: article.slug,
      sourceKey: article.sourceKey,
      sourceType: WORLDCONS_SOURCE_TYPE,
      institutionName: article.institutionName,
      contentType: article.contentType,
      caseNumber,
      originalTitle: article.originalTitle ?? null,
      officialUrl: article.originalUrl || article.canonicalUrl,
      worldconsUrl,
      detailApiUrl,
      sourceTextUrl,
    },
  };
}

export function mapSearchApiSource(source: SourceRecord) {
  return {
    ...source,
    sourceType: WORLDCONS_SOURCE_TYPE,
  };
}

function metadataString(metadata: Record<string, unknown> | null | undefined, keys: string[]) {
  if (!metadata) return null;
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}
