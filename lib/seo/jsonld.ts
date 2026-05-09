import type { ArticleDetail } from "@/lib/db/types";
import { getAppBaseUrl } from "@/lib/seo/metadata";

export function articleJsonLd(article: ArticleDetail) {
  return {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: article.koreanTitle || article.originalTitle,
    description: article.oneLineSummary,
    datePublished: article.originalPublishedAt,
    dateModified: article.summarizedAt || article.fetchedAt || article.discoveredAt,
    inLanguage: "ko",
    isBasedOn: article.originalUrl,
    url: `${getAppBaseUrl()}/articles/${article.slug}`,
    publisher: {
      "@type": "Organization",
      name: "헌법재판소도서관 헌법판례요약시스템",
    },
    about: article.tags.map((tag) => tag.name),
  };
}
