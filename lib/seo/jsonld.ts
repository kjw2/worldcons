import type { ArticleDetail } from "@/lib/db/types";
import { getAppBaseUrl, publicAbsoluteUrl } from "@/lib/seo/metadata";
import { safeExternalUrl } from "@/lib/utils/safe-url";

export function articleJsonLd(article: ArticleDetail) {
  const originalUrl = safeExternalUrl(article.originalUrl);
  const url = publicAbsoluteUrl(`/articles/${article.slug}`);
  const title = article.koreanTitle || article.originalTitle || article.slug;
  const keywords = article.tags.map((tag) => tag.name).filter(Boolean);
  return {
    "@context": "https://schema.org",
    "@type": "Article",
    "@id": `${url}#article`,
    headline: title,
    description: article.oneLineSummary,
    datePublished: article.originalPublishedAt,
    dateModified: article.summarizedAt || article.fetchedAt || article.discoveredAt,
    inLanguage: "ko",
    isAccessibleForFree: true,
    mainEntityOfPage: { "@type": "WebPage", "@id": url },
    ...(originalUrl ? { isBasedOn: originalUrl } : {}),
    url,
    identifier: article.caseNumber || article.slug,
    articleSection: article.institutionName,
    ...(keywords.length > 0 ? { keywords } : {}),
    author: {
      "@type": "Organization",
      name: "WORLD CONS",
      url: `${getAppBaseUrl()}/`,
    },
    publisher: {
      "@type": "Organization",
      name: "WORLD CONS",
      url: `${getAppBaseUrl()}/`,
    },
    about: keywords,
  };
}

export function articleBreadcrumbJsonLd(article: ArticleDetail) {
  const title = article.koreanTitle || article.originalTitle || article.slug;
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "홈", item: publicAbsoluteUrl("/") },
      { "@type": "ListItem", position: 2, name: "전체 판례", item: publicAbsoluteUrl("/list") },
      { "@type": "ListItem", position: 3, name: article.institutionName, item: publicAbsoluteUrl(`/sources/${article.sourceKey}`) },
      { "@type": "ListItem", position: 4, name: title, item: publicAbsoluteUrl(`/articles/${article.slug}`) },
    ],
  };
}

export function jsonLdScriptValue(value: unknown) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
