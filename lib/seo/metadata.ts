import type { Metadata } from "next";
import type { ArticleDetail, TagSummary } from "@/lib/db/types";

const DEFAULT_BASE_URL = "http://localhost:3000";

function normalizeBaseUrl(value: string) {
  return value.replace(/\/+$/, "");
}

export function getAppBaseUrl() {
  if (process.env.APP_BASE_URL) {
    return normalizeBaseUrl(process.env.APP_BASE_URL);
  }

  const vercelUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  if (vercelUrl) {
    return normalizeBaseUrl(vercelUrl.startsWith("http") ? vercelUrl : `https://${vercelUrl}`);
  }

  return DEFAULT_BASE_URL;
}

export function articleMetadata(article: ArticleDetail): Metadata {
  const title = article.koreanTitle || article.originalTitle || "헌법재판 기사";
  const description = article.oneLineSummary;
  const url = `${getAppBaseUrl()}/articles/${article.slug}`;

  return {
    title,
    description,
    alternates: {
      canonical: url,
    },
    openGraph: {
      title,
      description,
      url,
      type: "article",
      publishedTime: article.originalPublishedAt ?? undefined,
    },
  };
}

export function tagMetadata(tag: TagSummary): Metadata {
  const title = `${tag.name} 관련 헌법재판 뉴스·판례`;
  const description = `${tag.name} 태그와 연결된 헌법재판 뉴스·판례 ${tag.articleCount ?? 0}건`;
  const url = `${getAppBaseUrl()}/tags/${tag.slug}`;

  return {
    title,
    description,
    alternates: {
      canonical: url,
    },
    openGraph: {
      title,
      description,
      url,
      type: "website",
    },
  };
}
