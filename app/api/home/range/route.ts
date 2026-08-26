import { unstable_cache } from "next/cache";
import { NextResponse } from "next/server";
import { PUBLIC_ARTICLES_CACHE_TAG, PUBLIC_ARTICLE_COUNTS_CACHE_TAG } from "@/lib/public-content-cache";
import { listArticles, listJurisdictionArticleCounts } from "@/lib/db/queries";
import type { ArticleListFilters, ArticleListResult } from "@/lib/db/types";
import { parseArticleListApiParams, publicApiValidationErrorResponse } from "@/lib/security/public-api-validation";
import { consumeRateLimit, rateLimitExceededResponse } from "@/lib/security/rate-limit";

export const revalidate = 60;

function canUseJurisdictionTotal(filters: ArticleListFilters) {
  return !filters.q && !filters.source && !filters.type && !filters.tag && !filters.language;
}

function withJurisdictionTotal(articles: ArticleListResult, jurisdictionArticleCounts: Record<string, number>, filters: ArticleListFilters) {
  const total = Math.max(
    articles.items.length,
    filters.jurisdiction
      ? jurisdictionArticleCounts[filters.jurisdiction] ?? 0
      : Object.values(jurisdictionArticleCounts).reduce((sum, count) => sum + count, 0),
  );
  const shownThrough = (articles.pageInfo.page - 1) * articles.pageInfo.pageSize + articles.items.length;

  return {
    ...articles,
    pageInfo: {
      ...articles.pageInfo,
      total: Math.max(total, shownThrough),
      hasMore: shownThrough < total,
      totalIsExact: true,
    },
  };
}

const getHomeRangePayload = unstable_cache(
  async (filters: ArticleListFilters) => {
    const countFromJurisdictions = canUseJurisdictionTotal(filters);
    const [articles, jurisdictionArticleCounts] = await Promise.all([
      listArticles({ ...filters, count: countFromJurisdictions ? "none" : "exact" }),
      listJurisdictionArticleCounts([], { range: filters.range }),
    ]);

    return {
      articles: countFromJurisdictions ? withJurisdictionTotal(articles, jurisdictionArticleCounts, filters) : articles,
      jurisdictionArticleCounts,
    };
  },
  ["home-range-payload-v2"],
  { revalidate: 60, tags: [PUBLIC_ARTICLES_CACHE_TAG, PUBLIC_ARTICLE_COUNTS_CACHE_TAG] },
);

export async function GET(request: Request) {
  const rateLimit = await consumeRateLimit(request, "publicApi");
  if (rateLimit?.limited) {
    return rateLimitExceededResponse(rateLimit);
  }

  const { searchParams } = new URL(request.url);
  const parsed = parseArticleListApiParams(searchParams);
  if (!parsed.ok) return publicApiValidationErrorResponse(parsed.error);

  const payload = await getHomeRangePayload({
    ...parsed.data,
    page: parsed.data.page ?? 1,
    pageSize: parsed.data.pageSize ?? 9,
    count: "exact",
  });

  return NextResponse.json(payload, {
    headers: {
      "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
    },
  });
}
