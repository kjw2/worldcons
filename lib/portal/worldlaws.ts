import type { ArticleListItem } from "@/lib/db/types";
import { displayArticleTypeLabel } from "@/lib/ui/content-type-labels";
import { displayJurisdictionLabel, displaySourceLabel } from "@/lib/ui/source-labels";
import { safeExternalUrl } from "@/lib/utils/safe-url";

const JURISDICTION_CODES: Record<string, string> = {
  "United States": "US",
  Germany: "DE",
  France: "FR",
  Spain: "ES",
};

export function jurisdictionCodeFor(jurisdiction: string) {
  return JURISDICTION_CODES[jurisdiction] ?? jurisdiction;
}

export function isoOrNull(value?: string | null) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function firstIso(values: Array<string | null | undefined>, fallback: string) {
  return values.map(isoOrNull).find(Boolean) ?? fallback;
}

export function portalArticleUpdatedAt(article: ArticleListItem, fallbackUpdatedAt: string) {
  return firstIso([article.summarizedAt, article.fetchedAt, article.discoveredAt, article.originalPublishedAt], fallbackUpdatedAt);
}

export function portalArticlePublishedAt(article: ArticleListItem, fallbackUpdatedAt: string) {
  return firstIso([article.originalPublishedAt, article.discoveredAt, article.fetchedAt, article.summarizedAt], portalArticleUpdatedAt(article, fallbackUpdatedAt));
}

export function toWorldlawsPortalItem(
  article: ArticleListItem,
  baseUrl: string,
  fallbackUpdatedAt: string,
  options: { type?: string; badges?: string[] } = {},
) {
  const jurisdictionName = displayJurisdictionLabel(article.jurisdiction);
  const displayType = displayArticleTypeLabel(article);
  const updatedAt = portalArticleUpdatedAt(article, fallbackUpdatedAt);
  const publishedAt = portalArticlePublishedAt(article, fallbackUpdatedAt);
  const sourceName = displaySourceLabel({ sourceKey: article.sourceKey, name: article.institutionName });
  const externalUrl = safeExternalUrl(article.originalUrl) ?? undefined;

  return {
    id: article.id ?? article.slug,
    canonicalId: `worldcons:${article.slug}`,
    title: article.koreanTitle || article.originalTitle || "제목 미상",
    subtitle: article.oneLineSummary || "",
    type: options.type ?? displayType,
    jurisdictionCode: jurisdictionCodeFor(article.jurisdiction),
    jurisdictionName,
    sourceName,
    publishedAt,
    updatedAt,
    language: "ko",
    url: `${baseUrl}/articles/${article.slug}`,
    externalUrl,
    badges: options.badges ?? [jurisdictionName, displayType].filter(Boolean),
  };
}
