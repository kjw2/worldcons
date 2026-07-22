import { unstable_cache } from "next/cache";
import { cache } from "react";
import { getArticleDetailPageData } from "@/lib/db/queries";
import { PUBLIC_ARTICLES_CACHE_TAG } from "@/lib/public-content-cache";

export const PUBLIC_ARTICLE_DETAIL_REVALIDATE_SECONDS = 3_600;

const getPersistedArticleDetailPageData = unstable_cache(
  async (slug: string) => getArticleDetailPageData(slug),
  ["public-article-detail-page-v1"],
  {
    revalidate: PUBLIC_ARTICLE_DETAIL_REVALIDATE_SECONDS,
    tags: [PUBLIC_ARTICLES_CACHE_TAG],
  },
);

export const getCachedArticleDetailPageData = cache(
  async (slug: string) => getPersistedArticleDetailPageData(slug),
);
