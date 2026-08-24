import type { Metadata } from "next";
import type { ArticleListItem, TagSummary } from "@/lib/db/types";
import { isIndexablePublicTag, publicAbsoluteUrl } from "@/lib/seo/public-urls";

export { getAppBaseUrl, isIndexablePublicTag, publicAbsoluteUrl, publicPath } from "@/lib/seo/public-urls";

export function siteVerificationMetadata(): Pick<Metadata, "verification"> {
  const google = process.env.GOOGLE_SITE_VERIFICATION?.trim();
  const naver = process.env.NAVER_SITE_VERIFICATION?.trim();
  if (!google && !naver) return {};
  return {
    verification: {
      ...(google ? { google } : {}),
      ...(naver ? { other: { "naver-site-verification": naver } } : {}),
    },
  };
}

export function articleMetadata(article: ArticleListItem): Metadata {
  const title = article.koreanTitle || article.originalTitle || "헌법재판 기사";
  const description = article.oneLineSummary;
  const url = publicAbsoluteUrl(`/articles/${article.slug}`);

  return {
    title,
    description,
    robots: { index: true, follow: true },
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
  const url = publicAbsoluteUrl(`/tags/${tag.slug}`);
  const indexable = isIndexablePublicTag(tag);

  return {
    title,
    description,
    robots: indexable ? undefined : { index: false, follow: true },
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
