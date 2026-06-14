import type { ArticleDetail } from "@/lib/db/types";
import { getAppBaseUrl } from "@/lib/seo/metadata";
import { safeExternalUrl } from "@/lib/utils/safe-url";

export function articleJsonLd(article: ArticleDetail) {
  const originalUrl = safeExternalUrl(article.originalUrl);
  return {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: article.koreanTitle || article.originalTitle,
    description: article.oneLineSummary,
    datePublished: article.originalPublishedAt,
    dateModified: article.summarizedAt || article.fetchedAt || article.discoveredAt,
    inLanguage: "ko",
    ...(originalUrl ? { isBasedOn: originalUrl } : {}),
    url: `${getAppBaseUrl()}/articles/${article.slug}`,
    publisher: {
      "@type": "Organization",
      name: "헌법판례요약시스템",
    },
    about: article.tags.map((tag) => tag.name),
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
